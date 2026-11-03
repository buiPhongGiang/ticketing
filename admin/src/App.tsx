import { useCallback, useEffect, useState } from 'react';
import { formatAmount, timeAgo } from '../../app/src/format';
import { holdersOf, type DashboardSnapshot } from '../../app/src/lib/dashboard';
import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { eventIndex, failureText, isScanner, login, logout, reader, restoreSession, sendAction, walletProvider, type AdminAction, type Eip1193 } from './chain';
import { config, deployBlock, eventInfo } from './config';
import { ticketsCsv } from './csv';
import { revenueOf, scannerCandidates, type IndexedEvent, type IndexState } from './events';
import { filterTickets, type StatusFilter } from './filter';
import { LoginError, type Session } from './login';

const POLL_MS = 15_000;
const PAGE = 50;
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const amount = (wei: bigint | string) => formatAmount(wei, config.nativeSymbol);
const clock = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour12: false });

type View = 'overview' | 'tickets' | 'mint' | 'scanners' | 'revenue';
const VIEWS: { key: View; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'tickets', label: 'Danh sách vé' },
  { key: 'mint', label: 'Phát hành vé' },
  { key: 'scanners', label: 'Nhân viên cổng' },
  { key: 'revenue', label: 'Doanh thu' },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const provider = walletProvider();

  useEffect(() => {
    restoreSession(provider).then(setSession).finally(() => setChecking(false));
  }, [provider]);

  const signOut = useCallback(() => { logout(); setSession(null); }, []);

  // Another account or network in the wallet means the login no longer describes who is here.
  useEffect(() => {
    if (!provider?.on || !session) return;
    provider.on('accountsChanged', signOut);
    provider.on('chainChanged', signOut);
    return () => { provider.removeListener?.('accountsChanged', signOut); provider.removeListener?.('chainChanged', signOut); };
  }, [provider, session, signOut]);

  if (checking) return <main className="gate"><p className="muted">Đang kiểm tra đăng nhập…</p></main>;
  if (!session || !provider) return <LoginScreen provider={provider} onLogin={setSession} />;
  return <Console session={session} provider={provider} onSignOut={signOut} />;
}

function LoginScreen({ provider, onLogin }: { provider?: Eip1193; onLogin: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function connect() {
    setBusy(true); setProblem(null);
    try {
      onLogin(await login(provider!));
    } catch (e) {
      if (e instanceof LoginError && e.reason === 'NotOrganizer') setProblem('Ví này không phải ban tổ chức của sự kiện. Đổi sang đúng ví rồi thử lại.');
      else if (e instanceof LoginError) setProblem('Không xác minh được chữ ký. Thử đăng nhập lại.');
      else setProblem(failureText(e));
    } finally { setBusy(false); }
  }

  return (
    <main className="gate">
      <div className="stub login">
        <div className="stub-top"><span className="display big-title">Quản trị vé</span><span>{eventInfo.name} · {eventInfo.when} · {eventInfo.venue}</span></div>
        <Perforation />
        <div className="stub-bottom login-body">
          {provider
            ? <button data-testid="login" className="btn light" disabled={busy} onClick={connect}>{busy ? 'Xác nhận trong ví…' : 'Đăng nhập bằng ví'}</button>
            : <p data-testid="no-wallet">Trình duyệt chưa có ví. Cài một ví như <a href="https://metamask.io/download/">MetaMask</a> rồi tải lại trang.</p>}
          <p className="fine">Bạn chỉ ký một tin nhắn, không tạo giao dịch và không tốn phí. Chỉ ví ban tổ chức của hợp đồng {short(config.contract)} mới vào được.</p>
          {problem ? <p data-testid="login-error" className="alert" role="alert">{problem}</p> : null}
        </div>
      </div>
    </main>
  );
}

const Perforation = () => <div className="perforation"><i /><span /><i /></div>;

function useAdminData() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [index, setIndex] = useState<IndexState | null>(null);
  const [error, setError] = useState(false);
  const [indexError, setIndexError] = useState(false);

  const refresh = useCallback(async () => {
    const reads = await Promise.allSettled([reader.read(), eventIndex.sync(setIndex)]);
    if (reads[0].status === 'fulfilled') setData(reads[0].value);
    setError(reads[0].status === 'rejected');
    if (reads[1].status === 'fulfilled') setIndex(reads[1].value);
    else setIndex(eventIndex.state());
    setIndexError(reads[1].status === 'rejected');
  }, []);

  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await refresh(); } finally { running = false; }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, index, error, indexError, refresh };
}

function Console({ session, provider, onSignOut }: { session: Session; provider: Eip1193; onSignOut: () => void }) {
  const [view, setView] = useState<View>('overview');
  const { data, index, error, indexError, refresh } = useAdminData();
  const events = index?.events ?? [];
  const send = (action: AdminAction, onHash: (h: Hex) => void) => sendAction(provider, session.address, action, onHash);

  return (
    <div className="shell">
      <nav className="side" aria-label="Quản trị">
        <div className="brand"><span className="display">Quản trị vé</span><span className="muted small">{eventInfo.name}</span></div>
        {VIEWS.map((v) => <button key={v.key} data-testid={`view-${v.key}`} aria-current={view === v.key ? 'page' : undefined} className={view === v.key ? 'nav on' : 'nav'} onClick={() => setView(v.key)}>{v.label}</button>)}
        <div className="grow" />
        <div className="me">
          <span className="mono small" data-testid="me">{short(session.address)}</span>
          <span className="muted small">{eventInfo.network}</span>
          <button data-testid="logout" className="btn ghost" onClick={onSignOut}>Đăng xuất</button>
        </div>
      </nav>
      <main className="content">
        <header className="top">
          <h1 className="display">{VIEWS.find((v) => v.key === view)!.label}</h1>
          <div className="status">
            <span className={error ? 'dot off' : 'dot'} />
            <span className="mono small" data-testid="updated">{error ? 'Mất kết nối' : 'Trực tiếp'}{data ? ` · ${clock(data.readAt)}` : ''}</span>
            <button data-testid="refresh" className="btn ghost" onClick={refresh}>Làm mới</button>
          </div>
        </header>
        {error ? <p data-testid="stale" className="alert" role="alert">{data ? `Không kết nối được mạng. Số liệu dưới đây là của lúc ${clock(data.readAt)}.` : 'Không kết nối được mạng. Thử lại sau.'}</p> : null}
        {!data ? (error ? null : <p className="muted">Đang tải…</p>) : <>
          {view === 'overview' ? <Overview data={data} events={events} index={index} /> : null}
          {view === 'tickets' ? <Tickets data={data} events={events} /> : null}
          {view === 'mint' ? <Mint data={data} send={send} onDone={refresh} /> : null}
          {view === 'scanners' ? <Scanners index={index} indexError={indexError} send={send} onDone={refresh} /> : null}
          {view === 'revenue' ? <RevenueView data={data} index={index} indexError={indexError} session={session} send={send} onDone={refresh} /> : null}
        </>}
      </main>
    </div>
  );
}

function Metric({ label, value, id, note }: { label: string; value: string; id?: string; note?: string }) {
  return <div className="metric"><span className="label">{label}</span><span className="value" data-testid={id}>{value}</span>{note ? <span className="muted small">{note}</span> : null}</div>;
}

function ScanNote({ index, error }: { index: IndexState | null; error?: boolean }) {
  if (!index || index.complete) return null;
  const total = index.latest - index.fromBlock + 1n;
  const done = index.scannedTo - index.fromBlock + 1n;
  const text = deployBlock === undefined
    ? `Chưa cấu hình block triển khai (VITE_DEPLOY_BLOCK), nên chỉ đọc được ${done > 0n ? done : 0n} block gần đây.`
    : `Đang đọc lịch sử: ${done > 0n ? done : 0n} / ${total} block.`;
  return <p data-testid="scan-note" className="note">{text}{error ? ' RPC đang từ chối hoặc lỗi, sẽ tự thử lại.' : ''}</p>;
}

function Overview({ data, events, index }: { data: DashboardSnapshot; events: IndexedEvent[]; index: IndexState | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState(200);
  const total = Number(data.maxSupply);
  const cells = Array.from({ length: Math.min(total, shown) }, (_, i) => data.tickets[i] ?? null);
  const selected = data.tickets.find((t) => t.tokenId === picked);
  const recent = [...events].filter((e) => e.name !== 'ScannerSet').reverse().slice(0, 12);
  const share = data.issued ? ` (${((data.entered / data.issued) * 100).toFixed(1)}%)` : '';
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="columns">
      <div className="stack">
        <div className="stub">
          <div className="stub-top row"><span className="display hero"><b data-testid="entered">{data.entered}</b><small>/{data.issued}</small></span><span>đã vào cửa{share}</span></div>
          <Perforation />
          <div className="stub-bottom row between mono small"><span>{eventInfo.when} · {eventInfo.venue}</span><span>{data.maxSupply} vé tối đa</span></div>
        </div>
        <section className="panel">
          <h2 className="display">Tường vé</h2>
          <div className="wall">
            {cells.map((t, i) => t
              ? <button key={i} data-testid={`cell-${t.tokenId}`} aria-label={`Vé ${t.tokenId}, ${t.checkedIn ? 'đã vào' : 'chưa vào'}`} aria-pressed={picked === t.tokenId} className={`cell ${t.checkedIn ? 'in' : 'wait'}${picked === t.tokenId ? ' picked' : ''}`} onClick={() => setPicked(t.tokenId)}>{t.checkedIn ? '✓' : t.tokenId}</button>
              : <span key={i} className="cell free" />)}
          </div>
          {total > shown ? <button data-testid="wall-more" className="btn ghost" onClick={() => setShown(shown + 200)}>Xem thêm ({total - shown} ô)</button> : null}
          <div className="legend">
            <span><i className="cell mini in">✓</i>Đã vào <b>{data.entered}</b></span>
            <span><i className="cell mini wait" />Chưa vào <b data-testid="waiting">{data.waiting}</b></span>
            <span><i className="cell mini free" />Chưa phát hành <b data-testid="unsold">{data.unsold}</b></span>
          </div>
          {selected ? <p data-testid="picked" className="picked-row"><b>Vé #{selected.tokenId}</b><span className="mono">{selected.owner}</span><span>{selected.checkedIn ? 'Đã vào' : 'Chưa vào'}</span></p> : null}
        </section>
      </div>
      <div className="stack">
        <section className="panel metrics">
          <Metric label="VÍ ĐANG GIỮ VÉ" value={String(data.holders)} id="holders" />
          <Metric label="GIÁ VÉ" value={data.priceWei === '0' ? 'Không bán' : amount(data.priceWei)} />
          <Metric label="TIỀN CHƯA RÚT" value={amount(data.balanceWei)} id="balance" />
        </section>
        <section className="panel" data-testid="activity">
          <h2 className="display">Hoạt động</h2>
          <ScanNote index={index} />
          {recent.length === 0 ? <p className="muted">Chưa có hoạt động nào.</p> : (
            <ul className="feed">{recent.map((e) => <li key={e.id}><span>{describe(e)}</span><span className="mono small muted">{short(e.to ?? e.holder ?? '')}</span><span className="small muted">{ago(e.timestamp, now)}</span></li>)}</ul>
          )}
        </section>
        <section className="panel" data-testid="top-holders">
          <h2 className="display">Ví giữ nhiều vé nhất</h2>
          {data.tickets.length === 0 ? <p className="muted">Chưa có ví nào giữ vé.</p> : (
            <table><thead><tr><th>Ví</th><th className="num">Vé</th><th className="num">Đã vào</th></tr></thead>
              <tbody>{holdersOf(data.tickets).slice(0, 5).map((h) => <tr key={h.owner}><td className="mono">{short(h.owner)}</td><td className="num">{h.tickets}</td><td className="num">{h.entered}</td></tr>)}</tbody></table>
          )}
        </section>
      </div>
    </div>
  );
}

const ago = (timestamp: number, now: number) => timeAgo(timestamp, now);
function describe(e: IndexedEvent) {
  if (e.name === 'CheckedIn') return `Vào cửa · Vé #${e.tokenId}`;
  if (e.from === zeroAddress) return e.paid ? `Mua vé #${e.tokenId}` : `Phát hành vé #${e.tokenId}`;
  return `Chuyển vé #${e.tokenId}`;
}

function Tickets({ data, events }: { data: DashboardSnapshot; events: IndexedEvent[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const list = filterTickets(data.tickets, query, status);
  const entries = new Map(events.filter((e) => e.name === 'CheckedIn').map((e) => [e.tokenId!, e]));

  function exportCsv() {
    // The BOM makes Excel read Vietnamese text correctly.
    const blob = new Blob(['﻿', ticketsCsv(list, events)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ve-${status}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const chips: { key: StatusFilter; label: string }[] = [{ key: 'all', label: 'Tất cả' }, { key: 'entered', label: 'Đã vào' }, { key: 'waiting', label: 'Chưa vào' }];
  return (
    <section className="panel">
      <div className="toolbar">
        <label className="grow field"><span className="sr">Tìm vé</span><input data-testid="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} placeholder="Số vé hoặc địa chỉ ví" /></label>
        <div role="group" aria-label="Lọc trạng thái" className="chips">{chips.map((c) => <button key={c.key} data-testid={`filter-${c.key}`} aria-pressed={status === c.key} className={status === c.key ? 'chip on' : 'chip'} onClick={() => { setStatus(c.key); setShown(PAGE); }}>{c.label}</button>)}</div>
        <button data-testid="export" className="btn" disabled={list.length === 0} onClick={exportCsv}>Xuất CSV ({list.length})</button>
      </div>
      {list.length === 0 ? <p data-testid="no-result" className="muted">{data.tickets.length ? 'Không có vé nào khớp.' : 'Chưa có vé nào được phát hành.'}</p> : (
        <table data-testid="ticket-table"><thead><tr><th>Vé</th><th>Ví đang giữ</th><th>Trạng thái</th><th>Giờ vào cửa</th><th>Ví soát vé</th></tr></thead>
          <tbody>{list.slice(0, shown).map((t) => {
            const entry = entries.get(t.tokenId);
            return <tr key={t.tokenId} data-testid={`row-${t.tokenId}`}><td><b>#{t.tokenId}</b></td><td className="mono">{t.owner}</td><td>{t.checkedIn ? <b>✓ Đã vào</b> : <span className="muted">Chưa vào</span>}</td><td className="small">{entry ? new Date(entry.timestamp * 1000).toLocaleString('vi-VN') : ''}</td><td className="mono small">{entry?.scanner ? short(entry.scanner) : ''}</td></tr>;
          })}</tbody></table>
      )}
      {list.length > shown ? <button data-testid="more" className="btn ghost" onClick={() => setShown(shown + PAGE)}>Xem thêm ({list.length - shown})</button> : null}
    </section>
  );
}

type TxState = { step: 'idle' } | { step: 'wallet' } | { step: 'pending'; hash: Hex } | { step: 'done'; hash: Hex; message: string } | { step: 'failed'; message: string; hash?: Hex };

function useTx(send: (a: AdminAction, onHash: (h: Hex) => void) => Promise<'success' | 'reverted'>, onDone: () => void) {
  const [tx, setTx] = useState<TxState>({ step: 'idle' });
  const run = async (action: AdminAction, success: string) => {
    setTx({ step: 'wallet' });
    let hash: Hex | undefined;
    try {
      const status = await send(action, (h) => { hash = h; setTx({ step: 'pending', hash: h }); });
      if (status === 'success') setTx({ step: 'done', hash: hash!, message: success });
      else setTx({ step: 'failed', hash, message: 'Giao dịch thất bại trên chain. Chưa có gì thay đổi.' });
      onDone();
    } catch (e) {
      setTx({ step: 'failed', hash, message: failureText(e) });
    }
  };
  return { tx, run, busy: tx.step === 'wallet' || tx.step === 'pending' };
}

function TxStatus({ tx }: { tx: TxState }) {
  if (tx.step === 'idle') return null;
  const hash = 'hash' in tx && tx.hash ? <span className="mono small">{short(tx.hash)}</span> : null;
  if (tx.step === 'wallet') return <p data-testid="tx-wallet" className="note">Xác nhận trong ví…</p>;
  if (tx.step === 'pending') return <p data-testid="tx-pending" className="note">Đã gửi, đang chờ mạng xác nhận. {hash}</p>;
  if (tx.step === 'done') return <p data-testid="tx-done" className="good" role="status">{tx.message} {hash}</p>;
  return <p data-testid="tx-failed" className="alert" role="alert">{tx.message} {hash}</p>;
}

const validAddress = (a: string) => isAddress(a) && a.toLowerCase() !== zeroAddress;

function Mint({ data, send, onDone }: { data: DashboardSnapshot; send: (a: AdminAction, h: (x: Hex) => void) => Promise<'success' | 'reverted'>; onDone: () => void }) {
  const [to, setTo] = useState('');
  const [quantity, setQuantity] = useState('1');
  const { tx, run, busy } = useTx(send, onDone);
  const q = Number(quantity);
  const qOk = Number.isSafeInteger(q) && q >= 1 && q <= data.unsold;
  const toOk = validAddress(to.trim());
  return (
    <section className="panel form">
      <p className="muted">Vé phát hành không thu tiền. Còn lại <b data-testid="mint-left">{data.unsold}</b> / {data.maxSupply} vé.</p>
      <label className="field"><span>Ví nhận</span><input data-testid="mint-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={!!to && !toOk} /></label>
      {to && !toOk ? <p data-testid="mint-to-error" className="field-error">Địa chỉ ví không hợp lệ.</p> : null}
      <label className="field"><span>Số lượng</span><input data-testid="mint-quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={!qOk} /></label>
      {!qOk ? <p data-testid="mint-quantity-error" className="field-error">{data.unsold === 0 ? 'Đã phát hành hết vé.' : `Nhập số nguyên từ 1 đến ${data.unsold}.`}</p> : null}
      <button data-testid="mint-submit" className="btn" disabled={!qOk || !toOk || busy} onClick={() => run({ fn: 'mint', to: to.trim() as Address, quantity: BigInt(q) }, `Đã phát hành ${q} vé.`)}>{busy ? 'Đang xử lý…' : 'Phát hành vé'}</button>
      <TxStatus tx={tx} />
    </section>
  );
}

function Scanners({ index, indexError, send, onDone }: { index: IndexState | null; indexError: boolean; send: (a: AdminAction, h: (x: Hex) => void) => Promise<'success' | 'reverted'>; onDone: () => void }) {
  const [address, setAddress] = useState('');
  const [active, setActive] = useState<Address[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const candidates = scannerCandidates(index?.events ?? []).join();
  const load = useCallback(async () => {
    const list = candidates ? (candidates.split(',') as Address[]) : [];
    try {
      const flags = await Promise.all(list.map(isScanner));
      setActive(list.filter((_, i) => flags[i]));
      setReadFailed(false);
    } catch { setReadFailed(true); }
  }, [candidates]);
  useEffect(() => { load(); }, [load]);
  const { tx, run, busy } = useTx(send, () => { onDone(); load(); });
  const ok = validAddress(address.trim());
  return (
    <div className="stack">
      <section className="panel form">
        <p className="muted">Ví được cấp quyền mới soát vé được, và cần có tiền trả phí mạng.</p>
        <label className="field"><span>Ví nhân viên</span><input data-testid="scanner-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={!!address && !ok} /></label>
        {address && !ok ? <p data-testid="scanner-error" className="field-error">Địa chỉ ví không hợp lệ.</p> : null}
        <button data-testid="scanner-add" className="btn" disabled={!ok || busy} onClick={() => run({ fn: 'setScanner', scanner: address.trim() as Address, allowed: true }, 'Đã cấp quyền soát vé.')}>{busy ? 'Đang xử lý…' : 'Cấp quyền'}</button>
        <TxStatus tx={tx} />
      </section>
      <section className="panel" data-testid="scanner-list">
        <h2 className="display">Đang có quyền</h2>
        <ScanNote index={index} error={indexError} />
        {readFailed ? <p className="alert" role="alert">Không đọc được quyền hiện tại. Thử lại sau.</p> : null}
        {active && active.length === 0 ? <p className="muted">Chưa có ví nào.</p> : null}
        {active && active.length > 0 ? <table><thead><tr><th>Ví</th><th /></tr></thead><tbody>{active.map((a) => <tr key={a} data-testid={`scanner-${a}`}><td className="mono">{a}</td><td className="num"><button data-testid={`revoke-${a}`} className="btn ghost danger" disabled={busy} onClick={() => run({ fn: 'setScanner', scanner: a, allowed: false }, `Đã thu hồi quyền của ${short(a)}.`)}>Thu hồi</button></td></tr>)}</tbody></table> : null}
      </section>
    </div>
  );
}

function RevenueView({ data, index, indexError, session, send, onDone }: { data: DashboardSnapshot; index: IndexState | null; indexError: boolean; session: Session; send: (a: AdminAction, h: (x: Hex) => void) => Promise<'success' | 'reverted'>; onDone: () => void }) {
  const [to, setTo] = useState<string>(session.address);
  const [confirming, setConfirming] = useState(false);
  const { tx, run, busy } = useTx(send, onDone);
  const balance = BigInt(data.balanceWei);
  const revenue = index ? revenueOf(index, BigInt(data.priceWei), balance) : null;
  const ok = validAddress(to.trim());
  return (
    <div className="stack">
      <section className="panel metrics wide">
        <Metric label="VÉ ĐÃ BÁN" value={revenue ? String(revenue.sold) : '…'} id="sold" />
        <Metric label="VÉ PHÁT MIỄN PHÍ" value={revenue ? String(revenue.free) : '…'} id="free" />
        <Metric label="TIỀN ĐÃ THU" value={revenue ? amount(revenue.collectedWei) : '…'} id="collected" />
        <Metric label="ĐÃ RÚT" value={revenue ? amount(revenue.withdrawnWei) : '…'} id="withdrawn" note="Tính từ tiền đã thu trừ số dư" />
        <Metric label="CHƯA RÚT" value={amount(balance)} id="available" />
      </section>
      <ScanNote index={index} error={indexError} />
      <section className="panel form">
        <h2 className="display">Rút tiền</h2>
        <p className="muted">Rút toàn bộ <b>{amount(balance)}</b> về ví nhận. Giao dịch không hoàn tác được.</p>
        <label className="field"><span>Ví nhận</span><input data-testid="withdraw-to" value={to} onChange={(e) => { setTo(e.target.value); setConfirming(false); }} spellCheck={false} aria-invalid={!ok} /></label>
        {!ok ? <p data-testid="withdraw-error" className="field-error">Địa chỉ ví không hợp lệ.</p> : null}
        {!confirming
          ? <button data-testid="withdraw" className="btn" disabled={!ok || busy || balance === 0n} onClick={() => setConfirming(true)}>{balance === 0n ? 'Không có tiền để rút' : busy ? 'Đang xử lý…' : 'Rút tiền'}</button>
          : <div className="confirm" data-testid="withdraw-confirm" role="group" aria-label="Xác nhận rút tiền">
              <p>Rút <b>{amount(balance)}</b> về <span className="mono">{to.trim()}</span>?</p>
              <div className="row"><button data-testid="withdraw-yes" className="btn" onClick={() => { setConfirming(false); run({ fn: 'withdraw', to: to.trim() as Address }, `Đã rút ${amount(balance)}.`); }}>Xác nhận rút</button><button data-testid="withdraw-no" className="btn ghost" onClick={() => setConfirming(false)}>Hủy</button></div>
            </div>}
        <TxStatus tx={tx} />
      </section>
    </div>
  );
}
