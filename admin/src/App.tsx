import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createdEventId, login, logout, restoreSession, walletProvider, type Eip1193 } from './chain';
import { config } from './config';
import { failureText } from './errors';
import { EventConsole, TABS, type Tab } from './EventConsole';
import type { SafeInfo } from './safe';
import { eventWhen, parseUsdc, short, toLocalInput, usdc } from './format';
import { LoginError, type Session } from './login';
import { buildEventArgs, eventStatus, mine, supplyOf, type EventDraft, type EventInfo } from './model';
import { useChainData, useChainNow, type ChainData } from './useData';
import { Badge, Field, Perforation, Skeleton, StaleBanner, TxLine, useTx } from './ui';

// ---------------------------------------------------------------- routing

type Route = { page: 'home' } | { page: 'new' } | { page: 'event'; id: number; tab: Tab };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'new') return { page: 'new' };
  if (parts[0] === 'e' && /^\d+$/.test(parts[1] ?? '')) {
    const tab = TABS.find((t) => t.key === parts[2])?.key ?? 'overview';
    return { page: 'event', id: Number(parts[1]), tab };
  }
  return { page: 'home' };
}

function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => { setHash(window.location.hash); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}
export const go = (path: string) => { window.location.hash = path; };

// ---------------------------------------------------------------- app

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

  if (checking) return <main className="gate"><span className="spin big" aria-label="Loading" /></main>;
  if (!session || !provider) return <LoginScreen provider={provider} onLogin={setSession} />;
  return <Signed session={session} provider={provider} onSignOut={signOut} />;
}

function LoginScreen({ provider, onLogin }: { provider?: Eip1193; onLogin: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function connect() {
    setBusy(true); setProblem(null);
    try {
      onLogin(await login(provider!));
    } catch (e) {
      setProblem(e instanceof LoginError ? 'Signature not verified.' : failureText(e));
    } finally { setBusy(false); }
  }

  return (
    <main className="gate">
      <div className="stub login">
        <div className="stub-top">
          <span className="eyebrow mono">{config.network} · Organizer</span>
          <span className="display big-title">Vé Gốc</span>
          <span className="login-tags mono"><span>Resale cap +10%</span><span>Escrow float</span><span>Refund on cancel</span></span>
        </div>
        <Perforation />
        <div className="stub-bottom login-body">
          {provider
            ? <button data-testid="login" className="btn light" disabled={busy} onClick={connect}>{busy ? <><span className="spin dark" />Confirm in wallet</> : 'Sign in with wallet'}</button>
            : <p data-testid="no-wallet" className="no-wallet">No wallet found. <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">Install MetaMask</a></p>}
          {problem ? <p data-testid="login-error" className="alert" role="alert">{problem}</p> : null}
        </div>
      </div>
    </main>
  );
}

function Signed({ session, provider, onSignOut }: { session: Session; provider: Eip1193; onSignOut: () => void }) {
  const route = useRoute();
  const data = useChainData(route.page === 'event' ? route.id : null);
  return (
    <div className="app">
      <TopBar session={session} data={data} onSignOut={onSignOut} />
      {route.page === 'home' ? <Home session={session} data={data} /> : null}
      {route.page === 'new' ? <NewEvent session={session} provider={provider} data={data} /> : null}
      {route.page === 'event' ? <EventConsole key={route.id} id={route.id} tab={route.tab} session={session} provider={provider} data={data} /> : null}
    </div>
  );
}

function TopBar({ session, data, onSignOut }: { session: Session; data: ChainData; onSignOut: () => void }) {
  const state = data.error ? 'Offline' : data.snapshot ? 'Live' : 'Connecting';
  return (
    <header className="topbar">
      <a className="brand" href="#/"><span className="display">Vé Gốc</span><span className="brand-sub mono">Organizer</span></a>
      <div className="top-right">
        <span className={`net ${data.error ? 'off' : ''}`} data-testid="net" title={state}><span className="dot" />{config.network}<span className="net-state">· {state}</span></span>
        <span className="mono me" data-testid="me" title={session.address}>{short(session.address)}</span>
        <button data-testid="logout" className="btn ghost sm" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- home

function Home({ session, data }: { session: Session; data: ChainData }) {
  const now = useChainNow(data.snapshot, 15_000);
  const safes = data.snapshot?.safes ?? {};
  const events = data.snapshot ? mine(data.snapshot.events, session.address, safes).reverse() : null;
  return (
    <main className="page">
      <StaleBanner data={data} />
      <div className="page-head">
        <div>
          <span className="eyebrow mono">{events ? `${events.length} event${events.length === 1 ? '' : 's'}` : ' '}</span>
          <h1 className="display">Your events</h1>
        </div>
        <a className="btn amber" href="#/new" data-testid="new-event">+ New event</a>
      </div>
      {!events ? (
        <div className="posters">{[0, 1, 2].map((i) => <div key={i} className="poster ghost-card"><Skeleton h={28} w="70%" /><Skeleton h={14} w="45%" /><Skeleton h={8} /></div>)}</div>
      ) : events.length === 0 ? (
        <div className="empty-hero" data-testid="no-events">
          <span className="display">No events yet</span>
          <a className="btn amber" href="#/new">+ New event</a>
        </div>
      ) : (
        <div className="posters">{events.map((e) => <Poster key={e.id} e={e} now={now} href={`#/e/${e.id}`} safe={safes[e.organizer.toLowerCase()]} />)}</div>
      )}
    </main>
  );
}

function Poster({ e, now, href, safe }: { e: EventInfo; now: number; href?: string; safe?: SafeInfo }) {
  const status = eventStatus(e, now);
  const supply = supplyOf(e);
  const pct = supply ? Math.min(100, (e.issued / supply) * 100) : 0;
  const body = (
    <>
      <div className="poster-top">
        <div className="row between"><span className="mono poster-id">#{String(e.id).padStart(2, '0')}</span><Badge status={status} /></div>
        <h2 className="display poster-name">{e.name || 'Untitled'}</h2>
        <div className="poster-meta"><span className="mono">{eventWhen(e.startsAt, e.endsAt)}</span><span>{e.venue || '—'}</span></div>
      </div>
      <Perforation />
      <div className="poster-stub">
        <div className="meter" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
        <div className="row between mono small"><span data-testid="card-issued"><b>{e.issued}</b> / {supply} issued</span><span>{usdc(e.sales)}</span></div>
        {safe ? <span className="poster-safe mono small" data-testid={`card-safe-${e.id}`}>Organizer · Safe {safe.threshold} of {safe.owners.length}</span> : null}
      </div>
    </>
  );
  return href
    ? <a className={`poster s-${status}`} href={href} data-testid={`event-card-${e.id}`}>{body}</a>
    : <div className={`poster s-${status}`} data-testid="preview">{body}</div>;
}

// ---------------------------------------------------------------- new event

const defaultDraft = (): EventDraft => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(19, 0, 0, 0);
  return { name: '', venue: '', start: toLocalInput(d.getTime()), hours: '4', maxPerWallet: '4', tiers: [{ name: 'GA', price: '25', supply: '100' }] };
};

function NewEvent({ session, provider, data }: { session: Session; provider: Eip1193; data: ChainData }) {
  const [draft, setDraft] = useState<EventDraft>(defaultDraft);
  const [touched, setTouched] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh() });
  const { args, errors } = buildEventArgs(draft, Math.floor(Date.now() / 1000), parseUsdc);
  const show = (k: keyof typeof errors) => (touched ? (errors[k] as string | undefined) : undefined);
  const set = (patch: Partial<EventDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setTier = (i: number, patch: Partial<EventDraft['tiers'][number]>) => setDraft((d) => ({ ...d, tiers: d.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setTouched(true);
    if (!args) return;
    await tx.run(
      { fn: 'createEvent', args: [args.name, args.venue, args.startsAt, args.endsAt, args.maxPerWallet, args.tierNames, args.prices, args.supplies] },
      'Event created',
      (r) => { const id = createdEventId(r); if (id !== null) go(`/e/${id}`); },
    );
  }

  const preview: EventInfo = {
    id: data.snapshot?.events.length ?? 0, organizer: session.address, name: draft.name || 'Event name', venue: draft.venue || 'Venue',
    startsAt: args ? Number(args.startsAt) : Math.floor(new Date(draft.start).getTime() / 1000) || Math.floor(Date.now() / 1000), endsAt: args ? Number(args.endsAt) : (Math.floor(new Date(draft.start).getTime() / 1000) || Math.floor(Date.now() / 1000)) + 3600, maxPerWallet: 0,
    cancelled: false, settled: false, issued: 0, checkedIn: 0, refunded: 0, resales: 0, sales: 0n, resaleVolume: 0n, resaleFaceVolume: 0n,
    tiers: draft.tiers.map((t) => ({ name: t.name, price: parseUsdc(t.price) ?? 0n, supply: Number(t.supply) || 0, sold: 0 })), principal: 0n, yieldAccrued: 0n, listed: 0,
    settleAt: Number.MAX_SAFE_INTEGER, refundOpen: false, quorumMet: true, paidSold: 0, paidCheckedIn: 0, waiting: [],
  };

  return (
    <main className="page">
      <div className="page-head">
        <div><a className="back mono" href="#/">← Events</a><h1 className="display">New event</h1></div>
      </div>
      <div className="new-grid">
        <form className="panel form" onSubmit={submit} noValidate data-testid="new-form">
          <Field label="Name" error={show('name')}><input data-testid="f-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="Neon Pulse Festival" aria-invalid={!!show('name')} /></Field>
          <Field label="Venue" error={show('venue')}><input data-testid="f-venue" value={draft.venue} onChange={(e) => set({ venue: e.target.value })} maxLength={80} placeholder="Saigon Riverside" aria-invalid={!!show('venue')} /></Field>
          <div className="form-row">
            <Field label="Starts" error={show('start')}><input data-testid="f-start" type="datetime-local" value={draft.start} onChange={(e) => set({ start: e.target.value })} aria-invalid={!!show('start')} /></Field>
            <Field label="Hours" error={show('hours')} narrow><input data-testid="f-hours" inputMode="decimal" value={draft.hours} onChange={(e) => set({ hours: e.target.value })} aria-invalid={!!show('hours')} /></Field>
            <Field label="Max / wallet" error={show('maxPerWallet')} narrow><input data-testid="f-max" inputMode="numeric" value={draft.maxPerWallet} onChange={(e) => set({ maxPerWallet: e.target.value })} placeholder="0 = no limit" aria-invalid={!!show('maxPerWallet')} /></Field>
          </div>
          <fieldset className="tiers">
            <legend className="label">Tiers</legend>
            <div className="tier-head label" aria-hidden="true"><span>Name</span><span>Price USDC</span><span>Supply</span><span /></div>
            {draft.tiers.map((t, i) => {
              const err = touched ? errors.tierRows?.[i] : undefined;
              return (
                <div key={i} className="tier-row-wrap">
                  <div className="tier-row">
                    <input aria-label={`Tier ${i + 1} name`} data-testid={`tier-name-${i}`} placeholder="Name" value={t.name} maxLength={24} onChange={(e) => setTier(i, { name: e.target.value })} aria-invalid={!!err} />
                    <input aria-label={`Tier ${i + 1} price`} data-testid={`tier-price-${i}`} placeholder="Price" inputMode="decimal" value={t.price} onChange={(e) => setTier(i, { price: e.target.value })} aria-invalid={!!err} />
                    <input aria-label={`Tier ${i + 1} supply`} data-testid={`tier-supply-${i}`} placeholder="Supply" inputMode="numeric" value={t.supply} onChange={(e) => setTier(i, { supply: e.target.value })} aria-invalid={!!err} />
                    <button type="button" className="icon-btn" aria-label={`Remove tier ${i + 1}`} disabled={draft.tiers.length === 1} onClick={() => set({ tiers: draft.tiers.filter((_, j) => j !== i) })}>×</button>
                  </div>
                  {err ? <span className="field-error">{err}</span> : null}
                </div>
              );
            })}
            {draft.tiers.length < 4 ? <button type="button" className="btn ghost sm add-tier" data-testid="add-tier" onClick={() => set({ tiers: [...draft.tiers, { name: draft.tiers.length === 1 ? 'VIP' : `Tier ${draft.tiers.length + 1}`, price: '', supply: '' }] })}>+ Tier</button> : null}
          </fieldset>
          <div className="form-foot">
            <button className="btn" data-testid="create" disabled={tx.busy || (touched && !args)}>{tx.busy ? 'Creating…' : 'Create event'}</button>
            <TxLine state={tx.state} />
          </div>
        </form>
        <aside className="preview-col">
          <span className="label">Preview</span>
          <Poster e={preview} now={0} />
          <div className="panel preview-tiers">
            {preview.tiers.map((t, i) => <div key={i} className="row between"><span>{t.name || '—'}</span><span className="mono">{usdc(t.price)} · {t.supply}</span></div>)}
          </div>
        </aside>
      </div>
    </main>
  );
}
