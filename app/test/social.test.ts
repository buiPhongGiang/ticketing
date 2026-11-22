import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocial, type SocialLimits } from '../scripts/social';
import { createLocalSigner } from '../src/lib';
import { cleanComment, COMMENT_MAX, guestName, httpSocial, socialMessage, type SocialClient } from '../src/lib/social';
import type { Address, Hex } from '../src/lib/types';

const scope = { chainId: 43113, contract: '0x6f5802cdeea534b66067607875e2e284fec93ef2' as Address };
const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const alice = createLocalSigner(key(11));
const bob = createLocalSigner(key(12));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The app's client wired straight to the backend: same JSON, no HTTP server. Alice and Bob hold tickets of events 1 and 3. */
function start(opts: { file?: string; limits?: Partial<SocialLimits>; holders?: Set<string> } = {}) {
  let t = 1_795_300_000_000;
  let ip = '203.0.113.1';
  const holders = opts.holders ?? new Set([`1:${alice.address}`, `1:${bob.address}`, `3:${alice.address}`, `3:${bob.address}`]);
  const asked: string[] = [];
  const social = createSocial({
    scope, now: () => t, eventExists: async (id) => Number(id) < 7, file: opts.file, limits: opts.limits,
    holdsTicket: async (eventId, account) => { asked.push(`${eventId}:${account}`); return holders.has(`${eventId}:${account}`); },
  });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const r = await social.handle(new URL(url, 'http://x').pathname.replace('/relay', ''), JSON.parse(String(init.body)), ip);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  }) as unknown as typeof fetch;
  const as = (signer: typeof alice, clock: () => number = () => t): SocialClient => httpSocial('/relay', signer, scope, clock, fetchImpl);
  return { social, as, holders, asked, tick: (ms: number) => { t += ms; }, now: () => t, from: (addr: string) => { ip = addr; } };
}
const signedComment = async (signer: typeof alice, eventId: string, at: number, text: string) =>
  ({ author: signer.address, eventId, at, text, signature: await signer.signMessage(socialMessage(scope, 'comment', eventId, at, text)) });
/** The other valid encoding of the same ECDSA signature: s → n − s, v flipped. */
const highS = (sig: Hex): Hex => {
  const r = sig.slice(2, 66), s = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
  return `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
};

test('comments are plain text: no control characters or angle brackets, blank runs collapsed, 280 characters at most', () => {
  expect(cleanComment('  Hẹn gặp ở cổng 3!  ')).toBe('Hẹn gặp ở cổng 3!');
  expect(cleanComment('<script>alert(1)</script> hi <b>x</b>')).toBe('scriptalert(1)/script hi bx/b');
  expect(cleanComment('a\u0000b\u0007c \t  d')).toBe('abc d');
  expect(cleanComment('a\n\n\n\n\nb')).toBe('a\n\nb');
  expect(cleanComment('x'.repeat(400))).toHaveLength(COMMENT_MAX);
  expect(cleanComment(' \n\t ')).toBe('');
  expect(guestName('0x9638F49A3cB7c002779724b427905F6Ab1D54bfa')).toBe('Khách 4BFA');
});

test('a like is counted once per account, shows as liked only to that account, and can be taken back', async () => {
  const { as, tick } = start();
  expect(await as(alice).feed(['1', '2'])).toEqual({ '1': { likes: 0, comments: 0, liked: false }, '2': { likes: 0, comments: 0, liked: false } });
  expect(await as(alice).like('1', true)).toEqual({ likes: 1, comments: 0, liked: true });
  tick(1000);
  expect(await as(alice).like('1', true)).toEqual({ likes: 1, comments: 0, liked: true });
  expect(await as(bob).like('1', true)).toEqual({ likes: 2, comments: 0, liked: true });
  expect((await as(bob).feed(['1']))['1']).toEqual({ likes: 2, comments: 0, liked: true });
  tick(1000);
  expect(await as(alice).like('1', false)).toEqual({ likes: 1, comments: 0, liked: false });
  expect((await as(alice).feed(['1', '2']))).toEqual({ '1': { likes: 1, comments: 0, liked: false }, '2': { likes: 0, comments: 0, liked: false } });
  // A like needs no ticket: event 2 has no holders here.
  expect(await as(alice).like('2', true)).toEqual({ likes: 1, comments: 0, liked: true });
});

test('comments: newest first, signed by the author, cleaned before signing; an empty one is refused on the device', async () => {
  const { as, tick } = start();
  const first = await as(alice).comment('1', '  Ai đi chung không? <3 ');
  expect(first).toMatchObject({ author: alice.address, text: 'Ai đi chung không? 3' });
  tick(5000);
  await as(bob).comment('1', 'Có mình!');
  const thread = await as(alice).comments('1');
  expect(thread.canComment).toBe(true);
  expect(thread.comments.map((c) => [c.author, c.text])).toEqual([[bob.address, 'Có mình!'], [alice.address, 'Ai đi chung không? 3']]);
  expect((await as(alice).feed(['1']))['1'].comments).toBe(2);
  expect(await as(alice).comments('2')).toEqual({ comments: [], canComment: false });
  await expect(as(alice).comment('1', '   ')).rejects.toMatchObject({ code: 'CommentEmpty' });
});

test('only an account with a ticket of the event can comment; free device keys without one cannot', async () => {
  const { as, holders, asked, tick } = start();
  const stranger = createLocalSigner(key(99));
  expect((await as(stranger).comments('1')).canComment).toBe(false);
  await expect(as(stranger).comment('1', 'spam')).rejects.toMatchObject({ code: 'NeedTicket' });
  // Alice holds tickets of events 1 and 3, not 2.
  await expect(as(alice).comment('2', 'không có vé')).rejects.toMatchObject({ code: 'NeedTicket' });
  expect((await as(alice).feed(['1', '2']))['2'].comments).toBe(0);
  // The chain's "no" is trusted for 30 seconds, so a flood of refused comments does not become a flood of RPC calls.
  const before = asked.length;
  for (let i = 0; i < 5; i++) await expect(as(stranger).comment('1', `spam ${i}`)).rejects.toMatchObject({ code: 'NeedTicket' });
  expect(asked.length).toBe(before);
  // Once the stranger buys a ticket the next check (after the 30 s) lets them in.
  holders.add(`1:${stranger.address}`);
  tick(31_000);
  expect(await as(stranger).comment('1', 'mới mua vé xong')).toMatchObject({ author: stranger.address });
  // Seen holding once: still allowed after the ticket is resold or refunded.
  holders.delete(`1:${stranger.address}`);
  tick(31_000);
  expect((await as(stranger).comments('1')).canComment).toBe(true);
});

test('nobody can write as someone else: a signature by another key, for another event, action or text is refused', async () => {
  const { social, now } = start();
  const at = Math.floor(now() / 1000);
  const body = async (signer: typeof alice, author: Address, action: 'like' | 'comment', eventId: string, text = '') =>
    ({ author, eventId, at, text, on: true, signature: await signer.signMessage(socialMessage(scope, action, eventId, at, text)) });
  expect((await social.handle('/social/like', await body(bob, alice.address, 'like', '1'))).status).toBe(401);
  expect((await social.handle('/social/like', { ...(await body(alice, alice.address, 'like', '1')), eventId: '2' })).status).toBe(401);
  expect((await social.handle('/social/comment', { ...(await body(alice, alice.address, 'comment', '1', 'hi')), text: 'bye' })).status).toBe(401);
  expect((await social.handle('/social/comment', await body(alice, alice.address, 'like', '1', 'hi'))).status).toBe(401);
  // Signed for another deployment: refused here.
  const other = { author: alice.address, eventId: '1', at, on: true, signature: await alice.signMessage(socialMessage({ ...scope, chainId: 1 }, 'like', '1', at)) };
  expect((await social.handle('/social/like', other)).status).toBe(401);
  expect((await social.handle('/social/like', await body(alice, alice.address, 'like', '1'))).status).toBe(200);
  expect((await social.handle('/social/feed', { eventIds: ['1'] })).json).toEqual({ events: { '1': { likes: 1, comments: 0, liked: false } } });
});

test('signature malleability: the high-s twin, a v of 0/1 and a compact signature are refused, so one signed comment is one comment', async () => {
  const { social, now } = start();
  const at = Math.floor(now() / 1000);
  const c = await signedComment(alice, '1', at, 'một lần');
  const twin = highS(c.signature);
  expect(twin).not.toBe(c.signature);
  expect((await social.handle('/social/comment', { ...c, signature: twin })).json).toEqual({ error: 'InvalidSignature' });
  expect((await social.handle('/social/comment', { ...c, signature: `${c.signature.slice(0, 130)}${c.signature.endsWith('1b') ? '00' : '01'}` })).json).toEqual({ error: 'InvalidSignature' });
  expect((await social.handle('/social/comment', { ...c, signature: c.signature.slice(0, 130) })).json).toEqual({ error: 'InvalidSignature' });
  expect((await social.handle('/social/comment', c)).status).toBe(200);
  // The same signed comment again returns the stored one; its id comes from the content, not from the signature bytes.
  const again = (await social.handle('/social/comment', c)).json as { comment: { id: string } };
  const list = ((await social.handle('/social/comments', { eventId: '1' })).json as { comments: { id: string }[] }).comments;
  expect(list).toHaveLength(1);
  expect(again.comment.id).toBe(list[0].id);
  // Another text under the same author, event and second is refused.
  expect((await social.handle('/social/comment', await signedComment(alice, '1', at, 'lần hai'))).status).toBe(409);
  expect((await social.handle('/social/comment', await signedComment(bob, '1', at, 'một lần'))).status).toBe(200);
  const ids = ((await social.handle('/social/comments', { eventId: '1' })).json as { comments: { id: string }[] }).comments.map((x) => x.id);
  expect(new Set(ids).size).toBe(2);
  // Likes take the canonical form only as well.
  const like = { author: alice.address, eventId: '1', at, on: true, signature: await alice.signMessage(socialMessage(scope, 'like', '1', at)) };
  expect((await social.handle('/social/like', { ...like, signature: highS(like.signature) })).status).toBe(401);
});

test('time window: a signature more than five minutes from the server clock, either way, is refused', async () => {
  const { social, as, now } = start();
  await expect(as(alice, () => now() - 301_000).like('1', true)).rejects.toMatchObject({ code: 'SignatureExpired' });
  await expect(as(alice, () => now() + 301_000).like('1', true)).rejects.toMatchObject({ code: 'SignatureExpired' });
  await expect(as(alice, () => now() - 301_000).comment('1', 'cũ')).rejects.toMatchObject({ code: 'SignatureExpired' });
  expect(await as(alice, () => now() - 299_000).like('1', true)).toMatchObject({ liked: true });
  const at = Math.floor(now() / 1000);
  expect((await social.handle('/social/like', { author: alice.address, eventId: '1', at: at + 0.5, on: true, signature: '0x' })).status).toBe(400);
});

test('refused before anything is stored: unknown events, HTML, over-long or empty text, malformed bodies', async () => {
  const { social, as, now } = start();
  await expect(as(alice).like('99', true)).rejects.toMatchObject({ code: 'BadEvent' });
  const at = Math.floor(now() / 1000);
  expect((await social.handle('/social/comment', await signedComment(alice, '1', at, '<img src=x onerror=alert(1)>'))).status).toBe(400);
  expect((await social.handle('/social/comment', await signedComment(alice, '1', at, 'x'.repeat(COMMENT_MAX + 1)))).status).toBe(400);
  expect((await social.handle('/social/comment', await signedComment(alice, '1', at, ''))).json).toEqual({ error: 'CommentEmpty' });
  expect((await social.handle('/social/like', { author: 'me', eventId: '1' })).status).toBe(400);
  expect((await social.handle('/social/comments', { eventId: 'x' })).status).toBe(400);
  expect((await as(alice).feed(['1']))['1']).toEqual({ likes: 0, comments: 0, liked: false });
});

test('limits that free device keys cannot dodge: per account, per client IP, per event and per-event totals', async () => {
  // Per account.
  const a = start({ limits: { commentsPer10Min: 2, likesPer10Min: 3 } });
  await a.as(alice).comment('1', 'một'); a.tick(1000);
  await a.as(alice).comment('1', 'hai'); a.tick(1000);
  await expect(a.as(alice).comment('1', 'ba')).rejects.toMatchObject({ code: 'RateLimited' });
  await a.as(bob).comment('1', 'bob vẫn viết được');
  a.tick(10 * 60_000);
  await a.as(alice).comment('1', 'ba');
  for (let i = 0; i < 3; i++) { a.tick(1000); await a.as(alice).like('1', i % 2 === 0); }
  a.tick(1000);
  await expect(a.as(alice).like('1', false)).rejects.toMatchObject({ code: 'RateLimited' });

  // Per client IP: fresh keys from one address share one allowance; another address is not affected.
  const many = Array.from({ length: 6 }, (_, i) => createLocalSigner(key(200 + i)));
  const b = start({ limits: { ipLikesPer10Min: 3, ipCommentsPer10Min: 2 }, holders: new Set(many.map((s) => `1:${s.address}`)) });
  for (const s of many.slice(0, 3)) await b.as(s).like('1', true);
  await expect(b.as(many[3]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  await b.as(many[0]).comment('1', 'a'); await b.as(many[1]).comment('1', 'b');
  await expect(b.as(many[2]).comment('1', 'c')).rejects.toMatchObject({ code: 'RateLimited' });
  b.from('203.0.113.77');
  expect(await b.as(many[3]).like('1', true)).toMatchObject({ likes: 4 });
  expect(await b.as(many[2]).comment('1', 'c')).toMatchObject({ text: 'c' });

  // Per event per hour, whoever writes and from wherever: comments have their own budget.
  const c = start({ limits: { eventCommentsPerHour: 2 } });
  await c.as(alice).comment('1', 'x'); await c.as(bob).comment('1', 'y');
  c.from('198.51.100.9'); c.tick(1000);
  await expect(c.as(bob).comment('1', 'z')).rejects.toMatchObject({ code: 'RateLimited' });
  expect(await c.as(bob).comment('3', 'sự kiện khác')).toMatchObject({ text: 'sự kiện khác' });
  c.tick(3_600_001);
  expect(await c.as(bob).comment('1', 'z')).toMatchObject({ text: 'z' });

  // Totals per event: distinct likers are capped; the comment list keeps the newest.
  const d = start({ limits: { likersPerEvent: 2, commentsPerEvent: 2 } });
  await d.as(alice).like('1', true); await d.as(bob).like('1', true);
  await expect(d.as(many[0]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  d.tick(1000);
  expect(await d.as(alice).like('1', false)).toMatchObject({ likes: 1 });
  expect(await d.as(many[0]).like('1', true)).toMatchObject({ likes: 2 });
  for (const text of ['1', '2', '3']) { d.tick(1000); await d.as(alice).comment('1', text); }
  expect((await d.as(alice).comments('1')).comments.map((x) => x.text)).toEqual(['3', '2']);
});

test('a replayed like cannot undo a newer take-back', async () => {
  const { social, now, tick } = start();
  const at = Math.floor(now() / 1000);
  const like = { author: alice.address, eventId: '1', at, on: true, signature: await alice.signMessage(socialMessage(scope, 'like', '1', at)) };
  await social.handle('/social/like', like);
  tick(5000);
  const later = at + 5;
  await social.handle('/social/like', { author: alice.address, eventId: '1', at: later, on: false, signature: await alice.signMessage(socialMessage(scope, 'unlike', '1', later)) });
  expect((await social.handle('/social/like', like)).json).toEqual({ event: { likes: 0, comments: 0, liked: false } });
});

test('likes, comments and who was seen holding a ticket survive a restart in the JSON file', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'vegoc-social-')), 'social.json');
  const a = start({ file });
  await a.as(alice).like('3', true);
  await a.as(bob).comment('3', 'Hẹn gặp ở cổng!');
  expect(JSON.parse(readFileSync(file, 'utf8')).comments['3'][0].text).toBe('Hẹn gặp ở cổng!');
  const b = start({ file, holders: new Set() });
  expect((await b.as(alice).feed(['3']))['3']).toEqual({ likes: 1, comments: 1, liked: true });
  const thread = await b.as(bob).comments('3');
  expect(thread.comments[0]).toMatchObject({ author: bob.address, text: 'Hẹn gặp ở cổng!' });
  expect(thread.canComment).toBe(true);
});

test('like spam cannot block a ticket holder\'s comment: likes and comments have separate event budgets', async () => {
  const crowd = Array.from({ length: 8 }, (_, i) => createLocalSigner(key(300 + i)));
  const { as, from, tick } = start({ limits: { eventNewLikersPerHour: 3, eventCommentsPerHour: 2, ipLikesPer10Min: 1000, likesPer10Min: 1000 } });
  // Ticketless keys from many addresses use up the event's whole like budget for the hour...
  for (let i = 0; i < 3; i++) { from(`198.51.100.${40 + i}`); await as(crowd[i]).like('1', true); }
  from('198.51.100.60');
  await expect(as(crowd[3]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  // ...and one of them toggles its like over and over: that is not charged to the event at all.
  from('198.51.100.40');
  for (let i = 0; i < 20; i++) { tick(1000); await as(crowd[0]).like('1', i % 2 === 1); }
  // ...and they hammer the comment route, where they are refused before any budget is touched.
  for (const s of crowd.slice(0, 6)) await expect(as(s).comment('1', 'spam')).rejects.toMatchObject({ code: 'NeedTicket' });
  // The holders still comment, up to the comment budget, which only holders can spend.
  from('203.0.113.5');
  expect(await as(alice).comment('1', 'vẫn bình luận được')).toMatchObject({ text: 'vẫn bình luận được' });
  expect(await as(bob).comment('1', 'mình cũng vậy')).toMatchObject({ text: 'mình cũng vậy' });
  tick(1000);
  await expect(as(alice).comment('1', 'quá giới hạn giờ này')).rejects.toMatchObject({ code: 'RateLimited' });
  // A holder who already likes the event can still take the like back and give it again; a new liker waits for the next hour.
  expect((await as(alice).feed(['1']))['1']).toEqual({ likes: 3, comments: 2, liked: false });
  await expect(as(alice).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  tick(3_600_001);
  expect(await as(alice).like('1', true)).toMatchObject({ likes: 4, liked: true });
});

test('unlike-then-like still charges the new-liker budget; phantom unlikes store nothing', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'vegoc-social-')), 'social.json');
  const crowd = Array.from({ length: 4 }, (_, i) => createLocalSigner(key(400 + i)));
  const { as, tick } = start({ file, limits: { eventNewLikersPerHour: 2 } });
  // Accounts that never liked send an unlike first: nothing changes, nothing is written.
  for (const s of crowd) expect(await as(s).like('1', false)).toEqual({ likes: 0, comments: 0, liked: false });
  expect(() => readFileSync(file, 'utf8')).toThrow();
  tick(1000);
  // Their likes are then charged like anyone's: two fit the hour, the third does not.
  expect(await as(crowd[0]).like('1', true)).toMatchObject({ likes: 1 });
  expect(await as(crowd[1]).like('1', true)).toMatchObject({ likes: 2 });
  await expect(as(crowd[2]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  expect(Object.keys(stored.likes['1'])).toHaveLength(2);
  expect(stored.unlikes['1'] ?? {}).toEqual({});
  // A real take-back is remembered (so an older like cannot return) and re-liking within the hour is not charged twice.
  tick(1000);
  expect(await as(crowd[0]).like('1', false)).toMatchObject({ likes: 1 });
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).unlikes['1'])).toEqual([crowd[0].address.toLowerCase()]);
  tick(1000);
  expect(await as(crowd[0]).like('1', true)).toMatchObject({ likes: 2 });
  await expect(as(crowd[3]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
  // After the hour the budget is there again, and a returning account is charged like a new one.
  tick(3_600_001);
  expect(await as(crowd[0]).like('1', false)).toMatchObject({ likes: 1 });
  tick(1000);
  expect(await as(crowd[0]).like('1', true)).toMatchObject({ likes: 2 });
  expect(await as(crowd[2]).like('1', true)).toMatchObject({ likes: 3 });
  await expect(as(crowd[3]).like('1', true)).rejects.toMatchObject({ code: 'RateLimited' });
});
