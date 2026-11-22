// Pieces shared by the ticket market screens: who someone is, what a price means against the cap, the line for
// resale tickets, sharing a link, and the watcher that turns chain changes into notifications.
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Share, TextInput, View } from 'react-native';
import { useApp } from './app-context';
import { config, payOn } from './config';
import { formatVnd } from './format';
import { useLoad, useMounted } from './hooks';
import { guestLabel } from './lib/exchange';
import { carry, diffSnapshots, loadNotices, merge, noticeKey, saveNotices, snapshotOf, type NoticeState } from './lib/notices';
import type { ErrorCode, EventInfo, Ticket, WaitlistState } from './lib/types';
import { linkUrl, type LinkTarget } from './links';
import { codeOf } from './messages';
import { setUnread } from './notice-store';
import { color, font } from './theme';
import { Btn, Display, Ic, T } from './ui';

/** Plain words for what can go wrong on these screens. Anything else: a short "try again". */
const vi: Partial<Record<ErrorCode, string>> = {
  Network: 'Mất kết nối. Thử lại sau ít phút',
  RateLimited: 'Bạn thao tác hơi nhanh. Chờ một phút rồi thử lại',
  NotListed: 'Vé này không còn rao bán',
  PriceChanged: 'Giá vừa đổi. Tải lại để xem giá mới',
  WaitlistFirst: 'Đang có người xếp hàng cho hạng vé này. Vé về người đứng đầu hàng',
  ListingsOpen: 'Đang có vé rao bán cho hạng này. Mua luôn, không cần xếp hàng',
  AlreadyWaiting: 'Bạn đã có chỗ trong hàng chờ này',
  NotWaiting: 'Bạn không còn trong hàng chờ này',
  OwnListing: 'Đây là vé bạn đang rao',
  EventEnded: 'Sự kiện đã kết thúc',
  EventCancelled: 'Sự kiện đã huỷ',
  InFlight: 'Thao tác trước chưa xong. Chờ một chút',
  InsufficientUsdc: 'Số dư không đủ',
  NotHolder: 'Vé này không thuộc về bạn',
  BadEvent: 'Không tìm thấy sự kiện',
  NonexistentToken: 'Không có vé này. Vé đã hoàn tiền thì không còn nữa',
  BadTier: 'Không tìm thấy hạng vé',
  SignatureExpired: 'Đồng hồ máy bạn lệch quá 5 phút. Chỉnh giờ rồi thử lại',
};
export const viMessage = (e: unknown) => vi[codeOf(e)] ?? 'Chưa làm được. Thử lại sau';

/** "5 phút trước", from unix seconds. */
export function agoVi(at: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, nowSec - at);
  if (s < 60) return 'Vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86_400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86_400)} ngày trước`;
}

const dayVi = (unix: number) => { const d = new Date((unix + 7 * 3600) * 1000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
/** Event time in Vietnam: "5/12 · 19:00", or "19/11 – 13/12" for a run of several days. */
export function whenVi(startsAt: number, endsAt: number): string {
  if (endsAt - startsAt > 86_400) return `${dayVi(startsAt)} – ${dayVi(endsAt)}`;
  const d = new Date((startsAt + 7 * 3600) * 1000);
  return `${dayVi(startsAt)} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** How an asking price sits against the original price: "Bằng giá gốc", "Giá gốc +4,5%", "Dưới giá gốc 10%". */
export function priceVsFace(price: string, face: string): string {
  const p = BigInt(price), f = BigInt(face);
  if (f === 0n || p === f) return 'Bằng giá gốc';
  const tenths = Number(((p > f ? p - f : f - p) * 1000n) / f);
  const pct = `${Math.floor(tenths / 10)}${tenths % 10 ? `,${tenths % 10}` : ''}%`;
  return p > f ? `Giá gốc +${pct}` : `Dưới giá gốc ${pct}`;
}

/** The proof on a listing: where the price sits, and the ceiling the ticket contract enforces for it. */
export function CapBadge({ price, face, cap, testID }: { price: string; face: string; cap: string; testID?: string }) {
  const within = BigInt(price) <= BigInt(cap);
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <View style={{ paddingHorizontal: 8, paddingVertical: 3, backgroundColor: within ? color.greenSub : color.orange }}>
        <T lines={1} style={{ fontFamily: font.bold, fontSize: 12, lineHeight: 16, color: within ? color.green : color.ink }}>{priceVsFace(price, face)}</T>
      </View>
      <T lines={1} style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>Trần {formatVnd(cap)}</T>
    </View>
  );
}

const tints = [color.amberSoft, color.blueSub, color.greenSub, '#FFE3D6'];
/** A coloured circle with the last two characters of the account id. Nobody picks a name or a picture here. */
export function Avatar({ account, size = 40 }: { account: string; size?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: tints[parseInt(account.slice(-2), 16) % tints.length] }}>
      <T style={{ fontFamily: font.bold, fontSize: size * 0.32, lineHeight: size * 0.5, color: color.ink }}>{account.slice(-2).toUpperCase()}</T>
    </View>
  );
}

/** Who holds or sells a ticket: "Khách 4BFA" from the end of the account id, or "Bạn" for this device. */
export function Person({ account, sub, onPress, size = 36 }: { account: string; sub?: string; onPress?: () => void; size?: number }) {
  const app = useApp();
  const me = account.toLowerCase() === app.wallet.address.toLowerCase();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Avatar account={account} size={size} />
      <View style={{ flexShrink: 1 }}>
        <T lines={1} style={{ fontFamily: font.bold, fontSize: 14, lineHeight: 20 }}>{me ? 'Bạn' : guestLabel(account)}</T>
        {sub ? <T lines={1} style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{sub}</T> : null}
      </View>
    </View>
  );
  if (!onPress) return body;
  return <Pressable testID="person" accessibilityRole="button" accessibilityLabel={`Xem trang của ${me ? 'bạn' : guestLabel(account)}`} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center', flexShrink: 1 }}>{body}</Pressable>;
}

/** A row of choices; one is on. */
export function Chips<V extends string | number | null>({ items, value, onChange, testID }: { items: { value: V; label: string }[]; value: V; onChange: (v: V) => void; testID?: string }) {
  return (
    <View testID={testID} accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((i) => {
        const on = i.value === value;
        return (
          <Pressable key={String(i.value)} testID={testID ? `${testID}-${i.value}` : undefined} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(i.value)}
            style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: on ? color.ink : color.paper }}>
            <T lines={1} style={{ fontFamily: font.semibold, fontSize: 14, color: on ? color.white : color.ink }}>{i.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Web: the phone's share sheet when the browser has one, else the link goes to the clipboard. App: the share sheet. */
export async function shareLink(target: LinkTarget, text: string): Promise<'shared' | 'copied' | 'none'> {
  const url = linkUrl(target);
  try {
    if (url && typeof navigator !== 'undefined' && typeof navigator.share === 'function') { await navigator.share({ title: 'Vé Gốc', text, url }); return 'shared'; }
    if (url) { await Clipboard.setStringAsync(url); return 'copied'; }
    await Share.share({ message: text });
    return 'shared';
  } catch { return 'none'; /* the sheet was closed */ }
}

export function ShareBtn({ target, text, testID }: { target: LinkTarget; text: string; testID?: string }) {
  const [copied, setCopied] = useState(false);
  const mounted = useMounted();
  return (
    <Pressable testID={testID ?? 'share'} accessibilityRole="button" accessibilityLabel="Chia sẻ liên kết" onPress={async () => {
      const r = await shareLink(target, text);
      if (r === 'copied' && mounted.current) { setCopied(true); setTimeout(() => { if (mounted.current) setCopied(false); }, 2500); }
    }} style={{ minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: copied ? color.greenSub : color.paper }}>
      <Ic name="share" size={18} />
      <T style={{ fontFamily: font.semibold, fontSize: 14 }}>{copied ? 'Đã chép liên kết' : 'Chia sẻ'}</T>
    </Pressable>
  );
}

/**
 * The line for resale tickets of one tier. The contract decides who gets a ticket: the next one listed goes to
 * whoever is first here, and the seller cannot pick. While a listing is open there is nothing to wait for.
 */
export function QueueBox({ event, tier, state, open, onChanged }: { event: Pick<EventInfo, 'id' | 'name' | 'tiers'>; tier: number; state?: WaitlistState; open: number; onChanged?: () => void }) {
  const app = useApp();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const t = event.tiers[tier];
  if (!state || !t) return null;
  const mine = state.position > 0;
  async function run(action: () => Promise<{ id: string }>) {
    setBusy(true); setFailure(null);
    try {
      const entry = await action();
      if (mounted.current) app.go({ name: 'tx', entryId: entry.id });
    } catch (e) {
      if (mounted.current) { setFailure(viMessage(e)); onChanged?.(); }
    } finally { if (mounted.current) setBusy(false); }
  }
  const join = () => (payOn
    ? app.go({ name: 'pay', order: { kind: 'wait', eventId: event.id, tier, units: state.cap, title: `Đặt cọc hàng chờ · ${t.name} · ${event.name}` } })
    : run(() => app.service.joinWaitlist(event.id, tier)));
  return (
    <View testID={`queue-${event.id}-${tier}`} style={{ gap: 10, padding: 14, backgroundColor: mine ? color.amber : color.amberSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ic name="hourglass" size={22} />
        <View style={{ flex: 1 }}>
          <Display size={18}>{mine ? `Bạn đứng thứ ${state.position} trong hàng` : `Hàng chờ ${t.name}`}</Display>
          <T testID={`queue-count-${event.id}-${tier}`} style={{ fontSize: 13, lineHeight: 18, color: color.ink }}>{state.waiting === 0 ? 'Chưa ai xếp hàng' : `${state.waiting} người đang chờ`}</T>
        </View>
      </View>
      <T style={{ fontSize: 13, lineHeight: 18 }}>Vé {t.name} kế tiếp được rao sẽ tự về người đứng đầu hàng. Người bán không chọn được người mua.</T>
      {mine
        ? <>
            <T testID="queue-deposit" style={{ fontFamily: font.medium, fontSize: 14 }}>Bạn đã đặt cọc {formatVnd(state.deposit)}. Vé rẻ hơn mức này thì phần dư trả lại bạn.</T>
            <Btn testID={`queue-leave-${event.id}-${tier}`} label="Rời hàng, nhận lại tiền cọc" kind="secondary" busy={busy} onPress={() => run(() => app.service.leaveWaitlist(event.id, tier))} />
          </>
        : open > 0
          ? <T style={{ fontFamily: font.medium, fontSize: 14 }}>Đang có vé {t.name} rao bán. Mua luôn, không cần xếp hàng.</T>
          : <Btn testID={`queue-join-${event.id}-${tier}`} label={`Xếp hàng mua · cọc ${formatVnd(state.cap)}`} kind="dark" busy={busy} onPress={join} />}
      {failure ? <T testID="queue-error" style={{ fontFamily: font.semibold, color: color.ink }}>{failure}</T> : null}
    </View>
  );
}

/**
 * On a holder's ticket: how many people are in line for a ticket of this tier, read from the contract, and the way
 * to offer the ticket at or under the cap. With someone in line it sells in the same step.
 */
export function QueueForTicket({ ticket }: { ticket: Ticket }) {
  const app = useApp();
  const can = ticket.status === 'available' && ticket.paid !== '0' && ticket.event.status === 'onsale';
  const { data: lines } = useLoad(() => (can ? app.service.getWaitlist(ticket.eventId) : Promise.resolve(undefined)), [ticket.eventId, can]);
  const line = lines?.[ticket.tier];
  if (!can || !line || line.waiting === 0) return null;
  // The contract refuses a listing from someone standing in that same line.
  if (line.position > 0) {
    return (
      <View testID="ticket-queue-self" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, backgroundColor: color.paper }}>
        <Ic name="hourglass" size={18} />
        <T style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>Bạn đang xếp hàng mua thêm vé hạng {ticket.tierName}. Muốn bán lại vé này thì rời hàng trước.</T>
      </View>
    );
  }
  const waiting = line.waiting;
  return (
    <View testID="ticket-queue" style={{ gap: 10, padding: 14, backgroundColor: color.amberSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ic name="hourglass" size={22} />
        <Display size={18} style={{ flex: 1 }}>{waiting} người đang chờ vé hạng {ticket.tierName}</Display>
      </View>
      <T style={{ fontSize: 13, lineHeight: 18 }}>Không đi được? Rao bán là vé về ngay người đứng đầu hàng, bạn nhận tiền trong cùng lúc đó. Giá tối đa {formatVnd(ticket.cap)}.</T>
      <Btn testID="ticket-queue-resell" label="Đăng bán lại" kind="dark" onPress={() => app.go({ name: 'resell', tokenId: ticket.tokenId })} />
    </View>
  );
}

/** The lines this device stands in, read from the contract for the events on sale (a handful of calls). */
export async function myQueues(service: ReturnType<typeof useApp>['service']): Promise<{ eventId: string; states: WaitlistState[] }[]> {
  const events = (await service.getEvents()).filter((e) => e.status === 'onsale').slice(0, 8);
  return Promise.all(events.map(async (e) => ({ eventId: e.id, states: (await service.getWaitlist(e.id)).filter((s) => s.position > 0) })));
}

/** A text box with a counter and a save button, for the seller's note. */
export function Composer({ value, onChange, max, placeholder, label, busy, failure, onSend, testID, allowEmpty }: {
  value: string; onChange: (v: string) => void; max: number; placeholder: string; label: string; busy: boolean; failure: string | null; onSend: () => void; testID: string; allowEmpty?: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <TextInput testID={`${testID}-input`} accessibilityLabel={placeholder} value={value} onChangeText={(v) => onChange(v.slice(0, max))} placeholder={placeholder} placeholderTextColor={color.muted} multiline maxLength={max}
        style={{ minHeight: 52, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 12, fontFamily: font.body, fontSize: 15, lineHeight: 22, color: color.ink, backgroundColor: color.paper }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <T testID={failure ? `${testID}-error` : undefined} style={{ flex: 1, fontSize: 12, lineHeight: 16, color: failure ? color.orange : color.muted }}>{failure ?? `${value.length}/${max}`}</T>
        <View style={{ width: 112 }}><Btn testID={`${testID}-send`} label={label} kind="dark" busy={busy} disabled={!allowEmpty && !value.trim()} onPress={onSend} /></View>
      </View>
    </View>
  );
}

const WATCH_MS = 60_000;
const ANNOUNCE_MS = 10 * 60_000;

/**
 * Looks at this device's tickets and places in line once a minute (and after each of its own transactions), and
 * turns what changed since the last look into notifications. Also tells the market when a listing made on this
 * device went up, so it can show its age. Draws nothing.
 */
export function NoticeWatcher() {
  const app = useApp();
  const running = useRef(false);
  const look = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const key = noticeKey(config.chainId, config.contract, app.wallet.address);
    try {
      const [tickets, queues, stored] = await Promise.all([app.service.listTickets(), myQueues(app.service), loadNotices(app.store, key)]);
      const snapshot = snapshotOf(tickets, queues);
      let state: NoticeState = stored.snapshot ? merge(stored, diffSnapshots(stored.snapshot, snapshot, Date.now())) : stored;
      state = { ...state, snapshot: stored.snapshot ? carry(stored.snapshot, snapshot) : carry(snapshot, snapshot) };
      if (app.exchange) {
        // A listing made on this device in the last ten minutes: post its (empty) note once, which gives it a time.
        const fresh = tickets.filter((t) => t.status === 'listed' && t.tx?.kind === 'list' && t.tx.state === 'succeeded' && Date.now() - t.tx.createdAt < ANNOUNCE_MS);
        if (fresh.length) {
          const doneKey = `${key}:announced`;
          const done: string[] = JSON.parse((await app.store.getItem(doneKey)) ?? '[]');
          for (const t of fresh.filter((x) => !done.includes(`${x.tokenId}:${x.listPrice}`))) {
            try {
              const has = (await app.exchange.notes([t.tokenId]))[t.tokenId];
              if (!has || has.price !== t.listPrice || has.author.toLowerCase() !== app.wallet.address.toLowerCase()) await app.exchange.setNote(t.tokenId, t.listPrice, '');
              done.push(`${t.tokenId}:${t.listPrice}`);
            } catch { /* tried again at the next look, while the listing is still fresh */ }
          }
          await app.store.setItem(doneKey, JSON.stringify(done.slice(-50)));
        }
      }
      await saveNotices(app.store, key, state);
      setUnread(state.items.filter((i) => !i.read).length);
    } catch { /* no network: the next look catches up, nothing is lost */ } finally { running.current = false; }
  }, [app.service, app.exchange, app.store, app.wallet.address]);

  useEffect(() => {
    look();
    const timer = setInterval(look, WATCH_MS);
    const off = app.service.subscribe((e) => { if (e.state === 'succeeded') look(); });
    return () => { clearInterval(timer); off(); };
  }, [look, app.service, app.refreshKey]);
  return null;
}
