import React, { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { isAddress } from 'viem';
import { useApp } from '../app-context';
import { config } from '../config';
import { formatAmount } from '../format';
import { useMounted } from '../hooks';
import type { Address } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Row, Screen, T } from '../ui';

export function TransferScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const [to, setTo] = useState('');
  const [fee, setFee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  const clean = to.trim();
  const valid = isAddress(clean, { strict: false }) && clean.toLowerCase() !== app.wallet.address.toLowerCase();

  useEffect(() => {
    setFee(null);
    if (!valid) return;
    let live = true;
    app.service.estimateTransferFeeWei(tokenId, clean as Address).then((f) => { if (live) setFee(f); }).catch(() => {});
    return () => { live = false; };
  }, [app.service, clean, tokenId, valid]);

  async function send() {
    setBusy(true); setFailure(null);
    try {
      await app.service.transfer(tokenId, clean as Address);
      if (mounted.current) app.back();
    } catch (e) {
      if (!mounted.current) return;
      setFailure(messageFor(codeOf(e)));
      setBusy(false);
    }
  }

  return (
    <Screen title="Chuyển vé" back nav="tickets" footer={<>
      {failure ? <T testID="transfer-error" style={{ fontFamily: font.medium }}>{failure}</T> : null}
      <Btn testID="send-transfer" label={`Chuyển vé #${tokenId}`} onPress={send} disabled={!valid} busy={busy} />
    </>}>
      <View style={{ gap: 8 }}>
        <T style={{ fontFamily: font.medium }}>Địa chỉ ví nhận</T>
        <TextInput testID="recipient" accessibilityLabel="Địa chỉ ví nhận" value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} placeholder="0x…" placeholderTextColor={color.muted}
          style={{ minHeight: 52, padding: 12, fontFamily: font.mono, fontSize: 12, color: color.ink, backgroundColor: color.white, borderWidth: 2, borderColor: color.ink }} />
        {clean && !valid ? <T testID="recipient-invalid" style={{ fontSize: 14 }}>{clean.toLowerCase() === app.wallet.address.toLowerCase() ? 'Đây là ví của bạn.' : messageFor('InvalidRecipient')}</T> : null}
      </View>
      <View>
        <Row label="Vé" value={`#${tokenId}`} />
        <Row label="Phí mạng (ước tính)" value={fee ? formatAmount(fee, config.nativeSymbol) : '…'} />
      </View>
      <View style={{ padding: 16, backgroundColor: color.ink, gap: 4 }}>
        <T style={{ fontFamily: font.semibold, color: color.white }}>Bạn không thể tự lấy lại vé</T>
        <T style={{ fontSize: 14, lineHeight: 20, color: color.darkMuted }}>Sau khi chuyển, chỉ ví nhận mới vào cửa được và QR bạn đã tạo sẽ bị từ chối. Tiền mua bán lại không đi qua ứng dụng này.</T>
      </View>
    </Screen>
  );
}
