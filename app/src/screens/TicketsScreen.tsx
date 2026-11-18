import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp, type Notice } from '../app-context';
import { config } from '../config';
import { eventDate, formatAmount, formatUsdc } from '../format';
import { useLoad, useMounted } from '../hooks';
import type { Ticket } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Display, Mono, Screen, T, TicketCard, type CardTone } from '../ui';

export function cardProps(t: Ticket): { status: string; tone: CardTone; holder?: string } {
  switch (t.status) {
    case 'listed': return { status: `Listed · ${formatUsdc(t.listPrice)} USDC`, tone: 'listed' };
    case 'used': return { status: 'Checked in', tone: 'used' };
    case 'refundable': return { status: `Refund ${formatUsdc(t.paid)} USDC`, tone: 'gone' };
    case 'sold': return { status: 'Sold on resale', tone: 'void', holder: t.owner };
    case 'pending': return { status: 'Confirming…', tone: 'gone' };
    case 'unresolved': return { status: 'Result unknown', tone: 'gone' };
    default: return { status: 'Yours', tone: 'live' };
  }
}

export const ticketCard = (t: Ticket, props: { compact?: boolean; testID?: string } = {}) => (
  <TicketCard tokenId={t.tokenId} eventName={t.event.name} when={`${eventDate(t.event.startsAt)} · ${t.event.venue}`} tierName={t.tierName} {...cardProps(t)} {...props} />
);

export function TicketsScreen({ notice }: { notice?: Notice }) {
  const app = useApp();
  const { data: tickets, error, loading, reload } = useLoad(() => app.service.listTickets(), []);
  const { data: balances } = useLoad(() => app.service.getBalances(app.wallet.address), [app.wallet.address]);
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

  return (
    <Screen title="My tickets" nav="tickets" footer={<Btn testID="refresh" label="Refresh" kind="secondary" onPress={reload} busy={loading} />}>
      {notice ? (
        <View testID="notice" style={{ backgroundColor: color.green, padding: 16, gap: 4 }}>
          <T testID={notice.kind === 'bought' ? 'bought' : undefined} style={{ fontFamily: font.semibold, color: color.white }}>{notice.text}</T>
          {notice.feeWei ? <Mono testID="fee" style={{ color: color.white, fontSize: 11 }}>{`NETWORK FEE ${formatAmount(notice.feeWei, config.nativeSymbol)}`}</Mono> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Display size={30} testID="usdc-balance">{balances ? formatUsdc(balances.usdc) : '…'}</Display>
          <Mono style={{ color: color.muted }}>USDC</Mono>
        </View>
        <Pressable testID="faucet" accessibilityRole="button" disabled={busy} onPress={faucet}
          style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', borderWidth: 1, borderColor: color.ink, opacity: busy ? 0.5 : 1 }}>
          <T style={{ fontFamily: font.semibold, fontSize: 14 }}>+ Test USDC</T>
        </Pressable>
      </View>
      {failure ? <T testID="faucet-error">{failure}</T> : null}
      {error && !tickets ? <T testID="load-error">{messageFor('Network')}</T> : null}
      {!tickets && !error ? <Center /> : null}
      {tickets?.length === 0 ? <Display testID="empty">No tickets yet</Display> : null}
      {tickets?.map((t) => (
        <Pressable key={t.tokenId} testID={`ticket-${t.tokenId}`} accessibilityRole="button" accessibilityLabel={`Open ticket ${t.tokenId}`} onPress={() => app.go({ name: 'ticket', tokenId: t.tokenId })}>
          {ticketCard(t, { compact: true })}
        </Pressable>
      ))}
    </Screen>
  );
}
