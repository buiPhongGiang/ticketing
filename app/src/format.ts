const UNIT = 1_000_000_000_000n; // wei per displayed step: 6 decimals of an 18-decimal coin
const NANO = 1_000_000_000n; // wei per nAVAX (gwei)

/** A balance: up to 6 decimals, rounded down so it never reads higher than it is. */
export function formatAmount(wei: string | bigint, symbol: string): string {
  const steps = BigInt(wei) / UNIT;
  const whole = steps / 1_000_000n;
  const fraction = (steps % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

/** Two significant digits, e.g. 0.02817568 → "0.028". Display only, so floating point is fine. */
function twoDigits(x: number): string {
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  const s = x.toPrecision(2);
  return s.includes('e') ? '< 0.000001' : String(Number(s));
}

/**
 * A network fee actually paid. From 0.000001 of the coin up it is shown in the coin; below that in nano-units
 * (nAVAX), because six decimals would turn a real fee of 0.00000000003 AVAX into nothing or, rounded up, into a
 * number tens of thousands of times too high.
 */
export function formatFee(wei: string | bigint, symbol: string): string {
  const value = Number(BigInt(wei));
  if (value === 0) return `0 ${symbol}`;
  if (value >= 1e12) return `${twoDigits(value / 1e18)} ${symbol}`;
  return `${twoDigits(value / 1e9)} n${symbol}`;
}

/** "1.4 s" from milliseconds. */
export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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
/** A show of one evening reads "5 Dec · 19:00"; a run of several days reads "19 Nov – 13 Dec". Vietnam time. */
export function eventWhen(startsAt: number, endsAt: number): string {
  if (endsAt - startsAt <= 86_400) return eventDate(startsAt);
  const day = (unix: number) => { const d = new Date((unix + 7 * 3600) * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  return `${day(startsAt)} – ${day(endsAt)}`;
}

/** Event time in Vietnam (UTC+7, no DST), e.g. "28 Nov · 19:00". */
export function eventDate(unix: number): string {
  const d = new Date((unix + 7 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:${mm}`;
}
