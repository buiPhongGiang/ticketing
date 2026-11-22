// The steps of one VND checkout, apart from the screen so the rule can be tested: opening the payment screen never
// buys, joins a line or reports a payment. Only confirm(), which the screen calls from its confirm button, does.
import type { PayOrder } from './app-context';
import { saveReceipt, toReceipt, type PayClient, type PayIntent, type PayMethod, type PayPurpose, type PayResult } from './lib/pay';
import { ServiceError, type Address, type ErrorCode, type JournalEntry, type KeyValueStore, type TicketService } from './lib/types';

/**
 * sheet: a bank code is shown, waiting for the buyer to pay and confirm. held: an earlier payment for this account
 * never reached its order and still covers this one, waiting for the buyer to confirm. bank: reported, waiting for
 * the bank. chain: paid, the order is being carried out.
 */
export type PayStage = 'opening' | 'sheet' | 'held' | 'bank' | 'chain';

/** The bank confirmed the money but the order did not go through; the amount stays with the account. */
export class PaidButFailed extends Error {
  constructor(public reason: ErrorCode | undefined) { super('PaidButFailed'); this.name = 'PaidButFailed'; }
}

export interface PayFlowDeps {
  order: PayOrder;
  wallet: Address;
  service: Pick<TicketService, 'getBalances' | 'signBuyOrder' | 'buy' | 'buyListing' | 'joinWaitlist' | 'adoptBuy'>;
  pay: PayClient;
  store: KeyValueStore;
  onStage?: (stage: PayStage) => void;
  /** Between status polls; injected in tests. */
  wait?: (ms: number) => Promise<void>;
  polls?: number;
}

export function createPayFlow({ order, wallet, service, pay, store, onStage = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)), polls = 60 }: PayFlowDeps) {
  let stage: PayStage = 'opening';
  let intent: PayIntent | null = null;
  let confirming: Promise<JournalEntry> | null = null;
  const set = (s: PayStage) => { stage = s; onStage(s); };

  /** The wallet's own transaction, for orders the contract has no relayed form of, and for an amount already held. */
  const act = (): Promise<JournalEntry> => {
    if (order.kind === 'buy') return service.buy(order.eventId, order.tier, order.quantity);
    if (order.kind === 'resale') return service.buyListing(order.tokenId, order.units);
    return service.joinWaitlist(order.eventId, order.tier);
  };

  /**
   * Prepares the screen and sends nothing: either a bank code to pay (the order is signed, a signature only), or
   * the note that an earlier payment already covers this order. Both wait for confirm().
   */
  async function open(): Promise<{ stage: 'sheet'; intent: PayIntent } | { stage: 'held' }> {
    set('opening');
    intent = null;
    const held = await service.getBalances(wallet);
    if (BigInt(held.usdc) >= BigInt(order.units)) { set('held'); return { stage: 'held' }; }
    const purpose: PayPurpose = order.kind === 'buy'
      ? { kind: 'buy', order: await service.signBuyOrder(order.eventId, order.tier, order.quantity) }
      : order.kind === 'resale'
        ? { kind: 'resale', buyer: wallet, tokenId: order.tokenId }
        : { kind: 'wait', buyer: wallet, eventId: order.eventId, tier: String(order.tier) };
    intent = await pay.create(purpose);
    set('sheet');
    return { stage: 'sheet', intent };
  }

  async function run(method: PayMethod): Promise<JournalEntry> {
    if (stage === 'held') { set('chain'); return act(); }
    if (stage !== 'sheet' || !intent) throw new ServiceError('PayUnknown');
    const code = intent.code;
    set('bank');
    await pay.mockTransfer(code, method);
    let result: PayResult | null = null;
    for (let i = 0; i < polls; i++) {
      const r = await pay.status(code);
      if (r.status === 'paid' && (stage as PayStage) !== 'chain') set('chain');
      if (r.status === 'done' || r.status === 'failed' || r.status === 'expired') { result = r; break; }
      await wait(2000);
    }
    if (!result) throw new ServiceError('Network');
    if (result.status === 'expired') throw new ServiceError('PayExpired');
    if (result.status === 'failed') throw new PaidButFailed(result.error);
    set('chain');
    const receipt = toReceipt(code, result, order.eventId);
    if (receipt) await saveReceipt(store, wallet, receipt);
    return order.kind === 'buy' && result.hash ? service.adoptBuy(result.hash, order.eventId, order.tier, order.quantity) : act();
  }

  return {
    open,
    /** The buyer's explicit go-ahead. A second call while the first runs returns the same result: one tap, one order. */
    confirm(method: PayMethod): Promise<JournalEntry> {
      confirming ??= run(method).finally(() => { confirming = null; });
      return confirming;
    },
    stage: () => stage,
  };
}
