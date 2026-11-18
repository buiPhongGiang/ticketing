import { createPublicClient, createWalletClient, custom, defineChain, http, numberToHex, parseEventLogs, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { abi } from '../../app/src/lib/abi';
import { config } from './config';
import { createLogIndex, type MintInfo } from './logs';
import { buildLoginMessage, SESSION_MS, verifySession, type LoginContext, type Session } from './login';
import { toEventInfo, toTicket, type EventInfo, type RawEventView, type RawTicketView, type Ticket } from './model';

export const chain = defineChain({
  id: config.chainId,
  name: config.network,
  nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});
// JSON-RPC batching: the dozens of getTicket reads of one refresh travel in a few HTTP requests.
export const client = createPublicClient({ chain, transport: http(config.rpcUrl, { batch: { batchSize: 40, wait: 10 }, retryCount: 0, timeout: 10_000 }) }) as PublicClient;
export const logIndex = createLogIndex({ client, contract: config.contract, deployBlock: config.deployBlock, chunk: config.logChunk });
const box = { address: config.contract, abi } as const;

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}
export const walletProvider = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

// ---------------------------------------------------------------- reads

export interface EventsSnapshot {
  events: EventInfo[];
  /** Timestamp of the block the read was pinned to. */
  blockTime: number;
  /** Client clock at the read, to advance chain time between reads. */
  readAt: number;
}

export async function readEvents(): Promise<EventsSnapshot> {
  const block = await client.getBlock({ blockTag: 'latest' });
  const raw = (await client.readContract({ ...box, functionName: 'getEvents', blockNumber: block.number! })) as unknown as RawEventView[];
  return { events: raw.map(toEventInfo), blockTime: Number(block.timestamp), readAt: Date.now() };
}

const isGone = (e: unknown) => /ERC721NonexistentToken/.test(String((e as any)?.data?.errorName ?? '') + String((e as any)?.shortMessage ?? '') + String((e as any)?.message ?? ''));

/**
 * Live tickets of one event. Event and tier never change, so ids known to belong to another event, and burned ids,
 * are not read again.
 */
export function createTicketReader() {
  const otherEvent = new Map<number, number>();
  const burned = new Set<number>();
  return async function read(eventId: number, mints: Map<number, MintInfo>): Promise<Ticket[]> {
    const total = Number(await client.readContract({ ...box, functionName: 'totalMinted' }));
    const ids: number[] = [];
    for (let id = 0; id < total; id++) {
      if (burned.has(id)) continue;
      const known = otherEvent.get(id) ?? mints.get(id)?.eventId;
      if (known !== undefined && known !== eventId) continue;
      ids.push(id);
    }
    const results = await Promise.allSettled(ids.map((id) => client.readContract({ ...box, functionName: 'getTicket', args: [BigInt(id)] })));
    const out: Ticket[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const t = toTicket(r.value as unknown as RawTicketView);
        otherEvent.set(t.tokenId, t.eventId);
        if (t.eventId === eventId) out.push(t);
      } else if (isGone(r.reason)) burned.add(ids[i]);
      else throw r.reason;
    });
    return out;
  };
}

export async function readScanners(eventId: number, candidates: Address[]): Promise<Address[]> {
  const flags = await Promise.all(candidates.map((a) => client.readContract({ ...box, functionName: 'isScanner', args: [BigInt(eventId), a] })));
  return candidates.filter((_, i) => flags[i]);
}

export async function readListings(eventId: number): Promise<Ticket[]> {
  const raw = (await client.readContract({ ...box, functionName: 'listings', args: [BigInt(eventId)] })) as unknown as RawTicketView[];
  return raw.map(toTicket);
}

// ---------------------------------------------------------------- wallet

const SESSION_KEY = 'ticketbox-admin.session';
const loginContext = (): LoginContext => ({ host: window.location.host, chainId: config.chainId, contract: config.contract });
const verifier = { verifyMessage: (a: { address: Address; message: string; signature: Hex }) => client.verifyMessage(a) };

/** Asks the wallet to move to this network, adding it if the wallet does not know it. */
async function ensureChain(provider: Eip1193) {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === config.chainId) return;
  const chainId = numberToHex(config.chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: config.network, nativeCurrency: chain.nativeCurrency, rpcUrls: [config.rpcUrl], ...(config.explorer ? { blockExplorerUrls: [config.explorer] } : {}) }],
    });
  }
}

export async function login(provider: Eip1193): Promise<Session> {
  const [address] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  await ensureChain(provider);
  const now = Date.now();
  const message = buildLoginMessage(address, loginContext(), crypto.randomUUID(), now);
  const hex = `0x${[...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const signature = (await provider.request({ method: 'personal_sign', params: [hex, address] })) as Hex;
  const session: Session = { address, message, signature, expiresAt: now + SESSION_MS };
  await verifySession(session, loginContext(), verifier, now);
  // Cleared when the tab closes. Holds a signature that can do nothing on chain, and no key.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Restores a login only if it still verifies and the wallet is still on the signing account. */
export async function restoreSession(provider: Eip1193 | undefined): Promise<Session | null> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw || !provider) return null;
  try {
    const session = JSON.parse(raw) as Session;
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    if (accounts[0]?.toLowerCase() !== session.address.toLowerCase()) throw new Error('account changed');
    await verifySession(session, loginContext(), verifier, Date.now());
    return session;
  } catch {
    logout();
    return null;
  }
}

export type BoxWrite =
  | { fn: 'createEvent'; args: readonly [string, string, bigint, bigint, number, string[], bigint[], number[]] }
  | { fn: 'setScanner'; args: readonly [bigint, Address, boolean] }
  | { fn: 'issue'; args: readonly [bigint, bigint, Address, bigint] }
  | { fn: 'cancelEvent'; args: readonly [bigint] }
  | { fn: 'refundMany'; args: readonly [bigint[]] }
  | { fn: 'settle'; args: readonly [bigint, Address] };

/** Sends one TicketBox call through the wallet. Calls onHash once broadcast, then waits for the receipt. */
export async function sendBox(provider: Eip1193, account: Address, call: BoxWrite, onHash: (hash: Hex) => void): Promise<TransactionReceipt> {
  await ensureChain(provider);
  // Finds a revert, and its reason, before the wallet asks for a signature.
  const { request } = await client.simulateContract({ ...box, functionName: call.fn, args: call.args, account } as never);
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  const hash = await wallet.writeContract({ ...(request as object), account, chain } as never);
  onHash(hash);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 700, timeout: 120_000 });
  if (receipt.status !== 'success') throw Object.assign(new Error('reverted'), { shortMessage: 'Transaction reverted.' });
  return receipt;
}

export function createdEventId(receipt: TransactionReceipt): number | null {
  const [log] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'EventCreated' });
  return log ? Number(log.args.eventId) : null;
}

export const txUrl = (hash: string) => (config.explorer ? `${config.explorer}/tx/${hash}` : null);
export const addressUrl = (a: string) => (config.explorer ? `${config.explorer}/address/${a}` : null);
