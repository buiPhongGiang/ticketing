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
  if (seconds < 60) return 'Vừa xong';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86_400)} ngày trước`;
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

/**
 * Guests and organizers see Vietnamese đồng only. The contract settles in USDC, so amounts are converted at a
 * fixed rate set per build (EXPO_PUBLIC_VND_PER_USDC, default 26,000 đ per USDC).
 */
export const VND_PER_USDC = BigInt(Math.round(Number(process.env.EXPO_PUBLIC_VND_PER_USDC || 26_000)));

const groupVnd = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** USDC base units as đồng, rounded to the nearest đồng: 27_500_000 → "715.000đ". */
export function formatVnd(units: string | bigint, rate: bigint = VND_PER_USDC): string {
  return `${groupVnd((BigInt(units) * rate + 500_000n) / 1_000_000n)}đ`;
}

/** The number alone, for an input field: 27_500_000 → "715.000". */
export const vndDigits = (units: string | bigint, rate: bigint = VND_PER_USDC) => formatVnd(units, rate).slice(0, -1);

/** "715.000", "715000" or "715.000đ" to USDC base units, rounded down so it never exceeds what was typed. */
export function parseVnd(input: string, rate: bigint = VND_PER_USDC): bigint | null {
  const s = input.trim().replace(/[.\s,]/g, '').replace(/đ$/i, '');
  if (!/^\d+$/.test(s) || rate <= 0n) return null;
  return (BigInt(s) * 1_000_000n) / rate;
}

/** A show of one evening reads "5/12 · 19:00"; a run of several days reads "19/11 – 13/12". Vietnam time. */
export function eventWhen(startsAt: number, endsAt: number): string {
  if (endsAt - startsAt <= 86_400) return eventDate(startsAt);
  const day = (unix: number) => { const d = new Date((unix + 7 * 3600) * 1000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
  return `${day(startsAt)} – ${day(endsAt)}`;
}

/** Event time in Vietnam (UTC+7, no DST), day/month as written in Vietnam, e.g. "28/11 · 19:00". */
export function eventDate(unix: number): string {
  const d = new Date((unix + 7 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1} · ${hh}:${mm}`;
}
