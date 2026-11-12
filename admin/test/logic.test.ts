import { expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { ticketsCsv } from '../src/csv';
import { revenueOf, scannerCandidates, type IndexedEvent } from '../src/events';
import { filterTickets } from '../src/filter';
import { buildLoginMessage, LoginError, SESSION_MS, verifySession, type LoginContext, type Session } from '../src/login';
import { verifyMessage } from 'viem';

const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ctx: LoginContext = { host: 'admin.test', chainId: 31337, contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' };
const NOW = 1_800_000_000_000;
const verifier = { verifyMessage: (a: Parameters<typeof verifyMessage>[0]) => verifyMessage(a), getOrganizer: async () => owner.address };

async function sessionOf(account = owner, c = ctx): Promise<Session> {
  const message = buildLoginMessage(account.address, c, 'nonce-1', NOW);
  return { address: account.address, message, signature: await account.signMessage({ message }), expiresAt: NOW + SESSION_MS };
}
const reason = (p: Promise<void>) => p.then(() => 'ok', (e: LoginError) => e.reason);

test('the owner with a fresh signature is let in', async () => {
  expect(await reason(verifySession(await sessionOf(), ctx, verifier, NOW))).toBe('ok');
});
test('a wallet that is not the owner is refused even with a valid signature', async () => {
  expect(await reason(verifySession(await sessionOf(other), ctx, verifier, NOW))).toBe('NotOrganizer');
});
test('a signature from another wallet cannot claim the owner address', async () => {
  const forged = { ...(await sessionOf(other)), address: owner.address };
  expect(await reason(verifySession(forged, ctx, verifier, NOW))).toBe('BadSignature');
});
test('an edited message no longer matches its signature', async () => {
  const s = await sessionOf();
  expect(await reason(verifySession({ ...s, message: s.message.replace('nonce-1', 'nonce-2') }, ctx, verifier, NOW))).toBe('BadSignature');
});
test('an expired session is refused', async () => {
  expect(await reason(verifySession(await sessionOf(), ctx, verifier, NOW + SESSION_MS))).toBe('Expired');
});
test('a login for another contract does not carry over', async () => {
  const s = await sessionOf();
  expect(await reason(verifySession(s, { ...ctx, contract: '0x0000000000000000000000000000000000000001' }, verifier, NOW))).toBe('WrongContract');
});
test('ownership moving away ends the session', async () => {
  expect(await reason(verifySession(await sessionOf(), ctx, { ...verifier, getOrganizer: async () => other.address }, NOW))).toBe('NotOrganizer');
});

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const A = owner.address, B = other.address;
const ev = (o: Partial<IndexedEvent>): IndexedEvent => ({ id: Math.random().toString(), name: 'Transfer', block: 1n, logIndex: 0, hash: '0x00', timestamp: 1, ...o });
const mint = (paid: boolean) => ev({ from: ZERO, to: A, paid, tokenId: '0' });

test('revenue counts only paid mints and derives what was withdrawn', () => {
  const r = revenueOf({ complete: true, events: [mint(true), mint(true), mint(false), ev({ from: A, to: B })] }, 100n, 50n)!;
  expect(r).toEqual({ sold: 2, free: 1, collectedWei: 200n, withdrawnWei: 150n, balanceWei: 50n });
});
test('revenue is unavailable until the whole history has been read', () => {
  expect(revenueOf({ complete: false, events: [mint(true)] }, 100n, 50n)).toBeNull();
});
test('a balance above what sales explain never produces a negative withdrawal', () => {
  expect(revenueOf({ complete: true, events: [] }, 100n, 50n)!.withdrawnWei).toBe(0n);
});
test('scanner candidates are distinct wallets from ScannerSet only', () => {
  const list = scannerCandidates([ev({ name: 'ScannerSet', scanner: A, allowed: true }), ev({ name: 'ScannerSet', scanner: A, allowed: false }), ev({ name: 'ScannerSet', scanner: B, allowed: true }), ev({ from: A, to: B })]);
  expect(list).toEqual([A, B]);
});

const tickets = [{ tokenId: '0', owner: A, checkedIn: true }, { tokenId: '1', owner: B, checkedIn: false }, { tokenId: '10', owner: B, checkedIn: true }];
const ids = (l: typeof tickets) => l.map((t) => t.tokenId);
test('search matches an exact ticket number, with or without #', () => {
  expect(ids(filterTickets(tickets, '1', 'all'))).toEqual(['1']);
  expect(ids(filterTickets(tickets, '#10', 'all'))).toEqual(['10']);
});
test('search matches part of a wallet address in any letter case', () => {
  expect(ids(filterTickets(tickets, B.slice(0, 8).toUpperCase().replace('0X', '0x'), 'all'))).toEqual(['1', '10']);
});
test('search matches the last characters of a wallet without 0x', () => {
  expect(ids(filterTickets(tickets, B.slice(-4).toUpperCase(), 'all'))).toEqual(['1', '10']);
});
test('status filter combines with search', () => {
  expect(ids(filterTickets(tickets, '', 'entered'))).toEqual(['0', '10']);
  expect(ids(filterTickets(tickets, B, 'waiting'))).toEqual(['1']);
  expect(filterTickets(tickets, 'no match', 'all')).toEqual([]);
});
test('csv has a header, entry details, and neutralises spreadsheet formulas', () => {
  const csv = ticketsCsv(tickets, [ev({ name: 'CheckedIn', tokenId: '0', holder: A, scanner: B, timestamp: 1_700_000_000 })]);
  const lines = csv.split('\r\n');
  expect(lines[0]).toBe('Ticket,Holder,Status,Checked in at,Checked by');
  expect(lines[1]).toBe(`0,${A},Checked in,2023-11-14T22:13:20.000Z,${B}`);
  expect(lines[2]).toBe(`1,${B},Not yet,,`);
  expect(ticketsCsv([{ tokenId: '=1+1', owner: A, checkedIn: false }], []).split('\r\n')[1].startsWith("'=1+1,")).toBe(true);
});
