import { expect, test } from 'vitest';
import { eventOutcome } from '../src/outcome';

const base = { status: 'ended' as const, cancelled: false, refundOpen: false, quorumMet: false, paidSold: 0, paidCheckedIn: 0, refunded: 0, settled: false };

test('an event on sale has no outcome yet', () => {
  expect(eventOutcome({ ...base, status: 'onsale' })).toBeNull();
});

test('cancelled: refunds are open, and how many went back is said once any did', () => {
  expect(eventOutcome({ ...base, status: 'cancelled', cancelled: true, refundOpen: true, paidSold: 5 }))
    .toEqual({ kind: 'cancelled', title: 'Sự kiện đã bị hủy', body: 'Mọi vé đã mua được hoàn đúng số tiền đã trả.', refundOpen: true });
  expect(eventOutcome({ ...base, status: 'cancelled', cancelled: true, refundOpen: true, paidSold: 5, refunded: 5 })!.body).toBe('Mọi vé đã mua được hoàn đúng số tiền đã trả. Đã hoàn 5 vé.');
});

test('no-show: fewer than half of the paid tickets were scanned, refunds are open', () => {
  const o = eventOutcome({ ...base, refundOpen: true, paidSold: 4, paidCheckedIn: 0 })!;
  expect([o.kind, o.refundOpen]).toEqual(['noshow', true]);
  expect(o.body).toBe('0/4 vé đã mua được soát ở cửa, chưa tới một nửa, nên sự kiện coi như không diễn ra và vé chưa soát được hoàn tiền.');
});

test('happened: at least half were scanned; settled says the organizer was paid', () => {
  expect(eventOutcome({ ...base, quorumMet: true, paidSold: 16, paidCheckedIn: 9 })).toEqual({ kind: 'happened', title: 'Sự kiện đã diễn ra', body: '9/16 vé đã mua được soát ở cửa.', refundOpen: false });
  expect(eventOutcome({ ...base, quorumMet: true, paidSold: 6, paidCheckedIn: 4, settled: true })!.body).toBe('4/6 vé đã mua được soát ở cửa. Ban tổ chức đã được thanh toán.');
});

test('ended without a quorum and without open refunds: settled after the hold, or nothing sold', () => {
  expect(eventOutcome({ ...base, paidSold: 4, paidCheckedIn: 1, settled: true, refunded: 2 }))
    .toEqual({ kind: 'ended', title: 'Sự kiện đã kết thúc', body: '1/4 vé đã mua được soát ở cửa. Đã hết hạn hoàn tiền. Đã hoàn 2 vé.', refundOpen: false });
  expect(eventOutcome({ ...base, quorumMet: true })!.body).toBe('Chưa bán được vé nào.');
});
