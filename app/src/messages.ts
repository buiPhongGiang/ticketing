import type { ErrorCode } from './lib/types';

/** Wording agreed in the design's error table. */
const messages: Record<ErrorCode, string> = {
  SoldOut: 'Sold out',
  SaleClosed: 'Public sale is not open yet',
  WrongPayment: 'Amount does not match. Reload the price and try again',
  NotScanner: 'This wallet is not allowed to check tickets',
  SignatureExpired: 'QR code expired. Ask the guest for a new one',
  InvalidSignature: 'Invalid QR code. Ask the guest to make a new one',
  OwnerChanged: 'Ticket changed hands. The current holder needs a new QR code',
  AlreadyCheckedIn: 'This ticket is already checked in',
  TicketUsed: 'Used tickets cannot be transferred',
  WithdrawFailed: 'Withdrawal failed',
  NonexistentToken: 'Ticket does not exist',
  InvalidRecipient: 'Invalid recipient address',
  InsufficientFunds: 'Not enough funds in this wallet for this transaction',
  WrongNetwork: 'This code is for another event or network',
  InFlight: 'A previous transaction is still pending. Wait for it, then try again',
  Network: 'Cannot reach the network. Try again later',
  Unknown: 'Unknown error',
};

export function messageFor(code: ErrorCode | undefined): string {
  return messages[code ?? 'Unknown'];
}

export function codeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code in messages ? (code as ErrorCode) : 'Unknown';
}
