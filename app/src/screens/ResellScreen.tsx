import React, { useEffect, useState } from 'react';
import { Image, Pressable, TextInput, View } from 'react-native';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { formatVnd, parseVnd, vndDigits } from '../format';
import { useLoad, useMounted } from '../hooks';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Screen, T } from '../ui';

export function ResellScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: t } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const { data: waitlist } = useLoad(() => (t ? app.service.getWaitlist(t.eventId) : Promise.resolve(undefined)), [t?.eventId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  useEffect(() => { if (t && !text) setText(vndDigits(t.cap)); }, [t, text]);

  if (!t) return <Screen title="Bán lại vé" back nav="tickets"><Center /></Screen>;
  const face = BigInt(t.face);
  const cap = BigInt(t.cap);
  // The first field names the test id and stays as it is; the second is what a screen reader says.
  const presets: [string, bigint, string][] = [['Face', face, 'Giá gốc'], ['+5%', (face * 105n) / 100n, 'Giá gốc +5%'], ['Cap +10%', cap, 'Giá trần +10%']];
  // A price typed in đồng becomes USDC units rounded down; a preset's own đồng figure maps back to its exact amount.
  const digits = text.replace(/\D/g, '');
  const preset = presets.find(([, v]) => vndDigits(v).replace(/\D/g, '') === digits);
  const price = preset ? preset[1] : parseVnd(text);
  const over = price !== null && price > cap;
  const valid = price !== null && price > 0n && !over;
  const waiting = waitlist?.[t.tier]?.waiting ?? 0;

  async function send() {
    if (!valid) return;
    setBusy(true); setFailure(null);
    try {
      const e = await app.service.list(tokenId, price!.toString());
      if (mounted.current) app.go({ name: 'tx', entryId: e.id });
    } catch (e) {
      if (mounted.current) { setFailure(messageFor(codeOf(e))); setBusy(false); }
    }
  }

  return (
    <Screen title="Bán lại vé" back nav="tickets" footer={<>
      {failure ? <T testID="resell-error" style={{ fontFamily: font.semibold, color: color.orange }}>{failure}</T> : null}
      <Btn testID="send-list" label={valid ? `Bán với giá ${formatVnd(price!)}` : 'Bán'} onPress={send} disabled={!valid} busy={busy} />
    </>}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, backgroundColor: color.paper }}>
        <Image source={eventPhoto(t.event.id)} style={{ width: 60, height: 60 }} />
        <View style={{ flex: 1 }}>
          <T lines={1} style={{ fontFamily: font.bold }}>{t.event.name}</T>
          <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{t.tierName} · giá gốc {formatVnd(t.face)}</T>
        </View>
        <Display size={20} style={{ color: color.blue, paddingRight: 8 }}>#{tokenId}</Display>
      </View>

      <View style={{ alignItems: 'center', gap: 6, paddingTop: 8 }}>
        <T style={{ color: color.muted }}>Giá bạn muốn bán</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch', justifyContent: 'center' }}>
          <TextInput testID="price" accessibilityLabel="Giá bán, tính bằng đồng" value={text} onChangeText={setText} inputMode="numeric" keyboardType="number-pad"
            style={{ flexShrink: 1, minWidth: 0, maxWidth: 260, textAlign: 'right', fontFamily: font.display, fontSize: 44, letterSpacing: -1, color: over ? color.orange : color.ink, paddingVertical: 4 }} />
          <T testID="price-unit" style={{ fontFamily: font.bold, fontSize: 24, color: color.muted, flexShrink: 0 }}>đ</T>
        </View>
        {over
          ? <T testID="over-cap" style={{ color: color.orange, fontFamily: font.bold }}>Tối đa {formatVnd(cap)}</T>
          : <T style={{ color: color.green, fontFamily: font.semibold, fontSize: 13 }}>Bán được tới {formatVnd(cap)}</T>}
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {presets.map(([label, value, spoken]) => {
          const on = price === value;
          return (
            <Pressable key={label} testID={`preset-${label}`} accessibilityRole="button" accessibilityLabel={`${spoken}: ${formatVnd(value)}`} onPress={() => setText(vndDigits(value))}
              style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? color.ink : color.paper }}>
              <T lines={1} style={{ fontFamily: font.bold, fontSize: 14, color: on ? color.white : color.ink }}>{vndDigits(value)}</T>
            </Pressable>
          );
        })}
      </View>

      {waiting > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: color.amber }}>
          <Ic name="people" size={22} />
          <T style={{ flex: 1, fontFamily: font.semibold }}>{waiting} người đang xếp hàng chờ. Vé sẽ bán ngay cho người đứng đầu.</T>
        </View>
      ) : null}
    </Screen>
  );
}
