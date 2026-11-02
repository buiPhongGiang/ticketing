import { expect, test } from 'vitest';
import { formatAmount } from '../src/format';

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
