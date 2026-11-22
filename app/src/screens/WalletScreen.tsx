import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import type { IconKey } from '../art';
import { config, demoMode, devNames, payOn, relayerUrl } from '../config';
import { formatAmount, formatVnd } from '../format';
import { useLoad } from '../hooks';
import { createLocalSigner } from '../lib';
import { loadReceipts, type Receipt } from '../lib/pay';
import { eventDate } from '../format';
import { methodName, receiptAmount, RECEIPT_TITLE } from './ReceiptScreen';
import { color, font } from '../theme';
import { Display, Ic, Mono, Screen, short, T } from '../ui';

/** The money card at the top of the wallet: what this account can spend, in đồng. */
function BalanceCard({ usdc, native }: { usdc?: string; native?: string }) {
  return (
    <View style={{ backgroundColor: color.blue, padding: 20, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ic name="wallet" size={22} tint={color.white} />
        <T style={{ color: color.blueSub, fontFamily: font.semibold }}>Số dư</T>
      </View>
      <Display size={36} testID="wallet-usdc" style={{ color: color.white }}>{usdc !== undefined ? formatVnd(usdc) : '…'}</Display>
      {native !== undefined ? <T style={{ color: color.blueSub, fontSize: 13, lineHeight: 18 }}>{formatAmount(native, config.nativeSymbol)} để trả phí mạng</T> : null}
    </View>
  );
}

export function WalletScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const { data: balances } = useLoad(() => app.service.getBalances(app.wallet.address), [app.wallet.address]);
  const copy = async () => { await Clipboard.setStringAsync(app.wallet.address); setCopied(true); };

  // A guest's account: the key was made on this phone at first launch and stays in its secure storage.
  if (!demoMode) {
    return (
      <Screen title={payOn ? 'Tài khoản' : 'Ví'} back nav="tickets">
        {payOn ? null : <BalanceCard usdc={balances?.usdc} />}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: color.paper }}>
          <Ic name="shield" size={22} />
          <T testID="account-note" style={{ flex: 1, fontFamily: font.medium }}>{payOn ? 'Vé nằm trên điện thoại này. Bạn trả bằng đồng qua chuyển khoản hoặc MoMo, không mất thêm phí.' : relayerUrl ? 'Vé nằm trên điện thoại này. Không mất phí.' : 'Vé nằm trên điện thoại này.'}</T>
        </View>
        {payOn ? <Receipts /> : null}
        {/* Gate staff: open the gate with the organizer's PIN, or send this device's ID to be granted in the console. */}
        {app.enterGate ? (
          <Pressable testID="open-gate" accessibilityRole="button" onPress={() => app.go({ name: 'gate-pin' })} style={styles.staffRow}>
            <Ic name="scan" size={18} />
            <T style={{ flex: 1, fontFamily: font.semibold }}>Nhân viên soát vé? Mở cổng</T>
            <Ic name="next" size={18} tint={color.muted} />
          </Pressable>
        ) : (
          <Pressable testID="copy-device-id" accessibilityRole="button" onPress={copy} style={styles.staffRow}>
            <Ic name="scan" size={18} />
            <T style={{ flex: 1, fontFamily: font.semibold }}>{copied ? 'Đã chép mã thiết bị' : 'Nhân viên soát vé? Chép mã thiết bị'}</T>
          </Pressable>
        )}
      </Screen>
    );
  }

  return (
    <Screen title="Ví thử" back nav="tickets">
      <BalanceCard usdc={balances?.usdc} native={balances?.native} />

      <View style={{ gap: 6, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Địa chỉ</T>
          <Pressable testID="copy-address" accessibilityRole="button" onPress={copy}
            style={{ minHeight: 36, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: copied ? color.greenSub : color.paper }}>
            <T style={{ fontFamily: font.bold, fontSize: 13 }}>{copied ? 'Đã chép' : 'Chép'}</T>
          </Pressable>
        </View>
        <Mono testID="full-address" style={{ fontSize: 11.5, lineHeight: 16 }}>{app.wallet.address}</Mono>
      </View>

      {app.devWallets.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Display size={18}>Đổi tài khoản</Display>
          {app.devWallets.map((key, i) => {
            const address = createLocalSigner(key).address;
            const on = address === app.wallet.address;
            const name = devNames[i] ?? `Ví ${i + 1}`;
            const glyph: IconKey = /gate|soát/i.test(name) ? 'scan' : 'ticket';
            return (
              <Pressable key={key} testID={`dev-wallet-${i}`} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={name} onPress={() => app.useDevWallet(i)}
                style={{ minHeight: 64, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: on ? color.blueSub : color.paper, borderWidth: 2, borderColor: on ? color.blue : color.paper }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.white }}>
                  <Ic name={glyph} size={18} />
                </View>
                <View style={{ flex: 1 }}>
                  <T style={{ fontFamily: font.bold }}>{name}</T>
                  <Mono style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{short(address)}</Mono>
                </View>
                {on ? <Ic name="check" size={18} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </Screen>
  );
}

/** Every VND payment made from this device, newest first. The codes and salts live here only. */
function Receipts() {
  const app = useApp();
  const { data: receipts } = useLoad(() => loadReceipts(app.store, app.wallet.address), [app.wallet.address]);
  return (
    <View testID="receipts" style={{ gap: 8 }}>
      <Display size={18}>Các lần thanh toán</Display>
      {receipts && receipts.length === 0 ? <T testID="receipts-empty" style={{ color: color.muted }}>Chưa có khoản nào. Biên nhận hiện ở đây sau khi bạn mua vé.</T> : null}
      {receipts?.map((r: Receipt) => (
        <Pressable key={r.code} testID={`receipt-${r.code}`} accessibilityRole="button" accessibilityLabel={`Mở biên nhận ${r.code}`} onPress={() => app.go({ name: 'receipt', code: r.code })} style={[styles.staffRow, { paddingVertical: 10 }]}>
          <View style={{ flex: 1 }}>
            <T style={{ fontFamily: font.semibold }}>{RECEIPT_TITLE[r.kind]}{r.tokenIds.length ? ` · #${r.tokenIds.join(', #')}` : ''}</T>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{methodName(r.method)}{r.paidAt ? ` · ${eventDate(r.paidAt)}` : ''}</T>
          </View>
          <T style={{ fontFamily: font.bold }}>{r.kind === 'refund' || r.kind === 'payout' ? '+' : ''}{receiptAmount(r)}</T>
          <Ic name="next" size={18} tint={color.muted} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = {
  staffRow: { minHeight: 56, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: 14, backgroundColor: color.paper },
};
