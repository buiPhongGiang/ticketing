// Log index against a real chain: ticket → event mapping from mint logs, refunds of burned tickets, chunked resume.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { Address, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, usdcAbi } from '../../app/src/lib/abi';
import { connect, deployAll, KEYS } from '../e2e/deploy';
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { createLogIndex, entriesOf, refundsOf, scannerCandidates } from '../src/logs';
import { inspectOrganizer } from '../src/safe';
import { SAFE_L2_SINGLETON, SAFE_PROXY_CODE } from './safe-proxy.fixture';

// A port the system hands out, so two test runs (or anything else on a fixed port) cannot collide.
const PORT = await new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const RPC = `http://127.0.0.1:${PORT}`;
const { client, walletOf } = connect(RPC);
const organizer = privateKeyToAccount(KEYS.organizer);
const guest = privateKeyToAccount(KEYS.guest);
const guest2 = privateKeyToAccount(KEYS.guest2);
const gate = privateKeyToAccount(KEYS.gate);
let proc: ChildProcess;
let box: Address, usdc: Address, deployBlock: bigint;

beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', String(PORT), '--silent']);
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  ({ box, usdc, block: deployBlock } = await deployAll(RPC));
});
afterAll(() => { proc?.kill(); });

async function send(account: typeof organizer, functionName: string, args: unknown[], address = box, contractAbi: unknown = abi) {
  const r = await client.waitForTransactionReceipt({ hash: await walletOf(account).writeContract({ address, abi: contractAbi, functionName, args } as never) });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
}
const now = async () => Number((await client.getBlock()).timestamp);
async function createEvent(name: string, prices = [10_000000n, 30_000000n]) {
  const t = await now();
  const id = Number(await client.readContract({ address: box, abi, functionName: 'eventCount' }));
  await send(organizer, 'createEvent', [name, 'Hall', BigInt(t + 60), BigInt(t + 7200), 0, ['GA', 'VIP'], prices, [10, 5]]);
  return id;
}
async function buy(account: typeof guest, eventId: number, tier: number, qty: number, price: bigint) {
  await send(account, 'faucet', [], usdc, usdcAbi);
  await send(account, 'approve', [box, price * BigInt(qty)], usdc, usdcAbi);
  await send(account, 'buy', [BigInt(eventId), BigInt(tier), BigInt(qty)]);
}

test('maps tickets to events from mint logs and keeps refunds of burned tickets', async () => {
  const a = await createEvent('A');
  const b = await createEvent('B');
  await buy(guest, a, 0, 2, 10_000000n); // tokens 0, 1
  await send(organizer, 'issue', [BigInt(b), 1n, guest2.address, 1n]); // token 2
  await buy(guest2, a, 1, 1, 30_000000n); // token 3
  await send(organizer, 'setScanner', [BigInt(a), gate.address, true]);
  await send(guest, 'list', [1n, 11_000000n]);
  await send(guest2, 'approve', [box, 11_000000n], usdc, usdcAbi);
  await send(guest2, 'buyListing', [1n, 11_000000n]);
  await send(organizer, 'cancelEvent', [BigInt(a)]);
  await send(guest, 'refundMany', [[0n, 1n, 3n]]);

  const index = createLogIndex({ client: client as PublicClient, contract: box, deployBlock, chunk: 3n });
  const seen: bigint[] = [];
  const s = await index.sync((p) => seen.push(p.scannedTo));
  expect(s.complete).toBe(true);
  expect(seen.length).toBeGreaterThan(3);
  expect([...s.mints.entries()]).toEqual([
    [0, { eventId: a, tier: 0, paid: 10_000000n }], [1, { eventId: a, tier: 0, paid: 10_000000n }],
    [2, { eventId: b, tier: 1, paid: 0n }], [3, { eventId: a, tier: 1, paid: 30_000000n }],
  ]);
  expect(refundsOf(s, a)).toEqual([
    { tokenId: 3, holder: guest2.address, amount: 30_000000n, tier: 1 },
    { tokenId: 1, holder: guest2.address, amount: 10_000000n, tier: 0 },
    { tokenId: 0, holder: guest.address, amount: 10_000000n, tier: 0 },
  ]);
  expect(entriesOf(s, a).map((e) => e.kind)).toEqual(['Refunded', 'Refunded', 'Refunded', 'Cancelled', 'Resold', 'Listed', 'ScannerSet', 'Purchased', 'Purchased', 'EventCreated']);
  expect(entriesOf(s, b).map((e) => e.kind)).toEqual(['Issued', 'EventCreated']);
  expect(entriesOf(s, a, ['Resold'])[0]).toMatchObject({ tokenId: 1, account: guest.address, other: guest2.address, amount: 11_000000n });
  expect(scannerCandidates(s, a)).toEqual([gate.address]);
  expect(s.entries.every((e) => (e.timestamp ?? 0) > 1_600_000_000)).toBe(true);
});

test('a failure mid-scan keeps progress and a later sync only adds new logs', async () => {
  const c = await createEvent('C');
  let fail = true, calls = 0;
  const flaky = new Proxy(client, { get(t, k) {
    if (k !== 'getLogs') return (t as any)[k];
    return (args: any) => { calls++; return fail && calls === 2 ? Promise.reject(new Error('429')) : (t as any).getLogs(args); };
  } }) as unknown as PublicClient;
  const index = createLogIndex({ client: flaky, contract: box, deployBlock, chunk: 5n });
  await expect(index.sync()).rejects.toThrow('429');
  const reached = index.state().scannedTo;
  expect(index.state().complete).toBe(false);
  expect(reached).toBe(deployBlock + 4n);
  fail = false;
  const before = (await index.sync()).entries.length;
  expect(index.state().complete).toBe(true);
  await send(organizer, 'issue', [BigInt(c), 0n, guest.address, 2n]);
  const after = await index.sync();
  expect(after.entries.length).toBe(before + 1);
  expect(entriesOf(after, c)[0]).toMatchObject({ kind: 'Issued', quantity: 2, tokenIds: [4, 5] });
});

test('with a block list from an indexer the activity is there before the scan; a failing indexer changes nothing', async () => {
  const full = await createLogIndex({ client: client as PublicClient, contract: box, deployBlock, chunk: 50n }).sync();
  const known = new Map(full.entries.map((e) => [e.block, e.timestamp ?? 0] as [bigint, number]));

  const progress: { entries: number; scannedTo: bigint; complete: boolean }[] = [];
  const fast = createLogIndex({ client: client as PublicClient, contract: box, deployBlock, chunk: 3n, discover: async () => known });
  const done = await fast.sync((s) => progress.push({ entries: s.entries.length, scannedTo: s.scannedTo, complete: s.complete }));
  // First report: everything is listed although no block range has been scanned yet.
  expect(progress[0]).toEqual({ entries: full.entries.length, scannedTo: deployBlock - 1n, complete: false });
  expect(done.complete).toBe(true);
  expect(done.entries.map((e) => e.id)).toEqual(full.entries.map((e) => e.id));
  expect([...done.mints.entries()]).toEqual([...full.mints.entries()]);

  const broken = createLogIndex({ client: client as PublicClient, contract: box, deployBlock, chunk: 50n, discover: async () => { throw new Error('indexer down'); } });
  const viaScan = await broken.sync();
  expect(viaScan.complete).toBe(true);
  expect(viaScan.entries.map((e) => e.id)).toEqual(full.entries.map((e) => e.id));
});

// ---------------------------------------------------------------- organizer verification

const fakeSafe = JSON.parse(readFileSync(new URL('../../out/FakeSafe.sol/FakeSafe.json', import.meta.url), 'utf8'));

test('a contract that merely answers getOwners/getThreshold is not a Safe, even when pinned; nothing is read from it', async () => {
  const hash = await walletOf(organizer).deployContract({ abi: fakeSafe.abi, bytecode: fakeSafe.bytecode.object, args: [] } as never);
  const fake = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
  // It does answer like a Safe…
  expect(await client.readContract({ address: fake, abi: fakeSafe.abi, functionName: 'getThreshold' })).toBe(2n);
  // …and is still refused, pinned or not.
  expect(await inspectOrganizer(client as PublicClient, fake, [fake])).toEqual({ kind: 'unverified' });
  expect(await inspectOrganizer(client as PublicClient, fake, [])).toEqual({ kind: 'unverified' });
  expect(await inspectOrganizer(client as PublicClient, organizer.address, [organizer.address])).toEqual({ kind: 'wallet' });
});

test('the Safe proxy code with a canonical singleton is accepted when pinned, and refused with any other singleton', async () => {
  const proxy = '0x00000000000000000000000000000000000a11ce' as Address;
  const slot = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;
  // Stand-in for the singleton's storage readers, at the canonical singleton address (anvil has no Safe deployed).
  await client.request({ method: 'anvil_setCode' as never, params: [SAFE_L2_SINGLETON, fakeSafe.deployedBytecode.object] as never });
  await client.request({ method: 'anvil_setCode' as never, params: [proxy, SAFE_PROXY_CODE] as never });
  await client.request({ method: 'anvil_setStorageAt' as never, params: [proxy, '0x0', slot(SAFE_L2_SINGLETON)] as never });
  const ok = await inspectOrganizer(client as PublicClient, proxy, [proxy]);
  expect(ok).toMatchObject({ kind: 'safe', safe: { threshold: 2 } });
  expect(await inspectOrganizer(client as PublicClient, proxy, [])).toEqual({ kind: 'unverified' }); // not pinned
  await client.request({ method: 'anvil_setStorageAt' as never, params: [proxy, '0x0', slot(guest.address)] as never });
  expect(await inspectOrganizer(client as PublicClient, proxy, [proxy])).toEqual({ kind: 'unverified' }); // foreign implementation
});

// Read-only check against the live chain. Run with FUJI_RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com
test.skipIf(!process.env.FUJI_RPC_URL)('the team Safe on Fuji verifies as a 2-of-3 Safe', async () => {
  const fuji = createPublicClient({ chain: avalancheFuji, transport: http(process.env.FUJI_RPC_URL) });
  const SAFE = '0x96aDD8A7c64d93818cc71eb6E97Db478a091bc41' as Address;
  const found = await inspectOrganizer(fuji as PublicClient, SAFE, [SAFE]);
  expect(found).toMatchObject({ kind: 'safe', safe: { address: SAFE, threshold: 2 } });
  expect(found.kind === 'safe' && found.safe.owners).toHaveLength(3);
  expect(await inspectOrganizer(fuji as PublicClient, SAFE, [])).toEqual({ kind: 'unverified' });
});
