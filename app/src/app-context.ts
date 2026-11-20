import { createContext, useContext } from 'react';
import type { LocalSigner, TicketService } from './lib/types';

export type Notice = { kind: 'bought' | 'resale' | 'refund' | 'faucet' | 'listed' | 'unlisted' | 'waiting'; text: string; feeWei?: string; confirmedMs?: number; blockMs?: number; relayed?: boolean };

export type Route =
  | { name: 'events' } | { name: 'event'; eventId: string } | { name: 'tx'; entryId: string }
  | { name: 'tickets'; notice?: Notice } | { name: 'ticket'; tokenId: string } | { name: 'resell'; tokenId: string }
  | { name: 'qr'; tokenId: string } | { name: 'gate' } | { name: 'wallet' };

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
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext is missing');
  return v;
}
