// Paying in đồng. Ticket money moves through a bank transfer (VietQR) or an e-wallet (MoMo), off chain; the chain
// holds the rules and the proof. This build has no real gateway: the relayer plays a MOCK bank, clearly labelled in
// the app, and everything after "the bank says paid" is the real path (signed webhook, purchase on Fuji, receipt hash
// recorded in PaymentReceipts).
//
// Shared by the app and the relayer; nothing here needs Node.
import { encodePacked, keccak256, parseAbi } from 'viem';
import type { BuyOrder } from './relayer';
import { ServiceError, type Address, type ErrorCode, type Hex, type KeyValueStore } from './types';

export type PayMethod = 'vietqr' | 'momo';

/** What a payment is for. The relayer works the amount out from the chain itself; the app never names a price. */
export type PayPurpose =
  | { kind: 'buy'; order: BuyOrder }
  | { kind: 'resale'; buyer: Address; tokenId: string }
  | { kind: 'wait'; buyer: Address; eventId: string; tier: string };

/** PaymentReceipts.Kind */
export const RECEIPT_KIND = { buy: 0, resale: 1, refund: 2, payout: 3 } as const;
export type ReceiptKind = keyof typeof RECEIPT_KIND | 'wait';

/** What the buyer is asked to pay, as the (mock) bank or wallet shows it. */
export interface PayIntent {
  /** Transfer content: the bank reference of this payment. Known to the buyer and the gateway only. */
  code: string;
  /** Whole đồng. */
  amountVnd: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Demo receiving account. Not a real account. */
  bank: { name: string; account: string; holder: string };
}

/**
 * pending: waiting for the bank. paid: the signed webhook was accepted, the chain part is running.
 * done: finished (ticket bought, or the order funded for the wallet's own transaction). failed: paid, but the
 * chain refused; the money is still held for this account.
 */
export type PayState = 'pending' | 'paid' | 'done' | 'failed' | 'expired';

export interface PayResult {
  status: PayState;
  kind: ReceiptKind;
  amountVnd: string;
  method: PayMethod | 'bank';
  error?: ErrorCode;
  bankTxId?: string;
  /** Unix seconds. */
  paidAt?: number;
  /** The purchase the relayer sent (buyFor). */
  hash?: Hex;
  tokenIds?: string[];
  salt?: Hex;
  receiptHash?: Hex;
  /** PaymentReceipts.record transaction. */
  recordTx?: Hex;
}

/** One row of the public reconciliation list: no bank code, no salt, only what the chain also shows. */
export interface LedgerRow {
  receiptHash: Hex;
  kind: ReceiptKind;
  amountVnd: string;
  method: PayMethod | 'bank';
  eventId?: string;
  tokenIds: string[];
  paidAt: number;
  hash?: Hex;
  recordTx?: Hex;
  status: PayState;
}

export const VND_PER_USDC_DEFAULT = 26_000n;
/** Settlement units (6 decimals) to whole đồng, rounded to the nearest đồng. Same rule as the app's price labels. */
export const vndOfUnits = (units: bigint, rate: bigint = VND_PER_USDC_DEFAULT): bigint => (units * rate + 500_000n) / 1_000_000n;

/** keccak256(abi.encodePacked(bankCode, amountVnd, salt)): what PaymentReceipts stores for a ticket. */
export function receiptHash(code: string, amountVnd: string | bigint, salt: Hex): Hex {
  return keccak256(encodePacked(['string', 'uint256', 'bytes32'], [code, BigInt(amountVnd), salt]));
}

export const receiptsAbi = parseAbi([
  'function record(uint256[] tokenIds, uint8 kind, bytes32 receiptHash)',
  'function receiptsOf(uint256 tokenId) view returns ((bytes32 receiptHash, uint8 kind, uint64 at)[])',
  'function recorded(bytes32) view returns (bool)',
  'function count() view returns (uint256)',
  'event PaymentRecorded(uint256 indexed tokenId, uint8 kind, bytes32 indexed receiptHash, address indexed recorder)',
  'error NotRecorder()',
  'error AlreadyRecorded()',
]);

export interface PayClient {
  create(purpose: PayPurpose): Promise<PayIntent>;
  status(code: string): Promise<PayResult>;
  /** DEMO ONLY: stands in for the buyer's banking app. Tells the mock bank the transfer was made. */
  mockTransfer(code: string, method: PayMethod): Promise<{ bankTxId: string }>;
  /** Mock bank payout after an on-chain refund: the relayer checks the refund transaction and records the payout. */
  payout(txHash: Hex): Promise<PayResult & { code: string }>;
  ledger(): Promise<{ rows: LedgerRow[] }>;
}

const errorCodes = new Set<string>(['SoldOut', 'SaleClosed', 'WalletLimit', 'EventCancelled', 'EventEnded', 'SignatureExpired', 'InvalidSignature', 'BadEvent', 'BadTier', 'NotListed', 'OwnListing', 'WaitlistFirst', 'ListingsOpen', 'AlreadyWaiting', 'RateLimited', 'RelayerLow', 'PayExpired', 'PayUnknown', 'PayOff', 'NotRefundable', 'Network', 'Unknown']);

export function httpPay(url: string, fetchImpl: typeof fetch = fetch): PayClient {
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new ServiceError('Network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new ServiceError(errorCodes.has(json.error) ? json.error : 'Unknown');
    return json;
  };
  return {
    create: (purpose) => post('pay/create', { purpose }),
    status: (code) => post('pay/status', { code }),
    mockTransfer: (code, method) => post('mock-bank/transfer', { code, method }),
    payout: (txHash) => post('pay/payout', { txHash }),
    ledger: () => post('pay/ledger', {}),
  };
}

// ---------------------------------------------------------------- receipts kept on the device

/** The buyer's copy of a payment: enough to recompute the hash the chain stores. Never leaves the device. */
export interface Receipt {
  code: string;
  amountVnd: string;
  salt: Hex;
  receiptHash: Hex;
  kind: ReceiptKind;
  method: PayMethod | 'bank';
  tokenIds: string[];
  eventId?: string;
  paidAt: number;
  bankTxId?: string;
  hash?: Hex;
  recordTx?: Hex;
}

const receiptsKey = (wallet: Address) => `ticketing.receipts:${wallet.toLowerCase()}`;

export async function loadReceipts(store: KeyValueStore, wallet: Address): Promise<Receipt[]> {
  try {
    const all = JSON.parse((await store.getItem(receiptsKey(wallet))) ?? '[]');
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

/** Newest first; a receipt with the same bank code replaces the older copy. */
export async function saveReceipt(store: KeyValueStore, wallet: Address, receipt: Receipt): Promise<Receipt[]> {
  const rest = (await loadReceipts(store, wallet)).filter((r) => r.code !== receipt.code);
  const all = [receipt, ...rest].slice(0, 200);
  await store.setItem(receiptsKey(wallet), JSON.stringify(all));
  return all;
}

export function toReceipt(code: string, r: PayResult, eventId?: string): Receipt | null {
  if (!r.salt || !r.receiptHash) return null;
  return {
    code, amountVnd: r.amountVnd, salt: r.salt, receiptHash: r.receiptHash, kind: r.kind, method: r.method, tokenIds: r.tokenIds ?? [],
    eventId, paidAt: r.paidAt ?? 0, bankTxId: r.bankTxId, hash: r.hash, recordTx: r.recordTx,
  };
}

export type ReceiptCheck =
  | { ok: true; tokenId: string; at: number }
  /** tampered: the fields on this device no longer hash to what was issued. missing: the chain has no such record. */
  | { ok: false; reason: 'tampered' | 'missing' | 'no-ticket' };

/**
 * Recomputes the hash from the buyer's copy and looks for it among the records PaymentReceipts holds for the
 * ticket. `read` is one eth_call: receiptsOf(tokenId).
 */
export async function checkReceipt(receipt: Receipt, read: (tokenId: string) => Promise<readonly { receiptHash: Hex; kind: number; at: bigint | number }[]>): Promise<ReceiptCheck> {
  const computed = receiptHash(receipt.code, receipt.amountVnd, receipt.salt);
  if (computed.toLowerCase() !== receipt.receiptHash.toLowerCase()) return { ok: false, reason: 'tampered' };
  if (receipt.tokenIds.length === 0) return { ok: false, reason: 'no-ticket' };
  let at = 0;
  for (const tokenId of receipt.tokenIds) {
    const found = (await read(tokenId)).find((x) => x.receiptHash.toLowerCase() === computed.toLowerCase());
    if (!found) return { ok: false, reason: 'missing' };
    at = Number(found.at);
  }
  return { ok: true, tokenId: receipt.tokenIds[0], at };
}
