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
