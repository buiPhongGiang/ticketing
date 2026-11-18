// Read-only numbers for the organizer. Kept apart from TicketService: it needs no wallet and signs nothing.
import { createPublicClient, decodeEventLog, http, zeroAddress } from 'viem';
import { abi } from '../../app/src/lib/abi';
import { errorCode } from '../../app/src/lib';
import { ServiceError, type Address, type AppConfig } from '../../app/src/lib/types';

export interface DashboardTicket {
  tokenId: string;
  owner: Address;
  checkedIn: boolean;
}

export interface DashboardInput {
  maxSupply: string;
  priceWei: string;
  /** Wei held by the contract now. Withdrawals lower it, so it is not total revenue. */
  balanceWei: string;
  organizer: Address;
  tickets: DashboardTicket[];
  /** When the chain was read, in ms. */
  readAt: number;
}

export interface DashboardSnapshot extends DashboardInput {
  issued: number;
  entered: number;
  waiting: number;
  unsold: number;
  holders: number;
}

export function summarize(input: DashboardInput): DashboardSnapshot {
  const issued = input.tickets.length;
  const entered = input.tickets.filter((t) => t.checkedIn).length;
  return {
    ...input,
    issued,
    entered,
    waiting: issued - entered,
    unsold: Number(input.maxSupply) - issued,
    holders: new Set(input.tickets.map((t) => t.owner.toLowerCase())).size,
  };
}

export interface Holder {
  owner: Address;
  tickets: number;
  entered: number;
}

export function holdersOf(tickets: DashboardTicket[]): Holder[] {
  const byOwner = new Map<string, Holder>();
  for (const t of tickets) {
    const key = t.owner.toLowerCase();
    const holder = byOwner.get(key) ?? { owner: t.owner, tickets: 0, entered: 0 };
    holder.tickets += 1;
    if (t.checkedIn) holder.entered += 1;
    byOwner.set(key, holder);
  }
  return [...byOwner.values()].sort((a, b) => b.tickets - a.tickets);
}

export type ActivityKind = 'buy' | 'mint' | 'transfer' | 'checkIn';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  tokenId: string;
  /** Who received the ticket, or who held it at check-in. */
  wallet: Address;
  /** Block time in unix seconds. */
  timestamp: number;
}

/** The public Fuji RPC refuses eth_getLogs over 100 blocks, measured 2026-11-03. */
const LOG_CHUNK = 100n;
/**
 * How far the first scan looks back. Later reads only fetch new blocks. Kept small and read one call
 * at a time: 50 chunks with 10 in parallel was followed by HTTP 429 from that same RPC.
 */
const FIRST_SCAN_CHUNKS = 10n;
const ACTIVITY_LIMIT = 20;
/** Parallel reads, low enough for public RPC rate limits. */
const CONCURRENCY = 10;

/** Splits an inclusive block range into ranges of at most `size` blocks. */
export function blockChunks(from: bigint, to: bigint, size: bigint = LOG_CHUNK): [bigint, bigint][] {
  const chunks: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    chunks.push([start, end < to ? end : to]);
  }
  return chunks;
}

async function inPool<T, R>(items: T[], work: (item: T) => Promise<R>, size = CONCURRENCY): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

interface RawEvent {
  id: string;
  name: 'Transfer' | 'CheckedIn';
  minted: boolean;
  tokenId: string;
  wallet: Address;
  hash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

export function createDashboardReader(config: AppConfig) {
  const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 8000 }) });
  const call = (functionName: string, args: readonly unknown[] = []): Promise<any> =>
    client.readContract({ address: config.contract, abi, functionName, args } as never);
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      throw new ServiceError(errorCode(e));
    }
  };

  // Activity state: only the newest events are kept, since only those are ever shown.
  let firstBlock: bigint | null = null;
  let lastBlock: bigint | null = null;
  let recent: RawEvent[] = [];
  const blockTimes = new Map<bigint, number>();
  const paidTx = new Map<string, boolean>();

  async function logsIn([fromBlock, toBlock]: [bigint, bigint]): Promise<RawEvent[]> {
    const logs = await client.getLogs({ address: config.contract, fromBlock, toBlock });
    const events: RawEvent[] = [];
    for (const log of logs) {
      let decoded: { eventName: string; args: any };
      try {
        decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as never;
      } catch {
        continue;
      }
      const common = { id: `${log.transactionHash}:${log.logIndex}`, hash: log.transactionHash!, blockNumber: log.blockNumber!, logIndex: log.logIndex!, tokenId: String(decoded.args.tokenId) };
      if (decoded.eventName === 'Transfer') events.push({ ...common, name: 'Transfer', minted: decoded.args.from === zeroAddress, wallet: decoded.args.to });
      if (decoded.eventName === 'CheckedIn') events.push({ ...common, name: 'CheckedIn', minted: false, wallet: decoded.args.holder });
    }
    return events;
  }

  async function describe(e: RawEvent): Promise<ActivityEvent> {
    let timestamp = blockTimes.get(e.blockNumber);
    if (timestamp === undefined) {
      timestamp = Number((await client.getBlock({ blockNumber: e.blockNumber })).timestamp);
      blockTimes.set(e.blockNumber, timestamp);
    }
    let kind: ActivityKind = e.name === 'CheckedIn' ? 'checkIn' : 'transfer';
    if (e.minted) {
      // A sale and a free mint emit the same Transfer. Only the payment tells them apart.
      let paid = paidTx.get(e.hash);
      if (paid === undefined) {
        paid = (await client.getTransaction({ hash: e.hash })).value > 0n;
        paidTx.set(e.hash, paid);
      }
      kind = paid ? 'buy' : 'mint';
    }
    return { id: e.id, kind, tokenId: e.tokenId, wallet: e.wallet, timestamp };
  }

  return {
    getOrganizer: (): Promise<Address> => guarded(() => call('owner')),
    /** Scans every ticket, so it costs two RPC calls per ticket. */
    read: (): Promise<DashboardSnapshot> =>
      guarded(async () => {
        const [maxSupply, priceWei, totalMinted, organizer, balanceWei] = await Promise.all([
          call('maxSupply'),
          call('price'),
          call('totalMinted'),
          call('owner'),
          client.getBalance({ address: config.contract }),
        ]);
        const ids = Array.from({ length: Number(totalMinted) }, (_, i) => i);
        const tickets = await inPool(ids, async (i): Promise<DashboardTicket> => {
          const [owner, checkedIn] = await Promise.all([call('ownerOf', [BigInt(i)]), call('checkedIn', [BigInt(i)])]);
          return { tokenId: String(i), owner, checkedIn };
        });
        return summarize({
          maxSupply: maxSupply.toString(),
          priceWei: priceWei.toString(),
          balanceWei: balanceWei.toString(),
          organizer,
          tickets,
          readAt: Date.now(),
        });
      }),
    /** Newest events within the blocks scanned so far, which is not the whole history of the event. */
    readActivity: (): Promise<{ events: ActivityEvent[]; windowBlocks: number }> =>
      guarded(async () => {
        const latest = await client.getBlockNumber({ cacheTime: 0 });
        // A dev chain that was reset is shorter than what was already scanned.
        const known = lastBlock !== null && latest >= lastBlock;
        const lookBack = LOG_CHUNK * FIRST_SCAN_CHUNKS - 1n;
        const start = known ? lastBlock! + 1n : latest > lookBack ? latest - lookBack : 0n;
        const found = (await inPool(blockChunks(start, latest), logsIn, 1)).flat();
        const merged = new Map((known ? recent : []).concat(found).map((e) => [e.id, e]));
        const newest = [...merged.values()]
          .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber < b.blockNumber ? 1 : -1))
          .slice(0, ACTIVITY_LIMIT);
        const events = await inPool(newest, describe, 1);
        // Commit only after every read worked, so a failed scan is simply retried.
        recent = newest;
        firstBlock = known ? firstBlock : start;
        lastBlock = latest;
        return { events, windowBlocks: Number(latest - firstBlock! + 1n) };
      }),
  };
}
