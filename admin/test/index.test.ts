import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEventIndex, revenueOf, scannerCandidates } from '../src/events';

const PORT = 8596, url = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: 't', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const guest = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) }) as PublicClient;
const wallet = createWalletClient({ chain, transport: http(url) });
const artifact = JSON.parse(readFileSync(new URL('../../out/EventTicket.sol/EventTicket.json', import.meta.url), 'utf8'));
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', String(PORT), '--silent']);
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
afterAll(() => { proc?.kill(); });

async function deploy() {
  const r = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: owner, chain, abi: artifact.abi, bytecode: artifact.bytecode.object, args: ['S', 'S', 10n, 1000n, owner.address] }) });
  const contract = r.contractAddress!;
  const send = async (account: typeof owner, functionName: string, args: unknown[], value = 0n) => {
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account, chain, address: contract, abi: artifact.abi, functionName, args, value } as never) });
  };
  return { contract, send, deployBlock: r.blockNumber };
}

test('reads sales, free mints, scanners and withdrawals over many small chunks', async () => {
  const { contract, send, deployBlock } = await deploy();
  await send(owner, 'setScanner', [guest.address, true]);
  await send(guest as never, 'buy', [2n], 2000n);
  await send(owner, 'mint', [guest.address, 1n]);
  await send(owner, 'setScanner', [guest.address, false]);
  await send(owner, 'withdraw', [owner.address]);
  await send(guest as never, 'buy', [1n], 1000n);

  const index = createEventIndex({ client, contract, deployBlock, chunk: 2n });
  const seen: bigint[] = [];
  const s = await index.sync((p) => seen.push(p.scannedTo));
  expect(s.complete).toBe(true);
  expect(seen.length).toBeGreaterThan(1);
  expect(revenueOf(s, 1000n, 1000n)).toEqual({ sold: 3, free: 1, collectedWei: 3000n, withdrawnWei: 2000n, balanceWei: 1000n });
  expect(scannerCandidates(s.events)).toEqual([guest.address]);
  expect(s.events.every((e) => e.timestamp > 1_600_000_000)).toBe(true);
});

test('a later sync only adds new events', async () => {
  const { contract, send, deployBlock } = await deploy();
  await send(guest as never, 'buy', [1n], 1000n);
  const index = createEventIndex({ client, contract, deployBlock });
  expect((await index.sync()).events).toHaveLength(1);
  await send(owner, 'mint', [guest.address, 1n]);
  expect((await index.sync()).events.map((e) => e.tokenId)).toEqual(['0', '1']);
});

test('without a deploy block the history is marked incomplete', async () => {
  const { contract, send } = await deploy();
  await send(guest as never, 'buy', [1n], 1000n);
  const s = await createEventIndex({ client, contract }).sync();
  expect(s.events).toHaveLength(1);
  expect(s.complete).toBe(false);
  expect(revenueOf(s, 1000n, 1000n)).toBeNull();
});

test('a failure mid-scan keeps progress and resumes where it stopped', async () => {
  const { contract, send, deployBlock } = await deploy();
  await send(guest as never, 'buy', [1n], 1000n);
  await send(guest as never, 'buy', [1n], 1000n);
  let fail = true, calls = 0;
  const flaky = new Proxy(client, { get(t, k) {
    if (k !== 'getLogs') return (t as any)[k];
    return (a: any) => {
      calls++;
      if (fail && calls === 2) return Promise.reject(new Error('429'));
      return t.getLogs(a);
    };
  } }) as PublicClient;
  const index = createEventIndex({ client: flaky, contract, deployBlock, chunk: 1n });
  await expect(index.sync()).rejects.toThrow('429');
  expect(index.state().complete).toBe(false);
  const reached = index.state().scannedTo;
  fail = false;
  const s = await index.sync();
  expect(s.complete).toBe(true);
  expect(s.events).toHaveLength(2);
  expect(reached).toBe(deployBlock);
});
