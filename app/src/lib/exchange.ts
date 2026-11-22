// The one thing the ticket market keeps off chain: a seller's short note on their own listing. The relayer stores
// it in a file; it is never presented as on-chain. Prices, tickets, the queue and who gets a ticket are the
// contract's. A note is signed by the device key (EIP-191) and counts only while the chain shows its author
// holding that ticket, listed at that price.
//
// Shared by the app and the relayer; nothing here needs Node.
import { ServiceError, type Address, type Hex, type LocalSigner } from './types';

export const NOTE_MAX = 140;
/** A signed note is accepted for five minutes around the server's clock. */
export const EXCHANGE_WINDOW_S = 300;

export interface ExchangeScope { chainId: number; contract: Address }

/** What the device key signs. The second line keeps it apart from the like/comment messages: neither can be replayed as the other. */
export function noteMessage(scope: ExchangeScope, tokenId: string, price: string, at: number, text: string): string {
  return ['Vé Gốc', 'chợ vé', `network ${scope.chainId}`, `contract ${scope.contract.toLowerCase()}`, `note ticket ${tokenId} price ${price}`, `at ${at}`, text].join('\n');
}

/**
 * Plain text only, in one Unicode form (NFKC). Dropped: format characters and everything a reader cannot see
 * (zero-width and direction controls, variation selectors, tags), control characters, angle brackets. Runs of blank
 * space collapse.
 */
export function cleanText(raw: string, max: number): string {
  const text = raw.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/[\u0000-\u0008\u000B-\u001F\u007F<>]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Cut by whole characters, so the cap never leaves half of one behind.
  return [...text].slice(0, max).join('').trim();
}

/** A seller's note on one listing. */
export interface ListingNote {
  tokenId: string; author: Address; price: string; text: string;
  /** When this text was signed (unix seconds). */
  at: number;
  /** When the seller first posted for this listing (same seller, same price): the listing's age as the market shows it. */
  posted: number;
}

/** A note counts only for the listing it was written for: same holder, same price, as the chain shows them now. */
export const noteFits = (note: ListingNote | undefined, owner: string, listPrice: string): note is ListingNote =>
  !!note && listPrice !== '0' && note.author.toLowerCase() === owner.toLowerCase() && note.price === listPrice;

export interface ExchangeClient {
  /** Notes for the listings on screen, by ticket id. */
  notes(tokenIds: string[]): Promise<Record<string, ListingNote>>;
  /** Signs and stores the note for this device's own listing. An empty text only records when the listing went up. */
  setNote(tokenId: string, price: string, text: string): Promise<ListingNote>;
}

const errorCodes = new Set<string>(['RateLimited', 'SignatureExpired', 'InvalidSignature', 'NotListed', 'NotHolder', 'PriceChanged', 'Network', 'Unknown']);

export function httpExchange(url: string, signer: LocalSigner, scope: ExchangeScope, now: () => number = Date.now, fetchImpl: typeof fetch = fetch): ExchangeClient {
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/exchange/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new ServiceError('Network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new ServiceError(errorCodes.has(json.error) ? json.error : 'Unknown');
    return json;
  };
  return {
    notes: async (tokenIds) => {
      const ids = [...new Set(tokenIds)].slice(0, 100);
      return ids.length ? (await post('notes', { tokenIds: ids })).notes : {};
    },
    setNote: async (tokenId, price, text) => {
      const clean = cleanText(text, NOTE_MAX);
      const at = Math.floor(now() / 1000);
      const signature: Hex = await signer.signMessage(noteMessage(scope, tokenId, price, at, clean));
      return (await post('note', { author: signer.address, tokenId, price, text: clean, at, signature })).note;
    },
  };
}

/** Nobody picks a name here: every account shows as "Khách 4BFA", from the end of its id. */
export const accountTag = (account: string) => account.slice(-4).toUpperCase();
export const guestLabel = (account: string) => `Khách ${accountTag(account)}`;
