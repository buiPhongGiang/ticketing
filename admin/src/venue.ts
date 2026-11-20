// Door scans from the venue's own L1 (vegoc), as counted on the C-Chain by VenueCheckIns. GateLog on vegoc sends
// holder-signed scans over ICM; VenueCheckIns checks each against VeGoc. Everything here is public C-Chain data.
import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { blockChunks } from './logs';

export const venueCheckInsAbi = parseAbi([
  'function tallies(uint256) view returns (uint32 accepted, uint32 paidAccepted, uint32 rejected, uint32 batches)',
  'function venueQuorum(uint256) view returns (uint256 venuePaidCheckedIn, uint256 paidSold, uint256 veGocPaidCheckedIn, bool met)',
  'event BatchReceived(uint256 indexed eventId, uint256 batch, uint256 accepted, uint256 rejected)',
]);

export interface VenueBatch { batch: number; accepted: number; rejected: number; tx: Hex; block: bigint }
export interface VenueDoor {
  accepted: number;
  paidAccepted: number;
  rejected: number;
  venuePaid: number;
  paidSold: number;
  /** Paid tickets VeGoc itself counted at its own gate on the C-Chain. */
  veGocPaid: number;
  met: boolean;
  /** Newest first. */
  batches: VenueBatch[];
}

/** Share of paid tickets scanned at the venue door, and how many more scans reach VeGoc's one-half quorum. */
export function venueProgress(d: Pick<VenueDoor, 'venuePaid' | 'paidSold'>, quorumBps = 5000): { pct: number; missing: number } {
  if (d.paidSold === 0) return { pct: 0, missing: 0 };
  const need = Math.ceil((d.paidSold * quorumBps) / 10_000);
  return { pct: Math.min(100, Math.round((d.venuePaid / d.paidSold) * 100)), missing: Math.max(0, need - d.venuePaid) };
}

type Reader = Pick<PublicClient, 'readContract' | 'getLogs' | 'getBlockNumber'>;

export async function readVenueDoor(client: Reader, address: Address, eventId: number, fromBlock: bigint, chunk: bigint): Promise<VenueDoor> {
  const id = BigInt(eventId);
  const [tally, quorum, latest] = await Promise.all([
    client.readContract({ address, abi: venueCheckInsAbi, functionName: 'tallies', args: [id] }),
    client.readContract({ address, abi: venueCheckInsAbi, functionName: 'venueQuorum', args: [id] }),
    client.getBlockNumber(),
  ]);
  const [accepted, paidAccepted, rejected, count] = tally;
  const batches: VenueBatch[] = [];
  if (count > 0) {
    for (const [from, to] of blockChunks(fromBlock, latest, chunk)) {
      const logs = await client.getLogs({ address, event: venueCheckInsAbi[2], args: { eventId: id }, fromBlock: from, toBlock: to });
      for (const l of logs) {
        batches.push({ batch: Number(l.args.batch), accepted: Number(l.args.accepted), rejected: Number(l.args.rejected), tx: l.transactionHash!, block: l.blockNumber! });
      }
    }
  }
  batches.sort((a, b) => (a.block === b.block ? b.batch - a.batch : a.block > b.block ? -1 : 1));
  return {
    accepted, paidAccepted, rejected, venuePaid: Number(quorum[0]), paidSold: Number(quorum[1]), veGocPaid: Number(quorum[2]), met: quorum[3], batches,
  };
}
