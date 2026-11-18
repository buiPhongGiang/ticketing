// Contract between the chain layer (src/lib) and the screens. All on-chain integers are decimal strings here.
export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  /** VeGoc */
  contract: Address;
  /** Payment token: any 6-decimal ERC-20 with EIP-2612 permit (mock USDC with a faucet, or Circle's USDC) */
  usdc: Address;
  nativeSymbol: string;
  /** Organizers whose events the app lists. Empty or missing: every event on the contract. */
  organizers?: Address[];
}

/** Async key/value persistence: AsyncStorage on device, in-memory in tests. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PermitRequest {
  chainId: number;
  token: Address;
  tokenName: string;
  /** EIP-712 domain version of the token: "2" for Circle's USDC, "1" for OpenZeppelin's ERC20Permit */
  tokenVersion: string;
  spender: Address;
  value: string;
  nonce: string;
  deadline: string;
}

/** Holds a key locally. */
export interface LocalSigner {
  address: Address;
  /** EIP-712 CheckIn(uint256 tokenId,uint256 deadline); domain: contract name, version 1, chain id, contract address. */
  signCheckIn(args: { chainId: number; contract: Address; tokenId: string; deadline: string }): Promise<Hex>;
  /** EIP-2612 permit for the payment token, so a purchase is one transaction. */
  signPermit(args: PermitRequest): Promise<Hex>;
  /** Signs a prepared transaction and returns the raw bytes. Does not broadcast. */
  signTransaction(tx: Record<string, unknown>): Promise<Hex>;
}

export interface TierInfo {
  name: string;
  /** USDC base units (6 decimals) */
  price: string;
  supply: number;
  sold: number;
}

export type EventStatus = 'onsale' | 'ended' | 'cancelled';

export interface EventInfo {
  id: string;
  name: string;
  venue: string;
  organizer: Address;
  startsAt: number;
  endsAt: number;
  maxPerWallet: number;
  cancelled: boolean;
  settled: boolean;
  issued: number;
  checkedIn: number;
  refunded: number;
  resales: number;
  sales: string;
  resaleVolume: string;
  resaleFaceVolume: string;
  tiers: TierInfo[];
  /** Ticket money held in the float vault for this event */
  principal: string;
  /** Mock yield accrued on the float */
  yieldAccrued: string;
  listed: number;
  /** Earliest time the organizer may settle: the end if the gate quorum was met, else 48 h later */
  settleAt: number;
  /** Holders can claim refunds now: cancelled, or ended with too few tickets scanned (no-show) */
  refundOpen: boolean;
  /** At least 20 % of the paid tickets were scanned at the gate */
  quorumMet: boolean;
  paidSold: number;
  paidCheckedIn: number;
  status: EventStatus;
}

export type TxKind = 'buy' | 'resale' | 'list' | 'unlist' | 'refund' | 'faucet' | 'checkIn';
/**
 * submitting: signed and journaled, broadcast not yet acknowledged.
 * pending: broadcast acknowledged, no receipt yet.
 * unknown: connection failed after signing; must be looked up, never re-signed.
 * succeeded: receipt status 1. reverted: receipt status 0.
 */
export type TxState = 'submitting' | 'pending' | 'unknown' | 'succeeded' | 'reverted';

export interface JournalEntry {
  id: string;
  kind: TxKind;
  state: TxState;
  wallet: Address;
  hash: Hex;
  rawTx: Hex;
  nonce: number;
  createdAt: number;
  to?: Address;
  eventId?: string;
  tokenId?: string;
  tier?: string;
  quantity?: string;
  /** USDC base units moved by this action (purchase total, resale price, refund) */
  amount?: string;
  /** Network fee actually paid, in wei, once the receipt is in */
  feeWei?: string;
  /** Client clock when the node accepted the transaction */
  sentAt?: number;
  /** Milliseconds from sending to seeing the receipt, when both happened in the same run */
  confirmedMs?: number;
  /** Contract error name when a reverted tx could be replayed for a reason. */
  reasonCode?: ErrorCode;
}

export type ErrorCode =
  | 'SoldOut' | 'SaleClosed' | 'WalletLimit' | 'EventCancelled' | 'EventEnded' | 'NotScanner' | 'NotHolder'
  | 'SignatureExpired' | 'InvalidSignature' | 'AlreadyCheckedIn' | 'TicketUsed' | 'TransferBlocked' | 'AboveCap'
  | 'NotListed' | 'PriceChanged' | 'OwnListing' | 'NotRefundable' | 'FaucetCooldown' | 'BadEvent' | 'BadTier'
  | 'DeadlineTooFar' | 'HolderNotWallet' | 'CompNotResellable'
  | 'OwnerChanged' | 'NonexistentToken' | 'InsufficientUsdc' | 'InsufficientFunds' | 'WrongNetwork' | 'InFlight'
  | 'Network' | 'Unknown';

export type TicketStatus =
  | 'available'   // held, unused, not listed
  | 'listed'      // held and listed on the resale market
  | 'used'        // checked in
  | 'refundable'  // event cancelled or a no-show: refund can be claimed
  | 'sold'        // this wallet listed it and someone bought it
  | 'pending'     // an action on this ticket is in flight
  | 'unresolved'; // an action on this ticket has an unknown outcome

export interface Ticket {
  tokenId: string;
  eventId: string;
  tier: number;
  tierName: string;
  owner: Address;
  /** What the first buyer paid the organizer (0 for comps); the refund amount */
  paid: string;
  face: string;
  /** Highest allowed resale price: face + 10 % */
  cap: string;
  /** '0' when not listed */
  listPrice: string;
  checkedIn: boolean;
  status: TicketStatus;
  event: Pick<EventInfo, 'id' | 'name' | 'venue' | 'startsAt' | 'endsAt' | 'cancelled' | 'refundOpen' | 'status'>;
  /** Latest journal entry for this ticket from this wallet, if any. */
  tx?: JournalEntry;
}

/** What the QR carries. `holder` is untrusted: it only helps explain errors. */
export interface QrPayload {
  v: 1;
  chainId: number;
  contract: Address;
  tokenId: string;
  deadline: string;
  holder: Address;
  signature: Hex;
}

export type ScanVerdict =
  | { kind: 'invalid-qr' }
  | { kind: 'expiring'; payload: QrPayload; secondsLeft: number } // under 15 s: must not be sent
  | { kind: 'rejected'; code: ErrorCode; payload: QrPayload; owner?: Address }
  | { kind: 'ok'; payload: QrPayload; secondsLeft: number; ticket?: Ticket };

export interface Balances {
  native: string;
  usdc: string;
}

export interface TicketService {
  getEvents(): Promise<EventInfo[]>;
  getEvent(eventId: string): Promise<EventInfo>;
  /** Tickets listed for resale in one event, cheapest first. */
  getListings(eventId: string): Promise<Ticket[]>;
  isScanner(address: Address): Promise<boolean>;
  getBalances(address: Address): Promise<Balances>;
  /** Tickets this wallet holds, plus the ones it sold on the market. */
  listTickets(): Promise<Ticket[]>;
  getTicket(tokenId: string): Promise<Ticket>;

  /** Each throws ServiceError before signing if the action must not proceed. */
  faucet(): Promise<JournalEntry>;
  buy(eventId: string, tier: number, quantity: number): Promise<JournalEntry>;
  buyListing(tokenId: string, price: string): Promise<JournalEntry>;
  list(tokenId: string, price: string): Promise<JournalEntry>;
  unlist(tokenId: string): Promise<JournalEntry>;
  claimRefund(tokenId: string): Promise<JournalEntry>;
  /** Refuses while an action on this ticket is in flight or if not the holder. Deadline = now + 180 s. */
  createQr(tokenId: string): Promise<{ encoded: string; payload: QrPayload }>;

  /** eth_call as the scanner; sends nothing. */
  preflight(rawQr: string): Promise<ScanVerdict>;
  /** Runs preflight again, then signs, journals and broadcasts. Returns the verdict if it no longer passes. */
  checkIn(rawQr: string): Promise<JournalEntry | ScanVerdict>;

  /** Looks up one entry by hash. Rebroadcasts the same rawTx if the node does not know it. Never re-signs. */
  lookup(entryId: string): Promise<JournalEntry>;
  /** Called at launch: looks up every non-final entry of this wallet. */
  resume(): Promise<JournalEntry[]>;
  journal(): Promise<JournalEntry[]>;
  /** Fires whenever a journal entry changes, including from the background receipt watcher. Returns unsubscribe. */
  subscribe(listener: (entry: JournalEntry) => void): () => void;
}

export class ServiceError extends Error {
  constructor(public code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ServiceError';
  }
}

export interface ServiceDeps {
  config: AppConfig;
  signer: LocalSigner;
  store: KeyValueStore;
  /** Injected clock in ms, for tests. Defaults to Date.now. */
  now?: () => number;
}
