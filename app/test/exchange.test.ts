import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExchange, exchangeRoute, ipBucket, type ExchangeChain, type ExchangeLimits, type ListedTicket } from '../scripts/exchange';
import { createRelayServer, defaultLimits } from '../scripts/relay-server';
import { createLocalSigner } from '../src/lib';
import { cleanText, guestLabel, httpExchange, NOTE_MAX, noteFits, noteMessage, type ExchangeClient } from '../src/lib/exchange';
import { socialMessage } from '../src/lib/social';
import { carry, diffSnapshots, merge, snapshotOf, type Snapshot } from '../src/lib/notices';
import type { Address, Hex, Ticket } from '../src/lib/types';

const scope = { chainId: 43113, contract: '0x6f5802cdeea534b66067607875e2e284fec93ef2' as Address };
const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const alice = createLocalSigner(key(21)); // holds ticket 5 of event 1, listed
const bob = createLocalSigner(key(22)); // a buyer
const carol = createLocalSigner(key(23)); // holds ticket 6 of event 1, not listed
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const highS = (sig: Hex): Hex => {
  const r = sig.slice(2, 66), s = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
  return `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
};

/** The app's client wired straight to the backend: same JSON, no HTTP server. The chain is a small table. */
function start(opts: { file?: string; limits?: Partial<ExchangeLimits> } = {}) {
  let t = 1_795_300_000_000;
  let ip = '203.0.113.1';
  const tickets: Record<string, ListedTicket> = {
    '5': { owner: alice.address, listPrice: '27500000', eventId: '1' },
    '6': { owner: carol.address, listPrice: '0', eventId: '1' },
  };
  const asked: string[] = [];
  let down = false;
  let onRead: ((id: string) => unknown) | undefined;
  const chain: ExchangeChain = {
    ticket: async (id) => {
      asked.push(id);
      if (down) throw new Error('rpc down');
      const answer = tickets[id] ? { ...tickets[id] } : null;
      await onRead?.(id);
      return answer;
    },
  };
  const exchange = createExchange({ scope, chain, now: () => t, file: opts.file, limits: opts.limits });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const r = await exchange.handle(new URL(url, 'http://x').pathname.replace('/relay', ''), JSON.parse(String(init.body)), ip);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  }) as unknown as typeof fetch;
  const as = (signer: typeof alice): ExchangeClient => httpExchange('/relay', signer, scope, () => t, fetchImpl);
  return {
    exchange, as, tickets, asked, tick: (ms: number) => { t += ms; }, sec: () => Math.floor(t / 1000), from: (a: string) => { ip = a; },
    rpc: (up: boolean) => { down = !up; }, duringRead: (fn?: (id: string) => unknown) => { onRead = fn; },
  };
}
const signed = async (signer: typeof alice, tokenId: string, price: string, at: number, text: string) =>
  ({ author: signer.address, tokenId, price, at, text, signature: await signer.signMessage(noteMessage(scope, tokenId, price, at, text)) });

test('a note is plain text: one Unicode form, nothing invisible, no control characters or angle brackets, capped by whole characters', () => {
  expect(cleanText('  Bán gấp <b>vé</b>\u0007 đẹp  ', NOTE_MAX)).toBe('Bán gấp bvé/b đẹp');
  // Zero-width and direction controls, the byte-order mark, a soft hyphen, variation selectors, tag characters.
  expect(cleanText('gi​á ⁦tốt⁩‮﻿­️\u{E0041}', NOTE_MAX)).toBe('giá tốt');
  expect(cleanText('ＶＩＰ', NOTE_MAX)).toBe('VIP');
  expect(cleanText('a\n\n\n\n\nb \t c', NOTE_MAX)).toBe('a\n\nb c');
  expect([...cleanText('🎫'.repeat(200), NOTE_MAX)]).toHaveLength(NOTE_MAX);
  expect(cleanText(' \n​ ', NOTE_MAX)).toBe('');
  expect(guestLabel('0x9638F49A3cB7c002779724b427905F6Ab1D54bfa')).toBe('Khách 4BFA');
});

test('a note is taken only from the holder the chain shows, while the ticket is listed at the signed price', async () => {
  const { as, tickets, tick } = start();
  const note = await as(alice).setNote('5', '27500000', 'Bận đột xuất, giao vé ngay');
  expect(note).toMatchObject({ tokenId: '5', author: alice.address, price: '27500000', text: 'Bận đột xuất, giao vé ngay' });
  expect(note.posted).toBe(note.at);
  expect(await as(bob).notes(['5', '6', '99', '5'])).toEqual({ '5': note });
  await expect(as(bob).setNote('5', '27500000', 'của tôi')).rejects.toMatchObject({ code: 'NotHolder' });
  await expect(as(alice).setNote('5', '25000000', 'giá khác')).rejects.toMatchObject({ code: 'PriceChanged' });
  await expect(as(carol).setNote('6', '27500000', 'chưa rao')).rejects.toMatchObject({ code: 'NotListed' });
  await expect(as(alice).setNote('99', '27500000', 'không có vé')).rejects.toMatchObject({ code: 'NotHolder' });
  // Editing keeps the time the listing was first posted; a new price is a new listing.
  tick(60_000);
  const edited = await as(alice).setNote('5', '27500000', 'Còn vé');
  expect(edited).toMatchObject({ text: 'Còn vé', posted: note.at });
  tickets['5'].listPrice = '25000000';
  tick(60_000);
  const relisted = await as(alice).setNote('5', '25000000', '');
  expect(relisted.posted).toBe(relisted.at);
  expect(relisted.posted).toBeGreaterThan(note.at);
});

test('a signature is refused when forged, expired, re-encoded, or made for a like or comment', async () => {
  const { exchange, sec, as } = start();
  const at = sec();
  const body = await signed(alice, '5', '27500000', at, 'ok');
  expect((await exchange.handle('/exchange/note', { ...body, author: bob.address })).json).toEqual({ error: 'InvalidSignature' });
  expect((await exchange.handle('/exchange/note', { ...body, text: 'khác' })).json).toEqual({ error: 'InvalidSignature' });
  expect((await exchange.handle('/exchange/note', { ...body, price: '1' })).json).toEqual({ error: 'InvalidSignature' });
  expect((await exchange.handle('/exchange/note', { ...body, signature: highS(body.signature) })).json).toEqual({ error: 'InvalidSignature' });
  expect((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at - 301, 'ok'))).json).toEqual({ error: 'SignatureExpired' });
  expect((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at + 301, 'ok'))).json).toEqual({ error: 'SignatureExpired' });
  // A comment signature (social.ts) is not a note.
  expect((await exchange.handle('/exchange/note', { ...body, signature: await alice.signMessage(socialMessage(scope, 'comment', '1', at, 'ok')) })).json).toEqual({ error: 'InvalidSignature' });
  // Text that is not already clean, or too long, is refused before anything else is looked at.
  expect((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at, '<b>x</b>'))).status).toBe(400);
  expect((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at, 'x​y'))).status).toBe(400);
  expect((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at, 'x'.repeat(141)))).status).toBe(400);
  expect(await as(bob).notes(['5'])).toEqual({});
  expect((await exchange.handle('/exchange/note', body)).status).toBe(200);
  // An older signed note does not replace a newer one.
  const newer = await as(alice).setNote('5', '27500000', 'mới');
  expect(newer.at).toBe(at);
  expect(((await exchange.handle('/exchange/note', await signed(alice, '5', '27500000', at - 10, 'cũ'))).json as { note: { text: string } }).note.text).toBe('ok');
});

test('a note is served only while the chain shows its author holding the ticket at that price; a read removes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-exchange-'));
  const file = join(dir, 'exchange.json');
  const { as, tickets, tick } = start({ file });
  const note = await as(alice).setNote('5', '27500000', 'Vé đẹp');
  // The client applies the same rule to what it is given.
  expect(noteFits(note, alice.address, '27500000')).toBe(true);
  expect(noteFits(note, bob.address, '27500000')).toBe(false);
  expect(noteFits(note, alice.address, '25000000')).toBe(false);
  expect(noteFits(note, alice.address, '0')).toBe(false);
  expect(noteFits(undefined, alice.address, '27500000')).toBe(false);
  // Relisted at another price: the old note is not served. The read leaves the file alone.
  tickets['5'].listPrice = '25000000';
  tick(16_000);
  expect(await as(bob).notes(['5'])).toEqual({});
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).notes)).toEqual(['5']);
  // Back at the first price, still Alice's: it is the same listing again, and her note fits it.
  tickets['5'].listPrice = '27500000';
  tick(16_000);
  expect(await as(bob).notes(['5'])).toEqual({ '5': note });
  // Sold: the buyer lists it at the same price. The previous holder's note does not come with it.
  tickets['5'].owner = bob.address;
  tick(16_000);
  expect(await as(carol).notes(['5'])).toEqual({});
  const mine = await as(bob).setNote('5', '27500000', '');
  expect(mine.posted).toBe(mine.at);
  expect(await as(carol).notes(['5'])).toEqual({ '5': mine });
  // Unlisted: nothing is served.
  tickets['5'].listPrice = '0';
  tick(16_000);
  expect(await as(carol).notes(['5'])).toEqual({});
});

test('a read asks the chain little: each id once, only ids with a note, answers and misses cached, a cap per request', async () => {
  const a = start({ limits: { lookupsPerRead: 2, notesPer10Min: 50, ipNotesPer10Min: 50 } });
  for (const id of ['10', '11', '12']) { a.tickets[id] = { owner: alice.address, listPrice: '27500000', eventId: '1' }; await a.as(alice).setNote(id, '27500000', `vé ${id}`); }
  a.tick(16_000);
  a.asked.length = 0;
  // No note stored for 6, 7 or 99: the chain is not asked about them at all.
  expect(await a.as(bob).notes(['6', '7', '99'])).toEqual({});
  expect(a.asked).toEqual([]);
  // Three notes, a cap of two lookups: two are answered now, the third by the next read. Duplicates count once.
  const first = await a.as(bob).notes(['10', '10', '11', '12', '12']);
  expect(Object.keys(first).sort()).toEqual(['10', '11']);
  expect(a.asked.sort()).toEqual(['10', '11']);
  expect(Object.keys(await a.as(bob).notes(['10', '11', '12'])).sort()).toEqual(['10', '11', '12']);
  expect(a.asked.sort()).toEqual(['10', '11', '12']);
  // Within the cache time nothing more is asked, whoever reads.
  for (let i = 0; i < 5; i++) await a.as(carol).notes(['10', '11', '12']);
  expect(a.asked).toHaveLength(3);
  // "No such ticket" is remembered too.
  delete a.tickets['12'];
  a.tick(16_000);
  a.asked.length = 0;
  expect(Object.keys(await a.as(bob).notes(['12']))).toEqual([]);
  expect(Object.keys(await a.as(bob).notes(['12']))).toEqual([]);
  expect(a.asked).toEqual(['12']);
  // The chain not answering: nothing is served rather than something stale, and it is not asked again at once.
  a.tick(16_000);
  a.rpc(false);
  a.asked.length = 0;
  expect(await a.as(bob).notes(['10'])).toEqual({});
  expect(await a.as(bob).notes(['10'])).toEqual({});
  expect(a.asked).toEqual(['10']);
  a.rpc(true);
  a.tick(6000);
  expect(Object.keys(await a.as(bob).notes(['10']))).toEqual(['10']);
});

test('the sweep removes notes whose listing is gone, and never a note written while it was looking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-exchange-'));
  const file = join(dir, 'exchange.json');
  const a = start({ file });
  a.tickets['10'] = { owner: alice.address, listPrice: '27500000', eventId: '1' };
  await a.as(alice).setNote('5', '27500000', 'năm');
  await a.as(alice).setNote('10', '27500000', 'mười');
  expect(await a.exchange.sweep()).toBe(0);
  // Ticket 5 is sold and listed again by Bob at the same price; ticket 10 is unlisted.
  a.tickets['5'].owner = bob.address;
  a.tickets['10'].listPrice = '0';
  a.tick(16_000);
  // While the sweep is asking the chain about ticket 5, Bob writes his own note for it.
  // The sweep's answer from the chain is held back until that write is stored.
  let wrote = false;
  a.duringRead(async (id) => { if (id === '5' && !wrote) { wrote = true; await a.as(bob).setNote('5', '27500000', 'của Bob'); } });
  expect(await a.exchange.sweep()).toBe(1);
  a.duringRead(undefined);
  expect(wrote).toBe(true);
  const stored = JSON.parse(readFileSync(file, 'utf8')).notes;
  expect(Object.keys(stored)).toEqual(['5']);
  expect(stored['5']).toMatchObject({ author: bob.address, text: 'của Bob' });
  expect((await a.as(carol).notes(['5']))['5'].text).toBe('của Bob');
  // The chain not answering removes nothing.
  a.tickets['5'].listPrice = '0';
  a.tick(16_000);
  a.rpc(false);
  expect(await a.exchange.sweep()).toBe(0);
  a.rpc(true);
  a.tick(6000);
  expect(await a.exchange.sweep()).toBe(1);
  expect(JSON.parse(readFileSync(file, 'utf8')).notes).toEqual({});
});

test('limits hold per account and per client address, an IPv6 /64 counting as one; the file survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-exchange-'));
  const file = join(dir, 'exchange.json');
  const a = start({ file, limits: { notesPer10Min: 2, ipNotesPer10Min: 3 } });
  a.tickets['7'] = { owner: bob.address, listPrice: '1000000', eventId: '1' };
  a.tickets['8'] = { owner: carol.address, listPrice: '1000000', eventId: '1' };
  a.from('2001:db8:1:2:aaaa::1');
  await a.as(alice).setNote('5', '27500000', 'một');
  a.tick(1000);
  await a.as(alice).setNote('5', '27500000', 'hai');
  a.tick(1000);
  await expect(a.as(alice).setNote('5', '27500000', 'ba')).rejects.toMatchObject({ code: 'RateLimited' });
  // Another address in the same /64 is the same client: its third write is the last one.
  a.from('2001:db8:1:2:bbbb::9');
  await a.as(bob).setNote('7', '1000000', 'của Bob');
  await expect(a.as(carol).setNote('8', '1000000', 'của Carol')).rejects.toMatchObject({ code: 'RateLimited' });
  a.from('2001:db8:1:3::9');
  expect((await a.as(carol).setNote('8', '1000000', 'của Carol')).text).toBe('của Carol');
  // A refused write from a stranger costs the chain nothing once that account's own limit is used up.
  a.asked.length = 0;
  for (let i = 0; i < 4; i++) { a.tick(1000); await a.as(alice).setNote('5', '27500000', `lần ${i}`).catch(() => {}); }
  expect(a.asked).toEqual([]);
  const stored = readFileSync(file, 'utf8');
  expect(stored).not.toMatch(/signature/);
  const b = start({ file });
  b.tickets['7'] = { owner: bob.address, listPrice: '1000000', eventId: '1' };
  expect((await b.as(alice).notes(['5', '7']))['7'].text).toBe('của Bob');
});

test('an IPv6 address is counted by its /64, an IPv4 address as it is', () => {
  expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  expect(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  expect(ipBucket('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
  expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(ipBucket('::1')).toBe('0:0:0:0::/64');
  expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  expect(ipBucket('unknown')).toBe('unknown');
});

test('the relay server counts note reads and writes per client address and logs no body', async () => {
  expect(exchangeRoute('/exchange/notes')).toBe('read');
  expect(exchangeRoute('/exchange/note')).toBe('write');
  expect(exchangeRoute('/exchange/other')).toBe(null);
  const { exchange, sec } = start();
  const lines: string[] = [];
  const server = createRelayServer({
    backend: { balance: async () => 10n ** 18n, handle: (path, body, extra) => exchange.handle(path, body, extra?.ip) },
    limits: { ...defaultLimits, ipPerMin: 2 }, log: (l) => lines.push(l),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const body = await signed(alice, '5', '27500000', sec(), 'bí mật 123');
    expect((await post('/exchange/note', body)).status).toBe(200);
    expect((await post('/exchange/notes', { tokenIds: ['5'] })).status).toBe(200);
    expect((await post('/exchange/note', body)).status).toBe(200);
    expect((await post('/exchange/note', body)).status).toBe(429);
    expect((await post('/exchange/notes', { tokenIds: ['5'] })).status).toBe(200);
    expect((await post('/exchange/wants', {})).status).toBe(429);
    expect(lines.join('\n')).not.toMatch(/bí mật|0x[0-9a-f]{130}/);
    expect(lines[0]).toMatch(/\/exchange\/note 200$/);
  } finally { server.close(); }
});

const ticket = (tokenId: string, status: Ticket['status'], extra: Partial<Ticket> = {}): Ticket => ({
  tokenId, eventId: '1', tier: 0, tierName: 'A', owner: alice.address, paid: '25000000', face: '25000000', cap: '27500000', listPrice: status === 'listed' ? '27500000' : '0',
  checkedIn: false, status, event: { id: '1', name: 'Show', venue: 'V', startsAt: 0, endsAt: 0, cancelled: false, refundOpen: false, status: 'onsale' }, ...extra,
});
const wait = (position: number) => [{ eventId: '1', states: [{ tier: 0, waiting: 3, position, deposit: '27500000', cap: '27500000' }] }];

test('notifications come from what changed on chain between two looks', () => {
  const first = snapshotOf([ticket('5', 'listed'), ticket('6', 'available')], wait(0));
  expect(diffSnapshots(first, first, 1)).toEqual([]);
  // The listed ticket is someone else's now: sold, at the price it was listed for.
  const sold = snapshotOf([ticket('5', 'sold'), ticket('6', 'available')], wait(0));
  expect(diffSnapshots(first, sold, 7)).toEqual([{ id: 'sold:5', kind: 'sold', at: 7, read: false, eventId: '1', tokenId: '5', amount: '27500000' }]);
  // In line, then a ticket of that tier appears and the place is gone: it arrived.
  const waiting: Snapshot = snapshotOf([], wait(1));
  const arrived = snapshotOf([ticket('9', 'available')], wait(0));
  expect(diffSnapshots(waiting, arrived, 8).map((n) => n.id)).toEqual(['arrived:9']);
  // A ticket bought the ordinary way is not news.
  expect(diffSnapshots(snapshotOf([], wait(0)), arrived, 8)).toEqual([]);
  // The show is cancelled: the refund is on offer. A free ticket has nothing to refund.
  const cancelled = snapshotOf([ticket('6', 'refundable'), ticket('7', 'refundable', { paid: '0' })], wait(0));
  expect(diffSnapshots(snapshotOf([ticket('6', 'available'), ticket('7', 'available', { paid: '0' })], wait(0)), cancelled, 9)).toEqual([{ id: 'refund:6', kind: 'refund', at: 9, read: false, eventId: '1', tokenId: '6', amount: '25000000' }]);
  // While an action is confirming nothing is said; the last settled state is carried so the change is seen after.
  const pending = snapshotOf([ticket('5', 'pending'), ticket('6', 'available')], wait(0));
  expect(diffSnapshots(first, pending, 10)).toEqual([]);
  expect(diffSnapshots(carry(first, pending), sold, 11).map((n) => n.id)).toEqual(['sold:5']);
});

test('the notice list keeps each notice once, newest first', () => {
  const sold = { id: 'sold:5', kind: 'sold' as const, at: 60_000, read: false, eventId: '1', tokenId: '5' };
  const refund = { id: 'refund:6', kind: 'refund' as const, at: 50_000, read: false, eventId: '1', tokenId: '6' };
  let state = merge({ items: [] }, [refund]);
  state = merge(state, [refund, sold]);
  expect(state.items.map((i) => i.id)).toEqual(['sold:5', 'refund:6']);
});
