// Links that open one screen of the web app: /#/e/3 (event), /#/l/12 (resale listing), /#/u/0x… (a seller's page),
// /#/cho-ve (the market, /#/cho-ve/3 for one event). The part after # never reaches a server.
import { Platform } from 'react-native';
import type { Route } from './app-context';

export type LinkTarget = { kind: 'event'; id: string } | { kind: 'listing'; id: string } | { kind: 'user'; id: string } | { kind: 'market'; id?: string };

export function linkHash(t: LinkTarget): string {
  if (t.kind === 'market') return t.id ? `#/cho-ve/${t.id}` : '#/cho-ve';
  return `#/${{ event: 'e', listing: 'l', user: 'u' }[t.kind]}/${t.id}`;
}

/** The screens a link opens, with the tab it belongs to underneath so Back lands somewhere sensible. Null: not a link. */
export function routesFor(hash: string): Route[] | null {
  const market = /^#\/cho-ve(?:\/(\d{1,9}))?\/?$/.exec(hash);
  if (market) return [{ name: 'market', eventId: market[1] }];
  const m = /^#\/([elu])\/([0-9a-zA-Z]{1,42})$/.exec(hash);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === 'e' && /^\d{1,9}$/.test(id)) return [{ name: 'events' }, { name: 'event', eventId: id }];
  if (kind === 'l' && /^\d{1,9}$/.test(id)) return [{ name: 'market' }, { name: 'listing', tokenId: id }];
  if (kind === 'u' && /^0x[0-9a-fA-F]{40}$/.test(id)) return [{ name: 'market' }, { name: 'user', account: id }];
  return null;
}

/** The link the page was opened with, on the web. */
export function openedLink(): Route[] | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return routesFor(window.location.hash);
}

/** A full link to share, on the web; null in the phone app, which has no address to link to. */
export function linkUrl(t: LinkTarget): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return `${window.location.origin}${window.location.pathname}${linkHash(t)}`;
}
