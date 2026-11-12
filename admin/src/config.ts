import type { Address } from 'viem';
import type { AppConfig } from '../../app/src/lib/types';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing setting ${name}. See README.`);
  return value;
}

const env = import.meta.env;
export const config: AppConfig = {
  chainId: Number(required('VITE_CHAIN_ID', env.VITE_CHAIN_ID)),
  rpcUrl: required('VITE_RPC_URL', env.VITE_RPC_URL),
  contract: required('VITE_CONTRACT', env.VITE_CONTRACT) as Address,
  nativeSymbol: env.VITE_NATIVE_SYMBOL ?? 'AVAX',
};
export const eventInfo = {
  name: env.VITE_EVENT_NAME ?? '[EVENT NAME]',
  when: env.VITE_EVENT_WHEN ?? '[DATE & TIME]',
  venue: env.VITE_EVENT_VENUE ?? '[VENUE]',
  network: env.VITE_NETWORK_NAME ?? 'Network',
};
/** Block of the deploy transaction. Without it, revenue totals stay unavailable. */
export const deployBlock = env.VITE_DEPLOY_BLOCK ? BigInt(env.VITE_DEPLOY_BLOCK) : undefined;
/** Largest eth_getLogs range the RPC accepts. */
export const logChunk = env.VITE_LOG_CHUNK ? BigInt(env.VITE_LOG_CHUNK) : 100n;
