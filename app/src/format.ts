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
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** USDC base units (6 decimals) as "25.00"; more decimals only when they are not zero. */
export function formatUsdc(units: string | bigint): string {
  const v = BigInt(units);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0');
  const trimmed = frac.replace(/0+$/, '');
  const shown = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  return `${whole.toLocaleString('en-US')}.${shown}`;
}

/** "25.5" or "25,50" style user input to USDC base units; null if not a positive amount with ≤ 6 decimals. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Event time in Vietnam (UTC+7, no DST), e.g. "28 Nov · 19:00". */
export function eventDate(unix: number): string {
  const d = new Date((unix + 7 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:${mm}`;
}
