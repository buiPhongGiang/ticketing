import { expect, test } from 'vitest';
import type { PayOrder } from '../src/app-context';
import { memoryStore } from '../src/lib';
import { loadReceipts, receiptHash, type PayClient, type PayResult } from '../src/lib/pay';
import { createPayFlow, PaidButFailed, type PayStage } from '../src/pay-flow';
import type { Address, Hex, JournalEntry } from '../src/lib/types';

const WALLET = '0x00000000000000000000000000000000000000b1' as Address;
const SALT = `0x${'5a'.repeat(32)}` as Hex;
const orders: Record<'buy' | 'resale' | 'wait', PayOrder> = {
  buy: { kind: 'buy', eventId: '1', tier: 0, quantity: 2, units: '30000000', title: '2 × GA · Saigon Indie Night' },
  resale: { kind: 'resale', tokenId: '31', eventId: '1', units: '16500000', title: 'Vé bán lại #31' },
  wait: { kind: 'wait', eventId: '1', tier: 0, units: '16500000', title: 'Đặt cọc xếp hàng' },
};
const entry = (id: string) => ({ id, kind: 'buy', state: 'pending' }) as unknown as JournalEntry;

/** Records every call that would spend, buy or join; `held` is what the account already holds. */
function setup(kind: 'buy' | 'resale' | 'wait', held = '0', statuses: PayResult[] = []) {
  const calls: string[] = [];
  const stages: PayStage[] = [];
  const done: PayResult = { status: 'done', kind, amountVnd: '780000', method: 'vietqr', hash: '0xb0', tokenIds: ['145', '146'], salt: SALT, receiptHash: receiptHash('VG1', '780000', SALT), recordTx: '0xc0', paidAt: 5 };
  const queue = statuses.length ? [...statuses] : [{ status: 'paid', kind, amountVnd: '780000', method: 'vietqr' } as PayResult, done];
  const store = memoryStore();
  const flow = createPayFlow({
    order: orders[kind], wallet: WALLET, store, wait: async () => {}, polls: 5, onStage: (s) => stages.push(s),
    service: {
      getBalances: async () => ({ native: '0', usdc: held }),
      signBuyOrder: async () => { calls.push('sign'); return { buyer: WALLET, eventId: '1', tier: '0', quantity: '2', deadline: '9', signature: '0x01', permit: { v: 27, r: '0x02', s: '0x03' } }; },
      buy: async () => { calls.push('BUY'); return entry('buy'); },
      buyListing: async () => { calls.push('BUY-LISTING'); return entry('resale'); },
      joinWaitlist: async () => { calls.push('JOIN-LINE'); return entry('wait'); },
      adoptBuy: async (hash) => { calls.push(`adopt ${hash}`); return entry('adopted'); },
    },
    pay: {
      create: async (p) => { calls.push(`create ${p.kind}`); return { code: 'VG1', amountVnd: '780000', expiresAt: 9, bank: { name: 'Demo', account: '0', holder: 'X' } }; },
      mockTransfer: async (code, method) => { calls.push(`BANK ${code} ${method}`); return { bankTxId: 'FT1' }; },
      status: async () => queue.length > 1 ? queue.shift()! : queue[0],
      payout: async () => { throw new Error('unused'); },
      ledger: async () => ({ rows: [] }),
    } satisfies PayClient,
  });
  const spent = () => calls.filter((c) => /^[A-Z-]+( |$)/.test(c));
  return { flow, calls, stages, store, spent };
}

test('opening the payment screen never pays, buys or joins a line: it shows a bank code and waits', async () => {
  for (const kind of ['buy', 'resale', 'wait'] as const) {
    const { flow, calls, spent } = setup(kind);
    expect(await flow.open()).toMatchObject({ stage: 'sheet', intent: { code: 'VG1', amountVnd: '780000' } });
    // Opening it again (a re-render, coming back to the screen) still sends nothing.
    await flow.open();
    expect(spent()).toEqual([]);
    expect(calls.filter((c) => c.startsWith('create'))).toEqual([`create ${kind}`, `create ${kind}`]);
  }
});

test('an account that already holds the amount (a funded test wallet, an earlier payment) is asked to confirm too: nothing happens on open', async () => {
  for (const kind of ['buy', 'resale', 'wait'] as const) {
    const { flow, calls, spent, stages } = setup(kind, '30000000');
    expect(await flow.open()).toEqual({ stage: 'held' });
    await flow.open();
    expect(spent()).toEqual([]);
    expect(calls).toEqual([]); // not even a bank code is asked for
    expect(stages.at(-1)).toBe('held');
    // Only the explicit confirm carries the order out, once.
    await flow.confirm('vietqr');
    expect(spent()).toEqual([{ buy: 'BUY', resale: 'BUY-LISTING', wait: 'JOIN-LINE' }[kind]]);
  }
});

test('confirm before the screen is ready does nothing', async () => {
  const { flow, spent } = setup('resale');
  await expect(flow.confirm('vietqr')).rejects.toMatchObject({ code: 'PayUnknown' });
  expect(spent()).toEqual([]);
});

test('purchase: confirm reports the payment, waits for the bank, then follows the purchase the relayer sent; the receipt is kept on the device', async () => {
  const { flow, calls, stages, store } = setup('buy');
  await flow.open();
  expect((await flow.confirm('momo')).id).toBe('adopted');
  expect(calls).toEqual(['sign', 'create buy', 'BANK VG1 momo', 'adopt 0xb0']);
  expect(stages).toEqual(['opening', 'sheet', 'bank', 'chain', 'chain']);
  expect(await loadReceipts(store, WALLET)).toMatchObject([{ code: 'VG1', amountVnd: '780000', tokenIds: ['145', '146'], recordTx: '0xc0' }]);
});

test('resale and the waitlist: after the bank confirms, the account sends its own transaction, once', async () => {
  const resale = setup('resale');
  await resale.flow.open();
  await resale.flow.confirm('vietqr');
  expect(resale.calls).toEqual(['create resale', 'BANK VG1 vietqr', 'BUY-LISTING']);
  const wait = setup('wait');
  await wait.flow.open();
  await wait.flow.confirm('vietqr');
  expect(wait.calls).toEqual(['create wait', 'BANK VG1 vietqr', 'JOIN-LINE']);
});

test('two taps on confirm make one order', async () => {
  const { flow, spent } = setup('resale');
  await flow.open();
  const [a, b] = await Promise.all([flow.confirm('vietqr'), flow.confirm('vietqr')]);
  expect(a).toBe(b);
  expect(spent()).toEqual(['BANK VG1 vietqr', 'BUY-LISTING']);
});

test('paid but the order failed, an expired code, a bank that never answers: nothing is bought and the reason is kept', async () => {
  const failed = setup('resale', '0', [{ status: 'failed', kind: 'resale', amountVnd: '429000', method: 'vietqr', error: 'NotListed' }]);
  await failed.flow.open();
  const refused = await failed.flow.confirm('vietqr').catch((e) => e);
  expect(refused).toBeInstanceOf(PaidButFailed);
  expect(refused.reason).toBe('NotListed');
  // The screen has to be opened again before anything else can be confirmed.
  await expect(failed.flow.confirm('vietqr')).rejects.toMatchObject({ code: 'PayUnknown' });
  expect(failed.spent().filter((c) => !c.startsWith('BANK'))).toEqual([]);

  const expired = setup('buy', '0', [{ status: 'expired', kind: 'buy', amountVnd: '780000', method: 'vietqr' }]);
  await expired.flow.open();
  await expect(expired.flow.confirm('vietqr')).rejects.toMatchObject({ code: 'PayExpired' });
  const silent = setup('buy', '0', [{ status: 'pending', kind: 'buy', amountVnd: '780000', method: 'vietqr' }]);
  await silent.flow.open();
  await expect(silent.flow.confirm('vietqr')).rejects.toMatchObject({ code: 'Network' });
  expect([...expired.calls, ...silent.calls].some((c) => c.startsWith('adopt') || c === 'BUY')).toBe(false);
  expect(await loadReceipts(silent.store, WALLET)).toEqual([]);
});
