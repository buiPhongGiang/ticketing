// Seller notes for the ticket market, kept by the relayer in one JSON file. Off chain, no gas, nothing recorded on
// any chain, and no money or ticket moves here: prices, buying and the queue are the contract's. This is the only
// thing the market stores off chain; there is no write path for an account without a listed ticket.
//
//   POST /exchange/notes  { tokenIds }                                    notes by ticket id
//   POST /exchange/note   { author, tokenId, price, text, at, signature }
//
// What holds:
//   - a note is written only by the account the chain shows as the ticket's holder, while it is listed at the
//     signed price (read fresh from the chain on every write), so writing one takes a real, listed ticket;
//   - a note is served only while that is still true. A read changes nothing: it leaves out what no longer fits.
//     Notes are removed by the holder's next write or by the background sweep, which removes a note only if it
//     is still the very note it looked up;
//   - a read asks the chain through a short cache (answers and "no such ticket" alike), each id once, and only a
//     capped number of ids not in the cache per request; the rest are left out until a later read;
//   - per account and per client address (an IPv6 /64 counts as one): writes in ten minutes, on top of the relay
//     server's own caps; per event: writes per hour;
//   - signatures in the one canonical form (65 bytes, v 27/28, low s), valid five minutes around the server clock;
//   - plain text, 140 characters, nothing invisible. Nothing here is logged.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, verifyMessage, type Abi } from 'viem';
import { abi } from '../src/lib/abi';
import { cleanText, EXCHANGE_WINDOW_S, NOTE_MAX, noteFits, noteMessage, type ExchangeScope, type ListingNote } from '../src/lib/exchange';
import { strictSignature } from '../src/lib/offline';
import type { Address, Hex } from '../src/lib/types';

export interface ExchangeLimits {
  /** Notes one account may write in ten minutes. */
  notesPer10Min: number;
  /** Notes one client address may write in ten minutes, whatever account signs. */
  ipNotesPer10Min: number;
  /** Notes one event takes in an hour, from everyone. */
  eventNotesPerHour: number;
  /** Ticket ids one read may ask the chain about when they are not in the cache. */
  lookupsPerRead: number;
}
export const exchangeLimits: ExchangeLimits = { notesPer10Min: 10, ipNotesPer10Min: 20, eventNotesPerHour: 300, lookupsPerRead: 20 };

/**
 * What a per-address limit counts against: an IPv4 address as it is, an IPv6 address by its /64, since one
 * subscriber holds a whole /64 and could otherwise show up as a new address for every request.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export type ListedTicket = { owner: Address; listPrice: string; eventId: string };
/** What the backend reads from the chain: a ticket's holder, listing price ('0': not listed) and event; null if there is no such ticket. */
export interface ExchangeChain {
  ticket(tokenId: string): Promise<ListedTicket | null>;
}

/** That read over a public RPC. No key: this only reads. */
export function exchangeChain({ rpcUrl, contract }: { rpcUrl: string; contract: Address }): ExchangeChain {
  const pub = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });
  return {
    ticket: async (tokenId) => {
      try {
        const t = (await pub.readContract({ address: contract, abi: abi as Abi, functionName: 'getTicket', args: [BigInt(tokenId)] } as never)) as any;
        return { owner: t.owner, listPrice: t.listPrice.toString(), eventId: t.eventId.toString() };
      } catch (e) {
        if (/NonexistentToken/.test(String((e as { message?: string })?.message ?? e))) return null;
        throw e;
      }
    },
  };
}

export interface ExchangeOptions {
  scope: ExchangeScope;
  chain: ExchangeChain;
  /** JSON file. Without it everything is kept in memory until the process stops. */
  file?: string;
  limits?: Partial<ExchangeLimits>;
  now?: () => number;
}

const PATHS = new Set(['/exchange/notes', '/exchange/note']);
/** For the relay server's own per-address counters: the read is cheap, the write is counted like likes and comments. */
export const exchangeRoute = (path: string): 'read' | 'write' | null => (path === '/exchange/notes' ? 'read' : path === '/exchange/note' ? 'write' : null);

const TEN_MIN = 600_000;
const HOUR = 3_600_000;
/** How long an answer from the chain is reused; a failed call is not asked again for a few seconds. */
const CACHE_MS = 15_000;
const RETRY_MS = 5_000;

export function createExchange({ scope, chain, file, limits, now = Date.now }: ExchangeOptions) {
  const lim: ExchangeLimits = { ...exchangeLimits, ...limits };
  let notes: Record<string, ListingNote> = {};
  if (file && existsSync(file)) {
    try { notes = JSON.parse(readFileSync(file, 'utf8')).notes ?? {}; } catch { /* a damaged file starts empty */ }
  }
  // Written beside the file and moved into place, so a crash mid-write cannot leave half a file.
  const save = () => { if (file) { try { writeFileSync(`${file}.tmp`, JSON.stringify({ notes })); renameSync(`${file}.tmp`, file); } catch { /* kept in memory; the next write tries again */ } } };
  const nowSec = () => Math.floor(now() / 1000);

  const hits = new Map<string, number[]>();
  /** True when every counter still has room; then, and only then, each of them is charged. */
  function take(counters: [key: string, limit: number, ms: number][]): boolean {
    const lists = counters.map(([key, , ms]) => (hits.get(key) ?? []).filter((t) => t > now() - ms));
    if (lists.some((l, i) => l.length >= counters[i][1])) return false;
    counters.forEach(([key], i) => { lists[i].push(now()); hits.set(key, lists[i]); });
    if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => t > now() - HOUR)) hits.delete(k);
    return true;
  }

  /** ticket null: the chain says there is no such ticket. ticket undefined: the chain did not answer. */
  const seen = new Map<string, { at: number; ticket: ListedTicket | null | undefined }>();
  const cached = (tokenId: string) => {
    const hit = seen.get(tokenId);
    return hit && now() - hit.at < (hit.ticket === undefined ? RETRY_MS : CACHE_MS) ? hit : undefined;
  };
  /** One read of the chain, remembered whatever the answer. */
  async function lookup(tokenId: string): Promise<ListedTicket | null | undefined> {
    let ticket: ListedTicket | null | undefined;
    try { ticket = await chain.ticket(tokenId); } catch { ticket = undefined; }
    if (seen.size > 5000) for (const [k, v] of seen) if (now() - v.at >= CACHE_MS) seen.delete(k);
    seen.set(tokenId, { at: now(), ticket });
    return ticket;
  }

  const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
  const num = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9]\d{0,8})$/.test(x);
  const units = (x: unknown): x is string => typeof x === 'string' && /^[1-9]\d{0,30}$/.test(x);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const no = (status: number, error: string) => ({ status, json: { error } });

  async function handle(path: string, body: any, clientIp = 'unknown'): Promise<{ status: number; json: unknown }> {
    if (path === '/exchange/notes') {
      // Each id once, and only ids a note is stored for ever reach the chain.
      const ids: string[] = Array.isArray(body?.tokenIds) ? [...new Set<string>(body.tokenIds.filter(num))].slice(0, 100).filter((i) => notes[i]) : [];
      let budget = lim.lookupsPerRead;
      const out: Record<string, ListingNote> = {};
      await Promise.all(ids.map(async (i) => {
        const hit = cached(i);
        // Over the cap for this request: left out now, answered by a later read once the cache holds it.
        if (!hit && budget-- <= 0) return;
        const ticket = hit ? hit.ticket : await lookup(i);
        const note = notes[i];
        // Served only while the chain shows the author holding the ticket at that price. Nothing is removed here.
        if (ticket && noteFits(note, ticket.owner, ticket.listPrice)) out[i] = note;
      }));
      return { status: 200, json: { notes: out } };
    }
    if (path === '/exchange/note') {
      const text = typeof body?.text === 'string' ? body.text : null;
      // The text as sent must already be in its clean form, so what is stored is exactly what was signed.
      if (text === null || text.length > 4 * NOTE_MAX || cleanText(text, NOTE_MAX) !== text) return no(400, 'Unknown');
      if (!addr(body?.author) || !num(body?.tokenId) || !units(body?.price) || typeof body?.signature !== 'string' || !Number.isSafeInteger(body?.at)) return no(400, 'Unknown');
      if (Math.abs(nowSec() - body.at) > EXCHANGE_WINDOW_S) return no(400, 'SignatureExpired');
      // One encoding per signature: a high-s twin, a v of 0/1 or a 64-byte compact form is not "another" request.
      if (!strictSignature(body.signature)) return no(401, 'InvalidSignature');
      let ok = false;
      try { ok = await verifyMessage({ address: body.author, message: noteMessage(scope, body.tokenId, body.price, body.at, text), signature: body.signature as Hex }); } catch { ok = false; }
      if (!ok) return no(401, 'InvalidSignature');
      const ip = ipBucket(clientIp);
      // Counted before the chain is asked, so a valid key cannot be used to make the relayer read without end.
      if (!take([[`note:a:${body.author.toLowerCase()}`, lim.notesPer10Min, TEN_MIN], [`note:ip:${ip}`, lim.ipNotesPer10Min, TEN_MIN]])) return no(429, 'RateLimited');
      // A write always reads the chain itself: the holder and the price must be what was signed, now.
      const ticket = await lookup(body.tokenId);
      if (ticket === undefined) return no(503, 'Network');
      if (!ticket || !same(ticket.owner, body.author)) return no(403, 'NotHolder');
      if (ticket.listPrice === '0') return no(409, 'NotListed');
      if (ticket.listPrice !== body.price) return no(409, 'PriceChanged');
      if (!take([[`note:event:${ticket.eventId}`, lim.eventNotesPerHour, HOUR]])) return no(429, 'RateLimited');
      // What is stored for this ticket counts only if it is this same listing: same holder, same price.
      const old = noteFits(notes[body.tokenId], ticket.owner, ticket.listPrice) ? notes[body.tokenId] : undefined;
      // An older signed note never replaces a newer one for the same listing.
      if (old && old.at >= body.at) return { status: 200, json: { note: old } };
      // Editing the text keeps the time the listing was first posted: that is its age on the market.
      const note: ListingNote = { tokenId: body.tokenId, author: body.author, price: body.price, text, at: body.at, posted: old ? old.posted : body.at };
      notes[body.tokenId] = note;
      save();
      return { status: 200, json: { note } };
    }
    return no(404, 'Unknown');
  }

  let cursor = 0;
  /**
   * Background tidy-up: looks at a few stored notes per run and removes those whose listing is gone (sold, unlisted,
   * re-priced, refunded). A note is removed only if it is still the note that was looked up, so one written while
   * the chain was being asked is never lost.
   */
  async function sweep(max = 25): Promise<number> {
    const ids = Object.keys(notes);
    let removed = 0;
    for (let n = 0; n < Math.min(max, ids.length); n++) {
      const id = ids[(cursor + n) % ids.length];
      const before = notes[id];
      const ticket = await lookup(id);
      if (ticket === undefined || notes[id] !== before) continue;
      if (!ticket || !noteFits(before, ticket.owner, ticket.listPrice)) { delete notes[id]; removed++; }
    }
    cursor = ids.length ? (cursor + max) % ids.length : 0;
    if (removed) save();
    return removed;
  }

  return { handle, handles: (path: string) => PATHS.has(path), sweep };
}
