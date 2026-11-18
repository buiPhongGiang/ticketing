import { useCallback, useEffect, useState } from 'react';
import { formatAmount, timeAgo } from '../../app/src/format';
import { type DashboardSnapshot } from './dashboard';
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
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

type View = 'overview' | 'tickets' | 'mint' | 'scanners' | 'revenue';
const VIEWS: { key: View; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'mint', label: 'Issue tickets' },
  { key: 'scanners', label: 'Gate staff' },
  { key: 'revenue', label: 'Revenue' },
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

  if (checking) return <main className="gate"><p className="muted">Checking sign-in…</p></main>;
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
      if (e instanceof LoginError && e.reason === 'NotOrganizer') setProblem('This wallet is not the event organizer.');
      else if (e instanceof LoginError) setProblem('Signature not verified.');
      else setProblem(failureText(e));
    } finally { setBusy(false); }
  }

  return (
    <main className="gate">
      <div className="stub login">
        <div className="stub-top"><span className="display big-title">Ticket admin</span><span>{eventInfo.name} · {eventInfo.when} · {eventInfo.venue}</span></div>
        <Perforation />
        <div className="stub-bottom login-body">
          {provider
            ? <button data-testid="login" className="btn light" disabled={busy} onClick={connect}>{busy ? 'Confirm in your wallet…' : 'Sign in with wallet'}</button>
            : <p data-testid="no-wallet">No wallet found. <a href="https://metamask.io/download/">Install MetaMask</a></p>}
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
      <nav className="side" aria-label="Admin">
        <div className="brand"><span className="display">Ticket admin</span><span className="muted small">{eventInfo.name}</span></div>
        <div className="navs">{VIEWS.map((v) => <button key={v.key} data-testid={`view-${v.key}`} aria-current={view === v.key ? 'page' : undefined} className={view === v.key ? 'nav on' : 'nav'} onClick={() => setView(v.key)}>{v.label}</button>)}</div>
        <div className="grow" />
        <div className="me">
          <span className="mono small" data-testid="me">{short(session.address)}</span>
          <button data-testid="logout" className="btn ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </nav>
      <main className="content">
        <header className="top">
          <h1 className="display">{VIEWS.find((v) => v.key === view)!.label}</h1>
          <div className="status">
            <span className={error ? 'dot off' : 'dot'} />
            <span className="mono small" data-testid="updated">{error ? 'Offline' : 'Live'}</span>
            <button data-testid="refresh" className="btn ghost" onClick={refresh}>Refresh</button>
          </div>
        </header>
        {error ? <p data-testid="stale" className="alert" role="alert">{data ? `Cannot reach the network. Last update ${clock(data.readAt)}.` : 'Cannot reach the network.'}</p> : null}
        {!data ? (error ? null : <p className="muted">Loading…</p>) : <>
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
    ? `Last ${done > 0n ? done : 0n} blocks only.`
    : `Syncing ${done > 0n ? done : 0n} / ${total} blocks`;
  return <p data-testid="scan-note" className="note">{text}{error ? ' · retrying' : ''}</p>;
}

function Overview({ data, events, index }: { data: DashboardSnapshot; events: IndexedEvent[]; index: IndexState | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState(200);
  const total = Number(data.maxSupply);
  const cells = Array.from({ length: Math.min(total, shown) }, (_, i) => data.tickets[i] ?? null);
  const selected = data.tickets.find((t) => t.tokenId === picked);
  const recent = [...events].filter((e) => e.name !== 'ScannerSet').reverse().slice(0, 6);
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="columns">
      <div className="stack">
        <div className="stub">
          <div className="stub-top row"><span className="display hero"><b data-testid="entered">{data.entered}</b><small>/{data.issued}</small></span><span>checked in</span></div>
          <Perforation />
          <div className="stub-bottom row between mono small"><span>{eventInfo.name}</span><span>{data.maxSupply} max</span></div>
        </div>
        <section className="panel">
          <h2 className="display">Ticket wall</h2>
          <div className="wall">
            {cells.map((t, i) => t
              ? <button key={i} data-testid={`cell-${t.tokenId}`} aria-label={`Ticket ${t.tokenId}, ${t.checkedIn ? 'checked in' : 'not yet'}`} aria-pressed={picked === t.tokenId} className={`cell ${t.checkedIn ? 'in' : 'wait'}${picked === t.tokenId ? ' picked' : ''}`} onClick={() => setPicked(t.tokenId)}>{t.checkedIn ? '✓' : t.tokenId}</button>
              : <span key={i} className="cell free" />)}
          </div>
          {total > shown ? <button data-testid="wall-more" className="btn ghost" onClick={() => setShown(shown + 200)}>Show more ({total - shown})</button> : null}
          <div className="legend">
            <span><i className="cell mini in">✓</i>Checked in <b>{data.entered}</b></span>
            <span><i className="cell mini wait" />Not yet <b data-testid="waiting">{data.waiting}</b></span>
            <span><i className="cell mini free" />Not issued <b data-testid="unsold">{data.unsold}</b></span>
          </div>
          {selected ? <p data-testid="picked" className="picked-row"><b>Ticket #{selected.tokenId}</b><span className="mono">{selected.owner}</span><span>{selected.checkedIn ? 'Checked in' : 'Not yet'}</span></p> : null}
        </section>
      </div>
      <div className="stack">
        <section className="panel metrics">
          <Metric label="HOLDERS" value={String(data.holders)} id="holders" />
          <Metric label="PRICE" value={data.priceWei === '0' ? 'Not for sale' : amount(data.priceWei)} />
          <Metric label="NOT WITHDRAWN" value={amount(data.balanceWei)} id="balance" />
        </section>
        <section className="panel" data-testid="activity">
          <h2 className="display">Activity</h2>
          <ScanNote index={index} />
          {recent.length === 0 ? <p className="muted">No activity yet.</p> : (
            <ul className="feed">{recent.map((e) => <li key={e.id}><span>{describe(e)}</span><span className="small muted">{ago(e.timestamp, now)}</span></li>)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}

const ago = (timestamp: number, now: number) => timeAgo(timestamp, now);
function describe(e: IndexedEvent) {
  if (e.name === 'CheckedIn') return `Check-in · Ticket #${e.tokenId}`;
  if (e.from === zeroAddress) return e.paid ? `Bought ticket #${e.tokenId}` : `Issued ticket #${e.tokenId}`;
  return `Transferred ticket #${e.tokenId}`;
}

function Tickets({ data, events }: { data: DashboardSnapshot; events: IndexedEvent[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const list = filterTickets(data.tickets, query, status);
  const entries = new Map(events.filter((e) => e.name === 'CheckedIn').map((e) => [e.tokenId!, e]));

  function exportCsv() {
    // The BOM makes Excel read UTF-8 text correctly.
    const blob = new Blob(['﻿', ticketsCsv(list, events)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tickets-${status}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const chips: { key: StatusFilter; label: string }[] = [{ key: 'all', label: 'All' }, { key: 'entered', label: 'Checked in' }, { key: 'waiting', label: 'Not yet' }];
  return (
    <section className="panel">
      <div className="toolbar">
        <label className="grow field"><span className="sr">Search tickets</span><input data-testid="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} placeholder="Search # or wallet" /></label>
        <div role="group" aria-label="Filter by status" className="chips">{chips.map((c) => <button key={c.key} data-testid={`filter-${c.key}`} aria-pressed={status === c.key} className={status === c.key ? 'chip on' : 'chip'} onClick={() => { setStatus(c.key); setShown(PAGE); }}>{c.label}</button>)}</div>
        <button data-testid="export" className="btn" disabled={list.length === 0} onClick={exportCsv}>Export CSV</button>
      </div>
      {list.length === 0 ? <p data-testid="no-result" className="muted">{data.tickets.length ? 'No tickets match.' : 'No tickets issued yet.'}</p> : (
        <table data-testid="ticket-table"><thead><tr><th>Ticket</th><th>Holder</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>{list.slice(0, shown).map((t) => {
            const entry = entries.get(t.tokenId);
            return <tr key={t.tokenId} data-testid={`row-${t.tokenId}`}><td><b>#{t.tokenId}</b></td><td className="mono" title={t.owner}>{short(t.owner)}</td><td>{t.checkedIn ? <b>✓ Checked in</b> : <span className="muted">Not yet</span>}</td><td className="small mono">{entry ? clock(entry.timestamp * 1000) : ''}</td></tr>;
          })}</tbody></table>
      )}
      {list.length > shown ? <button data-testid="more" className="btn ghost" onClick={() => setShown(shown + PAGE)}>Show more ({list.length - shown})</button> : null}
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
      else setTx({ step: 'failed', hash, message: 'Transaction failed.' });
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
  if (tx.step === 'wallet') return <p data-testid="tx-wallet" className="note">Confirm in your wallet…</p>;
  if (tx.step === 'pending') return <p data-testid="tx-pending" className="note">Confirming… {hash}</p>;
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
      <p className="muted"><b data-testid="mint-left">{data.unsold}</b> / {data.maxSupply} left</p>
      <label className="field"><span>Recipient wallet</span><input data-testid="mint-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={!!to && !toOk} /></label>
      {to && !toOk ? <p data-testid="mint-to-error" className="field-error">Invalid address</p> : null}
      <label className="field"><span>Quantity</span><input data-testid="mint-quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={!qOk} /></label>
      {!qOk ? <p data-testid="mint-quantity-error" className="field-error">{data.unsold === 0 ? 'None left' : `1 to ${data.unsold}`}</p> : null}
      <button data-testid="mint-submit" className="btn" disabled={!qOk || !toOk || busy} onClick={() => run({ fn: 'mint', to: to.trim() as Address, quantity: BigInt(q) }, `Issued ${q} ticket${q === 1 ? '' : 's'}.`)}>{busy ? 'Working…' : 'Issue tickets'}</button>
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
        <label className="field"><span>Staff wallet</span><input data-testid="scanner-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={!!address && !ok} /></label>
        {address && !ok ? <p data-testid="scanner-error" className="field-error">Invalid address</p> : null}
        <button data-testid="scanner-add" className="btn" disabled={!ok || busy} onClick={() => run({ fn: 'setScanner', scanner: address.trim() as Address, allowed: true }, 'Gate access granted.')}>{busy ? 'Working…' : 'Grant access'}</button>
        <TxStatus tx={tx} />
      </section>
      <section className="panel" data-testid="scanner-list">
        <h2 className="display">Has access</h2>
        <ScanNote index={index} error={indexError} />
        {readFailed ? <p className="alert" role="alert">Could not read access list.</p> : null}
        {active && active.length === 0 ? <p className="muted">No wallets yet.</p> : null}
        {active && active.length > 0 ? <table><thead><tr><th>Wallet</th><th /></tr></thead><tbody>{active.map((a) => <tr key={a} data-testid={`scanner-${a}`}><td className="mono">{a}</td><td className="num"><button data-testid={`revoke-${a}`} className="btn ghost danger" disabled={busy} onClick={() => run({ fn: 'setScanner', scanner: a, allowed: false }, `Access revoked for ${short(a)}.`)}>Revoke</button></td></tr>)}</tbody></table> : null}
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
        <Metric label="SOLD" value={revenue ? String(revenue.sold) : '…'} id="sold" />
        <Metric label="COLLECTED" value={revenue ? amount(revenue.collectedWei) : '…'} id="collected" />
        <Metric label="WITHDRAWN" value={revenue ? amount(revenue.withdrawnWei) : '…'} id="withdrawn" />
        <Metric label="AVAILABLE" value={amount(balance)} id="available" />
      </section>
      <ScanNote index={index} error={indexError} />
      <section className="panel form">
        <h2 className="display">Withdraw</h2>
        <label className="field"><span>Recipient wallet</span><input data-testid="withdraw-to" value={to} onChange={(e) => { setTo(e.target.value); setConfirming(false); }} spellCheck={false} aria-invalid={!ok} /></label>
        {!ok ? <p data-testid="withdraw-error" className="field-error">Invalid address</p> : null}
        {!confirming
          ? <button data-testid="withdraw" className="btn" disabled={!ok || busy || balance === 0n} onClick={() => setConfirming(true)}>{balance === 0n ? 'Nothing to withdraw' : busy ? 'Working…' : 'Withdraw'}</button>
          : <div className="confirm" data-testid="withdraw-confirm" role="group" aria-label="Confirm withdrawal">
              <p>Withdraw <b>{amount(balance)}</b> to <span className="mono">{to.trim()}</span>?</p>
              <div className="row"><button data-testid="withdraw-yes" className="btn" onClick={() => { setConfirming(false); run({ fn: 'withdraw', to: to.trim() as Address }, `Withdrew ${amount(balance)}.`); }}>Confirm withdrawal</button><button data-testid="withdraw-no" className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button></div>
            </div>}
        <TxStatus tx={tx} />
      </section>
    </div>
  );
}
