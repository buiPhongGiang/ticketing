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
  const title = `Vé #${tokenId}`;
  if (error && !t) return <Screen title={title} back nav="tickets"><T testID="load-error">{messageFor('Network')}</T></Screen>;
  if (!t) return <Screen title={title} back nav="tickets"><Center /></Screen>;
  const card = <TicketCard testID="ticket-card" tokenId={tokenId} {...ticketCardProps(t, app.wallet.address)} />;
  const txRow = t.tx ? <Row label="Giao dịch" value={short(t.tx.hash)} mono /> : null;

  if (t.status === 'transferring') {
    return (
      <Screen title={title} back nav="tickets">
        <Banner testID="transferring" tone="amber" icon="clock" body="Đang chuyển. QR tạm ẩn cho đến khi có kết quả." />
        {card}{txRow}
      </Screen>
    );
  }
  if (t.status === 'unresolved') {
    return (
      <Screen title={title} back nav="tickets" ownLookup footer={<Btn testID="lookup" label="Tra lại giao dịch" onPress={() => t.tx && app.service.lookup(t.tx.id)} />}>
        <Banner testID="transfer-unknown" tone="amber" icon="off" body="Mất kết nối sau khi đã gửi. QR vẫn ẩn và chưa chuyển lại được cho đến khi tra ra kết quả." />
        {card}{txRow}
      </Screen>
    );
  }
  if (t.status === 'transferred') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <Display testID="transferred" style={{ color: color.blue }}>Quyền vào cửa đã chuyển</Display>
        <View>
          <Step label="Ví của bạn đã chuyển vé" address={app.wallet.address} />
          <Step label="Ví nhận đang giữ quyền vào cửa" address={t.owner} />
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
          <Icon name="lock" size={22} /><T style={{ flexShrink: 1 }}>Vé đã dùng nên không chuyển và không tạo QR được nữa.</T>
        </View>
      </Screen>
    );
  }
  const transferFailed = t.tx?.kind === 'transfer' && t.tx.state === 'reverted';
  return (
    <Screen title={title} back nav="tickets" footer={<>
      <T style={{ fontSize: 14, color: color.muted }}>QR có hạn 3 phút. Hãy tạo khi đã đến cổng.</T>
      <Btn testID="make-qr" label="Tạo QR tại cổng" onPress={() => app.go({ name: 'qr', tokenId })} />
      <Btn testID="transfer" label={transferFailed ? 'Thử chuyển lại' : 'Chuyển vé'} kind="secondary" onPress={() => app.go({ name: 'transfer', tokenId })} />
    </>}>
      {transferFailed ? <Banner testID="transfer-failed" tone="orange" icon="x" body="Chưa chuyển được. Đã kiểm tra lại: ví của bạn vẫn đang giữ vé, nên QR dùng lại được." /> : null}
      {card}
      {transferFailed ? <View><Row label="Lý do" value={messageFor(t.tx?.reasonCode)} />{txRow}</View> : (
        <T style={{ color: color.muted }}>Quyền vào cửa thuộc về ví đang giữ vé. Chuyển vé đi thì quyền này đi theo. Đừng chia sẻ QR của bạn.</T>
      )}
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
