import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isAddress, type Address, type Hex } from 'viem';
import { addressUrl, safeCallState, sendBox, type BoxWrite, type Eip1193 } from './chain';
import type { SafeInfo } from './safe';
import { failureText } from './errors';
import { ago, eventDate, eventWhen, short, timeRange, usdc, usdcNumber } from './format';
import { entriesOf, refundsOf, type IndexState, type LogEntry } from './logs';
import type { Session } from './login';
import {
  capOf, chunk, countBy, eventStatus, feeOf, filterRows, organizes, projectYield, REFUND_BATCH, refundableIds, resaleStats, settleState, STATUS_LABEL, supplyOf, ticketRows, ticketsCsv, waitingOf, wallCells,
  type EventInfo, type StatusFilter, type TicketRow,
} from './model';
import type { EventsSnapshot } from './chain';
import { useChainNow, type ChainData } from './useData';
import { Badge, Confirm, Empty, Field, HashLink, Metric, Perforation, Skeleton, StaleBanner, TxLine, useTx, type TxState } from './ui';

export type Tab = 'overview' | 'tickets' | 'resale' | 'gate' | 'money';
export const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'resale', label: 'Resale' },
  { key: 'gate', label: 'Gate staff' },
  { key: 'money', label: 'Money' },
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
}

/** "Safe 2 of 3", linked to the Safe on the explorer. */
export function SafeTag({ safe }: { safe: SafeInfo }) {
  const url = addressUrl(safe.address);
  const text = `Safe ${safe.threshold} of ${safe.owners.length}`;
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
      <span>Goes through the verified Safe <b>{safe.address}</b></span>
      <span>{safe.threshold} of {safe.owners.length} owners must approve · {safe.owners.map(short).join(' · ')}</span>
    </div>
  );
}

function SafeLine({ safe, have }: { safe?: SafeInfo; have: number | null }) {
  if (!safe) return null;
  return <p className="safe-line mono small" data-testid="safe-line"><SafeTag safe={safe} />{have === null ? null : <span>{have} of {safe.threshold} approvals</span>}</p>;
}

export function EventConsole({ id, tab, session, provider, data }: { id: number; tab: Tab; session: Session; provider: Eip1193; data: ChainData }) {
  const now = useChainNow(data.snapshot, 1000);
  const e = data.snapshot?.events[id];
  const rows = useMemo(() => {
    if (!e || !data.detail || !data.index) return null;
    return ticketRows(data.detail.tickets, refundsOf(data.index, id), e.tiers);
  }, [e, data.detail, data.index, id]);

  if (!data.snapshot) {
    return <main className="page"><StaleBanner data={data} /><div className="panel"><Skeleton h={40} w="50%" /><Skeleton h={180} /></div></main>;
  }
  if (!e) return <main className="page"><Empty id="not-found">Event not found. <a href="#/">Back to events</a></Empty></main>;
  if (!organizes(e, session.address, data.snapshot.safes)) {
    // A contract organizer that is not a verified, configured Safe is never treated as one, whatever it answers.
    const unverified = data.snapshot.unverified.includes(e.organizer.toLowerCase());
    return (
      <main className="page">
        <Empty id={unverified ? 'unverified-organizer' : 'not-yours'}>
          {unverified ? 'The organizer of this event is an unverified contract. This console acts only for a wallet or a Safe it was configured with.' : 'This wallet is not the organizer of this event.'} <a href="#/">Back to events</a>
        </Empty>
      </main>
    );
  }
  const status = eventStatus(e, now);
  // A Safe organizer: every organizer action goes through it and needs its threshold of owners.
  const safe = e.organizer.toLowerCase() === session.address.toLowerCase() ? undefined : data.snapshot.safes[e.organizer.toLowerCase()];
  const ctx: Ctx = { e, rows, data, session, provider, now, safe };
  return (
    <div className="console">
      <nav className="side" aria-label="Event">
        <a className="back mono" href="#/" data-testid="back">← Events</a>
        <div className={`side-stub s-${status}`}>
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
        <div className="stub-top hero-top">
          <span className="eyebrow mono">{eventWhen(e.startsAt, e.endsAt)} · {e.venue}</span>
          <div className="hero-numbers">
            <span className="display hero"><b data-testid="checked-in">{e.checkedIn}</b><small>/{e.issued}</small></span>
            <span className="hero-label mono">Checked in / issued</span>
          </div>
        </div>
        <Perforation />
        <div className="stub-bottom hero-bottom mono small">
          <Badge status={status} />
          <span data-testid="quorum" title="Paid tickets scanned at the gate. From one half the show counts as having happened.">Gate quorum <b>{e.paidCheckedIn}</b> / {e.paidSold} paid{e.paidSold ? ` · ${e.quorumMet ? 'met' : 'needs half'}` : ''}</span>
          <span><b data-testid="issued">{e.issued}</b> / {supply} issued</span>
          <span>{e.tiers.map((t) => `${t.name} ${t.sold}/${t.supply}`).join(' · ')}</span>
        </div>
      </section>

      <section className="panel float-card" data-testid="float-card">
          <div className="panel-head"><h2 className="display">Float</h2><span className="tag mono">Escrow vault</span></div>
          <Metric big label="Principal" id="principal" value={usdc(e.principal)} />
          <div className="metric">
            <span className="label">Yield</span>
            <YieldTicker e={e} snapshot={data.snapshot} />
            <span className="sub">{e.cancelled ? 'Mock yield · frozen at cancel' : 'Mock yield · 5% APR'}</span>
          </div>
        </section>
      <section className="panel wall-panel">
        <div className="panel-head"><h2 className="display">Ticket wall</h2><span className="mono small muted">{supply} seats</span></div>
        {rows ? <Wall e={e} rows={rows} /> : <div className="wall">{Array.from({ length: Math.min(supply, 24) }, (_, i) => <span key={i} className="cell loading" />)}</div>}
      </section>

      <div className="ov-col">
      <section className="panel resale-card" data-testid="resale-card">
          <div className="panel-head"><h2 className="display">Resale</h2><span className="tag mono amber-tag">Cap +10%</span></div>
          <div className="metrics two">
            <Metric label="Resales" id="resales" value={stats.count} />
            <Metric label="Listed now" id="listed" value={stats.listed} sub={<span data-testid="in-line">{waitingOf(e)} in line</span>} />
            <Metric label="Volume" value={usdc(stats.volume)} />
            <Metric label="Avg vs face" id="avg-face" value={stats.avgPctOfFace === null ? '—' : `${stats.avgPctOfFace.toFixed(1)}%`} />
          </div>
        </section>


      <section className="panel activity" data-testid="activity">
        <div className="panel-head"><h2 className="display">Activity</h2>{data.index && !data.index.complete ? <span className="mono small muted" data-testid="syncing">Syncing…</span> : null}</div>
        {!activity ? <><Skeleton /><Skeleton /><Skeleton /></> : activity.length === 0 ? <Empty>No activity yet</Empty> : (
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
  const text = usdcNumber(v, 6);
  return <span className="value ticker" data-testid="yield"><span>{text.slice(0, -4)}</span><span className="dim">{text.slice(-4)}</span> USDC</span>;
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
          ? <button key={i} data-testid={`cell-${c.tokenId}`} className={`cell ${c.kind}${picked === c.tokenId ? ' picked' : ''}`} aria-label={`Ticket ${c.tokenId}, ${STATUS_LABEL[c.kind as keyof typeof STATUS_LABEL]}`} aria-pressed={picked === c.tokenId} onClick={() => setPicked(picked === c.tokenId ? null : c.tokenId!)}>{c.kind === 'checked' ? '✓' : c.tokenId}</button>
          : <span key={i} className={`cell ${c.kind}`} />)}
      </div>
      {hidden > 0 ? <button className="btn ghost sm" onClick={() => setLimit(limit + 480)}>+{hidden} more</button> : null}
      <div className="legend">
        <span><i className="cell mini valid" />Valid <b data-testid="n-valid">{counts.valid}</b></span>
        <span><i className="cell mini checked">✓</i>Checked in <b>{counts.checked}</b></span>
        <span><i className="cell mini listed" />Listed <b>{counts.listed}</b></span>
        <span><i className="cell mini refunded" />Refunded <b data-testid="n-refunded">{Math.max(counts.refunded, e.refunded)}</b></span>
        <span><i className="cell mini empty" />Unsold <b>{unsold}</b></span>
      </div>
      {sel ? (
        <div className="picked-row" data-testid="picked">
          <b>#{sel.tokenId}</b><span>{e.tiers[sel.tier]?.name}</span><span className="mono">{short(sel.owner)}</span><span>{STATUS_LABEL[sel.status]}</span>
          <span className="mono">{sel.paid > 0n ? usdc(sel.paid) : 'Comp'}</span>
        </div>
      ) : null}
    </>
  );
}

const KIND_TAG: Record<LogEntry['kind'], string> = {
  Purchased: 'Sale', Issued: 'Comp', Listed: 'Listed', Unlisted: 'Unlisted', Resold: 'Resale', CheckedIn: 'Entry', Refunded: 'Refund', Cancelled: 'Cancel', Settled: 'Settle', EventCreated: 'Created', ScannerSet: 'Gate',
  WaitlistJoined: 'In line', WaitlistLeft: 'Left line', Extended: 'Extended',
};

function describe(x: LogEntry, e: EventInfo, mintsRef: IndexState['mints']): string {
  const tier = x.tier !== undefined ? e.tiers[x.tier]?.name ?? `Tier ${x.tier}` : '';
  switch (x.kind) {
    case 'Purchased': return `${x.quantity} × ${tier} · ${usdc(x.amount ?? 0n)}`;
    case 'Issued': return `${x.quantity} × ${tier} → ${short(x.account!)}`;
    case 'Listed': return `#${x.tokenId} at ${usdc(x.amount ?? 0n)}`;
    case 'Unlisted': return `#${x.tokenId}`;
    case 'Resold': {
      const face = x.tokenId !== undefined ? e.tiers[mintsRef.get(x.tokenId)?.tier ?? -1]?.price : undefined;
      return `#${x.tokenId} · ${usdc(x.amount ?? 0n)}${face ? ` · ${(Number(((x.amount ?? 0n) * 1000n) / face) / 10).toFixed(1)}% of face` : ''}`;
    }
    case 'CheckedIn': return `#${x.tokenId} · ${short(x.account!)}`;
    case 'Refunded': return `#${x.tokenId} · ${usdc(x.amount ?? 0n)}`;
    case 'Cancelled': return 'Event cancelled';
    case 'Settled': return `${usdc(x.amount ?? 0n)} + ${usdc(x.yieldPaid ?? 0n)} yield${x.fee ? ` · fee ${usdc(x.fee)}` : ''}`;
    case 'ScannerSet': return `${x.allowed ? '+' : '−'} ${short(x.account!)}`;
    case 'WaitlistJoined': return `${short(x.account!)} · ${tier} · ${usdc(x.amount ?? 0n)} paid in`;
    case 'WaitlistLeft': return `${short(x.account!)} · ${tier}`;
    case 'Extended': return `New end ${eventDate(Number(x.amount ?? 0n))}`;
    default: return '';
  }
}

function FeedItem({ x, e, index, now }: { x: LogEntry; e: EventInfo; index: IndexState; now: number }) {
  return (
    <li>
      <span className={`kind k-${x.kind}`}>{KIND_TAG[x.kind]}</span>
      <span className="feed-text" title={x.account}>{describe(x, e, index.mints)}</span>
      <span className="mono small muted">{x.timestamp ? ago(x.timestamp, now) : ''}</span>
      <HashLink hash={x.hash} />
    </li>
  );
}

// ---------------------------------------------------------------- tickets

const PAGE = 50;
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'valid', label: 'Valid' }, { key: 'checked', label: 'Checked in' }, { key: 'listed', label: 'Listed' }, { key: 'refunded', label: 'Refunded' },
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
        <label className="search"><span className="sr">Search tickets</span><input data-testid="search" value={query} onChange={(ev) => { setQuery(ev.target.value); setShown(PAGE); }} placeholder="Search # or wallet" /></label>
        <div role="group" aria-label="Filter by status" className="chips">
          {FILTERS.map((f) => <button key={f.key} data-testid={`filter-${f.key}`} aria-pressed={status === f.key} className={status === f.key ? 'chip on' : 'chip'} onClick={() => { setStatus(f.key); setShown(PAGE); }}>{f.label}<span className="chip-n">{f.key === 'all' ? rows.length : counts[f.key]}</span></button>)}
        </div>
        <button data-testid="export" className="btn ghost" disabled={list.length === 0} onClick={exportCsv}>Export CSV</button>
      </div>
      {list.length === 0 ? <Empty id="no-result">{rows.length ? 'No tickets match' : 'No tickets yet'}</Empty> : (
        <div className="table-wrap">
          <table data-testid="ticket-table">
            <thead><tr><th>Ticket</th><th>Tier</th><th>Holder</th><th>Status</th><th className="num">Paid</th><th className="num">Face</th></tr></thead>
            <tbody>{list.slice(0, shown).map((r) => (
              <tr key={r.tokenId} data-testid={`row-${r.tokenId}`} className={r.status === 'refunded' ? 'struck' : ''}>
                <td className="mono"><b>#{r.tokenId}</b></td>
                <td>{e.tiers[r.tier]?.name}</td>
                <td className="mono" title={r.owner}>{short(r.owner)}</td>
                <td><span className={`pill p-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                <td className="num mono">{r.paid > 0n ? usdcNumber(r.paid) : 'Comp'}</td>
                <td className="num mono">{usdcNumber(r.face)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {list.length > shown ? <button className="btn ghost sm" onClick={() => setShown(shown + PAGE)}>+{list.length - shown} more</button> : null}
    </section>
  );
}

// ---------------------------------------------------------------- resale

function Resale({ e, data, now }: Ctx) {
  const stats = resaleStats(e);
  const listings = data.detail?.listings ?? null;
  const resales = data.index ? entriesOf(data.index, e.id, ['Resold']) : null;
  const faceOf = (tokenId: number) => {
    const tier = data.index?.mints.get(tokenId)?.tier;
    return tier === undefined ? null : e.tiers[tier]?.price ?? null;
  };
  return (
    <div className="stack">
      <section className="panel metrics five">
        <Metric label="Resales" value={stats.count} />
        <Metric label="Volume" value={usdc(stats.volume)} />
        <Metric label="Avg vs face" value={stats.avgPctOfFace === null ? '—' : `${stats.avgPctOfFace.toFixed(1)}%`} />
        <Metric label="Listed now" value={stats.listed} />
        <Metric label="In line" value={waitingOf(e)} sub="First in line gets the next listing" />
      </section>
      <section className="panel">
        <div className="panel-head"><h2 className="display">Listings</h2><span className="mono small muted">{listings?.length ?? ''}</span></div>
        {!listings ? <Skeleton h={60} /> : listings.length === 0 ? <Empty id="no-listings">No listings</Empty> : (
          <div className="table-wrap"><table data-testid="listings">
            <thead><tr><th>Ticket</th><th>Tier</th><th>Seller</th><th className="num">Price</th><th className="num">Face</th><th>vs cap</th></tr></thead>
            <tbody>{listings.map((t) => (
              <tr key={t.tokenId}><td className="mono"><b>#{t.tokenId}</b></td><td>{e.tiers[t.tier]?.name}</td><td className="mono">{short(t.owner)}</td>
                <td className="num mono">{usdcNumber(t.listPrice)}</td><td className="num mono">{usdcNumber(t.face)}</td><td><CapBar price={t.listPrice} face={t.face} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h2 className="display">Recent resales</h2></div>
        {!resales ? <Skeleton h={60} /> : resales.length === 0 ? <Empty id="no-resales">No resales yet</Empty> : (
          <div className="table-wrap"><table data-testid="resales">
            <thead><tr><th>Ticket</th><th>Seller → buyer</th><th className="num">Price</th><th>vs cap</th><th>When</th><th>Tx</th></tr></thead>
            <tbody>{resales.slice(0, 50).map((x) => {
              const face = faceOf(x.tokenId!);
              return (
                <tr key={x.id}><td className="mono"><b>#{x.tokenId}</b></td><td className="mono">{short(x.account!)} → {short(x.other!)}</td>
                  <td className="num mono">{usdcNumber(x.amount ?? 0n)}</td><td>{face ? <CapBar price={x.amount ?? 0n} face={face} /> : '—'}</td>
                  <td className="mono small muted">{x.timestamp ? ago(x.timestamp, now) : ''}</td><td><HashLink hash={x.hash} /></td></tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function CapBar({ price, face }: { price: bigint; face: bigint }) {
  const cap = capOf(face);
  const pct = face ? Number((price * 1000n) / face) / 10 : 0;
  const fill = cap ? Math.min(100, Number((price * 100n) / cap)) : 0;
  return <span className="capbar"><span className="capbar-track"><i style={{ width: `${fill}%` }} /></span><span className="mono small">{pct.toFixed(1)}%</span></span>;
}

// ---------------------------------------------------------------- gate staff

function Gate({ e, data, session, provider, now, safe }: Ctx) {
  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  const scanners = data.detail?.scanners ?? null;
  const valid = isAddress(address.trim());
  const closed = eventStatus(e, now) !== 'live';
  // Through a Safe nothing is sent before the owner has seen which Safe it goes to.
  const [asking, setAsking] = useState<{ wallet: Address; allowed: boolean } | null>(null);

  async function setScanner(a: Address, allowed: boolean) {
    const r = await tx.run({ fn: 'setScanner', args: [BigInt(e.id), a, allowed] }, allowed ? `Gate access granted · ${short(a)}` : `Access revoked · ${short(a)}`);
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
      <form className="panel" onSubmit={grant} noValidate>
        <div className="panel-head"><h2 className="display">Add gate staff</h2>{closed ? <span className="tag mono">Event closed</span> : null}</div>
        <div className="inline-form">
          <Field label="Wallet" error={touched && !valid ? 'Not a wallet address' : undefined}>
            <input data-testid="scanner-address" value={address} onChange={(ev) => setAddress(ev.target.value)} placeholder="0x…" aria-invalid={touched && !valid} spellCheck={false} />
          </Field>
          <button className="btn" data-testid="scanner-add" disabled={tx.busy}>Grant</button>
        </div>
        {asking ? (
          <Confirm id="scanner" yes={asking.allowed ? 'Grant' : 'Revoke'} onNo={() => setAsking(null)} onYes={() => { const q = asking; setAsking(null); void setScanner(q.wallet, q.allowed); }}>
            {asking.allowed ? 'Gate access for' : 'Revoke gate access of'} <span className="mono">{short(asking.wallet)}</span>
            <SafeNotice safe={safe} />
          </Confirm>
        ) : null}
        <TxLine state={tx.state} />
      </form>
      <section className="panel">
        <div className="panel-head"><h2 className="display">Staff</h2><span className="mono small muted">{scanners?.length ?? ''}</span></div>
        {!scanners ? <Skeleton h={44} /> : scanners.length === 0 ? <Empty id="no-scanners">No gate staff</Empty> : (
          <ul className="staff">{scanners.map((a) => (
            <li key={a} data-testid={`scanner-${a}`}>
              <span className="mono">{addressUrl(a) ? <a href={addressUrl(a)!} target="_blank" rel="noreferrer">{a}</a> : a}</span>
              <button className="btn ghost sm" data-testid={`revoke-${a}`} disabled={tx.busy} onClick={() => revoke(a)}>Revoke</button>
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- money

function Money(ctx: Ctx) {
  const { e, data, now } = ctx;
  const refunds = data.index ? refundsOf(data.index, e.id) : [];
  const refundedAmount = refunds.reduce((s, r) => s + r.amount, 0n);
  const status = eventStatus(e, now);
  // Lives here so the cancel result stays on screen when the panel turns into the refund panel.
  const cancelTx = useTx({ provider: ctx.provider, account: ctx.session.address, onDone: () => void data.refresh(), safe: ctx.safe });
  return (
    <div className="stack">
      <section className="panel metrics four" data-testid="money-metrics">
        <Metric label="Sales" id="sales" value={usdc(e.sales)} sub="Primary, face value" />
        <Metric label="Float" id="float" value={usdc(e.principal)} sub="In escrow vault" />
        <div className="metric"><span className="label">Yield</span><YieldTicker e={e} snapshot={data.snapshot} /><span className="sub">{e.cancelled ? 'Mock · frozen at cancel' : 'Mock · 5% APR'}</span></div>
        <Metric label="Refunded" id="refunded" value={usdc(refundedAmount)} sub={`${Math.max(e.refunded, refunds.length)} tickets`} />
      </section>
      <div className="actions">
        <IssuePanel {...ctx} disabled={status !== 'live'} />
        {status === 'cancelled' || status === 'noshow' ? <RefundPanel {...ctx} cancelState={cancelTx.state} noShow={status === 'noshow'} /> : <CancelPanel {...ctx} tx={cancelTx} disabled={status !== 'live'} />}
        <SettlePanel {...ctx} />
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
  const toErr = isAddress(to.trim()) ? undefined : 'Not a wallet address';
  const qtyErr = Number.isInteger(n) && n >= 1 && n <= Math.min(left, 100) ? undefined : left === 0 ? 'Tier sold out' : `1–${Math.min(left, 100)}`;

  return (
    <section className="panel action" data-testid="issue-panel">
      <div className="panel-head"><h2 className="display">Issue comps</h2><span className="tag mono">Free</span></div>
      <div className="form-row">
        <label className="field narrow"><span className="label">Tier</span>
          <select data-testid="issue-tier" value={tier} onChange={(ev) => setTier(Number(ev.target.value))} disabled={disabled}>
            {e.tiers.map((x, i) => <option key={i} value={i}>{x.name} · {x.supply - x.sold} left</option>)}
          </select>
        </label>
        <Field label="Qty" narrow error={touched ? qtyErr : undefined}><input data-testid="issue-qty" inputMode="numeric" value={qty} onChange={(ev) => setQty(ev.target.value)} disabled={disabled} aria-invalid={touched && !!qtyErr} /></Field>
      </div>
      <Field label="Wallet" error={touched ? toErr : undefined}><input data-testid="issue-to" value={to} onChange={(ev) => setTo(ev.target.value)} placeholder="0x…" spellCheck={false} disabled={disabled} aria-invalid={touched && !!toErr} /></Field>
      {asking ? (
        <Confirm id="issue" yes={`Issue ${n}`} onNo={() => setAsking(false)} onYes={async () => {
          setAsking(false);
          const r = await tx.run({ fn: 'issue', args: [BigInt(e.id), BigInt(tier), to.trim() as Address, BigInt(n)] }, `Issued ${n} × ${t.name}`);
          if (r) { setTo(''); setQty('1'); setTouched(false); }
        }}>
          <b>{n} × {t?.name}</b> → <span className="mono">{short(to.trim())}</span>
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn" data-testid="issue-submit" disabled={disabled || tx.busy} onClick={() => { setTouched(true); if (!toErr && !qtyErr) setAsking(true); }}>Issue</button>
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
      <div className="panel-head"><h2 className="display">Cancel event</h2></div>
      <div className="metrics two">
        <Metric label="Paid tickets" value={paid ?? '—'} />
        <Metric label="To refund" value={usdc(e.principal)} />
      </div>
      {asking ? (
        <Confirm id="cancel" danger yes="Cancel event" onNo={() => setAsking(false)} onYes={() => { setAsking(false); void tx.run({ fn: 'cancelEvent', args: [BigInt(e.id)] }, 'Event cancelled'); }}>
          Sales stop. Every paid ticket becomes refundable.
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn danger" data-testid="cancel" disabled={disabled || tx.busy} onClick={() => setAsking(true)}>Cancel event</button>
      )}
      <SafeLine safe={disabled ? undefined : safe} have={approvals} />
      <TxLine state={tx.state} />
    </section>
  );
}

function RefundPanel({ e, data, session, provider, cancelState, noShow }: Ctx & { cancelState: TxState; noShow: boolean }) {
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
        const note = batches.length > 1 ? `Batch ${i + 1}/${batches.length}` : `${batches[i].length} tickets`;
        setState({ stage: 'confirm', note });
        const r = await sendBox(provider, session.address, { fn: 'refundMany', args: [batches[i].map(BigInt)] }, (hash) => setState({ stage: 'pending', hash, note }));
        last = r.transactionHash;
        done += batches[i].length;
      }
      setState({ stage: 'done', hash: last, text: `Refunded ${done} tickets · ${usdc(owed)}` });
    } catch (err) {
      setState({ stage: 'failed', reason: done ? `${failureText(err)} ${done} refunded so far.` : failureText(err) });
    }
    void data.refresh();
  }

  return (
    <section className="panel action refund" data-testid="refund-panel">
      <div className="panel-head"><h2 className="display">Refund all holders</h2><span className="tag mono orange-tag">{noShow ? 'No-show' : 'Cancelled'}</span></div>
      <div className="metrics two">
        <Metric label="Tickets left" id="refund-count" value={ids ? ids.length : '—'} />
        <Metric label="Owed" id="refund-owed" value={ids ? usdc(owed) : '—'} />
      </div>
      {ids && ids.length === 0 && state.stage === 'idle' && cancelState.stage !== 'done' ? <p className="tx tx-done" data-testid="all-refunded"><b>✓</b>All holders refunded · {e.refunded} tickets</p> : null}
      {asking ? (
        <Confirm id="refund" yes={`Refund ${ids!.length}`} onNo={() => setAsking(false)} onYes={() => void refundAll()}>
          <b>{ids!.length} tickets</b> · {usdc(owed)} back to holders at face value
        </Confirm>
      ) : ids && ids.length === 0 ? null : (
        <button className="btn" data-testid="refund-all" disabled={!ids || busy} onClick={() => setAsking(true)}>Refund all</button>
      )}
      <TxLine state={state.stage === 'idle' ? cancelState : state} />
    </section>
  );
}

function SettlePanel({ e, data, session, provider, now, safe }: Ctx) {
  const [asking, setAsking] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh(), safe });
  // Proceeds go to the organizer: the Safe itself when a Safe organizes the event.
  const to = safe ? safe.address : session.address;
  const elapsed = data.snapshot ? now * 1000 - data.snapshot.blockTime * 1000 : 0;
  const s = settleState(e, now, projectYield(e.yieldAccrued, e.principal, elapsed, e.cancelled));
  const feeBps = data.snapshot?.feeBps ?? 0;
  const fee = s.kind === 'settle' ? feeOf(s.principal, feeBps) : 0n;
  const feeLabel = `Platform fee ${feeBps / 100}%`;
  const settled = data.index ? entriesOf(data.index, e.id, ['Settled']) : [];
  const paidOut = settled.reduce((acc, x) => ({ p: acc.p + (x.amount ?? 0n), y: acc.y + (x.yieldPaid ?? 0n), f: acc.f + (x.fee ?? 0n) }), { p: 0n, y: 0n, f: 0n });
  useEffect(() => { if (s.kind === 'wait' || s.kind === 'done') setAsking(false); }, [s.kind]);
  const label = s.kind === 'yield' ? 'Collect yield' : 'Settle';
  const open = s.kind === 'settle' || s.kind === 'yield';
  const approvals = useSafeApprovals(open ? safe : undefined, session.address, { fn: 'settle', args: [BigInt(e.id), to] }, data.snapshot?.readAt);

  return (
    <section className="panel action" data-testid="settle-panel">
      <div className="panel-head"><h2 className="display">Settle</h2><span className="mono small muted" title={to}>→ {safe ? 'Safe ' : ''}{short(to)}</span></div>
      {s.kind === 'settle' ? (
        <div className="metrics two"><Metric label="To you" id="settle-net" value={usdc(s.principal - fee)} sub={`${usdc(s.principal)} − ${feeLabel.toLowerCase()}`} /><Metric label="Yield" value={usdc(s.yield)} sub="Mock" /></div>
      ) : s.kind === 'yield' ? (
        <div className="metrics two"><Metric label="Principal" value={e.principal > 0n ? 'Held for refunds' : usdc(0n)} /><Metric label="Yield" value={usdc(s.yield)} sub="Mock" /></div>
      ) : s.kind === 'wait' ? (
        <div className="metrics two"><Metric label="Opens" id="settle-opens" value={eventDate(s.opensAt)} sub={s.dispute ? 'Gate quorum not met · 48 h hold' : undefined} /><Metric label="Float now" value={usdc(e.principal)} /></div>
      ) : (
        <div className="metrics two" data-testid="settled"><Metric label="Principal paid" id="settled-principal" value={usdc(paidOut.p)} sub={paidOut.f > 0n ? `${feeLabel} · ${usdc(paidOut.f)}` : undefined} /><Metric label="Yield paid" id="settled-yield" value={usdc(paidOut.y)} /></div>
      )}
      {asking && (s.kind === 'settle' || s.kind === 'yield') ? (
        <Confirm id="settle" yes={label} onNo={() => setAsking(false)} onYes={() => {
          setAsking(false);
          void tx.run({ fn: 'settle', args: [BigInt(e.id), to] }, (r) => {
            void r;
            return s.kind === 'settle' ? `Settled · ${usdc(s.principal - fee)} + ${usdc(s.yield)} yield` : `Yield collected · ${usdc(s.yield)}`;
          });
        }}>
          {s.kind === 'settle' ? <><b>{usdc(s.principal - fee + s.yield)}</b> → <span className="mono">{short(to)}</span>{fee > 0n ? <> · {feeLabel.toLowerCase()} {usdc(fee)}</> : null}</> : <><b>{usdc(s.yield)}</b> yield → <span className="mono">{short(to)}</span></>}
          <SafeNotice safe={safe} />
        </Confirm>
      ) : (
        <button className="btn" data-testid="settle" disabled={s.kind === 'wait' || s.kind === 'done' || tx.busy} onClick={() => setAsking(true)}>{s.kind === 'done' ? 'Settled' : label}</button>
      )}
      <SafeLine safe={open ? safe : undefined} have={approvals} />
      <TxLine state={tx.state} />
    </section>
  );
}
