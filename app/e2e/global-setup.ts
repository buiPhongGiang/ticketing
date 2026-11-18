import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

export const RPC = 'http://127.0.0.1:8546';
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // organizer
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // guest A
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // guest B
] as const;
const GATE = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

/** Same addresses as the playwright config: deployer #0 at nonces 0-2 on a fresh anvil. */
export default async function globalSetup() {
  const art = (n: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../out/${n}.sol/${n}.json`), 'utf8'));
  const client = createPublicClient({ chain: foundry, transport: http(RPC) });
  const as = (i: number) => createWalletClient({ account: privateKeyToAccount(KEYS[i]), chain: foundry, transport: http(RPC) });
  const deploy = async (n: string, args: unknown[]) => {
    const a = art(n);
    const hash = await as(0).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  const call = async (i: number, address: Address, n: string, functionName: string, args: unknown[] = []) => {
    const hash = await as(i).writeContract({ address, abi: art(n).abi, functionName, args } as never);
    await client.waitForTransactionReceipt({ hash });
  };
  const usdc = await deploy('MockUSDC', []);
  const vault = await deploy('FloatVault', [usdc]);
  const box = await deploy('TicketBox', [usdc, vault]);
  if (box.toLowerCase() !== '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0') throw new Error(`Unexpected address ${box}`);
  await call(0, vault, 'FloatVault', 'setBox', [box]);
  await call(0, usdc, 'MockUSDC', 'setMinter', [vault]);
  const now = BigInt((await client.getBlock()).timestamp);
  await call(0, box, 'TicketBox', 'createEvent', ['Test Fest', 'Hall A', now + 864000n, now + 900000n, 0, ['GA', 'VIP'], [25_000_000n, 60_000_000n], [100, 10]]);
  await call(0, box, 'TicketBox', 'createEvent', ['Second Show', 'Hall B', now + 964000n, now + 990000n, 0, ['GA'], [15_000_000n], [50]]);
  for (const id of [0n, 1n]) await call(0, box, 'TicketBox', 'setScanner', [id, GATE, true]);
  for (const i of [1, 2]) await call(i, usdc, 'MockUSDC', 'faucet');
}
