import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { eventWhen } from '../format';
import { clock, useLoad, useSecondsLeft } from '../hooks';
import type { QrPayload } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Screen, T } from '../ui';

export function QrScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const { data: ticket } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const [qr, setQr] = useState<{ encoded: string; payload: QrPayload } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const left = useSecondsLeft(qr?.payload.deadline);
  const expired = !!qr && left === 0;

  const sign = useCallback(async () => {
    setFailure(null); setCopied(false);
    try {
      setQr(await app.service.createQr(tokenId));
    } catch (e) {
      setQr(null); setFailure(messageFor(codeOf(e)));
    }
  }, [app.service, tokenId]);

  useEffect(() => { sign(); }, [sign]);

  const title = 'Vé của bạn';
  if (failure) return <Screen title={title} back nav="tickets"><T testID="qr-error">{failure}</T></Screen>;
  if (!qr) return <Screen title={title} back nav="tickets"><Center /></Screen>;
  return (
    <Screen title={title} back nav="tickets" footer={expired
      ? <Btn testID="resign" label="Tạo mã QR mới" onPress={sign} />
      : <Btn testID="copy-qr" label={copied ? 'Đã chép mã' : 'Chép mã'} kind="secondary" onPress={async () => { await Clipboard.setStringAsync(qr.encoded); setCopied(true); }} />}>
      <View style={{ backgroundColor: color.white, borderWidth: 1, borderColor: color.paper }}>
        {ticket ? (
          <View style={{ height: 110 }}>
            <Image source={eventPhoto(ticket.event.id)} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: 'rgba(43,43,217,0.55)' }} />
            <Display size={22} lines={2} style={{ position: 'absolute', left: 16, right: 16, bottom: 12, color: color.white }}>{ticket.event.name}</Display>
          </View>
        ) : null}
        <View testID="qr" accessibilityLabel="Mã QR vào cửa" style={{ padding: 20, alignItems: 'center' }}>
          <QRCode value={qr.encoded} size={240} color={expired ? color.line : color.ink} backgroundColor={color.white} ecl="M" />
        </View>
        <View style={{ height: 0, borderTopWidth: 2, borderStyle: 'dashed', borderColor: color.line, marginHorizontal: 16 }} />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', padding: 16 }}>
          <View style={{ flexShrink: 1 }}>
            {ticket ? <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{eventWhen(ticket.event.startsAt, ticket.event.endsAt)} · {ticket.tierName}</T> : null}
            {ticket ? <T lines={1} style={{ fontFamily: font.bold }}>{ticket.event.venue}</T> : null}
          </View>
          <Display size={32} style={{ color: color.blue }}>#{tokenId}</Display>
        </View>
      </View>
      <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 14, paddingVertical: 8, backgroundColor: expired ? color.amberSoft : color.paper }}>
        <Ic name="hourglass" size={18} />
        <T style={{ fontFamily: font.semibold }}>{expired ? 'Hết hạn · hãy tạo mã mới' : 'Còn hiệu lực '}</T>
        {expired ? null : <T testID="qr-clock" style={{ fontFamily: font.bold }}>{clock(left)}</T>}
      </View>
      {/* The encoded payload, for automated tests and manual entry at the gate. */}
      <T testID="qr-payload" style={{ height: 0, opacity: 0 }}>{qr.encoded}</T>
    </Screen>
  );
}
