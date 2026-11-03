// Read-only numbers for the organizer. Kept apart from TicketService: it needs no wallet and signs nothing.
import { createPublicClient, http } from 'viem';
import { abi } from './abi';
import { errorCode } from './index';
import { ServiceError, type Address, type AppConfig } from './types';

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

/** Parallel reads per scan, low enough for public RPC rate limits. */
const CONCURRENCY = 10;

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
        const tickets: DashboardTicket[] = Array.from({ length: Number(totalMinted) });
        let next = 0;
        const worker = async () => {
          while (next < tickets.length) {
            const i = next++;
            const [owner, checkedIn] = await Promise.all([call('ownerOf', [BigInt(i)]), call('checkedIn', [BigInt(i)])]);
            tickets[i] = { tokenId: String(i), owner, checkedIn };
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        return summarize({
          maxSupply: maxSupply.toString(),
          priceWei: priceWei.toString(),
          balanceWei: balanceWei.toString(),
          organizer,
          tickets,
          readAt: Date.now(),
        });
      }),
  };
}
