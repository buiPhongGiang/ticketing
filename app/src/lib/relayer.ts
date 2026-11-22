// The guest never holds AVAX. A relayer sends the purchase (`buyFor`, signed by the guest off chain) and pays its gas;
// for the actions the contract has no relayed version of (list, waitlist, refund), it tops the device account up with
// just enough test AVAX for one transaction. Testnet only: `createRelayer` refuses any chain but anvil and Fuji.
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, zeroAddress, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, usdcAbi } from './abi';
import { createLocalSigner, createTicketService, decodeQr, memoryStore, toEventInfo } from './index';
import { receiptsAbi, type PayPurpose } from './pay';
import { strictSignature } from './offline';
import { ServiceError, type Address, type ErrorCode, type Hex, type LocalSigner, type ScanVerdict } from './types';

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

/**
 * The gate device holds no key: it reads the chain itself (holder list, eth_call as the gate) and asks the relayer,
 * which holds the gate key, to send the check-in. The relayer checks the QR again exactly as the device does.
 */
export interface RemoteGate {
  /** The gate wallet's address; also proves the PIN. */
  info(): Promise<{ address: Address }>;
  /** A hash once the node accepted the check-in, or the verdict if the QR no longer passes. */
  checkIn(raw: string): Promise<{ hash: Hex } | { verdict: ScanVerdict }>;
}

const errorCodes = new Set<string>(['SoldOut', 'SaleClosed', 'WalletLimit', 'EventCancelled', 'EventEnded', 'SignatureExpired', 'InvalidSignature', 'BadEvent', 'BadTier', 'HolderNotWallet', 'InsufficientUsdc', 'FaucetCooldown', 'GatePin', 'RateLimited', 'RelayerLow', 'InFlight', 'NotScanner', 'Network', 'Unknown']);

async function postJson(url: string, path: string, body: unknown, fetchImpl: typeof fetch, headers: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch {
    throw new ServiceError('Network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new ServiceError(errorCodes.has(json.error) ? json.error : 'Unknown');
  return json;
}

/** Client side of the key-less gate: every call carries the gate PIN set in the relayer's env (GATE_PIN). */
export function httpGate(url: string, pin: string, fetchImpl: typeof fetch = fetch): RemoteGate {
  const headers = { 'x-gate-pin': pin };
  return {
    info: () => postJson(url, 'gate/info', {}, fetchImpl, headers),
    checkIn: (raw) => postJson(url, 'gate/checkin', { raw }, fetchImpl, headers),
  };
}

/** Stands in for a key on the gate device: the address only. Nothing can be signed with it. */
export function addressOnlySigner(address: Address): LocalSigner {
  const none = async (): Promise<never> => { throw new ServiceError('NotScanner'); };
  return { address, signCheckIn: none, signPermit: none, signBuy: none, signTransaction: none, signMessage: none };
}

/** Client side: the app talks to the relayer over HTTP. */
export function httpRelayer(url: string, fetchImpl: typeof fetch = fetch): Relayer {
  const post = (path: string, body: unknown) => postJson(url, path, body, fetchImpl);
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
  /** PaymentReceipts, where the relayer records the hash of each VND payment. Without it nothing is recorded. */
  receipts?: Address;
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

  const config = { chainId: o.chainId, rpcUrl: o.rpcUrl, contract: o.contract, usdc: o.usdc, nativeSymbol: 'AVAX' };
  const gateSigner = createLocalSigner(o.privateKey);
  /**
   * The gate device's check-in, sent with the relayer key (it is the gate wallet). Same rules as the device: decode,
   * network, expiry, 5-minute ceiling, 15 seconds left, then eth_call of checkIn as the gate; plus the contract's
   * strict signature form (65 bytes, v 27/28, low s). A fresh journal each time; the contract refuses a second entry.
   */
  const gateCheckIn = (raw: string) => serial(async (): Promise<{ hash: Hex } | { verdict: ScanVerdict }> => {
    const payload = decodeQr(raw);
    if (!payload) return { verdict: { kind: 'invalid-qr' } };
    if (!strictSignature(payload.signature)) return { verdict: { kind: 'rejected', code: 'InvalidSignature', payload } };
    const service = createTicketService({ config, signer: gateSigner, store: memoryStore(), now });
    const r = await service.checkIn(raw);
    if ('hash' in r) return { hash: r.hash };
    // Ticket details stay on the device, which reads them itself.
    return { verdict: r.kind === 'ok' ? { ...r, ticket: undefined } : r };
  });
  let balanceAt = 0;
  let balanceWei = 0n;
  /** The relayer's own native balance, cached 30 s so a flood of requests does not flood the RPC. */
  const balance = async (): Promise<bigint> => {
    if (now() - balanceAt > 30_000) { balanceWei = await pub.getBalance({ address: account.address }); balanceAt = now(); }
    return balanceWei;
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

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const mined = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (r.status !== 'success') throw new ServiceError('Unknown');
    return r;
  };
  /**
   * The chain side of a VND payment (scripts/payments.ts decides when). The buyer paid in đồng off chain; the
   * contract still settles in its 6-decimal token, so the relayer moves that amount from its float into the
   * buyer's device account right before the purchase. On testnet the float is the mock token's faucet.
   */
  const pay = {
    /** What an order costs now, read from the chain, and whether it can still go ahead. */
    quote: async (p: PayPurpose): Promise<{ units: bigint; buyer: Address; eventId: string; tokenId?: string }> => {
      try {
        if (p.kind === 'resale') {
          const t = (await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'getTicket', args: [BigInt(p.tokenId)] })) as any;
          if (t.listPrice === 0n) throw new ServiceError('NotListed');
          if (same(t.owner, p.buyer)) throw new ServiceError('OwnListing');
          const ev = toEventInfo(await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'getEvent', args: [t.eventId] }), Math.floor(now() / 1000));
          if (ev.status !== 'onsale') throw new ServiceError(ev.status === 'cancelled' ? 'EventCancelled' : 'EventEnded');
          if ((ev.waiting[Number(t.tier)] ?? 0) > 0) throw new ServiceError('WaitlistFirst');
          return { units: t.listPrice as bigint, buyer: p.buyer, eventId: ev.id, tokenId: p.tokenId };
        }
        const eventId = p.kind === 'buy' ? p.order.eventId : p.eventId;
        const tier = Number(p.kind === 'buy' ? p.order.tier : p.tier);
        const ev = toEventInfo(await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'getEvent', args: [BigInt(eventId)] }), Math.floor(now() / 1000));
        const t = ev.tiers[tier];
        if (!t) throw new ServiceError('BadTier');
        if (ev.status !== 'onsale') throw new ServiceError(ev.status === 'cancelled' ? 'EventCancelled' : 'EventEnded');
        if (p.kind === 'wait') {
          const [position] = (await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'waitlistPlace', args: [BigInt(eventId), BigInt(tier), p.buyer] })) as [bigint, bigint];
          if (position > 0n) throw new ServiceError('AlreadyWaiting');
          return { units: (BigInt(t.price) * 11_000n) / 10_000n, buyer: p.buyer, eventId };
        }
        const quantity = Number(p.order.quantity);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 20 || t.sold + quantity > t.supply) throw new ServiceError('SoldOut');
        return { units: BigInt(t.price) * BigInt(quantity), buyer: p.order.buyer, eventId };
      } catch (e) {
        return fail(e);
      }
    },
    /** Settlement tokens for one paid order, from the relayer's float into the buyer's account. Waits until mined. */
    fund: (to: Address, units: bigint) => serial(async () => {
      try {
        const float = (await pub.readContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'balanceOf', args: [account.address] })) as bigint;
        if (float < units) await mined(await wallet.writeContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'faucet', args: [] } as never));
        return { hash: (await mined(await wallet.writeContract({ address: o.usdc, abi: usdcAbi as Abi, functionName: 'transfer', args: [to, units] } as never))).transactionHash };
      } catch (e) {
        return fail(e);
      }
    }),
    /** Ticket ids a purchase minted to the buyer, once it is mined. */
    minted: async (hash: Hex, buyer: Address): Promise<string[]> => {
      const r = await mined(hash);
      return parseEventLogs({ abi: abi as Abi, logs: r.logs, eventName: 'Transfer' })
        .filter((l: any) => same(l.address, o.contract) && l.args.from === zeroAddress && same(l.args.to, buyer))
        .map((l: any) => l.args.tokenId.toString());
    },
    /** Writes the payment's hash for its tickets into PaymentReceipts. Waits until mined. */
    record: (tokenIds: string[], kind: number, hash: Hex) => serial(async () => {
      if (!o.receipts) throw new ServiceError('PayOff');
      try {
        const { request } = await pub.simulateContract({ account, address: o.receipts, abi: receiptsAbi, functionName: 'record', args: [tokenIds.map(BigInt), kind, hash] });
        return { hash: (await mined(await wallet.writeContract(request as never))).transactionHash };
      } catch (e) {
        return fail(e);
      }
    }),
    /** The refund a transaction paid out on chain: which ticket, to whom, how much. Null if it holds none. */
    refundOf: async (hash: Hex): Promise<{ tokenId: string; holder: Address; units: bigint } | null> => {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        if (r.status !== 'success') return null;
        const [log] = parseEventLogs({ abi: abi as Abi, logs: r.logs, eventName: 'Refunded' }).filter((l: any) => same(l.address, o.contract)) as any[];
        return log ? { tokenId: log.args.tokenId.toString(), holder: log.args.holder, units: log.args.amount } : null;
      } catch {
        return null;
      }
    },
    buy: (order: BuyOrder) => relayer.buy(order),
    topUp: (to: Address) => relayer.topUp(to),
  };

  /** Minimal HTTP routing, shared by the server script and the tests. */
  async function handle(path: string, body: any): Promise<{ status: number; json: unknown }> {
    const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
    try {
      if (path === '/buy' && body && addr(body.buyer)) return { status: 200, json: await relayer.buy(body as BuyOrder) };
      if (path === '/faucet' && addr(body?.to)) return { status: 200, json: await relayer.faucet(body.to) };
      if (path === '/top-up' && addr(body?.to)) return { status: 200, json: await relayer.topUp(body.to) };
      if (path === '/gate/info') return { status: 200, json: { address: account.address } };
      if (path === '/gate/checkin' && typeof body?.raw === 'string' && body.raw.length < 2000) return { status: 200, json: await gateCheckIn(body.raw) };
      return { status: 404, json: { error: 'Unknown' } };
    } catch (e) {
      return { status: 400, json: { error: e instanceof ServiceError ? e.code : 'Unknown' } };
    }
  }

  let knownEvents = 0;
  /** Whether an event id exists on the contract. The count only grows, so a known id is never asked again. */
  const eventExists = async (eventId: string): Promise<boolean> => {
    const n = Number(eventId);
    if (n < knownEvents) return true;
    knownEvents = Number(await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'eventCount' }));
    return n < knownEvents;
  };

  /** Whether an account holds a ticket of an event right now (ticketsOf on the contract). */
  const holdsTicket = async (eventId: string, holder: Address): Promise<boolean> => {
    const tickets = (await pub.readContract({ address: o.contract, abi: abi as Abi, functionName: 'ticketsOf', args: [holder] })) as { eventId: bigint }[];
    return tickets.some((t) => t.eventId.toString() === eventId);
  };

  return { ...relayer, address: account.address, handle, gateCheckIn, balance, pay, eventExists, holdsTicket };
}
