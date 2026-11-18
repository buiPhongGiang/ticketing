import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useApp, type Notice } from '../app-context';
import { formatUsdc } from '../format';
import { useEntry } from '../hooks';
import type { JournalEntry } from '../lib/types';
import { messageFor } from '../messages';
import { color } from '../theme';
import { Banner, Btn, Center, Row, Screen, T, TxLink } from '../ui';

const titles: Record<JournalEntry['kind'], string> = {
  buy: 'Buying', resale: 'Buying resale', list: 'Listing', unlist: 'Unlisting', refund: 'Refund', faucet: 'Test USDC', checkIn: 'Check-in',
  waitJoin: 'Joining the line', waitLeave: 'Leaving the line', credit: 'Withdrawing',
};

export function noticeFor(e: JournalEntry): Notice {
  const usdc = e.amount ? `${formatUsdc(e.amount)} USDC` : '';
  const q = Number(e.quantity ?? 1);
  switch (e.kind) {
    case 'buy': return { kind: 'bought', text: `Bought ${q} ticket${q === 1 ? '' : 's'} · ${usdc}`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'resale': return { kind: 'resale', text: `Bought #${e.tokenId} on resale · ${usdc}`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'list': return { kind: 'listed', text: e.soldTo ? `#${e.tokenId} sold to the first in line · ${usdc}` : `#${e.tokenId} listed for ${usdc}`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'waitJoin': return { kind: 'waiting', text: `In line for a resale ticket · ${usdc} paid in`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'waitLeave': return { kind: 'waiting', text: `Left the line · ${usdc} back`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'credit': return { kind: 'refund', text: `Withdrew ${usdc}`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'unlist': return { kind: 'unlisted', text: `#${e.tokenId} unlisted`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    case 'refund': return { kind: 'refund', text: `Refunded ${usdc}`, feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
    default: return { kind: 'faucet', text: '+1,000.00 test USDC', feeWei: e.feeWei, confirmedMs: e.confirmedMs, blockMs: e.blockMs };
  }
}

export function TxScreen({ entryId }: { entryId: string }) {
  const app = useApp();
  const entry = useEntry(entryId);

  useEffect(() => {
    if (entry?.state === 'succeeded') app.reset({ name: 'tickets', notice: noticeFor(entry) });
  }, [app, entry]);

  if (!entry) return <Screen title="Sending" nav="tickets"><Center /></Screen>;
  const title = titles[entry.kind];
  const details = (
    <View>
      {entry.tokenId ? <Row label="Ticket" value={`#${entry.tokenId}`} /> : null}
      {entry.quantity ? <Row label="Tickets" value={entry.quantity} /> : null}
      {entry.amount && entry.kind !== 'unlist' ? <Row label={entry.kind === 'list' ? 'Price' : entry.kind === 'waitJoin' ? 'Deposit' : 'Amount'} value={`${formatUsdc(entry.amount)} USDC`} /> : null}
      {entry.state === 'reverted' ? <Row label="Reason" value={messageFor(entry.reasonCode)} /> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 }}><T style={{ color: color.muted }}>Transaction</T><TxLink hash={entry.hash} /></View>
    </View>
  );
  if (entry.state === 'reverted') {
    return (
      <Screen title={title} nav="tickets" footer={<Btn testID="retry" label="Back" onPress={app.back} />}>
        <Banner testID="tx-failed" tone="orange" icon="x" title="Failed" body={entry.kind === 'buy' || entry.kind === 'resale' || entry.kind === 'waitJoin' ? 'No USDC was taken.' : undefined} />
        {details}
      </Screen>
    );
  }
  if (entry.state === 'unknown') {
    return (
      <Screen title={title} nav="tickets" ownLookup footer={<Btn testID="lookup" label="Look up transaction" onPress={() => app.service.lookup(entry.id)} />}>
        <Banner testID="tx-unknown" tone="amber" icon="off" title="Result unknown" body="Look it up before trying again." />
        {details}
      </Screen>
    );
  }
  return (
    <Screen title={title} nav="tickets">
      <Banner testID="tx-pending" tone="amber" icon="clock" title="Confirming" />
      {details}
    </Screen>
  );
}
