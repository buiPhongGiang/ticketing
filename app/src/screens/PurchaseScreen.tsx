import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useApp } from '../app-context';
import { config } from '../config';
import { formatAmount } from '../format';
import { useEntry } from '../hooks';
import { messageFor } from '../messages';
import { Banner, Btn, Center, Row, Screen, short } from '../ui';

export function PurchaseScreen({ entryId }: { entryId: string }) {
  const app = useApp();
  const entry = useEntry(entryId);

  useEffect(() => {
    if (entry?.state === 'succeeded') app.reset({ name: 'tickets', bought: Number(entry.quantity ?? 0) });
  }, [app, entry]);

  if (!entry) return <Screen title="Đang mua" nav="event"><Center /></Screen>;

  const details = (
    <View>
      {entry.state === 'reverted' ? <Row label="Lý do" value={messageFor(entry.reasonCode)} /> : <>
        <Row label="Số vé" value={entry.quantity ?? ''} />
        <Row label="Số tiền" value={formatAmount(entry.valueWei ?? '0', config.nativeSymbol)} />
      </>}
      <Row label="Giao dịch" value={short(entry.hash)} mono />
    </View>
  );

  if (entry.state === 'reverted') {
    return (
      <Screen title="Chưa mua được" nav="event" footer={<Btn testID="retry" label="Thử lại" onPress={() => app.reset({ name: 'event' })} />}>
        <Banner testID="purchase-failed" tone="orange" icon="x" title="Chưa mua được" body="Giao dịch thất bại nên bạn chưa có vé. Số tiền vé không bị trừ, phí mạng vẫn mất." />
        {details}
      </Screen>
    );
  }
  if (entry.state === 'unknown') {
    return (
      <Screen title="Đang mua" nav="event" ownLookup footer={<Btn testID="lookup" label="Tra lại giao dịch" onPress={() => app.service.lookup(entry.id)} />}>
        <Banner testID="purchase-unknown" tone="amber" icon="off" title="Chưa rõ kết quả" body="Mất kết nối sau khi đã gửi. Đừng mua lại kẻo mất tiền hai lần. Hãy tra lại giao dịch này trước." />
        {details}
      </Screen>
    );
  }
  return (
    <Screen title="Đang mua" nav="event">
      <Banner testID="purchase-pending" tone="amber" icon="clock" title="Đang xác nhận" body="Giao dịch đã gửi. Vé chỉ thuộc về bạn khi mạng xác nhận xong." />
      {details}
    </Screen>
  );
}
