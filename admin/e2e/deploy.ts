// Deploys MockUSDC → FloatVault(usdc) → VeGoc(usdc, vault, feeRecipient, feeBps) on a fresh anvil, wires them and
// funds the vault's mock-yield reserve, like the deploy scripts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const KEYS = {
  organizer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  guest: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  guest2: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  gate: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;

/** Platform fee on settled principal and the wallet that receives it. */
export const FEE_BPS = 300n;
export const TREASURY = '0x00000000000000000000000000000000000000fe' as Address;
export const RESERVE = 500_000000n;

const OUT = resolve(import.meta.dirname, '../../out');
const artifact = (file: string, name: string) => JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, 'utf8'));

export function connect(rpc: string) {
  const chain = defineChain({ id: 31337, name: 'Anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }), pollingInterval: 50 });
  const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });
  return { chain, client, walletOf };
}

export async function deployAll(rpc: string): Promise<{ usdc: Address; vault: Address; box: Address; block: bigint }> {
  const { client, walletOf } = connect(rpc);
  const wallet = walletOf(privateKeyToAccount(KEYS.organizer));
  const deploy = async (file: string, name: string, args: unknown[]) => {
    const a = artifact(file, name);
    const r = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args } as never) });
    return { address: r.contractAddress!, block: r.blockNumber, abi: a.abi };
  };
  const usdc = await deploy('MockUSDC.sol', 'MockUSDC', []);
  const vault = await deploy('FloatVault.sol', 'FloatVault', [usdc.address]);
  const box = await deploy('VeGoc.sol', 'VeGoc', [usdc.address, vault.address, TREASURY, FEE_BPS]);
  const send = async (address: Address, abi: unknown, functionName: string, args: unknown[]) =>
    client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args } as never) });
  await send(vault.address, vault.abi, 'setBox', [box.address]);
  // Mock yield is paid from a reserve somebody funded: here the organizer puts in 500 faucet USDC.
  await send(usdc.address, usdc.abi, 'faucet', []);
  await send(usdc.address, usdc.abi, 'approve', [vault.address, RESERVE]);
  await send(vault.address, vault.abi, 'fundReserve', [RESERVE]);
  return { usdc: usdc.address, vault: vault.address, box: box.address, block: usdc.block };
}
