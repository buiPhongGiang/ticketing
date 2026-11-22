// What the organizer reads off an event at a glance: where it stands in its life and what can be done now, sales per
// tier, and the platform fee. Pure derivations from contract reads and logs, so every rule here is unit-tested.
import type { Hex } from 'viem';
import { vnd } from './format';
import type { LogEntry } from './logs';
import { eventStatus, feeOf, QUORUM_BPS, quorumOf, supplyOf, type EventInfo, type EventStatus } from './model';

// ---------------------------------------------------------------- lifecycle

export type StepKey = 'onsale' | 'ended' | 'refunds' | 'settled' | 'cancelled' | 'refunded';
/** done: behind us. now: where the event stands. next: not reached yet. */
export type StepState = 'done' | 'now' | 'next';
export interface LifeStep { key: StepKey; title: string; state: StepState; at?: number; note: string; hash?: Hex }
/** The organizer's move at this point. `wait`: nothing to send, time has to pass. */
export type LifeAction = 'cancel' | 'settle' | 'refund' | 'yield' | 'wait' | 'none';
export interface Lifecycle { status: EventStatus; steps: LifeStep[]; action: LifeAction; hint: string }

export interface LifeFacts {
  created?: LogEntry;
  cancelled?: LogEntry;
  settled?: LogEntry;
  /** Paid tickets that can still be refunded. Null while the tickets are being read. */
  refundsLeft: number | null;
  /** Yield the vault would pay out now. */
  yieldNow: bigint;
  feeBps: number;
}

type LifeEvent = Pick<EventInfo, 'cancelled' | 'settled' | 'startsAt' | 'endsAt' | 'settleAt' | 'issued' | 'refunded' | 'paidSold' | 'paidCheckedIn' | 'tiers' | 'principal'>;

const scanned = (e: LifeEvent) => `${e.paidCheckedIn}/${e.paidSold} vé trả tiền đã vào cửa`;
const left = (n: number | null) => (n === null ? 'Đang đếm số vé chưa hoàn' : n === 0 ? 'Không còn vé nào chờ hoàn' : `Còn ${n} vé chưa hoàn`);

/**
 * The event's path through VeGoc: on sale → ended → settled, or on sale → cancelled → refunded, or (ended with less
 * than half of the paid tickets scanned) on sale → ended → refunds for 48 h → settled.
 */
export function lifecycle(e: LifeEvent, now: number, f: LifeFacts): Lifecycle {
  const status = eventStatus(e, now);
  const fee = `${f.feeBps / 100}%`;
  const onsale = (state: StepState): LifeStep => ({
    key: 'onsale', title: 'Mở bán', state, at: f.created?.timestamp, hash: f.created?.hash,
    note: `Đã phát hành ${e.issued}/${supplyOf(e)} vé`,
  });

  if (status === 'cancelled') {
    const open = f.refundsLeft === null || f.refundsLeft > 0;
    const action: LifeAction = open ? (f.refundsLeft === null ? 'wait' : 'refund') : f.yieldNow > 0n ? 'yield' : 'none';
    return {
      status, action,
      steps: [
        onsale('done'),
        { key: 'cancelled', title: 'Đã huỷ', state: 'done', at: f.cancelled?.timestamp, hash: f.cancelled?.hash, note: 'Ngừng bán. Mỗi vé trả tiền được hoàn đúng số đã trả.' },
        { key: 'refunded', title: 'Hoàn tiền', state: open ? 'now' : 'done', note: `${left(f.refundsLeft)} · đã hoàn ${e.refunded} vé` },
      ],
      hint: action === 'refund' ? 'Bấm "Hoàn tiền tất cả" để trả tiền cho khách. Khách cũng tự nhận lại được trong ứng dụng.'
        : action === 'yield' ? 'Khách đã nhận lại tiền. Phần lãi tính tới lúc huỷ có thể rút về ví ban tổ chức.'
        : action === 'wait' ? 'Đang đọc danh sách vé từ chuỗi.'
        : 'Sự kiện đã huỷ và hoàn tiền xong. Không còn việc gì phải làm.',
    };
  }

  // While the event runs the opening time still depends on the door count, so no date is promised yet.
  const settledStep = (state: StepState, note: string): LifeStep => ({
    key: 'settled', title: 'Quyết toán', state, note,
    at: state === 'done' ? f.settled?.timestamp : status === 'live' ? undefined : e.settleAt, hash: state === 'done' ? f.settled?.hash : undefined,
  });

  if (status === 'live') {
    return {
      status, action: 'cancel',
      steps: [
        onsale('now'),
        { key: 'ended', title: 'Kết thúc', state: 'next', at: e.endsAt, note: 'Ngừng bán và ngừng soát vé. Cần ít nhất một nửa số vé trả tiền đã vào cửa.' },
        settledStep('next', `Mở ngay lúc kết thúc nếu đủ lượt vào cửa, thiếu thì lùi 48 giờ. Tiền vé trừ phí nền tảng ${fee} về ví ban tổ chức.`),
      ],
      hint: 'Đang mở bán. Lúc này có thể tặng vé mời, lùi giờ kết thúc (tab Soát vé) hoặc huỷ sự kiện. Quyết toán mở sau giờ kết thúc.',
    };
  }

  if (status === 'settled') {
    const s = f.settled;
    const paid = s ? `Đã chuyển ${vnd(s.amount ?? 0n)} tiền vé${s.yieldPaid ? ` và ${vnd(s.yieldPaid)} lãi` : ''}${s.fee ? ` · phí nền tảng ${vnd(s.fee)}` : ''}` : 'Tiền vé đã về ví ban tổ chức';
    return {
      status, action: 'none',
      steps: [onsale('done'), { key: 'ended', title: 'Kết thúc', state: 'done', at: e.endsAt, note: scanned(e) }, settledStep('done', paid)],
      hint: 'Sự kiện đã quyết toán. Không còn việc gì phải làm.',
    };
  }

  if (status === 'ended') {
    return {
      status, action: 'settle',
      steps: [
        onsale('done'),
        { key: 'ended', title: 'Kết thúc', state: 'done', at: e.endsAt, note: `${scanned(e)}, đủ một nửa` },
        settledStep('now', `Đang giữ ${vnd(e.principal)}. Phí nền tảng ${fee} là ${vnd(feeOf(e.principal, f.feeBps))}.`),
      ],
      hint: 'Sự kiện đã diễn ra. Bấm "Quyết toán" để nhận tiền vé về ví ban tổ chức.',
    };
  }

  // No-show: ended with less than half of the paid tickets scanned.
  const settleOpen = now >= e.settleAt;
  const owing = f.refundsLeft === null || f.refundsLeft > 0;
  return {
    status, action: f.refundsLeft !== null && f.refundsLeft > 0 ? 'refund' : settleOpen ? 'settle' : 'wait',
    steps: [
      onsale('done'),
      { key: 'ended', title: 'Kết thúc', state: 'done', at: e.endsAt, note: `Chỉ ${scanned(e)}, chưa đủ một nửa` },
      { key: 'refunds', title: 'Hoàn tiền cho khách', state: owing || !settleOpen ? 'now' : 'done', at: e.endsAt, note: `${left(f.refundsLeft)} · đã hoàn ${e.refunded} vé. Vé đã vào cửa không được hoàn.` },
      settledStep(settleOpen ? 'now' : 'next', 'Mở sau giờ kết thúc 48 giờ, chỉ trả phần khách không nhận lại.'),
    ],
    hint: f.refundsLeft !== null && f.refundsLeft > 0
      ? 'Chưa đủ một nửa số vé trả tiền vào cửa nên khách được hoàn tiền. Bấm "Hoàn tiền tất cả", hoặc để khách tự nhận lại.'
      : settleOpen ? 'Đã qua 48 giờ. Có thể quyết toán phần tiền khách không nhận lại.'
      : 'Đang trong 48 giờ chờ khách nhận lại tiền. Quyết toán mở sau đó.',
  };
}

// ---------------------------------------------------------------- sales per tier

export interface TierSale {
  name: string;
  price: bigint;
  supply: number;
  /** Issued in this tier, paid and comps together (the contract's counter). */
  sold: number;
  left: number;
  /** From the mint logs; null until the whole history has been read. */
  paid: number | null;
  comps: number | null;
  /** What buyers paid for this tier at the primary sale. */
  revenue: bigint | null;
}

/** `mints`: the event's Purchased and Issued log entries, or null while the log history is incomplete. */
export function tierSales(e: Pick<EventInfo, 'tiers'>, mints: LogEntry[] | null): TierSale[] {
  return e.tiers.map((t, i) => {
    const own = mints?.filter((x) => x.tier === i) ?? null;
    const bought = own?.filter((x) => x.kind === 'Purchased') ?? null;
    return {
      name: t.name, price: t.price, supply: t.supply, sold: t.sold, left: Math.max(0, t.supply - t.sold),
      paid: bought ? bought.reduce((s, x) => s + (x.quantity ?? 0), 0) : null,
      comps: own ? own.filter((x) => x.kind === 'Issued').reduce((s, x) => s + (x.quantity ?? 0), 0) : null,
      revenue: bought ? bought.reduce((s, x) => s + (x.amount ?? 0n), 0n) : null,
    };
  });
}

export interface FeeView {
  /** collected: taken at settlement (Settled log). estimate: what settlement would take from the float held now. none: nothing to take. */
  kind: 'collected' | 'estimate' | 'none';
  amount: bigint;
}

/**
 * The platform fee is taken once, from the primary-sale float, when the organizer settles. Resales pay no fee in
 * VeGoc: the buyer's money goes to the seller whole.
 */
export function platformFee(e: Pick<EventInfo, 'cancelled' | 'settled' | 'principal'>, feeBps: number, settled: LogEntry[]): FeeView {
  const taken = settled.reduce((s, x) => s + (x.fee ?? 0n), 0n);
  if (e.settled || taken > 0n) return { kind: 'collected', amount: taken };
  if (e.cancelled || feeBps === 0) return { kind: 'none', amount: 0n };
  return { kind: 'estimate', amount: feeOf(e.principal, feeBps) };
}

/** The door count against the contract's quorum of one half of the paid tickets. */
export function quorumView(e: Pick<EventInfo, 'paidSold' | 'paidCheckedIn'>): { need: number; missing: number; met: boolean; pct: number } {
  const need = Math.ceil((e.paidSold * QUORUM_BPS) / 10_000);
  return { need, missing: Math.max(0, need - e.paidCheckedIn), met: quorumOf(e), pct: e.paidSold ? Math.min(100, Math.round((e.paidCheckedIn / e.paidSold) * 100)) : 0 };
}

/** How far a listing sits from its cap: 100 means listed at the cap. */
export const pctOfCap = (price: bigint, cap: bigint) => (cap === 0n ? 0 : Number((price * 1000n) / cap) / 10);
