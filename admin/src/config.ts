import type { Address } from 'viem';
import upgrade from '../../l1/upgrade.json';

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
  /** Public read-only RPC of the venue L1. With it the console reads GateLog and AttendanceMirror on that chain itself. */
  venueRpc?: string;
  /** GateLog on the venue L1: the door scans before they are sent over ICM. */
  gateLog?: Address;
  /** AttendanceMirror on the venue L1: how each event ended, as received from this chain. */
  mirror?: Address;
  /**
   * Wallets the venue L1's network upgrade put on TxAllowList (l1/upgrade.json). The precompile cannot list its
   * members, so these are the first candidates; later changes come from its RoleSet logs. Roles are always read live.
   */
  venueAllowSeed: Address[];
  /** AttendanceRelay on this chain: sends an event's outcome to the venue L1. */
  attendanceRelay?: Address;
  /** Read-only visitors see the events of these organizers. Empty: every event on the contract. */
  organizers: Address[];
  /** PaymentReceipts on this chain: hashes of the VND payments. With `relayerUrl` it enables the Đối soát tab. */
  receipts?: Address;
  receiptsFromBlock: bigint;
  /** The payment backend (relayer), for its public payment list. Relative when the console is served next to it. */
  relayerUrl?: string;
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
  venueRpc: env.VITE_VENUE_RPC ? String(env.VITE_VENUE_RPC) : undefined,
  gateLog: (env.VITE_GATE_LOG || undefined) as Address | undefined,
  mirror: (env.VITE_MIRROR || undefined) as Address | undefined,
  venueAllowSeed: upgrade.precompileUpgrades.flatMap((u) => [...(u.txAllowListConfig?.adminAddresses ?? []), ...(u.txAllowListConfig?.enabledAddresses ?? [])]) as Address[],
  attendanceRelay: (env.VITE_ATTENDANCE_RELAY || undefined) as Address | undefined,
  organizers: String(env.VITE_ORGANIZERS ?? '').split(',').map((a) => a.trim()).filter(Boolean) as Address[],
  receipts: (env.VITE_RECEIPTS || undefined) as Address | undefined,
  receiptsFromBlock: env.VITE_RECEIPTS_FROM_BLOCK ? BigInt(env.VITE_RECEIPTS_FROM_BLOCK) : 0n,
  relayerUrl: env.VITE_RELAYER_URL ? String(env.VITE_RELAYER_URL) : undefined,
};
