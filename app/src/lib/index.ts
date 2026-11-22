export * from './types';
import {
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  keccak256,
  isAddress,
  parseTransaction,
  decodeErrorResult,
  maxUint256,
  parseSignature,
  parseEventLogs,
  type Abi,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { abi, usdcAbi } from './abi';
import { receiptsAbi } from './pay';
import type { BuyOrder } from './relayer';
import {
  ServiceError,
  type Address,
  type Hex,
  type LocalSigner,
  type KeyValueStore,
  type ServiceDeps,
  type TicketService,
  type JournalEntry,
  type ErrorCode,
  type QrPayload,
  type Ticket,
  type EventInfo,
  type TicketStatus,
  type WaitlistState,
  type GateSnapshot,
  type ScanVerdict,
} from './types';

export const createPrivateKey = (): Hex => generatePrivateKey();

/** How long a QR made by this app is valid, and the longest validity the contract accepts (MAX_QR_WINDOW). */
export const QR_SECONDS = 180;
export const MAX_QR_SECONDS = 300;
const versionAbi = [{ type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const;

export function createLocalSigner(privateKey: Hex): LocalSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTransaction: (tx) => account.signTransaction(tx as never),
    signMessage: (text) => account.signMessage({ message: text }),
    signCheckIn: ({ chainId, contract, tokenId, deadline }) =>
      account.signTypedData({
        domain: { name: 'VeGoc', version: '1', chainId, verifyingContract: contract },
        types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'CheckIn',
        message: { tokenId: BigInt(tokenId), deadline: BigInt(deadline) },
      }),
    signBuy: ({ chainId, contract, eventId, tier, quantity, nonce, deadline }) =>
      account.signTypedData({
        domain: { name: 'VeGoc', version: '1', chainId, verifyingContract: contract },
        types: {
          Buy: [
            { name: 'buyer', type: 'address' },
            { name: 'eventId', type: 'uint256' },
            { name: 'tier', type: 'uint256' },
            { name: 'quantity', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Buy',
        message: { buyer: account.address, eventId: BigInt(eventId), tier: BigInt(tier), quantity: BigInt(quantity), nonce: BigInt(nonce), deadline: BigInt(deadline) },
      }),
    signPermit: ({ chainId, token, tokenName, tokenVersion, spender, value, nonce, deadline }) =>
      account.signTypedData({
        domain: { name: tokenName, version: tokenVersion, chainId, verifyingContract: token },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: { owner: account.address, spender, value: BigInt(value), nonce: BigInt(nonce), deadline: BigInt(deadline) },
      }),
  };
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => { m.set(k, v); },
    removeItem: async (k) => { m.delete(k); },
  };
}

export const encodeQr = (payload: QrPayload): string => JSON.stringify(payload);
export function decodeQr(raw: string): QrPayload | null {
  try {
    const p = JSON.parse(raw);
    const uint = (x: unknown) => typeof x === 'string' && /^(0|[1-9]\d*)$/.test(x) && BigInt(x) <= maxUint256;
    return p && p.v === 1 && Number.isSafeInteger(p.chainId) && p.chainId > 0 &&
      typeof p.contract === 'string' && isAddress(p.contract) &&
      typeof p.holder === 'string' && isAddress(p.holder) &&
      uint(p.tokenId) && uint(p.deadline) &&
      typeof p.signature === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(p.signature)
      ? p
      : null;
  } catch {
    return null;
  }
}

const contractCodes = new Set<string>([
  'SoldOut', 'SaleClosed', 'WalletLimit', 'EventCancelled', 'EventEnded', 'NotScanner', 'NotHolder',
  'SignatureExpired', 'InvalidSignature', 'AlreadyCheckedIn', 'TicketUsed', 'TransferBlocked', 'AboveCap',
  'NotListed', 'PriceChanged', 'OwnListing', 'NotRefundable', 'FaucetCooldown', 'BadEvent', 'BadTier',
  'DeadlineTooFar', 'HolderNotWallet', 'CompNotResellable', 'WaitlistFirst', 'ListingsOpen', 'AlreadyWaiting', 'NotWaiting',
]);
const errorAbi = [...abi, ...usdcAbi] as Abi;
function mapName(name: string | undefined): ErrorCode | undefined {
  if (!name) return undefined;
  if (contractCodes.has(name)) return name as ErrorCode;
  if (name === 'ERC721NonexistentToken') return 'NonexistentToken';
  if (name === 'ERC721IncorrectOwner' || name === 'ERC721InsufficientApproval') return 'OwnerChanged';
  if (name === 'ERC20InsufficientBalance' || name === 'ERC20InsufficientAllowance') return 'InsufficientUsdc';
  return undefined;
}
export function errorCode(error: unknown): ErrorCode {
  const seen = new Set<unknown>();
  let e = error as any;
  while (e && !seen.has(e)) {
    seen.add(e);
    const named = mapName(e.data?.errorName ?? e.errorName);
    if (named) return named;
    if (typeof e.data === 'string') {
      try {
        const d = mapName(decodeErrorResult({ abi: errorAbi, data: e.data as Hex }).errorName);
        if (d) return d;
      } catch {}
    }
    if (/insufficient funds/i.test(e.message ?? '')) return 'InsufficientFunds';
    e = e.cause;
  }
  return /revert/i.test(String(error)) ? 'Unknown' : 'Network';
}

const final = (e: JournalEntry) => e.state === 'succeeded' || e.state === 'reverted';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function toEventInfo(v: any, nowSec: number): EventInfo {
  const d = v.data;
  const endsAt = Number(d.endsAt);
  return {
    id: v.id.toString(),
    name: d.name,
    venue: d.venue,
    organizer: d.organizer,
    startsAt: Number(d.startsAt),
    endsAt,
    maxPerWallet: Number(d.maxPerWallet),
    cancelled: d.cancelled,
    settled: d.settled,
    issued: Number(d.issued),
    checkedIn: Number(d.checkedIn),
    refunded: Number(d.refunded),
    resales: Number(d.resales),
    sales: d.sales.toString(),
    resaleVolume: d.resaleVolume.toString(),
    resaleFaceVolume: d.resaleFaceVolume.toString(),
    tiers: v.tiers.map((t: any) => ({ name: t.name, price: t.price.toString(), supply: Number(t.supply), sold: Number(t.sold) })),
    principal: v.principal.toString(),
    yieldAccrued: v.yieldAccrued.toString(),
    listed: Number(v.listed),
    settleAt: Number(v.settleAt),
    refundOpen: v.refundOpen,
    quorumMet: v.quorumMet,
    paidSold: Number(v.paidSold),
    paidCheckedIn: Number(v.paidCheckedIn),
    waiting: (v.waiting as bigint[]).map(Number),
    status: d.cancelled ? 'cancelled' : nowSec >= endsAt ? 'ended' : 'onsale',
  };
}

export function createTicketService({ config, signer, store, relayer, gate, now = Date.now }: ServiceDeps): TicketService {
  const chain = defineChain({
    id: config.chainId,
    name: 'VeGoc',
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  // A local chain answers at once; public testnet RPCs drop or rate-limit calls now and then, so retry and poll gently.
  const local = config.chainId === 31337;
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: local ? 0 : 2, timeout: 8000 }) });
  const pollMs = local ? 300 : 500;
  /** Consecutive failed checks before a watched transaction is shown as unknown. */
  const maxMisses = local ? 1 : 16;
  const key = `ticket-journal:${config.chainId}:${config.contract.toLowerCase()}:${signer.address.toLowerCase()}`;
  const listeners = new Set<(e: JournalEntry) => void>();
  const watching = new Set<string>();
  let writes: Promise<unknown> = Promise.resolve();
  let actions: Promise<unknown> = Promise.resolve();
  const nowSec = () => Math.floor(now() / 1000);

  const journal = async (): Promise<JournalEntry[]> => {
    await writes;
    return JSON.parse((await store.getItem(key)) ?? '[]');
  };
  const save = (entry: JournalEntry): Promise<JournalEntry> => {
    const work = writes.then(async () => {
      const entries: JournalEntry[] = JSON.parse((await store.getItem(key)) ?? '[]');
      const i = entries.findIndex((e) => e.id === entry.id);
      if (i < 0) entries.push(entry);
      else entries[i] = entry;
      await store.setItem(key, JSON.stringify(entries));
      for (const l of listeners) {
        try { l({ ...entry }); } catch {}
      }
      return entry;
    });
    writes = work.catch(() => {});
    return work;
  };
  const read = async (functionName: string, args: readonly unknown[] = [], address: Address = config.contract, useAbi: Abi = abi as Abi): Promise<any> => {
    try {
      return await client.readContract({ address, abi: useAbi, functionName, args } as never);
    } catch (e) {
      throw new ServiceError(errorCode(e));
    }
  };
  const openFor = async (tokenId: string) => (await journal()).filter((e) => e.tokenId === tokenId && !final(e));

  function watch(id: string) {
    if (watching.has(id)) return;
    watching.add(id);
    void (async () => {
      try {
        let misses = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, pollMs));
          try {
            const e = await lookup(id, true);
            misses = 0;
            if (final(e)) break;
          } catch {
            if (++misses >= maxMisses) { await lookup(id); break; }
          }
        }
      } catch {
      } finally {
        watching.delete(id);
      }
    })();
  }

  /**
   * Milliseconds from sending to the block's own timestamp. Avalanche blocks carry `timestampMilliseconds`; other
   * chains do not, and a phone clock can be off, so anything outside 0..receipt time is dropped.
   */
  async function blockDelay(blockNumber: bigint, sentAt: number, receiptMs: number): Promise<number | undefined> {
    try {
      const block = (await client.request({ method: 'eth_getBlockByNumber', params: [`0x${blockNumber.toString(16)}`, false] } as never)) as { timestampMilliseconds?: string } | null;
      if (!block?.timestampMilliseconds) return undefined;
      const ms = Number(BigInt(block.timestampMilliseconds)) - sentAt;
      return ms >= 0 && ms <= receiptMs ? ms : undefined;
    } catch {
      return undefined;
    }
  }

  /** With quiet set, a failed check throws instead of marking the entry unknown, so the watcher can try again. */
  async function lookup(id: string, quiet = false): Promise<JournalEntry> {
    let entry = (await journal()).find((e) => e.id === id);
    if (!entry) throw new ServiceError('Unknown', 'Unknown journal entry');
    if (final(entry)) return entry;
    try {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: entry.hash });
      } catch (e) {
        if ((e as any).name !== 'TransactionReceiptNotFoundError') throw e;
      }
      if (receipt) {
        entry = {
          ...entry,
          state: receipt.status === 'success' ? 'succeeded' : 'reverted',
          feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
          // Only when this run sent it and saw the receipt: a lookup after a restart says nothing about speed.
          confirmedMs: entry.sentAt !== undefined && entry.state === 'pending' ? Math.max(0, now() - entry.sentAt) : entry.confirmedMs,
        };
        if (entry.confirmedMs !== undefined && entry.blockMs === undefined) entry.blockMs = await blockDelay(receipt.blockNumber, entry.sentAt!, entry.confirmedMs);
        if (entry.kind === 'list' && entry.state === 'succeeded') {
          // A listing made while someone waited is sold in the same transaction.
          const [sold] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Resold' });
          if (sold) entry.soldTo = sold.args.buyer;
        }
        if (entry.state === 'reverted') {
          entry.reasonCode = 'Unknown';
          try {
            let tx: { from: Address; to?: Address | null; data?: Hex; value?: bigint };
            if (entry.relayed) {
              const sent = await client.getTransaction({ hash: entry.hash });
              tx = { from: sent.from, to: sent.to, data: sent.input, value: sent.value };
            } else tx = { ...parseTransaction(entry.rawTx), from: entry.wallet };
            await client.call({ account: tx.from, to: tx.to!, data: tx.data, value: tx.value, blockNumber: receipt.blockNumber });
          } catch (e) {
            const code = errorCode(e);
            entry.reasonCode = code === 'Network' ? 'Unknown' : code;
          }
        }
        return save(entry);
      }
      let known = false;
      try {
        await client.getTransaction({ hash: entry.hash });
        known = true;
      } catch (e) {
        if ((e as any).name !== 'TransactionNotFoundError') throw e;
      }
      if (!known && entry.relayed) {
        // Only the relayer holds the signed transaction. Not seen yet: try again later, never re-sign.
        if (quiet) throw new ServiceError('Network');
        return save({ ...entry, state: 'unknown' });
      }
      if (!known) {
        try {
          await client.sendRawTransaction({ serializedTransaction: entry.rawTx });
        } catch (e) {
          // The nonce was consumed by another transaction, so this one can never be mined.
          if (/nonce too low|nonce provided.*lower|nonce has already been used/i.test(String(e)))
            return save({ ...entry, state: 'reverted', reasonCode: 'Unknown' });
          if (!/already known|known transaction/i.test(String(e))) throw e;
        }
      }
      entry = { ...entry, state: 'pending' };
      await save(entry);
      watch(id);
      return entry;
    } catch (e) {
      if (quiet) throw e;
      return save({ ...entry, state: 'unknown' });
    }
  }

  type Call = { to: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  const box = (functionName: string, args: readonly unknown[]): Call => ({ to: config.contract, abi: abi as Abi, functionName, args });

  async function prepare(call: Call) {
    try {
      await client.simulateContract({ address: call.to, abi: call.abi, functionName: call.functionName, args: call.args, account: signer.address } as never);
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
      const [nonce, fees, estimate, balance] = await Promise.all([
        client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        client.estimateFeesPerGas(),
        client.estimateGas({ account: signer.address, to: call.to, data }),
        client.getBalance({ address: signer.address }),
      ]);
      const gas = (estimate * 120n + 99n) / 100n;
      if (balance < gas * fees.maxFeePerGas) {
        // The guest holds no AVAX: the relayer sends just enough for this one transaction.
        if (!relayer) throw new ServiceError('InsufficientFunds');
        await relayer.topUp(signer.address);
        if ((await client.getBalance({ address: signer.address })) < gas * fees.maxFeePerGas) throw new ServiceError('InsufficientFunds');
      }
      return {
        chainId: config.chainId, to: call.to, data, value: 0n, nonce, gas,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, type: 'eip1559' as const,
      };
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError(errorCode(e));
    }
  }

  async function send(kind: JournalEntry['kind'], build: () => Promise<Call>, extra: Partial<JournalEntry> = {}, beforeSigning?: () => void): Promise<JournalEntry> {
    const work = actions.then(async () => {
      const entries = await journal();
      if (entries.some((e) => e.state === 'unknown' || e.state === 'submitting')) throw new ServiceError('InFlight');
      if (extra.tokenId && entries.some((e) => e.tokenId === extra.tokenId && !final(e))) throw new ServiceError('InFlight');
      const tx = await prepare(await build());
      beforeSigning?.();
      const rawTx = await signer.signTransaction(tx);
      const hash = keccak256(rawTx);
      let entry: JournalEntry = { ...extra, id: hash, kind, state: 'submitting', wallet: signer.address, hash, rawTx, nonce: tx.nonce, createdAt: now(), to: tx.to };
      await save(entry);
      try {
        const sentAt = now();
        await client.sendRawTransaction({ serializedTransaction: rawTx });
        entry = await save({ ...entry, state: 'pending', sentAt });
      } catch {
        entry = await save({ ...entry, state: 'unknown' });
      }
      watch(entry.id);
      return entry;
    });
    actions = work.catch(() => {});
    return work;
  }

  /** Journals a transaction the relayer sent: same states and watcher as our own, nothing to rebroadcast. */
  async function relayed(kind: JournalEntry['kind'], submit: () => Promise<{ hash: Hex }>, extra: Partial<JournalEntry> = {}, to: Address = config.contract): Promise<JournalEntry> {
    const work = actions.then(async () => {
      const entries = await journal();
      if (entries.some((e) => e.state === 'unknown' || e.state === 'submitting')) throw new ServiceError('InFlight');
      const sentAt = now();
      const { hash } = await submit();
      const entry = await save({ ...extra, id: hash, kind, state: 'pending', wallet: signer.address, hash, rawTx: '0x', nonce: -1, createdAt: sentAt, sentAt, to, relayed: true });
      watch(entry.id);
      return entry;
    });
    actions = work.catch(() => {});
    return work;
  }

  /** Spends `amount` USDC through VeGoc: plain call if the allowance covers it, else the permit variant. */
  async function withPayment(amount: bigint, plain: Call, permitted: (deadline: bigint, v: number, r: Hex, s: Hex) => Call): Promise<Call> {
    const [allowance, balance] = await Promise.all([
      read('allowance', [signer.address, config.contract], config.usdc, usdcAbi as Abi),
      read('balanceOf', [signer.address], config.usdc, usdcAbi as Abi),
    ]);
    if (balance < amount) throw new ServiceError('InsufficientUsdc');
    if (allowance >= amount) return plain;
    const [nonce, name, version] = await Promise.all([
      read('nonces', [signer.address], config.usdc, usdcAbi as Abi),
      read('name', [], config.usdc, usdcAbi as Abi),
      permitVersion(),
    ]);
    const deadline = BigInt(nowSec() + 1200);
    const sig = await signer.signPermit({
      chainId: config.chainId, token: config.usdc, tokenName: name, tokenVersion: version, spender: config.contract,
      value: amount.toString(), nonce: nonce.toString(), deadline: deadline.toString(),
    });
    const { v, r, s, yParity } = parseSignature(sig);
    return permitted(deadline, Number(v ?? BigInt(yParity + 27)), r, s);
  }

  /**
   * EIP-712 version of the payment token's permit domain. Circle's USDC answers `version()` with "2"; OpenZeppelin's
   * ERC20Permit (the mock) has no such function and uses "1".
   */
  let tokenVersion: string | undefined;
  async function permitVersion(): Promise<string> {
    if (tokenVersion === undefined) {
      try {
        tokenVersion = (await client.readContract({ address: config.usdc, abi: versionAbi, functionName: 'version' })) as string;
      } catch (e) {
        if (errorCode(e) === 'Network') throw new ServiceError('Network');
        tokenVersion = '1';
      }
    }
    return tokenVersion;
  }

  /**
   * The guest's signed purchase: the EIP-712 `Buy` message and the token's permit for the total. Whoever sends it
   * (the relayer, with buyFor) pays the gas and can change nothing about the order.
   */
  async function signOrder(eventId: string, tier: number, quantity: number, amount: bigint): Promise<BuyOrder> {
    const [permitNonce, name, version, buyNonce] = await Promise.all([
      read('nonces', [signer.address], config.usdc, usdcAbi as Abi),
      read('name', [], config.usdc, usdcAbi as Abi),
      permitVersion(),
      read('nonces', [signer.address]),
    ]);
    const deadline = String(nowSec() + 1200);
    const permitSig = await signer.signPermit({
      chainId: config.chainId, token: config.usdc, tokenName: name, tokenVersion: version, spender: config.contract,
      value: amount.toString(), nonce: permitNonce.toString(), deadline,
    });
    const signature = await signer.signBuy({ chainId: config.chainId, contract: config.contract, eventId, tier: String(tier), quantity: String(quantity), nonce: buyNonce.toString(), deadline });
    const { v, r, s, yParity } = parseSignature(permitSig);
    return { buyer: signer.address, eventId, tier: String(tier), quantity: String(quantity), deadline, signature, permit: { v: Number(v ?? BigInt(yParity + 27)), r, s } };
  }

  /** The guest signs the order and the permit; the relayer sends buyFor and pays the gas. */
  async function relayedBuy(eventId: string, tier: number, quantity: number, amount: bigint) {
    const balance = await read('balanceOf', [signer.address], config.usdc, usdcAbi as Abi);
    if (balance < amount) throw new ServiceError('InsufficientUsdc');
    return relayer!.buy(await signOrder(eventId, tier, quantity, amount));
  }

  async function priceOf(eventId: string, tier: number, quantity: number): Promise<bigint> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ServiceError('SoldOut');
    const t = (await service.getEvent(eventId)).tiers[tier];
    if (!t) throw new ServiceError('BadTier');
    return BigInt(t.price) * BigInt(quantity);
  }

  let eventCache: { at: number; list: EventInfo[] } | null = null;
  async function events(fresh = true): Promise<EventInfo[]> {
    if (!fresh && eventCache && now() - eventCache.at < 10_000) return eventCache.list;
    const list = ((await read('getEvents')) as any[]).map((v) => toEventInfo(v, nowSec()));
    eventCache = { at: now(), list };
    return list;
  }

  function toTicket(v: any, ev: EventInfo | undefined, entries: JournalEntry[]): Ticket {
    const tokenId = v.tokenId.toString();
    const related = entries.filter((e) => e.tokenId === tokenId);
    const open = related.filter((e) => !final(e)).at(-1);
    const mine = same(v.owner, signer.address);
    let status: TicketStatus = v.checkedIn ? 'used' : ev?.refundOpen ? 'refundable' : v.listPrice > 0n ? 'listed' : 'available';
    if (!mine) status = 'sold';
    if (open) status = open.state === 'unknown' ? 'unresolved' : 'pending';
    const tier = Number(v.tier);
    return {
      tokenId,
      eventId: v.eventId.toString(),
      tier,
      tierName: ev?.tiers[tier]?.name ?? '',
      owner: v.owner,
      paid: v.paid.toString(),
      face: v.face.toString(),
      cap: v.cap.toString(),
      listPrice: v.listPrice.toString(),
      checkedIn: v.checkedIn,
      status,
      event: ev
        ? { id: ev.id, name: ev.name, venue: ev.venue, startsAt: ev.startsAt, endsAt: ev.endsAt, cancelled: ev.cancelled, refundOpen: ev.refundOpen, status: ev.status }
        : { id: v.eventId.toString(), name: '', venue: '', startsAt: 0, endsAt: 0, cancelled: false, refundOpen: false, status: 'onsale' },
      tx: related.at(-1),
    };
  }

  async function ticket(tokenId: string): Promise<Ticket> {
    const [v, list, entries] = await Promise.all([read('getTicket', [BigInt(tokenId)]), events(false), journal()]);
    return toTicket(v, list.find((e) => e.id === v.eventId.toString()), entries);
  }

  async function holderTicket(tokenId: string) {
    if ((await openFor(tokenId)).length) throw new ServiceError('InFlight');
    const t = await ticket(tokenId);
    if (!same(t.owner, signer.address)) throw new ServiceError('OwnerChanged');
    return t;
  }

  const service: TicketService = {
    getEvents: async () => {
      const all = await events(true);
      // The contract lets anyone create an event; the app lists only the organizers it was configured with.
      const allowed = config.organizers?.map((a) => a.toLowerCase());
      return allowed?.length ? all.filter((e) => allowed.includes(e.organizer.toLowerCase())) : all;
    },
    getEvent: async (id) => {
      const v = await read('getEvent', [BigInt(id)]);
      return toEventInfo(v, nowSec());
    },
    getListings: async (eventId) => {
      const [views, list, entries] = await Promise.all([read('listings', [BigInt(eventId)]), events(false), journal()]);
      const ev = list.find((e) => e.id === eventId);
      return (views as any[])
        .map((v) => toTicket(v, ev, entries))
        .sort((a, b) => (BigInt(a.listPrice) < BigInt(b.listPrice) ? -1 : 1));
    },
    isScanner: async (address) => (await read('scannerFor', [address])) > 0n,
    getBalances: async (address) => {
      try {
        const [native, usdc] = await Promise.all([
          client.getBalance({ address }),
          client.readContract({ address: config.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [address] }),
        ]);
        return { native: native.toString(), usdc: (usdc as bigint).toString() };
      } catch {
        throw new ServiceError('Network');
      }
    },
    listTickets: async () => {
      const [views, list, entries] = await Promise.all([read('ticketsOf', [signer.address]), events(true), journal()]);
      const byEvent = new Map(list.map((e) => [e.id, e]));
      const held = (views as any[]).map((v) => toTicket(v, byEvent.get(v.eventId.toString()), entries));
      const heldIds = new Set(held.map((t) => t.tokenId));
      // Tickets this wallet listed that are now someone else's: show them as sold.
      const listedIds = [...new Set(entries.filter((e) => e.kind === 'list' && e.state === 'succeeded').map((e) => e.tokenId!))].filter((id) => !heldIds.has(id));
      const sold: Ticket[] = [];
      for (const id of listedIds) {
        try {
          const v = await read('getTicket', [BigInt(id)]);
          if (!same(v.owner, signer.address)) sold.push(toTicket(v, byEvent.get(v.eventId.toString()), entries));
        } catch (e) {
          if ((e as ServiceError).code !== 'NonexistentToken') throw e;
        }
      }
      return [...held, ...sold].sort((a, b) => Number(b.tokenId) - Number(a.tokenId));
    },
    getTicket: ticket,

    faucet: () => relayer
      ? relayed('faucet', () => relayer.faucet(signer.address), {}, config.usdc)
      : send('faucet', async () => ({ to: config.usdc, abi: usdcAbi as Abi, functionName: 'faucet', args: [] })),
    buy: async (eventId, tier, quantity) => {
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ServiceError('SoldOut');
      const ev = await service.getEvent(eventId);
      const t = ev.tiers[tier];
      if (!t) throw new ServiceError('BadTier');
      const amount = BigInt(t.price) * BigInt(quantity);
      const args = [BigInt(eventId), BigInt(tier), BigInt(quantity)] as const;
      const extra = { eventId, tier: String(tier), quantity: String(quantity), amount: amount.toString() };
      if (relayer) return relayed('buy', () => relayedBuy(eventId, tier, quantity, amount), extra);
      return send('buy', () => withPayment(amount, box('buy', args), (d, v, r, s) => box('buyWithPermit', [...args, d, v, r, s])), {
        eventId, tier: String(tier), quantity: String(quantity), amount: amount.toString(),
      });
    },
    signBuyOrder: async (eventId, tier, quantity) => signOrder(eventId, tier, quantity, await priceOf(eventId, tier, quantity)),
    adoptBuy: async (hash, eventId, tier, quantity) => {
      const amount = await priceOf(eventId, tier, quantity);
      return relayed('buy', async () => ({ hash }), { eventId, tier: String(tier), quantity: String(quantity), amount: amount.toString() });
    },
    receiptsOf: async (tokenId) => {
      if (!config.receipts) return [];
      try {
        const rows = (await client.readContract({ address: config.receipts, abi: receiptsAbi, functionName: 'receiptsOf', args: [BigInt(tokenId)] })) as readonly { receiptHash: Hex; kind: number; at: bigint }[];
        return rows.map((r) => ({ receiptHash: r.receiptHash, kind: Number(r.kind), at: Number(r.at) }));
      } catch (e) {
        throw new ServiceError(errorCode(e));
      }
    },
    buyListing: async (tokenId, price) => {
      const t = await ticket(tokenId);
      if (same(t.owner, signer.address)) throw new ServiceError('OwnListing');
      if (t.listPrice === '0') throw new ServiceError('NotListed');
      if (BigInt(t.listPrice) > BigInt(price)) throw new ServiceError('PriceChanged');
      const max = BigInt(price);
      return send('resale', () => withPayment(max, box('buyListing', [BigInt(tokenId), max]), (d, v, r, s) => box('buyListingWithPermit', [BigInt(tokenId), max, d, v, r, s])), {
        tokenId, eventId: t.eventId, amount: t.listPrice,
      });
    },
    list: async (tokenId, price) => {
      const t = await holderTicket(tokenId);
      const p = BigInt(price);
      if (t.paid === '0') throw new ServiceError('CompNotResellable');
      if (p <= 0n || p > BigInt(t.cap)) throw new ServiceError('AboveCap');
      return send('list', async () => box('list', [BigInt(tokenId), p]), { tokenId, eventId: t.eventId, amount: price });
    },
    unlist: async (tokenId) => {
      const t = await holderTicket(tokenId);
      return send('unlist', async () => box('unlist', [BigInt(tokenId)]), { tokenId, eventId: t.eventId });
    },
    getWaitlist: async (eventId) => {
      const ev = await service.getEvent(eventId);
      return Promise.all(ev.tiers.map(async (t, tier): Promise<WaitlistState> => {
        const [position, deposit] = (await read('waitlistPlace', [BigInt(eventId), BigInt(tier), signer.address])) as [bigint, bigint];
        return { tier, waiting: ev.waiting[tier] ?? 0, position: Number(position), deposit: deposit.toString(), cap: ((BigInt(t.price) * 11_000n) / 10_000n).toString() };
      }));
    },
    joinWaitlist: async (eventId, tier) => {
      const ev = await service.getEvent(eventId);
      const t = ev.tiers[tier];
      if (!t) throw new ServiceError('BadTier');
      const deposit = (BigInt(t.price) * 11_000n) / 10_000n;
      const args = [BigInt(eventId), BigInt(tier)] as const;
      return send('waitJoin', () => withPayment(deposit, box('joinWaitlist', args), (d, v, r, s) => box('joinWaitlistWithPermit', [...args, d, v, r, s])), {
        eventId, tier: String(tier), amount: deposit.toString(),
      });
    },
    leaveWaitlist: async (eventId, tier) => {
      const [, deposit] = (await read('waitlistPlace', [BigInt(eventId), BigInt(tier), signer.address])) as [bigint, bigint];
      if (deposit === 0n) throw new ServiceError('NotWaiting');
      return send('waitLeave', async () => box('leaveWaitlist', [BigInt(eventId), BigInt(tier)]), { eventId, tier: String(tier), amount: deposit.toString() });
    },
    getCredit: async () => ((await read('credit', [signer.address])) as bigint).toString(),
    withdrawCredit: async () => {
      const amount = (await read('credit', [signer.address])) as bigint;
      return send('credit', async () => box('withdrawCredit', []), { amount: amount.toString() });
    },
    claimRefund: async (tokenId) => {
      const t = await holderTicket(tokenId);
      return send('refund', async () => box('claimRefund', [BigInt(tokenId)]), { tokenId, eventId: t.eventId, amount: t.paid });
    },
    createQr: async (tokenId) => {
      const t = await holderTicket(tokenId);
      if (t.checkedIn) throw new ServiceError('TicketUsed');
      if (t.event.cancelled) throw new ServiceError('EventCancelled');
      if (t.event.status === 'ended') throw new ServiceError('EventEnded');
      const deadline = (BigInt(nowSec()) + BigInt(QR_SECONDS)).toString();
      const signature = await signer.signCheckIn({ chainId: config.chainId, contract: config.contract, tokenId, deadline });
      const payload: QrPayload = { v: 1, chainId: config.chainId, contract: config.contract, holder: signer.address, tokenId, deadline, signature };
      return { payload, encoded: encodeQr(payload) };
    },
    gateSnapshot: async () => {
      const [domain, list, total] = await Promise.all([read('eip712Domain'), events(true), read('totalMinted')]);
      const open = list.filter((e) => e.status === 'onsale');
      const allowed = await Promise.all(open.map((e) => read('isScanner', [BigInt(e.id), signer.address])));
      const mine = open.filter((_, i) => allowed[i]);
      const byId = new Map(mine.map((e) => [e.id, e]));
      const snap: GateSnapshot = {
        v: 1, takenAt: now(), gate: signer.address,
        domain: { name: domain[1], version: domain[2], chainId: Number(domain[3]), verifyingContract: domain[4] },
        events: Object.fromEntries(mine.map((e) => [e.id, { name: e.name, endsAt: e.endsAt, cancelled: e.cancelled }])),
        tickets: {},
      };
      if (!mine.length) return snap;
      // Token ids run from 0 to totalMinted - 1. Read in chunks so a public RPC is not flooded.
      const ids = Array.from({ length: Number(total) }, (_, i) => BigInt(i));
      for (let i = 0; i < ids.length; i += 25) {
        // A refunded ticket is burned, and getTicket reverts for it.
        const views = await Promise.all(ids.slice(i, i + 25).map((id) => read('getTicket', [id]).catch((e) => {
          if ((e as ServiceError).code === 'NonexistentToken') return null;
          throw e;
        })));
        for (const v of views) {
          // A listed ticket can be sold any second, so it is left out: offline, it is refused (NotInSnapshot).
          if (!v || v.listPrice > 0n) continue;
          const ev = byId.get(v.eventId.toString());
          if (ev) snap.tickets[v.tokenId.toString()] = { eventId: ev.id, tierName: ev.tiers[Number(v.tier)]?.name ?? '', holder: v.owner, checkedIn: v.checkedIn };
        }
      }
      return snap;
    },
    ping: async () => {
      try { await client.getBlockNumber({ cacheTime: 0 }); } catch { throw new ServiceError('Network'); }
    },
    preflight: async (raw) => {
      const payload = decodeQr(raw);
      if (!payload) return { kind: 'invalid-qr' };
      const reject = (code: ErrorCode) => ({ kind: 'rejected' as const, code, payload });
      if ((await journal()).some((e) => e.kind === 'checkIn' && e.tokenId === payload.tokenId && !final(e))) return reject('InFlight');
      if (payload.chainId !== config.chainId || !same(payload.contract, config.contract)) return reject('WrongNetwork');
      const remaining = BigInt(payload.deadline) - BigInt(nowSec());
      if (remaining < 0n) return reject('SignatureExpired');
      // The contract refuses a deadline more than five minutes ahead; say so without a round trip.
      if (remaining > BigInt(MAX_QR_SECONDS)) return reject('DeadlineTooFar');
      if (remaining < 15n) return { kind: 'expiring', payload, secondsLeft: Number(remaining) };
      try {
        await client.simulateContract({
          address: config.contract, abi, functionName: 'checkIn',
          args: [BigInt(payload.tokenId), BigInt(payload.deadline), payload.signature], account: signer.address,
        });
        let info: Ticket | undefined;
        try { info = await ticket(payload.tokenId); } catch {}
        return { kind: 'ok', payload, ticket: info, secondsLeft: Number(remaining > 100000n ? 100000n : remaining) };
      } catch (e) {
        const code = errorCode(e);
        if (code === 'Network') throw new ServiceError('Network');
        if (code === 'InvalidSignature') {
          const owner = await read('ownerOf', [BigInt(payload.tokenId)]);
          if (!same(owner, payload.holder)) return { ...reject('OwnerChanged'), owner };
        }
        return reject(code);
      }
    },
    checkIn: async (raw) => {
      const verdict = await service.preflight(raw);
      if (verdict.kind !== 'ok') return verdict;
      const p = verdict.payload;
      // Preflight and prepare both wait on the network, so the 15 second rule is checked again before signing.
      const secondsLeft = () => Number(BigInt(p.deadline) - BigInt(nowSec()));
      const TOO_LATE = new ServiceError('SignatureExpired');
      if (gate) {
        // No key on this device: the relayer checks the QR again and sends the check-in with the gate key.
        if (secondsLeft() < 15) return { kind: 'expiring', payload: p, secondsLeft: Math.max(0, secondsLeft()) };
        let refused: ScanVerdict | undefined;
        if ((await journal()).some((e) => e.tokenId === p.tokenId && !final(e))) throw new ServiceError('InFlight');
        try {
          return await relayed('checkIn', async () => {
            const r = await gate.checkIn(raw);
            if ('verdict' in r) { refused = r.verdict; throw TOO_LATE; }
            return r;
          }, { tokenId: p.tokenId });
        } catch (e) {
          if (e === TOO_LATE && refused) return refused;
          throw e;
        }
      }
      try {
        return await send('checkIn', async () => box('checkIn', [BigInt(p.tokenId), BigInt(p.deadline), p.signature]), { tokenId: p.tokenId }, () => {
          if (secondsLeft() < 15) throw TOO_LATE;
        });
      } catch (e) {
        if (e === TOO_LATE) return { kind: 'expiring', payload: p, secondsLeft: Math.max(0, secondsLeft()) };
        throw e;
      }
    },
    lookup,
    resume: async () => Promise.all((await journal()).filter((e) => !final(e)).map((e) => lookup(e.id))),
    journal,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return service;
}
