import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useApp, type PayOrder } from '../app-context';
import { formatVnd } from '../format';
import { clock, useMounted, useSecondsLeft } from '../hooks';
import type { PayIntent, PayMethod } from '../lib/pay';
import { codeOf, messageFor } from '../messages';
import { createPayFlow, PaidButFailed, type PayStage } from '../pay-flow';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Mono, Row, Screen, T } from '../ui';

const groupVnd = (v: string) => `${v.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;

type Stage = PayStage | 'failed';

/**
 * Checkout in đồng. The guest sees a bank transfer (VietQR) or MoMo, never a token. This build has no real gateway:
 * the confirm button stands in for the banking app, and from the bank's confirmation on the path is the real one
 * (signed webhook, purchase on chain, receipt hash recorded). The sheet carries no "demo" notes, so two things keep
 * anyone from sending real money: the receiving bank and account are fictional ("Demo Bank", set by the relayer),
 * and the QR is plain text, not a VietQR / NAPAS payload, so no banking app can read it as a transfer.
 *
 * Nothing is paid, bought or joined when this screen opens: every order waits for the confirm button, which names
 * what is bought and for how much (src/pay-flow.ts).
 */
export function PayScreen({ order }: { order: PayOrder }) {
  const app = useApp();
  const mounted = useMounted();
  const [stage, setStage] = useState<Stage>('opening');
  const [intent, setIntent] = useState<PayIntent | null>(null);
  const [method, setMethod] = useState<PayMethod>('vietqr');
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);
  const left = useSecondsLeft(intent ? String(intent.expiresAt) : undefined);
  const flow = useMemo(
    () => createPayFlow({ order, wallet: app.wallet.address, service: app.service, pay: app.pay!, store: app.store, onStage: (s) => { if (mounted.current) setStage(s); } }),
    // One flow per order on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, app.service, app.pay, app.store, app.wallet.address],
  );

  const open = useCallback(async () => {
    setFailure(null); setIntent(null);
    try {
      const r = await flow.open();
      if (mounted.current && r.stage === 'sheet') setIntent(r.intent);
    } catch (e) {
      if (mounted.current) { setFailure(messageFor(codeOf(e))); setStage('failed'); }
    }
  }, [flow, mounted]);

  useEffect(() => { if (!started.current) { started.current = true; void open(); } }, [open]);

  async function confirm() {
    setFailure(null);
    try {
      const entry = await flow.confirm(method);
      if (mounted.current) app.go({ name: 'tx', entryId: entry.id });
    } catch (e) {
      if (!mounted.current) return;
      setFailure(e instanceof PaidButFailed
        ? `Đã nhận tiền nhưng đơn chưa thành công: ${messageFor(e.reason)}. Số tiền vẫn được giữ cho tài khoản này, bạn hãy đặt lại.`
        : messageFor(codeOf(e)));
      setStage('failed');
    }
  }

  const amount = intent ? groupVnd(intent.amountVnd) : formatVnd(order.units);
  const busy = stage === 'bank' || stage === 'chain';
  const held = stage === 'held';
  const expired = stage === 'sheet' && !!intent && left === 0;
  const what = order.kind === 'buy' ? 'Mua' : order.kind === 'resale' ? 'Mua lại' : 'Đặt cọc';
  const footer = stage === 'failed'
    ? <><T testID="pay-error" style={{ fontFamily: font.semibold, color: color.orange }}>{failure}</T><Btn testID="pay-retry" label="Làm lại" kind="dark" onPress={open} /></>
    : expired
      ? <Btn testID="pay-retry" label="Lấy mã thanh toán mới" kind="dark" onPress={open} />
      : <>
          {busy ? <T testID="pay-progress" style={{ fontFamily: font.semibold, color: color.muted }}>{stage === 'bank' ? 'Đang chờ ngân hàng xác nhận…' : order.kind === 'buy' ? 'Đã nhận tiền. Đang phát hành vé…' : 'Đã nhận tiền. Đang hoàn tất đơn…'}</T> : null}
          {held || (busy && !intent)
            ? <Btn testID="pay-confirm-held" accessibilityLabel={`Xác nhận ${what.toLowerCase()} ${amount}`} label={`Xác nhận · ${what} ${amount}`} onPress={confirm} busy={busy} disabled={!held} />
            : <Btn testID="pay-confirm" accessibilityLabel={`${method === 'vietqr' ? 'Tôi đã chuyển khoản' : 'Tôi đã thanh toán MoMo'} ${amount}`} label={method === 'vietqr' ? 'Tôi đã chuyển khoản' : 'Tôi đã thanh toán MoMo'} onPress={confirm} busy={busy} disabled={stage !== 'sheet'} />}
        </>;

  return (
    <Screen title="Thanh toán" back nav="events" footer={footer}>
      <View style={{ alignItems: 'center', gap: 2 }}>
        <T testID="pay-title" lines={2} style={{ color: color.muted, textAlign: 'center' }}>{order.title}</T>
        <Display size={40} testID="pay-amount">{amount}</Display>
      </View>

      {held || (busy && !intent) ? (
        <View testID="pay-held" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: color.paper }}>
          <Ic name="shield" size={22} />
          <T style={{ flex: 1, fontFamily: font.medium }}>Tài khoản này đang được giữ đủ {amount} từ một lần thanh toán trước chưa dùng tới. Bấm xác nhận để dùng số tiền đó cho đơn này; bạn không phải chuyển khoản thêm.</T>
        </View>
      ) : (
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
          {(['vietqr', 'momo'] as const).map((m) => {
            const on = m === method;
            return (
              <Pressable key={m} testID={`pay-${m}`} accessibilityRole="radio" accessibilityLabel={m === 'vietqr' ? 'Chuyển khoản VietQR' : 'Ví MoMo'} accessibilityState={{ selected: on, disabled: busy }} disabled={busy} onPress={() => setMethod(m)}
                style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? color.ink : color.paper }}>
                <T style={{ fontFamily: font.bold, color: on ? color.white : color.ink }}>{m === 'vietqr' ? 'VietQR' : 'MoMo'}</T>
              </Pressable>
            );
          })}
        </View>
      )}

      {held || (busy && !intent) ? null : !intent ? (stage === 'failed' ? null : <Center />) : method === 'vietqr' ? (
        <View testID="pay-sheet" style={{ borderWidth: 1, borderColor: color.paper }}>
          <View accessibilityLabel="Mã QR chuyển khoản" style={{ alignItems: 'center', padding: 18 }}>
            {/* Plain text, never an EMVCo / VietQR payload: a banking app that scans it finds nothing it can pay. */}
            <QRCode value={`VEGOC-DEMO|${intent.code}|${intent.amountVnd}`} size={176} color={expired ? color.line : color.ink} backgroundColor={color.white} ecl="M" />
          </View>
          <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
            <Row label="Ngân hàng" value={intent.bank.name} />
            <Row label="Số tài khoản" value={`${intent.bank.account} · ${intent.bank.holder}`} />
            <CodeRow code={intent.code} copied={copied} onCopy={async () => { await Clipboard.setStringAsync(intent.code); setCopied(true); }} />
          </View>
        </View>
      ) : (
        <View testID="pay-sheet" style={{ borderWidth: 1, borderColor: color.paper }}>
          {/* The app's own colours, no wallet brand mark: this sheet is not MoMo's checkout. */}
          <View style={{ backgroundColor: color.paper, paddingHorizontal: 16, paddingVertical: 14 }}>
            <T style={{ fontFamily: font.bold }}>Trả bằng ví MoMo</T>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Mở MoMo, chuyển đúng số tiền với nội dung bên dưới.</T>
          </View>
          <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
            <Row label="Người nhận" value={intent.bank.holder} />
            <Row label="Số tiền" value={amount} />
            <CodeRow code={intent.code} copied={copied} onCopy={async () => { await Clipboard.setStringAsync(intent.code); setCopied(true); }} />
          </View>
        </View>
      )}

      {intent && stage === 'sheet' ? (
        <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 14, paddingVertical: 8, backgroundColor: expired ? color.amberSoft : color.paper }}>
          <Ic name="hourglass" size={18} />
          <T testID="pay-clock" style={{ fontFamily: font.semibold }}>{expired ? 'Mã đã hết hạn' : `Mã còn hiệu lực ${clock(left)}`}</T>
        </View>
      ) : null}
    </Screen>
  );
}

function CodeRow({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12 }}>
      <T style={{ color: color.muted }}>Nội dung chuyển khoản</T>
      <Pressable testID="pay-code-copy" accessibilityRole="button" accessibilityLabel={`Chép mã chuyển khoản ${code}`} onPress={onCopy} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
        <Mono testID="pay-code" style={{ fontFamily: font.bold, fontSize: 16, letterSpacing: 1 }}>{code}</Mono>
        <T style={{ fontFamily: font.bold, fontSize: 13, color: color.blue }}>{copied ? 'Đã chép' : 'Chép'}</T>
      </Pressable>
    </View>
  );
}
