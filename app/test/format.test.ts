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
