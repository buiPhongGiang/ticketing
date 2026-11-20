// Offline gate. While online the gate keeps a snapshot of who holds each ticket of the events it scans, plus VeGoc's
// EIP-712 domain. With no network it checks a QR the same way the contract does (signer of CheckIn(tokenId, deadline)
// under that domain == holder in the snapshot, not expired, not already in), admits the guest and queues the scan.
// Back online, each queued scan is checked against the chain again and sent as a normal check-in. A scan that can no
// longer be sent (the ticket was resold or checked in since the snapshot, or the QR expired before the network came
// back) is kept and flagged for staff.
import { hexToBytes, recoverTypedDataAddress } from 'viem';
import { decodeQr, MAX_QR_SECONDS } from './index';
import type { Address, ErrorCode, GateSnapshot, JournalEntry, KeyValueStore, QrPayload, ScanVerdict, Ticket } from './types';

/** queued: admitted offline, not sent. sent: check-in transaction sent. synced: on chain. conflict: staff must look. */
export type QueueState = 'queued' | 'sent' | 'synced' | 'conflict';

export interface QueuedScan {
  tokenId: string;
  eventId: string;
  holder: Address;
  raw: string;
  deadline: string;
  /** Client clock (ms) at the scan */
  scannedAt: number;
  state: QueueState;
  hash?: string;
  /** Why it could not be recorded: OwnerChanged (resold since the snapshot), AlreadyCheckedIn, SignatureExpired, ... */
  conflict?: ErrorCode;
}

export type OfflineVerdict =
  | { kind: 'invalid-qr' }
  | { kind: 'no-snapshot' }
  | { kind: 'rejected'; code: ErrorCode; payload: QrPayload; owner?: Address }
  | { kind: 'expiring'; payload: QrPayload; secondsLeft: number }
  | { kind: 'ok'; payload: QrPayload; secondsLeft: number; eventName: string; tierName: string };

/** The same 15 seconds the online gate leaves for the transaction to land. */
export const MIN_SECONDS = 15;
/** Default age after which the holder list is no longer trusted offline: a ticket resold since would let the old holder in. */
export const MAX_LIST_AGE_SEC = 600;
/** secp256k1 group order / 2: OpenZeppelin's ECDSA refuses any s above it (malleable signatures). */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Accepts only what VeGoc's checkIn accepts through ECDSA.tryRecover: 65 bytes, v of 27 or 28, low s.
 * viem alone would also take a 64-byte compact signature, v of 0/1, or a high s.
 */
export function strictSignature(signature: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const b = hexToBytes(signature as `0x${string}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  return (b[64] === 27 || b[64] === 28) && s > 0n && s <= HALF_N;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pure check of one QR against a snapshot and the local queue. Sends nothing. */
export async function verifyOffline(raw: string, snap: GateSnapshot | null, queue: QueuedScan[], nowSec: number, maxAgeSec = MAX_LIST_AGE_SEC): Promise<OfflineVerdict> {
  const payload = decodeQr(raw);
  if (!payload) return { kind: 'invalid-qr' };
  if (!snap) return { kind: 'no-snapshot' };
  const reject = (code: ErrorCode, owner?: Address): OfflineVerdict => ({ kind: 'rejected', code, payload, owner });
  if (nowSec * 1000 - snap.takenAt > maxAgeSec * 1000) return reject('StaleList');
  if (payload.chainId !== snap.domain.chainId || !same(payload.contract, snap.domain.verifyingContract)) return reject('WrongNetwork');
  const t = snap.tickets[payload.tokenId];
  // Another event, or a ticket bought after the snapshot: nothing to check it against.
  if (!t) return reject('NotInSnapshot');
  const ev = snap.events[t.eventId];
  if (!ev) return reject('NotInSnapshot');
  if (ev.cancelled) return reject('EventCancelled');
  if (nowSec >= ev.endsAt) return reject('EventEnded');
  const remaining = Number(BigInt(payload.deadline) - BigInt(nowSec));
  if (remaining < 0) return reject('SignatureExpired');
  if (remaining > MAX_QR_SECONDS) return reject('DeadlineTooFar');
  if (t.checkedIn || queue.some((q) => q.tokenId === payload.tokenId)) return reject('AlreadyCheckedIn');
  if (!strictSignature(payload.signature)) return reject('InvalidSignature');
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: snap.domain,
      types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'CheckIn',
      message: { tokenId: BigInt(payload.tokenId), deadline: BigInt(payload.deadline) },
      signature: payload.signature,
    });
  } catch {
    return reject('InvalidSignature');
  }
  if (!same(signer, t.holder)) return same(signer, payload.holder) ? reject('OwnerChanged', t.holder) : reject('InvalidSignature');
  if (remaining < MIN_SECONDS) return { kind: 'expiring', payload, secondsLeft: remaining };
  return { kind: 'ok', payload, secondsLeft: remaining, eventName: ev.name, tierName: t.tierName };
}

/** What the queue needs from the ticket service. */
export interface GateChain {
  gateSnapshot(): Promise<GateSnapshot>;
  getTicket(tokenId: string): Promise<Ticket>;
  checkIn(raw: string): Promise<JournalEntry | ScanVerdict>;
  journal(): Promise<JournalEntry[]>;
}

export interface FlushReport {
  sent: number;
  synced: number;
  conflicts: QueuedScan[];
}

export function createOfflineGate({ store, chain, scope, now = Date.now, maxAgeSec = MAX_LIST_AGE_SEC }: { store: KeyValueStore; chain: GateChain; scope: string; now?: () => number; maxAgeSec?: number }) {
  const snapKey = `gate-snapshot:${scope}`;
  const queueKey = `gate-queue:${scope}`;
  let writes: Promise<unknown> = Promise.resolve();
  const nowSec = () => Math.floor(now() / 1000);

  const queue = async (): Promise<QueuedScan[]> => {
    await writes;
    return JSON.parse((await store.getItem(queueKey)) ?? '[]');
  };
  const update = (fn: (q: QueuedScan[]) => QueuedScan[]) => {
    const work = writes.then(async () => {
      const next = fn(JSON.parse((await store.getItem(queueKey)) ?? '[]'));
      await store.setItem(queueKey, JSON.stringify(next));
      return next;
    });
    writes = work.catch(() => {});
    return work;
  };
  const snapshot = async (): Promise<GateSnapshot | null> => JSON.parse((await store.getItem(snapKey)) ?? 'null');

  return {
    snapshot,
    queue,
    /** Reads the holders from the chain and keeps them. Throws if offline. */
    refresh: async () => {
      const snap = await chain.gateSnapshot();
      await store.setItem(snapKey, JSON.stringify(snap));
      return snap;
    },
    verify: async (raw: string) => verifyOffline(raw, await snapshot(), await queue(), nowSec(), maxAgeSec),
    /**
     * Online scans go through here too: a ticket already admitted offline (queued, sent or flagged) is refused even
     * though the chain does not know about it yet, so the network coming back cannot let it in a second time.
     */
    screenOnline: async <V extends ScanVerdict>(verdict: V): Promise<V | ScanVerdict> => {
      if (verdict.kind !== 'ok' && verdict.kind !== 'expiring') return verdict;
      const hit = (await queue()).find((q) => q.tokenId === verdict.payload.tokenId);
      if (!hit) return verdict;
      return { kind: 'rejected', code: hit.state === 'sent' ? 'InFlight' : 'AlreadyCheckedIn', payload: verdict.payload };
    },
    /** Admits the guest: verifies again (a second scan of the same QR is refused), then queues the scan. */
    admit: async (raw: string): Promise<OfflineVerdict> => {
      const v = await verifyOffline(raw, await snapshot(), await queue(), nowSec(), maxAgeSec);
      if (v.kind !== 'ok') return v;
      const snap = (await snapshot())!;
      const item: QueuedScan = { tokenId: v.payload.tokenId, eventId: snap.tickets[v.payload.tokenId].eventId, holder: snap.tickets[v.payload.tokenId].holder, raw, deadline: v.payload.deadline, scannedAt: now(), state: 'queued' };
      await update((q) => [...q, item]);
      return v;
    },
    /**
     * Sends every queued scan that the chain still accepts and flags the rest. Throws ServiceError('Network') if the
     * network is still down; scans already handled keep their new state.
     */
    flush: async (): Promise<FlushReport> => {
      const report: FlushReport = { sent: 0, synced: 0, conflicts: [] };
      const set = (tokenId: string, patch: Partial<QueuedScan>) => update((q) => q.map((x) => (x.tokenId === tokenId ? { ...x, ...patch } : x)));
      const entries = await chain.journal();
      for (const item of await queue()) {
        if (item.state === 'sent') {
          const e = entries.find((x) => x.hash === item.hash);
          if (e?.state === 'succeeded') { await set(item.tokenId, { state: 'synced' }); report.synced++; }
          else if (e?.state === 'reverted') { const c = { ...item, state: 'conflict' as const, conflict: e.reasonCode ?? 'Unknown' }; await set(item.tokenId, c); report.conflicts.push(c); }
          continue;
        }
        if (item.state !== 'queued') continue;
        const t = await chain.getTicket(item.tokenId);
        let conflict: ErrorCode | undefined;
        if (t.checkedIn) conflict = 'AlreadyCheckedIn';
        else if (!same(t.owner, item.holder)) conflict = 'OwnerChanged';
        else if (Number(BigInt(item.deadline) - BigInt(nowSec())) < MIN_SECONDS) conflict = 'SignatureExpired';
        if (!conflict) {
          const r = await chain.checkIn(item.raw);
          if ('hash' in r) { await set(item.tokenId, { state: 'sent', hash: r.hash }); report.sent++; continue; }
          conflict = r.kind === 'rejected' ? r.code : r.kind === 'expiring' ? 'SignatureExpired' : 'Unknown';
        }
        const c = { ...item, state: 'conflict' as const, conflict };
        await set(item.tokenId, c);
        report.conflicts.push(c);
      }
      return report;
    },
    /** A ticket checked in online: an offline scan of it later must be refused even before the next snapshot. */
    markIn: async (tokenId: string) => {
      const snap = await snapshot();
      if (!snap?.tickets[tokenId]) return;
      snap.tickets[tokenId].checkedIn = true;
      await store.setItem(snapKey, JSON.stringify(snap));
    },
  };
}

export type OfflineGate = ReturnType<typeof createOfflineGate>;
