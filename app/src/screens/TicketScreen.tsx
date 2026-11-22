import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { demoMode, payOn } from '../config';
import { formatVnd } from '../format';
import { useLoad, useMounted } from '../hooks';
import { loadReceipts } from '../lib/pay';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Ic, Mono, Row, Screen, T, TxLink } from '../ui';
import { QueueForTicket } from '../exchange-ui';
import { ticketCard } from './TicketsScreen';

export function TicketScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: t, error } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const { data: receipts } = useLoad(() => (payOn ? loadReceipts(app.store, app.wallet.address) : Promise.resolve([])), [app.wallet.address]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  const title = `Vé #${tokenId}`;
  // The newest payment made from this device that names this ticket.
  const receipt = receipts?.find((r) => r.tokenIds.includes(tokenId));
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
      <Row label="Giá vé" value={formatVnd(t.face)} />
      {t.paid === '0' ? <Row label="Vé mời" testID="comp" value="Không bán lại" /> : <Row label="Bán lại tối đa" testID="cap" value={formatVnd(t.cap)} />}
      {receipt ? (
        <Pressable testID="open-receipt" accessibilityRole="button" accessibilityLabel="Mở biên nhận thanh toán" onPress={() => app.go({ name: 'receipt', code: receipt.code })}
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.paper }}>
          <T style={{ color: color.muted }}>{receipt.kind === 'refund' ? 'Biên nhận hoàn tiền' : 'Biên nhận thanh toán'}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><T style={{ fontFamily: font.semibold, color: color.blue }}>{receipt.code}</T><Ic name="next" size={18} tint={color.blue} /></View>
        </Pressable>
      ) : null}
      {t.tx ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 }}><T style={{ color: color.muted }}>Giao dịch</T><TxLink hash={t.tx.hash} /></View> : null}
    </View>
  );
  const err = failure ? <T testID="ticket-error" style={{ fontFamily: font.medium }}>{failure}</T> : null;

  if (t.status === 'pending' || t.status === 'unresolved') {
    return (
      <Screen title={title} back nav="tickets" ownLookup={t.status === 'unresolved'} footer={t.status === 'unresolved' && t.tx ? <Btn testID="lookup" label="Kiểm tra giao dịch" onPress={() => app.service.lookup(t.tx!.id)} /> : undefined}>
        <Banner testID="ticket-pending" tone="amber" icon={t.status === 'pending' ? 'clock' : 'off'} body={t.status === 'pending' ? 'Đang xác nhận…' : 'Chưa rõ kết quả'} />
        {card}{facts}
      </Screen>
    );
  }
  if (t.status === 'sold') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <View testID="sold" style={{ gap: 4 }}>
          <T style={{ fontFamily: font.semibold }}>Đã bán lại</T>
          {demoMode ? <Mono style={{ color: color.muted }}>Hiện do {t.owner} giữ</Mono> : null}
        </View>
        {facts}
      </Screen>
    );
  }
  if (t.status === 'used') {
    return (
      <Screen title={title} back nav="tickets">
        {card}
        <View testID="used" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: color.paper }}><Ic name="check" size={18} /><T style={{ fontFamily: font.semibold }}>Đã vào cửa. Chúc bạn xem vui!</T></View>
        {facts}
      </Screen>
    );
  }
  if (t.status === 'refundable') {
    return (
      <Screen title={title} back nav="tickets" footer={<>{err}<Btn testID="refund" label={`Nhận hoàn ${formatVnd(t.paid)}`} busy={busy} onPress={() => run(() => app.service.claimRefund(tokenId))} /></>}>
        <Banner testID="cancelled" tone="orange" icon="x" title={t.event.cancelled ? 'Sự kiện bị hủy' : 'Sự kiện không diễn ra'} body={t.event.cancelled ? 'Bạn có thể nhận lại tiền.' : 'Quá ít người vào cửa. Bạn có thể nhận lại tiền.'} />
        {payOn ? <T testID="refund-note" style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Lệnh hoàn được ghi công khai theo đúng số tiền bạn đã trả; ngân hàng chi trả theo lệnh này.</T> : null}
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
      {ended ? null : <Btn testID="make-qr" label="Mở mã QR vào cửa" onPress={() => app.go({ name: 'qr', tokenId })} disabled={busy} />}
      {ended || comp ? null : listed
        ? <Btn testID="unlist" label="Gỡ rao bán" kind="secondary" busy={busy} onPress={() => run(() => app.service.unlist(tokenId))} />
        : <Btn testID="resell" label="Không đi được? Bán lại" kind="secondary" disabled={busy} onPress={() => app.go({ name: 'resell', tokenId })} />}
    </>}>
      {card}
      {/* The market's side of this ticket: who is waiting for one like it, or how its listing looks to buyers. */}
      <QueueForTicket ticket={t} />
      {listed && !ended ? <Btn testID="open-listing" label="Xem trên Chợ vé, thêm ghi chú" kind="secondary" onPress={() => app.go({ name: 'listing', tokenId })} /> : null}
      {facts}
    </Screen>
  );
}
