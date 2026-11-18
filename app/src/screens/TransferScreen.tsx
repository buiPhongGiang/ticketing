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
    <Screen title="Transfer" back nav="tickets" footer={<>
      {failure ? <T testID="transfer-error" style={{ fontFamily: font.medium }}>{failure}</T> : null}
      <Btn testID="send-transfer" label={`Send #${tokenId}`} onPress={send} disabled={!valid} busy={busy} />
    </>}>
      <View style={{ gap: 8 }}>
        <T style={{ fontFamily: font.medium }}>Recipient</T>
        <TextInput testID="recipient" accessibilityLabel="Recipient address" value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} placeholder="0x…" placeholderTextColor={color.muted}
          style={{ minHeight: 52, padding: 12, fontFamily: font.mono, fontSize: 12, color: color.ink, backgroundColor: color.white, borderWidth: 2, borderColor: color.ink }} />
        {clean && !valid ? <T testID="recipient-invalid" style={{ fontSize: 14 }}>{clean.toLowerCase() === app.wallet.address.toLowerCase() ? 'Your own wallet' : messageFor('InvalidRecipient')}</T> : null}
      </View>
      <Row label="Fee" value={fee ? formatAmount(fee, config.nativeSymbol) : '…'} />
    </Screen>
  );
}
