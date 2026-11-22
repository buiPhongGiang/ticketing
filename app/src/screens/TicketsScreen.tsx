import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp, type Notice } from '../app-context';
import { eventPhoto } from '../art';
import { config, demoMode, hasFaucet, payOn } from '../config';
import { eventWhen, formatFee, formatSeconds, formatVnd } from '../format';
import { useLoad, useMounted } from '../hooks';
import type { Ticket, WaitlistState } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Mono, Screen, T, TicketCard, type CardTone } from '../ui';

export function cardProps(t: Ticket): { status: string; tone: CardTone; holder?: string } {
  if (t.event.status === 'ended' && (t.status === 'available' || t.status === 'listed')) return { status: 'Sự kiện đã kết thúc', tone: 'gone' };
  switch (t.status) {
    case 'listed': return { status: `Đang rao bán · ${formatVnd(t.listPrice)}`, tone: 'listed' };
    case 'used': return { status: 'Đã vào cửa', tone: 'used' };
    case 'refundable': return { status: t.paid === '0' ? (t.event.cancelled ? 'Sự kiện bị hủy' : 'Sự kiện đã kết thúc') : `Hoàn ${formatVnd(t.paid)}`, tone: 'gone' };
    case 'sold': return { status: 'Đã bán lại', tone: 'void', holder: demoMode ? t.owner : undefined };
    case 'pending': return { status: 'Đang xác nhận…', tone: 'gone' };
    case 'unresolved': return { status: 'Chưa rõ kết quả', tone: 'gone' };
    default: return { status: 'Vé của bạn', tone: 'live' };
  }
}

/**
 * What the chain took, in time and money, for the demo build: "Confirmed in 2.4 s · fee 0.035 nAVAX". Guests outside
 * the demo see how fast it went and never a network fee.
 */
export const receiptLine = (feeWei: string, confirmedMs?: number, blockMs?: number, relayed?: boolean) => [
  // The block time is for the demo build; a guest reads one plain duration.
  demoMode && blockMs !== undefined ? `Vào khối +${formatSeconds(blockMs)}` : null,
  confirmedMs !== undefined ? `${demoMode && blockMs !== undefined ? 'xác nhận +' : 'Xác nhận sau '}${formatSeconds(confirmedMs)}` : null,
  relayed ? 'không mất phí' : demoMode ? `phí ${formatFee(feeWei, config.nativeSymbol)}` : null,
].filter(Boolean).join(' · ');

export const ticketCard = (t: Ticket, props: { compact?: boolean; testID?: string } = {}) => (
  <TicketCard tokenId={t.tokenId} eventName={t.event.name} when={`${eventWhen(t.event.startsAt, t.event.endsAt)} · ${t.event.venue}`} tierName={t.tierName} photo={eventPhoto(t.event.id)} {...cardProps(t)} {...props} />
);

export function TicketsScreen({ notice }: { notice?: Notice }) {
  const app = useApp();
  const { data: tickets, error, loading, reload } = useLoad(() => app.service.listTickets(), []);
  const { data: balances } = useLoad(() => app.service.getBalances(app.wallet.address), [app.wallet.address]);
  const { data: credit } = useLoad(() => app.service.getCredit(), [app.wallet.address]);
  // The lines this account stands in: a deposit is paid there, so it belongs next to the tickets.
  const { data: lines } = useLoad(async () => {
    const out: { eventId: string; eventName: string; tierName: string; state: WaitlistState }[] = [];
    for (const e of (await app.service.getEvents()).filter((x) => x.status === 'onsale')) {
      for (const s of await app.service.getWaitlist(e.id)) if (s.position > 0) out.push({ eventId: e.id, eventName: e.name, tierName: e.tiers[s.tier]?.name ?? '', state: s });
    }
    return out;
  }, [app.wallet.address]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();

  async function faucet() {
    setBusy(true); setFailure(null);
    try {
      const e = await app.service.faucet();
      if (mounted.current) app.go({ name: 'tx', entryId: e.id });
    } catch (e) {
      if (mounted.current) setFailure(messageFor(codeOf(e)));
    } finally { if (mounted.current) setBusy(false); }
  }

  const going = notice?.kind === 'bought' || notice?.kind === 'resale';
  return (
    <Screen title="Vé của tôi" nav="tickets" footer={<Btn testID="refresh" label="Tải lại" kind="secondary" onPress={reload} busy={loading} />}>
      {notice ? (
        <View testID="notice" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: going ? color.amberSoft : color.greenSub }}>
          <Ic name={going ? 'ticket' : 'check'} size={22} />
          <View style={{ flex: 1, gap: 2 }}>
            <T testID={notice.kind === 'bought' ? 'bought' : undefined} style={{ fontFamily: font.bold }}>{going ? `Bạn có vé rồi! ${notice.text}` : notice.text}</T>
            {notice.feeWei ? <Mono testID="fee" style={{ color: color.muted }}>{receiptLine(notice.feeWei, notice.confirmedMs, notice.blockMs, notice.relayed)}</Mono> : null}
          </View>
        </View>
      ) : null}
      {payOn ? null : <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 12, backgroundColor: color.paper }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Ic name="money" size={22} />
          <View>
            <T style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>Số dư</T>
            <Display size={20} testID="usdc-balance">{balances ? formatVnd(balances.usdc) : '…'}</Display>
          </View>
        </View>
        {hasFaucet ? (
          <Pressable testID="faucet" accessibilityRole="button" disabled={busy} onPress={faucet}
            style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: color.white, opacity: busy ? 0.5 : 1 }}>
            <T style={{ fontFamily: font.bold, fontSize: 14 }}>+ Tiền thử</T>
          </Pressable>
        ) : null}
      </View>}
      {credit && credit !== '0' ? (
        <View testID="credit" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 12, backgroundColor: color.amberSoft }}>
          <T style={{ fontFamily: font.semibold, flexShrink: 1 }}>{formatVnd(credit)} hoàn từ hàng chờ</T>
          <View style={{ width: 120 }}><Btn testID="withdraw-credit" label="Rút" kind="dark" onPress={async () => { try { const e = await app.service.withdrawCredit(); if (mounted.current) app.go({ name: 'tx', entryId: e.id }); } catch (e) { if (mounted.current) setFailure(messageFor(codeOf(e))); } }} /></View>
        </View>
      ) : null}
      {lines?.map((l) => (
        <Pressable key={`${l.eventId}-${l.state.tier}`} testID={`line-${l.eventId}-${l.state.tier}`} accessibilityRole="button" accessibilityLabel={`Mở ${l.eventName}`} onPress={() => app.go({ name: 'event', eventId: l.eventId })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: color.amber }}>
          <Ic name="hourglass" size={22} />
          <View style={{ flex: 1 }}>
            <T lines={1} style={{ fontFamily: font.bold }}>Xếp thứ {l.state.position} · {l.tierName} · {l.eventName}</T>
            <T style={{ fontSize: 13, lineHeight: 18 }}>Đã đặt cọc {formatVnd(l.state.deposit)}. Vé bán lại kế tiếp {l.state.position === 1 ? 'là của bạn' : 'thuộc về người đứng đầu hàng'}.</T>
          </View>
          <Ic name="next" size={18} />
        </Pressable>
      ))}
      {failure ? <T testID="faucet-error" style={{ color: color.orange, fontFamily: font.semibold }}>{failure}</T> : null}
      {error && !tickets ? <T testID="load-error">{messageFor('Network')}</T> : null}
      {!tickets && !error ? <Center /> : null}
      {tickets?.length === 0 && !lines?.length ? (
        <Center>
          <Ic name="ticket" size={40} tint={color.muted} />
          <Display testID="empty" size={22}>Chưa có vé</Display>
          <Btn label="Tìm sự kiện" kind="dark" onPress={() => app.reset({ name: 'events' })} />
        </Center>
      ) : null}
      {tickets?.map((t) => (
        <Pressable key={t.tokenId} testID={`ticket-${t.tokenId}`} accessibilityRole="button" accessibilityLabel={`Mở vé ${t.tokenId}`} onPress={() => app.go({ name: 'ticket', tokenId: t.tokenId })}>
          {ticketCard(t, { compact: true })}
        </Pressable>
      ))}
    </Screen>
  );
}
