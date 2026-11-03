import { createContext, useContext } from 'react';
import type { LocalSigner, TicketService } from './lib/types';

export type Route =
  | { name: 'event' } | { name: 'purchase'; entryId: string } | { name: 'tickets'; bought?: number }
  | { name: 'ticket'; tokenId: string } | { name: 'transfer'; tokenId: string } | { name: 'qr'; tokenId: string }
  | { name: 'gate' } | { name: 'wallet' } | { name: 'dashboard' };

export interface AppValue {
  wallet: LocalSigner;
  service: TicketService;
  isScanner: boolean;
  isOrganizer: boolean;
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
