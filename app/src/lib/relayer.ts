// The guest never holds AVAX. A relayer sends the purchase (`buyFor`, signed by the guest off chain) and pays its gas;
// for the actions the contract has no relayed version of (list, waitlist, refund), it tops the device account up with
// just enough test AVAX for one transaction. Testnet only: `createRelayer` refuses any chain but anvil and Fuji.
import { createPublicClient, createWalletClient, defineChain, http, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, usdcAbi } from './abi';
import { ServiceError, type Address, type ErrorCode, type Hex } from './types';

/** What the guest signed: the EIP-712 `Buy` message and the token's permit, both with `deadline`. */
export interface BuyOrder {
  buyer: Address;
  eventId: string;
  tier: string;
  quantity: string;
  deadline: string;
  signature: Hex;
  permit: { v: number; r: Hex; s: Hex };
}

export interface Relayer {
  /** Sends `buyFor`. Resolves with the hash once the node accepted it; throws ServiceError if it would revert. */
  buy(order: BuyOrder): Promise<{ hash: Hex }>;
  /** Test USDC for a new account (mock token only). */
  faucet(to: Address): Promise<{ hash: Hex }>;
  /** Enough test AVAX for one action, waited until mined. No-op when the account already has enough. */
  topUp(to: Address): Promise<{ hash?: Hex }>;
}

const errorCodes = new Set<string>(['SoldOut', 'SaleClosed', 'WalletLimit', 'EventCancelled', 'EventEnded', 'SignatureExpired', 'InvalidSignature', 'BadEvent', 'BadTier', 'HolderNotWallet', 'InsufficientUsdc', 'FaucetCooldown', 'Network', 'Unknown']);

/** Client side: the app talks to the relayer over HTTP. */
export function httpRelayer(url: string, fetchImpl: typeof fetch = fetch): Relayer {
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new ServiceError('Network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new ServiceError(errorCodes.has(json.error) ? json.error : 'Unknown');
    return json;
  };
  return {
    buy: (order) => post('buy', order),
    faucet: (to) => post('faucet', { to }),
    topUp: (to) => post('top-up', { to }),
  };
}

export interface RelayerOptions {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
  contract: Address;
  usdc: Address;
  /** Wei sent per top-up; default 0.01 of the native token. */
  topUpWei?: bigint;
  /** USDC base units per faucet grant; default 100 USDC. */
  grant?: bigint;
  now?: () => number;
}

const TEST_CHAINS = [31337, 43113];

/** Server side (scripts/relayer.ts, and the tests): holds the relayer key and pays the gas. */
export function createRelayer(o: RelayerOptions, mapError: (e: unknown) => ErrorCode = () => 'Unknown') {
  if (!TEST_CHAINS.includes(o.chainId)) throw new Error('The relayer runs on anvil or Fuji only');
  const chain = defineChain({ id: o.chainId, name: 'relay', nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const transport = http(o.rpcUrl, { retryCount: 2, timeout: 15_000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: o.chainId === 31337 ? 50 : 400 });
  const account = privateKeyToAccount(o.privateKey);
  const wallet = createWalletClient({ chain, transport, account });
  const topUpWei = o.topUpWei ?? 10n ** 16n;
  const grant = o.grant ?? 100_000_000n;
  const now = o.now ?? Date.now;
  const lastFaucet = new Map<string, number>();
  const lastTopUp = new Map<string, number>();
  // One transaction at a time from the relayer key, so nonces never collide.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const fail = (e: unknown): never => {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError(mapError(e));
  };

  const relayer: Relayer = {
    buy: (order) => serial(async () => {
      try {
        const { request } = await pub.simulateContract({
          account, address: o.contract, abi: abi as Abi, functionName: 'buyFor',
          args: [order.buyer, BigInt(order.eventId), BigInt(order.tier), BigInt(order.quantity), BigInt(order.deadline), order.signature, order.permit],
        } as never);
        return { hash: await wallet.writeContract(request as never) };
      } catch (e) {
        return fail(e);
      }
    }),
    faucet: (to) => serial(async () => {
      const last = lastFaucet.get(to.toLowerCase());
      if (last !== undefined && now() - last < 5 * 60_000) throw new ServiceError('FaucetCooldown');
      try {
        const balance = (await pub.readContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'balanceOf', args: [account.address] })) as bigint;
        if (balance < grant) {
          const h = await wallet.writeContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'faucet', args: [] } as never);
          await pub.waitForTransactionReceipt({ hash: h });
        }
        const hash = await wallet.writeContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'transfer', args: [to, grant] } as never);
        lastFaucet.set(to.toLowerCase(), now());
        return { hash };
      } catch (e) {
        return fail(e);
      }
    }),
    topUp: (to) => serial(async () => {
      try {
        const balance = await pub.getBalance({ address: to });
        if (balance >= topUpWei / 2n) return {};
        const last = lastTopUp.get(to.toLowerCase());
        if (last !== undefined && now() - last < 30_000) throw new ServiceError('FaucetCooldown');
        const hash = await wallet.sendTransaction({ to, value: topUpWei - balance } as never);
        lastTopUp.set(to.toLowerCase(), now());
        await pub.waitForTransactionReceipt({ hash });
        return { hash };
      } catch (e) {
        return fail(e);
      }
    }),
  };

  /** Minimal HTTP routing, shared by the server script and the tests. */
  async function handle(path: string, body: any): Promise<{ status: number; json: unknown }> {
    const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
    try {
      if (path === '/buy' && body && addr(body.buyer)) return { status: 200, json: await relayer.buy(body as BuyOrder) };
      if (path === '/faucet' && addr(body?.to)) return { status: 200, json: await relayer.faucet(body.to) };
      if (path === '/top-up' && addr(body?.to)) return { status: 200, json: await relayer.topUp(body.to) };
      return { status: 404, json: { error: 'Unknown' } };
    } catch (e) {
      return { status: 400, json: { error: e instanceof ServiceError ? e.code : 'Unknown' } };
    }
  }

  return { ...relayer, address: account.address, handle };
}
