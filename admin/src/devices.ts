// Who may send transactions on the venue L1 (vegoc). Its TxAllowList precompile refuses everyone else at the node,
// before a contract runs; GateLog on top of it says which of those wallets are gate devices. The precompile has no
// "list members" call, so candidates come from the network upgrade file, RoleSet logs and GateSet logs, and each
// one's role is then read live. Pure of config, so the rules are unit-tested with a fake client.
import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';

export const TX_ALLOW_LIST: Address = '0x0200000000000000000000000000000000000002';

export const allowListAbi = parseAbi([
  'function readAllowList(address) view returns (uint256)',
  'event RoleSet(uint256 indexed role, address indexed account, address indexed sender, uint256 oldRole)',
]);
export const gateAbi = parseAbi([
  'function isGate(address) view returns (bool)',
  'function venue() view returns (address)',
  'event GateSet(address indexed gate, bool allowed)',
]);

/** TxAllowList roles: 0 none, 1 enabled (may send), 2 admin and 3 manager (may send and change the list). */
export type L1Role = 'none' | 'enabled' | 'admin' | 'manager';
const ROLES: L1Role[] = ['none', 'enabled', 'admin', 'manager'];
export const roleOf = (n: bigint | number): L1Role => ROLES[Number(n)] ?? 'none';

export interface L1Device {
  address: Address;
  role: L1Role;
  /** GateLog accepts scans from this wallet. */
  gate: boolean;
  /** The venue: owner of GateLog, the only wallet that names gate devices. */
  venue: boolean;
  /** Last TxAllowList change for this wallet, when there was one after the network upgrade. */
  changedTx?: Hex;
}

/** What a wallet can do at the door, from the two checks it has to pass. */
export type DeviceKind = 'gate' | 'gate-blocked' | 'venue' | 'admin' | 'sender' | 'removed';
export function deviceKind(d: Pick<L1Device, 'role' | 'gate' | 'venue'>): DeviceKind {
  if (d.venue) return 'venue';
  if (d.gate) return d.role === 'none' ? 'gate-blocked' : 'gate';
  if (d.role === 'none') return 'removed';
  return d.role === 'enabled' ? 'sender' : 'admin';
}

/** Addresses from every source, first mention wins, compared without case. */
export function candidates(...lists: Address[][]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of lists.flat()) if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

const ORDER: DeviceKind[] = ['gate', 'gate-blocked', 'venue', 'admin', 'sender', 'removed'];
export const sortDevices = (list: L1Device[]) => [...list].sort((a, b) => ORDER.indexOf(deviceKind(a)) - ORDER.indexOf(deviceKind(b)));

/** Gate devices that pass both checks right now. */
export const activeGates = (list: L1Device[]) => list.filter((d) => deviceKind(d) === 'gate').length;

type Reader = Pick<PublicClient, 'readContract' | 'getLogs'>;

export async function readDevices(l1: Reader, gateLog: Address, seed: Address[]): Promise<L1Device[]> {
  const [roleLogs, gateLogs, venue] = await Promise.all([
    l1.getLogs({ address: TX_ALLOW_LIST, event: allowListAbi[1], fromBlock: 0n, toBlock: 'latest' }),
    l1.getLogs({ address: gateLog, event: gateAbi[2], fromBlock: 0n, toBlock: 'latest' }),
    l1.readContract({ address: gateLog, abi: gateAbi, functionName: 'venue' }),
  ]);
  const changed = new Map<string, Hex>();
  for (const l of roleLogs) if (l.args.account && l.transactionHash) changed.set(l.args.account.toLowerCase(), l.transactionHash);
  const all = candidates(seed, [venue], gateLogs.flatMap((l) => (l.args.gate ? [l.args.gate] : [])), roleLogs.flatMap((l) => (l.args.account ? [l.args.account] : [])));
  const [roles, gates] = await Promise.all([
    Promise.all(all.map((a) => l1.readContract({ address: TX_ALLOW_LIST, abi: allowListAbi, functionName: 'readAllowList', args: [a] }))),
    Promise.all(all.map((a) => l1.readContract({ address: gateLog, abi: gateAbi, functionName: 'isGate', args: [a] }))),
  ]);
  return sortDevices(all.map((address, i) => ({
    address, role: roleOf(roles[i]), gate: gates[i], venue: address.toLowerCase() === venue.toLowerCase(), changedTx: changed.get(address.toLowerCase()),
  })));
}
