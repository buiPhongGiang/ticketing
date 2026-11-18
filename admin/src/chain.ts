import { createPublicClient, createWalletClient, custom, defineChain, http, numberToHex, type Address, type Hex, type PublicClient } from 'viem';
import { abi } from '../../app/src/lib/abi';
import { createDashboardReader } from '../../app/src/lib/dashboard';
import { config, deployBlock, logChunk } from './config';
import { createEventIndex } from './events';
import { buildLoginMessage, SESSION_MS, verifySession, type LoginContext, type Session } from './login';

export const chain = defineChain({
  id: config.chainId,
  name: 'EventTicket',
  nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});
export const client = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 0, timeout: 8000 }) }) as PublicClient;
export const reader = createDashboardReader(config);
export const eventIndex = createEventIndex({ client, contract: config.contract, deployBlock, chunk: logChunk });
export const isScanner = (address: Address): Promise<boolean> => client.readContract({ address: config.contract, abi, functionName: 'isScanner', args: [address] }) as Promise<boolean>;

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}
export const walletProvider = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

const SESSION_KEY = 'ticket-admin.session';
const loginContext = (): LoginContext => ({ host: window.location.host, chainId: config.chainId, contract: config.contract });
const verifier = { verifyMessage: (a: { address: Address; message: string; signature: Hex }) => client.verifyMessage(a), getOrganizer: () => reader.getOrganizer() };

/** Asks the wallet to move to this event's network, adding it if the wallet does not know it. */
async function ensureChain(provider: Eip1193) {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === config.chainId) return;
  const chainId = numberToHex(config.chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [config.rpcUrl] }] });
  }
}

export async function login(provider: Eip1193): Promise<Session> {
  const [address] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  await ensureChain(provider);
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const message = buildLoginMessage(address, loginContext(), nonce, now);
  const hex = `0x${[...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const signature = (await provider.request({ method: 'personal_sign', params: [hex, address] })) as Hex;
  const session: Session = { address, message, signature, expiresAt: now + SESSION_MS };
  await verifySession(session, loginContext(), verifier, now);
  // Cleared when the tab closes. Holds a signature that can do nothing on chain, and no key.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Restores a login only if it still verifies and the wallet is still on the signing account. */
export async function restoreSession(provider: Eip1193 | undefined): Promise<Session | null> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw || !provider) return null;
  try {
    const session = JSON.parse(raw) as Session;
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    if (accounts[0]?.toLowerCase() !== session.address.toLowerCase()) throw new Error('account changed');
    await verifySession(session, loginContext(), verifier, Date.now());
    return session;
  } catch {
    logout();
    return null;
  }
}

export type AdminAction =
  | { fn: 'mint'; to: Address; quantity: bigint }
  | { fn: 'setScanner'; scanner: Address; allowed: boolean }
  | { fn: 'withdraw'; to: Address };

const argsOf = (a: AdminAction): readonly unknown[] => (a.fn === 'mint' ? [a.to, a.quantity] : a.fn === 'setScanner' ? [a.scanner, a.allowed] : [a.to]);

/** Sends one action through the connected wallet. Calls onHash as soon as it is broadcast, then waits for its receipt. */
export async function sendAction(provider: Eip1193, account: Address, action: AdminAction, onHash: (hash: Hex) => void): Promise<'success' | 'reverted'> {
  await ensureChain(provider);
  const args = argsOf(action);
  // Finds a revert, and its reason, before the wallet asks for a signature.
  await client.simulateContract({ address: config.contract, abi, functionName: action.fn, args, account } as never);
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  const hash = await wallet.writeContract({ address: config.contract, abi, functionName: action.fn, args, chain } as never);
  onHash(hash);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 120_000 });
  return receipt.status;
}

/** Plain words for whatever a wallet or RPC threw. */
export function failureText(error: unknown): string {
  const seen = new Set<unknown>();
  let e = error as any;
  while (e && !seen.has(e)) {
    seen.add(e);
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') return 'Request rejected in wallet.';
    const name = e.data?.errorName ?? e.errorName;
    if (name === 'OwnableUnauthorizedAccount') return 'Not the organizer wallet.';
    if (name === 'SoldOut') return 'Not enough tickets left.';
    if (name === 'WithdrawFailed') return 'Recipient refused the funds.';
    if (name === 'ERC721InvalidReceiver') return 'Invalid recipient address.';
    if (/insufficient funds/i.test(e.message ?? '')) return 'Not enough funds for the fee.';
    e = e.cause;
  }
  if (/timed? ?out|WaitForTransactionReceiptTimeout/i.test(String(error))) return 'No result after 2 minutes. Check before resending.';
  return 'Could not send.';
}
