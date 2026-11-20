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

describe('verifyOffline', () => {
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

  test('a ticket checked in online is refused offline before the next snapshot', async () => {
    const { chain } = fakeChain(snap());
    const gate = createOfflineGate({ store: memoryStore(), chain, scope: 't', now: () => NOW * 1000 });
    await gate.refresh();
    await gate.markIn('7');
    expect(await gate.verify(await qr())).toMatchObject({ code: 'AlreadyCheckedIn' });
  });
});
