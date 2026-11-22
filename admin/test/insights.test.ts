import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { activeGates, candidates, deviceKind, readDevices, roleOf, TX_ALLOW_LIST, type L1Device } from '../src/devices';
import { lifecycle, pctOfCap, platformFee, quorumView, tierSales, type LifeFacts } from '../src/insights';
import type { LogEntry } from '../src/logs';
import type { EventInfo, TierInfo } from '../src/model';

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const tiers: TierInfo[] = [{ name: 'GA', price: 15_000000n, supply: 80, sold: 14 }, { name: 'VIP', price: 40_000000n, supply: 10, sold: 3 }];
const ev = (patch: Partial<EventInfo> = {}): EventInfo => ({
  id: 1, organizer: A, name: 'Indie', venue: 'Hall', startsAt: 1000, endsAt: 2000, maxPerWallet: 4, cancelled: false, settled: false,
  issued: 17, checkedIn: 6, refunded: 0, resales: 1, sales: 330_000000n, resaleVolume: 0n, resaleFaceVolume: 0n, tiers, principal: 330_000000n, yieldAccrued: 0n, listed: 0,
  settleAt: 2000, refundOpen: false, quorumMet: true, paidSold: 16, paidCheckedIn: 8, waiting: [1, 0], ...patch,
});
const entry = (kind: LogEntry['kind'], patch: Partial<LogEntry> = {}): LogEntry => ({ id: `${kind}:${patch.logIndex ?? 0}`, kind, block: 1n, logIndex: 0, hash: `0x${kind.length.toString(16).padStart(64, '0')}` as Hex, timestamp: 900, eventId: 1, ...patch });
const facts = (patch: Partial<LifeFacts> = {}): LifeFacts => ({ refundsLeft: 0, yieldNow: 0n, feeBps: 300, ...patch });
const shape = (l: ReturnType<typeof lifecycle>) => l.steps.map((s) => `${s.key}:${s.state}`);

describe('lifecycle', () => {
  test('on sale: the organizer can cancel, settlement has no date yet', () => {
    const l = lifecycle(ev(), 1500, facts({ created: entry('EventCreated') }));
    expect(shape(l)).toEqual(['onsale:now', 'ended:next', 'settled:next']);
    expect(l.action).toBe('cancel');
    expect(l.steps[0]).toMatchObject({ at: 900, note: 'Đã phát hành 17/90 vé' });
    expect(l.steps[1].at).toBe(2000);
    expect(l.steps[2].at).toBeUndefined();
  });
  test('ended with the door quorum met: settle now, fee named in đồng', () => {
    const l = lifecycle(ev(), 2001, facts());
    expect(shape(l)).toEqual(['onsale:done', 'ended:done', 'settled:now']);
    expect(l.action).toBe('settle');
    expect(l.steps[1].note).toBe('8/16 vé trả tiền đã vào cửa, đủ một nửa');
    // 330 USDC at 26.000 đ, 3 % of it
    expect(l.steps[2].note).toBe('Đang giữ 8.580.000đ. Phí nền tảng 3% là 257.400đ.');
  });
  test('settled: nothing left to do, the Settled log gives time, hash and amounts', () => {
    const settled = entry('Settled', { timestamp: 2100, amount: 320_100000n, yieldPaid: 1_000000n, fee: 9_900000n });
    const l = lifecycle(ev({ settled: true, principal: 0n }), 3000, facts({ settled }));
    expect(shape(l)).toEqual(['onsale:done', 'ended:done', 'settled:done']);
    expect(l.action).toBe('none');
    expect(l.steps[2]).toMatchObject({ at: 2100, hash: settled.hash, note: 'Đã chuyển 8.322.600đ tiền vé và 26.000đ lãi · phí nền tảng 257.400đ' });
  });
  test('cancelled: refund while tickets are owed, then the yield, then nothing', () => {
    const cancelled = entry('Cancelled', { timestamp: 1200 });
    const owing = lifecycle(ev({ cancelled: true }), 1300, facts({ cancelled, refundsLeft: 16 }));
    expect(shape(owing)).toEqual(['onsale:done', 'cancelled:done', 'refunded:now']);
    expect(owing.action).toBe('refund');
    expect(owing.steps[1]).toMatchObject({ at: 1200, hash: cancelled.hash });
    expect(owing.steps[2].note).toBe('Còn 16 vé chưa hoàn · đã hoàn 0 vé');
    const paid = lifecycle(ev({ cancelled: true, refunded: 16, principal: 0n }), 1300, facts({ cancelled, yieldNow: 5n }));
    expect(shape(paid)).toEqual(['onsale:done', 'cancelled:done', 'refunded:done']);
    expect(paid.action).toBe('yield');
    expect(lifecycle(ev({ cancelled: true, refunded: 16 }), 1300, facts()).action).toBe('none');
    // Tickets not read yet: no button is offered on a guess.
    expect(lifecycle(ev({ cancelled: true }), 1300, facts({ refundsLeft: null })).action).toBe('wait');
  });
  test('ended below the quorum: refunds for 48 h, then settlement of what is left', () => {
    const e = ev({ paidCheckedIn: 2, quorumMet: false, settleAt: 2000 + 48 * 3600 });
    const during = lifecycle(e, 2500, facts({ refundsLeft: 14 }));
    expect(during.status).toBe('noshow');
    expect(shape(during)).toEqual(['onsale:done', 'ended:done', 'refunds:now', 'settled:next']);
    expect(during.action).toBe('refund');
    expect(during.steps[1].note).toBe('Chỉ 2/16 vé trả tiền đã vào cửa, chưa đủ một nửa');
    expect(lifecycle(e, 2500, facts({ refundsLeft: 0 })).action).toBe('wait');
    const after = lifecycle(e, e.settleAt + 1, facts({ refundsLeft: 0 }));
    expect(shape(after)).toEqual(['onsale:done', 'ended:done', 'refunds:done', 'settled:now']);
    expect(after.action).toBe('settle');
  });
});

describe('sales', () => {
  const mints = [
    entry('Purchased', { tier: 0, quantity: 2, amount: 30_000000n, logIndex: 1 }),
    entry('Purchased', { tier: 0, quantity: 1, amount: 15_000000n, logIndex: 2 }),
    entry('Issued', { tier: 0, quantity: 3, amount: 0n, logIndex: 3 }),
    entry('Purchased', { tier: 1, quantity: 1, amount: 40_000000n, logIndex: 4 }),
  ];
  test('per tier: issued and left from the contract, paid, comps and money from the mint logs', () => {
    expect(tierSales(ev(), mints)).toEqual([
      { name: 'GA', price: 15_000000n, supply: 80, sold: 14, left: 66, paid: 3, comps: 3, revenue: 45_000000n },
      { name: 'VIP', price: 40_000000n, supply: 10, sold: 3, left: 7, paid: 1, comps: 0, revenue: 40_000000n },
    ]);
  });
  test('an incomplete log history gives no paid/comp split rather than a low number', () => {
    expect(tierSales(ev(), null)[0]).toMatchObject({ sold: 14, left: 66, paid: null, comps: null, revenue: null });
  });
  test('platform fee: an estimate on the float, the Settled log once taken, none after a cancel', () => {
    expect(platformFee(ev(), 300, [])).toEqual({ kind: 'estimate', amount: 9_900000n });
    expect(platformFee(ev({ settled: true, principal: 0n }), 300, [entry('Settled', { fee: 9_900000n })])).toEqual({ kind: 'collected', amount: 9_900000n });
    expect(platformFee(ev({ cancelled: true }), 300, [])).toEqual({ kind: 'none', amount: 0n });
    expect(platformFee(ev(), 0, [])).toEqual({ kind: 'none', amount: 0n });
  });
  test('door quorum: half of the paid tickets, rounded up', () => {
    expect(quorumView(ev({ paidSold: 14, paidCheckedIn: 0 }))).toEqual({ need: 7, missing: 7, met: false, pct: 0 });
    expect(quorumView(ev({ paidSold: 15, paidCheckedIn: 8 }))).toEqual({ need: 8, missing: 0, met: true, pct: 53 });
    expect(quorumView(ev({ paidSold: 0, paidCheckedIn: 0 }))).toEqual({ need: 0, missing: 0, met: true, pct: 0 });
  });
  test('a listing against its cap', () => {
    expect(pctOfCap(15_750000n, 16_500000n)).toBe(95.4);
    expect(pctOfCap(16_500000n, 16_500000n)).toBe(100);
    expect(pctOfCap(1n, 0n)).toBe(0);
  });
});

describe('gate devices on the venue L1', () => {
  const VENUE = '0x6732CcE43f5a68Ab29ee75F1e8eF9eD939C865Ab' as Address;
  const GATE = '0x058b326D8A3B7f69FAC9cFB0a772a63e4d26FAA1' as Address;
  const RELAYER = '0x474044236309DC089A92c5AB9A3daF853831F1DC' as Address;
  const GONE = '0x6dEBabaf08f744e91F426cDA577a58A5787BCdF0' as Address;
  const d = (patch: Partial<L1Device>): L1Device => ({ address: A, role: 'none', gate: false, venue: false, ...patch });

  test('roles and what each wallet is at the door', () => {
    expect([0, 1, 2, 3, 9].map(roleOf)).toEqual(['none', 'enabled', 'admin', 'manager', 'none']);
    expect(deviceKind(d({ role: 'enabled', gate: true }))).toBe('gate');
    // Named in GateLog but taken off the allow list: the chain refuses its transactions.
    expect(deviceKind(d({ role: 'none', gate: true }))).toBe('gate-blocked');
    expect(deviceKind(d({ role: 'admin', venue: true }))).toBe('venue');
    expect(deviceKind(d({ role: 'enabled' }))).toBe('sender');
    expect(deviceKind(d({ role: 'admin' }))).toBe('admin');
    expect(deviceKind(d({}))).toBe('removed');
  });
  test('candidates are merged without case and keep the first spelling', () => {
    expect(candidates([VENUE, GATE], [GATE.toLowerCase() as Address, GONE])).toEqual([VENUE, GATE, GONE]);
  });
  test('reads every candidate from the precompile and GateLog, gate devices first, removed ones last', async () => {
    const roles: Record<string, bigint> = { [VENUE.toLowerCase()]: 2n, [GATE.toLowerCase()]: 1n, [RELAYER.toLowerCase()]: 1n, [GONE.toLowerCase()]: 0n };
    const calls: string[] = [];
    const l1 = {
      getLogs: async ({ address }: { address: Address }) => (address === TX_ALLOW_LIST
        ? [{ args: { account: GONE }, transactionHash: '0xaa' }, { args: { account: GONE }, transactionHash: '0xbb' }]
        : [{ args: { gate: GATE } }, { args: { gate: GONE } }]),
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly Address[] }) => {
        calls.push(functionName);
        if (functionName === 'venue') return VENUE;
        if (functionName === 'readAllowList') return roles[args![0].toLowerCase()] ?? 0n;
        return args![0] === GATE;
      },
    };
    const list = await readDevices(l1 as never, A, [VENUE, RELAYER]);
    expect(list.map((x) => [x.address, deviceKind(x)])).toEqual([[GATE, 'gate'], [VENUE, 'venue'], [RELAYER, 'sender'], [GONE, 'removed']]);
    expect(list[3].changedTx).toBe('0xbb');
    expect(activeGates(list)).toBe(1);
    expect(calls.filter((c) => c === 'readAllowList')).toHaveLength(4);
  });
});
