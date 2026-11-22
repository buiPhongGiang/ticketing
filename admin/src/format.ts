// Display helpers. Pure: no config, no chain.

export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/**
 * Organizers see Vietnamese đồng only. The contract settles in USDC (6-decimal base units), converted at a fixed rate
 * set per build: VITE_VND_PER_USDC, default 26,000 đ per USDC.
 */
export const VND_PER_USDC = BigInt(Math.round(Number((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VND_PER_USDC || 26_000)));

/** Base units to whole đồng, rounded half up. */
export function vndOf(units: bigint, rate: bigint = VND_PER_USDC): bigint {
  const negative = units < 0n;
  const v = ((negative ? -units : units) * rate + UNIT / 2n) / UNIT;
  return negative ? -v : v;
}

const groupVnd = (v: bigint) => { const s = (v < 0n ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return v < 0n ? `-${s}` : s; };

/** Base units to "1.234.500" (đồng, Vietnamese grouping, no unit). */
export const vndNumber = (units: bigint, rate: bigint = VND_PER_USDC) => groupVnd(vndOf(units, rate));

/** Base units to "1.234.500đ". */
export const vnd = (units: bigint, rate: bigint = VND_PER_USDC) => `${vndNumber(units, rate)}đ`;

/** "650000", "650.000" or "650.000đ" to USDC base units, rounded down. Null for anything that is not a plain amount. */
export function parseVnd(input: string, rate: bigint = VND_PER_USDC): bigint | null {
  const s = input.trim().replace(/[.\s,]/g, '').replace(/đ$/i, '');
  if (!/^\d+$/.test(s) || rate <= 0n) return null;
  return (BigInt(s) * UNIT) / rate;
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
/** "T7 21/11": weekday, day and month the way a Vietnamese poster writes them. */
const dayOf = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;

/** Unix seconds to "T7 21/11 · 19:00" in local time. */
export function eventDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${dayOf(d)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One evening reads "T7 5/12 · 19:00"; a run of several days reads "T5 19/11 – CN 13/12". Local time. */
export function eventWhen(start: number, end: number): string {
  if (end - start <= 86_400) return eventDate(start);
  return `${dayOf(new Date(start * 1000))} – ${dayOf(new Date(end * 1000))}`;
}

/** "19:00–23:00", or "19:00–01:00 +1 ngày" when the end falls on a later day. */
export function timeRange(start: number, end: number): string {
  const s = new Date(start * 1000), e = new Date(end * 1000);
  const days = Math.round((new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime() - new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()) / 86_400_000);
  return `${pad(s.getHours())}:${pad(s.getMinutes())}–${pad(e.getHours())}:${pad(e.getMinutes())}${days > 0 ? ` +${days} ngày` : ''}`;
}

export function ago(seconds: number, now: number): string {
  const d = Math.max(0, Math.floor(now - seconds));
  if (d < 60) return `${d} giây`;
  if (d < 3600) return `${Math.floor(d / 60)} phút`;
  if (d < 86_400) return `${Math.floor(d / 3600)} giờ`;
  return `${Math.floor(d / 86_400)} ngày`;
}

/** Whole percent of a over b, e.g. 108 for 10.8 over 10. Null when b is zero. */
export function percentOf(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * 1000n) / b) / 10;
}

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
