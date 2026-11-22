import { expect, test } from 'vitest';
import { formatAmount, formatFee, formatSeconds, formatVnd, parseVnd, timeAgo, vndDigits } from '../src/format';

test.each([
  ['10000000000000000', '0.01 AVAX'],
  ['1000000000000000000', '1 AVAX'],
  ['1500000000000000000', '1.5 AVAX'],
  // A balance is rounded down, so it never reads higher than what the wallet holds.
  ['230957658393860', '0.00023 AVAX'],
  ['54999999875488164', '0.054999 AVAX'],
  ['1', '0 AVAX'],
  ['0', '0 AVAX'],
])('balance of %s wei reads as %s', (wei, want) => {
  expect(formatAmount(wei, 'AVAX')).toBe(want);
});

test.each([
  // Fuji, 18 Nov 2026: 176,098 gas at 160 wei. Six decimals rounded up used to print 0.000001 AVAX, 35,000 times too much.
  ['28175680', '0.028 nAVAX'],
  ['8438880', '0.0084 nAVAX'],
  // 176,098 gas at a 7.5 nAVAX mainnet base fee
  ['1320735000000000', '0.0013 AVAX'],
  ['168000000000000', '0.00017 AVAX'],
  ['999999999999', '1,000 nAVAX'],
  ['1000000000000', '0.000001 AVAX'],
  ['2500000000', '2.5 nAVAX'],
  ['1', '< 0.000001 nAVAX'],
  ['0', '0 AVAX'],
])('fee of %s wei reads as %s', (wei, want) => {
  expect(formatFee(wei, 'AVAX')).toBe(want);
});

test('seconds to receipt', () => {
  expect(formatSeconds(1432)).toBe('1.4 s');
  expect(formatSeconds(960)).toBe('1.0 s');
});

const NOW = 1_000_000;
test.each([
  [NOW - 5, 'Vừa xong'],
  [NOW - 59, 'Vừa xong'],
  [NOW - 60, '1 phút trước'],
  [NOW - 3599, '59 phút trước'],
  [NOW - 3600, '1 giờ trước'],
  [NOW - 86_400, '1 ngày trước'],
  // Clocks disagree a little, so a block slightly in the future is still just now.
  [NOW + 30, 'Vừa xong'],
])('block time %i reads as %s', (timestamp, want) => {
  expect(timeAgo(timestamp, NOW)).toBe(want);
});

import { eventDate, eventWhen, formatUsdc, parseUsdc } from '../src/format';
test.each([
  ['25000000', '25.00'],
  ['27500000', '27.50'],
  ['1250000', '1.25'],
  ['1234567', '1.234567'],
  ['1000000000000', '1,000,000.00'],
  ['0', '0.00'],
])('%s USDC units read as %s', (u, want) => expect(formatUsdc(u)).toBe(want));
test.each([
  ['27.5', 27_500_000n],
  ['27,50', 27_500_000n],
  ['25', 25_000_000n],
  ['0.000001', 1n],
  ['1.0000001', null],
  ['abc', null],
  ['-1', null],
])('"%s" parses to %s', (s, want) => expect(parseUsdc(s)).toBe(want));
test('event dates are shown in Vietnam time', () => {
  expect(eventDate(1795867200)).toBe('28/11 · 19:00');
});
test('a show of one evening shows its start; a run of several days shows first and last day', () => {
  expect(eventWhen(1796472000, 1796486400)).toBe('5/12 · 19:00');
  expect(eventWhen(1795086000, 1797177600)).toBe('19/11 – 13/12');
});

test.each([
  ['25000000', '650.000đ'],
  ['27500000', '715.000đ'],
  ['60000000', '1.560.000đ'],
  ['64800000', '1.684.800đ'],
  ['0', '0đ'],
  ['1', '0đ'],
])('%s USDC units read as %s at 26,000 đ', (units, want) => {
  expect(formatVnd(units, 26_000n)).toBe(want);
});

test('đồng typed by a seller back to USDC units, never above what was typed', () => {
  expect(parseVnd('715.000', 26_000n)).toBe(27_500_000n);
  expect(parseVnd('702000', 26_000n)).toBe(27_000_000n);
  expect(parseVnd('715.000đ', 26_000n)).toBe(27_500_000n);
  expect(parseVnd('1', 26_000n)).toBe(38n);
  expect(parseVnd('', 26_000n)).toBeNull();
  expect(parseVnd('7,5a', 26_000n)).toBeNull();
  expect(vndDigits(27_500_000n, 26_000n)).toBe('715.000');
});
