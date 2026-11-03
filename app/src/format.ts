const UNIT = 1_000_000_000_000n; // wei per displayed step: 6 decimals of an 18-decimal coin

/** Up to 6 decimals, rounded up so a fee estimate never reads lower than it is. */
export function formatAmount(wei: string | bigint, symbol: string): string {
  const value = BigInt(wei);
  const steps = (value + UNIT - 1n) / UNIT;
  const whole = steps / 1_000_000n;
  const fraction = (steps % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

/** Age of a block, both times in unix seconds. */
export function timeAgo(timestamp: number, now: number): string {
  const seconds = now - timestamp;
  if (seconds < 60) return 'Vừa xong';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86_400)} ngày trước`;
}
