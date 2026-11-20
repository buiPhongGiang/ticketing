import { demoMode } from './config';
import type { ErrorCode } from './lib/types';

const messages: Record<ErrorCode, string> = {
  SoldOut: 'Sold out',
  SaleClosed: 'Not on sale',
  WalletLimit: 'Ticket limit reached for this event',
  EventCancelled: 'Event cancelled',
  EventEnded: 'Event has ended',
  NotScanner: 'This device cannot scan this event',
  NotHolder: 'Not your ticket',
  SignatureExpired: 'QR expired',
  InvalidSignature: 'Invalid QR',
  AlreadyCheckedIn: 'Already checked in',
  TicketUsed: 'Ticket already used',
  TransferBlocked: 'Tickets move only through resale',
  AboveCap: 'Above the resale cap',
  NotListed: 'No longer listed',
  PriceChanged: 'Price changed',
  OwnListing: 'Your own listing',
  NotRefundable: 'No refund open for this event',
  FaucetCooldown: 'Faucet: try again in 5 minutes',
  DeadlineTooFar: 'QR valid for too long',
  HolderNotWallet: 'Tickets go to personal accounts only',
  CompNotResellable: 'Free tickets cannot be resold',
  WaitlistFirst: 'Someone is waiting in line for this tier',
  ListingsOpen: 'A resale ticket is on offer: buy it',
  AlreadyWaiting: 'Already in line for this tier',
  NotWaiting: 'Not in line',
  BadEvent: 'Unknown event',
  BadTier: 'Unknown tier',
  OwnerChanged: 'Ticket changed hands',
  NonexistentToken: 'Ticket does not exist',
  InsufficientUsdc: 'Not enough USDC',
  InsufficientFunds: demoMode ? 'Not enough AVAX for the fee' : 'Could not complete. Try again',
  WrongNetwork: 'Wrong event or network',
  InFlight: 'Previous action still pending',
  NotInSnapshot: 'Not on the offline list',
  StaleList: 'Offline list too old. Reconnect',
  Network: 'Cannot reach the network',
  Unknown: 'Unknown error',
};

export function messageFor(code: ErrorCode | undefined): string {
  return messages[code ?? 'Unknown'];
}

export function codeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code in messages ? (code as ErrorCode) : 'Unknown';
}
