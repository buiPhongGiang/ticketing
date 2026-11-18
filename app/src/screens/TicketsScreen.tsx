import React from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { useLoad } from '../hooks';
import type { Ticket } from '../lib/types';
import { messageFor } from '../messages';
import { Banner, Btn, Center, Display, Screen, T, TicketCard } from '../ui';

export function ticketCardProps(t: Ticket, me: string) {
  switch (t.status) {
    case 'transferring': return { status: 'Transferring to', holder: t.tx?.to ?? t.owner, tone: 'gone' as const };
    case 'unresolved': return { status: 'May have gone to', holder: t.tx?.to ?? t.owner, tone: 'gone' as const };
    case 'transferred': return { status: 'Transferred to', holder: t.owner, tone: 'gone' as const };
    case 'used': return { status: 'Checked in', holder: t.owner, tone: 'used' as const };
    default: return { status: 'Yours', holder: me, tone: 'live' as const };
  }
}

export function TicketsScreen({ bought }: { bought?: number }) {
  const app = useApp();
  const { data: tickets, error, loading, reload } = useLoad(() => app.service.listTickets(), []);
  return (
    <Screen title="My tickets" nav="tickets" footer={<Btn testID="refresh" label="Refresh" kind="secondary" onPress={reload} busy={loading} />}>
      {bought ? <Banner testID="bought" tone="green" icon="check" body={`Bought ${bought} ticket${bought === 1 ? '' : 's'}`} /> : null}
      {error ? <T testID="load-error">{messageFor('Network')}</T> : null}
      {!tickets && !error ? <Center /> : null}
      {tickets?.length === 0 ? (
        <Display testID="empty">No tickets yet</Display>
      ) : null}
      {tickets && [...tickets].sort((x, y) => Number(y.tokenId) - Number(x.tokenId)).map((t) => (
        <Pressable key={t.tokenId} testID={`ticket-${t.tokenId}`} accessibilityRole="button" accessibilityLabel={`Open ticket ${t.tokenId}`} onPress={() => app.go({ name: 'ticket', tokenId: t.tokenId })}>
          <TicketCard compact tokenId={t.tokenId} {...ticketCardProps(t, app.wallet.address)} />
        </Pressable>
      ))}
    </Screen>
  );
}
