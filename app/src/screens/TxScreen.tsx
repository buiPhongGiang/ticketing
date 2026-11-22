import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useApp, type Notice } from '../app-context';
import { payOn } from '../config';
import { formatVnd } from '../format';
import { saveReceipt, toReceipt } from '../lib/pay';
import { useEntry } from '../hooks';
import type { JournalEntry } from '../lib/types';
import { messageFor } from '../messages';
import { color } from '../theme';
import { Banner, Btn, Center, Row, Screen, T, TxLink } from '../ui';

const titles: Record<JournalEntry['kind'], string> = {
  buy: 'Đang mua vé', resale: 'Đang mua vé bán lại', list: 'Đang rao bán', unlist: 'Đang gỡ rao bán', refund: 'Hoàn tiền', faucet: 'Tiền thử', checkIn: 'Soát vé',
  waitJoin: 'Đang xếp hàng', waitLeave: 'Đang rời hàng', credit: 'Đang rút tiền',
};

const timing = (e: JournalEntry) => ({ feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs, relayed: e.relayed });

export function noticeFor(e: JournalEntry): Notice {
  const usdc = e.amount ? formatVnd(e.amount) : '';
  const q = Number(e.quantity ?? 1);
  switch (e.kind) {
    case 'buy': return { kind: 'bought', text: `Đã mua ${q} vé · ${usdc}`, ...timing(e) };
    case 'resale': return { kind: 'resale', text: `Đã mua lại vé #${e.tokenId} · ${usdc}`, ...timing(e) };
    case 'list': return { kind: 'listed', text: e.soldTo ? `Vé #${e.tokenId} đã bán cho người đứng đầu hàng · ${usdc}` : `Vé #${e.tokenId} đang rao bán với giá ${usdc}`, ...timing(e) };
    case 'waitJoin': return { kind: 'waiting', text: `Đã xếp hàng chờ vé bán lại · đặt cọc ${usdc}`, ...timing(e) };
    case 'waitLeave': return { kind: 'waiting', text: `Đã rời hàng · nhận lại ${usdc}`, ...timing(e) };
    case 'credit': return { kind: 'refund', text: `Đã rút ${usdc}`, ...timing(e) };
    case 'unlist': return { kind: 'unlisted', text: `Đã gỡ rao bán vé #${e.tokenId}`, ...timing(e) };
    case 'refund': return { kind: 'refund', text: payOn ? `Đã ghi lệnh hoàn ${usdc} · tiền về qua ngân hàng` : `Đã hoàn ${usdc}`, ...timing(e) };
    default: return { kind: 'faucet', text: e.relayed ? 'Đã cộng tiền thử' : `+${formatVnd(1_000_000_000n)} tiền thử`, ...timing(e) };
  }
}

export function TxScreen({ entryId }: { entryId: string }) {
  const app = useApp();
  const entry = useEntry(entryId);

  const leaving = useRef(false);
  useEffect(() => {
    if (entry?.state !== 'succeeded' || leaving.current) return;
    leaving.current = true;
    const done = () => app.reset({ name: 'tickets', notice: noticeFor(entry) });
    if (!(payOn && app.pay && entry.kind === 'refund')) { done(); return; }
    // The refund is final on chain. The đồng go back through the bank: here a mock payout, recorded like a payment.
    app.pay.payout(entry.hash)
      .then(async (r) => { const receipt = toReceipt(r.code, r, entry.eventId); if (receipt) await saveReceipt(app.store, app.wallet.address, receipt); })
      .catch(() => {})
      .finally(done);
  }, [app, entry]);

  if (!entry) return <Screen title="Đang gửi" nav="tickets"><Center /></Screen>;
  const title = titles[entry.kind];
  const details = (
    <View>
      {entry.tokenId ? <Row label="Vé" value={`#${entry.tokenId}`} /> : null}
      {entry.quantity ? <Row label="Số vé" value={entry.quantity} /> : null}
      {entry.amount && entry.kind !== 'unlist' ? <Row label={entry.kind === 'list' ? 'Giá bán' : entry.kind === 'waitJoin' ? 'Tiền cọc' : 'Số tiền'} value={formatVnd(entry.amount)} /> : null}
      {entry.state === 'reverted' ? <Row label="Lý do" value={messageFor(entry.reasonCode)} /> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 }}><T style={{ color: color.muted }}>Giao dịch</T><TxLink hash={entry.hash} /></View>
    </View>
  );
  if (entry.state === 'reverted') {
    return (
      <Screen title={title} nav="tickets" footer={<Btn testID="retry" label="Quay lại" onPress={app.back} />}>
        <Banner testID="tx-failed" tone="orange" icon="x" title="Không thành công" body={entry.kind === 'buy' || entry.kind === 'resale' || entry.kind === 'waitJoin' ? 'Bạn chưa bị trừ tiền.' : undefined} />
        {details}
      </Screen>
    );
  }
  if (entry.state === 'unknown') {
    return (
      <Screen title={title} nav="tickets" ownLookup footer={<Btn testID="lookup" label="Kiểm tra giao dịch" onPress={() => app.service.lookup(entry.id)} />}>
        <Banner testID="tx-unknown" tone="amber" icon="off" title="Chưa rõ kết quả" body="Hãy kiểm tra trước khi thử lại." />
        {details}
      </Screen>
    );
  }
  return (
    <Screen title={title} nav="tickets">
      <Banner testID="tx-pending" tone="amber" icon="clock" title="Sắp xong" body="Đang xác nhận yêu cầu của bạn…" />
      {details}
    </Screen>
  );
}
