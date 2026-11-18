import { expect, test } from 'vitest';
import { formatAmount, formatFee, formatSeconds, timeAgo } from '../src/format';

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
  [NOW - 5, 'Just now'],
  [NOW - 59, 'Just now'],
  [NOW - 60, '1 min ago'],
  [NOW - 3599, '59 min ago'],
  [NOW - 3600, '1 h ago'],
  [NOW - 86_400, '1 d ago'],
  // Clocks disagree a little, so a block slightly in the future is still just now.
  [NOW + 30, 'Just now'],
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
  expect(eventDate(1795867200)).toBe('28 Nov · 19:00');
});
test('a show of one evening shows its start; a run of several days shows first and last day', () => {
  expect(eventWhen(1796472000, 1796486400)).toBe('5 Dec · 19:00');
  expect(eventWhen(1795086000, 1797177600)).toBe('19 Nov – 13 Dec');
});
