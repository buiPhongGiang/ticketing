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

  if (!entry) return <Screen title="Buying" nav="event"><Center /></Screen>;

  const details = (
    <View>
      {entry.state === 'reverted' ? <Row label="Reason" value={messageFor(entry.reasonCode)} /> : <>
        <Row label="Tickets" value={entry.quantity ?? ''} />
        <Row label="Amount" value={formatAmount(entry.valueWei ?? '0', config.nativeSymbol)} />
      </>}
      <Row label="Transaction" value={short(entry.hash)} mono />
    </View>
  );

  if (entry.state === 'reverted') {
    return (
      <Screen title="Purchase failed" nav="event" footer={<Btn testID="retry" label="Try again" onPress={() => app.reset({ name: 'event' })} />}>
        <Banner testID="purchase-failed" tone="orange" icon="x" title="Purchase failed" body="No ticket bought." />
        {details}
      </Screen>
    );
  }
  if (entry.state === 'unknown') {
    return (
      <Screen title="Buying" nav="event" ownLookup footer={<Btn testID="lookup" label="Look up transaction" onPress={() => app.service.lookup(entry.id)} />}>
        <Banner testID="purchase-unknown" tone="amber" icon="off" title="Result unknown" body="Look it up before buying again." />
        {details}
      </Screen>
    );
  }
  return (
    <Screen title="Buying" nav="event">
      <Banner testID="purchase-pending" tone="amber" icon="clock" title="Confirming" />
      {details}
    </Screen>
  );
}
