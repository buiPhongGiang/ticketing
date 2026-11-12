import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { config, eventInfo } from '../config';
import { formatAmount } from '../format';
import { useLoad, useMounted } from '../hooks';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Row, Screen, T } from '../ui';

const amount = (wei: bigint) => formatAmount(wei, config.nativeSymbol);

export function EventScreen() {
  const app = useApp();
  const { data: sale, error, reload } = useLoad(() => app.service.getSale(), []);
  const [quantity, setQuantity] = useState(1);
  const [fee, setFee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();

  const remaining = sale ? Number(sale.remaining) : 0;
  const canBuy = !!sale && sale.saleOpen && !sale.soldOut;

  useEffect(() => { if (remaining > 0 && quantity > remaining) setQuantity(remaining); }, [remaining, quantity]);
  useEffect(() => {
    if (!canBuy) return;
    let live = true;
    setFee(null);
    app.service.estimateBuyFeeWei(quantity).then((f) => { if (live) setFee(f); }).catch(() => { if (live) setFee(null); });
    return () => { live = false; };
  }, [app.service, canBuy, quantity, sale?.remaining]);

  async function buy() {
    setBusy(true); setFailure(null);
    try {
      const entry = await app.service.buy(quantity);
      if (mounted.current) app.go({ name: 'purchase', entryId: entry.id });
    } catch (e) {
      if (!mounted.current) return;
      setFailure(messageFor(codeOf(e)));
      reload();
    } finally { if (mounted.current) setBusy(false); }
  }

  const footer = canBuy ? <>
    {failure ? <T testID="buy-error" style={{ fontFamily: font.medium }}>{failure}</T> : null}
    <Btn testID="buy" label={`Buy ${quantity} ticket${quantity === 1 ? '' : 's'}`} onPress={buy} busy={busy} />
  </> : sale ? <Btn testID="buy" label={sale.saleOpen ? 'Sold out' : 'Not on sale'} disabled /> : undefined;

  return (
    <Screen title="Event" nav="event" footer={footer}>
      <View style={{ backgroundColor: color.ink, paddingHorizontal: 20, paddingVertical: 24, gap: 8 }}>
        <Display size={52} style={{ color: color.white }}>{eventInfo.name}</Display>
        <T style={{ color: color.darkMuted }}>{eventInfo.when} · {eventInfo.venue}</T>
      </View>
      {error ? <View style={{ gap: 12 }}><T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T><Btn label="Try again" kind="secondary" onPress={reload} /></View> : null}
      {!sale && !error ? <Center /> : null}
      {sale && !sale.saleOpen ? (
        <View style={{ gap: 4 }}><Display testID="sale-closed">Public sale not open</Display><T style={{ color: color.muted }}>Tickets are issued by the organizer straight to wallets.</T></View>
      ) : null}
      {sale?.saleOpen && sale.soldOut ? (
        <View style={{ gap: 4 }}><Display testID="sold-out">Sold out</Display><T style={{ color: color.muted }}>A current holder can still transfer a ticket to your wallet.</T></View>
      ) : null}
      {canBuy && sale ? <>
        <View>
          <Row label="Price per ticket" value={amount(BigInt(sale.priceWei))} />
          <Row label="Left" testID="remaining" value={`${sale.remaining} / ${sale.maxSupply}`} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T style={{ fontFamily: font.medium }}>Quantity</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Stepper label="−" name="Fewer" onPress={() => setQuantity(Math.max(1, quantity - 1))} />
            <Display size={28} testID="quantity" style={{ width: 44, textAlign: 'center' }}>{quantity}</Display>
            <Stepper label="+" name="More" testID="more" onPress={() => setQuantity(Math.min(remaining, quantity + 1))} />
          </View>
        </View>
        <View>
          <Row label="Tickets" value={amount(BigInt(sale.priceWei) * BigInt(quantity))} />
          <Row label="Network fee (est.)" value={fee ? amount(BigInt(fee)) : '…'} />
        </View>
      </> : null}
    </Screen>
  );
}

function Stepper({ label, name, onPress, testID }: { label: string; name: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={name} onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: color.white, borderWidth: 1, borderColor: color.ink }}>
      <T style={{ fontSize: 20 }}>{label}</T>
    </Pressable>
  );
}
