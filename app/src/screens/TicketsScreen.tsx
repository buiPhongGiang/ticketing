import React from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { useLoad } from '../hooks';
import type { Ticket } from '../lib/types';
import { messageFor } from '../messages';
import { Banner, Btn, Center, Display, Screen, T, TicketCard } from '../ui';
import { color } from '../theme';

export function ticketCardProps(t: Ticket, me: string) {
  switch (t.status) {
    case 'transferring': return { status: 'Đang chuyển cho', holder: t.tx?.to ?? t.owner, tone: 'gone' as const };
    case 'unresolved': return { status: 'Có thể đã chuyển cho', holder: t.tx?.to ?? t.owner, tone: 'gone' as const };
    case 'transferred': return { status: 'Đã chuyển cho', holder: t.owner, tone: 'gone' as const };
    case 'used': return { status: 'Đã vào cửa', holder: t.owner, tone: 'used' as const };
    default: return { status: 'Bạn đang giữ vé', holder: me, tone: 'live' as const };
  }
}

export function TicketsScreen({ bought }: { bought?: number }) {
  const app = useApp();
  const { data: tickets, error, loading, reload } = useLoad(() => app.service.listTickets(), []);
  return (
    <Screen title="Vé của tôi" nav="tickets" footer={<Btn testID="refresh" label="Làm mới danh sách vé" kind="secondary" onPress={reload} busy={loading} />}>
      {bought ? <Banner testID="bought" tone="green" icon="check" body={`Đã mua ${bought} vé`} /> : null}
      {error ? <T testID="load-error">{messageFor('Network')}</T> : null}
      {!tickets && !error ? <Center /> : null}
      {tickets?.length === 0 ? (
        <View testID="empty" style={{ gap: 4 }}>
          <Display>Chưa có vé</Display>
          <T style={{ color: color.muted }}>Mua vé ở tab Sự kiện, hoặc nhờ người đang giữ vé chuyển vào ví của bạn.</T>
        </View>
      ) : null}
      {tickets?.map((t) => (
        <Pressable key={t.tokenId} testID={`ticket-${t.tokenId}`} accessibilityRole="button" accessibilityLabel={`Mở vé số ${t.tokenId}`} onPress={() => app.go({ name: 'ticket', tokenId: t.tokenId })}>
          <TicketCard tokenId={t.tokenId} {...ticketCardProps(t, app.wallet.address)} />
        </Pressable>
      ))}
    </Screen>
  );
}
