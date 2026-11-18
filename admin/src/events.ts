// Reads the contract's full event history in small chunks, keeping progress so a rate limit only pauses the scan.
import { decodeEventLog, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { abi } from '../../app/src/lib/abi';
import { blockChunks } from './dashboard';

export interface IndexedEvent {
  id: string;
  name: 'Transfer' | 'CheckedIn' | 'ScannerSet';
  block: bigint;
  logIndex: number;
  hash: Hex;
  timestamp: number;
  tokenId?: string;
  from?: Address;
  to?: Address;
  holder?: Address;
  scanner?: Address;
  allowed?: boolean;
  /** For a mint: whether its transaction carried payment, which separates a sale from a free mint. */
  paid?: boolean;
}

export interface IndexState {
  events: IndexedEvent[];
  fromBlock: bigint;
  scannedTo: bigint;
  latest: bigint;
  /** True only when every block since deployment has been read, so totals can be trusted. */
  complete: boolean;
}

export interface IndexOptions {
  client: PublicClient;
  contract: Address;
  /** Omit when unknown: only recent blocks are read and totals stay unavailable. */
  deployBlock?: bigint;
  /** Largest eth_getLogs range the RPC accepts. The public Fuji RPC allows 100. */
  chunk?: bigint;
  /** Blocks to look back when deployBlock is unknown. */
  lookBack?: bigint;
}

const byChainOrder = (a: IndexedEvent, b: IndexedEvent) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);

export function createEventIndex({ client, contract, deployBlock, chunk = 100n, lookBack = 1000n }: IndexOptions) {
  let events = new Map<string, IndexedEvent>();
  let start: bigint | null = null;
  let cursor: bigint | null = null;
  let latest = 0n;
  let running: Promise<IndexState> | null = null;
  const blockTimes = new Map<bigint, number>();
  const paidTx = new Map<string, boolean>();

  async function timeOf(block: bigint) {
    let t = blockTimes.get(block);
    if (t === undefined) {
      t = Number((await client.getBlock({ blockNumber: block })).timestamp);
      blockTimes.set(block, t);
    }
    return t;
  }
  async function paidOf(hash: Hex) {
    let p = paidTx.get(hash);
    if (p === undefined) {
      p = (await client.getTransaction({ hash })).value > 0n;
      paidTx.set(hash, p);
    }
    return p;
  }

  async function readChunk(fromBlock: bigint, toBlock: bigint) {
    const logs = await client.getLogs({ address: contract, fromBlock, toBlock });
    const found: IndexedEvent[] = [];
    for (const log of logs) {
      let decoded: { eventName: string; args: any };
      try {
        decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as never;
      } catch {
        continue;
      }
      const base = { id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, logIndex: log.logIndex!, hash: log.transactionHash! };
      const { eventName: name, args } = decoded;
      if (name === 'Transfer') {
        const minted = args.from === zeroAddress;
        found.push({ ...base, name, tokenId: String(args.tokenId), from: args.from, to: args.to, timestamp: await timeOf(base.block), ...(minted ? { paid: await paidOf(base.hash) } : {}) });
      } else if (name === 'CheckedIn') {
        found.push({ ...base, name, tokenId: String(args.tokenId), holder: args.holder, scanner: args.scanner, timestamp: await timeOf(base.block) });
      } else if (name === 'ScannerSet') {
        found.push({ ...base, name, scanner: args.scanner, allowed: args.allowed, timestamp: await timeOf(base.block) });
      }
    }
    return found;
  }

  const state = (): IndexState => ({
    events: [...events.values()].sort(byChainOrder),
    fromBlock: start ?? 0n,
    scannedTo: cursor ?? (start ?? 0n) - 1n,
    latest,
    complete: deployBlock !== undefined && cursor !== null && cursor >= latest,
  });

  async function run(onProgress?: (s: IndexState) => void): Promise<IndexState> {
    latest = await client.getBlockNumber({ cacheTime: 0 });
    // A dev chain that was reset is shorter than what was already read.
    if (cursor !== null && latest < cursor) {
      events = new Map();
      start = null;
      cursor = null;
    }
    if (start === null) start = deployBlock ?? (latest > lookBack ? latest - lookBack : 0n);
    const next = cursor === null ? start : cursor + 1n;
    for (const [from, to] of blockChunks(next, latest, chunk)) {
      // One call at a time, and progress is kept per chunk, so a 429 loses nothing.
      for (const e of await readChunk(from, to)) events.set(e.id, e);
      cursor = to;
      onProgress?.(state());
    }
    if (cursor === null || cursor < latest) cursor = latest;
    return state();
  }

  return {
    /** Reads every block not read yet. Safe to call repeatedly: overlapping calls share one scan. */
    sync(onProgress?: (s: IndexState) => void): Promise<IndexState> {
      running ??= run(onProgress).finally(() => { running = null; });
      return running;
    },
    state,
  };
}

/** Wallets ever named in ScannerSet. Whether each still has the right must be read from isScanner. */
export function scannerCandidates(events: IndexedEvent[]): Address[] {
  const seen = new Map<string, Address>();
  for (const e of events) if (e.name === 'ScannerSet' && e.scanner) seen.set(e.scanner.toLowerCase(), e.scanner);
  return [...seen.values()];
}

export interface Revenue {
  sold: number;
  free: number;
  collectedWei: bigint;
  /** Derived: the contract emits no event for withdraw. */
  withdrawnWei: bigint;
  balanceWei: bigint;
}

/** Returns null while the history is incomplete: a partial total would read as a real one. */
export function revenueOf(index: Pick<IndexState, 'events' | 'complete'>, priceWei: bigint, balanceWei: bigint): Revenue | null {
  if (!index.complete) return null;
  const mints = index.events.filter((e) => e.name === 'Transfer' && e.from === zeroAddress);
  const sold = mints.filter((e) => e.paid).length;
  const collectedWei = BigInt(sold) * priceWei;
  return {
    sold,
    free: mints.length - sold,
    collectedWei,
    withdrawnWei: collectedWei > balanceWei ? collectedWei - balanceWei : 0n,
    balanceWei,
  };
}
