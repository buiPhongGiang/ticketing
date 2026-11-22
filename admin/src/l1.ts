// The venue's own L1 (vegoc), read directly from its public RPC: door scans in GateLog before they travel to the
// C-Chain, and the outcome of each event as AttendanceMirror received it from AttendanceRelay. No config here, so the
// rules are unit-tested with fake clients.
import { parseAbi, zeroHash, type Address, type Hex, type PublicClient } from 'viem';

export const gateLogAbi = parseAbi([
  'function scanCount(uint256) view returns (uint256)',
  'function sentUpTo(uint256) view returns (uint256)',
  'function batches(uint256) view returns (uint256)',
  'function scans(uint256) view returns ((uint256 tokenId, address holder, uint64 at)[])',
]);

export const mirrorAbi = parseAbi([
  'function records(uint256) view returns (address organizer, uint8 outcome, uint32 paidSold, uint32 paidCheckedIn)',
]);

export const relayAbi = parseAbi([
  'function messageOf(uint256) view returns (bytes32)',
  'function outcomeOf(uint256) view returns (uint8 outcome, uint256 paidSold, uint256 paidCheckedIn)',
  'function relay(uint256 eventId) returns (bytes32 messageID)',
  'error NotFinal()',
  'error AlreadyRelayed()',
]);

type Reader = Pick<PublicClient, 'readContract'>;

export interface DoorScan { tokenId: number; holder: Address; at: number }
export interface DoorLog {
  /** Every scan the gate devices recorded on the L1 for this event, newest first. */
  scans: DoorScan[];
  /** Scans already sent to the C-Chain. */
  sent: number;
  /** Scans recorded but not sent yet: the next attestation carries them. */
  waiting: number;
  batches: number;
}

export async function readDoorLog(l1: Reader, gateLog: Address, eventId: number): Promise<DoorLog> {
  const id = BigInt(eventId);
  const [scans, sent, batches] = await Promise.all([
    l1.readContract({ address: gateLog, abi: gateLogAbi, functionName: 'scans', args: [id] }),
    l1.readContract({ address: gateLog, abi: gateLogAbi, functionName: 'sentUpTo', args: [id] }),
    l1.readContract({ address: gateLog, abi: gateLogAbi, functionName: 'batches', args: [id] }),
  ]);
  const all = scans.map((s) => ({ tokenId: Number(s.tokenId), holder: s.holder, at: Number(s.at) }));
  return { scans: all.reverse(), sent: Number(sent), waiting: Math.max(0, all.length - Number(sent)), batches: Number(batches) };
}

/** AttendanceRelay.Outcome */
export type Outcome = 'none' | 'happened' | 'noshow' | 'cancelled';
const OUTCOMES: Outcome[] = ['none', 'happened', 'noshow', 'cancelled'];
export const outcomeOf = (n: number): Outcome => OUTCOMES[n] ?? 'none';
export const OUTCOME_LABEL: Record<Outcome, string> = { none: 'Chưa chốt', happened: 'Đã diễn ra', noshow: 'Không đủ lượt vào cửa', cancelled: 'Đã huỷ' };

/**
 * running: the event has no final outcome yet. ready: final, nobody sent it. sent: on its way, the L1 has no record
 * yet. delivered: AttendanceMirror on the L1 stores it.
 */
export type OutcomeStage = 'running' | 'ready' | 'sent' | 'delivered';
export interface OutcomeState {
  stage: OutcomeStage;
  outcome: Outcome;
  paidSold: number;
  paidCheckedIn: number;
  /** Teleporter message id, once sent. */
  messageId?: Hex;
}

export function outcomeState(now: { outcome: number; paidSold: number; paidCheckedIn: number }, messageId: Hex, record: { outcome: number; paidSold: number; paidCheckedIn: number }): OutcomeState {
  const sent = messageId !== zeroHash;
  // What the L1 stored wins: it is what contracts there act on, and it never changes after delivery.
  if (record.outcome !== 0) return { stage: 'delivered', outcome: outcomeOf(record.outcome), paidSold: record.paidSold, paidCheckedIn: record.paidCheckedIn, messageId: sent ? messageId : undefined };
  const base = { outcome: outcomeOf(now.outcome), paidSold: now.paidSold, paidCheckedIn: now.paidCheckedIn };
  if (sent) return { stage: 'sent', ...base, messageId };
  return { stage: now.outcome === 0 ? 'running' : 'ready', ...base };
}

export async function readOutcome(fuji: Reader, relay: Address, l1: Reader, mirror: Address, eventId: number): Promise<OutcomeState> {
  const id = BigInt(eventId);
  const [messageId, now, record] = await Promise.all([
    fuji.readContract({ address: relay, abi: relayAbi, functionName: 'messageOf', args: [id] }),
    fuji.readContract({ address: relay, abi: relayAbi, functionName: 'outcomeOf', args: [id] }),
    l1.readContract({ address: mirror, abi: mirrorAbi, functionName: 'records', args: [id] }),
  ]);
  return outcomeState(
    { outcome: Number(now[0]), paidSold: Number(now[1]), paidCheckedIn: Number(now[2]) },
    messageId,
    { outcome: Number(record[1]), paidSold: Number(record[2]), paidCheckedIn: Number(record[3]) },
  );
}
