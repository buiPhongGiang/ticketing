import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useApp } from '../app-context';
import { clock, useSecondsLeft } from '../hooks';
import type { QrPayload } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Center, Display, Screen, T } from '../ui';

export function QrScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
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

  const title = 'QR vào cửa';
  if (failure) return <Screen title={title} back nav="tickets"><T testID="qr-error">{failure}</T></Screen>;
  if (!qr) return <Screen title={title} back nav="tickets"><Center /></Screen>;
  return (
    <Screen title={title} back nav="tickets" footer={expired
      ? <Btn testID="resign" label="Ký QR mới" onPress={sign} />
      : <Btn testID="copy-qr" label={copied ? 'Đã sao chép mã' : 'Sao chép mã'} kind="secondary" onPress={async () => { await Clipboard.setStringAsync(qr.encoded); setCopied(true); }} />}>
      <View testID="qr" accessibilityLabel="Mã QR vào cửa" style={{ backgroundColor: color.white, padding: 25, alignItems: 'center' }}>
        <QRCode value={qr.encoded} size={280} color={expired ? color.line : color.ink} backgroundColor={color.white} ecl="M" />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <T style={{ fontFamily: font.medium }}>Vé #{tokenId} · {expired ? 'Đã hết hạn' : 'Còn hiệu lực'}</T>
        <Display size={44} testID="qr-clock" style={{ color: expired ? color.muted : color.ink }}>{clock(left)}</Display>
      </View>
      <T style={{ color: color.muted }}>{expired ? 'Mã không tự gia hạn. Bạn ký lại bằng ví để có mã mới.' : 'Đưa mã này cho nhân viên soát vé. Mã chỉ đúng khi ví của bạn vẫn đang giữ vé.'}</T>
      {/* The encoded payload, for automated tests and manual entry at the gate. */}
      <T testID="qr-payload" style={{ height: 0, opacity: 0 }}>{qr.encoded}</T>
    </Screen>
  );
}
