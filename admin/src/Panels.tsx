// Read-only panels built from insights.ts: the event's lifecycle, sales per tier, and the door quorum.
import { eventDate, vnd, vndNumber } from './format';
import { lifecycle, platformFee, quorumView, tierSales, type LifeFacts, type StepState } from './insights';
import { entriesOf, refundsOf, type IndexState } from './logs';
import { eventStatus, supplyOf, type EventInfo } from './model';
import { Badge, HashLink, Metric, Icon } from './ui';

const STEP_STATE: Record<StepState, string> = { done: 'Đã xong', now: 'Đang ở bước này', next: 'Sắp tới' };

/**
 * Where the event stands: on sale → ended → settled, or cancelled → refunded, or ended short of the door quorum →
 * refunds → settled. The actions themselves sit right below this panel.
 */
export function LifecyclePanel({ e, now, facts }: { e: EventInfo; now: number; facts: LifeFacts }) {
  const life = lifecycle(e, now, facts);
  return (
    <section className="panel life-panel" data-testid="lifecycle">
      <div className="panel-head"><h2 className="display">Vòng đời sự kiện</h2><Badge status={life.status} /></div>
      <ol className="life">
        {life.steps.map((s, i) => (
          <li key={s.key} className={`life-step ${s.state}`} data-testid={`step-${s.key}`} aria-current={s.state === 'now' ? 'step' : undefined}>
            <span className="life-mark" aria-hidden="true">{s.state === 'done' ? <Icon name="check" size={16} /> : i + 1}</span>
            <div className="life-body">
              <span className="life-title"><b>{s.title}</b><span className="life-state">{STEP_STATE[s.state]}</span></span>
              {s.at ? <span className="mono small muted">{eventDate(s.at)}</span> : null}
              <span className="life-note">{s.note}</span>
              {s.hash ? <HashLink hash={s.hash} /> : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="life-hint" data-testid="life-hint"><b>Việc làm được lúc này.</b> {life.hint}</p>
    </section>
  );
}

/** Sold and left per tier, money from the primary sale, refunds, and the platform fee. Chain reads and logs only. */
export function SalesPanel({ e, index, feeBps }: { e: EventInfo; index: IndexState | null; feeBps: number }) {
  const synced = !!index?.complete;
  const rows = tierSales(e, synced ? entriesOf(index!, e.id, ['Purchased', 'Issued']) : null);
  const refunds = index ? refundsOf(index, e.id) : [];
  const refunded = refunds.reduce((s, r) => s + r.amount, 0n);
  const fee = platformFee(e, feeBps, index ? entriesOf(index, e.id, ['Settled']) : []);
  const supply = supplyOf(e);
  const sum = (pick: (r: (typeof rows)[number]) => number | null) => (rows.every((r) => pick(r) !== null) ? rows.reduce((s, r) => s + (pick(r) ?? 0), 0) : null);
  return (
    <section className="panel sales-panel" data-testid="sales-panel">
      <div className="panel-head">
        <h2 className="display">Bán vé theo hạng</h2>
        {synced ? <span className="mono small muted">{e.issued}/{supply} vé</span> : <span className="mono small muted" data-testid="sales-syncing">Đang đọc lịch sử giao dịch…</span>}
      </div>
      <div className="table-wrap">
        <table className="cards" data-testid="tier-table">
          <thead><tr><th>Hạng vé</th><th className="num">Giá</th><th className="num">Đã phát hành</th><th className="num">Còn lại</th><th className="num">Vé trả tiền</th><th className="num">Vé mời</th><th className="num">Tiền thu</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-testid={`tier-row-${i}`}>
                <td data-label="Hạng vé"><b>{r.name}</b></td>
                <td data-label="Giá" className="num mono">{vndNumber(r.price)}</td>
                <td data-label="Đã phát hành" className="num mono">{r.sold}/{r.supply}</td>
                <td data-label="Còn lại" className="num mono">{r.left}</td>
                <td data-label="Vé trả tiền" className="num mono">{r.paid ?? '…'}</td>
                <td data-label="Vé mời" className="num mono">{r.comps ?? '…'}</td>
                <td data-label="Tiền thu" className="num mono">{r.revenue === null ? '…' : vndNumber(r.revenue)}</td>
              </tr>
            ))}
            <tr className="total" data-testid="tier-total">
              <td data-label="Hạng vé"><b>Tổng</b></td>
              <td data-label="Giá" className="num mono only-wide">—</td>
              <td data-label="Đã phát hành" className="num mono">{e.issued}/{supply}</td>
              <td data-label="Còn lại" className="num mono">{Math.max(0, supply - rows.reduce((s, r) => s + r.sold, 0))}</td>
              <td data-label="Vé trả tiền" className="num mono">{sum((r) => r.paid) ?? '…'}</td>
              <td data-label="Vé mời" className="num mono">{sum((r) => r.comps) ?? '…'}</td>
              <td data-label="Tiền thu" className="num mono"><b>{vndNumber(e.sales)}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="metrics four sales-totals">
        <Metric label="Tiền bán vé" id="sales-gross" value={vnd(e.sales)} sub="Bán lần đầu, theo giá gốc" />
        <Metric label="Đã hoàn" id="sales-refunded" value={vnd(refunded)} sub={`${Math.max(e.refunded, refunds.length)} vé`} />
        <Metric label="Đang giữ hộ" id="sales-held" value={vnd(e.principal)} sub="Nằm trong quỹ giữ hộ đến khi quyết toán" />
        <Metric label={`Phí nền tảng ${feeBps / 100}%`} id="sales-fee" value={fee.kind === 'none' ? '—' : vnd(fee.amount)}
          sub={fee.kind === 'collected' ? 'Đã trừ lúc quyết toán' : fee.kind === 'estimate' ? 'Tạm tính trên số đang giữ' : e.cancelled ? 'Sự kiện huỷ thì không thu' : 'Hợp đồng này không thu phí'} />
      </div>
    </section>
  );
}

/** The contract's own gate count, the one settlement and refunds depend on. */
export function QuorumPanel({ e, now }: { e: EventInfo; now: number }) {
  const q = quorumView(e);
  const status = eventStatus(e, now);
  const result = e.paidSold === 0 ? 'Chưa bán vé trả tiền nào, nên chưa có gì để xét.'
    : status === 'cancelled' ? 'Sự kiện đã huỷ: không xét lượt vào cửa, mọi vé trả tiền đều được hoàn.'
    : status === 'live' ? (q.met
      ? 'Đã đủ một nửa. Quyết toán mở ngay khi sự kiện kết thúc.'
      : `Còn thiếu ${q.missing} lượt. Nếu tới giờ kết thúc vẫn thiếu, khách được hoàn tiền và quyết toán lùi 48 giờ.`)
    : q.met ? 'Đủ một nửa: sự kiện được tính là đã diễn ra, ban tổ chức được quyết toán.'
    : `Không đủ một nửa: khách chưa vào cửa được hoàn tiền, quyết toán mở lúc ${eventDate(e.settleAt)}.`;
  return (
    <section className="panel" data-testid="quorum-panel">
      <div className="panel-head">
        <h2 className="display">Kết quả vào cửa</h2>
        <span className={`tag mono ${q.met && e.paidSold ? 'green-tag' : e.paidSold ? 'amber-tag' : ''}`} data-testid="quorum-result">{e.paidSold === 0 ? 'Chưa xét' : q.met ? 'Đủ một nửa' : 'Chưa đủ một nửa'}</span>
      </div>
      <div className="metrics three">
        <Metric label="Đã vào cửa" id="door-in" value={`${e.checkedIn}/${e.issued}`} sub="Mọi vé, kể cả vé mời" />
        <Metric label="Vé trả tiền đã vào" id="door-paid" value={`${e.paidCheckedIn}/${e.paidSold}`} sub="Chỉ số này quyết định kết quả" />
        <Metric label="Cần ít nhất" id="door-need" value={q.need} sub={e.paidSold === 0 ? undefined : q.met ? 'Đã đạt' : `Thiếu ${q.missing}`} />
      </div>
      <div className={`meter venue-meter ${q.met && e.paidSold ? 'met' : ''}`} aria-hidden="true"><i style={{ width: `${q.pct}%` }} /></div>
      <p className="panel-note" data-testid="quorum-text">{result}</p>
    </section>
  );
}
