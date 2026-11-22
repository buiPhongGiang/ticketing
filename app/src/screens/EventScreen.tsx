import React, { useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { demoMode, payOn } from '../config';
import { eventWhen, formatVnd } from '../format';
import { useLoad, useMounted } from '../hooks';
import type { EventInfo, Ticket, WaitlistState } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { eventOutcome } from '../outcome';
import { color, font } from '../theme';
import { Comments, LikeButton, useSocialFeed } from '../social-ui';
import { Btn, Center, Display, Ic, Going, Icon, RoundBtn, Screen, T } from '../ui';
import { shareEvent, statusBadge } from './EventsScreen';

function Hero({ ev }: { ev: EventInfo }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ height: 300 + insets.top, backgroundColor: color.ink }}>
      <Image source={eventPhoto(ev.id)} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 170, backgroundColor: 'rgba(18,19,26,0.55)' }} />
      <View style={{ position: 'absolute', top: insets.top + 12, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
        <RoundBtn testID="back" label="Quay lại" onPress={app.back}><Icon name="back" size={24} /></RoundBtn>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <RoundBtn label={`Chia sẻ ${ev.name}`} onPress={() => shareEvent(ev)}><Ic name="share" size={20} /></RoundBtn>
          <RoundBtn testID="wallet-chip" label={demoMode ? 'Mở ví' : 'Mở tài khoản'} onPress={() => app.go({ name: 'wallet' })}><Ic name={demoMode ? 'wallet' : 'user'} size={22} /></RoundBtn>
        </View>
      </View>
      <View style={{ position: 'absolute', left: 20, right: 20, bottom: 18, gap: 8 }}>
        {statusBadge(ev)}
        <Display size={32} testID="event-name" style={{ color: color.white }}>{ev.name}</Display>
      </View>
    </View>
  );
}

export function EventScreen({ eventId }: { eventId: string }) {
  const app = useApp();
  const { data: ev, error, reload } = useLoad(() => app.service.getEvent(eventId), [eventId]);
  const { data: listings } = useLoad(() => app.service.getListings(eventId), [eventId]);
  const { data: waitlist } = useLoad(() => app.service.getWaitlist(eventId), [eventId]);
  const [tier, setTier] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  const social = useSocialFeed([eventId]);

  const t = ev?.tiers[tier];
  const left = t ? t.supply - t.sold : 0;
  const canBuy = !!ev && ev.status === 'onsale' && left > 0;
  useEffect(() => { if (left > 0 && quantity > left) setQuantity(left); }, [left, quantity]);

  async function run(key: string, action: () => Promise<{ id: string }>) {
    setBusy(key); setFailure(null);
    try {
      const entry = await action();
      if (mounted.current) app.go({ name: 'tx', entryId: entry.id });
    } catch (e) {
      if (!mounted.current) return;
      setFailure(messageFor(codeOf(e)));
      reload();
    } finally { if (mounted.current) setBusy(null); }
  }

  const total = t ? BigInt(t.price) * BigInt(quantity) : 0n;
  const footer = ev ? <>
    {failure ? <T testID="buy-error" style={{ fontFamily: font.semibold, color: color.orange }}>{failure}</T> : null}
    {canBuy
      ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{quantity} vé</T>
            <Display size={22} testID="total">{formatVnd(total)}</Display>
          </View>
          <View style={{ flex: 1 }}><Btn testID="buy" label={payOn ? 'Thanh toán' : 'Mua vé'} busy={busy === 'buy'} disabled={!!busy && busy !== 'buy'}
            onPress={() => (payOn
              ? app.go({ name: 'pay', order: { kind: 'buy', eventId, tier, quantity, units: total.toString(), title: `${quantity} × ${t!.name} · ${ev.name}` } })
              : run('buy', () => app.service.buy(eventId, tier, quantity)))} /></View>
        </View>
      : <Btn testID="buy" label={ev.status === 'cancelled' ? 'Đã hủy' : ev.status === 'ended' ? 'Đã kết thúc' : 'Hết vé'} disabled />}
  </> : undefined;

  if (!ev) {
    return (
      <Screen title="Sự kiện" back nav="events">
        {error ? <T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T> : <Center />}
      </Screen>
    );
  }
  return (
    <Screen title={ev.name} nav="events" footer={footer} header={<Hero ev={ev} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexShrink: 1 }}>
          {social.on ? <LikeButton eventId={eventId} state={social.of(eventId)} onChange={(s) => social.set(eventId, s)} /> : null}
          <Going count={ev.issued} />
        </View>
        {ev.maxPerWallet ? <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Tối đa {ev.maxPerWallet} vé/người</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip icon="calendar" label={eventWhen(ev.startsAt, ev.endsAt)} />
        <Chip icon="pin" label={ev.venue} />
      </View>

      <OutcomeCard ev={ev} onTickets={() => app.reset({ name: 'tickets' })} />

      {ev.status === 'onsale' ? <>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 10 }}>
          {ev.tiers.map((x, i) => {
            const on = i === tier;
            const soldOut = x.sold >= x.supply;
            return (
              <Pressable key={x.name} testID={`tier-${i}`} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: soldOut }} disabled={soldOut} onPress={() => { setTier(i); setQuantity(1); }}
                style={{ flex: 1, padding: 14, gap: 4, backgroundColor: on ? color.blue : color.paper, opacity: soldOut ? 0.5 : 1 }}>
                <T style={{ fontFamily: font.semibold, fontSize: 14, color: on ? color.blueSub : color.muted }}>{x.name}</T>
                <Display size={20} style={{ color: on ? color.white : color.ink }}>{formatVnd(x.price)}</Display>
                <T style={{ fontSize: 12, lineHeight: 16, color: on ? color.blueSub : color.muted }}>{soldOut ? 'Hết vé' : `Còn ${x.supply - x.sold} vé`}</T>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T style={{ fontFamily: font.semibold, fontSize: 16 }}>Số vé</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.paper, padding: 4 }}>
            <Stepper icon="minus" name="Bớt một vé" onPress={() => setQuantity(Math.max(1, quantity - 1))} />
            <Display size={20} testID="quantity" style={{ width: 40, textAlign: 'center' }}>{quantity}</Display>
            <Stepper icon="plus" name="Thêm một vé" testID="more" dark onPress={() => setQuantity(Math.min(left, ev.maxPerWallet || left, quantity + 1))} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: color.blueSub }}>
          <Ic name="shield" size={20} />
          <T style={{ flex: 1, fontFamily: font.semibold, fontSize: 14 }}>Hoàn đủ tiền nếu sự kiện bị hủy</T>
        </View>
      </> : null}

      {ev.status === 'onsale' ? <Resale listings={listings} me={app.wallet.address} busy={busy} onBuy={(l) => (payOn
        ? app.go({ name: 'pay', order: { kind: 'resale', tokenId: l.tokenId, eventId, units: l.listPrice, title: `Vé bán lại #${l.tokenId} · ${ev.name}` } })
        : run(`resale-${l.tokenId}`, () => app.service.buyListing(l.tokenId, l.listPrice)))} /> : null}
      {ev.status === 'onsale' && t ? (
        <Waitlist tierName={t.name} state={waitlist?.[tier]} open={(listings ?? []).filter((l) => l.tier === tier).length} busy={busy}
          onJoin={() => (payOn && waitlist?.[tier]
            ? app.go({ name: 'pay', order: { kind: 'wait', eventId, tier, units: waitlist[tier].cap, title: `Đặt cọc xếp hàng · ${t.name} · ${ev.name}` } })
            : run('wait', () => app.service.joinWaitlist(eventId, tier)))} onLeave={() => run('wait', () => app.service.leaveWaitlist(eventId, tier))} />
      ) : null}
      <Comments eventId={eventId} onCount={(n) => social.set(eventId, { ...social.of(eventId), comments: n })} />
    </Screen>
  );
}

/** What became of an event that is no longer on sale: cancelled, too few scanned, or happened, with the door count. */
function OutcomeCard({ ev, onTickets }: { ev: EventInfo; onTickets: () => void }) {
  const o = eventOutcome(ev);
  if (!o) return null;
  return (
    <View testID="outcome" style={{ gap: 10, padding: 14, backgroundColor: o.refundOpen ? color.amberSoft : color.paper }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ic name={o.kind === 'happened' ? 'check' : o.refundOpen ? 'shield' : 'calendar'} size={22} />
        <Display size={18} testID="outcome-title" style={{ flex: 1 }}>{o.title}</Display>
      </View>
      <T testID="outcome-body">{o.body}</T>
      {o.refundOpen ? <Btn testID="outcome-tickets" label="Xem vé của tôi" kind="dark" onPress={onTickets} /> : null}
    </View>
  );
}

function Chip({ icon, label }: { icon: 'calendar' | 'pin'; label: string }) {
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: color.paper }}>
      <Ic name={icon} size={18} />
      <T lines={1} style={{ flexShrink: 1, fontFamily: font.semibold, fontSize: 14 }}>{label}</T>
    </View>
  );
}

function Resale({ listings, me, busy, onBuy }: { listings?: Ticket[]; me: string; busy: string | null; onBuy: (l: Ticket) => void }) {
  if (listings && listings.length === 0) return <View testID="resale"><T testID="resale-empty" style={{ height: 0, opacity: 0 }}>Chưa có vé bán lại</T></View>;
  return (
    <View testID="resale" style={{ gap: 8, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Display size={20}>Vé bán lại</Display>
        <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Không quá giá gốc +10%</T>
      </View>
      {!listings ? <Center /> : null}
      {listings?.map((l) => {
        const mine = l.owner.toLowerCase() === me.toLowerCase();
        return (
          <View key={l.tokenId} testID={`listing-${l.tokenId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: color.paper }}>
            <Display size={20} style={{ width: 56 }}>#{l.tokenId}</Display>
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: font.bold }}>{formatVnd(l.listPrice)}</T>
              <T style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{l.tierName} · giá gốc {formatVnd(l.face)}</T>
            </View>
            {mine ? <T style={{ fontFamily: font.semibold, color: color.muted }}>Vé của bạn</T> : (
              <View style={{ width: 88 }}><Btn testID={`buy-listing-${l.tokenId}`} label="Mua" kind="dark" busy={busy === `resale-${l.tokenId}`} disabled={!!busy} onPress={() => onBuy(l)} /></View>
            )}
          </View>
        );
      })}
      {listings?.length ? <T testID="resale-refund-note" style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>Nếu sự kiện bị hủy, bạn được hoàn theo giá gốc.</T> : null}
    </View>
  );
}

/**
 * The line for resale tickets of the selected tier. A seller does not pick the buyer: the next ticket listed goes to
 * whoever is first here. While a listing is open there is nothing to wait for, so joining is offered only without one.
 */
function Waitlist({ tierName, state, open, busy, onJoin, onLeave }: { tierName: string; state?: WaitlistState; open: number; busy: string | null; onJoin: () => void; onLeave: () => void }) {
  if (!state) return null;
  const mine = state.position > 0;
  return (
    <View testID="waitlist" style={{ gap: 10, padding: 14, backgroundColor: mine ? color.amber : color.amberSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ic name={mine ? 'hourglass' : 'ticket'} size={22} />
        <View style={{ flex: 1 }}>
          <Display size={18}>{mine ? `Bạn đang xếp thứ ${state.position}` : `Hết vé ${tierName}? Xếp hàng chờ`}</Display>
          <T testID="waiting-count" style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{`${tierName} · ${state.waiting} người đang chờ`}</T>
        </View>
      </View>
      {mine
        ? <><T testID="wait-position" style={{ fontFamily: font.medium }}>Vé {tierName} bán lại kế tiếp là của bạn. Đã đặt cọc {formatVnd(state.deposit)}.</T>
            <Btn testID="leave-waitlist" label="Rời hàng, nhận lại cọc" kind="secondary" busy={busy === 'wait'} disabled={!!busy && busy !== 'wait'} onPress={onLeave} /></>
        : open > 0
          ? <T style={{ color: color.muted }}>Đang có vé {tierName} bán lại ở trên.</T>
          : <Btn testID="join-waitlist" label={`Xếp hàng · đặt cọc ${formatVnd(state.cap)}`} kind="dark" busy={busy === 'wait'} disabled={!!busy && busy !== 'wait'} onPress={onJoin} />}
    </View>
  );
}

function Stepper({ icon, name, onPress, testID, dark }: { icon: 'plus' | 'minus'; name: string; onPress: () => void; testID?: string; dark?: boolean }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={name} onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: dark ? color.ink : color.white }}>
      <Ic name={icon} size={20} tint={dark ? color.white : color.ink} />
    </Pressable>
  );
}
