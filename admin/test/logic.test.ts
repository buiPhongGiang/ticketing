import { describe, expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage, type Address } from 'viem';
import { failureText } from '../src/errors';
import { ago, eventDate, parseUsdc, percentOf, short, timeRange, usdc, usdcNumber } from '../src/format';
import { buildLoginMessage, LoginError, SESSION_MS, verifySession, type LoginContext, type Session } from '../src/login';
import {
  buildEventArgs, capOf, chunk, countBy, eventStatus, feeOf, filterRows, mine, projectYield, quorumOf, refundableIds, resaleStats, settleState, ticketRows, ticketsCsv, toEventInfo, wallCells,
  type EventDraft, type EventInfo, type RawEventView, type Ticket, type TierInfo,
} from '../src/model';

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const tiers: TierInfo[] = [{ name: 'GA', price: 25_000000n, supply: 6, sold: 3 }, { name: 'VIP', price: 60_000000n, supply: 2, sold: 1 }];
const ev = (patch: Partial<EventInfo> = {}): EventInfo => ({
  id: 0, organizer: A, name: 'Neon', venue: 'Hall', startsAt: 1000, endsAt: 2000, maxPerWallet: 4, cancelled: false, settled: false,
  issued: 4, checkedIn: 1, refunded: 0, resales: 0, sales: 0n, resaleVolume: 0n, resaleFaceVolume: 0n, tiers, principal: 0n, yieldAccrued: 0n, listed: 0,
  settleAt: 2000, refundOpen: false, quorumMet: true, paidSold: 4, paidCheckedIn: 1, ...patch,
});
const ticket = (tokenId: number, patch: Partial<Ticket> = {}): Ticket => ({ tokenId, eventId: 0, tier: 0, owner: A, paid: 25_000000n, face: 25_000000n, cap: 27_500000n, listPrice: 0n, checkedIn: false, ...patch });

describe('format', () => {
  test('USDC amounts have two decimals, grouping and the unit', () => {
    expect(usdc(1_234_500000n)).toBe('1,234.50 USDC');
    expect(usdc(0n)).toBe('0.00 USDC');
    expect(usdcNumber(5n)).toBe('0.00');
    expect(usdcNumber(5_000n)).toBe('0.01');
    expect(usdcNumber(123_456n, 6)).toBe('0.123456');
  });
  test('parses typed prices into 6-decimal units', () => {
    expect(parseUsdc('25')).toBe(25_000000n);
    expect(parseUsdc('12,5')).toBe(12_500000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('1.0000001')).toBeNull();
    expect(parseUsdc('-1')).toBeNull();
    expect(parseUsdc('abc')).toBeNull();
  });
  test('short forms', () => {
    expect(short(A)).toBe('0x7099…79C8');
    expect(ago(100, 130)).toBe('30s');
    expect(ago(0, 7200)).toBe('2h');
    expect(percentOf(110n, 100n)).toBe(110);
    expect(percentOf(1n, 0n)).toBeNull();
    const start = new Date(2026, 10, 21, 19, 0).getTime() / 1000;
    expect(eventDate(start)).toBe('Sat 21 Nov · 19:00');
    expect(timeRange(start, start + 6 * 3600)).toBe('19:00–01:00 +1d');
  });
});

describe('errors', () => {
  test('custom errors become short phrases, found anywhere in the cause chain', () => {
    expect(failureText({ shortMessage: 'reverted', cause: { data: { errorName: 'EventNotEnded' } } })).toBe('Event has not ended yet.');
    expect(failureText({ cause: { cause: { errorName: 'NotOrganizer' } } })).toBe('Not the organizer of this event.');
    expect(failureText({ data: { errorName: 'SoldOut' } })).toBe('Not enough tickets left.');
  });
  test('wallet rejection, gas, network, unknown', () => {
    expect(failureText({ code: 4001 })).toBe('Rejected in wallet.');
    expect(failureText(new Error('insufficient funds for gas'))).toBe('Not enough gas funds.');
    expect(failureText(new Error('HTTP request failed'))).toBe('Cannot reach the network.');
    expect(failureText({ shortMessage: 'Execution reverted for an unknown reason.' })).toBe('Reverted on chain.');
    expect(failureText(42)).toBe('Transaction failed.');
  });
});

describe('events', () => {
  test('decodes the getEvents struct and keeps only the organizer\'s events', () => {
    const raw: RawEventView = {
      id: 3n, principal: 10n, yieldAccrued: 1n, listed: 2n, settleAt: 2000n, refundOpen: false, quorumMet: true, paidSold: 5n, paidCheckedIn: 1n,
      data: { organizer: A, startsAt: 1000n, endsAt: 2000n, maxPerWallet: 4, cancelled: false, settled: false, issued: 5, checkedIn: 1, refunded: 0, resales: 1, sales: 50n, resaleVolume: 11n, resaleFaceVolume: 10n, name: 'N', venue: 'V' },
      tiers: [{ name: 'GA', price: 10n, supply: 9, sold: 5 }],
    };
    const e = toEventInfo(raw);
    expect(e).toMatchObject({ id: 3, startsAt: 1000, endsAt: 2000, listed: 2, settleAt: 2000, quorumMet: true, paidSold: 5, paidCheckedIn: 1, tiers: [{ name: 'GA', price: 10n, supply: 9, sold: 5 }] });
    expect(mine([e, { ...e, id: 4, organizer: B }], A.toLowerCase()).map((x) => x.id)).toEqual([3]);
  });
  test('status: cancelled and settled win, then the end time and the gate quorum decide', () => {
    expect(eventStatus(ev(), 1999)).toBe('live');
    expect(eventStatus(ev(), 2000)).toBe('ended'); // 1 of 4 paid tickets scanned = 25 %
    expect(eventStatus(ev({ paidSold: 6, paidCheckedIn: 1 }), 1999)).toBe('live');
    expect(eventStatus(ev({ paidSold: 6, paidCheckedIn: 1 }), 2000)).toBe('noshow'); // 16.7 %
    expect(eventStatus(ev({ paidSold: 5, paidCheckedIn: 1 }), 2000)).toBe('ended'); // exactly 20 %
    expect(eventStatus(ev({ paidSold: 0, paidCheckedIn: 0 }), 2000)).toBe('ended'); // comps only: nothing to refund
    expect(quorumOf({ paidSold: 100, paidCheckedIn: 19 })).toBe(false);
    expect(quorumOf({ paidSold: 100, paidCheckedIn: 20 })).toBe(true);
    expect(eventStatus(ev({ settled: true }), 2500)).toBe('settled');
    expect(eventStatus(ev({ cancelled: true }), 1500)).toBe('cancelled');
  });
});

describe('tickets and wall', () => {
  const live = [ticket(4, { checkedIn: true }), ticket(1), ticket(7, { listPrice: 27_000000n }), ticket(9, { tier: 1, paid: 0n, face: 60_000000n })];
  const rows = ticketRows(live, [{ tokenId: 2, holder: B, amount: 25_000000n, tier: 0 }], tiers);

  test('rows are sorted, with status from check-in, listing and refunds', () => {
    expect(rows.map((r) => [r.tokenId, r.status])).toEqual([[1, 'valid'], [2, 'refunded'], [4, 'checked'], [7, 'listed'], [9, 'valid']]);
    expect(countBy(rows)).toEqual({ valid: 2, checked: 1, listed: 1, refunded: 1 });
  });
  test('wall: one cell per ticket, refunded placeholders, dashed cells up to supply', () => {
    const { cells, hidden } = wallCells(rows, ev({ issued: 6, refunded: 2 }));
    expect(cells.map((c) => c.kind)).toEqual(['valid', 'refunded', 'checked', 'listed', 'valid', 'refunded', 'empty', 'empty']);
    expect(hidden).toBe(0);
    const capped = wallCells(rows, ev({ issued: 6, refunded: 2 }), 5);
    expect(capped.cells).toHaveLength(5);
    expect(capped.hidden).toBe(3);
  });
  test('search by number or address piece, filter by status', () => {
    expect(filterRows(rows, '#7', 'all').map((r) => r.tokenId)).toEqual([7]);
    expect(filterRows(rows, '93bc', 'all').map((r) => r.tokenId)).toEqual([2]);
    expect(filterRows(rows, '', 'refunded').map((r) => r.tokenId)).toEqual([2]);
    expect(filterRows(rows, '7', 'checked')).toEqual([]);
  });
  test('refund ids skip comps', () => {
    expect(refundableIds(live)).toEqual([1, 4, 7]);
    // After a no-show a scanned ticket has no claim: its holder was let in.
    expect(refundableIds(live.map((t) => (t.tokenId === 4 ? { ...t, checkedIn: true } : t)), false)).toEqual([1, 7]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  test('CSV has a header, plain amounts and defuses formulas', () => {
    const csv = ticketsCsv([...rows, { tokenId: 10, tier: 0, owner: '=HYPERLINK("x")' as Address, paid: 0n, face: 1_234_000000n, listPrice: 0n, status: 'valid' }], tiers);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Ticket,Tier,Holder,Status,Paid USDC,Face USDC,Listed USDC');
    expect(lines[1]).toBe(`1,GA,${A},Valid,25.00,25.00,`);
    expect(lines[4]).toBe(`7,GA,${A},Listed,25.00,25.00,27.00`);
    expect(lines[6]).toBe(`10,GA,"'=HYPERLINK(""x"")",Valid,0.00,1234.00,`);
  });
});

describe('money', () => {
  test('resale stats and cap', () => {
    expect(resaleStats(ev({ resales: 2, resaleVolume: 55_000000n, resaleFaceVolume: 50_000000n, listed: 1 }))).toEqual({ count: 2, volume: 55_000000n, avgPctOfFace: 110, listed: 1 });
    expect(resaleStats(ev()).avgPctOfFace).toBeNull();
    expect(capOf(25_000000n)).toBe(27_500000n);
  });
  test('yield ticks at 5 % APR like the vault', () => {
    const year = 365 * 24 * 3600 * 1000;
    expect(projectYield(0n, 1_000_000000n, year)).toBe(50_000000n);
    expect(projectYield(7n, 1_000_000000n, 0)).toBe(7n);
    expect(projectYield(7n, 1_000_000000n, -5)).toBe(7n);
    expect(projectYield(7n, 1_000_000000n, year, true)).toBe(7n); // frozen at cancel
  });
  test('settle: waits for the end, pays principal + yield once, only yield after a cancel', () => {
    const e = ev({ principal: 100n, yieldAccrued: 3n });
    expect(settleState(e, 1999)).toEqual({ kind: 'wait', opensAt: 2000, dispute: false });
    expect(settleState(e, 2000)).toEqual({ kind: 'settle', principal: 100n, yield: 3n });
    // Below the quorum the contract reports settleAt = endsAt + 48 h: the float stays locked until then.
    const noShow = { ...e, settleAt: 2000 + 48 * 3600 };
    expect(settleState(noShow, 2000)).toEqual({ kind: 'wait', opensAt: 174_800, dispute: true });
    expect(settleState(noShow, 174_800)).toEqual({ kind: 'settle', principal: 100n, yield: 3n });
    expect(feeOf(100_000000n, 300)).toBe(3_000000n);
    expect(feeOf(100_000000n, 0)).toBe(0n);
    expect(settleState({ ...e, settled: true }, 3000)).toEqual({ kind: 'done' });
    expect(settleState({ ...e, cancelled: true }, 1500)).toEqual({ kind: 'yield', yield: 3n });
    expect(settleState({ ...e, cancelled: true, yieldAccrued: 0n }, 1500)).toEqual({ kind: 'done' });
  });
});

describe('new event form', () => {
  const now = 1_800_000_000;
  const start = new Date((now + 86_400) * 1000);
  const local = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}T19:00`;
  const draft: EventDraft = { name: ' Neon ', venue: 'Hall', start: local, hours: '4', maxPerWallet: '4', tiers: [{ name: 'GA', price: '25', supply: '100' }, { name: 'VIP', price: '60.5', supply: '10' }] };
  test('builds createEvent arguments', () => {
    const { args, errors } = buildEventArgs(draft, now, parseUsdc);
    expect(errors).toEqual({});
    expect(args!.name).toBe('Neon');
    expect(args!.endsAt - args!.startsAt).toBe(14_400n);
    expect(args!.prices).toEqual([25_000000n, 60_500000n]);
    expect(args!.supplies).toEqual([100, 10]);
    expect(args!.maxPerWallet).toBe(4);
  });
  test('reports each problem', () => {
    const { args, errors } = buildEventArgs({ ...draft, name: '', hours: '0', maxPerWallet: '-1', tiers: [{ name: 'GA', price: 'x', supply: '1' }, { name: '', price: '1', supply: '1' }, { name: 'C', price: '1', supply: '0' }] }, now, parseUsdc);
    expect(args).toBeUndefined();
    expect(errors).toMatchObject({ name: 'Required', hours: '0–336 h', maxPerWallet: '0–1000', tierRows: { 0: 'Price in USDC', 1: 'Name required', 2: 'Supply 1–100000' } });
    expect(buildEventArgs({ ...draft, tiers: [] }, now, parseUsdc).errors.tiers).toBe('1–4 tiers');
    expect(buildEventArgs(draft, now + 10 * 86_400, parseUsdc).errors.start).toBe('Ends in the past');
  });
});

describe('login', () => {
  const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const ctx: LoginContext = { host: 'admin.test', chainId: 31337, contract: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' };
  const NOW = 1_800_000_000_000;
  const verifier = { verifyMessage: (a: Parameters<typeof verifyMessage>[0]) => verifyMessage(a) };
  async function sessionOf(account = owner): Promise<Session> {
    const message = buildLoginMessage(account.address, ctx, 'nonce-1', NOW);
    return { address: account.address, message, signature: await account.signMessage({ message }), expiresAt: NOW + SESSION_MS };
  }
  const reason = (p: Promise<void>) => p.then(() => 'ok', (e: LoginError) => e.reason);

  test('any wallet with a fresh signature gets in', async () => {
    expect(await reason(verifySession(await sessionOf(), ctx, verifier, NOW))).toBe('ok');
    expect(await reason(verifySession(await sessionOf(other), ctx, verifier, NOW))).toBe('ok');
  });
  test('a signature from another wallet cannot claim an address', async () => {
    const forged = { ...(await sessionOf(other)), address: owner.address };
    expect(await reason(verifySession(forged, ctx, verifier, NOW))).toBe('BadSignature');
  });
  test('an edited message no longer matches its signature', async () => {
    const s = await sessionOf();
    expect(await reason(verifySession({ ...s, message: s.message.replace('nonce-1', 'nonce-2') }, ctx, verifier, NOW))).toBe('BadSignature');
  });
  test('expired, or for another contract or network', async () => {
    const s = await sessionOf();
    expect(await reason(verifySession(s, ctx, verifier, NOW + SESSION_MS))).toBe('Expired');
    expect(await reason(verifySession(s, { ...ctx, contract: '0x0000000000000000000000000000000000000001' }, verifier, NOW))).toBe('WrongContract');
    expect(await reason(verifySession(s, { ...ctx, chainId: 43113 }, verifier, NOW))).toBe('WrongContract');
  });
  test('the message names the wallet, network, contract and expiry', () => {
    const m = buildLoginMessage(owner.address, ctx, 'n', NOW);
    expect(m).toContain(`Wallet: ${owner.address}`);
    expect(m).toContain('Network: 31337');
    expect(m).toContain(`Contract: ${ctx.contract}`);
    expect(m).toContain(`Expires: ${new Date(NOW + SESSION_MS).toISOString()}`);
  });
});

import { approvedSignatures, isOwner, nextSafeStep, type SafeInfo } from '../src/safe';
import { organizes } from '../src/model';

describe('Safe organizer', () => {
  const O1 = '0xA52C09A9F0E0Dc256a2454934782468880226FB2' as Address;
  const O2 = '0x1319357D45c24a94cC3B4166EA77F9C44b297A21' as Address;
  const O3 = '0x442B1585802d8c6Ad597820bbC9E715fBDA6980e' as Address;
  const SAFE = '0x96aDD8A7c64d93818cc71eb6E97Db478a091bc41' as Address;
  const safe: SafeInfo = { address: SAFE, owners: [O1, O2, O3], threshold: 2 };
  const safes = { [SAFE.toLowerCase()]: safe };

  test('an owner of the organizing Safe sees and runs its events; a stranger does not', () => {
    const e = ev({ organizer: SAFE });
    expect(organizes(e, O2.toLowerCase(), safes)).toBe(true);
    expect(organizes(e, A, safes)).toBe(false);
    expect(organizes(ev({ organizer: A }), A, safes)).toBe(true);
    expect(mine([e, ev({ id: 1, organizer: A }), ev({ id: 2, organizer: B })], O1, safes).map((x) => x.id)).toEqual([0]);
    expect(isOwner(safe, O3.toLowerCase())).toBe(true);
    expect(isOwner(undefined, O3)).toBe(false);
  });
  test('2 of 3: the first owner approves, a second executes, a repeat visit waits', () => {
    expect(nextSafeStep(safe, O1, [])).toEqual({ kind: 'approve', have: 0 });
    expect(nextSafeStep(safe, O1, [O1])).toEqual({ kind: 'waiting', have: 1 });
    expect(nextSafeStep(safe, O2, [O1])).toEqual({ kind: 'execute', with: [O1] });
    expect(nextSafeStep(safe, O3, [O1, O2])).toEqual({ kind: 'execute', with: [O1] });
    expect(nextSafeStep({ ...safe, threshold: 3 }, O2, [O1])).toEqual({ kind: 'approve', have: 1 });
  });
  test('approved-hash signatures: 65 bytes per owner, sorted by address, v = 1', () => {
    const sig = approvedSignatures([O1, O2]).toLowerCase();
    expect(sig.length).toBe(2 + 2 * 65 * 2);
    // 0x1319… sorts before 0xA52C…
    expect(sig.slice(2, 66)).toBe(`000000000000000000000000${O2.slice(2).toLowerCase()}`);
    expect(sig.slice(66, 130)).toBe('0'.repeat(64));
    expect(sig.slice(130, 132)).toBe('01');
    expect(sig.slice(132, 196)).toBe(`000000000000000000000000${O1.slice(2).toLowerCase()}`);
    expect(sig.slice(-2)).toBe('01');
  });
});
