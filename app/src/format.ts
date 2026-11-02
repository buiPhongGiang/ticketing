const UNIT = 1_000_000_000_000n; // wei per displayed step: 6 decimals of an 18-decimal coin

/** Up to 6 decimals, rounded up so a fee estimate never reads lower than it is. */
export function formatAmount(wei: string | bigint, symbol: string): string {
  const value = BigInt(wei);
  const steps = (value + UNIT - 1n) / UNIT;
  const whole = steps / 1_000_000n;
  const fraction = (steps % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
}
