import { createContext, useContext } from 'react';
import type { ExchangeClient } from './lib/exchange';
import type { PayClient } from './lib/pay';
import type { SocialClient } from './lib/social';
import type { KeyValueStore, LocalSigner, TicketService } from './lib/types';

export type Notice = { kind: 'bought' | 'resale' | 'refund' | 'faucet' | 'listed' | 'unlisted' | 'waiting'; text: string; feeWei?: string; confirmedMs?: number; blockMs?: number; relayed?: boolean };

export type Route =
  | { name: 'events' } | { name: 'event'; eventId: string } | { name: 'tx'; entryId: string }
  | { name: 'tickets'; notice?: Notice } | { name: 'ticket'; tokenId: string } | { name: 'resell'; tokenId: string }
  | { name: 'qr'; tokenId: string } | { name: 'gate' } | { name: 'gate-pin' } | { name: 'wallet' }
  | { name: 'pay'; order: PayOrder } | { name: 'receipt'; code: string }
  // The ticket market: every resale listing and queue, one listing, the guest's own page, a seller's page, notifications.
  | { name: 'market'; eventId?: string } | { name: 'listing'; tokenId: string } | { name: 'me' } | { name: 'user'; account: string } | { name: 'notices' };

/** What the guest is about to pay for in đồng. `units` is the price as the screen showed it, for the sheet's first paint. */
export type PayOrder =
  | { kind: 'buy'; eventId: string; tier: number; quantity: number; units: string; title: string }
  | { kind: 'resale'; tokenId: string; eventId: string; units: string; title: string }
  | { kind: 'wait'; eventId: string; tier: number; units: string; title: string };

export interface AppValue {
  wallet: LocalSigner;
  service: TicketService;
  isScanner: boolean;
  go(route: Route): void;
  back(): void;
  reset(route: Route): void;
  /** Bumps after a wallet switch or when data should reload. */
  refreshKey: number;
  refresh(): void;
  devWallets: `0x${string}`[];
  useDevWallet(index: number): Promise<void>;
  /** VND checkout through the relayer's payment routes; undefined when this build pays on chain directly. */
  pay?: PayClient;
  /** Likes and comments through the relayer, signed by this device; undefined at the gate and in builds without it. */
  social?: SocialClient;
  /** Seller notes on resale listings through the relayer, signed by this device; undefined at the gate and in builds without it. */
  exchange?: ExchangeClient;
  /** Device storage: payment receipts live here, next to the journal. */
  store: KeyValueStore;
  /** Published build: door staff open the gate with the PIN the relayer holds; no key on the device. */
  enterGate?(pin: string): Promise<void>;
  /** Set while the gate runs through the relayer: back to the guest account. */
  leaveGate?(): void;
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext is missing');
  return v;
}
