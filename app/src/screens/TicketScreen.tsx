import React from 'react';
import { View } from 'react-native';
import { useApp } from '../app-context';
import { useLoad } from '../hooks';
import { messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Display, Icon, Mono, Row, Screen, short, T, TicketCard } from '../ui';
import { ticketCardProps } from './TicketsScreen';

export function TicketScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: t, error } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const title = `Ticket #${tokenId}`;
  if (error && !t) return <Screen title={title} back nav="tickets"><T testID="load-error">{messageFor('Network')}</T></Screen>;
  if (!t) return <Screen title={title} back nav="tickets"><Center /></Screen>;
  const card = <TicketCard testID="ticket-card" tokenId={tokenId} {...ticketCardProps(t, app.wallet.address)} />;
  const txRow = t.tx ? <Row label="Transaction" value={short(t.tx.hash)} mono /> : null;

  if (t.status === 'transferring') {
    return (
      <Screen title={title} back nav="tickets">
        <Banner testID="transferring" tone="amber" icon="clock" body="Transferring…" />
        {card}{txRow}
      </Screen>
    );
  }
  if (t.status === 'unresolved') {
    return (
      <Screen title={title} back nav="tickets" ownLookup footer={<Btn testID="lookup" label="Look up transaction" onPress={() => t.tx && app.service.lookup(t.tx.id)} />}>
        <Banner testID="transfer-unknown" tone="amber" icon="off" body="Transfer result unknown" />
        {card}{txRow}
      </Screen>
    );
  }
  if (t.status === 'transferred') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <Display testID="transferred" style={{ color: color.blue }}>Transferred</Display>
        <View>
          <Step label="From" address={app.wallet.address} />
          <Step label="To" address={t.owner} />
        </View>
        {txRow}
      </Screen>
    );
  }
  if (t.status === 'used') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <View testID="used" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <Icon name="lock" size={22} /><T style={{ flexShrink: 1 }}>Checked in</T>
        </View>
      </Screen>
    );
  }
  const transferFailed = t.tx?.kind === 'transfer' && t.tx.state === 'reverted';
  return (
    <Screen title={title} back nav="tickets" footer={<>
      <Btn testID="make-qr" label="Show QR" onPress={() => app.go({ name: 'qr', tokenId })} />
      <Btn testID="transfer" label={transferFailed ? 'Try transfer again' : 'Transfer ticket'} kind="secondary" onPress={() => app.go({ name: 'transfer', tokenId })} />
    </>}>
      {transferFailed ? <Banner testID="transfer-failed" tone="orange" icon="x" body="Transfer failed. You still hold this ticket." /> : null}
      {card}
      {transferFailed ? <View><Row label="Reason" value={messageFor(t.tx?.reasonCode)} />{txRow}</View> : null}
    </Screen>
  );
}

function Step({ label, address }: { label: string; address: string }) {
  return (
    <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.line }}>
      <T style={{ fontFamily: font.medium }}>{label}</T>
      <Mono style={{ color: color.muted }}>{short(address)}</Mono>
    </View>
  );
}
