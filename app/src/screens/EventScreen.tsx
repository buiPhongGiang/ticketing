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
    <Btn testID="buy" label={`Mua ${quantity} vé`} onPress={buy} busy={busy} />
  </> : sale ? <Btn testID="buy" label={sale.saleOpen ? 'Hết vé' : 'Chưa mở bán'} disabled /> : undefined;

  return (
    <Screen title="Sự kiện" nav="event" footer={footer}>
      <View style={{ backgroundColor: color.ink, paddingHorizontal: 20, paddingVertical: 24, gap: 8 }}>
        <Display size={52} style={{ color: color.white }}>{eventInfo.name}</Display>
        <T style={{ color: color.darkMuted }}>{eventInfo.when} · {eventInfo.venue}</T>
      </View>
      {error ? <View style={{ gap: 12 }}><T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T><Btn label="Thử lại" kind="secondary" onPress={reload} /></View> : null}
      {!sale && !error ? <Center /> : null}
      {sale && !sale.saleOpen ? (
        <View style={{ gap: 4 }}><Display testID="sale-closed">Chưa mở bán công khai</Display><T style={{ color: color.muted }}>Vé do ban tổ chức phát trực tiếp vào ví.</T></View>
      ) : null}
      {sale?.saleOpen && sale.soldOut ? (
        <View style={{ gap: 4 }}><Display testID="sold-out">Đã hết vé</Display><T style={{ color: color.muted }}>Vé vẫn có thể đến từ người đang giữ. Nhờ họ chuyển vé vào ví của bạn.</T></View>
      ) : null}
      {canBuy && sale ? <>
        <View>
          <Row label="Giá mỗi vé" value={amount(BigInt(sale.priceWei))} />
          <Row label="Còn lại" testID="remaining" value={`${sale.remaining} / ${sale.maxSupply} vé`} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T style={{ fontFamily: font.medium }}>Số lượng</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Stepper label="−" name="Giảm số lượng" onPress={() => setQuantity(Math.max(1, quantity - 1))} />
            <Display size={28} testID="quantity" style={{ width: 44, textAlign: 'center' }}>{quantity}</Display>
            <Stepper label="+" name="Tăng số lượng" testID="more" onPress={() => setQuantity(Math.min(remaining, quantity + 1))} />
          </View>
        </View>
        <View>
          <Row label="Tiền vé" value={amount(BigInt(sale.priceWei) * BigInt(quantity))} />
          <Row label="Phí mạng (ước tính)" value={fee ? amount(BigInt(fee)) : '…'} />
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
