// Likes and comments for the guest app, kept by the relayer in one JSON file. Off chain, no gas, nothing recorded
// on any chain. Every write carries a signature from the author's device key over the action (src/lib/social.ts).
//
//   POST /social/feed      { eventIds, viewer? }                    counts, and whether the viewer liked each
//   POST /social/comments  { eventId, viewer? }                     newest first, and whether the viewer may comment
//   POST /social/like      { author, eventId, on, at, signature }
//   POST /social/comment   { author, eventId, text, at, signature }
//
// A device key costs nothing to make, so a limit per account alone stops nobody. What holds:
//   - comments only from an account that holds (or was seen holding) a ticket of that event, read from the chain;
//   - per client IP: writes in ten minutes (the relay server adds its own per-minute and per-hour caps);
//   - per event: new likers per hour and comments per hour, counted apart, so likes (open to anyone) can never use
//     up the room for comments (ticket holders only); distinct likers and comments kept are capped too;
//   - signatures in the one canonical form (65 bytes, v 27/28, low s), valid five minutes around the server clock;
//   - a comment's id is derived from what was signed, and one account posts once per event per second.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak256, toHex, verifyMessage } from 'viem';
import { strictSignature } from '../src/lib/offline';
import { cleanComment, COMMENT_MAX, commentKey, SOCIAL_WINDOW_S, socialMessage, type Comment, type EventSocial, type SocialScope } from '../src/lib/social';
import type { Address, Hex } from '../src/lib/types';

export interface SocialLimits {
  /** Per account, in ten minutes. */
  commentsPer10Min: number;
  likesPer10Min: number;
  /** Per client IP, in ten minutes, whatever account signs. */
  ipCommentsPer10Min: number;
  ipLikesPer10Min: number;
  /**
   * Per event per hour, from everyone: accounts newly added to its likers, and comments. Two separate budgets: an
   * account without a ticket can spend the first one only, so it cannot block a ticket holder's comment.
   */
  eventNewLikersPerHour: number;
  eventCommentsPerHour: number;
  /** Distinct accounts that can like one event, and comments kept for it (older ones drop off). */
  likersPerEvent: number;
  commentsPerEvent: number;
}
export const socialLimits: SocialLimits = { commentsPer10Min: 5, likesPer10Min: 30, ipCommentsPer10Min: 10, ipLikesPer10Min: 60, eventNewLikersPerHour: 600, eventCommentsPerHour: 200, likersPerEvent: 5000, commentsPerEvent: 500 };

export interface SocialOptions {
  scope: SocialScope;
  /** JSON file. Without it everything is kept in memory until the process stops. */
  file?: string;
  /** Says whether an event id exists, so the file cannot be filled with made-up ids. */
  eventExists?: (eventId: string) => Promise<boolean>;
  /** Whether the account holds a ticket of the event now, read from the chain. Comments need it. */
  holdsTicket: (eventId: string, account: Address) => Promise<boolean>;
  limits?: Partial<SocialLimits>;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * likes: event → account → when it liked. unlikes: when an account that did like last took it back, so an older
 * signed like cannot return; written only for a like that existed, and trimmed to the newest per event.
 * holders: event → accounts this backend has seen holding a ticket; they may keep commenting after a resale or refund.
 */
interface State {
  likes: Record<string, Record<string, number>>;
  unlikes: Record<string, Record<string, number>>;
  comments: Record<string, Comment[]>;
  holders: Record<string, Record<string, 1>>;
}
const PATHS = new Set(['/social/feed', '/social/comments', '/social/like', '/social/comment']);
const SHOWN = 50;
const TEN_MIN = 600_000;
const HOUR = 3_600_000;

export function createSocial({ scope, file, eventExists = async () => true, holdsTicket, limits, now = Date.now, log = () => {} }: SocialOptions) {
  const lim: SocialLimits = { ...socialLimits, ...limits };
  let state: State = { likes: {}, unlikes: {}, comments: {}, holders: {} };
  if (file && existsSync(file)) {
    try { const s = JSON.parse(readFileSync(file, 'utf8')); state = { likes: s.likes ?? {}, unlikes: s.unlikes ?? {}, comments: s.comments ?? {}, holders: s.holders ?? {} }; } catch { /* a damaged file starts empty */ }
  }
  const save = () => { if (file) { try { writeFileSync(file, JSON.stringify(state)); } catch (e) { log(`social file not written: ${(e as Error).message}`); } } };
  const nowSec = () => Math.floor(now() / 1000);

  const hits = new Map<string, number[]>();
  const recent = (key: string, ms: number) => (hits.get(key) ?? []).filter((t) => t > now() - ms);
  /** True when every counter still has room; then, and only then, each of them is charged. */
  function take(counters: [key: string, limit: number, ms: number][]): boolean {
    const lists = counters.map(([key, , ms]) => recent(key, ms));
    if (lists.some((l, i) => l.length >= counters[i][1])) return false;
    counters.forEach(([key], i) => { lists[i].push(now()); hits.set(key, lists[i]); });
    if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => t > now() - HOUR)) hits.delete(k);
    return true;
  }

  /** event:account → when that account was last charged to the event's new-liker budget. Only a recorded like sets it. */
  const joined = new Map<string, number>();
  const notHolder = new Map<string, number>();
  /** Holds a ticket of the event now, or was seen holding one. A "no" from the chain is trusted for 30 seconds. */
  async function mayComment(eventId: string, account: string): Promise<boolean> {
    const who = account.toLowerCase();
    if (state.holders[eventId]?.[who]) return true;
    const key = `${eventId}:${who}`;
    if (now() - (notHolder.get(key) ?? -Infinity) < 30_000) return false;
    const holds = await holdsTicket(eventId, account as Address).catch(() => false);
    if (!holds) {
      notHolder.set(key, now());
      if (notHolder.size > 20_000) for (const [k, t] of notHolder) if (now() - t > 30_000) notHolder.delete(k);
      return false;
    }
    (state.holders[eventId] ??= {})[who] = 1;
    save();
    return true;
  }

  const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
  const id = (x: unknown): x is string => typeof x === 'string' && /^\d{1,9}$/.test(x);
  const summary = (eventId: string, viewer?: string): EventSocial => ({
    likes: Object.keys(state.likes[eventId] ?? {}).length,
    comments: (state.comments[eventId] ?? []).length,
    liked: !!viewer && !!state.likes[eventId]?.[viewer.toLowerCase()],
  });
  const no = (status: number, error: string) => ({ status, json: { error } });

  /** null when the signed write is in order; otherwise the refusal. */
  async function refuse(body: any, action: 'like' | 'unlike' | 'comment', text: string): Promise<{ status: number; json: unknown } | null> {
    if (!addr(body?.author) || !id(body?.eventId) || typeof body?.signature !== 'string' || !Number.isSafeInteger(body?.at)) return no(400, 'Unknown');
    if (Math.abs(nowSec() - body.at) > SOCIAL_WINDOW_S) return no(400, 'SignatureExpired');
    // One encoding per signature: a high-s twin, a v of 0/1 or a 64-byte compact form is not accepted as "another" request.
    if (!strictSignature(body.signature)) return no(401, 'InvalidSignature');
    let ok = false;
    try { ok = await verifyMessage({ address: body.author, message: socialMessage(scope, action, body.eventId, body.at, text), signature: body.signature as Hex }); } catch { ok = false; }
    if (!ok) return no(401, 'InvalidSignature');
    if (!(await eventExists(body.eventId).catch(() => false))) return no(404, 'BadEvent');
    return null;
  }

  async function handle(path: string, body: any, ip = 'unknown'): Promise<{ status: number; json: unknown }> {
    if (path === '/social/feed') {
      const ids = Array.isArray(body?.eventIds) ? body.eventIds.filter(id).slice(0, 60) : [];
      const viewer = addr(body?.viewer) ? body.viewer : undefined;
      return { status: 200, json: { events: Object.fromEntries(ids.map((e: string) => [e, summary(e, viewer)])) } };
    }
    if (path === '/social/comments') {
      if (!id(body?.eventId)) return no(400, 'Unknown');
      const canComment = addr(body?.viewer) ? await mayComment(body.eventId, body.viewer) : false;
      return { status: 200, json: { comments: (state.comments[body.eventId] ?? []).slice(0, SHOWN), canComment } };
    }
    if (path === '/social/like') {
      const on = body?.on === true;
      const bad = await refuse(body, on ? 'like' : 'unlike', '');
      if (bad) return bad;
      const who = body.author.toLowerCase();
      const likes = (state.likes[body.eventId] ??= {});
      const unlikes = (state.unlikes[body.eventId] ??= {});
      // An older signed action never overrides a newer one, so a captured request cannot flip a like back.
      // Within one second the take-back wins.
      const stale = on ? (likes[who] ?? 0) >= body.at || (unlikes[who] ?? 0) >= body.at : (likes[who] ?? 0) > body.at || (unlikes[who] ?? 0) >= body.at;
      if (stale) return { status: 200, json: { event: summary(body.eventId, who) } };
      // Taking back a like that is not there changes nothing and stores nothing.
      if (!on && !likes[who]) return { status: 200, json: { event: summary(body.eventId, who) } };
      const fresh = on && !likes[who];
      if (fresh && Object.keys(likes).length >= lim.likersPerEvent) return no(429, 'RateLimited');
      // Joining an event's likers is charged to the event's hourly budget, once per account per hour: the same
      // account switching its like off and on within the hour is held by its own and its address's allowance.
      const joinKey = `${body.eventId}:${who}`;
      const charge = fresh && now() - (joined.get(joinKey) ?? -Infinity) >= HOUR;
      const counters: [string, number, number][] = [[`like:a:${who}`, lim.likesPer10Min, TEN_MIN], [`like:ip:${ip}`, lim.ipLikesPer10Min, TEN_MIN]];
      if (charge) counters.push([`event-likers:${body.eventId}`, lim.eventNewLikersPerHour, HOUR]);
      if (!take(counters)) return no(429, 'RateLimited');
      if (charge) {
        joined.set(joinKey, now());
        if (joined.size > 50_000) for (const [k, t] of joined) if (now() - t >= HOUR) joined.delete(k);
      }
      if (on) { likes[who] = body.at; delete unlikes[who]; } else { delete likes[who]; unlikes[who] = body.at; }
      // Only the newest take-backs are worth remembering.
      const gone = Object.keys(unlikes);
      if (gone.length > lim.likersPerEvent) for (const k of gone.slice(0, gone.length - lim.likersPerEvent)) delete unlikes[k];
      save();
      return { status: 200, json: { event: summary(body.eventId, who) } };
    }
    if (path === '/social/comment') {
      const text = typeof body?.text === 'string' ? body.text : '';
      if (!text.trim()) return no(400, 'CommentEmpty');
      if (text.length > COMMENT_MAX || cleanComment(text) !== text) return no(400, 'Unknown');
      const bad = await refuse(body, 'comment', text);
      if (bad) return bad;
      const who = body.author.toLowerCase();
      const list = (state.comments[body.eventId] ??= []);
      // The id comes from what was signed. Sending the same signed comment again returns the stored one.
      const cid = keccak256(toHex(commentKey(who, body.eventId, body.at, text))).slice(0, 18);
      const again = list.find((c) => c.id === cid);
      if (again) return { status: 200, json: { comment: again } };
      // One comment per account, event and second: a second text under the same timestamp is refused.
      if (list.some((c) => c.author.toLowerCase() === who && c.at === body.at)) return no(409, 'RateLimited');
      // Checked before any allowance is charged: an account without a ticket spends none of the comment budgets.
      if (!(await mayComment(body.eventId, body.author))) return no(403, 'NeedTicket');
      if (!take([[`comment:a:${who}`, lim.commentsPer10Min, TEN_MIN], [`comment:ip:${ip}`, lim.ipCommentsPer10Min, TEN_MIN], [`event-comments:${body.eventId}`, lim.eventCommentsPerHour, HOUR]])) return no(429, 'RateLimited');
      const comment: Comment = { id: cid, author: body.author, text, at: body.at };
      list.unshift(comment);
      if (list.length > lim.commentsPerEvent) list.length = lim.commentsPerEvent;
      save();
      return { status: 200, json: { comment } };
    }
    return no(404, 'Unknown');
  }

  return { handle, handles: (path: string) => PATHS.has(path) };
}
