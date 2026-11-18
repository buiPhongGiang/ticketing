import type { ErrorCode } from './lib/types';

/** Wording agreed in the design's error table. */
const messages: Record<ErrorCode, string> = {
  SoldOut: 'Sold out',
  SaleClosed: 'Not on sale',
  WrongPayment: 'Wrong amount',
  NotScanner: 'Wallet cannot scan',
  SignatureExpired: 'QR expired',
  InvalidSignature: 'Invalid QR',
  OwnerChanged: 'Ticket changed hands',
  AlreadyCheckedIn: 'Already checked in',
  TicketUsed: 'Ticket already used',
  WithdrawFailed: 'Withdrawal failed',
  NonexistentToken: 'Ticket does not exist',
  InvalidRecipient: 'Invalid recipient address',
  InsufficientFunds: 'Not enough funds',
  WrongNetwork: 'Wrong event or network',
  InFlight: 'Previous transaction pending',
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
