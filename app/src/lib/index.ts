export * from './types';
import {
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  keccak256,
  isAddress,
  zeroAddress,
  parseTransaction,
  decodeErrorResult,
  decodeEventLog,
  maxUint256,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { abi } from './abi';
import {
  ServiceError,
  type Hex,
  type LocalSigner,
  type KeyValueStore,
  type ServiceDeps,
  type TicketService,
  type JournalEntry,
  type ErrorCode,
  type QrPayload,
  type Ticket,
} from './types';
export const createPrivateKey = (): Hex => generatePrivateKey();
export function createLocalSigner(privateKey: Hex): LocalSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTransaction: (tx) => account.signTransaction(tx as never),
    signCheckIn: ({ chainId, contract, tokenId, deadline }) =>
      account.signTypedData({
        domain: { name: 'EventTicket', version: '1', chainId, verifyingContract: contract },
        types: {
          CheckIn: [
            { name: 'tokenId', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'CheckIn',
        message: { tokenId: BigInt(tokenId), deadline: BigInt(deadline) },
      }),
  };
}
export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
}
export const encodeQr = (payload: QrPayload): string => JSON.stringify(payload);
export function decodeQr(raw: string): QrPayload | null {
  try {
    const p = JSON.parse(raw);
    return p &&
      p.v === 1 &&
      Number.isSafeInteger(p.chainId) &&
      p.chainId > 0 &&
      typeof p.contract === 'string' &&
      isAddress(p.contract) &&
      typeof p.holder === 'string' &&
      isAddress(p.holder) &&
      typeof p.tokenId === 'string' &&
      /^(0|[1-9]\d*)$/.test(p.tokenId) &&
      BigInt(p.tokenId) <= maxUint256 &&
      typeof p.deadline === 'string' &&
      /^(0|[1-9]\d*)$/.test(p.deadline) &&
      BigInt(p.deadline) <= maxUint256 &&
      typeof p.signature === 'string' &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(p.signature)
      ? p
      : null;
  } catch {
    return null;
  }
}
const codes = new Set([
  'SoldOut',
  'SaleClosed',
  'WrongPayment',
  'NotScanner',
  'SignatureExpired',
  'InvalidSignature',
  'AlreadyCheckedIn',
  'TicketUsed',
  'WithdrawFailed',
]);
export function errorCode(error: unknown): ErrorCode {
  const seen = new Set<unknown>();
  let e = error as any;
  while (e && !seen.has(e)) {
    seen.add(e);
    const name = e.data?.errorName ?? e.errorName;
    if (codes.has(name)) return name;
    if (name === 'ERC721NonexistentToken') return 'NonexistentToken';
    if (name === 'ERC721InvalidReceiver') return 'InvalidRecipient';
    if (name === 'ERC721IncorrectOwner' || name === 'ERC721InsufficientApproval') return 'OwnerChanged';
    if (typeof e.data === 'string') {
      try {
        const d = decodeErrorResult({ abi, data: e.data as Hex });
        if (codes.has(d.errorName)) return d.errorName as ErrorCode;
        if (d.errorName === 'ERC721NonexistentToken') return 'NonexistentToken';
      } catch {}
    }
    if (/insufficient funds/i.test(e.message ?? '')) return 'InsufficientFunds';
    e = e.cause;
  }
  return /revert/i.test(String(error)) ? 'Unknown' : 'Network';
}
const final = (e: JournalEntry) => e.state === 'succeeded' || e.state === 'reverted';
export function createTicketService({ config, signer, store, now = Date.now }: ServiceDeps): TicketService {
  const chain = defineChain({
    id: config.chainId,
    name: 'EventTicket',
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  // A local chain answers at once; public testnet RPCs drop or rate-limit calls now and then, so retry and poll gently.
  const local = config.chainId === 31337;
  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: local ? 0 : 2, timeout: 8000 }),
  });
  const pollMs = local ? 300 : 1500;
  /** Consecutive failed checks before a watched transaction is shown as unknown. */
  const maxMisses = local ? 1 : 8;
  const key = `ticket-journal:${config.chainId}:${config.contract.toLowerCase()}:${signer.address.toLowerCase()}`;
  const mintedTokens = new Map<string, string[]>();
  const listeners = new Set<(e: JournalEntry) => void>();
  const watching = new Set<string>();
  let writes: Promise<unknown> = Promise.resolve();
  let actions: Promise<unknown> = Promise.resolve();
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
        try {
          l({ ...entry });
        } catch {}
      }
      return entry;
    });
    writes = work.catch(() => {});
    return work;
  };
  const read = async (functionName: string, args: readonly unknown[] = []): Promise<any> => {
    try {
      return await client.readContract({ address: config.contract, abi, functionName, args } as never);
    } catch (e) {
      throw new ServiceError(errorCode(e));
    }
  };
  const blocked = async (tokenId: string) =>
    (await journal()).some((e) => e.kind === 'transfer' && e.tokenId === tokenId && !final(e));
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
            if (++misses >= maxMisses) {
              await lookup(id);
              break;
            }
          }
        }
      } catch {
      } finally {
        watching.delete(id);
      }
    })();
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
        entry = { ...entry, state: receipt.status === 'success' ? 'succeeded' : 'reverted' };
        if (entry.state === 'reverted') {
          entry.reasonCode = 'Unknown';
          try {
            const tx = parseTransaction(entry.rawTx);
            await client.call({
              account: entry.wallet,
              to: config.contract,
              data: tx.data,
              value: tx.value,
              blockNumber: receipt.blockNumber,
            });
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
  async function prepare(functionName: string, args: readonly unknown[], value = 0n) {
    try {
      await client.simulateContract({
        address: config.contract,
        abi,
        functionName,
        args,
        account: signer.address,
        value,
      } as never);
      const data = encodeFunctionData({ abi, functionName, args } as never);
      const [nonce, fees, estimate, balance] = await Promise.all([
        client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        client.estimateFeesPerGas(),
        client.estimateGas({ account: signer.address, to: config.contract, data, value }),
        client.getBalance({ address: signer.address }),
      ]);
      const gas = (estimate * 120n + 99n) / 100n;
      if (balance < value + gas * fees.maxFeePerGas) throw new ServiceError('InsufficientFunds');
      return {
        chainId: config.chainId,
        to: config.contract,
        data,
        value,
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 'eip1559' as const,
      };
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError(errorCode(e));
    }
  }
  async function send(
    kind: JournalEntry['kind'],
    fn: string,
    args: readonly unknown[],
    value = 0n,
    extra: Partial<JournalEntry> = {},
    beforeSigning?: () => void,
  ): Promise<JournalEntry> {
    const work = actions.then(async () => {
      const entries = await journal();
      if (entries.some((e) => e.state === 'unknown' || e.state === 'submitting'))
        throw new ServiceError('InFlight');
      if (kind === 'transfer' && (await blocked(extra.tokenId!))) throw new ServiceError('InFlight');
      const tx = await prepare(fn, args, value);
      beforeSigning?.();
      const rawTx = await signer.signTransaction(tx);
      const hash = keccak256(rawTx);
      let entry: JournalEntry = {
        ...extra,
        id: hash,
        kind,
        state: 'submitting',
        wallet: signer.address,
        hash,
        rawTx,
        nonce: tx.nonce,
        createdAt: now(),
        valueWei: value.toString(),
      };
      await save(entry);
      try {
        await client.sendRawTransaction({ serializedTransaction: rawTx });
        entry = await save({ ...entry, state: 'pending' });
      } catch {
        entry = await save({ ...entry, state: 'unknown' });
      }
      watch(entry.id);
      return entry;
    });
    actions = work.catch(() => {});
    return work;
  }
  async function ticket(tokenId: string): Promise<Ticket> {
    const entries = await journal();
    let owner: string, checkedIn: boolean;
    try {
      [owner, checkedIn] = await Promise.all([
        read('ownerOf', [BigInt(tokenId)]),
        read('checkedIn', [BigInt(tokenId)]),
      ]);
    } catch (e) {
      // With no network the journal still knows about a transfer in flight, and the user needs that state to look it up.
      const open = entries.filter((j) => j.kind === 'transfer' && j.tokenId === tokenId && !final(j)).at(-1);
      if ((e as ServiceError).code !== 'Network' || !open) throw e;
      return {
        tokenId,
        owner: signer.address,
        checkedIn: false,
        status: open.state === 'unknown' ? 'unresolved' : 'transferring',
        tx: open,
      };
    }
    const related: JournalEntry[] = [];
    for (const e of entries) {
      if (e.tokenId === tokenId) {
        related.push(e);
        continue;
      }
      if (e.kind !== 'buy' || e.state !== 'succeeded') continue;
      let ids = mintedTokens.get(e.hash);
      if (!ids) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: e.hash });
          ids = [];
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== config.contract.toLowerCase()) continue;
            try {
              const event = decodeEventLog({
                abi,
                eventName: 'Transfer',
                data: log.data,
                topics: log.topics,
              });
              if (event.args.from === zeroAddress) ids.push(event.args.tokenId.toString());
            } catch {}
          }
          mintedTokens.set(e.hash, ids);
        } catch (err) {
          // The chain no longer knows this tx (for example a reset dev chain), which is not a network failure.
          if ((err as { name?: string }).name === 'TransactionReceiptNotFoundError') continue;
          throw new ServiceError('Network');
        }
      }
      if (ids.includes(tokenId)) related.push(e);
    }
    const tx = related.at(-1);
    const transfer = entries.filter((e) => e.kind === 'transfer' && e.tokenId === tokenId).at(-1);
    let status: Ticket['status'] =
      checkedIn && owner.toLowerCase() === signer.address.toLowerCase() ? 'used' : 'available';
    if (transfer && !final(transfer)) status = transfer.state === 'unknown' ? 'unresolved' : 'transferring';
    else if (transfer?.state === 'succeeded' && owner.toLowerCase() !== signer.address.toLowerCase())
      status = 'transferred';
    return { tokenId, owner: owner as Ticket['owner'], checkedIn, status, tx };
  }
  async function sale() {
    const [price, max, total] = await Promise.all([read('price'), read('maxSupply'), read('totalMinted')]);
    return {
      priceWei: price.toString(),
      maxSupply: max.toString(),
      totalMinted: total.toString(),
      remaining: (max - total).toString(),
      saleOpen: price > 0n,
      soldOut: total >= max,
    };
  }
  function recipient(to: string) {
    if (!isAddress(to) || to.toLowerCase() === zeroAddress) throw new ServiceError('InvalidRecipient');
  }
  async function buyArgs(quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ServiceError('WrongPayment');
    const price = await read('price');
    return price * BigInt(quantity);
  }
  const service: TicketService = {
    getSale: sale,
    isScanner: (address) => read('isScanner', [address]),
    getBalanceWei: async (address) => {
      try {
        return (await client.getBalance({ address })).toString();
      } catch {
        throw new ServiceError('Network');
      }
    },
    estimateBuyFeeWei: async (q) => {
      const tx = await prepare('buy', [BigInt(q)], await buyArgs(q));
      return (tx.gas * tx.maxFeePerGas).toString();
    },
    estimateTransferFeeWei: async (id, to) => {
      recipient(to);
      if (await blocked(id)) throw new ServiceError('InFlight');
      const tx = await prepare('transferFrom', [signer.address, to, BigInt(id)]);
      return (tx.gas * tx.maxFeePerGas).toString();
    },
    buy: async (q) => send('buy', 'buy', [BigInt(q)], await buyArgs(q), { quantity: q.toString() }),
    transfer: async (id, to) => {
      recipient(to);
      return send('transfer', 'transferFrom', [signer.address, to, BigInt(id)], 0n, { tokenId: id, to });
    },
    getTicket: ticket,
    listTickets: async () => {
      const total = BigInt((await sale()).totalMinted);
      const entries = await journal();
      const sent = new Set(entries.filter((e) => e.kind === 'transfer').map((e) => e.tokenId));
      const result: Ticket[] = [];
      for (let id = 0n; id < total; id++) {
        const t = await ticket(id.toString());
        if (t.owner.toLowerCase() === signer.address.toLowerCase() || sent.has(t.tokenId)) result.push(t);
      }
      return result;
    },
    createQr: async (tokenId) => {
      if (await blocked(tokenId)) throw new ServiceError('InFlight');
      const t = await ticket(tokenId);
      if (t.owner.toLowerCase() !== signer.address.toLowerCase()) throw new ServiceError('OwnerChanged');
      if (t.checkedIn) throw new ServiceError('TicketUsed');
      const deadline = (BigInt(Math.floor(now() / 1000)) + 180n).toString();
      const signature = await signer.signCheckIn({
        chainId: config.chainId,
        contract: config.contract,
        tokenId,
        deadline,
      });
      const payload: QrPayload = {
        v: 1,
        chainId: config.chainId,
        contract: config.contract,
        holder: signer.address,
        tokenId,
        deadline,
        signature,
      };
      return { payload, encoded: encodeQr(payload) };
    },
    preflight: async (raw) => {
      const payload = decodeQr(raw);
      if (!payload) return { kind: 'invalid-qr' };
      const reject = (code: ErrorCode) => ({ kind: 'rejected' as const, code, payload });
      if ((await journal()).some((e) => e.kind === 'checkIn' && e.tokenId === payload.tokenId && !final(e)))
        return reject('InFlight');
      if (
        payload.chainId !== config.chainId ||
        payload.contract.toLowerCase() !== config.contract.toLowerCase()
      )
        return reject('WrongNetwork');
      const remaining = BigInt(payload.deadline) - BigInt(Math.floor(now() / 1000));
      if (remaining < 0n) return reject('SignatureExpired');
      if (remaining < 15n) return { kind: 'expiring', payload, secondsLeft: Number(remaining) };
      try {
        await client.simulateContract({
          address: config.contract,
          abi,
          functionName: 'checkIn',
          args: [BigInt(payload.tokenId), BigInt(payload.deadline), payload.signature],
          account: signer.address,
        });
        return {
          kind: 'ok',
          payload,
          secondsLeft: Number(
            remaining > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : remaining,
          ),
        };
      } catch (e) {
        const code = errorCode(e);
        if (code === 'Network') throw new ServiceError('Network');
        if (code === 'InvalidSignature') {
          const owner = await read('ownerOf', [BigInt(payload.tokenId)]);
          if (owner.toLowerCase() !== payload.holder.toLowerCase())
            return { ...reject('OwnerChanged'), owner };
        }
        return reject(code);
      }
    },
    checkIn: async (raw) => {
      const verdict = await service.preflight(raw);
      if (verdict.kind !== 'ok') return verdict;
      const p = verdict.payload;
      // Preflight and prepare both wait on the network, so the 15 second rule is checked again before signing.
      const secondsLeft = () => Number(BigInt(p.deadline) - BigInt(Math.floor(now() / 1000)));
      const TOO_LATE = new ServiceError('SignatureExpired');
      try {
        return await send(
          'checkIn',
          'checkIn',
          [BigInt(p.tokenId), BigInt(p.deadline), p.signature],
          0n,
          { tokenId: p.tokenId },
          () => {
            if (secondsLeft() < 15) throw TOO_LATE;
          },
        );
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
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}
