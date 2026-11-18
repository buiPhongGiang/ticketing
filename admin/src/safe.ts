// A Safe (multisig) as event organizer. The console never holds more than one owner's wallet, so a call from the Safe
// takes two visits: one owner records an approval on chain (approveHash), another executes with both approvals.
// No Safe transaction service is involved: approvals are read from the Safe contract itself.
import { concat, getAddress, keccak256, pad, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

export interface SafeInfo {
  address: Address;
  owners: Address[];
  threshold: number;
}

export const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
  'function approveHash(bytes32 hashToApprove)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What counts as a Safe. Answering getOwners() and getThreshold() proves nothing: any contract can do that and pose
 * as a multisig. An organizer is treated as a Safe only if all three hold:
 *   1. its runtime code is byte for byte the Safe proxy (compared by hash),
 *   2. the proxy's singleton (storage slot 0) is a canonical Safe implementation,
 *   3. the console was configured with its address (VITE_SAFES).
 * Addresses: the canonical v1.4.1 deployment, same on every chain including Fuji (43113) and Avalanche (43114),
 * https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1 . The code hash is keccak256 of the
 * runtime code of a proxy made by that deployment's SafeProxyFactory (0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67),
 * read on Fuji with `cast code <proxy> | cast keccak`.
 */
export const SAFE_ALLOWLIST = {
  proxyCodeHashes: ['0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c'],
  singletons: [
    '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', // SafeL2 1.4.1
    '0x41675C099F32341bf84BFc5382aF534df5C7461a', // Safe 1.4.1
  ],
} as const;

/** `wallet`: no code. `safe`: verified and pinned. `unverified`: any other contract, never shown or used as a Safe. */
export type OrganizerKind = 'wallet' | 'safe' | 'unverified';

export function classifyOrganizer(o: { code: Hex | undefined; slot0: Hex | undefined; pinned: boolean }): OrganizerKind {
  if (!o.code || o.code === '0x') return 'wallet';
  if (!o.pinned) return 'unverified';
  if (!SAFE_ALLOWLIST.proxyCodeHashes.some((h) => same(h, keccak256(o.code!)))) return 'unverified';
  if (!o.slot0 || o.slot0.length !== 66 || !/^0x0{24}/.test(o.slot0)) return 'unverified';
  const singleton = `0x${o.slot0.slice(26)}`;
  return SAFE_ALLOWLIST.singletons.some((s) => same(s, singleton)) ? 'safe' : 'unverified';
}

export type Organizer = { kind: 'wallet' } | { kind: 'unverified' } | { kind: 'safe'; safe: SafeInfo };

/** Reads what an organizer address is. Owners and threshold are only read from a contract that passed verification. */
export async function inspectOrganizer(client: Pick<PublicClient, 'getCode' | 'getStorageAt' | 'readContract'>, address: Address, pinned: readonly string[]): Promise<Organizer> {
  const code = await client.getCode({ address });
  if (!code || code === '0x') return { kind: 'wallet' };
  const slot0 = await client.getStorageAt({ address, slot: '0x0' });
  if (classifyOrganizer({ code, slot0, pinned: pinned.some((p) => same(p, address)) }) !== 'safe') return { kind: 'unverified' };
  const [owners, threshold] = await Promise.all([
    client.readContract({ address, abi: safeAbi, functionName: 'getOwners' }),
    client.readContract({ address, abi: safeAbi, functionName: 'getThreshold' }),
  ]);
  return { kind: 'safe', safe: { address: getAddress(address), owners: [...owners], threshold: Number(threshold) } };
}
export const isOwner = (safe: SafeInfo | undefined, account: string) => !!safe && safe.owners.some((o) => same(o, account));

/**
 * "Approved hash" signatures as the Safe reads them: per owner 32 bytes of address, 32 zero bytes and v = 1,
 * sorted by owner address. An owner counts if it called approveHash before, or is the one sending execTransaction.
 */
export function approvedSignatures(owners: Address[]): Hex {
  const sorted = [...owners].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return concat(sorted.map((o) => concat([pad(o, { size: 32 }), pad('0x', { size: 32 }), '0x01'])));
}

export type SafeStep =
  /** Enough owners approved already: this owner can execute. `with` are the approvals to attach besides its own. */
  | { kind: 'execute'; with: Address[] }
  /** Not enough yet: this owner adds its approval. */
  | { kind: 'approve'; have: number }
  /** This owner approved earlier and still waits for others. */
  | { kind: 'waiting'; have: number };

/** What `account` can do for a Safe call that `approvers` (other owners included or not) have approved so far. */
export function nextSafeStep(safe: SafeInfo, account: Address, approvers: Address[]): SafeStep {
  const others = approvers.filter((a) => !same(a, account));
  if (others.length + 1 >= safe.threshold) return { kind: 'execute', with: others.slice(0, safe.threshold - 1) };
  return approvers.some((a) => same(a, account)) ? { kind: 'waiting', have: approvers.length } : { kind: 'approve', have: approvers.length };
}
