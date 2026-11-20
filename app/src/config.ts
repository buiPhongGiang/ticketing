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
  usdc: required('EXPO_PUBLIC_USDC', process.env.EXPO_PUBLIC_USDC) as Address,
  nativeSymbol: process.env.EXPO_PUBLIC_NATIVE_SYMBOL ?? 'AVAX',
  organizers: (process.env.EXPO_PUBLIC_ORGANIZERS ?? '').split(',').map((a: string) => a.trim()).filter(Boolean) as Address[],
};

export const networkName = process.env.EXPO_PUBLIC_NETWORK_NAME ?? 'Network';
/** Shown on every screen so a viewer knows which chain the app talks to. */
export const networkLabel = config.chainId === 43113 ? 'Avalanche Fuji' : config.chainId === 43114 ? 'Avalanche' : networkName;
/** False when the payment token has no public faucet (Circle's USDC): the test-USDC button is hidden. */
export const hasFaucet = process.env.EXPO_PUBLIC_FAUCET !== '0';
/** Block explorer base URL (no trailing slash); empty on a local chain. */
export const explorer = process.env.EXPO_PUBLIC_EXPLORER ?? '';

/** Chains where a list of test wallets may be built into the app: local anvil and Avalanche Fuji testnet. */
const TEST_CHAINS = [31337, 43113];

/**
 * Test keys for the wallet switcher. They ship inside the bundle, so they are ignored on any other chain,
 * and on a public testnet they must be throwaway guest or gate wallets, never an organizer's.
 */
export const devKeys: `0x${string}`[] =
  TEST_CHAINS.includes(config.chainId) && process.env.EXPO_PUBLIC_DEV_KEYS
    ? (process.env.EXPO_PUBLIC_DEV_KEYS.split(',') as `0x${string}`[])
    : [];

/**
 * Demo build: the test keys above are set, so the app shows the address, the AVAX balance and the wallet switcher.
 * Without them (a real guest), the app makes a device key on first launch and never shows keys, AVAX or a switcher.
 */
export const demoMode = devKeys.length > 0;

/** Relayer that sends purchases (`buyFor`) and covers fees, so the guest needs no AVAX. Empty: the wallet pays its own fees. */
export const relayerUrl = process.env.EXPO_PUBLIC_RELAYER_URL ?? '';

/** Labels for the test wallets, in the same order as the keys. */
export const devNames: string[] = process.env.EXPO_PUBLIC_DEV_NAMES
  ? process.env.EXPO_PUBLIC_DEV_NAMES.split(',')
  : ['Guest A', 'Guest B', 'Gate staff'];
