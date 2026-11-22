// Reconciliation ("Đối soát"): the payment backend's list of VND payments next to the hashes PaymentReceipts holds
// on chain. Ticket money moves in đồng through a bank or an e-wallet; the chain only stores which payment record a
// ticket is tied to. A row is settled when both sides show the same hash.
import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { blockChunks } from './logs';

export const receiptsAbi = parseAbi([
  'event PaymentRecorded(uint256 indexed tokenId, uint8 kind, bytes32 indexed receiptHash, address indexed recorder)',
]);

export type PayKind = 'buy' | 'resale' | 'wait' | 'refund' | 'payout';
const CHAIN_KINDS: PayKind[] = ['buy', 'resale', 'refund', 'payout'];
export const KIND_LABEL: Record<PayKind, string> = { buy: 'Mua vé', resale: 'Mua lại', wait: 'Đặt cọc hàng chờ', refund: 'Hoàn tiền', payout: 'Trả người bán' };

/** A row of the backend's public list (POST <relayer>/pay/ledger): no bank code, no salt. */
export interface LedgerRow {
  receiptHash: Hex;
  kind: PayKind;
  amountVnd: string;
  method: 'vietqr' | 'momo' | 'bank';
  eventId?: string;
  tokenIds: string[];
  paidAt: number;
  hash?: Hex;
  recordTx?: Hex;
  status: 'pending' | 'paid' | 'done' | 'failed' | 'expired';
}

/** One PaymentRecorded log group: a hash and the tickets it was recorded for. */
export interface ChainRecord { receiptHash: Hex; kind: PayKind; tokenIds: number[]; tx: Hex; block: bigint }

/**
 * matched: the backend's payment and the chain record carry the same hash. ledger: the backend lists it, the chain
 * has no record (a waitlist deposit, or a payment whose order failed). chain: recorded on chain, missing from the
 * backend's list.
 */
export type ReconState = 'matched' | 'ledger' | 'chain';
export interface ReconRow {
  receiptHash: Hex;
  kind: PayKind;
  state: ReconState;
  /** Whole đồng; null when only the chain knows the payment. */
  amountVnd: bigint | null;
  method?: LedgerRow['method'];
  tokenIds: number[];
  paidAt?: number;
  /** Purchase or refund transaction on chain. */
  hash?: Hex;
  recordTx?: Hex;
  failed: boolean;
}

export interface ReconTotals { received: bigint; paidOut: bigint; payments: number; matched: number; open: number }

type Reader = Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;

export async function readRecorded(client: Reader, receipts: Address, fromBlock: bigint, chunk: bigint): Promise<ChainRecord[]> {
  const latest = await client.getBlockNumber();
  const byHash = new Map<string, ChainRecord>();
  for (const [from, to] of blockChunks(fromBlock, latest, chunk)) {
    const logs = await client.getLogs({ address: receipts, event: receiptsAbi[0], fromBlock: from, toBlock: to });
    for (const l of logs) {
      const key = l.args.receiptHash!.toLowerCase();
      const r = byHash.get(key) ?? { receiptHash: l.args.receiptHash!, kind: CHAIN_KINDS[Number(l.args.kind)] ?? 'buy', tokenIds: [], tx: l.transactionHash!, block: l.blockNumber! };
      r.tokenIds.push(Number(l.args.tokenId));
      byHash.set(key, r);
    }
  }
  return [...byHash.values()];
}

export async function fetchLedger(url: string, fetchImpl: typeof fetch = fetch): Promise<LedgerRow[]> {
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/pay/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`ledger ${res.status}`);
  const json = (await res.json()) as { rows?: LedgerRow[] };
  return Array.isArray(json.rows) ? json.rows : [];
}

/**
 * Rows of one event, newest first. `eventOf` says which event a ticket belongs to (from the mint logs); a ledger
 * row without tickets is placed by its own event id.
 */
export function reconcile(ledger: LedgerRow[], chain: ChainRecord[], eventId: number, eventOf: (tokenId: number) => number | undefined): ReconRow[] {
  const mine = (ids: number[], own?: string) => (ids.length ? ids.some((id) => eventOf(id) === eventId) : own !== undefined && Number(own) === eventId);
  const onChain = new Map(chain.map((c) => [c.receiptHash.toLowerCase(), c]));
  const rows: ReconRow[] = [];
  const seen = new Set<string>();
  for (const l of ledger) {
    const key = l.receiptHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const c = onChain.get(key);
    const tokenIds = c ? c.tokenIds : l.tokenIds.map(Number);
    if (!mine(tokenIds, l.eventId)) continue;
    rows.push({
      receiptHash: l.receiptHash, kind: l.kind, state: c ? 'matched' : 'ledger', amountVnd: BigInt(l.amountVnd), method: l.method, tokenIds,
      paidAt: l.paidAt, hash: l.hash, recordTx: c?.tx ?? l.recordTx, failed: l.status === 'failed',
    });
  }
  for (const c of chain) {
    if (seen.has(c.receiptHash.toLowerCase()) || !mine(c.tokenIds)) continue;
    rows.push({ receiptHash: c.receiptHash, kind: c.kind, state: 'chain', amountVnd: null, tokenIds: c.tokenIds, recordTx: c.tx, failed: false });
  }
  return rows.sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0));
}

/** Money in (sales, resales, deposits) and out (refund and seller payouts), in đồng; failed orders count as open. */
export function totals(rows: ReconRow[]): ReconTotals {
  const t: ReconTotals = { received: 0n, paidOut: 0n, payments: rows.length, matched: 0, open: 0 };
  for (const r of rows) {
    if (r.state === 'matched') t.matched++;
    // A waitlist deposit has no ticket to record against, so "ledger only" is its normal state.
    if (r.state === 'chain' || r.failed || (r.state === 'ledger' && r.kind !== 'wait')) t.open++;
    if (r.amountVnd === null) continue;
    if (r.kind === 'refund' || r.kind === 'payout') t.paidOut += r.amountVnd;
    else t.received += r.amountVnd;
  }
  return t;
}
