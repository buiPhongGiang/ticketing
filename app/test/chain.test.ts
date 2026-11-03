import { beforeAll, afterAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTicketService, createLocalSigner, memoryStore } from '../src/lib';
const artifact = JSON.parse(
  readFileSync(new URL('../../out/EventTicket.sol/EventTicket.json', import.meta.url), 'utf8'),
);
const chain = defineChain({
  id: 31337,
  name: 'test',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8599'] } },
});
const keys = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`);
const accounts = keys.map((key) => privateKeyToAccount(key));
const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) });
const wallet = createWalletClient({ chain, transport: http(), account: accounts[0] });
let proc: ChildProcess;
const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
const delay = () => new Promise((r) => setTimeout(r, 100));
beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', '8599', '--silent']);
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await delay();
    }
  }
  for (const a of accounts) await rpc('anvil_setBalance', [a.address, '0x3635c9adc5dea00000']);
});
afterAll(() => {
  proc?.kill();
});
async function setup(supply = 10n) {
  await rpc('evm_setAutomine', [true]);
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: ['Show', 'SHOW', supply, 1000n, accounts[0].address],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const contract = receipt.contractAddress!;
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: contract,
      abi: artifact.abi,
      functionName: 'setScanner',
      args: [accounts[2].address, true],
    }),
  });
  const store = memoryStore();
  let clock = Date.now();
  const make = (i: number, s = store) =>
    createTicketService({
      config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8599', contract, nativeSymbol: 'ETH' },
      signer: createLocalSigner(keys[i]),
      store: s,
      now: () => clock,
    });
  return {
    a: make(0),
    b: make(1),
    scanner: make(2),
    make,
    store,
    contract,
    setClock: (n: number) => (clock = n),
  };
}
async function final(s: ReturnType<typeof createTicketService>, id: string) {
  for (let i = 0; i < 100; i++) {
    const e = await s.lookup(id);
    if (['succeeded', 'reverted'].includes(e.state)) return e;
    await delay();
  }
  throw Error('timeout');
}
test('domain, old owner, expiry, scanner and duplicate entry', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy(1)).id);
  const qr = await x.a.createQr('0');
  expect((await x.scanner.preflight(qr.encoded)).kind).toBe('ok');
  expect(await x.a.preflight(qr.encoded)).toMatchObject({ kind: 'rejected', code: 'NotScanner' });
  x.setClock(Number(qr.payload.deadline) * 1000 - 14000);
  expect((await x.scanner.preflight(qr.encoded)).kind).toBe('expiring');
  x.setClock(Number(qr.payload.deadline) * 1000 + 1000);
  expect(await x.scanner.preflight(qr.encoded)).toMatchObject({ code: 'SignatureExpired' });
  x.setClock(Date.now());
  await final(x.a, (await x.a.transfer('0', accounts[1].address)).id);
  expect(await x.scanner.preflight(qr.encoded)).toMatchObject({
    code: 'OwnerChanged',
    owner: accounts[1].address,
  });
  const next = await x.b.createQr('0');
  const entry = await x.scanner.checkIn(next.encoded);
  expect('id' in entry).toBe(true);
  await final(
    x.scanner,
    (
      entry as {
        id: string;
      }
    ).id,
  );
  expect(await x.scanner.checkIn(next.encoded)).toMatchObject({ code: 'AlreadyCheckedIn' });
});
test('pending transfer blocks QR; restart resumes same hash; forgotten raw tx rebroadcast', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy(1)).id);
  await rpc('evm_setAutomine', [false]);
  const tx = await x.a.transfer('0', accounts[1].address);
  await expect(x.a.createQr('0')).rejects.toBeDefined();
  await rpc('anvil_dropTransaction', [tx.hash]);
  const resumed = await x.make(0).resume();
  expect(resumed[0].hash).toBe(tx.hash);
  expect(resumed[0].rawTx).toBe(tx.rawTx);
  expect(await client.getTransaction({ hash: tx.hash })).toBeDefined();
  await rpc('evm_mine');
  expect((await final(x.a, tx.id)).state).toBe('succeeded');
});
test('competing last ticket receipt zero is reverted SoldOut', async () => {
  const x = await setup(1n);
  await rpc('evm_setAutomine', [false]);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const racers = [0, 1].map((i) => {
    const signer = createLocalSigner(keys[i]);
    return createTicketService({
      config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8599', contract: x.contract, nativeSymbol: 'ETH' },
      store: memoryStore(),
      signer: {
        ...signer,
        signTransaction: async (tx) => {
          if (++arrivals === 2) release();
          await barrier;
          return signer.signTransaction(tx);
        },
      },
    });
  });
  const [a, b] = await Promise.all(racers.map((s) => s.buy(1)));
  await rpc('evm_mine');
  const results = await Promise.all([final(racers[0], a.id), final(racers[1], b.id)]);
  expect(results.map((r) => r.state).sort()).toEqual(['reverted', 'succeeded']);
  expect(results.find((r) => r.state === 'reverted')?.reasonCode).toBe('SoldOut');
});
test('dead RPC lookup returns unknown without throwing', async () => {
  const x = await setup();
  await rpc('evm_setAutomine', [false]);
  const tx = await x.a.buy(1);
  const dead = createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8598', contract: x.contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[0]),
    store: x.store,
  });
  expect((await dead.lookup(tx.id)).state).toBe('unknown');
  await rpc('evm_setAutomine', [true]);
});
test('watcher notifies final receipt; validation rejects before signing', async () => {
  const x = await setup(1n);
  const changes: string[] = [];
  const unsub = x.a.subscribe((e) => changes.push(e.state));
  const entry = await x.a.buy(1);
  for (let i = 0; i < 100 && !changes.includes('succeeded'); i++) await delay();
  expect(changes).toContain('submitting');
  expect(changes).toContain('pending');
  expect(changes).toContain('succeeded');
  unsub();
  expect((await x.a.journal())[0].hash).toBe(entry.hash);
  await expect(x.a.buy(1)).rejects.toMatchObject({ code: 'SoldOut' });
  await expect(x.a.transfer('0', '0x0000000000000000000000000000000000000000')).rejects.toMatchObject({
    code: 'InvalidRecipient',
  });
  expect(await x.scanner.preflight('{}')).toEqual({ kind: 'invalid-qr' });
  const qr = await x.a.createQr('0');
  expect(await x.scanner.preflight(JSON.stringify({ ...qr.payload, chainId: 1 }))).toMatchObject({
    code: 'WrongNetwork',
  });
  expect((await x.a.listTickets())[0].status).toBe('available');
  expect((await x.a.getTicket('0')).tx?.hash).toBe(entry.hash);
});

test('an unresolved transaction blocks new signing, so the same nonce is never reused', async () => {
  const { a, store, contract } = await setup();
  await rpc('evm_setAutomine', [false]);
  const entry = await a.buy(1);
  const dead = createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:1', contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[0]),
    store,
  });
  expect((await dead.lookup(entry.id)).state).toBe('unknown');
  await expect(a.buy(1)).rejects.toMatchObject({ code: 'InFlight' });
  await rpc('evm_setAutomine', [true]);
});

test('a transaction whose nonce was used by another tx ends as failed instead of unknown forever', async () => {
  const { a, contract } = await setup();
  await rpc('evm_setAutomine', [false]);
  const entry = await a.buy(1);
  await rpc('anvil_dropTransaction', [entry.hash]);
  const other = await wallet.sendTransaction({ to: accounts[1].address, value: 1n, nonce: entry.nonce });
  await rpc('evm_mine');
  await client.waitForTransactionReceipt({ hash: other });
  const settled = await a.lookup(entry.id);
  expect(settled.state).toBe('reverted');
  expect(settled.reasonCode).toBe('Unknown');
  expect(contract).toBeTruthy();
  await rpc('evm_setAutomine', [true]);
});

test('scanning again while a check-in is pending sends nothing', async () => {
  const { a, scanner } = await setup();
  await a.buy(1);
  await delay();
  const qr = await a.createQr('0');
  await rpc('evm_setAutomine', [false]);
  const first = await scanner.checkIn(qr.encoded);
  expect('hash' in first).toBe(true);
  await expect(scanner.preflight(qr.encoded)).resolves.toMatchObject({ kind: 'rejected', code: 'InFlight' });
  await expect(scanner.checkIn(qr.encoded)).resolves.toMatchObject({ kind: 'rejected', code: 'InFlight' });
  const pool = (await rpc('txpool_content')) as { pending: Record<string, Record<string, unknown>> };
  const count = Object.values(pool.pending).reduce((n, byNonce) => n + Object.keys(byNonce).length, 0);
  expect(count).toBe(1);
  await rpc('evm_setAutomine', [true]);
});

test('transferring a ticket this wallet no longer holds explains that the owner changed', async () => {
  const { a, b, make } = await setup();
  await a.buy(1);
  await delay();
  const sent = await a.transfer('0', accounts[1].address);
  await client.waitForTransactionReceipt({ hash: sent.hash });
  await a.lookup(sent.id);
  await expect(a.transfer('0', accounts[2].address)).rejects.toMatchObject({ code: 'OwnerChanged' });
  expect(b && make).toBeTruthy();
});

test('an unresolved transfer is still readable with no network, from the journal', async () => {
  const { a, store, contract } = await setup();
  await a.buy(1);
  await delay();
  await rpc('evm_setAutomine', [false]);
  const sent = await a.transfer('0', accounts[1].address);
  const dead = createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:1', contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[0]),
    store,
  });
  await dead.lookup(sent.id);
  await expect(dead.getTicket('0')).resolves.toMatchObject({
    tokenId: '0',
    status: 'unresolved',
    tx: { id: sent.id },
  });
  await expect(dead.getTicket('5')).rejects.toMatchObject({ code: 'Network' });
  await rpc('evm_setAutomine', [true]);
});

test('a QR that drops under 15 seconds while preparing the check-in is not signed or sent', async () => {
  const { a, contract, store } = await setup();
  await a.buy(1);
  await delay();
  const base = Date.now();
  const qr = await createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8599', contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[0]),
    store,
    now: () => base,
  }).createQr('0');
  // The first clock read passes the check at preflight; later reads are after a slow network.
  let reads = 0;
  const scanner = createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8599', contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[2]),
    store: memoryStore(),
    now: () => base + (reads++ === 0 ? 0 : 170_000),
  });
  await expect(scanner.checkIn(qr.encoded)).resolves.toMatchObject({ kind: 'expiring' });
  await expect(scanner.journal()).resolves.toHaveLength(0);
});

test('a journal entry the chain no longer knows does not break the ticket list', async () => {
  const { a, store, contract } = await setup();
  await a.buy(1);
  await delay();
  const key = `ticket-journal:31337:${contract.toLowerCase()}:${accounts[0].address.toLowerCase()}`;
  const entries = JSON.parse((await store.getItem(key))!);
  entries[0].hash = `0x${'ab'.repeat(32)}`;
  entries[0].state = 'succeeded';
  await store.setItem(key, JSON.stringify(entries));
  const fresh = createTicketService({
    config: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8599', contract, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[0]),
    store,
  });
  await expect(fresh.listTickets()).resolves.toMatchObject([{ tokenId: '0', status: 'available' }]);
});
test('a QR with numbers too big for uint256 is an unreadable code, not a network failure', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy(1)).id);
  const { payload } = await x.a.createQr('0');
  const tooBig = (2n ** 256n).toString();
  for (const change of [{ tokenId: tooBig }, { deadline: tooBig }]) {
    expect(await x.scanner.preflight(JSON.stringify({ ...payload, ...change }))).toEqual({ kind: 'invalid-qr' });
  }
});
