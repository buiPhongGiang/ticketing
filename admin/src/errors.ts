// Short words for whatever a wallet, RPC or contract threw.

const CONTRACT_ERRORS: Record<string, string> = {
  BadEvent: 'Check the name and dates.',
  BadTier: 'Check the tiers.',
  NotOrganizer: 'Not the organizer of this event.',
  NotScanner: 'Not gate staff.',
  NotHolder: 'Not the ticket holder.',
  SaleClosed: 'Sales closed.',
  SoldOut: 'Not enough tickets left.',
  WalletLimit: 'Wallet limit reached.',
  EventCancelled: 'Event is cancelled.',
  EventEnded: 'Event has ended.',
  EventNotEnded: 'Event has not ended yet.',
  NotRefundable: 'No refund open for this event.',
  AlreadySettled: 'Already settled.',
  DisputeWindow: 'Too few tickets were scanned. Settlement opens 48 h after the end.',
  DeadlineTooFar: 'QR valid for too long.',
  HolderNotWallet: 'Tickets go to plain wallets only, not contracts.',
  CompNotResellable: 'Free tickets cannot be resold.',
  BatchTooLarge: 'Too many tickets in one refund.',
  SignatureExpired: 'Signature expired.',
  InvalidSignature: 'Invalid signature.',
  AlreadyCheckedIn: 'Already checked in.',
  TicketUsed: 'Ticket already used.',
  TransferBlocked: 'Transfers only through resale.',
  AboveCap: 'Above the resale cap.',
  NotListed: 'Not listed.',
  PriceChanged: 'Price changed.',
  OwnListing: 'Own listing.',
  ERC721NonexistentToken: 'Ticket no longer exists.',
  ERC721InvalidReceiver: 'Invalid recipient.',
  ERC20InsufficientBalance: 'Not enough USDC.',
  ERC20InsufficientAllowance: 'USDC not approved.',
  Insufficient: 'Vault balance too low.',
};

export function failureText(error: unknown): string {
  const seen = new Set<unknown>();
  let e = error as any;
  let reverted = false;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') return 'Rejected in wallet.';
    const name: string | undefined = e.data?.errorName ?? e.errorName;
    if (name && CONTRACT_ERRORS[name]) return CONTRACT_ERRORS[name];
    const msg = String(e.shortMessage ?? e.message ?? '');
    if (/^Approved by \d+ of \d+\./.test(msg) || /^Organizer is not a verified Safe|^This wallet is not an owner/.test(msg)) return msg;
    if (/GS0\d\d/.test(msg)) return 'Safe refused: not enough owner approvals.';
    if (/reverted/i.test(msg)) reverted = true;
    if (/insufficient funds/i.test(msg)) return 'Not enough gas funds.';
    if (/429|rate limit|too many requests/i.test(msg)) return 'Network busy. Try again.';
    if (/WaitForTransactionReceiptTimeout|timed? ?out/i.test(e.name ?? '') || /timed? ?out/i.test(msg)) return 'No result yet. Check before resending.';
    if (/Failed to fetch|HTTP request failed|fetch failed/i.test(msg)) return 'Cannot reach the network.';
    e = e.cause;
  }
  return reverted ? 'Reverted on chain.' : 'Transaction failed.';
}
