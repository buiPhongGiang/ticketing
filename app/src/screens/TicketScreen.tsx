import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../app-context';
import { formatUsdc } from '../format';
import { useLoad, useMounted } from '../hooks';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Icon, Mono, Row, Screen, T, TxLink } from '../ui';
import { ticketCard } from './TicketsScreen';

export function TicketScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: t, error } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  const title = `Ticket #${tokenId}`;
  if (error && !t) return <Screen title={title} back nav="tickets"><T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T></Screen>;
  if (!t) return <Screen title={title} back nav="tickets"><Center /></Screen>;

  async function run(action: () => Promise<{ id: string }>) {
    setBusy(true); setFailure(null);
    try {
      const e = await action();
      if (mounted.current) app.go({ name: 'tx', entryId: e.id });
    } catch (e) {
      if (mounted.current) setFailure(messageFor(codeOf(e)));
    } finally { if (mounted.current) setBusy(false); }
  }

  const card = ticketCard(t, { testID: 'ticket-card' });
  const facts = (
    <View>
      <Row label="Face value" value={`${formatUsdc(t.face)} USDC`} />
      {t.paid === '0' ? <Row label="Free ticket" testID="comp" value="Not for resale" /> : <Row label="Resale cap" testID="cap" value={`${formatUsdc(t.cap)} USDC`} />}
      {t.tx ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 }}><T style={{ color: color.muted }}>Last transaction</T><TxLink hash={t.tx.hash} /></View> : null}
    </View>
  );
  const err = failure ? <T testID="ticket-error" style={{ fontFamily: font.medium }}>{failure}</T> : null;

  if (t.status === 'pending' || t.status === 'unresolved') {
    return (
      <Screen title={title} back nav="tickets" ownLookup={t.status === 'unresolved'} footer={t.status === 'unresolved' && t.tx ? <Btn testID="lookup" label="Look up transaction" onPress={() => app.service.lookup(t.tx!.id)} /> : undefined}>
        <Banner testID="ticket-pending" tone="amber" icon={t.status === 'pending' ? 'clock' : 'off'} body={t.status === 'pending' ? 'Confirming…' : 'Result unknown'} />
        {card}{facts}
      </Screen>
    );
  }
  if (t.status === 'sold') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <View testID="sold" style={{ gap: 4 }}>
          <T style={{ fontFamily: font.semibold }}>Sold on resale</T>
          <Mono style={{ color: color.muted }}>Now held by {t.owner}</Mono>
        </View>
        {facts}
      </Screen>
    );
  }
  if (t.status === 'used') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <View testID="used" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="lock" size={22} /><T>Checked in</T></View>
        {facts}
      </Screen>
    );
  }
  if (t.status === 'refundable') {
    return (
      <Screen title={title} back nav="tickets" footer={<>{err}<Btn testID="refund" label={`Refund ${formatUsdc(t.paid)} USDC`} busy={busy} onPress={() => run(() => app.service.claimRefund(tokenId))} /></>}>
        <Banner testID="cancelled" tone="orange" icon="x" title={t.event.cancelled ? 'Event cancelled' : 'No-show'} body={t.event.cancelled ? undefined : 'Too few tickets were scanned. Take your money back.'} />
        {card}{facts}
      </Screen>
    );
  }
  const listed = t.status === 'listed';
  const ended = t.event.status === 'ended';
  const comp = t.paid === '0'; // a free ticket from the organizer: entry only, the contract refuses to list it
  return (
    <Screen title={title} back nav="tickets" footer={<>
      {err}
      {ended ? null : <Btn testID="make-qr" label="Show QR" onPress={() => app.go({ name: 'qr', tokenId })} disabled={busy} />}
      {ended || comp ? null : listed
        ? <Btn testID="unlist" label="Unlist" kind="secondary" busy={busy} onPress={() => run(() => app.service.unlist(tokenId))} />
        : <Btn testID="resell" label="Resell" kind="secondary" disabled={busy} onPress={() => app.go({ name: 'resell', tokenId })} />}
    </>}>
      {card}
      {facts}
    </Screen>
  );
}
