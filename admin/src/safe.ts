// A Safe (multisig) as event organizer. The console never holds more than one owner's wallet, so a call from the Safe
// takes two visits: one owner records an approval on chain (approveHash), another executes with both approvals.
// No Safe transaction service is involved: approvals are read from the Safe contract itself.
import { concat, pad, parseAbi, type Address, type Hex } from 'viem';

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
