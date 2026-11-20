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
  /** Safes this console trusts as organizers. A contract organizer outside this list is never treated as a Safe. */
  safes: Address[];
  /** Avalanche Data API (Glacier) base URL. When set, the activity feed gets its first paint from it. */
  dataApi?: string;
  /** VenueCheckIns on this chain: door scans received over ICM from the venue L1. The panel is hidden without it. */
  venueCheckIns?: Address;
  venueFromBlock: bigint;
  venueChain: string;
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
  safes: String(env.VITE_SAFES ?? '').split(',').map((a) => a.trim()).filter(Boolean) as Address[],
  dataApi: env.VITE_DATA_API ? String(env.VITE_DATA_API).replace(/\/$/, '') : undefined,
  venueCheckIns: (env.VITE_VENUE_CHECKINS || undefined) as Address | undefined,
  venueFromBlock: env.VITE_VENUE_FROM_BLOCK ? BigInt(env.VITE_VENUE_FROM_BLOCK) : 0n,
  venueChain: env.VITE_VENUE_CHAIN ?? 'venue L1',
};
