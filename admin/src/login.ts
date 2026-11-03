// Proves control of a wallet by signature, then checks it against owner() on chain.
// This only opens the interface: the contract's onlyOwner is what protects every action.
import type { Address, Hex } from 'viem';

/** How long a login lasts. */
export const SESSION_MS = 8 * 60 * 60 * 1000;

export interface Session {
  address: Address;
  message: string;
  signature: Hex;
  expiresAt: number;
}

export type LoginFailure = 'NotOrganizer' | 'Expired' | 'BadSignature' | 'WrongContract';

export class LoginError extends Error {
  constructor(public reason: LoginFailure) {
    super(reason);
    this.name = 'LoginError';
  }
}

export interface LoginContext {
  host: string;
  chainId: number;
  contract: Address;
}

export function buildLoginMessage(address: Address, ctx: LoginContext, nonce: string, now: number): string {
  return [
    `${ctx.host} muốn bạn đăng nhập trang quản trị vé.`,
    'Việc ký không tạo giao dịch và không tốn phí.',
    '',
    `Ví: ${address}`,
    `Mạng: ${ctx.chainId}`,
    `Hợp đồng: ${ctx.contract}`,
    `Mã dùng một lần: ${nonce}`,
    `Hết hạn: ${new Date(now + SESSION_MS).toISOString()}`,
  ].join('\n');
}

export interface Verifier {
  verifyMessage(args: { address: Address; message: string; signature: Hex }): Promise<boolean>;
  getOrganizer(): Promise<Address>;
}

/** Throws LoginError unless the session is unexpired, for this contract, signed by its wallet, and that wallet is the owner now. */
export async function verifySession(session: Session, ctx: LoginContext, verifier: Verifier, now: number): Promise<void> {
  if (now >= session.expiresAt) throw new LoginError('Expired');
  if (!session.message.includes(`Hợp đồng: ${ctx.contract}`) || !session.message.includes(`Mạng: ${ctx.chainId}`)) throw new LoginError('WrongContract');
  const valid = await verifier.verifyMessage({ address: session.address, message: session.message, signature: session.signature });
  if (!valid) throw new LoginError('BadSignature');
  const organizer = await verifier.getOrganizer();
  if (organizer.toLowerCase() !== session.address.toLowerCase()) throw new LoginError('NotOrganizer');
}
