import { expect, test } from 'vitest';
import { formatAmount, timeAgo } from '../src/format';

test.each([
  ['10000000000000000', '0.01 AVAX'],
  ['1000000000000000000', '1 AVAX'],
  ['1500000000000000000', '1.5 AVAX'],
  // A fee is rounded up, so the estimate is never lower than the real number.
  ['230957658393860', '0.000231 AVAX'],
  ['1', '0.000001 AVAX'],
  ['0', '0 AVAX'],
])('%s wei reads as %s', (wei, want) => {
  expect(formatAmount(wei, 'AVAX')).toBe(want);
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

import { eventDate, formatUsdc, parseUsdc } from '../src/format';
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
