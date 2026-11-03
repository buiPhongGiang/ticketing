import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createDashboardReader, summarize } from '../src/lib/dashboard';
import { ServiceError } from '../src/lib/types';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;
const base = { maxSupply: '10', priceWei: '1000', balanceWei: '3000', organizer: A, readAt: 1 };

test('summarize counts entries, waiting tickets, unsold tickets and distinct holders', () => {
  const s = summarize({
    ...base,
    tickets: [
      { tokenId: '0', owner: A, checkedIn: true },
      { tokenId: '1', owner: B, checkedIn: false },
      // The same wallet in another letter case is still one holder.
      { tokenId: '2', owner: B.toUpperCase().replace('0X', '0x') as `0x${string}`, checkedIn: false },
    ],
  });
  expect(s).toMatchObject({ issued: 3, entered: 1, waiting: 2, unsold: 7, holders: 2 });
});

test('summarize handles an event with no tickets issued', () => {
  expect(summarize({ ...base, tickets: [] })).toMatchObject({ issued: 0, entered: 0, waiting: 0, unsold: 10, holders: 0 });
});

const PORT = 8598;
const url = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: 'test', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const organizerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const scanner = privateKeyToAccount(organizerKey);
const buyer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const client = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, transport: http() });
const artifact = JSON.parse(readFileSync(new URL('../../out/EventTicket.sol/EventTicket.json', import.meta.url), 'utf8'));
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--port', String(PORT), '--silent']);
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
afterAll(() => { proc?.kill(); });

test('reads the real chain state, including a check-in and sale proceeds', async () => {
  const send = async (account: typeof scanner, functionName: string, args: unknown[], value = 0n) => {
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account, address: contract, abi: artifact.abi, functionName, args, value, chain } as never) });
  };
  const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: scanner, chain, abi: artifact.abi, bytecode: artifact.bytecode.object, args: ['Show', 'SHOW', 5n, 1000n, scanner.address] }) });
  const contract = deployed.contractAddress!;
  const reader = createDashboardReader({ chainId: 31337, rpcUrl: url, contract, nativeSymbol: 'E' });

  expect((await reader.read()).issued).toBe(0);
  expect(await reader.getOrganizer()).toBe(scanner.address);

  await send(scanner, 'setScanner', [scanner.address, true]);
  await send(buyer as never, 'buy', [2n], 2000n);
  await send(scanner, 'mint', [scanner.address, 1n]);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await buyer.signTypedData({
    domain: { name: 'EventTicket', version: '1', chainId: 31337, verifyingContract: contract },
    types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'CheckIn',
    message: { tokenId: 1n, deadline },
  });
  await send(scanner, 'checkIn', [1n, deadline, signature]);

  const s = await reader.read();
  expect(s).toMatchObject({ issued: 3, entered: 1, waiting: 2, unsold: 2, holders: 2, balanceWei: '2000', priceWei: '1000', maxSupply: '5', organizer: scanner.address });
  expect(s.tickets.map((t) => [t.tokenId, t.owner, t.checkedIn])).toEqual([
    ['0', buyer.address, false],
    ['1', buyer.address, true],
    ['2', scanner.address, false],
  ]);
});

test('a dead RPC surfaces as a Network error, never as empty numbers', async () => {
  const reader = createDashboardReader({ chainId: 31337, rpcUrl: 'http://127.0.0.1:1', contract: A, nativeSymbol: 'E' });
  await expect(reader.read()).rejects.toMatchObject({ code: 'Network' } satisfies Partial<ServiceError>);
  await expect(reader.getOrganizer()).rejects.toMatchObject({ code: 'Network' });
});
