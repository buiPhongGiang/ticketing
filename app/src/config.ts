import type { Address, AppConfig } from './lib/types';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing setting ${name}. See README.`);
  return value;
}

// Expo inlines EXPO_PUBLIC_* only when they are written out in full.
export const config: AppConfig = {
  chainId: Number(required('EXPO_PUBLIC_CHAIN_ID', process.env.EXPO_PUBLIC_CHAIN_ID)),
  rpcUrl: required('EXPO_PUBLIC_RPC_URL', process.env.EXPO_PUBLIC_RPC_URL),
  contract: required('EXPO_PUBLIC_CONTRACT', process.env.EXPO_PUBLIC_CONTRACT) as Address,
  nativeSymbol: process.env.EXPO_PUBLIC_NATIVE_SYMBOL ?? 'AVAX',
};

/** The contract stores no event details, so they come from configuration. */
export const eventInfo = {
  name: process.env.EXPO_PUBLIC_EVENT_NAME ?? '[EVENT NAME]',
  when: process.env.EXPO_PUBLIC_EVENT_WHEN ?? '[DATE & TIME]',
  venue: process.env.EXPO_PUBLIC_EVENT_VENUE ?? '[VENUE]',
  network: process.env.EXPO_PUBLIC_NETWORK_NAME ?? 'Network',
};

/** Public test keys. Ignored on every chain except the local anvil chain. */
export const devKeys: `0x${string}`[] =
  config.chainId === 31337 && process.env.EXPO_PUBLIC_DEV_KEYS
    ? (process.env.EXPO_PUBLIC_DEV_KEYS.split(',') as `0x${string}`[])
    : [];
