import { expect, test } from 'vitest';
import { encodePacked, keccak256 } from 'viem';
import { createPayments, sign, type PayChain } from '../scripts/payments';
import { checkReceipt, loadReceipts, receiptHash, saveReceipt, toReceipt, vndOfUnits, type PayPurpose, type Receipt } from '../src/lib/pay';
import { memoryStore } from '../src/lib';
import { ServiceError, type Address, type Hex } from '../src/lib/types';

const SECRET = 'test-webhook-secret-0123456789';
const BUYER = '0x00000000000000000000000000000000000000b1' as Address;
const SALT = `0x${'5a'.repeat(32)}` as Hex;
const order = { buyer: BUYER, eventId: '1', tier: '0', quantity: '2', deadline: '9', signature: '0x01' as Hex, permit: { v: 27, r: '0x02' as Hex, s: '0x03' as Hex } };
const buy: PayPurpose = { kind: 'buy', order };

/** A chain that records what it was asked to do, in order. 15 USDC a ticket = 390.000đ. */
function fakeChain(over: Partial<PayChain> = {}) {
  const calls: string[] = [];
  const chain: PayChain = {
    quote: async (p) => ({ units: p.kind === 'buy' ? 30_000_000n : p.kind === 'resale' ? 16_500_000n : 16_500_000n, buyer: BUYER, eventId: '1', tokenId: p.kind === 'resale' ? p.tokenId : undefined }),
    fund: async (to, units) => { calls.push(`fund ${to} ${units}`); return { hash: '0xf0' }; },
    topUp: async (to) => { calls.push(`topUp ${to}`); return {}; },
    buy: async (o) => { calls.push(`buy ${o.eventId}/${o.tier}×${o.quantity}`); return { hash: '0xb0' }; },
    minted: async () => ['145', '146'],
    record: async (ids, kind, hash) => { calls.push(`record ${ids.join(',')} kind ${kind} ${hash}`); return { hash: '0xc0' }; },
    refundOf: async () => null,
    ...over,
  };
  return { chain, calls };
}
function start(over: Partial<PayChain> = {}, ttl = 900) {
  let t = 1_795_300_000_000;
  const f = fakeChain(over);
  let n = 0;
  const pay = createPayments({ chain: f.chain, secret: SECRET, ttl, now: () => t, random: (bytes) => Uint8Array.from({ length: bytes }, () => (n += 7) % 256) });
  return { ...f, pay, tick: (ms: number) => { t += ms; } };
}
const hook = (body: object) => { const raw = JSON.stringify(body); return [raw, sign(SECRET, raw)] as const; };

test('receipt hash: keccak256(abi.encodePacked(bankCode, amountVnd, salt)), the formula PaymentReceipts.hashOf uses', () => {
  const h = receiptHash('VG7K2M9QXA', '780000', SALT);
  expect(h).toBe(keccak256(encodePacked(['string', 'uint256', 'bytes32'], ['VG7K2M9QXA', 780_000n, SALT])));
  expect(receiptHash('VG7K2M9QXA', '780001', SALT)).not.toBe(h);
  expect(receiptHash('VG7K2M9QXB', '780000', SALT)).not.toBe(h);
  expect(receiptHash('VG7K2M9QXA', '780000', `0x${'5b'.repeat(32)}`)).not.toBe(h);
});

test('đồng from settlement units at 26,000 đ: 15 units → 390.000đ, rounded to the nearest đồng', () => {
  expect(vndOfUnits(15_000_000n)).toBe(390_000n);
  expect(vndOfUnits(16_500_000n)).toBe(429_000n);
  expect(vndOfUnits(1n)).toBe(0n);
  expect(vndOfUnits(20n)).toBe(1n);
});

test('the amount comes from the chain; the salt and hash stay hidden until the bank confirms', async () => {
  const { pay } = start();
  const intent = await pay.create(buy);
  expect(intent.amountVnd).toBe('780000');
  expect(intent.code).toMatch(/^VG[A-HJ-NP-Z2-9]{8}$/);
  // The receiving account is fictional and says so in its own name: no real bank, no number that could exist.
  expect(intent.bank).toEqual({ name: 'Demo Bank', account: '0000 2026 1122', holder: 'VE GOC DEMO' });
  expect(pay.status(intent.code)).toEqual({ status: 'pending', kind: 'buy', amountVnd: '780000', method: 'vietqr' });
});

test('a webhook is accepted only with the HMAC of its exact body, the right amount and an unused code', async () => {
  const { pay, calls } = start();
  const { code } = await pay.create(buy);
  const [raw, sig] = hook({ code, amountVnd: '780000', bankTxId: 'FT1', method: 'momo' });
  expect(pay.webhook(raw, undefined).status).toBe(401);
  expect(pay.webhook(raw, sign('another-secret-0123456789', raw)).status).toBe(401);
  expect(pay.webhook(raw.replace('780000', '1'), sig).status).toBe(401); // body changed after signing
  const [lowRaw, lowSig] = hook({ code, amountVnd: '1000', bankTxId: 'FT1' });
  expect(pay.webhook(lowRaw, lowSig)).toMatchObject({ status: 400, json: { error: 'AmountMismatch' } });
  const [ghostRaw, ghostSig] = hook({ code: 'VGNOSUCHCD', amountVnd: '780000' });
  expect(pay.webhook(ghostRaw, ghostSig).status).toBe(404);
  expect(calls).toEqual([]);

  const ok = pay.webhook(raw, sig);
  expect(ok.status).toBe(200);
  await ok.settled;
  // Replay of the same signed report: refused, nothing bought twice.
  expect(pay.webhook(raw, sig)).toMatchObject({ status: 409, json: { error: 'AlreadyPaid' } });
  expect(calls.filter((c) => c.startsWith('buy'))).toHaveLength(1);
});

test('paid purchase: float to the buyer, buyFor, then the receipt hash recorded for every ticket of the order', async () => {
  const { pay, calls } = start();
  const { code } = await pay.create(buy);
  const [raw, sig] = hook({ code, amountVnd: '780000', bankTxId: 'FT2611220001', method: 'momo' });
  await pay.webhook(raw, sig).settled;
  const r = pay.status(code)!;
  expect(r).toMatchObject({ status: 'done', kind: 'buy', method: 'momo', bankTxId: 'FT2611220001', hash: '0xb0', tokenIds: ['145', '146'], recordTx: '0xc0' });
  expect(r.receiptHash).toBe(receiptHash(code, '780000', r.salt!));
  expect(calls).toEqual([`fund ${BUYER} 30000000`, 'buy 1/0×2', `record 145,146 kind 0 ${r.receiptHash}`]);
  // The public list shows what the chain shows, never the bank code or the salt.
  const [row] = pay.ledger();
  expect(row).toMatchObject({ receiptHash: r.receiptHash, kind: 'buy', amountVnd: '780000', tokenIds: ['145', '146'], hash: '0xb0', recordTx: '0xc0', status: 'done' });
  expect(JSON.stringify(row)).not.toContain(code);
  expect(JSON.stringify(row)).not.toContain(r.salt!);
});

test('the mock bank reports through the same signed webhook', async () => {
  const { pay } = start();
  const { code } = await pay.create(buy);
  const r = pay.mockBankTransfer(code, 'vietqr');
  expect(r).toMatchObject({ status: 200, json: { bankTxId: expect.stringMatching(/^FT\d{11}$/) } });
  await (r as { settled: Promise<void> }).settled;
  expect(pay.status(code)!.status).toBe('done');
  expect(pay.mockBankTransfer(code).status).toBe(409);
  expect(pay.mockBankTransfer('VGNOSUCHCD').status).toBe(404);
});

test('an expired code cannot be paid', async () => {
  const { pay, tick, calls } = start({}, 60);
  const { code } = await pay.create(buy);
  tick(61_000);
  expect(pay.status(code)!.status).toBe('expired');
  expect(pay.mockBankTransfer(code)).toMatchObject({ status: 410, json: { error: 'PayExpired' } });
  expect(calls).toEqual([]);
});

test('paid, but the chain refuses the purchase: the payment is marked failed with the reason and stays in the ledger', async () => {
  const { pay, calls } = start({ buy: async () => { throw new ServiceError('SoldOut'); } });
  const { code } = await pay.create(buy);
  await (pay.mockBankTransfer(code) as { settled: Promise<void> }).settled;
  expect(pay.status(code)).toMatchObject({ status: 'failed', error: 'SoldOut' });
  expect(calls.some((c) => c.startsWith('record'))).toBe(false);
  expect(pay.ledger()[0]).toMatchObject({ status: 'failed', tokenIds: [] });
});

test('resale: the listing price is funded and recorded for that ticket; a waitlist deposit is funded, not recorded', async () => {
  const { pay, calls } = start();
  const resale = await pay.create({ kind: 'resale', buyer: BUYER, tokenId: '31' });
  expect(resale.amountVnd).toBe('429000');
  await (pay.mockBankTransfer(resale.code) as { settled: Promise<void> }).settled;
  const r = pay.status(resale.code)!;
  expect(calls).toEqual([`fund ${BUYER} 16500000`, `topUp ${BUYER}`, `record 31 kind 1 ${r.receiptHash}`]);
  expect(r).toMatchObject({ status: 'done', tokenIds: ['31'], recordTx: '0xc0' });

  calls.length = 0;
  const wait = await pay.create({ kind: 'wait', buyer: BUYER, eventId: '1', tier: '0' });
  await (pay.mockBankTransfer(wait.code) as { settled: Promise<void> }).settled;
  expect(calls).toEqual([`fund ${BUYER} 16500000`, `topUp ${BUYER}`]);
  expect(pay.status(wait.code)).toMatchObject({ status: 'done', kind: 'wait' });
});

test('refund payout: only for a transaction that refunded on chain, recorded once', async () => {
  const tx = `0x${'ab'.repeat(32)}` as Hex;
  const { pay, calls } = start({ refundOf: async (h) => (h === tx ? { tokenId: '12', holder: BUYER, units: 15_000_000n } : null) });
  expect((await pay.payout(`0x${'cd'.repeat(32)}`)).status).toBe(404);
  const out = await pay.payout(tx);
  expect(out).toMatchObject({ status: 200, json: { kind: 'refund', amountVnd: '390000', tokenIds: ['12'], method: 'bank', recordTx: '0xc0' } });
  const j = out.json as { code: string; salt: Hex; receiptHash: Hex };
  expect(j.code).toMatch(/^HT/);
  expect(j.receiptHash).toBe(receiptHash(j.code, '390000', j.salt));
  expect(calls).toEqual([`record 12 kind 2 ${j.receiptHash}`]);
  expect((await pay.payout(tx)).status).toBe(409);
});

test('HTTP shape: bad purposes are refused; the webhook route needs the raw body and its signature', async () => {
  const { pay } = start();
  expect((await pay.handle('/pay/create', { purpose: { kind: 'buy', order: { buyer: 'nope' } } })).status).toBe(400);
  expect((await pay.handle('/pay/create', { purpose: { kind: 'resale', buyer: BUYER, tokenId: '1e9' } })).status).toBe(400);
  const made = (await pay.handle('/pay/create', { purpose: buy })).json as { code: string };
  expect((await pay.handle('/pay/status', { code: made.code })).json).toMatchObject({ status: 'pending' });
  expect((await pay.handle('/pay/status', { code: 'x' })).status).toBe(404);
  const [raw, sig] = hook({ code: made.code, amountVnd: '780000' });
  expect((await pay.handle('/webhook/payment', JSON.parse(raw))).status).toBe(401);
  expect((await pay.handle('/webhook/payment', JSON.parse(raw), { raw, signature: sig })).status).toBe(200);
  expect(pay.handles('/pay/ledger') && pay.handles('/mock-bank/transfer') && !pay.handles('/buy')).toBe(true);
  expect(() => createPayments({ chain: fakeChain().chain, secret: 'short' })).toThrow();
});

test('the buyer checks a receipt against the chain: match, edited copy, record missing', async () => {
  const receipt: Receipt = { code: 'VG7K2M9QXA', amountVnd: '780000', salt: SALT, receiptHash: receiptHash('VG7K2M9QXA', '780000', SALT), kind: 'buy', method: 'vietqr', tokenIds: ['145', '146'], paidAt: 1 };
  const onChain = async () => [{ receiptHash: receipt.receiptHash, kind: 0, at: 1_795_300_100n }];
  expect(await checkReceipt(receipt, onChain)).toEqual({ ok: true, tokenId: '145', at: 1_795_300_100 });
  expect(await checkReceipt({ ...receipt, amountVnd: '390000' }, onChain)).toEqual({ ok: false, reason: 'tampered' });
  expect(await checkReceipt(receipt, async (id) => (id === '145' ? onChain() : []))).toEqual({ ok: false, reason: 'missing' });
  expect(await checkReceipt({ ...receipt, tokenIds: [] }, onChain)).toEqual({ ok: false, reason: 'no-ticket' });
});

test('receipts stay on the device, newest first, one per bank code', async () => {
  const store = memoryStore();
  const r = toReceipt('VG1', { status: 'done', kind: 'buy', amountVnd: '390000', method: 'momo', salt: SALT, receiptHash: receiptHash('VG1', '390000', SALT), tokenIds: ['7'], paidAt: 5 }, '1')!;
  await saveReceipt(store, BUYER, r);
  await saveReceipt(store, BUYER, { ...r, code: 'VG2' });
  await saveReceipt(store, BUYER, { ...r, recordTx: '0xc0' });
  expect((await loadReceipts(store, BUYER)).map((x) => [x.code, x.recordTx])).toEqual([['VG1', '0xc0'], ['VG2', undefined]]);
  expect(await loadReceipts(store, '0x00000000000000000000000000000000000000b2')).toEqual([]);
  expect(toReceipt('VG3', { status: 'pending', kind: 'buy', amountVnd: '1', method: 'vietqr' })).toBeNull();
});
