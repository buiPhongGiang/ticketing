import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

export const RPC = 'http://127.0.0.1:8546';
const ORGANIZER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SCANNER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

export default async function globalSetup() {
  const artifact = JSON.parse(readFileSync(resolve(process.cwd(), '../out/EventTicket.sol/EventTicket.json'), 'utf8'));
  const account = privateKeyToAccount(ORGANIZER);
  const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) });
  const client = createPublicClient({ chain: foundry, transport: http(RPC) });
  const hash = await wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: ['Sự kiện thử', 'SHOW', 20n, parseEther('0.01'), account.address],
  });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (contractAddress?.toLowerCase() !== '0x5fbdb2315678afecb367f032d93f642f64180aa3') throw new Error(`Unexpected address ${contractAddress}`);
  const tx = await wallet.writeContract({ address: contractAddress, abi: artifact.abi, functionName: 'setScanner', args: [SCANNER, true] });
  await client.waitForTransactionReceipt({ hash: tx });
}
