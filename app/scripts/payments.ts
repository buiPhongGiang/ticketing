// VND payments for the relayer. Money moves through a bank or an e-wallet, off chain; this module is the backend
// that hears "paid" from the payment gateway and only then lets the chain part run:
//
//   POST /pay/create          the app asks to pay for an order; the amount is read from the chain, never from the app
//   POST /webhook/payment     the gateway reports a payment; HMAC-SHA256 of the raw body in x-vg-signature
//   POST /pay/status          the app polls with its bank code
//   POST /pay/payout          after an on-chain refund: a bank payout record with the same hash scheme
//   POST /pay/ledger          public reconciliation list (hashes and amounts; no bank codes, no salts)
//   POST /mock-bank/transfer  DEMO ONLY. There is no real gateway behind this build: this route stands in for the
//                             buyer's banking app and the bank, and calls the webhook with a valid signature.
//
// What is real here: signature check, amount check, one use per bank code, the purchase on Fuji, the receipt hash in
// PaymentReceipts. What is mock: the bank. Nothing in this file can make VND move.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { receiptHash, RECEIPT_KIND, vndOfUnits, type LedgerRow, type PayIntent, type PayMethod, type PayPurpose, type PayResult, type PayState, type ReceiptKind } from '../src/lib/pay';
import type { BuyOrder } from '../src/lib/relayer';
import { ServiceError, type Address, type ErrorCode, type Hex } from '../src/lib/types';

/** What payments need from the chain: `createRelayer(...).pay`. */
export interface PayChain {
  quote(p: PayPurpose): Promise<{ units: bigint; buyer: Address; eventId: string; tokenId?: string }>;
  fund(to: Address, units: bigint): Promise<{ hash: Hex }>;
  topUp(to: Address): Promise<{ hash?: Hex }>;
  buy(order: BuyOrder): Promise<{ hash: Hex }>;
  minted(hash: Hex, buyer: Address): Promise<string[]>;
  record(tokenIds: string[], kind: number, hash: Hex): Promise<{ hash: Hex }>;
  refundOf(hash: Hex): Promise<{ tokenId: string; holder: Address; units: bigint } | null>;
}

export interface PaymentsOptions {
  chain: PayChain;
  /** Shared with the gateway. Every webhook must carry HMAC-SHA256(secret, raw body). */
  secret: string;
  /** đồng per settlement unit (6 decimals), the same fixed rate the app shows prices at. */
  rate?: bigint;
  /** Seconds a bank code stays payable. */
  ttl?: number;
  /** JSON file the finished payments are kept in, so a restart keeps the reconciliation list. */
  ledgerFile?: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  log?: (line: string) => void;
}

interface Payment {
  code: string;
  purpose: PayPurpose;
  kind: ReceiptKind;
  method: PayMethod;
  buyer: Address;
  eventId: string;
  tokenId?: string;
  units: bigint;
  amountVnd: bigint;
  salt: Hex;
  receiptHash: Hex;
  expiresAt: number;
  status: PayState;
  error?: ErrorCode;
  bankTxId?: string;
  paidAt?: number;
  hash?: Hex;
  tokenIds?: string[];
  recordTx?: Hex;
}

export const sign = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest('hex');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: a code is read off a screen and typed into a bank app
// Fictional on purpose, and it must stay so: the payment sheet shows these as they are, with no "demo" note beside
// them. Never a real bank's name or an account number that could exist; a real gateway would supply its own.
const BANK = { name: 'Demo Bank', account: '0000 2026 1122', holder: 'VE GOC DEMO' };
const PATHS = new Set(['/pay/create', '/pay/status', '/pay/payout', '/pay/ledger', '/webhook/payment', '/mock-bank/transfer']);

export function createPayments({ chain, secret, rate, ttl = 900, ledgerFile, now = Date.now, random = (n) => randomBytes(n), log = () => {} }: PaymentsOptions) {
  if (secret.length < 16) throw new Error('PAY_WEBHOOK_SECRET must be at least 16 characters');
  const payments = new Map<string, Payment>();
  const paidOut = new Set<string>();
  let ledger: LedgerRow[] = [];
  if (ledgerFile && existsSync(ledgerFile)) {
    try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')); } catch { ledger = []; }
  }
  const nowSec = () => Math.floor(now() / 1000);
  const hex = (n: number): Hex => `0x${[...random(n)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const newCode = (prefix: string) => prefix + [...random(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

  function book(row: LedgerRow) {
    ledger = [row, ...ledger.filter((r) => r.receiptHash !== row.receiptHash)].slice(0, 2000);
    if (ledgerFile) {
      try { writeFileSync(ledgerFile, JSON.stringify(ledger)); } catch (e) { log(`ledger not written: ${(e as Error).message}`); }
    }
  }
  const row = (p: Payment): LedgerRow => ({
    receiptHash: p.receiptHash, kind: p.kind, amountVnd: p.amountVnd.toString(), method: p.method, eventId: p.eventId,
    tokenIds: p.tokenIds ?? (p.tokenId ? [p.tokenId] : []), paidAt: p.paidAt ?? 0, hash: p.hash, recordTx: p.recordTx, status: p.status,
  });
  const result = (p: Payment): PayResult => {
    const expired = p.status === 'pending' && nowSec() > p.expiresAt;
    const out: PayResult = { status: expired ? 'expired' : p.status, kind: p.kind, amountVnd: p.amountVnd.toString(), method: p.method };
    if (p.status === 'pending') return out;
    // The salt goes to whoever holds the bank code, and only once the bank confirmed the payment.
    return { ...out, error: p.error, bankTxId: p.bankTxId, paidAt: p.paidAt, hash: p.hash, tokenIds: p.tokenIds ?? (p.tokenId ? [p.tokenId] : undefined), salt: p.salt, receiptHash: p.receiptHash, recordTx: p.recordTx };
  };

  function isMethod(m: unknown): m is PayMethod { return m === 'vietqr' || m === 'momo'; }

  async function create(purpose: PayPurpose): Promise<PayIntent> {
    const q = await chain.quote(purpose);
    const amountVnd = vndOfUnits(q.units, rate);
    const code = newCode('VG');
    const salt = hex(32);
    const p: Payment = {
      code, purpose, kind: purpose.kind, method: 'vietqr', buyer: q.buyer, eventId: q.eventId, tokenId: q.tokenId, units: q.units, amountVnd, salt,
      receiptHash: receiptHash(code, amountVnd, salt), expiresAt: nowSec() + ttl, status: 'pending',
    };
    payments.set(code, p);
    if (payments.size > 5000) for (const [k, x] of payments) if (x.status === 'pending' && nowSec() > x.expiresAt) payments.delete(k);
    return { code, amountVnd: amountVnd.toString(), expiresAt: p.expiresAt, bank: BANK };
  }

  /** After the bank's word: put the order's amount into the buyer's account, then buy, then record the proof. */
  async function settle(p: Payment) {
    try {
      await chain.fund(p.buyer, p.units);
      if (p.purpose.kind === 'buy') {
        p.hash = (await chain.buy(p.purpose.order)).hash;
        p.tokenIds = await chain.minted(p.hash, p.buyer);
        p.recordTx = (await chain.record(p.tokenIds, RECEIPT_KIND.buy, p.receiptHash)).hash;
      } else {
        // Resale and the waitlist have no relayed form in the contract: the buyer's own account sends them, so it
        // also gets the fee for that one transaction.
        await chain.topUp(p.buyer).catch(() => {});
        if (p.purpose.kind === 'resale') p.recordTx = (await chain.record([p.purpose.tokenId], RECEIPT_KIND.resale, p.receiptHash)).hash;
      }
      p.status = 'done';
    } catch (e) {
      p.status = 'failed';
      p.error = e instanceof ServiceError ? e.code : 'Unknown';
    }
    book(row(p));
    log(`payment ${p.receiptHash.slice(0, 10)} ${p.kind} ${p.amountVnd} VND ${p.status}${p.error ? ` ${p.error}` : ''}`);
  }

  /** The gateway's report. Returns the HTTP status and body; the chain part runs after the answer. */
  function webhook(raw: string, signature: string | undefined): { status: number; json: unknown; settled?: Promise<void> } {
    const want = Buffer.from(sign(secret, raw), 'hex');
    const got = Buffer.from(/^[0-9a-f]{64}$/i.test(signature ?? '') ? signature! : '', 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { error: 'BadSignature' } };
    let body: { code?: unknown; amountVnd?: unknown; bankTxId?: unknown; paidAt?: unknown; method?: unknown };
    try { body = JSON.parse(raw); } catch { return { status: 400, json: { error: 'BadBody' } }; }
    const p = typeof body.code === 'string' ? payments.get(body.code) : undefined;
    if (!p) return { status: 404, json: { error: 'PayUnknown' } };
    // One bank code pays once: a replayed or duplicated report changes nothing.
    if (p.status !== 'pending') return { status: 409, json: { error: 'AlreadyPaid' } };
    if (nowSec() > p.expiresAt) return { status: 410, json: { error: 'PayExpired' } };
    if (String(body.amountVnd) !== p.amountVnd.toString()) return { status: 400, json: { error: 'AmountMismatch' } };
    p.status = 'paid';
    // Which rail the money came in on is the gateway's to say.
    if (isMethod(body.method)) p.method = body.method;
    p.bankTxId = typeof body.bankTxId === 'string' ? body.bankTxId.slice(0, 40) : undefined;
    p.paidAt = nowSec();
    return { status: 200, json: { ok: true }, settled: settle(p) };
  }

  /**
   * DEMO ONLY: the bank and the buyer's banking app in one call. It knows what a real gateway would know (the
   * transfer content and the amount the buyer sent) and reports it through the same signed webhook.
   */
  function mockBankTransfer(code: string, method: PayMethod = 'vietqr') {
    const p = payments.get(code);
    if (!p) return { status: 404, json: { error: 'PayUnknown' } };
    const bankTxId = `FT${new Date(now()).toISOString().slice(2, 10).replace(/-/g, '')}${[...random(5)].map((b) => b % 10).join('')}`;
    const raw = JSON.stringify({ code, amountVnd: p.amountVnd.toString(), method, bankTxId, paidAt: nowSec(), gateway: 'mock' });
    const r = webhook(raw, sign(secret, raw));
    return r.status === 200 ? { ...r, json: { bankTxId } } : r;
  }

  /** A refund already happened on chain; this records the matching bank payout (mock) with the same hash scheme. */
  async function payout(txHash: Hex): Promise<{ status: number; json: unknown }> {
    const key = txHash.toLowerCase();
    if (paidOut.has(key)) return { status: 409, json: { error: 'PayUnknown' } };
    const refund = await chain.refundOf(txHash);
    if (!refund || refund.units === 0n) return { status: 404, json: { error: 'NotRefundable' } };
    paidOut.add(key);
    const code = newCode('HT');
    const salt = hex(32);
    const amountVnd = vndOfUnits(refund.units, rate);
    const hash = receiptHash(code, amountVnd, salt);
    const out: PayResult & { code: string } = { code, status: 'done', kind: 'refund', amountVnd: amountVnd.toString(), method: 'bank', paidAt: nowSec(), tokenIds: [refund.tokenId], salt, receiptHash: hash, hash: txHash };
    try {
      out.recordTx = (await chain.record([refund.tokenId], RECEIPT_KIND.refund, hash)).hash;
    } catch (e) {
      paidOut.delete(key);
      return { status: 400, json: { error: e instanceof ServiceError ? e.code : 'Unknown' } };
    }
    book({ receiptHash: hash, kind: 'refund', amountVnd: out.amountVnd, method: 'bank', tokenIds: [refund.tokenId], paidAt: out.paidAt!, hash: txHash, recordTx: out.recordTx, status: 'done' });
    return { status: 200, json: out };
  }

  const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
  const num = (x: unknown): x is string => typeof x === 'string' && /^\d{1,12}$/.test(x);
  function purposeOf(x: any): PayPurpose | null {
    if (x?.kind === 'buy' && x.order && addr(x.order.buyer) && num(x.order.eventId) && num(x.order.tier) && num(x.order.quantity)) return { kind: 'buy', order: x.order };
    if (x?.kind === 'resale' && addr(x.buyer) && num(x.tokenId)) return { kind: 'resale', buyer: x.buyer, tokenId: x.tokenId };
    if (x?.kind === 'wait' && addr(x.buyer) && num(x.eventId) && num(x.tier)) return { kind: 'wait', buyer: x.buyer, eventId: x.eventId, tier: x.tier };
    return null;
  }

  async function handle(path: string, body: any, extra: { raw?: string; signature?: string } = {}): Promise<{ status: number; json: unknown }> {
    try {
      if (path === '/pay/create') {
        const purpose = purposeOf(body?.purpose);
        if (!purpose) return { status: 400, json: { error: 'Unknown' } };
        return { status: 200, json: await create(purpose) };
      }
      if (path === '/pay/status') {
        const p = typeof body?.code === 'string' ? payments.get(body.code) : undefined;
        return p ? { status: 200, json: result(p) } : { status: 404, json: { error: 'PayUnknown' } };
      }
      if (path === '/webhook/payment') { const { status, json } = webhook(extra.raw ?? '', extra.signature); return { status, json }; }
      if (path === '/mock-bank/transfer' && typeof body?.code === 'string') { const { status, json } = mockBankTransfer(body.code, isMethod(body.method) ? body.method : 'vietqr'); return { status, json }; }
      if (path === '/pay/payout' && typeof body?.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) return await payout(body.txHash);
      if (path === '/pay/ledger') return { status: 200, json: { rows: ledger.slice(0, 500) } };
      return { status: 404, json: { error: 'Unknown' } };
    } catch (e) {
      return { status: 400, json: { error: e instanceof ServiceError ? e.code : 'Unknown' } };
    }
  }

  return { handle, handles: (path: string) => PATHS.has(path), create, webhook, mockBankTransfer, payout, status: (code: string) => { const p = payments.get(code); return p ? result(p) : null; }, ledger: () => ledger };
}
