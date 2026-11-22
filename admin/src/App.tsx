import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { zeroAddress } from 'viem';
import { createdEventId, login, logout, restoreSession, walletProvider, type Eip1193 } from './chain';
import { config } from './config';
import { failureText } from './errors';
import { EventConsole, TABS, type Tab } from './EventConsole';
import type { SafeInfo } from './safe';
import { eventWhen, parseVnd, short, toLocalInput, vnd } from './format';
import { LoginError, type Session } from './login';
import { buildEventArgs, eventStatus, mine, supplyOf, waitingOf, type EventDraft, type EventInfo } from './model';
import { useChainData, useChainNow, type ChainData } from './useData';
import { eventPhoto } from './art';
import { Badge, Field, Perforation, Skeleton, StaleBanner, TxLine, useTx, Icon } from './ui';

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

/** Stands in for a login while nobody is signed in: an address that organizes nothing and can sign nothing. */
const VISITOR: Session = { address: zeroAddress, message: '', signature: '0x', expiresAt: Number.MAX_SAFE_INTEGER };
const NO_WALLET: Eip1193 = { request: async () => { throw Object.assign(new Error('read-only'), { plain: true, shortMessage: 'Đang ở chế độ chỉ xem. Đăng nhập bằng ví ban tổ chức để thao tác.' }); } };

/**
 * Every page opens without a wallet: all of it is public chain data. A wallet is asked for only when someone signs in
 * to act, and without one the console stays read-only.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const provider = walletProvider();

  useEffect(() => {
    restoreSession(provider).then(setSession).finally(() => setChecking(false));
  }, [provider]);

  const signOut = useCallback(() => { logout(); setSession(null); }, []);
  const signIn = useCallback(async () => {
    if (!provider) return;
    setBusy(true); setProblem(null);
    try {
      setSession(await login(provider));
    } catch (e) {
      setProblem(e instanceof LoginError ? 'Chữ ký không khớp với ví. Chưa đăng nhập.' : failureText(e));
    } finally { setBusy(false); }
  }, [provider]);

  // Another account or network in the wallet means the login no longer describes who is here.
  useEffect(() => {
    if (!provider?.on || !session) return;
    provider.on('accountsChanged', signOut);
    provider.on('chainChanged', signOut);
    return () => { provider.removeListener?.('accountsChanged', signOut); provider.removeListener?.('chainChanged', signOut); };
  }, [provider, session, signOut]);

  if (checking) return <main className="gate"><span className="spin big" aria-label="Đang tải" /></main>;
  const signed = session && provider ? { session, provider } : null;
  return (
    <Shell
      session={signed?.session ?? VISITOR} provider={signed?.provider ?? NO_WALLET} readOnly={!signed}
      hasWallet={!!provider} busy={busy} problem={problem} onSignIn={signIn} onSignOut={signOut}
    />
  );
}

interface ShellProps {
  session: Session; provider: Eip1193; readOnly: boolean;
  hasWallet: boolean; busy: boolean; problem: string | null; onSignIn: () => void; onSignOut: () => void;
}

function Shell({ session, provider, readOnly, hasWallet, busy, problem, onSignIn, onSignOut }: ShellProps) {
  const route = useRoute();
  const data = useChainData(route.page === 'event' ? route.id : null);
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/"><span className="display">Vé Gốc</span><span className="brand-sub mono">Ban tổ chức</span></a>
        <div className="top-right">
          <Net data={data} />
          {!readOnly ? (
            <><span className="mono me" data-testid="me" title={session.address}>{short(session.address)}</span><button data-testid="logout" className="btn ghost sm" onClick={onSignOut}>Đăng xuất</button></>
          ) : (
            <>
              <span className="tag mono" data-testid="read-only" title="Số liệu đọc thẳng từ chuỗi. Muốn thao tác thì đăng nhập bằng ví ban tổ chức.">Chỉ xem</span>
              {hasWallet
                ? <button data-testid="login" className="btn ghost sm" disabled={busy} onClick={onSignIn}>{busy ? <><span className="spin" />Xác nhận trong ví</> : 'Đăng nhập'}</button>
                : <a data-testid="no-wallet" className="btn ghost sm" href="https://metamask.io/download/" target="_blank" rel="noreferrer" title="Xem thì không cần ví. Cần ví MetaMask khi muốn thao tác.">Cài MetaMask</a>}
            </>
          )}
        </div>
      </header>
      {problem ? <p data-testid="login-error" className="alert login-error" role="alert">{problem}</p> : null}
      {route.page === 'home' ? <Home session={session} data={data} readOnly={readOnly} /> : null}
      {route.page === 'new' ? <NewEvent session={session} provider={provider} data={data} readOnly={readOnly} /> : null}
      {route.page === 'event' ? <EventConsole key={route.id} id={route.id} tab={route.tab} session={session} provider={provider} data={data} readOnly={readOnly} /> : null}
    </div>
  );
}

function Net({ data }: { data: ChainData }) {
  const state = data.error ? 'Mất kết nối' : data.snapshot ? 'Trực tiếp' : 'Đang kết nối';
  return <span className={`net ${data.error ? 'off' : ''}`} data-testid="net" title={state}><span className="dot" />{config.network}<span className="net-state">· {state}</span></span>;
}

// ---------------------------------------------------------------- home

function Home({ session, data, readOnly }: { session: Session; data: ChainData; readOnly: boolean }) {
  const now = useChainNow(data.snapshot, 15_000);
  const safes = data.snapshot?.safes ?? {};
  // A visitor sees the configured organizers' events (anyone can create one on the contract), an organizer their own.
  const listed = (all: EventInfo[]) => (config.organizers.length ? all.filter((e) => config.organizers.some((o) => o.toLowerCase() === e.organizer.toLowerCase())) : all);
  const events = data.snapshot ? (readOnly ? listed(data.snapshot.events) : mine(data.snapshot.events, session.address, safes)).slice().reverse() : null;
  return (
    <main className="page">
      <StaleBanner data={data} />
      <div className="page-head">
        <div>
          <span className="eyebrow mono">{events ? `${events.length} sự kiện` : ' '}</span>
          <h1 className="display">{readOnly ? 'Sự kiện' : 'Sự kiện của bạn'}</h1>
        </div>
        <a className="btn amber" href="#/new" data-testid="new-event">+ Tạo sự kiện</a>
      </div>
      {readOnly ? <p className="readonly-note" data-testid="home-readonly">Đang ở chế độ chỉ xem: số bán, soát vé và quyết toán đọc thẳng từ chuỗi {config.network}, không cần ví. Đăng nhập bằng ví ban tổ chức khi muốn thao tác.</p> : null}
      {!events ? (
        <div className="posters">{[0, 1, 2].map((i) => <div key={i} className="poster ghost-card"><Skeleton h={28} w="70%" /><Skeleton h={14} w="45%" /><Skeleton h={8} /></div>)}</div>
      ) : events.length === 0 ? (
        <div className="empty-hero" data-testid="no-events">
          <span className="display">Chưa có sự kiện nào</span>
          <a className="btn amber" href="#/new">+ Tạo sự kiện</a>
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
  const waiting = waitingOf(e);
  const body = (
    <>
      <div className="poster-photo">
        <img src={eventPhoto(e.id)} alt="" loading="lazy" />
        <Badge status={status} />
      </div>
      <div className="poster-top">
        <span className="mono poster-id">#{String(e.id).padStart(2, '0')}</span>
        <h2 className="display poster-name">{e.name || 'Chưa đặt tên'}</h2>
        <div className="poster-meta"><span className="mono">{eventWhen(e.startsAt, e.endsAt)}</span><span>{e.venue || '—'}</span></div>
      </div>
      <Perforation />
      <div className="poster-stub">
        <div className="meter" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
        <div className="row between mono small"><span data-testid="card-issued"><b>{e.issued}</b> / {supply} vé đã phát hành</span><span>{vnd(e.sales)}</span></div>
        {href && (e.resales || e.listed || waiting) ? <span className="mono small" data-testid={`card-resale-${e.id}`}>Bán lại: {e.resales} lượt · đang rao {e.listed} · chờ mua {waiting}</span> : null}
        {safe ? <span className="poster-safe mono small" data-testid={`card-safe-${e.id}`}>Ban tổ chức là Safe {safe.threshold}/{safe.owners.length}</span> : null}
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
  return { name: '', venue: '', start: toLocalInput(d.getTime()), hours: '4', maxPerWallet: '4', tiers: [{ name: 'GA', price: '650000', supply: '100' }] };
};

function NewEvent({ session, provider, data, readOnly }: { session: Session; provider: Eip1193; data: ChainData; readOnly: boolean }) {
  const [draft, setDraft] = useState<EventDraft>(defaultDraft);
  const [touched, setTouched] = useState(false);
  const tx = useTx({ provider, account: session.address, onDone: () => void data.refresh() });
  const { args, errors } = buildEventArgs(draft, Math.floor(Date.now() / 1000), parseVnd);
  const show = (k: keyof typeof errors) => (touched ? (errors[k] as string | undefined) : undefined);
  const set = (patch: Partial<EventDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setTier = (i: number, patch: Partial<EventDraft['tiers'][number]>) => setDraft((d) => ({ ...d, tiers: d.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (readOnly) return;
    setTouched(true);
    if (!args) return;
    await tx.run(
      { fn: 'createEvent', args: [args.name, args.venue, args.startsAt, args.endsAt, args.maxPerWallet, args.tierNames, args.prices, args.supplies] },
      'Đã tạo sự kiện',
      (r) => { const id = createdEventId(r); if (id !== null) go(`/e/${id}`); },
    );
  }

  const startSec = Math.floor(new Date(draft.start).getTime() / 1000) || Math.floor(Date.now() / 1000);
  const preview: EventInfo = {
    id: data.snapshot?.events.length ?? 0, organizer: session.address, name: draft.name || 'Tên sự kiện', venue: draft.venue || 'Địa điểm',
    startsAt: args ? Number(args.startsAt) : startSec, endsAt: args ? Number(args.endsAt) : startSec + 3600, maxPerWallet: 0,
    cancelled: false, settled: false, issued: 0, checkedIn: 0, refunded: 0, resales: 0, sales: 0n, resaleVolume: 0n, resaleFaceVolume: 0n,
    tiers: draft.tiers.map((t) => ({ name: t.name, price: parseVnd(t.price) ?? 0n, supply: Number(t.supply) || 0, sold: 0 })), principal: 0n, yieldAccrued: 0n, listed: 0,
    settleAt: Number.MAX_SAFE_INTEGER, refundOpen: false, quorumMet: true, paidSold: 0, paidCheckedIn: 0, waiting: [],
  };

  return (
    <main className="page">
      <div className="page-head">
        <div><a className="back mono" href="#/"><Icon name="arrow-left" size={14} />Sự kiện</a><h1 className="display">Tạo sự kiện</h1></div>
      </div>
      <div className="new-grid">
        <form className="panel form" onSubmit={submit} noValidate data-testid="new-form">
          <Field label="Tên sự kiện" error={show('name')}><input data-testid="f-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="Đêm nhạc Indie Sài Gòn" aria-invalid={!!show('name')} /></Field>
          <Field label="Địa điểm" error={show('venue')}><input data-testid="f-venue" value={draft.venue} onChange={(e) => set({ venue: e.target.value })} maxLength={80} placeholder="Soul Live Project, TP.HCM" aria-invalid={!!show('venue')} /></Field>
          <div className="form-row">
            <Field label="Bắt đầu" error={show('start')}><input data-testid="f-start" type="datetime-local" value={draft.start} onChange={(e) => set({ start: e.target.value })} aria-invalid={!!show('start')} /></Field>
            <Field label="Kéo dài (giờ)" error={show('hours')} narrow><input data-testid="f-hours" inputMode="decimal" value={draft.hours} onChange={(e) => set({ hours: e.target.value })} aria-invalid={!!show('hours')} /></Field>
            <Field label="Tối đa mỗi ví" error={show('maxPerWallet')} narrow><input data-testid="f-max" inputMode="numeric" value={draft.maxPerWallet} onChange={(e) => set({ maxPerWallet: e.target.value })} placeholder="0 = không giới hạn" aria-invalid={!!show('maxPerWallet')} /></Field>
          </div>
          <p className="form-note">Vé bán từ lúc tạo đến giờ kết thúc. Giá bán lại bị chặn ở 110% giá gốc, hợp đồng tự áp dụng.</p>
          <fieldset className="tiers">
            <legend className="label">Hạng vé</legend>
            {draft.tiers.map((t, i) => {
              const err = touched ? errors.tierRows?.[i] : undefined;
              return (
                <div key={i} className="tier-row-wrap" data-testid={`tier-${i}`}>
                  <div className="tier-row">
                    <label className="field tier-name"><span className="label">Tên hạng</span>
                      <input data-testid={`tier-name-${i}`} placeholder="GA" value={t.name} maxLength={24} onChange={(e) => setTier(i, { name: e.target.value })} aria-invalid={!!err} />
                    </label>
                    <label className="field"><span className="label">Giá (đ)</span>
                      <input data-testid={`tier-price-${i}`} placeholder="650000" inputMode="decimal" value={t.price} onChange={(e) => setTier(i, { price: e.target.value })} aria-invalid={!!err} />
                    </label>
                    <label className="field"><span className="label">Số lượng</span>
                      <input data-testid={`tier-supply-${i}`} placeholder="100" inputMode="numeric" value={t.supply} onChange={(e) => setTier(i, { supply: e.target.value })} aria-invalid={!!err} />
                    </label>
                    <button type="button" className="icon-btn" aria-label={`Bỏ hạng vé ${i + 1}`} disabled={draft.tiers.length === 1} onClick={() => set({ tiers: draft.tiers.filter((_, j) => j !== i) })}><Icon name="x" size={18} /></button>
                  </div>
                  {err ? <span className="field-error">{err}</span> : null}
                </div>
              );
            })}
            {draft.tiers.length < 4 ? <button type="button" className="btn ghost sm add-tier" data-testid="add-tier" onClick={() => set({ tiers: [...draft.tiers, { name: draft.tiers.length === 1 ? 'VIP' : `Hạng ${draft.tiers.length + 1}`, price: '', supply: '' }] })}>+ Thêm hạng vé</button> : null}
          </fieldset>
          <div className="form-foot">
            <button className="btn" data-testid="create" disabled={readOnly || tx.busy || (touched && !args)}>{tx.busy ? 'Đang tạo…' : 'Tạo sự kiện'}</button>
            {readOnly ? <span className="readonly-note" data-testid="new-readonly">Đang ở chế độ chỉ xem. Đăng nhập bằng ví ban tổ chức để tạo sự kiện.</span> : null}
            <TxLine state={tx.state} />
          </div>
        </form>
        <aside className="preview-col">
          <span className="label">Xem trước</span>
          <Poster e={preview} now={0} />
          <div className="panel preview-tiers">
            {preview.tiers.map((t, i) => <div key={i} className="row between"><span>{t.name || '—'}</span><span className="mono">{vnd(t.price)} · {t.supply} vé</span></div>)}
          </div>
        </aside>
      </div>
    </main>
  );
}
