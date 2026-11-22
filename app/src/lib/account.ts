// What the chain says about any account's tickets, for a seller's public page. Read-only, straight from the ticket
// contract; nothing here is a score or an estimate.
import { createPublicClient, http, type Abi } from 'viem';
import { abi } from './abi';
import type { AppConfig } from './types';

export interface HeldTicket { tokenId: string; eventId: string; tier: number; face: string; cap: string; listPrice: string; checkedIn: boolean }

export function accountReader(config: Pick<AppConfig, 'rpcUrl' | 'contract'>) {
  const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 2, timeout: 8000 }) });
  return {
    /** Every ticket the account holds now. */
    ticketsOf: async (account: string): Promise<HeldTicket[]> => {
      const views = (await client.readContract({ address: config.contract, abi: abi as Abi, functionName: 'ticketsOf', args: [account] } as never)) as any[];
      return views.map((v) => ({
        tokenId: v.tokenId.toString(), eventId: v.eventId.toString(), tier: Number(v.tier), face: v.face.toString(), cap: v.cap.toString(),
        listPrice: v.listPrice.toString(), checkedIn: v.checkedIn,
      }));
    },
  };
}

/** Counts for a public page: held now, on offer now, and used at a gate (a used ticket stays with its holder). */
export const tally = (tickets: HeldTicket[]) => ({
  held: tickets.length,
  listed: tickets.filter((t) => t.listPrice !== '0').length,
  checkedIn: tickets.filter((t) => t.checkedIn).length,
});
