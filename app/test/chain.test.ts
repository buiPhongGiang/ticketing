import { beforeAll, afterAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, http, defineChain, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTicketService, createLocalSigner, createPrivateKey, errorCode, memoryStore, type TicketService } from '../src/lib';
import { createOfflineGate } from '../src/lib/offline';
import { createRelayer } from '../src/lib/relayer';

const art = (name: string) => JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
const [USDC, VAULT, BOX, USDC_V2] = ['MockUSDC', 'FloatVault', 'VeGoc', 'UsdcV2Mock'].map(art);
// A port the system hands out, so a second test run (or anything else on a fixed port) cannot collide.
const PORT = await new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const RPC = `http://127.0.0.1:${PORT}`;
const FEE_BPS = 300n;
const TREASURY = '0x00000000000000000000000000000000000000fe' as Address;
const chain = defineChain({ id: 31337, name: 'test', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// 0 organizer, 1 guest A, 2 guest B, 3 gate
const keys = [1, 2, 3, 4].map((n) => `0x${n.toString(16).padStart(64, '0')}` as Hex);
const accounts = keys.map((key) => privateKeyToAccount(key));
// viem polls for receipts every 4 s by default; on a local chain that only makes the suite slow.
const client = createPublicClient({ chain, transport: http(RPC, { retryCount: 0 }), pollingInterval: 50 });
const walletOf = (i: number) => createWalletClient({ chain, transport: http(RPC), account: accounts[i] });
let proc: ChildProcess;
const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
const delay = (ms = 100) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', String(PORT), '--silent']);
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
async function setup(gaSupply = 10, token: 'mock' | 'circle-like' = 'mock') {
  await rpc('evm_setAutomine', [true]);
  const usdc = await deploy(token === 'mock' ? USDC : USDC_V2, []);
  const vault = await deploy(VAULT, [usdc]);
  const box = await deploy(BOX, [usdc, vault, TREASURY, FEE_BPS]);
  await write(0, vault, VAULT.abi, 'setBox', [box]);
  const now = Number((await client.getBlock()).timestamp);
  await write(0, box, BOX.abi, 'createEvent', ['Show', 'Hall', BigInt(now + 86400), BigInt(now + 90000), 0, ['GA', 'VIP'], [1_000_000n, 3_000_000n], [gaSupply, 5]]);
  await write(0, box, BOX.abi, 'setScanner', [0n, accounts[3].address, true]);
  for (const i of [1, 2]) {
    if (token === 'mock') await write(i, usdc, USDC.abi, 'faucet');
    else await write(0, usdc, USDC_V2.abi, 'mint', [accounts[i].address, 1_000_000_000n]);
  }
  const store = memoryStore();
  let clock = Date.now();
  const config = { chainId: 31337, rpcUrl: RPC, contract: box, usdc, nativeSymbol: 'ETH' };
  const make = (i: number, s = store, rpcUrl = RPC) => createTicketService({ config: { ...config, rpcUrl }, signer: createLocalSigner(keys[i]), store: s, now: () => clock });
  const usdcOf = async (i: number) => (await client.readContract({ address: usdc, abi: USDC.abi, functionName: 'balanceOf', args: [accounts[i].address] })) as bigint;
  return { a: make(1), b: make(2), gate: make(3), make, store, box, usdc, vault, usdcOf, config, now, setClock: (n: number) => (clock = n) };
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
  expect(e.confirmedMs).toBeGreaterThanOrEqual(0);
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

test('a token with EIP-712 version "2" (as Circle USDC has): the permit is signed with the version the token reports', async () => {
  const x = await setup(10, 'circle-like');
  const e = await final(x.a, (await x.a.buy('0', 0, 2)).id);
  expect(e.state).toBe('succeeded');
  expect(await x.usdcOf(1)).toBe(1_000_000_000n - 2_000_000n);
  expect((await x.a.getEvent('0')).principal).toBe('2000000');
  await final(x.a, (await x.a.list('0', '1100000')).id);
  expect((await final(x.b, (await x.b.buyListing('0', '1100000')).id)).state).toBe('succeeded');
  expect((await x.b.getTicket('0')).owner).toBe(accounts[2].address);
});

test('a free ticket cannot be listed; the app says so before signing', async () => {
  const x = await setup();
  await write(0, x.box, BOX.abi, 'issue', [0n, 0n, accounts[1].address, 1n]);
  const t = await x.a.getTicket('0');
  expect(t.paid).toBe('0');
  await expect(x.a.list('0', '1000000')).rejects.toMatchObject({ code: 'CompNotResellable' });
  expect(await x.a.journal()).toHaveLength(0);
});

test('only events of the configured organizers are listed', async () => {
  const x = await setup();
  await write(2, x.box, BOX.abi, 'createEvent', ['Troll event', 'Nowhere', BigInt(x.now + 60), BigInt(x.now + 3600), 0, ['GA'], [1n], [1]]);
  expect((await x.a.getEvents()).map((e) => e.name)).toEqual(['Show', 'Troll event']);
  const filtered = createTicketService({ config: { ...x.config, organizers: [accounts[0].address] }, signer: createLocalSigner(keys[1]), store: memoryStore() });
  expect((await filtered.getEvents()).map((e) => e.name)).toEqual(['Show']);
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

test('a QR signed for longer than five minutes is refused, by the app and by the contract', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const signer = createLocalSigner(keys[1]);
  const deadline = String(x.now + 3600); // a holder who signs an hour ahead to hand the QR to someone else
  const signature = await signer.signCheckIn({ chainId: 31337, contract: x.box, tokenId: '0', deadline });
  const raw = JSON.stringify({ v: 1, chainId: 31337, contract: x.box, holder: signer.address, tokenId: '0', deadline, signature });
  expect(await x.gate.preflight(raw)).toMatchObject({ kind: 'rejected', code: 'DeadlineTooFar' });
  await expect(client.simulateContract({ address: x.box, abi: BOX.abi, functionName: 'checkIn', args: [0n, BigInt(deadline), signature], account: accounts[3].address }))
    .rejects.toThrow(/DeadlineTooFar/);
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

test('waitlist: B pays in the cap with a permit and is first in line; A\'s listing goes to B in the same transaction', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  const bBefore = await x.usdcOf(2);
  const joined = await final(x.b, (await x.b.joinWaitlist('0', 0)).id);
  expect(joined.state).toBe('succeeded');
  expect(joined.amount).toBe('1100000');
  expect(await x.usdcOf(2)).toBe(bBefore - 1_100_000n);
  expect((await x.b.getWaitlist('0'))[0]).toMatchObject({ tier: 0, waiting: 1, position: 1, deposit: '1100000', cap: '1100000' });
  expect((await x.a.getWaitlist('0'))[0]).toMatchObject({ waiting: 1, position: 0, deposit: '0' });
  expect((await x.b.getEvent('0')).waiting).toEqual([1, 0]);
  await expect(x.b.joinWaitlist('0', 0)).rejects.toMatchObject({ code: 'AlreadyWaiting' });

  const aBefore = await x.usdcOf(1);
  const listed = await final(x.a, (await x.a.list('0', '1050000')).id); // below the cap
  expect(listed.state).toBe('succeeded');
  expect(listed.soldTo).toBe(accounts[2].address);
  expect((await x.b.getTicket('0')).owner).toBe(accounts[2].address);
  expect(await x.usdcOf(1)).toBe(aBefore + 1_050_000n);
  expect((await x.a.listTickets()).find((t) => t.tokenId === '0')?.status).toBe('sold');
  expect((await x.b.getWaitlist('0'))[0]).toMatchObject({ waiting: 0, position: 0 });
  // B paid in 1.10 and the ticket cost 1.05: the rest is credit to withdraw
  expect(await x.b.getCredit()).toBe('50000');
  await final(x.b, (await x.b.withdrawCredit()).id);
  expect(await x.b.getCredit()).toBe('0');
  expect(await x.usdcOf(2)).toBe(bBefore - 1_050_000n);
});

test('waitlist rules: nothing to wait for while a listing is open; leaving returns the deposit', async () => {
  const x = await setup();
  await final(x.a, (await x.a.buy('0', 0, 1)).id);
  await final(x.a, (await x.a.list('0', '1100000')).id); // nobody waits: the listing stays open
  expect((await x.a.getTicket('0')).status).toBe('listed');
  await expect(x.b.joinWaitlist('0', 0)).rejects.toMatchObject({ code: 'ListingsOpen' });
  const before = await x.usdcOf(2);
  await final(x.b, (await x.b.joinWaitlist('0', 1)).id); // the VIP tier has its own line
  expect(await x.usdcOf(2)).toBe(before - 3_300_000n);
  await expect(x.a.leaveWaitlist('0', 1)).rejects.toMatchObject({ code: 'NotWaiting' });
  await final(x.b, (await x.b.leaveWaitlist('0', 1)).id);
  expect(await x.usdcOf(2)).toBe(before);
  expect((await x.b.getWaitlist('0'))[1]).toMatchObject({ waiting: 0, position: 0 });
});

// Keep this test last: it moves the chain clock a day ahead, and anvil's clock only goes forward.
test('no-show: an event that ends with nobody scanned turns tickets refundable; a scanned event does not', async () => {
  const x = await setup();
  const start = x.now;
  await write(0, x.box, BOX.abi, 'createEvent', ['Second', 'Hall', BigInt(start + 60), BigInt(start + 3600), 0, ['GA'], [1_000_000n], [10]]);
  await write(0, x.box, BOX.abi, 'setScanner', [1n, accounts[3].address, true]);
  await final(x.a, (await x.a.buy('0', 0, 1)).id); // ticket 0, event 0: will not be scanned
  await final(x.a, (await x.a.buy('1', 0, 1)).id); // ticket 1, event 1: scanned
  const qr = await x.a.createQr('1');
  await final(x.gate, ((await x.gate.checkIn(qr.encoded)) as { id: string }).id);
  await rpc('evm_increaseTime', [90_001]);
  await rpc('evm_mine');
  x.setClock((start + 90_100) * 1000);

  const [ev0, ev1] = await x.a.getEvents();
  expect([ev0.status, ev0.refundOpen, ev0.quorumMet]).toEqual(['ended', true, false]);
  expect(ev0.settleAt).toBe(ev0.endsAt + 48 * 3600);
  expect([ev1.status, ev1.refundOpen, ev1.quorumMet, ev1.settleAt]).toEqual(['ended', false, true, ev1.endsAt]);
  expect((await x.a.getTicket('0')).status).toBe('refundable');
  expect((await x.a.getTicket('1')).status).toBe('used');
  await expect(x.a.createQr('0')).rejects.toMatchObject({ code: 'EventEnded' });
  const before = await x.usdcOf(1);
  expect((await final(x.a, (await x.a.claimRefund('0')).id)).state).toBe('succeeded');
  expect(await x.usdcOf(1)).toBe(before + 1_000_000n);
});

/** A fresh device key that holds nothing, wired to an in-process relayer that pays the gas. */
async function guestWithRelayer(x: Awaited<ReturnType<typeof setup>>) {
  const relayerKey = `0x${'05'.padStart(64, '0')}` as Hex;
  await rpc('anvil_setBalance', [privateKeyToAccount(relayerKey).address, '0x3635c9adc5dea00000']);
  const relayer = createRelayer({ rpcUrl: RPC, chainId: 31337, privateKey: relayerKey, contract: x.box, usdc: x.usdc }, errorCode);
  const signer = createLocalSigner(createPrivateKey());
  // Earlier tests move the chain clock forward; sign deadlines against chain time.
  const offset = Number((await client.getBlock()).timestamp) * 1000 - Date.now();
  const guest = createTicketService({ config: x.config, signer, store: memoryStore(), relayer, now: () => Date.now() + offset });
  return { guest, signer, relayer };
}

test('a new device key with no AVAX gets test USDC and buys through the relayer (buyFor); it never pays gas', async () => {
  const x = await setup();
  const { guest, signer } = await guestWithRelayer(x);
  expect(await client.getBalance({ address: signer.address })).toBe(0n);
  const f = await final(guest, (await guest.faucet()).id);
  expect([f.state, f.relayed]).toEqual(['succeeded', true]);
  expect((await guest.getBalances(signer.address)).usdc).toBe('100000000');
  const e = await final(guest, (await guest.buy('0', 1, 2)).id);
  expect([e.state, e.relayed, e.amount]).toEqual(['succeeded', true, '6000000']);
  const tickets = await guest.listTickets();
  expect(tickets.map((t) => t.owner.toLowerCase())).toEqual([signer.address.toLowerCase(), signer.address.toLowerCase()]);
  expect((await guest.getBalances(signer.address)).usdc).toBe('94000000');
  expect(await client.getBalance({ address: signer.address })).toBe(0n);
});

test('relayed purchase refused before sending: sold out comes back as the contract error, nothing spent', async () => {
  const x = await setup(1);
  const { guest, signer } = await guestWithRelayer(x);
  await final(guest, (await guest.faucet()).id);
  await expect(guest.buy('0', 0, 2)).rejects.toMatchObject({ code: 'SoldOut' });
  expect((await guest.getBalances(signer.address)).usdc).toBe('100000000');
});

test('listing from a device key with no AVAX: the relayer tops it up for that one transaction', async () => {
  const x = await setup();
  const { guest, signer } = await guestWithRelayer(x);
  await final(guest, (await guest.faucet()).id);
  await final(guest, (await guest.buy('0', 0, 1)).id);
  const [t] = await guest.listTickets();
  const e = await final(guest, (await guest.list(t.tokenId, '1100000')).id);
  expect(e.state).toBe('succeeded');
  expect(e.relayed).toBeUndefined();
  expect((await guest.getTicket(t.tokenId)).status).toBe('listed');
});

test('offline gate: snapshot online, admit with the network down, flush sends the check-in on chain; a resold ticket is flagged', async () => {
  const x = await setup();
  const clock = Number((await client.getBlock()).timestamp) * 1000;
  x.setClock(clock);
  await final(x.a, (await x.a.buy('0', 0, 2)).id); // tickets 0 and 1, held by A
  const store = memoryStore();
  let offline = false;
  const down = new Proxy(x.gate, { get: (t, k) => (offline ? async () => { throw new Error('offline'); } : (t as any)[k]) });
  const gate = createOfflineGate({ store, chain: down as TicketService, scope: 'test', now: () => clock });
  const snap = await gate.refresh();
  expect({ ...snap.domain, verifyingContract: snap.domain.verifyingContract.toLowerCase() }).toEqual({ name: 'VeGoc', version: '1', chainId: 31337, verifyingContract: x.box.toLowerCase() });
  expect(Object.keys(snap.tickets)).toEqual(['0', '1']);
  // A listed ticket can sell any second: it is left out of the list and refused offline.
  await final(x.a, (await x.a.buy('0', 0, 1)).id); // ticket 2
  await final(x.a, (await x.a.list('2', '1000000')).id);
  expect(Object.keys((await gate.refresh()).tickets)).toEqual(['0', '1']);
  expect(snap.tickets['0'].holder).toBe(accounts[1].address);

  offline = true;
  const qr0 = (await x.a.createQr('0')).encoded;
  const qr1 = (await x.a.createQr('1')).encoded;
  expect(await gate.admit(qr0)).toMatchObject({ kind: 'ok', eventName: 'Show', tierName: 'GA' });
  expect(await gate.admit(qr1)).toMatchObject({ kind: 'ok' });
  expect(await gate.admit(qr0)).toMatchObject({ kind: 'rejected', code: 'AlreadyCheckedIn' });
  await expect(gate.flush()).rejects.toThrow();

  // While the door was offline, A resold ticket 1 to B on chain.
  await final(x.a, (await x.a.list('1', '1000000')).id);
  await final(x.b, (await x.b.buyListing('1', '1000000')).id);
  offline = false;
  const r = await gate.flush();
  expect(r.sent).toBe(1);
  expect(r.conflicts.map((c) => [c.tokenId, c.conflict])).toEqual([['1', 'OwnerChanged']]);
  const sent = (await gate.queue()).find((q) => q.tokenId === '0')!;
  expect((await final(x.gate, sent.hash!)).state).toBe('succeeded');
  expect((await x.a.getTicket('0')).checkedIn).toBe(true);
  expect(await gate.flush()).toMatchObject({ synced: 1 });
});
