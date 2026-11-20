import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { createLocalSigner, encodeQr, memoryStore, ServiceError, type GateSnapshot, type JournalEntry, type QrPayload, type Ticket } from '../src/lib';
import { createOfflineGate, verifyOffline, type GateChain, type QueuedScan } from '../src/lib/offline';

const CONTRACT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address;
const holder = createLocalSigner(`0x${'11'.repeat(32)}` as Hex);
const buyer = createLocalSigner(`0x${'22'.repeat(32)}` as Hex);
const NOW = 1_900_000_000;

function snap(over: Partial<GateSnapshot['tickets'][string]> = {}, ev: Partial<GateSnapshot['events'][string]> = {}): GateSnapshot {
  return {
    v: 1, takenAt: NOW * 1000, gate: '0x0000000000000000000000000000000000000003',
    domain: { name: 'VeGoc', version: '1', chainId: 31337, verifyingContract: CONTRACT },
    events: { '0': { name: 'Test Fest', endsAt: NOW + 3600, cancelled: false, ...ev } },
    tickets: { '7': { eventId: '0', tierName: 'GA', holder: holder.address, checkedIn: false, ...over } },
  };
}

async function qr(signer = holder, tokenId = '7', deadline = NOW + 180, chainId = 31337): Promise<string> {
  const signature = await signer.signCheckIn({ chainId, contract: CONTRACT, tokenId, deadline: String(deadline) });
  const p: QrPayload = { v: 1, chainId, contract: CONTRACT, tokenId, deadline: String(deadline), holder: signer.address, signature };
  return encodeQr(p);
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Same signature, other encodings: high s (v flipped), v as 0/1, and the 64-byte compact form (EIP-2098). */
function variants(sig: string) {
  const r = sig.slice(2, 66), s = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
  const highS = `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
  const lowV = `0x${r}${sig.slice(66, 130)}${(v - 27).toString(16).padStart(2, '0')}`;
  const compact = `0x${r}${((v === 28 ? 1n << 255n : 0n) | s).toString(16).padStart(64, '0')}`;
  return { highS, lowV, compact };
}

describe('verifyOffline', () => {
  test('only signatures the contract would accept: high s, v of 0/1 and 64-byte compact are refused', async () => {
    const raw = JSON.parse(await qr());
    for (const [name, sig] of Object.entries(variants(raw.signature))) {
      const v = await verifyOffline(JSON.stringify({ ...raw, signature: sig }), snap(), [], NOW);
      expect([name, v]).toMatchObject([name, { kind: 'rejected', code: 'InvalidSignature' }]);
    }
    expect(await verifyOffline(JSON.stringify(raw), snap(), [], NOW)).toMatchObject({ kind: 'ok' });
  });

  test('a holder list older than the limit is refused (a resale since could let the old holder in)', async () => {
    const old = { ...snap(), takenAt: (NOW - 601) * 1000 };
    expect(await verifyOffline(await qr(), old, [], NOW)).toMatchObject({ kind: 'rejected', code: 'StaleList' });
    expect(await verifyOffline(await qr(), { ...old, takenAt: (NOW - 599) * 1000 }, [], NOW)).toMatchObject({ kind: 'ok' });
    expect(await verifyOffline(await qr(), { ...old, takenAt: (NOW - 120) * 1000 }, [], NOW, 60)).toMatchObject({ code: 'StaleList' });
  });

  test('a QR signed by the holder in the snapshot is valid with no network', async () => {
    const v = await verifyOffline(await qr(), snap(), [], NOW);
    expect(v).toMatchObject({ kind: 'ok', eventName: 'Test Fest', tierName: 'GA', secondsLeft: 180 });
  });

  test('a QR from a previous holder is refused and names the holder in the snapshot', async () => {
    const v = await verifyOffline(await qr(buyer), snap(), [], NOW);
    expect(v).toMatchObject({ kind: 'rejected', code: 'OwnerChanged', owner: holder.address });
  });

  test('a forged signature is refused', async () => {
    const raw = JSON.parse(await qr());
    raw.signature = (await buyer.signCheckIn({ chainId: 31337, contract: CONTRACT, tokenId: '8', deadline: raw.deadline }));
    raw.holder = holder.address;
    expect(await verifyOffline(JSON.stringify(raw), snap(), [], NOW)).toMatchObject({ kind: 'rejected', code: 'InvalidSignature' });
  });

  test('a QR for another chain or contract is refused', async () => {
    expect(await verifyOffline(await qr(holder, '7', NOW + 180, 43113), snap(), [], NOW)).toMatchObject({ kind: 'rejected', code: 'WrongNetwork' });
  });

  test('expired, too long, expiring', async () => {
    expect(await verifyOffline(await qr(holder, '7', NOW - 1), snap(), [], NOW)).toMatchObject({ code: 'SignatureExpired' });
    expect(await verifyOffline(await qr(holder, '7', NOW + 301), snap(), [], NOW)).toMatchObject({ code: 'DeadlineTooFar' });
    expect(await verifyOffline(await qr(holder, '7', NOW + 10), snap(), [], NOW)).toMatchObject({ kind: 'expiring', secondsLeft: 10 });
  });

  test('already checked in on chain at the snapshot, or already in the local queue', async () => {
    expect(await verifyOffline(await qr(), snap({ checkedIn: true }), [], NOW)).toMatchObject({ code: 'AlreadyCheckedIn' });
    const queued = [{ tokenId: '7', state: 'queued' } as QueuedScan];
    expect(await verifyOffline(await qr(), snap(), queued, NOW)).toMatchObject({ code: 'AlreadyCheckedIn' });
  });

  test('unknown ticket, cancelled or ended event, no snapshot, garbage', async () => {
    expect(await verifyOffline(await qr(holder, '9'), snap(), [], NOW)).toMatchObject({ code: 'NotInSnapshot' });
    expect(await verifyOffline(await qr(), snap({}, { cancelled: true }), [], NOW)).toMatchObject({ code: 'EventCancelled' });
    expect(await verifyOffline(await qr(), snap({}, { endsAt: NOW }), [], NOW)).toMatchObject({ code: 'EventEnded' });
    expect(await verifyOffline(await qr(), null, [], NOW)).toEqual({ kind: 'no-snapshot' });
    expect(await verifyOffline('hello', snap(), [], NOW)).toEqual({ kind: 'invalid-qr' });
  });
});

/** A chain that answers from a table; `down` makes every call fail like a dropped connection. */
function fakeChain(s: GateSnapshot) {
  const state = { down: false, owner: holder.address as Address, checkedIn: false, sent: [] as string[], journal: [] as JournalEntry[] };
  const guard = () => { if (state.down) throw new ServiceError('Network'); };
  const chain: GateChain = {
    gateSnapshot: async () => { guard(); return s; },
    getTicket: async (tokenId) => { guard(); return { tokenId, owner: state.owner, checkedIn: state.checkedIn } as Ticket; },
    checkIn: async (raw) => {
      guard();
      const hash = `0x${String(state.sent.length + 1).padStart(64, '0')}`;
      state.sent.push(raw);
      state.journal.push({ id: hash, hash, state: 'pending' } as JournalEntry);
      return state.journal.at(-1)!;
    },
    journal: async () => state.journal,
  };
  return { chain, state };
}

describe('offline queue', () => {
  test('snapshot while online, admit offline once, flush when back online', async () => {
    let clock = NOW * 1000;
    const { chain, state } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => clock });
    await gate.refresh();
    state.down = true;
    await expect(gate.refresh()).rejects.toThrow();
    const raw = await qr();
    expect(await gate.admit(raw)).toMatchObject({ kind: 'ok' });
    // Same QR again at the same door: refused locally.
    expect(await gate.admit(raw)).toMatchObject({ kind: 'rejected', code: 'AlreadyCheckedIn' });
    expect((await gate.queue()).map((q) => q.state)).toEqual(['queued']);
    await expect(gate.flush()).rejects.toThrow();
    expect((await gate.queue())[0].state).toBe('queued');

    state.down = false;
    clock += 30_000;
    const r = await gate.flush();
    expect(r).toMatchObject({ sent: 1, conflicts: [] });
    expect(state.sent).toEqual([raw]);
    expect((await gate.queue())[0]).toMatchObject({ state: 'sent', hash: state.journal[0].hash });
    state.journal[0].state = 'succeeded';
    expect(await gate.flush()).toMatchObject({ synced: 1 });
    expect((await gate.queue())[0].state).toBe('synced');
  });

  test('resold since the snapshot: flagged, not sent', async () => {
    const { chain, state } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => NOW * 1000 });
    await gate.refresh();
    await gate.admit(await qr());
    state.owner = buyer.address;
    const r = await gate.flush();
    expect(r.conflicts.map((c) => c.conflict)).toEqual(['OwnerChanged']);
    expect(state.sent).toEqual([]);
  });

  test('checked in on chain by another door since the snapshot: flagged', async () => {
    const { chain, state } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => NOW * 1000 });
    await gate.refresh();
    await gate.admit(await qr());
    state.checkedIn = true;
    expect((await gate.flush()).conflicts[0].conflict).toBe('AlreadyCheckedIn');
  });

  test('QR expired before the network came back: flagged, kept for staff', async () => {
    let clock = NOW * 1000;
    const { chain, state } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => clock });
    await gate.refresh();
    await gate.admit(await qr());
    clock += 170_000;
    expect((await gate.flush()).conflicts[0]).toMatchObject({ state: 'conflict', conflict: 'SignatureExpired', tokenId: '7' });
    expect(state.sent).toEqual([]);
  });

  test('back online, a ticket admitted offline is refused by the online path too (no second entry)', async () => {
    const { chain, state } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => NOW * 1000 });
    await gate.refresh();
    const raw = await qr();
    await gate.admit(raw);
    const payload = JSON.parse(raw) as QrPayload;
    const online = { kind: 'ok' as const, payload, secondsLeft: 100 };
    // Queued, not sent yet: the chain would still say valid.
    expect(await gate.screenOnline(online)).toMatchObject({ kind: 'rejected', code: 'AlreadyCheckedIn' });
    await gate.flush();
    expect(await gate.screenOnline(online)).toMatchObject({ kind: 'rejected', code: 'InFlight' });
    state.owner = buyer.address;
    // Flagged scans keep the ticket refused as well.
    const other = createOfflineGate({ store: memoryStore(), chain, scope: 'u', now: () => NOW * 1000 });
    await other.refresh();
    state.owner = holder.address;
    await other.admit(raw);
    state.checkedIn = true;
    await other.flush();
    expect((await other.queue())[0].state).toBe('conflict');
    expect(await other.screenOnline(online)).toMatchObject({ kind: 'rejected', code: 'AlreadyCheckedIn' });
    // Another ticket passes through untouched.
    const seven = { ...online, payload: { ...payload, tokenId: '8' } };
    expect(await gate.screenOnline(seven)).toBe(seven);
  });

  test('a stale list refuses offline admission after the configured age', async () => {
    let clock = NOW * 1000;
    const { chain } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => clock, maxAgeSec: 120 });
    await gate.refresh();
    clock += 121_000;
    expect(await gate.admit(await qr(holder, '7', NOW + 250))).toMatchObject({ kind: 'rejected', code: 'StaleList' });
    expect(await gate.queue()).toEqual([]);
  });

  test('a ticket checked in online is refused offline before the next snapshot', async () => {
    const { chain } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => NOW * 1000 });
    await gate.refresh();
    await gate.markIn('7');
    expect(await gate.verify(await qr())).toMatchObject({ code: 'AlreadyCheckedIn' });
  });
});
