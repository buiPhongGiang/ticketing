import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../app-context';
import { eventDate } from '../format';
import { useLoad } from '../hooks';
import { checkReceipt, loadReceipts, type Receipt, type ReceiptCheck } from '../lib/pay';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Display, Ic, Mono, Row, Screen, T, TxLink } from '../ui';

const groupVnd = (v: string) => `${v.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
export const RECEIPT_TITLE: Record<Receipt['kind'], string> = { buy: 'Mua vé', resale: 'Mua vé bán lại', wait: 'Đặt cọc xếp hàng', refund: 'Hoàn tiền về ngân hàng', payout: 'Chi trả về ngân hàng' };
export const methodName = (m: Receipt['method']) => (m === 'momo' ? 'Ví MoMo' : m === 'bank' ? 'Ngân hàng chi trả' : 'Chuyển khoản VietQR');
export const receiptAmount = (r: Receipt) => groupVnd(r.amountVnd);

/**
 * The buyer's copy of one VND payment, and a check anyone can repeat: hash the bank code, the amount and the salt
 * on this device, then compare with what PaymentReceipts holds for the ticket.
 */
export function ReceiptScreen({ code }: { code: string }) {
  const app = useApp();
  const { data: receipts } = useLoad(() => loadReceipts(app.store, app.wallet.address), [app.wallet.address]);
  const [check, setCheck] = useState<ReceiptCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const r = receipts?.find((x) => x.code === code);
  if (!receipts) return <Screen title="Biên nhận" back nav="tickets"><Center /></Screen>;
  if (!r) return <Screen title="Biên nhận" back nav="tickets"><T testID="receipt-missing">Biên nhận này không có trên thiết bị.</T></Screen>;

  async function verify() {
    setBusy(true); setFailure(null); setCheck(null);
    try {
      setCheck(await checkReceipt(r!, (tokenId) => app.service.receiptsOf(tokenId)));
    } catch (e) {
      setFailure(messageFor(codeOf(e) === 'Unknown' ? 'Network' : codeOf(e)));
    } finally { setBusy(false); }
  }

  const onChain = r.tokenIds.length > 0 && !!r.recordTx;
  return (
    <Screen title="Biên nhận" back nav="tickets" footer={onChain ? <>
      {failure ? <T testID="receipt-error" style={{ fontFamily: font.semibold, color: color.orange }}>{failure}</T> : null}
      <Btn testID="receipt-check" accessibilityLabel="Kiểm tra biên nhận với bản ghi công khai" label="Kiểm tra" kind="dark" busy={busy} onPress={verify} />
    </> : undefined}>
      <View style={{ gap: 2 }}>
        <T style={{ color: color.muted }}>{RECEIPT_TITLE[r.kind]} · {methodName(r.method)}</T>
        <Display size={36} testID="receipt-amount">{receiptAmount(r)}</Display>
        {r.paidAt ? <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{eventDate(r.paidAt)}</T> : null}
      </View>

      {check?.ok ? (
        <View testID="receipt-ok" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: color.greenSub }}>
          <Ic name="check" size={22} />
          <View style={{ flex: 1, gap: 2 }}>
            <Display size={20}>Khớp với bản ghi công khai</Display>
            <T style={{ fontFamily: font.medium }}>{`Vé #${r.tokenIds.join(', #')} mang đúng mã băm của khoản này, ghi lúc ${eventDate(check.at)}.`}</T>
          </View>
        </View>
      ) : null}
      {check && !check.ok ? <Banner testID="receipt-bad" tone="orange" icon="x" title="Không khớp" body={check.reason === 'tampered' ? 'Mã, số tiền hoặc chuỗi ngẫu nhiên trên thiết bị không còn cho ra mã băm của biên nhận.' : check.reason === 'missing' ? 'Bản ghi công khai không có mã băm này cho vé.' : 'Khoản này chưa gắn với vé nào để so.'} /> : null}

      <View>
        <Row label="Mã chuyển khoản" value={r.code} testID="receipt-code" />
        {r.bankTxId ? <Row label="Mã giao dịch ngân hàng" value={r.bankTxId} /> : null}
        <Row label="Số tiền" value={`${r.amountVnd} VND`} />
        {r.tokenIds.length ? <Row label="Vé" value={r.tokenIds.map((t) => `#${t}`).join(', ')} /> : null}
        <Field label="Chuỗi ngẫu nhiên (salt)" value={r.salt} testID="receipt-salt" />
        <Field label="Mã băm = keccak256(mã, số tiền, salt)" value={r.receiptHash} testID="receipt-hash" />
        {r.hash ? <Link label={r.kind === 'refund' ? 'Lệnh hoàn tiền' : 'Giao dịch mua'} hash={r.hash} /> : null}
        {r.recordTx ? <Link label="Ghi mã băm" hash={r.recordTx} /> : null}
      </View>

      <T testID="receipt-note" style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>
        {onChain
          ? 'Bản ghi công khai chỉ lưu mã băm. Nó cho biết vé này gắn với khoản thanh toán nào và ghi lúc nào; còn việc ngân hàng đã chuyển tiền là do cổng thanh toán xác nhận.'
          : 'Tiền cọc xếp hàng chưa gắn với vé nào nên chỉ nằm trong sổ thanh toán.'}
      </T>
    </Screen>
  );
}

function Field({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={{ gap: 2, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.paper }}>
      <T style={{ color: color.muted }}>{label}</T>
      <Mono testID={testID} style={{ fontSize: 12, lineHeight: 17 }}>{value}</Mono>
    </View>
  );
}

function Link({ label, hash }: { label: string; hash: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.paper }}>
      <T style={{ color: color.muted }}>{label}</T>
      <TxLink hash={hash} />
    </View>
  );
}
