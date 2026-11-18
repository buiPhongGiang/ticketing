import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { config, devNames } from '../config';
import { formatAmount } from '../format';
import { useLoad } from '../hooks';
import { color, font } from '../theme';
import { Banner, Btn, Display, Mono, Row, Screen, short, T } from '../ui';
import { createLocalSigner } from '../lib';

export function WalletScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const { data: balance } = useLoad(() => app.service.getBalanceWei(app.wallet.address), [app.wallet.address]);
  return (
    <Screen title="Test wallet" back nav="tickets" footer={<Btn testID="copy-address" label={copied ? 'Address copied' : 'Copy address'} kind="secondary" onPress={async () => { await Clipboard.setStringAsync(app.wallet.address); setCopied(true); }} />}>
      <View style={{ gap: 4 }}>
        <T style={{ fontFamily: font.medium }}>Address</T>
        <Mono testID="full-address" style={{ fontSize: 13, lineHeight: 18 }}>{app.wallet.address}</Mono>
      </View>
      <Row label="Balance" value={balance ? formatAmount(balance, config.nativeSymbol) : '…'} />
      {app.devWallets.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Display>Switch wallet</Display>
          {app.devWallets.map((key, i) => {
            const address = createLocalSigner(key).address;
            const on = address === app.wallet.address;
            return (
              <Pressable key={key} testID={`dev-wallet-${i}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => app.useDevWallet(i)}
                style={{ minHeight: 52, padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: on ? color.ink : color.white, borderWidth: 1, borderColor: color.ink }}>
                <T style={{ fontFamily: font.medium, color: on ? color.white : color.ink }}>{devNames[i] ?? `Wallet ${i}`}</T>
                <Mono style={{ color: on ? color.white : color.ink }}>{short(address)}</Mono>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </Screen>
  );
}
