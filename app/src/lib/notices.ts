// In-app notifications without a server watching the chain: the device compares what the chain says now with what
// it said the last time this device looked (kept in device storage), and turns the differences into a short list.
// Changes made while the app was closed show up at the next look. Nothing here leaves the device.
import type { KeyValueStore, Ticket, TicketStatus, WaitlistState } from './types';

export interface Snapshot {
  /** Tickets this device holds or sold, by ticket id. */
  tickets: Record<string, { status: TicketStatus; eventId: string; tier: number; listPrice: string; paid: string }>;
  /** Places in line, by "event:tier". Only where the device is waiting. */
  queues: Record<string, number>;
}

export type NoticeKind = 'sold' | 'arrived' | 'refund';
export interface NoticeItem {
  id: string;
  kind: NoticeKind;
  /** Unix ms when this device noticed it. */
  at: number;
  read: boolean;
  eventId: string;
  tokenId?: string;
  /** USDC base units: the price a listing sold for, or the refund on offer. */
  amount?: string;
}

export function snapshotOf(tickets: Ticket[], queues: { eventId: string; states: WaitlistState[] }[]): Snapshot {
  const snap: Snapshot = { tickets: {}, queues: {} };
  for (const t of tickets) snap.tickets[t.tokenId] = { status: t.status, eventId: t.eventId, tier: t.tier, listPrice: t.listPrice, paid: t.paid };
  for (const q of queues) for (const s of q.states) if (s.position > 0) snap.queues[`${q.eventId}:${s.tier}`] = s.position;
  return snap;
}

/** A ticket whose action is still confirming says nothing final yet. */
const settled = (s: TicketStatus) => s !== 'pending' && s !== 'unresolved';

/**
 * What changed between two looks:
 *  - sold: a ticket this device held is now someone else's (it only leaves through the resale market);
 *  - arrived: a ticket appeared in a tier where this device was waiting in line and no longer is;
 *  - refund: a held ticket became refundable (the show was cancelled, or too few people came in).
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot, at: number): NoticeItem[] {
  const out: NoticeItem[] = [];
  for (const [tokenId, now] of Object.entries(next.tickets)) {
    const before = prev.tickets[tokenId];
    if (!settled(now.status)) continue;
    if (now.status === 'sold' && before && before.status !== 'sold') {
      out.push({ id: `sold:${tokenId}`, kind: 'sold', at, read: false, eventId: now.eventId, tokenId, amount: before.listPrice !== '0' ? before.listPrice : undefined });
    }
    if (!before && now.status !== 'sold') {
      const key = `${now.eventId}:${now.tier}`;
      if (prev.queues[key] && !next.queues[key]) out.push({ id: `arrived:${tokenId}`, kind: 'arrived', at, read: false, eventId: now.eventId, tokenId });
    }
    if (now.status === 'refundable' && before && before.status !== 'refundable' && now.paid !== '0') {
      out.push({ id: `refund:${tokenId}`, kind: 'refund', at, read: false, eventId: now.eventId, tokenId, amount: now.paid });
    }
  }
  return out;
}

/** Keeps a pending ticket's last settled state, so the change is still seen once it confirms. */
export function carry(prev: Snapshot, next: Snapshot): Snapshot {
  const tickets = { ...next.tickets };
  for (const [id, t] of Object.entries(tickets)) if (!settled(t.status) && prev.tickets[id]) tickets[id] = prev.tickets[id];
  for (const id of Object.keys(tickets)) if (!settled(tickets[id].status)) delete tickets[id];
  return { tickets, queues: next.queues };
}

export interface NoticeState { snapshot?: Snapshot; items: NoticeItem[] }
const KEEP = 50;

/** New notices first; one that is already in the list is not added again. */
export function merge(state: NoticeState, fresh: NoticeItem[]): NoticeState {
  const known = new Set(state.items.map((i) => i.id));
  const added = fresh.filter((i) => !known.has(i.id));
  return { ...state, items: [...added, ...state.items].sort((a, b) => b.at - a.at).slice(0, KEEP) };
}

export const noticeKey = (chainId: number, contract: string, wallet: string) => `vegoc.notices:${chainId}:${contract.toLowerCase()}:${wallet.toLowerCase()}`;

export async function loadNotices(store: KeyValueStore, key: string): Promise<NoticeState> {
  try {
    const s = JSON.parse((await store.getItem(key)) ?? 'null');
    if (s && Array.isArray(s.items)) return { snapshot: s.snapshot, items: s.items };
  } catch { /* a damaged record starts empty */ }
  return { items: [] };
}
export const saveNotices = (store: KeyValueStore, key: string, state: NoticeState) => store.setItem(key, JSON.stringify(state));
