// Likes and comments on events. Off chain on purpose: nothing here is worth a transaction, and none of it is
// presented as on-chain. The relayer keeps them in a small file; the author is proven by a signature from the
// device key (EIP-191), so nobody can like or comment as someone else and no gas is involved.
//
// Shared by the app and the relayer; nothing here needs Node.
import { ServiceError, type Address, type Hex, type LocalSigner } from './types';

export const COMMENT_MAX = 280;
/** A signed action is accepted for five minutes around the server's clock. */
export const SOCIAL_WINDOW_S = 300;

export type SocialAction = 'like' | 'unlike' | 'comment';
export interface SocialScope { chainId: number; contract: Address }

/** What the device key signs. One line per field, so the text a wallet would show is readable. */
export function socialMessage(scope: SocialScope, action: SocialAction, eventId: string, at: number, text = ''): string {
  return ['Vé Gốc', `network ${scope.chainId}`, `contract ${scope.contract.toLowerCase()}`, `${action} event ${eventId}`, `at ${at}`, text].join('\n');
}

/** Plain text only: control characters and angle brackets are dropped, runs of blank space collapse, 280 characters at most. */
export function cleanComment(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F<>]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, COMMENT_MAX);
}

export interface EventSocial { likes: number; comments: number; liked: boolean }
export interface Comment { id: string; author: Address; text: string; at: number }

export interface SocialClient {
  /** Counts for a list of events, and whether this device liked each. */
  feed(eventIds: string[]): Promise<Record<string, EventSocial>>;
  /** Newest first, and whether this device may comment: only an account with a ticket of the event can. */
  comments(eventId: string): Promise<{ comments: Comment[]; canComment: boolean }>;
  like(eventId: string, on: boolean): Promise<EventSocial>;
  comment(eventId: string, text: string): Promise<Comment>;
}

const errorCodes = new Set<string>(['RateLimited', 'SignatureExpired', 'InvalidSignature', 'BadEvent', 'CommentEmpty', 'NeedTicket', 'Network', 'Unknown']);

export function httpSocial(url: string, signer: LocalSigner, scope: SocialScope, now: () => number = Date.now, fetchImpl: typeof fetch = fetch): SocialClient {
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new ServiceError('Network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new ServiceError(errorCodes.has(json.error) ? json.error : 'Unknown');
    return json;
  };
  const signed = async (action: SocialAction, eventId: string, text = '') => {
    const at = Math.floor(now() / 1000);
    const signature: Hex = await signer.signMessage(socialMessage(scope, action, eventId, at, text));
    return { author: signer.address, eventId, at, signature, text };
  };
  return {
    feed: async (eventIds) => (await post('social/feed', { eventIds, viewer: signer.address })).events,
    comments: async (eventId) => { const r = await post('social/comments', { eventId, viewer: signer.address }); return { comments: r.comments, canComment: !!r.canComment }; },
    like: async (eventId, on) => (await post('social/like', { ...(await signed(on ? 'like' : 'unlike', eventId)), on })).event,
    comment: async (eventId, text) => {
      const clean = cleanComment(text);
      if (!clean) throw new ServiceError('CommentEmpty');
      return (await post('social/comment', await signed('comment', eventId, clean))).comment;
    },
  };
}

/**
 * A comment's id comes from what was signed (author, event, time, text), never from the signature bytes: two
 * encodings of one signature must not make two comments.
 */
export const commentKey = (author: string, eventId: string, at: number, text: string) => `${author.toLowerCase()}|${eventId}|${at}|${text}`;

/** A guest has no name in the app: comments show a neutral label from the end of the account id. */
export const guestName = (author: string) => `Khách ${author.slice(-4).toUpperCase()}`;
