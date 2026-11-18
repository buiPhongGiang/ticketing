import { beforeAll, afterAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTicketService, createLocalSigner, memoryStore, type TicketService } from '../src/lib';

const art = (name: string) => JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
const [USDC, VAULT, BOX] = ['MockUSDC', 'FloatVault', 'TicketBox'].map(art);
const RPC = 'http://127.0.0.1:8599';
const chain = defineChain({ id: 31337, name: 'test', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// 0 organizer, 1 guest A, 2 guest B, 3 gate
const keys = [1, 2, 3, 4].map((n) => `0x${n.toString(16).padStart(64, '0')}` as Hex);
const accounts = keys.map((key) => privateKeyToAccount(key));
const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) });
const walletOf = (i: number) => createWalletClient({ chain, transport: http(), account: accounts[i] });
let proc: ChildProcess;
const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
const delay = (ms = 100) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', '8599', '--silent']);
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); break; } catch { await delay(); }
  }
  for (const a of accounts) await rpc('anvil_setBalance', [a.address, '0x3635c9adc5dea00000']);
});
afterAll(() => { proc?.kill(); });

async function deploy(artifact: any, args: unknown[]) {
  const hash = await walletOf(0).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function write(i: number, address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  const hash = await walletOf(i).writeContract({ address, abi, functionName, args } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
}

/** Fresh contracts, one event (GA 1 USDC, VIP 3 USDC), gate wallet granted, guests hold faucet USDC but no allowance. */
async function setup(gaSupply = 10) {
  await rpc('evm_setAutomine', [true]);
  const usdc = await deploy(USDC, []);
  const vault = await deploy(VAULT, [usdc]);
  const box = await deploy(BOX, [usdc, vault]);
  await write(0, vault, VAULT.abi, 'setBox', [box]);
  await write(0, usdc, USDC.abi, 'setMinter', [vault]);
  const now = Number((await client.getBlock()).timestamp);
  await write(0, box, BOX.abi, 'createEvent', ['Show', 'Hall', BigInt(now + 86400), BigInt(now + 90000), 0, ['GA', 'VIP'], [1_000_000n, 3_000_000n], [gaSupply, 5]]);
  await write(0, box, BOX.abi, 'setScanner', [0n, accounts[3].address, true]);
  for (const i of [1, 2]) await write(i, usdc, USDC.abi, 'faucet');
  const store = memoryStore();
  let clock = Date.now();
  const config = { chainId: 31337, rpcUrl: RPC, contract: box, usdc, nativeSymbol: 'ETH' };
  const make = (i: number, s = store, rpcUrl = RPC) => createTicketService({ config: { ...config, rpcUrl }, signer: createLocalSigner(keys[i]), store: s, now: () => clock });
  const usdcOf = async (i: number) => (await client.readContract({ address: usdc, abi: USDC.abi, functionName: 'balanceOf', args: [accounts[i].address] })) as bigint;
  return { a: make(1), b: make(2), gate: make(3), make, store, box, usdc, vault, usdcOf, setClock: (n: number) => (clock = n) };
}
async function final(s: TicketService, id: string) {
  for (let i = 0; i < 100; i++) {
    const e = await s.lookup(id);
    if (['succeeded', 'reverted'].includes(e.state)) return e;
    await delay();
  }
  throw Error('timeout');
}

test('buy without an approval goes through one permit transaction; money lands in the vault', async () => {
  const x = await setup();
  const before = await x.usdcOf(1);
  const e = await final(x.a, (await x.a.buy('0', 1, 2)).id);
  expect(e.state).toBe('succeeded');
  expect(e.amount).toBe('6000000');
  expect(BigInt(e.feeWei!)).toBeGreaterThan(0n);
  expect(await x.usdcOf(1)).toBe(before - 6_000_000n);
  const ev = await x.a.getEvent('0');
  expect(ev.principal).toBe('6000000');
  expect(ev.tiers[1].sold).toBe(2);
  const mine = await x.a.listTickets();
  expect(mine.map((t) => [t.tokenId, t.tierName, t.status])).toEqual([['1', 'VIP', 'available'], ['0', 'VIP', 'available']]);
});

test('resale: listing above the cap is refused before signing; buyer pays the seller; old QR fails, new QR enters once', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const oldQr = await x.a.createQr('0');
  await expect(x.a.list('0', '1100001')).rejects.toMatchObject({ code: 'AboveCap' });
  await final(x.a, (await x.a.list('0', '1100000')).id);
  expect((await x.a.getTicket('0')).status).toBe('listed');
  const listings = await x.b.getListings('0');
  expect(listings.map((l) => [l.tokenId, l.listPrice])).toEqual([['0', '1100000']]);

  const sellerBefore = await x.usdcOf(1);
  const e = await final(x.b, (await x.b.buyListing('0', '1100000')).id);
  expect(e.state).toBe('succeeded');
  expect(await x.usdcOf(1)).toBe(sellerBefore + 1_100_000n);
  expect((await x.b.getTicket('0')).owner).toBe(accounts[2].address);
  expect((await x.a.listTickets()).find((t) => t.tokenId === '0')?.status).toBe('sold');

  expect(await x.gate.preflight(oldQr.encoded)).toMatchObject({ kind: 'rejected', code: 'OwnerChanged', owner: accounts[2].address });
  const qr = await x.b.createQr('0');
  const ok = await x.gate.preflight(qr.encoded);
  expect(ok).toMatchObject({ kind: 'ok', ticket: { tokenId: '0', tierName: 'GA' } });
  const entry = await x.gate.checkIn(qr.encoded);
  expect('id' in entry).toBe(true);
  await final(x.gate, (entry as { id: string }).id);
  expect(await x.gate.checkIn(qr.encoded)).toMatchObject({ code: 'AlreadyCheckedIn' });
  expect((await x.b.getTicket('0')).status).toBe('used');
});

test('a price change while buying a listing is caught', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  await final(x.a, (await x.a.list('0', '1000000')).id);
  await final(x.a, (await x.a.list('0', '1100000')).id);
  await expect(x.b.buyListing('0', '1000000')).rejects.toMatchObject({ code: 'PriceChanged' });
  await expect(x.a.buyListing('0', '1100000')).rejects.toMatchObject({ code: 'OwnListing' });
});

test('cancel: the ticket shows as refundable and the refund returns face value', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  await write(0, x.box, BOX.abi, 'cancelEvent', [0n]);
  const t = await x.a.getTicket('0');
  expect(t.status).toBe('refundable');
  expect((await x.a.getEvents())[0].status).toBe('cancelled');
  const before = await x.usdcOf(1);
  const e = await final(x.a, (await x.a.claimRefund('0')).id);
  expect(e.amount).toBe('1000000');
  expect(await x.usdcOf(1)).toBe(before + 1_000_000n);
  expect(await x.a.listTickets()).toEqual([]);
  await expect(x.a.createQr('0')).rejects.toBeDefined();
});

test('faucet, then cooldown is reported by name', async () => {
  const x = await setup();
  await expect(x.a.faucet()).rejects.toMatchObject({ code: 'FaucetCooldown' });
  const fresh = x.make(0, memoryStore());
  const e = await final(fresh, (await fresh.faucet()).id);
  expect(e.state).toBe('succeeded');
  expect((await fresh.getBalances(accounts[0].address)).usdc).toBe('1000000000');
});

test('competing buys for the last ticket: one succeeds, the other is reverted SoldOut', async () => {
  const x = await setup(1);
  await rpc('evm_setAutomine', [false]);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const racers = [1, 2].map((i) => {
    const signer = createLocalSigner(keys[i]);
    return createTicketService({
      config: { chainId: 31337, rpcUrl: RPC, contract: x.box, usdc: x.usdc, nativeSymbol: 'ETH' },
      store: memoryStore(),
      signer: { ...signer, signTransaction: async (tx) => { if (++arrivals === 2) release(); await barrier; return signer.signTransaction(tx); } },
    });
  });
  const [a, b] = await Promise.all(racers.map((s) => s.buy('0', 0, 1)));
  await rpc('evm_mine');
  const results = await Promise.all([final(racers[0], a.id), final(racers[1], b.id)]);
  expect(results.map((r) => r.state).sort()).toEqual(['reverted', 'succeeded']);
  expect(results.find((r) => r.state === 'reverted')?.reasonCode).toBe('SoldOut');
  await rpc('evm_setAutomine', [true]);
});

test('pending action blocks QR; restart resumes the same hash; a forgotten raw tx is rebroadcast', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  await rpc('evm_setAutomine', [false]);
  const tx = await x.a.list('0', '1000000');
  await expect(x.a.createQr('0')).rejects.toMatchObject({ code: 'InFlight' });
  expect((await x.a.getTicket('0')).status).toBe('pending');
  await rpc('anvil_dropTransaction', [tx.hash]);
  const resumed = await x.make(1).resume();
  expect(resumed[0].hash).toBe(tx.hash);
  expect(await client.getTransaction({ hash: tx.hash })).toBeDefined();
  await rpc('evm_mine');
  expect((await final(x.a, tx.id)).state).toBe('succeeded');
  await rpc('evm_setAutomine', [true]);
});

test('an unresolved transaction blocks new signing, so the same nonce is never reused', async () => {
  const x = await setup();
  await rpc('evm_setAutomine', [false]);
  const entry = await x.a.buy('0', 0, 1);
  const dead = x.make(1, x.store, 'http://127.0.0.1:1');
  expect((await dead.lookup(entry.id)).state).toBe('unknown');
  await expect(x.a.buy('0', 0, 1)).rejects.toMatchObject({ code: 'InFlight' });
  await rpc('evm_setAutomine', [true]);
});

test('scanning again while a check-in is pending sends nothing', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const qr = await x.a.createQr('0');
  await rpc('evm_setAutomine', [false]);
  const first = await x.gate.checkIn(qr.encoded);
  expect('hash' in first).toBe(true);
  await expect(x.gate.checkIn(qr.encoded)).resolves.toMatchObject({ kind: 'rejected', code: 'InFlight' });
  const pool = (await rpc('txpool_content')) as { pending: Record<string, Record<string, unknown>> };
  expect(Object.values(pool.pending).reduce((n, byNonce) => n + Object.keys(byNonce).length, 0)).toBe(1);
  await rpc('evm_setAutomine', [true]);
});

test('QR rules: expiry window, wrong network, non-scanner, oversized numbers', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const qr = await x.a.createQr('0');
  expect(await x.a.preflight(qr.encoded)).toMatchObject({ kind: 'rejected', code: 'NotScanner' });
  expect(await x.gate.preflight('{}')).toEqual({ kind: 'invalid-qr' });
  expect(await x.gate.preflight(JSON.stringify({ ...qr.payload, chainId: 1 }))).toMatchObject({ code: 'WrongNetwork' });
  const tooBig = (2n ** 256n).toString();
  expect(await x.gate.preflight(JSON.stringify({ ...qr.payload, tokenId: tooBig }))).toEqual({ kind: 'invalid-qr' });
  x.setClock(Number(qr.payload.deadline) * 1000 - 14000);
  expect((await x.gate.preflight(qr.encoded)).kind).toBe('expiring');
  x.setClock(Number(qr.payload.deadline) * 1000 + 1000);
  expect(await x.gate.preflight(qr.encoded)).toMatchObject({ code: 'SignatureExpired' });
});

test('a QR that drops under 15 seconds while preparing the check-in is not signed or sent', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const base = Date.now();
  x.setClock(base);
  const qr = await x.a.createQr('0');
  let reads = 0;
  const gate = createTicketService({
    config: { chainId: 31337, rpcUrl: RPC, contract: x.box, usdc: x.usdc, nativeSymbol: 'ETH' },
    signer: createLocalSigner(keys[3]),
    store: memoryStore(),
    now: () => base + (reads++ === 0 ? 0 : 170_000),
  });
  await expect(gate.checkIn(qr.encoded)).resolves.toMatchObject({ kind: 'expiring' });
  await expect(gate.journal()).resolves.toHaveLength(0);
});
