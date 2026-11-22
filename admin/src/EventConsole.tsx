import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isAddress, type Address, type Hex } from 'viem';
import { addressUrl, safeCallState, sendBox, type BoxWrite, type Eip1193 } from './chain';
import type { SafeInfo } from './safe';
import { failureText } from './errors';
import { eventPhoto } from './art';
import { ago, eventDate, eventWhen, short, timeRange, vnd, vndNumber } from './format';
import { pctOfCap, platformFee } from './insights';
import { entriesOf, refundsOf, type IndexState, type LogEntry } from './logs';
import type { Session } from './login';
import {
  capOf, chunk, countBy, eventStatus, extendedEnd, feeOf, filterRows, organizes, projectYield, REFUND_BATCH, refundableIds, resaleStats, settleState, STATUS_LABEL, supplyOf, ticketRows, ticketsCsv, waitingOf, wallCells,
  type EventInfo, type StatusFilter, type TicketRow,
} from './model';
import type { EventsSnapshot } from './chain';
import { useChainNow, type ChainData } from './useData';
import { config } from './config';
import { LifecyclePanel, QuorumPanel, SalesPanel } from './Panels';
import { ReconPanel } from './ReconPanel';
import { GateDevicesPanel, OutcomePanel, PinHint, VenueDoorPanel } from './VenueDoor';
import { Badge, Confirm, Empty, Field, HashLink, Metric, Perforation, Skeleton, StaleBanner, TxLine, useTx, type TxState, Icon } from './ui';

export type Tab = 'overview' | 'tickets' | 'resale' | 'gate' | 'money' | 'recon';
export const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'tickets', label: 'Vé' },
  { key: 'resale', label: 'Bán lại' },
  { key: 'gate', label: 'Soát vé' },
  // Lifecycle and money in one place: where the event stands, then cancel, refund and settle.
  { key: 'money', label: 'Vòng đời' },
  // Reconciliation of VND payments against the hashes on chain; only in a build that takes VND payments.
  ...(config.receipts ? [{ key: 'recon' as const, label: 'Đối soát' }] : []),
];

interface Ctx {
  e: EventInfo;
  rows: TicketRow[] | null;
  data: ChainData;
  session: Session;
  provider: Eip1193;
  now: number;
  /** Set when the organizer is a Safe this wallet co-owns: organizer actions then need two owners. */
  safe?: SafeInfo;
  /** Nobody is signed in: every figure is shown, no action is offered. */
  readOnly: boolean;
}

const ReadOnlyNote = () => <p className="readonly-note" data-testid="readonly-note">Đang ở chế độ chỉ xem. Số liệu đọc trực tiếp từ chuỗi; đăng nhập bằng ví ban tổ chức để thao tác.</p>;

/** "Safe 2/3", linked to the Safe on the explorer. */
export function SafeTag({ safe }: { safe: SafeInfo }) {
  const url = addressUrl(safe.address);
  const text = `Safe ${safe.threshold}/${safe.owners.length}`;
  return url
    ? <a className="tag mono safe-tag" data-testid="safe-tag" href={url} target="_blank" rel="noreferrer" title={safe.address}>{text}</a>
    : <span className="tag mono safe-tag" data-testid="safe-tag" title={safe.address}>{text}</span>;
}

/** How many owners already approved this exact call at the Safe's current nonce. Null while unknown or without a Safe. */
function useSafeApprovals(safe: SafeInfo | undefined, account: Address, call: BoxWrite, refreshKey: unknown): number | null {
  const [have, setHave] = useState<number | null>(null);
  const key = JSON.stringify(call, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  useEffect(() => {
    let live = true;
    if (!safe) { setHave(null); return; }
    safeCallState(safe, account, call).then((s) => { if (live) setHave(s.approvers.length); }).catch(() => { if (live) setHave(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe, account, key, refreshKey]);
  return have;
}

/**
 * Shown inside every confirmation that will send a transaction to the Safe: which Safe (verified by proxy code,
 * singleton and config pin), who its owners are and how many must approve.
 */
function SafeNotice({ safe }: { safe?: SafeInfo }) {
  if (!safe) return null;
  return (
    <div className="safe-notice mono small" data-testid="safe-notice">
      <span>Gửi qua Safe đã xác minh <b>{safe.address}</b></span>
      <span>Cần {safe.threshold}/{safe.owners.length} chủ ví ký · {safe.owners.map(short).join(' · ')}</span>
    </div>
  );
}

function SafeLine({ safe, have }: { safe?: SafeInfo; have: number | null }) {
  if (!safe) return null;
  return <p className="safe-line mono small" data-testid="safe-line"><SafeTag safe={safe} />{have === null ? null : <span>{have}/{safe.threshold} chữ ký</span>}</p>;
}

export function EventConsole({ id, tab, session, provider, data, readOnly = false }: { id: number; tab: Tab; session: Session; provider: Eip1193; data: ChainData; readOnly?: boolean }) {
  const now = useChainNow(data.snapshot, 1000);
  const e = data.snapshot?.events[id];
  const rows = useMemo(() => {
    if (!e || !data.detail || !data.index) return null;
    return ticketRows(data.detail.tickets, refundsOf(data.index, id), e.tiers);
  }, [e, data.detail, data.index, id]);

  if (!data.snapshot) {
    return <main className="page"><StaleBanner data={data} /><div className="panel"><Skeleton h={40} w="50%" /><Skeleton h={180} /></div></main>;
  }
  if (!e) return <main className="page"><Empty id="not-found">Không tìm thấy sự kiện này. <a href="#/">Về danh sách sự kiện</a></Empty></main>;
  if (!readOnly && !organizes(e, session.address, data.snapshot.safes)) {
    // A contract organizer that is not a verified, configured Safe is never treated as one, whatever it answers.
    const unverified = data.snapshot.unverified.includes(e.organizer.toLowerCase());
    return (
      <main className="page">
        <Empty id={unverified ? 'unverified-organizer' : 'not-yours'}>
          {unverified ? 'Ban tổ chức của sự kiện này là một hợp đồng chưa xác minh. Trang này chỉ thao tác cho ví hoặc Safe đã được cấu hình.' : 'Ví này không phải ban tổ chức của sự kiện này.'} <a href="#/">Về danh sách sự kiện</a>
        </Empty>
      </main>
    );
  }
  const status = eventStatus(e, now);
  // A Safe organizer: every organizer action goes through it and needs its threshold of owners.
  const safe = e.organizer.toLowerCase() === session.address.toLowerCase() ? undefined : data.snapshot.safes[e.organizer.toLowerCase()];
  const ctx: Ctx = { e, rows, data, session, provider, now, safe, readOnly };
  return (
    <div className="console">
      <nav className="side" aria-label="Sự kiện">
        <a className="back mono" href="#/" data-testid="back"><Icon name="arrow-left" size={14} />Sự kiện</a>
        <div className={`side-stub s-${status}`} style={{ backgroundImage: `linear-gradient(180deg, rgba(18,19,26,.15), rgba(18,19,26,.85)), url(${eventPhoto(e.id)})` }}>
          <div className="row between"><span className="mono small">#{String(e.id).padStart(2, '0')}</span><Badge status={status} /></div>
          <span className="display side-name" data-testid="event-name">{e.name}</span>
          <span className="mono small sub-ink">{eventWhen(e.startsAt, e.endsAt)}</span>
          {safe ? <SafeTag safe={safe} /> : null}
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <a key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`tab-${t.key}`} className={tab === t.key ? 'tab on' : 'tab'} href={`#/e/${e.id}/${t.key}`}>{t.label}</a>
          ))}
        </div>
      </nav>
      <main className="content">
        <StaleBanner data={data} />
        <header className="content-head">
          <h1 className="display">{TABS.find((t) => t.key === tab)!.label}</h1>
          <span className="mono small muted">{e.venue} · {timeRange(e.startsAt, e.endsAt)}</span>
        </header>
        {tab === 'overview' ? <Overview {...ctx} /> : null}
        {tab === 'tickets' ? <Tickets {...ctx} /> : null}
        {tab === 'resale' ? <Resale {...ctx} /> : null}
        {tab === 'gate' ? <Gate {...ctx} /> : null}
        {tab === 'money' ? <Money {...ctx} /> : null}
        {tab === 'recon' ? <ReconPanel eventId={e.id} index={data.index} refreshKey={data.snapshot?.readAt} /> : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ e, rows, data, now }: Ctx) {
  const status = eventStatus(e, now);
  const supply = supplyOf(e);
  const stats = resaleStats(e);
  const activity = data.index ? entriesOf(data.index, e.id).filter((x) => x.kind !== 'ScannerSet' && x.kind !== 'EventCreated').slice(0, 14) : null;
  return (
    <div className="ov-grid">
      <section className={`stub hero-stub s-${status}`} data-testid="hero">
        <img className="hero-photo" src={eventPhoto(e.id)} alt="" />
        <div className="stub-top hero-top">
          <span className="eyebrow mono">{eventWhen(e.startsAt, e.endsAt)} · {e.venue}</span>
          <div className="hero-numbers">
            <span className="display hero"><b data-testid="checked-in">{e.checkedIn}</b><small>/{e.issued}</small></span>
            <span className="hero-label mono">Đã vào cửa / đã phát hành</span>
          </div>
        </div>
        <Perforation />
        <div className="stub-bottom hero-bottom mono small">
          <Badge status={status} />
          <span data-testid="quorum" title="Số vé trả tiền đã soát ở cửa. Từ một nửa trở lên thì sự kiện được tính là đã diễn ra.">Vé trả tiền đã vào cửa <b>{e.paidCheckedIn}</b>/{e.paidSold}{e.paidSold ? ` · ${e.quorumMet ? 'đủ một nửa' : 'chưa đủ một nửa'}` : ''}</span>
          <span><b data-testid="issued">{e.issued}</b>/{supply} vé đã phát hành</span>
        </div>
      </section>

      <section className="panel float-card" data-testid="float-card">
        <div className="panel-head"><h2 className="display with-icon"><Icon name="banknote" size={22} />Tiền giữ hộ</h2><span className="tag">Quỹ giữ hộ</span></div>
        <Metric big label="Tiền vé đang giữ" id="principal" value={vnd(e.principal)} />
        <div className="metric">
          <span className="label">Lãi</span>
          <YieldTicker e={e} snapshot={data.snapshot} />
          <span className="sub">{e.cancelled ? 'Lãi giả lập · dừng từ lúc huỷ' : 'Lãi giả lập · 5%/năm'}</span>
        </div>
      </section>

      <SalesPanel e={e} index={data.index} feeBps={data.snapshot?.feeBps ?? 0} />

      <section className="panel wall-panel">
        <div className="panel-head"><h2 className="display with-icon"><Icon name="ticket" size={22} />Sơ đồ vé</h2><span className="mono small muted">{supply} vé</span></div>
        {rows ? <Wall e={e} rows={rows} /> : <div className="wall">{Array.from({ length: Math.min(supply, 24) }, (_, i) => <span key={i} className="cell loading" />)}</div>}
      </section>

      <div className="ov-col">
        <section className="panel resale-card" data-testid="resale-card">
          <div className="panel-head"><h2 className="display with-icon"><Icon name="repeat" size={22} />Bán lại</h2><span className="tag amber-tag">Trần +10%</span></div>
          <div className="metrics two">
            <Metric label="Lượt bán lại" id="resales" value={stats.count} />
            <Metric label="Đang rao" id="listed" value={stats.listed} sub={<span data-testid="in-line">{waitingOf(e)} người chờ mua</span>} />
            <Metric label="Tổng tiền" value={vnd(stats.volume)} />
            <Metric label="So với giá gốc" id="avg-face" value={stats.avgPctOfFace === null ? '—' : `${stats.avgPctOfFace.toFixed(1)}%`} />
          </div>
        </section>

        <section className="panel activity" data-testid="activity">
          <div className="panel-head"><h2 className="display with-icon"><Icon name="activity" size={22} />Hoạt động</h2>{data.index && !data.index.complete ? <span className="mono small muted" data-testid="syncing">Đang đồng bộ…</span> : null}</div>
          {!activity ? <><Skeleton /><Skeleton /><Skeleton /></> : activity.length === 0 ? <Empty>Chưa có hoạt động nào</Empty> : (
            <ul className="feed">{activity.map((x) => <FeedItem key={x.id} x={x} e={e} index={data.index!} now={now} />)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}

function YieldTicker({ e, snapshot }: { e: EventInfo; snapshot: EventsSnapshot | null }) {
  const now = useChainNow(snapshot, 250);
  const elapsedMs = snapshot ? now * 1000 - snapshot.blockTime * 1000 : 0;
  const v = projectYield(e.yieldAccrued, e.principal, elapsedMs, e.cancelled);
  return <span className="value ticker" data-testid="yield">{vnd(v)}</span>;
}

function Wall({ e, rows }: { e: EventInfo; rows: TicketRow[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [limit, setLimit] = useState(240);
  const { cells, hidden } = wallCells(rows, e, limit);
  const counts = countBy(rows);
  const sel = rows.find((r) => r.tokenId === picked);
  const unsold = Math.max(0, supplyOf(e) - e.issued);
  return (
    <>
      <div className="wall" data-testid="wall">
        {cells.map((c, i) => c.tokenId !== undefined
          ? <button key={i} data-testid={`cell-${c.tokenId}`} className={`cell ${c.kind}${picked === c.tokenId ? ' picked' : ''}`} aria-label={`Vé ${c.tokenId}, ${STATUS_LABEL[c.kind as keyof typeof STATUS_LABEL]}`} aria-pressed={picked === c.tokenId} onClick={() => setPicked(picked === c.tokenId ? null : c.tokenId!)}>{c.kind === 'checked' ? <Icon name="check" size={16} /> : c.tokenId}</button>
          : <span key={i} className={`cell ${c.kind}`} />)}
      </div>
      {hidden > 0 ? <button className="btn ghost sm" onClick={() => setLimit(limit + 480)}>Xem thêm {hidden} vé</button> : null}
      <div className="legend">
        <span><i className="cell mini valid" />Hợp lệ <b data-testid="n-valid">{counts.valid}</b></span>
        <span><i className="cell mini checked"><Icon name="check" size={10} /></i>Đã vào cửa <b>{counts.checked}</b></span>
        <span><i className="cell mini listed" />Đang rao <b>{counts.listed}</b></span>
        <span><i className="cell mini refunded" />Đã hoàn <b data-testid="n-refunded">{Math.max(counts.refunded, e.refunded)}</b></span>
        <span><i className="cell mini empty" />Chưa bán <b>{unsold}</b></span>
      </div>
      {sel ? (
        <div className="picked-row" data-testid="picked">
          <b>#{sel.tokenId}</b><span>{e.tiers[sel.tier]?.name}</span><span className="mono">{short(sel.owner)}</span><span>{STATUS_LABEL[sel.status]}</span>
          <span className="mono">{sel.paid > 0n ? vnd(sel.paid) : 'Vé mời'}</span>
        </div>
      ) : null}
    </>
  );
}

const KIND_TAG: Record<LogEntry['kind'], string> = {
  Purchased: 'Mua vé', Issued: 'Vé mời', Listed: 'Rao bán', Unlisted: 'Gỡ rao', Resold: 'Bán lại', CheckedIn: 'Vào cửa', Refunded: 'Hoàn tiền', Cancelled: 'Huỷ', Settled: 'Quyết toán', EventCreated: 'Tạo', ScannerSet: 'Soát vé',
  WaitlistJoined: 'Xếp hàng', WaitlistLeft: 'Rời hàng', Extended: 'Lùi giờ',
};

function describe(x: LogEntry, e: EventInfo, mintsRef: IndexState['mints']): string {
  const tier = x.tier !== undefined ? e.tiers[x.tier]?.name ?? `Hạng ${x.tier}` : '';
  switch (x.kind) {
    case 'Purchased': return `${x.quantity} × ${tier} · ${vnd(x.amount ?? 0n)}`;
    case 'Issued': return `${x.quantity} × ${tier} → ${short(x.account!)}`;
    case 'Listed': return `#${x.tokenId} giá ${vnd(x.amount ?? 0n)}`;
    case 'Unlisted': return `#${x.tokenId}`;
    case 'Resold': {
      const face = x.tokenId !== undefined ? e.tiers[mintsRef.get(x.tokenId)?.tier ?? -1]?.price : undefined;
      return `#${x.tokenId} · ${vnd(x.amount ?? 0n)}${face ? ` · ${(Number(((x.amount ?? 0n) * 1000n) / face) / 10).toFixed(1)}% giá gốc` : ''}`;
    }
    case 'CheckedIn': return `#${x.tokenId} · ${short(x.account!)}`;
    case 'Refunded': return `#${x.tokenId} · ${vnd(x.amount ?? 0n)}`;
    case 'Cancelled': return 'Đã huỷ sự kiện';
    case 'Settled': return `${vnd(x.amount ?? 0n)} + ${vnd(x.yieldPaid ?? 0n)} lãi${x.fee ? ` · phí ${vnd(x.fee)}` : ''}`;
    case 'ScannerSet': return `${x.allowed ? '+' : '−'} ${short(x.account!)}`;
    case 'WaitlistJoined': return `${short(x.account!)} · ${tier} · đặt cọc ${vnd(x.amount ?? 0n)}`;
    case 'WaitlistLeft': return `${short(x.account!)} · ${tier}`;
    case 'Extended': return `Giờ kết thúc mới ${eventDate(Number(x.amount ?? 0n))}`;
    default: return '';
  }
}

function FeedItem({ x, e, index, now }: { x: LogEntry; e: EventInfo; index: IndexState; now: number }) {
  return (
    <li>
      <span className={`kind k-${x.kind}`}>{KIND_TAG[x.kind]}</span>
      <span className="feed-text" title={x.account}>{describe(x, e, index.mints)}</span>
      <span className="feed-meta"><span className="mono small muted">{x.timestamp ? `${ago(x.timestamp, now)} trước` : ''}</span><HashLink hash={x.hash} /></span>
    </li>
  );
}

// ---------------------------------------------------------------- tickets

const PAGE = 50;
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Tất cả' }, { key: 'valid', label: 'Hợp lệ' }, { key: 'checked', label: 'Đã vào cửa' }, { key: 'listed', label: 'Đang rao' }, { key: 'refunded', label: 'Đã hoàn' },
];

function Tickets({ e, rows }: Ctx) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [shown, setShown] = useState(PAGE);
  if (!rows) return <section className="panel"><Skeleton h={44} /><Skeleton /><Skeleton /><Skeleton /></section>;
  const list = filterRows(rows, query, status);
  const counts = countBy(rows);

  function exportCsv() {
    // The BOM makes Excel read UTF-8 text correctly.
    const blob = new Blob(['﻿', ticketsCsv(list, e.tiers)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `event-${e.id}-tickets-${status}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <label className="search"><span className="sr">Tìm vé</span><input data-testid="search" value={query} onChange={(ev) => { setQuery(ev.target.value); setShown(PAGE); }} placeholder="Tìm số vé hoặc ví" /></label>
        <div role="group" aria-label="Lọc theo trạng thái" className="chips">
          {FILTERS.map((f) => <button key={f.key} data-testid={`filter-${f.key}`} aria-pressed={status === f.key} className={status === f.key ? 'chip on' : 'chip'} onClick={() => { setStatus(f.key); setShown(PAGE); }}>{f.label}<span className="chip-n">{f.key === 'all' ? rows.length : counts[f.key]}</span></button>)}
        </div>
        <button data-testid="export" className="btn ghost" disabled={list.length === 0} onClick={exportCsv}>Xuất CSV</button>
      </div>
      {list.length === 0 ? <Empty id="no-result">{rows.length ? 'Không có vé nào khớp' : 'Chưa phát hành vé nào'}</Empty> : (
        <div className="table-wrap">
          <table className="cards" data-testid="ticket-table">
            <thead><tr><th>Vé</th><th>Hạng</th><th>Người giữ</th><th>Trạng thái</th><th className="num">Đã trả</th><th className="num">Giá gốc</th></tr></thead>
            <tbody>{list.slice(0, shown).map((r) => (
              <tr key={r.tokenId} data-testid={`row-${r.tokenId}`} className={r.status === 'refunded' ? 'struck' : ''}>
                <td data-label="Vé" className="mono"><b>#{r.tokenId}</b></td>
                <td data-label="Hạng">{e.tiers[r.tier]?.name}</td>
                <td data-label="Người giữ" className="mono" title={r.owner}>{short(r.owner)}</td>
                <td data-label="Trạng thái"><span className={`pill p-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                <td data-label="Đã trả" className="num mono">{r.paid > 0n ? vndNumber(r.paid) : 'Vé mời'}</td>
                <td data-label="Giá gốc" className="num mono">{vndNumber(r.face)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {list.length > shown ? <button className="btn ghost sm" onClick={() => setShown(shown + PAGE)}>Xem thêm {list.length - shown} vé</button> : null}
    </section>
  );
}

// ---------------------------------------------------------------- resale

/** Listings against the cap, the line of buyers per tier, finished resales, and what the platform takes. */
function Resale({ e, data, now }: Ctx) {
  const stats = resaleStats(e);
  const listings = data.detail?.listings ?? null;
  const resales = data.index ? entriesOf(data.index, e.id, ['Resold']) : null;
  const feeBps = data.snapshot?.feeBps ?? 0;
  const fee = platformFee(e, feeBps, data.index ? entriesOf(data.index, e.id, ['Settled']) : []);
  const waiting = waitingOf(e);
  const faceOf = (tokenId: number) => {
    const tier = data.index?.mints.get(tokenId)?.tier;
    return tier === undefined ? null : e.tiers[tier]?.price ?? null;
  };
  return (
    <div className="stack">
      <section className="panel metrics three" data-testid="resale-metrics">
        <Metric label="Lượt bán lại xong" id="rs-count" value={stats.count} />
        <Metric label="Tổng tiền bán lại" id="rs-volume" value={vnd(stats.volume)} sub="Người mua trả thẳng cho người bán" />
        <Metric label="Giá so với giá gốc" id="rs-avg" value={stats.avgPctOfFace === null ? '—' : `${stats.avgPctOfFace.toFixed(1)}%`} sub="Trung bình, trần là 110%" />
        <Metric label="Đang rao" id="rs-listed" value={stats.listed} />
        <Metric label="Người chờ mua" id="rs-waiting" value={waiting} sub="Ai chờ trước được vé rao tiếp theo" />
        <Metric label={`Phí nền tảng ${feeBps / 100}%`} id="rs-fee" value={fee.kind === 'none' ? '—' : vnd(fee.amount)}
          sub={fee.kind === 'collected' ? 'Đã trừ lúc quyết toán' : fee.kind === 'estimate' ? 'Tạm tính trên tiền vé gốc đang giữ' : 'Không thu ở sự kiện này'} />
      </section>
      <p className="panel-note" data-testid="resale-fee-note">Hợp đồng không thu phí trên giao dịch bán lại: người bán nhận đủ số người mua trả. Phí nền tảng {feeBps / 100}% chỉ trừ một lần vào tiền vé gốc khi quyết toán.</p>

      <section className="panel">
        <div className="panel-head"><h2 className="display">Hàng chờ theo hạng vé</h2><span className="mono small muted">{waiting} người</span></div>
        <ul className="staff queue" data-testid="queue">{e.tiers.map((t, i) => (
          <li key={i} data-testid={`queue-${i}`}>
            <span><b>{t.name}</b> <span className="mono small muted">giá gốc {vnd(t.price)} · trần {vnd(capOf(t.price))}</span></span>
            <span className="mono">{e.waiting[i] ?? 0} người chờ</span>
          </li>
        ))}</ul>
      </section>

      <section className="panel">
        <div className="panel-head"><h2 className="display">Vé đang rao</h2><span className="mono small muted">{listings?.length ?? ''}</span></div>
        {!listings ? <Skeleton h={60} /> : listings.length === 0 ? (
          <Empty id="no-listings">{waiting ? `Chưa có vé nào đang rao. ${waiting} người đang chờ: vé rao tiếp theo sẽ khớp ngay cho người đầu hàng.` : 'Chưa có vé nào đang rao.'}</Empty>
        ) : (
          <div className="table-wrap"><table className="cards" data-testid="listings">
            <thead><tr><th>Vé</th><th>Hạng</th><th>Người bán</th><th className="num">Giá rao</th><th className="num">Giá gốc</th><th className="num">Trần 110%</th><th>So với trần</th></tr></thead>
            <tbody>{listings.map((t) => (
              <tr key={t.tokenId} data-testid={`listing-${t.tokenId}`}>
                <td data-label="Vé" className="mono"><b>#{t.tokenId}</b></td>
                <td data-label="Hạng">{e.tiers[t.tier]?.name}</td>
                <td data-label="Người bán" className="mono" title={t.owner}>{short(t.owner)}</td>
                <td data-label="Giá rao" className="num mono">{vndNumber(t.listPrice)}</td>
                <td data-label="Giá gốc" className="num mono">{vndNumber(t.face)}</td>
                <td data-label="Trần 110%" className="num mono">{vndNumber(t.cap)}</td>
                <td data-label="So với trần"><CapBar price={t.listPrice} cap={t.cap} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2 className="display">Bán lại đã xong</h2><span className="mono small muted">{resales ? resales.length : ''}</span></div>
        {!resales ? <Skeleton h={60} /> : resales.length === 0 ? <Empty id="no-resales">Chưa có lượt bán lại nào</Empty> : (
          <div className="table-wrap"><table className="cards" data-testid="resales">
            <thead><tr><th>Vé</th><th>Người bán → người mua</th><th className="num">Giá</th><th>So với trần</th><th>Lúc</th><th>Giao dịch</th></tr></thead>
            <tbody>{resales.slice(0, 50).map((x) => {
              const face = faceOf(x.tokenId!);
              return (
                <tr key={x.id}>
                  <td data-label="Vé" className="mono"><b>#{x.tokenId}</b></td>
                  <td data-label="Người bán → người mua" className="mono">{short(x.account!)} → {short(x.other!)}</td>
                  <td data-label="Giá" className="num mono">{vndNumber(x.amount ?? 0n)}</td>
                  <td data-label="So với trần">{face ? <CapBar price={x.amount ?? 0n} cap={capOf(face)} /> : '—'}</td>
                  <td data-label="Lúc" className="mono small muted">{x.timestamp ? `${ago(x.timestamp, now)} trước` : ''}</td>
                  <td data-label="Giao dịch"><HashLink hash={x.hash} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function CapBar({ price, cap }: { price: bigint; cap: bigint }) {
  const pct = pctOfCap(price, cap);
  return <span className="capbar"><span className="capbar-track"><i style={{ width: `${Math.min(100, pct)}%` }} /></span><span className="mono small">{pct.toFixed(1)}% trần</span></span>;
}

// ---------------------------------------------------------------- door

function Gate({ e, data, session, provider, now, safe, readOnly }: Ctx) {
  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  const scanners = data.detail?.scanners ?? null;
  const valid = isAddress(address.trim());
  const closed = eventStatus(e, now) !== 'live';
  // Through a Safe nothing is sent before the owner has seen which Safe it goes to.
  const [asking, setAsking] = useState<{ wallet: Address; allowed: boolean } | null>(null);

  async function setScanner(a: Address, allowed: boolean) {
    const r = await tx.run({ fn: 'setScanner', args: [BigInt(e.id), a, allowed] }, allowed ? `Đã cấp quyền soát vé · ${short(a)}` : `Đã thu quyền soát vé · ${short(a)}`);
    if (r && allowed) { setAddress(''); setTouched(false); }
  }
  async function grant(ev: FormEvent) {
    ev.preventDefault();
    setTouched(true);
    if (!valid) return;
    const a = address.trim() as Address;
    if (safe) setAsking({ wallet: a, allowed: true });
    else await setScanner(a, true);
  }
  const revoke = (a: Address) => (safe ? setAsking({ wallet: a, allowed: false }) : void setScanner(a, false));

  return (
    <div className="stack narrow-stack">
      <QuorumPanel e={e} now={now} />
      {readOnly ? <ReadOnlyNote /> : <form className="panel" onSubmit={grant} noValidate>
        <div className="panel-head"><h2 className="display">Thêm nhân viên soát vé</h2>{closed ? <span className="tag mono">Sự kiện đã đóng</span> : null}</div>
        <div className="inline-form">
          <Field label="Ví của nhân viên" error={touched && !valid ? 'Không phải địa chỉ ví' : undefined}>
            <input data-testid="scanner-address" value={address} onChange={(ev) => setAddress(ev.target.value)} placeholder="0x…" aria-invalid={touched && !valid} spellCheck={false} />
          </Field>
          <button className="btn" data-testid="scanner-add" disabled={tx.busy}>Cấp quyền</button>
        </div>
        {asking ? (
          <Confirm id="scanner" yes={asking.allowed ? 'Cấp quyền' : 'Thu quyền'} onNo={() => setAsking(null)} onYes={() => { const q = asking; setAsking(null); void setScanner(q.wallet, q.allowed); }}>
            {asking.allowed ? 'Cấp quyền soát vé cho' : 'Thu quyền soát vé của'} <span className="mono">{short(asking.wallet)}</span>
            <SafeNotice safe={safe} />
          </Confirm>
        ) : null}
        <TxLine state={tx.state} />
      </form>}
      <section className="panel">
        <div className="panel-head"><h2 className="display">Nhân viên soát vé</h2><span className="mono small muted" title="Ví được hợp đồng VeGoc cho soát vé của sự kiện này">{scanners ? `${scanners.length} ví trên ${config.network}` : ''}</span></div>
        {!scanners ? <Skeleton h={44} /> : scanners.length === 0 ? <Empty id="no-scanners">Chưa có nhân viên soát vé nào</Empty> : (
          <ul className="staff">{scanners.map((a) => (
            <li key={a} data-testid={`scanner-${a}`}>
              <span className="mono">{addressUrl(a) ? <a href={addressUrl(a)!} target="_blank" rel="noreferrer">{a}</a> : a}</span>
              {readOnly ? null : <button className="btn ghost sm" data-testid={`revoke-${a}`} disabled={tx.busy} onClick={() => revoke(a)}>Thu quyền</button>}
            </li>
          ))}</ul>
        )}
      </section>
      {readOnly ? null : <ExtendPanel e={e} data={data} session={session} provider={provider} now={now} safe={safe} />}
      <PinHint />
      <GateDevicesPanel refreshKey={data.snapshot?.readAt} />
      <VenueDoorPanel eventId={e.id} refreshKey={data.snapshot?.readAt} />
      <OutcomePanel eventId={e.id} refreshKey={data.snapshot?.readAt} provider={provider} account={session.address} readOnly={readOnly} onDone={() => void data.refresh()} />
    </div>
  );
}

/** The longest the contract lets an event's end move back in total (MAX_EXTENSION). */
const EXTEND_STEPS: { minutes: number; label: string }[] = [{ minutes: 30, label: '+30 phút' }, { minutes: 60, label: '+1 giờ' }, { minutes: 120, label: '+2 giờ' }];

/**
 * extendEvent: moves the end of a running event back, for a door that was down. Scanning, and with it the quorum
 * count that decides between settlement and refunds, stays open until the new end.
 */
function ExtendPanel({ e, data, session, provider, now, safe }: Pick<Ctx, 'e' | 'data' | 'session' | 'provider' | 'now' | 'safe'>) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  if (eventStatus(e, now) !== 'live') return null;
  const newEnd = minutes === null ? null : extendedEnd(e.endsAt, minutes);
  return (
    <section className="panel" data-testid="extend-panel">
      <div className="panel-head"><h2 className="display">Cửa mở trễ?</h2><span className="mono small muted">Kết thúc {eventDate(e.endsAt)}</span></div>
      <p className="readonly-note">Lùi giờ kết thúc để còn soát vé được. Tổng cộng lùi tối đa 24 giờ; giờ bắt đầu không đổi.</p>
      <div className="chips" role="group" aria-label="Lùi thêm">
        {EXTEND_STEPS.map((s) => <button key={s.minutes} data-testid={`extend-${s.minutes}`} className={minutes === s.minutes ? 'chip on' : 'chip'} aria-pressed={minutes === s.minutes} disabled={tx.busy} onClick={() => { setMinutes(s.minutes); tx.reset(); }}>{s.label}</button>)}
      </div>
      {newEnd !== null ? (
        <Confirm id="extend" yes="Lùi giờ kết thúc" onNo={() => setMinutes(null)} onYes={() => { const end = newEnd; setMinutes(null); void tx.run({ fn: 'extendEvent', args: [BigInt(e.id), BigInt(end)] }, `Giờ kết thúc mới: ${eventDate(end)}`, undefined, { BadEvent: 'Quá giới hạn: một sự kiện chỉ lùi được tổng cộng 24 giờ.' }); }}>
          Giờ kết thúc mới <b>{eventDate(newEnd)}</b>. Bán vé và soát vé mở đến lúc đó.
          <SafeNotice safe={safe} />
        </Confirm>
      ) : null}
      <TxLine state={tx.state} />
    </section>
  );
}

// ---------------------------------------------------------------- lifecycle and money

function Money(ctx: Ctx) {
  const { e, data, now } = ctx;
  const refunds = data.index ? refundsOf(data.index, e.id) : [];
  const refundedAmount = refunds.reduce((s, r) => s + r.amount, 0n);
  const status = eventStatus(e, now);
  const elapsed = data.snapshot ? now * 1000 - data.snapshot.blockTime * 1000 : 0;
  const first = (kind: LogEntry['kind']) => (data.index ? entriesOf(data.index, e.id, [kind])[0] : undefined);
  // Lives here so the cancel result stays on screen when the panel turns into the refund panel.
  const cancelTx = useTx({ provider: ctx.provider, account: ctx.session.address, onDone: () => void data.refresh(), safe: ctx.safe });
  return (
    <div className="stack">
      <LifecyclePanel e={e} now={now} facts={{
        created: first('EventCreated'), cancelled: first('Cancelled'), settled: first('Settled'),
        refundsLeft: data.detail ? refundableIds(data.detail.tickets, status !== 'noshow').length : null,
        yieldNow: projectYield(e.yieldAccrued, e.principal, elapsed, e.cancelled), feeBps: data.snapshot?.feeBps ?? 0,
      }} />
      <section className="panel metrics four" data-testid="money-metrics">
        <Metric label="Tiền bán vé" id="sales" value={vnd(e.sales)} sub="Bán lần đầu, theo giá gốc" />
        <Metric label="Đang giữ hộ" id="float" value={vnd(e.principal)} sub="Trong quỹ giữ hộ" />
        <div className="metric"><span className="label">Lãi</span><YieldTicker e={e} snapshot={data.snapshot} /><span className="sub">{e.cancelled ? 'Giả lập · dừng từ lúc huỷ' : 'Giả lập · 5%/năm'}</span></div>
        <Metric label="Đã hoàn" id="refunded" value={vnd(refundedAmount)} sub={`${Math.max(e.refunded, refunds.length)} vé`} />
      </section>
      {ctx.readOnly ? <ReadOnlyNote /> : null}
      <div className="actions">
        {/* Only what this step of the event allows: cancel and comps while on sale, refunds after a cancel or a no-show. */}
        {status === 'cancelled' || status === 'noshow' ? <RefundPanel {...ctx} cancelState={cancelTx.state} noShow={status === 'noshow'} /> : null}
        {status === 'live' ? <CancelPanel {...ctx} tx={cancelTx} disabled={ctx.readOnly} /> : null}
        <SettlePanel {...ctx} />
        {status === 'live' ? <IssuePanel {...ctx} disabled={ctx.readOnly} /> : null}
      </div>
    </div>
  );
}

function IssuePanel({ e, data, session, provider, disabled, safe }: Ctx & { disabled: boolean }) {
  const [tier, setTier] = useState(0);
  const [to, setTo] = useState('');
  const [qty, setQty] = useState('1');
  const [asking, setAsking] = useState(false);
  const [touched, setTouched] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  const t = e.tiers[tier];
  const left = t ? t.supply - t.sold : 0;
  const n = Number(qty);
  const toErr = isAddress(to.trim()) ? undefined : 'Không phải địa chỉ ví';
  const qtyErr = Number.isInteger(n) && n >= 1 && n <= Math.min(left, 100) ? undefined : left === 0 ? 'Hạng vé này đã hết' : `Từ 1 đến ${Math.min(left, 100)}`;

  return (
    <section className="panel action" data-testid="issue-panel">
      <div className="panel-head"><h2 className="display">Tặng vé mời</h2><span className="tag mono">Miễn phí</span></div>
      <div className="form-row">
        <label className="field narrow"><span className="label">Hạng vé</span>
          <select data-testid="issue-tier" value={tier} onChange={(ev) => setTier(Number(ev.target.value))} disabled={disabled}>
            {e.tiers.map((x, i) => <option key={i} value={i}>{x.name} · còn {x.supply - x.sold}</option>)}
          </select>
        </label>
        <Field label="Số vé" narrow error={touched ? qtyErr : undefined}><input data-testid="issue-qty" inputMode="numeric" value={qty} onChange={(ev) => setQty(ev.target.value)} disabled={disabled} aria-invalid={touched && !!qtyErr} /></Field>
      </div>
      <Field label="Ví nhận" error={touched ? toErr : undefined}><input data-testid="issue-to" value={to} onChange={(ev) => setTo(ev.target.value)} placeholder="0x…" spellCheck={false} disabled={disabled} aria-invalid={touched && !!toErr} /></Field>
      {asking ? (
        <Confirm id="issue" yes={`Tặng ${n} vé`} onNo={() => setAsking(false)} onYes={async () => {
          setAsking(false);
          const r = await tx.run({ fn: 'issue', args: [BigInt(e.id), BigInt(tier), to.trim() as Address, BigInt(n)] }, `Đã tặng ${n} × ${t.name}`);
          if (r) { setTo(''); setQty('1'); setTouched(false); }
        }}>
          Tặng <b>{n} × {t?.name}</b> cho <span className="mono">{short(to.trim())}</span>. Vé mời không bán lại được và không được hoàn tiền.
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn" data-testid="issue-submit" disabled={disabled || tx.busy} onClick={() => { setTouched(true); if (!toErr && !qtyErr) setAsking(true); }}>Tặng vé</button>
      )}
      <TxLine state={tx.state} />
    </section>
  );
}

function CancelPanel({ e, data, disabled, tx, safe, session }: Ctx & { disabled: boolean; tx: ReturnType<typeof useTx> }) {
  const [asking, setAsking] = useState(false);
  const paid = data.detail ? refundableIds(data.detail.tickets).length : null;
  const approvals = useSafeApprovals(disabled ? undefined : safe, session.address, { fn: 'cancelEvent', args: [BigInt(e.id)] }, data.snapshot?.readAt);
  return (
    <section className="panel action" data-testid="cancel-panel">
      <div className="panel-head"><h2 className="display">Huỷ sự kiện</h2></div>
      <div className="metrics two">
        <Metric label="Vé trả tiền" value={paid ?? '—'} />
        <Metric label="Phải hoàn" value={vnd(e.principal)} />
      </div>
      {asking ? (
        <Confirm id="cancel" danger yes="Huỷ sự kiện" onNo={() => setAsking(false)} onYes={() => { setAsking(false); void tx.run({ fn: 'cancelEvent', args: [BigInt(e.id)] }, 'Đã huỷ sự kiện'); }}>
          Ngừng bán ngay và không mở lại được. Mọi vé trả tiền được hoàn đúng số đã trả, tổng cộng <b>{vnd(e.principal)}</b>.
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn danger" data-testid="cancel" disabled={disabled || tx.busy} onClick={() => setAsking(true)}>Huỷ sự kiện</button>
      )}
      <SafeLine safe={disabled ? undefined : safe} have={approvals} />
      <TxLine state={tx.state} />
    </section>
  );
}

function RefundPanel({ e, data, session, provider, cancelState, noShow, readOnly }: Ctx & { cancelState: TxState; noShow: boolean }) {
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<TxState>({ stage: 'idle' });
  const live = data.detail?.tickets ?? null;
  const ids = live ? refundableIds(live, !noShow) : null;
  const owed = live && ids ? live.filter((t) => ids.includes(t.tokenId)).reduce((s, t) => s + t.paid, 0n) : 0n;
  const busy = state.stage === 'confirm' || state.stage === 'pending';

  async function refundAll() {
    setAsking(false);
    // The contract takes at most 100 tickets per refundMany, about 5.6M gas.
    const batches = chunk(ids!, REFUND_BATCH);
    let done = 0;
    let last: Hex | undefined;
    try {
      for (let i = 0; i < batches.length; i++) {
        const note = batches.length > 1 ? `Đợt ${i + 1}/${batches.length}` : `${batches[i].length} vé`;
        setState({ stage: 'confirm', note });
        const r = await sendBox(provider, session.address, { fn: 'refundMany', args: [batches[i].map(BigInt)] }, (hash) => setState({ stage: 'pending', hash, note }));
        last = r.transactionHash;
        done += batches[i].length;
      }
      setState({ stage: 'done', hash: last, text: `Đã hoàn ${done} vé · ${vnd(owed)}` });
    } catch (err) {
      setState({ stage: 'failed', reason: done ? `${failureText(err)} Đã hoàn được ${done} vé.` : failureText(err) });
    }
    void data.refresh();
  }

  return (
    <section className="panel action refund" data-testid="refund-panel">
      <div className="panel-head"><h2 className="display">Hoàn tiền cho khách</h2><span className="tag mono orange-tag">{noShow ? 'Thiếu lượt vào cửa' : 'Đã huỷ'}</span></div>
      <div className="metrics two">
        <Metric label="Vé chưa hoàn" id="refund-count" value={ids ? ids.length : '—'} />
        <Metric label="Số tiền phải hoàn" id="refund-owed" value={ids ? vnd(owed) : '—'} />
      </div>
      {ids && ids.length === 0 && state.stage === 'idle' && cancelState.stage !== 'done' ? <p className="tx tx-done" data-testid="all-refunded"><Icon name="check" size={16} />Đã hoàn xong cho mọi khách · {e.refunded} vé</p> : null}
      {asking ? (
        <Confirm id="refund" yes={`Hoàn ${ids!.length} vé`} onNo={() => setAsking(false)} onYes={() => void refundAll()}>
          Trả <b>{vnd(owed)}</b> về cho người giữ <b>{ids!.length} vé</b>, mỗi vé đúng số đã trả. Vé đã hoàn bị huỷ.
        </Confirm>
      ) : ids && ids.length === 0 ? null : (
        <button className="btn" data-testid="refund-all" disabled={!ids || busy || readOnly} onClick={() => setAsking(true)}>Hoàn tiền tất cả</button>
      )}
      <TxLine state={state.stage === 'idle' ? cancelState : state} />
    </section>
  );
}

function SettlePanel({ e, data, session, provider, now, safe, readOnly }: Ctx) {
  const [asking, setAsking] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  // Proceeds go to the organizer: the Safe itself when a Safe organizes the event.
  const to = safe ? safe.address : e.organizer;
  const elapsed = data.snapshot ? now * 1000 - data.snapshot.blockTime * 1000 : 0;
  const s = settleState(e, now, projectYield(e.yieldAccrued, e.principal, elapsed, e.cancelled));
  const feeBps = data.snapshot?.feeBps ?? 0;
  const fee = s.kind === 'settle' ? feeOf(s.principal, feeBps) : 0n;
  const feeLabel = `phí nền tảng ${feeBps / 100}%`;
  const settled = data.index ? entriesOf(data.index, e.id, ['Settled']) : [];
  const paidOut = settled.reduce((acc, x) => ({ p: acc.p + (x.amount ?? 0n), y: acc.y + (x.yieldPaid ?? 0n), f: acc.f + (x.fee ?? 0n) }), { p: 0n, y: 0n, f: 0n });
  useEffect(() => { if (s.kind === 'wait' || s.kind === 'done') setAsking(false); }, [s.kind]);
  const label = s.kind === 'yield' ? 'Rút lãi' : 'Quyết toán';
  const open = s.kind === 'settle' || s.kind === 'yield';
  const approvals = useSafeApprovals(open ? safe : undefined, session.address, { fn: 'settle', args: [BigInt(e.id), to] }, data.snapshot?.readAt);

  return (
    <section className="panel action" data-testid="settle-panel">
      <div className="panel-head"><h2 className="display">Quyết toán</h2><span className="mono small muted" title={to}>về {safe ? 'Safe ' : 'ví '}{short(to)}</span></div>
      {s.kind === 'settle' ? (
        <div className="metrics two"><Metric label="Ban tổ chức nhận" id="settle-net" value={vnd(s.principal - fee)} sub={`${vnd(s.principal)} trừ ${feeLabel}`} /><Metric label="Lãi" value={vnd(s.yield)} sub="Giả lập" /></div>
      ) : s.kind === 'yield' ? (
        <div className="metrics two"><Metric label="Tiền vé" value={e.principal > 0n ? 'Giữ để hoàn cho khách' : vnd(0n)} /><Metric label="Lãi" value={vnd(s.yield)} sub="Giả lập" /></div>
      ) : s.kind === 'wait' ? (
        <div className="metrics two"><Metric label="Mở lúc" id="settle-opens" value={eventDate(s.opensAt)} sub={s.dispute ? 'Thiếu lượt vào cửa · giữ thêm 48 giờ' : 'Ngay khi sự kiện kết thúc'} /><Metric label="Đang giữ hộ" value={vnd(e.principal)} /></div>
      ) : (
        <div className="metrics two" data-testid="settled"><Metric label="Tiền vé đã nhận" id="settled-principal" value={vnd(paidOut.p)} sub={paidOut.f > 0n ? `Đã trừ ${feeLabel} · ${vnd(paidOut.f)}` : undefined} /><Metric label="Lãi đã nhận" id="settled-yield" value={vnd(paidOut.y)} /></div>
      )}
      {asking && (s.kind === 'settle' || s.kind === 'yield') ? (
        <Confirm id="settle" yes={label} onNo={() => setAsking(false)} onYes={() => {
          setAsking(false);
          void tx.run({ fn: 'settle', args: [BigInt(e.id), to] }, s.kind === 'settle' ? `Đã quyết toán · ${vnd(s.principal - fee)} + ${vnd(s.yield)} lãi` : `Đã rút lãi · ${vnd(s.yield)}`);
        }}>
          {s.kind === 'settle'
            ? <>Chuyển <b>{vnd(s.principal - fee + s.yield)}</b> về <span className="mono">{short(to)}</span>{fee > 0n ? <>, sau khi trừ {feeLabel} {vnd(fee)}</> : null}. Quyết toán chỉ làm được một lần.</>
            : <>Chuyển <b>{vnd(s.yield)}</b> tiền lãi về <span className="mono">{short(to)}</span>. Tiền vé vẫn giữ để hoàn cho khách.</>}
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn" data-testid="settle" disabled={s.kind === 'wait' || s.kind === 'done' || tx.busy || readOnly} onClick={() => setAsking(true)}>{s.kind === 'done' ? (e.cancelled ? 'Không còn gì để rút' : 'Đã quyết toán') : label}</button>
      )}
      <SafeLine safe={open ? safe : undefined} have={approvals} />
      <TxLine state={tx.state} />
    </section>
  );
}
