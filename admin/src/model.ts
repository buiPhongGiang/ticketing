// Pure derivations from what the contract returns. No chain access, so every rule here is unit-tested.
import type { Address } from 'viem';
import { usdcNumber } from './format';

export const APR_BPS = 500n;
export const RESALE_CAP_BPS = 11_000n;
/** One refundMany call takes at most this many tickets (MAX_REFUND_BATCH in the contract). */
export const REFUND_BATCH = 100;
const YEAR_MS = 365n * 24n * 3600n * 1000n;

export interface TierInfo { name: string; price: bigint; supply: number; sold: number }

export interface EventInfo {
  id: number;
  organizer: Address;
  name: string;
  venue: string;
  startsAt: number;
  endsAt: number;
  maxPerWallet: number;
  cancelled: boolean;
  settled: boolean;
  issued: number;
  checkedIn: number;
  refunded: number;
  resales: number;
  sales: bigint;
  resaleVolume: bigint;
  resaleFaceVolume: bigint;
  tiers: TierInfo[];
  principal: bigint;
  yieldAccrued: bigint;
  listed: number;
  /** Earliest time settle works: the end if the gate quorum was met, else 48 h later. */
  settleAt: number;
  /** Holders can claim refunds now: cancelled, or ended below the quorum and not settled. */
  refundOpen: boolean;
  /** At least half of the paid tickets were scanned at the gate. */
  quorumMet: boolean;
  paidSold: number;
  paidCheckedIn: number;
  /** Wallets waiting for a resale ticket, per tier. */
  waiting: number[];
}

export interface Ticket {
  tokenId: number;
  eventId: number;
  tier: number;
  owner: Address;
  paid: bigint;
  face: bigint;
  cap: bigint;
  listPrice: bigint;
  checkedIn: boolean;
}

/** Shape of VeGoc.getEvent / getEvents items as viem decodes them. */
export interface RawEventView {
  id: bigint;
  data: {
    organizer: Address; startsAt: bigint; endsAt: bigint; maxPerWallet: number; cancelled: boolean; settled: boolean;
    issued: number; checkedIn: number; refunded: number; resales: number; sales: bigint; resaleVolume: bigint; resaleFaceVolume: bigint;
    name: string; venue: string;
  };
  tiers: readonly { name: string; price: bigint; supply: number; sold: number }[];
  principal: bigint;
  yieldAccrued: bigint;
  listed: bigint;
  settleAt: bigint;
  refundOpen: boolean;
  quorumMet: boolean;
  paidSold: bigint;
  paidCheckedIn: bigint;
  waiting: readonly bigint[];
}

export interface RawTicketView {
  tokenId: bigint; eventId: bigint; tier: bigint; owner: Address; paid: bigint; face: bigint; cap: bigint; listPrice: bigint; checkedIn: boolean;
}

export function toEventInfo(v: RawEventView): EventInfo {
  const d = v.data;
  return {
    id: Number(v.id), organizer: d.organizer, name: d.name, venue: d.venue,
    startsAt: Number(d.startsAt), endsAt: Number(d.endsAt), maxPerWallet: Number(d.maxPerWallet),
    cancelled: d.cancelled, settled: d.settled, issued: Number(d.issued), checkedIn: Number(d.checkedIn), refunded: Number(d.refunded),
    resales: Number(d.resales), sales: d.sales, resaleVolume: d.resaleVolume, resaleFaceVolume: d.resaleFaceVolume,
    tiers: v.tiers.map((t) => ({ name: t.name, price: t.price, supply: Number(t.supply), sold: Number(t.sold) })),
    principal: v.principal, yieldAccrued: v.yieldAccrued, listed: Number(v.listed),
    settleAt: Number(v.settleAt), refundOpen: v.refundOpen, quorumMet: v.quorumMet, paidSold: Number(v.paidSold), paidCheckedIn: Number(v.paidCheckedIn),
    waiting: v.waiting.map(Number),
  };
}

export function toTicket(v: RawTicketView): Ticket {
  return {
    tokenId: Number(v.tokenId), eventId: Number(v.eventId), tier: Number(v.tier), owner: v.owner,
    paid: v.paid, face: v.face, cap: v.cap, listPrice: v.listPrice, checkedIn: v.checkedIn,
  };
}

/** Events this wallet organizes, directly or as an owner of the Safe that organizes them. */
export const mine = (events: EventInfo[], address: string, safes: Record<string, { owners: readonly string[] }> = {}) =>
  events.filter((e) => organizes(e, address, safes));

export function organizes(e: Pick<EventInfo, 'organizer'>, address: string, safes: Record<string, { owners: readonly string[] }> = {}): boolean {
  const me = address.toLowerCase();
  const organizer = e.organizer.toLowerCase();
  return organizer === me || !!safes[organizer]?.owners.some((o) => o.toLowerCase() === me);
}

/** Scanned paid tickets as a share of paid tickets sold, against the contract's quorum of one half. */
export const QUORUM_BPS = 5_000;
export const quorumOf = (e: Pick<EventInfo, 'paidSold' | 'paidCheckedIn'>) => e.paidCheckedIn * 10_000 >= e.paidSold * QUORUM_BPS;

/** `noshow`: ended with too few paid tickets scanned, so holders can take refunds and settlement waits 48 h. */
export type EventStatus = 'live' | 'ended' | 'noshow' | 'cancelled' | 'settled';
export function eventStatus(e: Pick<EventInfo, 'cancelled' | 'settled' | 'endsAt' | 'paidSold' | 'paidCheckedIn'>, now: number): EventStatus {
  if (e.cancelled) return 'cancelled';
  if (e.settled) return 'settled';
  if (now < e.endsAt) return 'live';
  return quorumOf(e) ? 'ended' : 'noshow';
}

export const supplyOf = (e: Pick<EventInfo, 'tiers'>) => e.tiers.reduce((s, t) => s + t.supply, 0);
export const waitingOf = (e: Pick<EventInfo, 'waiting'>) => e.waiting.reduce((s, n) => s + n, 0);

export type TicketStatus = 'valid' | 'checked' | 'listed' | 'refunded';

export interface TicketRow {
  tokenId: number;
  tier: number;
  /** Current holder, or the wallet that got the refund. */
  owner: Address;
  paid: bigint;
  face: bigint;
  listPrice: bigint;
  status: TicketStatus;
}

export interface RefundRecord { tokenId: number; holder: Address; amount: bigint; tier: number }

export function ticketStatus(t: Pick<Ticket, 'checkedIn' | 'listPrice'>): TicketStatus {
  if (t.checkedIn) return 'checked';
  return t.listPrice > 0n ? 'listed' : 'valid';
}

/** Live tickets plus refunded ones (burned on chain, known from logs), sorted by ticket number. */
export function ticketRows(live: Ticket[], refunds: RefundRecord[], tiers: TierInfo[]): TicketRow[] {
  const rows: TicketRow[] = live.map((t) => ({ tokenId: t.tokenId, tier: t.tier, owner: t.owner, paid: t.paid, face: t.face, listPrice: t.listPrice, status: ticketStatus(t) }));
  const seen = new Set(rows.map((r) => r.tokenId));
  for (const r of refunds) {
    if (seen.has(r.tokenId)) continue;
    rows.push({ tokenId: r.tokenId, tier: r.tier, owner: r.holder, paid: r.amount, face: tiers[r.tier]?.price ?? 0n, listPrice: 0n, status: 'refunded' });
  }
  return rows.sort((a, b) => a.tokenId - b.tokenId);
}

export type CellKind = TicketStatus | 'empty';
export interface WallCell { kind: CellKind; tokenId?: number }

/**
 * One cell per ticket: issued ones first (by number), then refunded ones the logs have not named yet, then
 * dashed cells for what is still unsold. Stops at `limit` cells and reports how many were left out.
 */
export function wallCells(rows: TicketRow[], e: Pick<EventInfo, 'tiers' | 'issued' | 'refunded'>, limit = 480): { cells: WallCell[]; hidden: number } {
  const cells: WallCell[] = rows.map((r) => ({ kind: r.status, tokenId: r.tokenId }));
  const refundedKnown = rows.filter((r) => r.status === 'refunded').length;
  for (let i = refundedKnown; i < e.refunded; i++) cells.push({ kind: 'refunded' });
  const unsold = Math.max(0, supplyOf(e) - e.issued);
  const total = cells.length + unsold;
  const shown = Math.min(total, limit);
  while (cells.length < shown) cells.push({ kind: 'empty' });
  return { cells: cells.slice(0, shown), hidden: total - shown };
}

export function countBy(rows: TicketRow[]): Record<TicketStatus, number> {
  const c: Record<TicketStatus, number> = { valid: 0, checked: 0, listed: 0, refunded: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

export interface ResaleStats { count: number; volume: bigint; avgPctOfFace: number | null; listed: number }
export function resaleStats(e: Pick<EventInfo, 'resales' | 'resaleVolume' | 'resaleFaceVolume' | 'listed'>): ResaleStats {
  const avg = e.resaleFaceVolume === 0n ? null : Number((e.resaleVolume * 1000n) / e.resaleFaceVolume) / 10;
  return { count: e.resales, volume: e.resaleVolume, avgPctOfFace: avg, listed: e.listed };
}

export const capOf = (face: bigint) => (face * RESALE_CAP_BPS) / 10_000n;

/** Mock vault yield after `elapsedMs` more of accrual at 5 % APR, matching FloatVault's linear formula. */
export function projectYield(yieldAccrued: bigint, principal: bigint, elapsedMs: number, frozen = false): bigint {
  // The vault stops accruing when an event is cancelled.
  if (elapsedMs <= 0 || frozen) return yieldAccrued;
  return yieldAccrued + (principal * APR_BPS * BigInt(Math.floor(elapsedMs))) / (10_000n * YEAR_MS);
}

/**
 * Ticket ids that would get money back: live and paid. Comps are left alone. After a no-show (not a cancel) a
 * scanned ticket has no claim, because its holder was let in.
 */
export const refundableIds = (live: Ticket[], cancelled = true) =>
  live.filter((t) => t.paid > 0n && (cancelled || !t.checkedIn)).map((t) => t.tokenId).sort((a, b) => a - b);

/** Platform fee taken from the principal at settlement. */
export const feeOf = (principal: bigint, feeBps: number) => (principal * BigInt(feeBps)) / 10_000n;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type SettleState =
  | { kind: 'settle'; principal: bigint; yield: bigint }
  | { kind: 'yield'; yield: bigint }
  /** `dispute`: the event ended below the gate quorum, so the float stays locked until `opensAt`. */
  | { kind: 'wait'; opensAt: number; dispute: boolean }
  | { kind: 'done' };

/**
 * What settle would do right now. After a cancel only the yield can leave; principal is the buyers'. After an event
 * that ended below the quorum the organizer waits until `settleAt` (the contract's 48 h dispute window).
 */
export function settleState(e: Pick<EventInfo, 'cancelled' | 'settled' | 'endsAt' | 'settleAt' | 'principal' | 'yieldAccrued'>, now: number, yieldNow = e.yieldAccrued): SettleState {
  if (e.cancelled) return yieldNow > 0n ? { kind: 'yield', yield: yieldNow } : { kind: 'done' };
  if (e.settled) return { kind: 'done' };
  if (now < e.endsAt) return { kind: 'wait', opensAt: e.endsAt, dispute: false };
  if (now < e.settleAt) return { kind: 'wait', opensAt: e.settleAt, dispute: true };
  return { kind: 'settle', principal: e.principal, yield: yieldNow };
}

export type StatusFilter = 'all' | TicketStatus;

export function filterRows(rows: TicketRow[], query: string, status: StatusFilter): TicketRow[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  return rows.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (!q) return true;
    // Four or more characters may be part of an address, such as the last four shown as 0x7099…79C8.
    return String(r.tokenId) === q || (q.length >= 4 && r.owner.toLowerCase().includes(q));
  });
}

export const STATUS_LABEL: Record<TicketStatus, string> = { valid: 'Valid', checked: 'Checked in', listed: 'Listed', refunded: 'Refunded' };

const csvCell = (value: string) => {
  // A leading formula character would run when the file is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function ticketsCsv(rows: TicketRow[], tiers: TierInfo[]): string {
  const head = ['Ticket', 'Tier', 'Holder', 'Status', 'Paid USDC', 'Face USDC', 'Listed USDC'];
  const body = rows.map((r) => [
    String(r.tokenId), tiers[r.tier]?.name ?? String(r.tier), r.owner, STATUS_LABEL[r.status],
    usdcNumber(r.paid).replace(/,/g, ''), usdcNumber(r.face).replace(/,/g, ''), r.listPrice > 0n ? usdcNumber(r.listPrice).replace(/,/g, '') : '',
  ]);
  return [head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export interface TierDraft { name: string; price: string; supply: string }
export interface EventDraft { name: string; venue: string; start: string; hours: string; maxPerWallet: string; tiers: TierDraft[] }
export interface EventArgs {
  name: string; venue: string; startsAt: bigint; endsAt: bigint; maxPerWallet: number; tierNames: string[]; prices: bigint[]; supplies: number[];
}
export type DraftErrors = Partial<Record<'name' | 'venue' | 'start' | 'hours' | 'maxPerWallet' | 'tiers', string>> & { tierRows?: Record<number, string> };

/** Validates the new-event form and builds createEvent arguments. `now` in unix seconds. */
export function buildEventArgs(d: EventDraft, now: number, parseUsdc: (s: string) => bigint | null): { args?: EventArgs; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const name = d.name.trim(), venue = d.venue.trim();
  if (!name) errors.name = 'Required';
  if (!venue) errors.venue = 'Required';
  const startMs = d.start ? new Date(d.start).getTime() : NaN;
  const hours = Number(d.hours);
  if (!Number.isFinite(startMs)) errors.start = 'Required';
  if (!(hours > 0 && hours <= 24 * 14)) errors.hours = '0–336 h';
  const max = d.maxPerWallet.trim() === '' ? 0 : Number(d.maxPerWallet);
  if (!Number.isInteger(max) || max < 0 || max > 1000) errors.maxPerWallet = '0–1000';
  if (d.tiers.length < 1 || d.tiers.length > 4) errors.tiers = '1–4 tiers';
  const tierRows: Record<number, string> = {};
  const prices: bigint[] = [], supplies: number[] = [], tierNames: string[] = [];
  d.tiers.forEach((t, i) => {
    const price = parseUsdc(t.price);
    const supply = Number(t.supply);
    if (!t.name.trim()) tierRows[i] = 'Name required';
    else if (price === null) tierRows[i] = 'Price in USDC';
    else if (!Number.isInteger(supply) || supply < 1 || supply > 100_000) tierRows[i] = 'Supply 1–100000';
    tierNames.push(t.name.trim()); prices.push(price ?? 0n); supplies.push(supply);
  });
  if (Object.keys(tierRows).length) errors.tierRows = tierRows;
  if (Number.isFinite(startMs) && hours > 0) {
    const endsAt = Math.floor(startMs / 1000) + Math.round(hours * 3600);
    if (endsAt <= now) errors.start = 'Ends in the past';
  }
  if (Object.keys(errors).length) return { errors };
  const startsAt = Math.floor(startMs / 1000);
  return {
    errors,
    args: { name, venue, startsAt: BigInt(startsAt), endsAt: BigInt(startsAt + Math.round(hours * 3600)), maxPerWallet: max, tierNames, prices, supplies },
  };
}
