// Contract between the chain layer (src/lib) and the screens. Change it only by agreement.
export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  contract: Address;
  nativeSymbol: string;
}

/** Async key/value persistence: AsyncStorage on device, in-memory in tests. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Holds a key locally. All values that are bigints on chain are decimal strings at this boundary. */
export interface LocalSigner {
  address: Address;
  /** EIP-712 signature over CheckIn(uint256 tokenId,uint256 deadline), domain EventTicket/1. */
  signCheckIn(args: { chainId: number; contract: Address; tokenId: string; deadline: string }): Promise<Hex>;
  /** Signs a prepared transaction and returns the raw bytes. Does not broadcast. */
  signTransaction(tx: Record<string, unknown>): Promise<Hex>;
}

export interface SaleInfo {
  priceWei: string;
  maxSupply: string;
  totalMinted: string;
  remaining: string;
  /** false when price is 0: no public sale, which does not mean free. */
  saleOpen: boolean;
  soldOut: boolean;
}

export type TxKind = 'buy' | 'transfer' | 'checkIn';
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
  tokenId?: string;
  to?: Address;
  quantity?: string;
  valueWei?: string;
  /** Contract error name when a reverted tx could be replayed for a reason. */
  reasonCode?: ErrorCode;
}

export type ErrorCode =
  | 'SoldOut' | 'SaleClosed' | 'WrongPayment' | 'NotScanner' | 'SignatureExpired' | 'InvalidSignature'
  | 'AlreadyCheckedIn' | 'TicketUsed' | 'WithdrawFailed' | 'OwnerChanged' | 'NonexistentToken'
  | 'InvalidRecipient' | 'InsufficientFunds' | 'WrongNetwork' | 'InFlight' | 'Network' | 'Unknown';

export type TicketStatus =
  | 'available'     // this wallet holds it and it is unused
  | 'transferring'  // a transfer from this wallet is submitting or pending
  | 'unresolved'    // a transfer from this wallet has an unknown outcome
  | 'transferred'   // this wallet sent it away, confirmed by receipt and ownerOf
  | 'used';         // checked in

export interface Ticket {
  tokenId: string;
  owner: Address;
  checkedIn: boolean;
  status: TicketStatus;
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
  | { kind: 'ok'; payload: QrPayload; secondsLeft: number };

export interface TicketService {
  getSale(): Promise<SaleInfo>;
  isScanner(address: Address): Promise<boolean>;
  getBalanceWei(address: Address): Promise<string>;
  /** Estimated network fee in wei. Throw ServiceError with the contract's code if the call would revert. */
  estimateBuyFeeWei(quantity: number): Promise<string>;
  estimateTransferFeeWei(tokenId: string, to: Address): Promise<string>;
  /** Tickets this wallet holds plus tickets it sent away, each with its derived status. */
  listTickets(): Promise<Ticket[]>;
  getTicket(tokenId: string): Promise<Ticket>;

  /** Each throws ServiceError before signing if the action must not proceed. */
  buy(quantity: number): Promise<JournalEntry>;
  transfer(tokenId: string, to: Address): Promise<JournalEntry>;
  /** Refuses while a transfer of this ticket is in flight or unresolved, or if not the holder. Deadline = now + 180 s. */
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
  /** Fires whenever a journal entry changes, including from the background receipt watcher started after each broadcast. Returns unsubscribe. */
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
