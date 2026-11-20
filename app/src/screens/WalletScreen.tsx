import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { config, demoMode, devNames, relayerUrl } from '../config';
import { formatAmount, formatUsdc } from '../format';
import { useLoad } from '../hooks';
import { color, font } from '../theme';
import { Btn, Display, Mono, Row, Screen, short, T } from '../ui';
import { createLocalSigner } from '../lib';

export function WalletScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const { data: balances } = useLoad(() => app.service.getBalances(app.wallet.address), [app.wallet.address]);
  // A guest's account: the key was made on this phone at first launch and stays in its secure storage.
  if (!demoMode) {
    return (
      <Screen title="Account" back nav="tickets" footer={
        // Gate staff send this to the organizer, who grants the device in the console.
        <Pressable testID="copy-device-id" accessibilityRole="button" onPress={async () => { await Clipboard.setStringAsync(app.wallet.address); setCopied(true); }} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ color: color.muted, fontSize: 13 }}>{copied ? 'Device ID copied' : 'Gate staff: copy device ID'}</T>
        </Pressable>}>
        <Row label="USDC" testID="wallet-usdc" value={balances ? formatUsdc(balances.usdc) : '…'} />
        <T testID="account-note" style={{ color: color.muted }}>{relayerUrl ? 'Your tickets stay on this phone. No fees to pay.' : 'Your tickets stay on this phone.'}</T>
      </Screen>
    );
  }
  return (
    <Screen title="Test wallet" back nav="tickets" footer={<Btn testID="copy-address" label={copied ? 'Address copied' : 'Copy address'} kind="secondary" onPress={async () => { await Clipboard.setStringAsync(app.wallet.address); setCopied(true); }} />}>
      <View style={{ gap: 4 }}>
        <T style={{ fontFamily: font.medium }}>Address</T>
        <Mono testID="full-address" style={{ fontSize: 13, lineHeight: 18 }}>{app.wallet.address}</Mono>
      </View>
      <View>
        <Row label="USDC" testID="wallet-usdc" value={balances ? formatUsdc(balances.usdc) : '…'} />
        <Row label={config.nativeSymbol} value={balances ? formatAmount(balances.native, config.nativeSymbol) : '…'} />
      </View>
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
