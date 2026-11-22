import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { fetchLedger, readRecorded, reconcile, totals, type ChainRecord, type LedgerRow } from '../src/recon';
import { extendedEnd } from '../src/model';
import { failureText } from '../src/errors';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const row = (n: number, over: Partial<LedgerRow> = {}): LedgerRow => ({ receiptHash: H(n), kind: 'buy', amountVnd: '390000', method: 'vietqr', eventId: '1', tokenIds: ['10'], paidAt: 1000 + n, hash: H(900 + n), recordTx: H(800 + n), status: 'done', ...over });
const rec = (n: number, tokenIds: number[], kind: ChainRecord['kind'] = 'buy'): ChainRecord => ({ receiptHash: H(n), kind, tokenIds, tx: H(700 + n), block: BigInt(n) });
// Tickets 10–19 belong to event 1, 20–29 to event 2.
const eventOf = (id: number) => (id >= 10 && id < 20 ? 1 : id >= 20 && id < 30 ? 2 : undefined);

describe('Đối soát: backend payments against the hashes on chain', () => {
  test('a payment is matched when the chain holds the same hash; the chain record names the tickets', () => {
    const rows = reconcile([row(1, { tokenIds: ['10', '11'], amountVnd: '780000' })], [rec(1, [10, 11])], 1, eventOf);
    expect(rows).toEqual([{ receiptHash: H(1), kind: 'buy', state: 'matched', amountVnd: 780_000n, method: 'vietqr', tokenIds: [10, 11], paidAt: 1001, hash: H(901), recordTx: H(701), failed: false }]);
  });

  test('only this event, newest first; one side missing shows as ledger-only or chain-only', () => {
    const ledger = [row(1), row(2, { tokenIds: ['20'], eventId: '2' }), row(3, { kind: 'wait', tokenIds: [], recordTx: undefined, hash: undefined }), row(4, { status: 'failed', tokenIds: [], hash: undefined, recordTx: undefined })];
    const chain = [rec(1, [10]), rec(2, [20]), rec(9, [12], 'refund'), rec(8, [25])];
    const rows = reconcile(ledger, chain, 1, eventOf);
    expect(rows.map((r) => [r.receiptHash, r.state, r.failed])).toEqual([[H(4), 'ledger', true], [H(3), 'ledger', false], [H(1), 'matched', false], [H(9), 'chain', false]]);
    expect(rows[3]).toMatchObject({ kind: 'refund', amountVnd: null, tokenIds: [12], recordTx: H(709) });
    expect(reconcile(ledger, chain, 2, eventOf).map((r) => r.receiptHash)).toEqual([H(2), H(8)]);
    expect(reconcile(ledger, chain, 7, eventOf)).toEqual([]);
  });

  test('totals: đồng in and out; a waitlist deposit off chain is normal, a failed order or a missing side is open', () => {
    const rows = reconcile(
      [row(1), row(2, { kind: 'resale', amountVnd: '429000', tokenIds: ['11'] }), row(3, { kind: 'wait', amountVnd: '429000', tokenIds: [], recordTx: undefined }), row(4, { kind: 'refund', method: 'bank', tokenIds: ['12'], eventId: undefined }), row(5, { status: 'failed', tokenIds: [] })],
      [rec(1, [10]), rec(2, [11], 'resale'), rec(4, [12], 'refund'), rec(6, [13])], 1, eventOf);
    expect(totals(rows)).toEqual({ received: 390_000n + 429_000n + 429_000n + 390_000n, paidOut: 390_000n, payments: 6, matched: 3, open: 2 });
    expect(totals([])).toEqual({ received: 0n, paidOut: 0n, payments: 0, matched: 0, open: 0 });
  });

  test('chain records: PaymentRecorded logs read in chunks and grouped by hash', async () => {
    const ranges: [bigint, bigint][] = [];
    const logs = [
      { args: { tokenId: 10n, kind: 0, receiptHash: H(1) }, transactionHash: H(701), blockNumber: 105n },
      { args: { tokenId: 11n, kind: 0, receiptHash: H(1) }, transactionHash: H(701), blockNumber: 105n },
      { args: { tokenId: 12n, kind: 2, receiptHash: H(2) }, transactionHash: H(702), blockNumber: 230n },
    ];
    const client = {
      getBlockNumber: async () => 250n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => { ranges.push([fromBlock, toBlock]); return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock); },
    };
    const out = await readRecorded(client as never, '0x00000000000000000000000000000000000000aa' as Address, 100n, 100n);
    expect(ranges).toEqual([[100n, 199n], [200n, 250n]]);
    expect(out).toEqual([{ receiptHash: H(1), kind: 'buy', tokenIds: [10, 11], tx: H(701), block: 105n }, { receiptHash: H(2), kind: 'refund', tokenIds: [12], tx: H(702), block: 230n }]);
  });

  test('the backend list is fetched with POST and tolerates an empty answer', async () => {
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => { seen.push(`${init.method} ${url}`); return { ok: true, json: async () => ({ rows: [row(1)] }) }; }) as unknown as typeof fetch;
    expect(await fetchLedger('/relay/', ok)).toHaveLength(1);
    expect(seen).toEqual(['POST /relay/pay/ledger']);
    expect(await fetchLedger('/relay', (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch)).toEqual([]);
    await expect(fetchLedger('/relay', (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch)).rejects.toThrow('ledger 502');
  });
});

describe('extending an event', () => {
  test('the new end is the current end plus whole minutes', () => {
    expect(extendedEnd(1_800_000_000, 30)).toBe(1_800_001_800);
    expect(extendedEnd(1_800_000_000, 120)).toBe(1_800_007_200);
    expect(extendedEnd(1_800_000_000, 0)).toBe(1_800_000_060);
  });

  test('a contract error can be worded for the action it happened in', () => {
    const bad = { data: { errorName: 'BadEvent' } };
    expect(failureText(bad)).toBe('Kiểm tra lại tên và ngày giờ.');
    expect(failureText(bad, { BadEvent: 'Over the limit: an event can be extended by 24 h in total.' })).toBe('Over the limit: an event can be extended by 24 h in total.');
    expect(failureText({ errorName: 'NotFinal' })).toMatch(/còn đang diễn ra/);
    // A sentence the console wrote itself is shown as it is; anything else from a wallet or RPC is not.
    expect(failureText({ cause: { plain: true, shortMessage: 'Đang ở chế độ chỉ xem.' } })).toBe('Đang ở chế độ chỉ xem.');
    expect(failureText({ cause: { shortMessage: 'some raw RPC text' } })).toBe('Giao dịch không thành công.');
  });
});
