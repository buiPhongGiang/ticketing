import React, { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useApp } from '../app-context';
import { formatUsdc, parseUsdc } from '../format';
import { useLoad, useMounted } from '../hooks';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Mono, Screen, T } from '../ui';

export function ResellScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: t } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  useEffect(() => { if (t && !text) setText(formatUsdc(t.cap).replace(/,/g, '')); }, [t, text]);

  if (!t) return <Screen title="Resell" back nav="tickets"><Center /></Screen>;
  const face = BigInt(t.face);
  const cap = BigInt(t.cap);
  const price = parseUsdc(text);
  const over = price !== null && price > cap;
  const valid = price !== null && price > 0n && !over;
  const presets: [string, bigint][] = [['Face', face], ['+5%', (face * 105n) / 100n], ['Cap +10%', cap]];

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
    <Screen title="Resell" back nav="tickets" footer={<>
      {failure ? <T testID="resell-error" style={{ fontFamily: font.medium }}>{failure}</T> : null}
      <Btn testID="send-list" label={valid ? `List #${tokenId} for ${formatUsdc(price!)} USDC` : `List #${tokenId}`} onPress={send} disabled={!valid} busy={busy} />
    </>}>
      <View style={{ gap: 4 }}>
        <Mono style={{ color: color.muted, fontSize: 11, letterSpacing: 1 }}>{`${t.event.name} · ${t.tierName} · #${tokenId}`.toUpperCase()}</Mono>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <TextInput testID="price" accessibilityLabel="Price in USDC" value={text} onChangeText={setText} inputMode="decimal" keyboardType="decimal-pad"
            style={{ flex: 1, minWidth: 0, width: "100%", minHeight: 72, paddingHorizontal: 12, fontFamily: font.display, fontSize: 48, color: over ? color.orange : color.ink, backgroundColor: color.white, borderWidth: 2, borderColor: over ? color.orange : color.ink }} />
          <Mono style={{ fontSize: 14 }}>USDC</Mono>
        </View>
        {over ? <T testID="over-cap" style={{ color: color.orange, fontFamily: font.semibold }}>Max {formatUsdc(cap)} USDC</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {presets.map(([label, value]) => {
          const on = price === value;
          return (
            <Pressable key={label} testID={`preset-${label}`} accessibilityRole="button" onPress={() => setText(formatUsdc(value).replace(/,/g, ''))}
              style={{ flex: 1, padding: 10, gap: 2, backgroundColor: on ? color.ink : color.white, borderWidth: 1, borderColor: color.ink }}>
              <Mono style={{ color: on ? color.darkMuted : color.muted, fontSize: 11 }}>{label.toUpperCase()}</Mono>
              <T style={{ fontFamily: font.semibold, color: on ? color.white : color.ink }}>{formatUsdc(value)}</T>
            </Pressable>
          );
        })}
      </View>
      <View style={{ height: 10, backgroundColor: color.line }}>
        <View style={{ width: `${Math.min(100, Number(((price ?? 0n) * 100n) / (cap || 1n)))}%`, height: 10, backgroundColor: over ? color.orange : color.blue }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Mono style={{ color: color.muted }}>0</Mono>
        <Display size={18} style={{ color: color.muted }}>{`Cap ${formatUsdc(cap)}`}</Display>
      </View>
    </Screen>
  );
}
