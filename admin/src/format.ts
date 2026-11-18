// Display helpers. Pure: no config, no chain.

export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 6-decimal base units to "1,234.50". Rounds half up at the shown precision. */
export function usdcNumber(units: bigint, decimals = 2): string {
  const negative = units < 0n;
  let v = negative ? -units : units;
  const step = 10n ** BigInt(USDC_DECIMALS - decimals);
  v = (v + step / 2n) / step;
  const scale = 10n ** BigInt(decimals);
  const whole = group((v / scale).toString());
  const frac = decimals > 0 ? `.${(v % scale).toString().padStart(decimals, '0')}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}

export const usdc = (units: bigint, decimals = 2) => `${usdcNumber(units, decimals)} USDC`;

/** "12.5" or "12,50" style input to base units. Returns null for anything that is not a plain amount. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(/,/g, '.');
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Unix seconds to "Sat 21 Nov · 19:00" in local time. */
export function eventDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One evening reads "Sat 5 Dec · 19:00"; a run of several days reads "Thu 19 Nov – Sun 13 Dec". Local time. */
export function eventWhen(start: number, end: number): string {
  if (end - start <= 86_400) return eventDate(start);
  const day = (s: number) => { const d = new Date(s * 1000); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  return `${day(start)} – ${day(end)}`;
}

/** "19:00" or "19:00 +1d" style end time relative to a start. */
export function timeRange(start: number, end: number): string {
  const s = new Date(start * 1000), e = new Date(end * 1000);
  const days = Math.round((new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime() - new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()) / 86_400_000);
  return `${pad(s.getHours())}:${pad(s.getMinutes())}–${pad(e.getHours())}:${pad(e.getMinutes())}${days > 0 ? ` +${days}d` : ''}`;
}

export function ago(seconds: number, now: number): string {
  const d = Math.max(0, Math.floor(now - seconds));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86_400)}d`;
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
