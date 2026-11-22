// How an event that is no longer on sale ended, in words a guest can act on. Pure: unit-tested.
import type { EventInfo } from './lib/types';

export type OutcomeKind = 'cancelled' | 'noshow' | 'happened' | 'ended';
export interface Outcome {
  kind: OutcomeKind;
  title: string;
  body: string;
  /** Holders can take their money back now. */
  refundOpen: boolean;
}

type Facts = Pick<EventInfo, 'status' | 'cancelled' | 'refundOpen' | 'quorumMet' | 'paidSold' | 'paidCheckedIn' | 'refunded' | 'settled'>;

const tickets = (n: number) => `${n} vé`;

/** Null while the event is on sale. */
export function eventOutcome(e: Facts): Outcome | null {
  if (e.status === 'onsale') return null;
  const back = e.refunded > 0 ? ` Đã hoàn ${tickets(e.refunded)}.` : '';
  if (e.cancelled) {
    return { kind: 'cancelled', title: 'Sự kiện đã bị hủy', body: `Mọi vé đã mua được hoàn đúng số tiền đã trả.${back}`, refundOpen: true };
  }
  const scanned = `${e.paidCheckedIn}/${e.paidSold} vé đã mua được soát ở cửa`;
  if (e.refundOpen) {
    return { kind: 'noshow', title: 'Quá ít người vào cửa', body: `${scanned}, chưa tới một nửa, nên sự kiện coi như không diễn ra và vé chưa soát được hoàn tiền.${back}`, refundOpen: true };
  }
  if (e.paidSold > 0 && e.quorumMet) {
    return { kind: 'happened', title: 'Sự kiện đã diễn ra', body: `${scanned}.${e.settled ? ' Ban tổ chức đã được thanh toán.' : ''}`, refundOpen: false };
  }
  // Ended below the half with refunds closed: the organizer settled after the 48-hour hold, or nothing was sold.
  return { kind: 'ended', title: 'Sự kiện đã kết thúc', body: e.paidSold > 0 ? `${scanned}.${e.settled ? ' Đã hết hạn hoàn tiền.' : ''}${back}` : 'Chưa bán được vé nào.', refundOpen: false };
}
