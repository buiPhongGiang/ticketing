// Reads VeGoc's log history in chunks, keeping progress so a rate limit only pauses the scan.
// Also rebuilds which event and tier each ticket belongs to, because Refunded and other ticket logs carry only the
// token id and a refunded ticket is burned, so getTicket can no longer answer.
import { decodeEventLog, zeroAddress, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { abi } from '../../app/src/lib/abi';

export type ActivityKind = 'EventCreated' | 'Cancelled' | 'ScannerSet' | 'Purchased' | 'Issued' | 'Listed' | 'Unlisted' | 'Resold' | 'CheckedIn' | 'Refunded' | 'Settled';

export interface LogEntry {
  id: string;
  kind: ActivityKind;
  block: bigint;
  logIndex: number;
  hash: Hex;
  timestamp?: number;
  eventId?: number;
  tokenId?: number;
  tier?: number;
  quantity?: number;
  /** Purchased total, Listed/Resold price, Refunded amount, Settled principal paid to the organizer. */
  amount?: bigint;
  yieldPaid?: bigint;
  /** Settled: platform fee taken from the principal. */
  fee?: bigint;
  /** Buyer, holder, recipient, scanner or seller depending on kind. */
  account?: Address;
  /** Resold buyer, CheckedIn scanner. */
  other?: Address;
  allowed?: boolean;
  /** Purchased/Issued: the ticket ids minted in the same transaction. */
  tokenIds?: number[];
}

export interface MintInfo { eventId: number; tier: number; paid: bigint }

export interface IndexState {
  entries: LogEntry[];
  mints: Map<number, MintInfo>;
  fromBlock: bigint;
  scannedTo: bigint;
  latest: bigint;
  /** True only when every block since deployment has been read. */
  complete: boolean;
}

type Decoded = { eventName: string; args: Record<string, any> };

/** Turns raw VeGoc logs (in chain order) into entries, and records ticket → event/tier/paid from mint logs. */
export function applyLogs(logs: Log[], mints: Map<number, MintInfo>): LogEntry[] {
  const out: LogEntry[] = [];
  const pending = new Map<string, number[]>();
  for (const log of logs) {
    let d: Decoded;
    try {
      d = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as Decoded;
    } catch {
      continue;
    }
    const a = d.args;
    const hash = log.transactionHash!;
    const base = { id: `${hash}:${log.logIndex}`, block: log.blockNumber!, logIndex: log.logIndex!, hash };
    switch (d.eventName) {
      case 'Transfer':
        if (a.from === zeroAddress) pending.set(hash, [...(pending.get(hash) ?? []), Number(a.tokenId)]);
        break;
      case 'Purchased':
      case 'Issued': {
        const ids = pending.get(hash) ?? [];
        pending.delete(hash);
        const quantity = Number(a.quantity);
        const amount = d.eventName === 'Purchased' ? (a.amount as bigint) : 0n;
        const each = quantity > 0 ? amount / BigInt(quantity) : 0n;
        for (const id of ids) mints.set(id, { eventId: Number(a.eventId), tier: Number(a.tier), paid: each });
        out.push({ ...base, kind: d.eventName, eventId: Number(a.eventId), account: d.eventName === 'Purchased' ? a.buyer : a.to, tier: Number(a.tier), quantity, amount, tokenIds: ids });
        break;
      }
      case 'EventCreated':
        out.push({ ...base, kind: 'EventCreated', eventId: Number(a.eventId), account: a.organizer });
        break;
      case 'Cancelled':
        out.push({ ...base, kind: 'Cancelled', eventId: Number(a.eventId) });
        break;
      case 'ScannerSet':
        out.push({ ...base, kind: 'ScannerSet', eventId: Number(a.eventId), account: a.scanner, allowed: a.allowed });
        break;
      case 'Listed':
        out.push({ ...base, kind: 'Listed', tokenId: Number(a.tokenId), account: a.seller, amount: a.price });
        break;
      case 'Unlisted':
        out.push({ ...base, kind: 'Unlisted', tokenId: Number(a.tokenId) });
        break;
      case 'Resold':
        out.push({ ...base, kind: 'Resold', tokenId: Number(a.tokenId), account: a.seller, other: a.buyer, amount: a.price });
        break;
      case 'CheckedIn':
        out.push({ ...base, kind: 'CheckedIn', tokenId: Number(a.tokenId), account: a.holder, other: a.scanner });
        break;
      case 'Refunded':
        out.push({ ...base, kind: 'Refunded', tokenId: Number(a.tokenId), account: a.holder, amount: a.amount });
        break;
      case 'Settled':
        out.push({ ...base, kind: 'Settled', eventId: Number(a.eventId), account: a.to, amount: a.principal, yieldPaid: a.yieldPaid, fee: a.fee });
        break;
    }
  }
  return out;
}

export const eventOf = (e: LogEntry, mints: Map<number, MintInfo>) => e.eventId ?? (e.tokenId !== undefined ? mints.get(e.tokenId)?.eventId : undefined);

/** Entries of one event, newest first. */
export function entriesOf(s: Pick<IndexState, 'entries' | 'mints'>, eventId: number, kinds?: ActivityKind[]): LogEntry[] {
  return s.entries.filter((e) => eventOf(e, s.mints) === eventId && (!kinds || kinds.includes(e.kind))).reverse();
}

export function refundsOf(s: Pick<IndexState, 'entries' | 'mints'>, eventId: number) {
  return entriesOf(s, eventId, ['Refunded']).map((e) => ({ tokenId: e.tokenId!, holder: e.account!, amount: e.amount ?? 0n, tier: s.mints.get(e.tokenId!)?.tier ?? 0 }));
}

/** Wallets ever named in ScannerSet for this event. Whether each still has the right must be read from isScanner. */
export function scannerCandidates(s: Pick<IndexState, 'entries' | 'mints'>, eventId: number): Address[] {
  const seen = new Map<string, Address>();
  for (const e of [...entriesOf(s, eventId, ['ScannerSet'])].reverse()) seen.set(e.account!.toLowerCase(), e.account!);
  return [...seen.values()];
}

export function blockChunks(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) out.push([start, start + size - 1n > to ? to : start + size - 1n]);
  return out;
}

export interface IndexOptions {
  client: PublicClient;
  contract: Address;
  /** Omit when unknown: only recent blocks are read. */
  deployBlock?: bigint;
  /** Largest eth_getLogs range the RPC accepts. */
  chunk?: bigint;
  lookBack?: bigint;
}

const byChainOrder = (a: LogEntry, b: LogEntry) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);

export function createLogIndex({ client, contract, deployBlock, chunk = 100n, lookBack = 5000n }: IndexOptions) {
  let entries = new Map<string, LogEntry>();
  let mints = new Map<number, MintInfo>();
  let start: bigint | null = null;
  let cursor: bigint | null = null;
  let latest = 0n;
  let running: Promise<IndexState> | null = null;
  const blockTimes = new Map<bigint, number>();

  async function stamp(found: LogEntry[]) {
    const missing = [...new Set(found.map((e) => e.block))].filter((b) => !blockTimes.has(b));
    const blocks = await Promise.all(missing.map((b) => client.getBlock({ blockNumber: b })));
    blocks.forEach((b, i) => blockTimes.set(missing[i], Number(b.timestamp)));
    for (const e of found) e.timestamp = blockTimes.get(e.block);
  }

  const state = (): IndexState => ({
    entries: [...entries.values()].sort(byChainOrder),
    mints,
    fromBlock: start ?? 0n,
    scannedTo: cursor ?? (start ?? 0n) - 1n,
    latest,
    complete: deployBlock !== undefined && cursor !== null && cursor >= latest,
  });

  async function run(onProgress?: (s: IndexState) => void): Promise<IndexState> {
    latest = await client.getBlockNumber({ cacheTime: 0 });
    // A dev chain that was reset is shorter than what was already read.
    if (cursor !== null && latest < cursor) {
      entries = new Map();
      mints = new Map();
      start = null;
      cursor = null;
    }
    if (start === null) start = deployBlock ?? (latest > lookBack ? latest - lookBack : 0n);
    const next = cursor === null ? start : cursor + 1n;
    for (const [from, to] of blockChunks(next, latest, chunk)) {
      // One range at a time, progress kept per chunk, so a 429 loses nothing.
      const logs = await client.getLogs({ address: contract, fromBlock: from, toBlock: to });
      const fresh = new Map(mints);
      const found = applyLogs(logs, fresh);
      await stamp(found);
      mints = fresh;
      for (const e of found) entries.set(e.id, e);
      cursor = to;
      onProgress?.(state());
    }
    if (cursor === null || cursor < latest) cursor = latest;
    return state();
  }

  return {
    /** Reads every block not read yet. Overlapping calls share one scan. */
    sync(onProgress?: (s: IndexState) => void): Promise<IndexState> {
      running ??= run(onProgress).finally(() => { running = null; });
      return running;
    },
    state,
  };
}
