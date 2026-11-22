import { useEffect, useState } from 'react';
import { addressUrl, client } from './chain';
import { config } from './config';
import { eventDate, shortHash } from './format';
import type { IndexState } from './logs';
import { fetchLedger, KIND_LABEL, readRecorded, reconcile, totals, type ChainRecord, type LedgerRow, type ReconRow } from './recon';
import { Empty, HashLink, Metric, Skeleton } from './ui';

const dong = (v: bigint) => `${v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const METHOD: Record<NonNullable<ReconRow['method']>, string> = { vietqr: 'VietQR', momo: 'MoMo', bank: 'Chuyển khoản' };
const STATE: Record<ReconRow['state'], string> = { matched: 'Khớp trên chuỗi', ledger: 'Chỉ có ở sổ thanh toán', chain: 'Chỉ có trên chuỗi' };

/**
 * Đối soát: every VND payment of this event from the payment backend, checked against the hash PaymentReceipts
 * holds on chain. Public data on both sides, so it also shows in a read-only visit.
 */
export function ReconPanel({ eventId, index, refreshKey }: { eventId: number; index: IndexState | null; refreshKey?: unknown }) {
  const { receipts, relayerUrl } = config;
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [chain, setChain] = useState<ChainRecord[] | null>(null);
  const [ledgerDown, setLedgerDown] = useState(false);
  const [chainDown, setChainDown] = useState(false);
  useEffect(() => {
    if (!receipts) return;
    let live = true;
    readRecorded(client, receipts, config.receiptsFromBlock, config.logChunk)
      .then((c) => { if (live) { setChain(c); setChainDown(false); } })
      .catch(() => { if (live) setChainDown(true); });
    if (relayerUrl) {
      fetchLedger(relayerUrl)
        .then((l) => { if (live) { setLedger(l); setLedgerDown(false); } })
        .catch(() => { if (live) setLedgerDown(true); });
    }
    return () => { live = false; };
  }, [receipts, relayerUrl, refreshKey]);
  if (!receipts) return <section className="panel"><Empty id="recon-off">Bản này không nhận thanh toán bằng đồng (chưa cấu hình hợp đồng PaymentReceipts).</Empty></section>;

  // Without the backend's list the chain records are still shown, as "chain only".
  const haveLedger = ledger ?? (ledgerDown || !relayerUrl ? [] : null);
  const rows = chain && haveLedger && index ? reconcile(haveLedger, chain, eventId, (id) => index.mints.get(id)?.eventId) : null;
  const t = rows ? totals(rows) : null;
  const url = addressUrl(receipts);
  return (
    <div className="stack">
      {ledgerDown ? <p className="alert" role="alert" data-testid="recon-ledger-down">Không kết nối được máy chủ thanh toán. Chỉ còn bản ghi trên chuỗi nên thiếu số tiền.</p> : null}
      {chainDown && !chain ? <p className="alert" role="alert">Không đọc được PaymentReceipts từ mạng.</p> : null}
      <section className="panel metrics four" data-testid="recon-metrics">
        <Metric label="Đã thu" id="recon-received" value={t ? dong(t.received) : '—'} sub="Mua vé, mua lại, đặt cọc" />
        <Metric label="Đã chi" id="recon-paidout" value={t ? dong(t.paidOut) : '—'} sub="Hoàn tiền và trả người bán" />
        <Metric label="Khớp với chuỗi" id="recon-matched" value={t ? `${t.matched}/${t.payments}` : '—'} sub="Hai bên cùng một mã băm" />
        <Metric label="Cần xem lại" id="recon-open" value={t ? t.open : '—'} sub={t && t.open === 0 ? 'Không còn khoản nào lệch' : 'Lệnh lỗi hoặc thiếu một bên'} />
      </section>
      <section className="panel">
        <div className="panel-head"><h2 className="display">Các khoản thanh toán</h2><span className="tag mono">VietQR · MoMo</span></div>
        {!rows ? <><Skeleton h={44} /><Skeleton /><Skeleton /></> : rows.length === 0 ? <Empty id="recon-none">Sự kiện này chưa có khoản thanh toán nào</Empty> : (
          <div className="table-wrap"><table className="cards" data-testid="recon-table">
            <thead><tr><th>Lúc trả</th><th>Khoản</th><th>Qua</th><th className="num">Số tiền</th><th>Vé</th><th>Mã băm biên nhận</th><th>Giao dịch vé</th><th>Giao dịch ghi nhận</th><th>Đối soát</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.receiptHash} data-testid={`recon-${r.receiptHash.slice(0, 10)}`}>
                <td data-label="Lúc trả" className="mono small">{r.paidAt ? eventDate(r.paidAt) : '—'}</td>
                <td data-label="Khoản">{KIND_LABEL[r.kind]}</td>
                <td data-label="Qua">{r.method ? METHOD[r.method] : '—'}</td>
                <td data-label="Số tiền" className="num mono">{r.amountVnd === null ? '—' : dong(r.amountVnd)}</td>
                <td data-label="Vé" className="mono">{r.tokenIds.length ? r.tokenIds.map((id) => `#${id}`).join(' ') : '—'}</td>
                <td data-label="Mã băm biên nhận" className="mono" title={r.receiptHash}>{shortHash(r.receiptHash)}</td>
                <td data-label="Giao dịch vé">{r.hash ? <HashLink hash={r.hash} /> : '—'}</td>
                <td data-label="Giao dịch ghi nhận">{r.recordTx ? <HashLink hash={r.recordTx} /> : '—'}</td>
                <td data-label="Đối soát"><span className={`pill ${r.failed ? 'p-listed' : r.state === 'matched' ? 'p-checked' : r.state === 'ledger' && r.kind === 'wait' ? 'p-refunded' : 'p-listed'}`}>{r.failed ? 'Lệnh lỗi' : STATE[r.state]}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="mono small muted recon-note" data-testid="recon-note">
          Tiền đi bằng đồng qua ngân hàng hoặc MoMo; khi chạy thật, tiền nằm ở trung gian thanh toán có giấy phép hoặc ngân hàng cho tới lúc quyết toán. Hợp đồng chỉ giữ sổ lệnh và bằng chứng: với mỗi vé là keccak256(mã ngân hàng, số tiền, salt), người mua tự tính lại được.
          {url ? <> <a href={url} target="_blank" rel="noreferrer">PaymentReceipts {receipts.slice(0, 10)}…</a></> : null}
        </p>
      </section>
    </div>
  );
}
