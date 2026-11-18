import type { Address } from 'viem';

export interface AdminConfig {
  chainId: number;
  rpcUrl: string;
  contract: Address;
  usdc?: Address;
  vault?: Address;
  nativeSymbol: string;
  network: string;
  explorer?: string;
  deployBlock?: bigint;
  logChunk: bigint;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing setting ${name}. See README.`);
  return value;
}

const env = import.meta.env;
export const config: AdminConfig = {
  chainId: Number(required('VITE_CHAIN_ID', env.VITE_CHAIN_ID)),
  rpcUrl: required('VITE_RPC_URL', env.VITE_RPC_URL),
  contract: required('VITE_CONTRACT', env.VITE_CONTRACT) as Address,
  usdc: (env.VITE_USDC || undefined) as Address | undefined,
  vault: (env.VITE_VAULT || undefined) as Address | undefined,
  nativeSymbol: env.VITE_NATIVE_SYMBOL ?? 'AVAX',
  network: env.VITE_NETWORK_NAME ?? 'Network',
  explorer: env.VITE_EXPLORER ? String(env.VITE_EXPLORER).replace(/\/$/, '') : undefined,
  deployBlock: env.VITE_DEPLOY_BLOCK ? BigInt(env.VITE_DEPLOY_BLOCK) : undefined,
  logChunk: env.VITE_LOG_CHUNK ? BigInt(env.VITE_LOG_CHUNK) : 100n,
};
