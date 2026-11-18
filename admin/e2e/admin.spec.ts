import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, usdcAbi } from '../../app/src/lib/abi';
import { BOX, RPC, USDC } from '../playwright.config';
import { connect, KEYS } from './deploy';

const ORGANIZER = privateKeyToAccount(KEYS.organizer);
const GUEST = privateKeyToAccount(KEYS.guest);
const GUEST2 = privateKeyToAccount(KEYS.guest2);
const GATE = privateKeyToAccount(KEYS.gate);
type Account = typeof ORGANIZER;
const { client, walletOf } = connect(RPC);

/** A stand-in for a browser wallet: real signatures and real transactions on anvil, driven from the test. */
async function installWallet(page: Page, start: Account = ORGANIZER) {
  const w = { account: start, rejectNext: false };
  await page.exposeFunction('__wallet', async (method: string, params: any[] = []) => {
    if (w.rejectNext && (method === 'personal_sign' || method === 'eth_sendTransaction')) {
      w.rejectNext = false;
      return { error: { code: 4001, message: 'User rejected the request.' } };
    }
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return { result: [w.account.address] };
    if (method === 'personal_sign') return { result: await w.account.signMessage({ message: { raw: params[0] as Hex } }) };
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      return { result: await walletOf(w.account).sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n }) };
    }
    const res = await fetch(RPC, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), headers: { 'content-type': 'application/json' } });
    return await res.json();
  });
  await page.addInitScript(() => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    (window as any).__emit = (name: string, v: unknown) => (listeners[name] ?? []).forEach((l) => l(v));
    (window as any).ethereum = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const r = await (window as any).__wallet(method, params ?? []);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
      on(name: string, l: (...a: unknown[]) => void) { (listeners[name] ??= []).push(l); },
      removeListener(name: string, l: (...a: unknown[]) => void) { listeners[name] = (listeners[name] ?? []).filter((x) => x !== l); },
    };
  });
  return w;
}

const t = (page: Page, id: string) => page.getByTestId(id);
async function signIn(page: Page, path = '/') {
  await page.goto('/');
  await t(page, 'login').click();
  await expect(t(page, 'me')).toBeVisible();
  if (path !== '/') await page.goto(path);
}

async function write(account: Account, functionName: string, args: unknown[], address: Address = BOX, contractAbi: unknown = abi) {
  const r = await client.waitForTransactionReceipt({ hash: await walletOf(account).writeContract({ address, abi: contractAbi, functionName, args } as never) });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
}
const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: BOX, abi, functionName, args } as never) as Promise<any>;
const usdcOf = (a: Address) => client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const chainNow = async () => Number((await client.getBlock()).timestamp);

async function createEvent(name: string, { account = ORGANIZER, endsIn = 7200, prices = [20_000000n, 50_000000n], supplies = [10, 4] } = {}) {
  const now = await chainNow();
  const id = Number(await read('eventCount'));
  await write(account, 'createEvent', [name, 'Test Hall', BigInt(now + 60), BigInt(now + endsIn), 0, ['GA', 'VIP'], prices, supplies]);
  return id;
}
async function faucet(account: Account) {
  // The faucet has a one-hour cooldown per wallet; skip when the wallet already holds enough.
  if ((await usdcOf(account.address)) < 200_000000n) await write(account, 'faucet', [], USDC, usdcAbi);
}
async function buy(account: Account, eventId: number, tier: number, qty: number) {
  await faucet(account);
  const ev = await read('getEvent', [BigInt(eventId)]);
  await write(account, 'approve', [BOX, ev.tiers[tier].price * BigInt(qty)], USDC, usdcAbi);
  await write(account, 'buy', [BigInt(eventId), BigInt(tier), BigInt(qty)]);
}

test('no wallet in the browser says what to do', async ({ page }) => {
  await page.goto('/');
  await expect(t(page, 'no-wallet')).toContainText('MetaMask');
  await expect(t(page, 'me')).toHaveCount(0);
});

test('refusing to sign leaves you logged out', async ({ page }) => {
  const w = await installWallet(page);
  await page.goto('/');
  w.rejectNext = true;
  await t(page, 'login').click();
  await expect(t(page, 'login-error')).toContainText('Rejected');
  await expect(t(page, 'me')).toHaveCount(0);
});

test('any wallet signs in, survives a reload, and is out after logout or an account switch', async ({ page }) => {
  const w = await installWallet(page, GUEST);
  await signIn(page);
  await expect(t(page, 'no-events')).toBeVisible();
  await page.reload();
  await expect(t(page, 'me')).toBeVisible();
  await t(page, 'logout').click();
  await expect(t(page, 'login')).toBeVisible();
  await page.reload();
  await expect(t(page, 'login')).toBeVisible();

  await t(page, 'login').click();
  await expect(t(page, 'me')).toBeVisible();
  await page.evaluate(() => (window as any).__emit('accountsChanged', []));
  await expect(t(page, 'login')).toBeVisible();
  await t(page, 'login').click();
  await expect(t(page, 'me')).toBeVisible();
  w.account = GUEST2;
  await page.reload();
  await expect(t(page, 'login')).toBeVisible();
});

test('creates an event from the form, then opens it', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  await t(page, 'new-event').click();
  await t(page, 'create').click();
  await expect(page.getByText('Required').first()).toBeVisible();
  await t(page, 'f-name').fill('Form Fest');
  await t(page, 'f-venue').fill('District 1');
  await t(page, 'f-hours').fill('5');
  await t(page, 'tier-price-0').fill('12.5');
  await t(page, 'add-tier').click();
  await t(page, 'tier-name-1').fill('VIP');
  await t(page, 'tier-price-1').fill('40');
  await t(page, 'tier-supply-1').fill('8');
  await expect(t(page, 'preview')).toContainText('FORM FEST', { ignoreCase: true });
  const id = Number(await read('eventCount'));
  await t(page, 'create').click();
  await expect(page).toHaveURL(new RegExp(`#/e/${id}$`));
  await expect(t(page, 'event-name')).toHaveText('Form Fest');
  const ev = await read('getEvent', [BigInt(id)]);
  expect(ev.data.organizer).toBe(ORGANIZER.address);
  expect(ev.data.endsAt - ev.data.startsAt).toBe(5n * 3600n);
  expect(ev.tiers.map((x: any) => [x.name, x.price, x.supply])).toEqual([['GA', 12_500000n, 100], ['VIP', 40_000000n, 8]]);
  await t(page, 'back').click();
  await expect(t(page, `event-card-${id}`)).toContainText('Live');
});

test('home shows only the signed-in organizer\'s events', async ({ page }) => {
  const mineId = await createEvent('Mine');
  const theirs = await createEvent('Theirs', { account: GUEST });
  await installWallet(page);
  await signIn(page);
  await expect(t(page, `event-card-${mineId}`)).toContainText('0 / 14 issued');
  await expect(t(page, `event-card-${theirs}`)).toHaveCount(0);
  await page.goto(`/#/e/${theirs}`);
  await expect(t(page, 'not-yours')).toBeVisible();
});

test('issues comps after a confirm step, and the wall shows them', async ({ page }) => {
  const id = await createEvent('Comps');
  await installWallet(page);
  await signIn(page, `/#/e/${id}/money`);
  await t(page, 'issue-to').fill('nope');
  await t(page, 'issue-submit').click();
  await expect(page.getByText('Not a wallet address')).toBeVisible();
  await t(page, 'issue-to').fill(GUEST.address);
  await t(page, 'issue-tier').selectOption('1');
  await t(page, 'issue-qty').fill('2');
  const before: bigint = await read('totalMinted');
  await t(page, 'issue-submit').click();
  await t(page, 'issue-no').click();
  expect(await read('totalMinted')).toBe(before);
  await t(page, 'issue-submit').click();
  await expect(t(page, 'issue-confirm')).toContainText('2 × VIP');
  await t(page, 'issue-yes').click();
  await expect(t(page, 'tx-done')).toContainText('Issued 2 × VIP');
  expect(await read('totalMinted')).toBe(before + 2n);
  expect(await read('ownerOf', [before])).toBe(GUEST.address);
  await t(page, 'tab-overview').click();
  await expect(t(page, `cell-${before}`)).toBeVisible();
  await expect(t(page, 'issued')).toHaveText('2');
});

test('rejecting or waiting on a transaction reads honestly', async ({ page }) => {
  const id = await createEvent('Pending');
  const w = await installWallet(page);
  await signIn(page, `/#/e/${id}/gate`);
  w.rejectNext = true;
  await t(page, 'scanner-address').fill(GATE.address);
  await t(page, 'scanner-add').click();
  await expect(t(page, 'tx-failed')).toContainText('Rejected in wallet');
  expect(await read('isScanner', [BigInt(id), GATE.address])).toBe(false);

  await client.request({ method: 'evm_setAutomine' as never, params: [false] as never });
  try {
    await t(page, 'scanner-add').click();
    await expect(t(page, 'tx-pending')).toBeVisible();
    await expect(t(page, 'tx-done')).toHaveCount(0);
    await client.request({ method: 'evm_mine' as never });
    await expect(t(page, 'tx-done')).toBeVisible();
  } finally {
    await client.request({ method: 'evm_setAutomine' as never, params: [true] as never });
  }
});

test('grants and revokes gate staff per event, and the chain agrees', async ({ page }) => {
  const id = await createEvent('Gate');
  await installWallet(page);
  await signIn(page, `/#/e/${id}/gate`);
  await expect(t(page, 'no-scanners')).toBeVisible();
  await t(page, 'scanner-address').fill('xyz');
  await t(page, 'scanner-add').click();
  await expect(page.getByText('Not a wallet address')).toBeVisible();
  await t(page, 'scanner-address').fill(GATE.address);
  await t(page, 'scanner-add').click();
  await expect(t(page, 'tx-done')).toContainText('Gate access granted');
  expect(await read('isScanner', [BigInt(id), GATE.address])).toBe(true);
  await expect(t(page, `scanner-${GATE.address}`)).toBeVisible();

  await t(page, `revoke-${GATE.address}`).click();
  await expect(t(page, 'tx-done')).toContainText('Access revoked');
  expect(await read('isScanner', [BigInt(id), GATE.address])).toBe(false);
  await expect(t(page, `scanner-${GATE.address}`)).toHaveCount(0);
});

test('sales show up in float, tickets and activity; tickets filter and export', async ({ page }) => {
  const id = await createEvent('Sales');
  await buy(GUEST, id, 0, 2);
  await buy(GUEST2, id, 1, 1);
  const first = Number(await read('totalMinted')) - 3;
  await installWallet(page);
  await signIn(page, `/#/e/${id}`);
  await expect(t(page, 'issued')).toHaveText('3');
  await expect(t(page, 'principal')).toHaveText('90.00 USDC');
  await expect(t(page, 'activity')).toContainText('2 × GA · 40.00 USDC');
  await expect(t(page, 'n-valid')).toHaveText('3');

  await t(page, 'tab-tickets').click();
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(3);
  await t(page, 'search').fill(`#${first + 2}`);
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(1);
  await expect(t(page, `row-${first + 2}`)).toContainText('VIP');
  await t(page, 'search').fill('');
  await t(page, 'filter-refunded').click();
  await expect(t(page, 'no-result')).toBeVisible();
  await t(page, 'filter-valid').click();
  const [download] = await Promise.all([page.waitForEvent('download'), t(page, 'export').click()]);
  expect(download.suggestedFilename()).toBe(`event-${id}-tickets-valid.csv`);
  const csv = readFileSync(await download.path(), 'utf8').replace('﻿', '').split('\r\n');
  expect(csv[0]).toBe('Ticket,Tier,Holder,Status,Paid USDC,Face USDC,Listed USDC');
  expect(csv).toContain(`${first},GA,${GUEST.address},Valid,20.00,20.00,`);
  expect(csv).toHaveLength(4);
});

test('cancel, then refund all holders: every buyer gets the money back', async ({ page }) => {
  const id = await createEvent('Cancel me');
  await faucet(GUEST);
  await faucet(GUEST2);
  const g1 = await usdcOf(GUEST.address), g2 = await usdcOf(GUEST2.address);
  await buy(GUEST, id, 0, 2);
  await buy(GUEST2, id, 1, 1);
  await write(ORGANIZER, 'issue', [BigInt(id), 0n, GATE.address, 1n]); // a comp: not refunded
  expect(await usdcOf(GUEST.address)).toBe(g1 - 40_000000n);

  await installWallet(page);
  await signIn(page, `/#/e/${id}/money`);
  await expect(t(page, 'float')).toHaveText('90.00 USDC');
  await t(page, 'cancel').click();
  await t(page, 'cancel-no').click();
  expect((await read('getEvent', [BigInt(id)])).data.cancelled).toBe(false);
  await t(page, 'cancel').click();
  await t(page, 'cancel-yes').click();
  await expect(t(page, 'tx-done')).toContainText('Event cancelled');
  await expect(t(page, 'refund-count')).toHaveText('3');
  await expect(t(page, 'refund-owed')).toHaveText('90.00 USDC');
  await t(page, 'refund-all').click();
  await t(page, 'refund-yes').click();
  await expect(t(page, 'refund-panel').getByTestId('tx-done')).toContainText('Refunded 3 tickets · 90.00 USDC');

  expect(await usdcOf(GUEST.address)).toBe(g1);
  expect(await usdcOf(GUEST2.address)).toBe(g2);
  await expect(t(page, 'float')).toHaveText('0.00 USDC');
  await expect(t(page, 'refunded')).toHaveText('90.00 USDC');
  await expect(t(page, 'refund-count')).toHaveText('0');
  await t(page, 'tab-overview').click();
  await expect(t(page, 'status-badge').first()).toHaveText('Cancelled');
  await expect(t(page, 'n-refunded')).toHaveText('3');
  await t(page, 'tab-tickets').click();
  await t(page, 'filter-refunded').click();
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(3);
});

test('losing the network keeps the last numbers and says so', async ({ page }) => {
  const id = await createEvent('Offline');
  await installWallet(page);
  await signIn(page, `/#/e/${id}`);
  await expect(t(page, 'issued')).toHaveText('0');
  await page.route(`${RPC}/**`, (r) => r.abort());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(t(page, 'stale')).toContainText('Cannot reach the network', { timeout: 40_000 });
  await expect(t(page, 'issued')).toHaveText('0');
  await page.unroute(`${RPC}/**`);
  await t(page, 'refresh').click();
  await expect(t(page, 'stale')).toHaveCount(0);
});

// Moves the chain clock forward, so it runs last.
test('settle opens after the end and pays principal plus mock yield', async ({ page }) => {
  const id = await createEvent('Settle', { endsIn: 900 });
  await buy(GUEST, id, 0, 3);
  await installWallet(page);
  await signIn(page, `/#/e/${id}/money`);
  await expect(t(page, 'settle')).toBeDisabled();

  await client.request({ method: 'evm_increaseTime' as never, params: [3600] as never });
  await client.request({ method: 'evm_mine' as never });
  const before = await usdcOf(ORGANIZER.address);
  await page.reload();
  await expect(t(page, 'settle')).toBeEnabled();
  await t(page, 'settle').click();
  await expect(t(page, 'settle-confirm')).toContainText('USDC');
  await t(page, 'settle-yes').click();
  await expect(t(page, 'settle-panel').getByTestId('tx-done')).toContainText('Settled · 60.00 USDC +');
  const gained = (await usdcOf(ORGANIZER.address)) - before;
  expect(gained).toBeGreaterThan(60_000000n);
  expect(gained).toBeLessThan(60_010000n);
  await expect(t(page, 'settled-principal')).toHaveText('60.00 USDC');
  await expect(t(page, 'settle')).toBeDisabled();
  await t(page, 'tab-overview').click();
  await expect(t(page, 'status-badge').first()).toHaveText('Settled');
});
