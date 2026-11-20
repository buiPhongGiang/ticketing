import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { eventWhen, formatUsdc } from '../format';
import { useLoad, useMounted } from '../hooks';
import type { Ticket, WaitlistState } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Mono, Screen, T } from '../ui';
import { statusBadge } from './EventsScreen';

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
    {failure ? <T testID="buy-error" style={{ fontFamily: font.medium }}>{failure}</T> : null}
    {canBuy
      ? <Btn testID="buy" label={`Buy · ${formatUsdc(total)} USDC`} onPress={() => run('buy', () => app.service.buy(eventId, tier, quantity))} busy={busy === 'buy'} disabled={!!busy && busy !== 'buy'} />
      : <Btn testID="buy" label={ev.status === 'cancelled' ? 'Cancelled' : ev.status === 'ended' ? 'Ended' : 'Sold out'} disabled />}
  </> : undefined;

  return (
    <Screen title="Event" back nav="events" footer={footer}>
      {error && !ev ? <T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T> : null}
      {!ev && !error ? <Center /> : null}
      {ev ? <>
        <View style={{ backgroundColor: color.ink, paddingHorizontal: 20, paddingVertical: 22, gap: 8 }}>
          {statusBadge(ev)}
          <Display size={48} style={{ color: color.white }} testID="event-name">{ev.name}</Display>
          <T style={{ color: color.darkMuted }}>{eventWhen(ev.startsAt, ev.endsAt)} · {ev.venue}</T>
          {ev.maxPerWallet ? <Mono style={{ color: color.darkMuted, fontSize: 11 }}>{`MAX ${ev.maxPerWallet} PER PERSON · RESALE CAP +10%`}</Mono> : null}
        </View>

        {ev.status === 'onsale' ? <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {ev.tiers.map((x, i) => {
              const on = i === tier;
              const soldOut = x.sold >= x.supply;
              return (
                <Pressable key={x.name} testID={`tier-${i}`} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: soldOut }} disabled={soldOut} onPress={() => { setTier(i); setQuantity(1); }}
                  style={{ flex: 1, padding: 14, gap: 2, backgroundColor: on ? color.blue : color.white, borderWidth: 2, borderColor: on ? color.blue : color.line, opacity: soldOut ? 0.5 : 1 }}>
                  <Mono style={{ color: on ? color.blueSub : color.muted, fontSize: 11, letterSpacing: 1 }}>{x.name.toUpperCase()}</Mono>
                  <Display size={30} style={{ color: on ? color.white : color.ink }}>{formatUsdc(x.price)}</Display>
                  <Mono style={{ color: on ? color.blueSub : color.muted, fontSize: 11 }}>{soldOut ? 'SOLD OUT' : `${x.supply - x.sold} LEFT`}</Mono>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T style={{ fontFamily: font.medium }}>Quantity</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Stepper label="−" name="Fewer" onPress={() => setQuantity(Math.max(1, quantity - 1))} />
              <Display size={28} testID="quantity" style={{ width: 44, textAlign: 'center' }}>{quantity}</Display>
              <Stepper label="+" name="More" testID="more" onPress={() => setQuantity(Math.min(left, ev.maxPerWallet || left, quantity + 1))} />
            </View>
          </View>
        </> : null}

        {ev.status === 'onsale' ? <Resale listings={listings} me={app.wallet.address} busy={busy} onBuy={(l) => run(`resale-${l.tokenId}`, () => app.service.buyListing(l.tokenId, l.listPrice))} /> : null}
        {ev.status === 'onsale' && t ? (
          <Waitlist tierName={t.name} state={waitlist?.[tier]} open={(listings ?? []).filter((l) => l.tier === tier).length} busy={busy}
            onJoin={() => run('wait', () => app.service.joinWaitlist(eventId, tier))} onLeave={() => run('wait', () => app.service.leaveWaitlist(eventId, tier))} />
        ) : null}
      </> : null}
    </Screen>
  );
}

function Resale({ listings, me, busy, onBuy }: { listings?: Ticket[]; me: string; busy: string | null; onBuy: (l: Ticket) => void }) {
  return (
    <View testID="resale" style={{ gap: 8, marginTop: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Display size={26}>Resale</Display>
        <Mono style={{ color: color.muted, fontSize: 11 }}>MAX FACE +10%</Mono>
      </View>
      {!listings ? <Center /> : null}
      {listings?.length === 0 ? <T testID="resale-empty" style={{ color: color.muted }}>No resale listings</T> : null}
      {listings?.length ? <Mono testID="resale-refund-note" style={{ color: color.muted, fontSize: 11 }}>IF CANCELLED, THE REFUND IS FACE VALUE</Mono> : null}
      {listings?.map((l) => {
        const mine = l.owner.toLowerCase() === me.toLowerCase();
        const markup = Number(((BigInt(l.listPrice) - BigInt(l.face)) * 1000n) / BigInt(l.face || '1')) / 10;
        return (
          <View key={l.tokenId} testID={`listing-${l.tokenId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: color.white, borderWidth: 1, borderColor: color.line }}>
            <Display size={30} style={{ width: 64 }}>#{l.tokenId}</Display>
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontFamily: font.semibold }}>{formatUsdc(l.listPrice)} USDC</T>
              <Mono style={{ color: color.muted, fontSize: 11 }}>{`${l.tierName.toUpperCase()} · FACE ${formatUsdc(l.face)} · ${markup >= 0 ? '+' : ''}${markup}%`}</Mono>
            </View>
            {mine ? <Mono style={{ color: color.muted }}>YOURS</Mono> : (
              <View style={{ width: 96 }}><Btn testID={`buy-listing-${l.tokenId}`} label="Buy" kind="dark" busy={busy === `resale-${l.tokenId}`} disabled={!!busy} onPress={() => onBuy(l)} /></View>
            )}
          </View>
        );
      })}
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
    <View testID="waitlist" style={{ gap: 8, padding: 12, backgroundColor: mine ? color.amber : color.white, borderWidth: 1, borderColor: mine ? color.amber : color.line }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Display size={22}>{mine ? `You are #${state.position} in line` : 'Waitlist'}</Display>
        <Mono testID="waiting-count" style={{ fontSize: 11 }}>{`${tierName.toUpperCase()} · ${state.waiting} WAITING`}</Mono>
      </View>
      {mine
        ? <><T testID="wait-position" style={{ fontFamily: font.medium }}>The next {tierName} ticket listed is yours. {formatUsdc(state.deposit)} USDC paid in.</T>
            <Btn testID="leave-waitlist" label="Leave and take the deposit back" kind="secondary" busy={busy === 'wait'} disabled={!!busy && busy !== 'wait'} onPress={onLeave} /></>
        : open > 0
          ? <T style={{ color: color.muted }}>A {tierName} ticket is on offer above.</T>
          : <><T style={{ color: color.muted }}>The next {tierName} ticket listed goes to the first in line.</T>
              <Btn testID="join-waitlist" label={`Join the line · ${formatUsdc(state.cap)} USDC`} kind="dark" busy={busy === 'wait'} disabled={!!busy && busy !== 'wait'} onPress={onJoin} /></>}
    </View>
  );
}

function Stepper({ label, name, onPress, testID }: { label: string; name: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={name} onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: color.white, borderWidth: 1, borderColor: color.ink }}>
      <T style={{ fontSize: 20 }}>{label}</T>
    </Pressable>
  );
}
