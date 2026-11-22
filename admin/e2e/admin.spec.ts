import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, usdcAbi, vaultAbi } from '../../app/src/lib/abi';
import { BOX, RPC, USDC, VAULT } from '../playwright.config';
import { connect, KEYS, TREASURY } from './deploy';

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

test('no wallet in the browser: the console opens read-only and says what a wallet is for', async ({ page }) => {
  await page.goto('/');
  await expect(t(page, 'no-wallet')).toContainText('MetaMask');
  await expect(t(page, 'read-only')).toBeVisible();
  await expect(t(page, 'home-readonly')).toBeVisible();
  await expect(t(page, 'me')).toHaveCount(0);
});

test('refusing to sign leaves you logged out', async ({ page }) => {
  const w = await installWallet(page);
  await page.goto('/');
  w.rejectNext = true;
  await t(page, 'login').click();
  await expect(t(page, 'login-error')).toContainText('từ chối');
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
  await expect(page.getByText('Chưa nhập').first()).toBeVisible();
  await t(page, 'f-name').fill('Form Fest');
  await t(page, 'f-venue').fill('District 1');
  await t(page, 'f-hours').fill('5');
  await t(page, 'tier-price-0').fill('325000');
  await t(page, 'add-tier').click();
  await t(page, 'tier-name-1').fill('VIP');
  await t(page, 'tier-price-1').fill('1040000');
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
  await expect(t(page, `event-card-${id}`)).toContainText('Đang bán');
});

test('home shows only the signed-in organizer\'s events', async ({ page }) => {
  const mineId = await createEvent('Mine');
  const theirs = await createEvent('Theirs', { account: GUEST });
  await installWallet(page);
  await signIn(page);
  await expect(t(page, `event-card-${mineId}`)).toContainText('0 / 14 vé đã phát hành');
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
  await expect(page.getByText('Không phải địa chỉ ví')).toBeVisible();
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
  await expect(t(page, 'tx-done')).toContainText('Đã tặng 2 × VIP');
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
  await expect(t(page, 'tx-failed')).toContainText('Bạn đã từ chối trong ví');
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
  await expect(page.getByText('Không phải địa chỉ ví')).toBeVisible();
  await t(page, 'scanner-address').fill(GATE.address);
  await t(page, 'scanner-add').click();
  await expect(t(page, 'tx-done')).toContainText('Đã cấp quyền soát vé');
  expect(await read('isScanner', [BigInt(id), GATE.address])).toBe(true);
  await expect(t(page, `scanner-${GATE.address}`)).toBeVisible();

  await t(page, `revoke-${GATE.address}`).click();
  await expect(t(page, 'tx-done')).toContainText('Đã thu quyền soát vé');
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
  await expect(t(page, 'principal')).toHaveText('2.340.000đ');
  await expect(t(page, 'activity')).toContainText('2 × GA · 1.040.000đ');
  await expect(t(page, 'n-valid')).toHaveText('3');
  // Sales per tier: issued and left from the contract, paid tickets and money from the mint logs.
  await expect(t(page, 'tier-row-0')).toContainText('2/10');
  await expect(t(page, 'tier-row-0')).toContainText('1.040.000');
  await expect(t(page, 'tier-row-1')).toContainText('1.300.000');
  await expect(t(page, 'tier-total')).toContainText('2.340.000');
  await expect(t(page, 'sales-fee')).toHaveText('70.200đ');

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
  expect(csv[0]).toBe('Vé,Hạng vé,Người giữ,Trạng thái,Đã trả (đ),Mệnh giá (đ),Giá rao (đ)');
  expect(csv).toContain(`${first},GA,${GUEST.address},Hợp lệ,520000,520000,`);
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
  await expect(t(page, 'float')).toHaveText('2.340.000đ');
  await expect(t(page, 'step-onsale')).toHaveAttribute('aria-current', 'step');
  await t(page, 'cancel').click();
  await expect(t(page, 'cancel-confirm')).toContainText('2.340.000đ');
  await t(page, 'cancel-no').click();
  expect((await read('getEvent', [BigInt(id)])).data.cancelled).toBe(false);
  await t(page, 'cancel').click();
  await t(page, 'cancel-yes').click();
  await expect(t(page, 'tx-done')).toContainText('Đã huỷ sự kiện');
  await expect(t(page, 'step-cancelled')).toContainText('Đã xong');
  await expect(t(page, 'step-refunded')).toHaveAttribute('aria-current', 'step');
  await expect(t(page, 'step-refunded')).toContainText('Còn 3 vé chưa hoàn');
  await expect(t(page, 'refund-count')).toHaveText('3');
  await expect(t(page, 'refund-owed')).toHaveText('2.340.000đ');
  await t(page, 'refund-all').click();
  await t(page, 'refund-yes').click();
  await expect(t(page, 'refund-panel').getByTestId('tx-done')).toContainText('Đã hoàn 3 vé · 2.340.000đ');
  await expect(t(page, 'step-refunded')).toContainText('Đã xong');

  expect(await usdcOf(GUEST.address)).toBe(g1);
  expect(await usdcOf(GUEST2.address)).toBe(g2);
  await expect(t(page, 'float')).toHaveText('0đ');
  await expect(t(page, 'refunded')).toHaveText('2.340.000đ');
  await expect(t(page, 'refund-count')).toHaveText('0');
  await t(page, 'tab-overview').click();
  await expect(t(page, 'status-badge').first()).toHaveText('Đã huỷ');
  await expect(t(page, 'n-refunded')).toHaveText('3');
  await t(page, 'tab-tickets').click();
  await t(page, 'filter-refunded').click();
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(3);
});

test('without a wallet every page reads from the chain and no action is offered', async ({ page }) => {
  const id = await createEvent('Open house');
  await buy(GUEST, id, 0, 2);
  await page.goto(`/#/e/${id}/money`);
  await expect(t(page, 'read-only')).toBeVisible();
  await expect(t(page, 'step-onsale')).toHaveAttribute('aria-current', 'step');
  await expect(t(page, 'float')).toHaveText('1.040.000đ');
  await expect(t(page, 'readonly-note')).toBeVisible();
  for (const id of ['cancel', 'settle', 'issue-submit']) await expect(t(page, id)).toBeDisabled();
  await t(page, 'tab-overview').click();
  await expect(t(page, 'tier-row-0')).toContainText('1.040.000');
  await t(page, 'tab-tickets').click();
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(2);
  await t(page, 'tab-resale').click();
  await expect(t(page, 'queue-0')).toContainText('0 người chờ');
  await expect(t(page, 'resale-fee-note')).toContainText('không thu phí trên giao dịch bán lại');
  await t(page, 'tab-gate').click();
  await expect(t(page, 'quorum-result')).toHaveText('Chưa đủ một nửa');
  await expect(t(page, 'door-need')).toHaveText('1');
  await expect(t(page, 'pin-hint')).toContainText('GATE_PIN');
  await expect(t(page, 'scanner-add')).toHaveCount(0);
  await page.goto('/#/new');
  await expect(t(page, 'new-readonly')).toBeVisible();
  await expect(t(page, 'create')).toBeDisabled();
});

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  test('the tier fields keep their labels and nothing scrolls sideways', async ({ page }) => {
    const id = await createEvent('Pocket');
    await buy(GUEST, id, 0, 2);
    await page.goto('/#/new');
    for (const label of ['Tên hạng', 'Giá (đ)', 'Số lượng']) await expect(t(page, 'tier-0').getByText(label, { exact: true })).toBeVisible();
    expect(await fits(page)).toBe(true);
    for (const tab of ['overview', 'tickets', 'resale', 'gate', 'money']) {
      await page.goto(`/#/e/${id}/${tab}`);
      await expect(t(page, 'event-name')).toBeVisible();
      if (tab === 'tickets') await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(2);
      if (tab === 'overview') await expect(t(page, 'tier-row-0')).toContainText('1.040.000');
      expect(await fits(page), tab).toBe(true);
    }
  });
});

test('losing the network keeps the last numbers and says so', async ({ page }) => {
  const id = await createEvent('Offline');
  await installWallet(page);
  await signIn(page, `/#/e/${id}`);
  await expect(t(page, 'issued')).toHaveText('0');
  await page.route(`${RPC}/**`, (r) => r.abort());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(t(page, 'stale')).toContainText('Không kết nối được mạng', { timeout: 40_000 });
  await expect(t(page, 'issued')).toHaveText('0');
  await page.unroute(`${RPC}/**`);
  await t(page, 'refresh').click();
  await expect(t(page, 'stale')).toHaveCount(0);
});

/** Gate scan with the holder's own EIP-712 signature, as the app's QR carries it. */
async function checkIn(holder: Account, tokenId: number) {
  const deadline = BigInt((await chainNow()) + 240);
  const signature = await holder.signTypedData({
    domain: { name: 'VeGoc', version: '1', chainId: 31337, verifyingContract: BOX },
    types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'CheckIn', message: { tokenId: BigInt(tokenId), deadline },
  });
  await write(GATE, 'checkIn', [BigInt(tokenId), deadline, signature]);
}

// The next two move the chain clock forward, so they run last.
test('settle opens at the end once the gate quorum is met, and pays principal minus the 3 % fee plus mock yield', async ({ page }) => {
  const id = await createEvent('Settle', { endsIn: 900 });
  await buy(GUEST, id, 0, 3);
  const first = Number(await read('totalMinted')) - 3;
  await write(ORGANIZER, 'setScanner', [BigInt(id), GATE.address, true]);
  await checkIn(GUEST, first);
  await checkIn(GUEST, first + 1); // 2 of 3 paid tickets scanned: above the quorum of one half
  await write(ORGANIZER, 'fundReserve', [BigInt(id), 5_000000n], VAULT, vaultAbi); // this event's mock yield
  await installWallet(page);
  await signIn(page, `/#/e/${id}/money`);
  await expect(t(page, 'settle')).toBeDisabled();

  await client.request({ method: 'evm_increaseTime' as never, params: [3600] as never });
  await client.request({ method: 'evm_mine' as never });
  const before = await usdcOf(ORGANIZER.address);
  const treasuryBefore = await usdcOf(TREASURY);
  await page.reload();
  await expect(t(page, 'settle')).toBeEnabled();
  await expect(t(page, 'step-settled')).toHaveAttribute('aria-current', 'step');
  await expect(t(page, 'step-ended')).toContainText('2/3 vé trả tiền đã vào cửa, đủ một nửa');
  await expect(t(page, 'settle-net')).toHaveText('1.513.200đ');
  await t(page, 'settle').click();
  await expect(t(page, 'settle-confirm')).toContainText('phí nền tảng 3% 46.800đ');
  await t(page, 'settle-yes').click();
  await expect(t(page, 'settle-panel').getByTestId('tx-done')).toContainText('Đã quyết toán · 1.513.200đ +');
  await expect(t(page, 'step-settled')).toContainText('Đã xong');
  await expect(t(page, 'step-settled')).toContainText('phí nền tảng 46.800đ');
  const gained = (await usdcOf(ORGANIZER.address)) - before;
  expect(gained).toBeGreaterThan(58_200000n);
  expect(gained).toBeLessThan(58_210000n);
  expect(await usdcOf(TREASURY)).toBe(treasuryBefore + 1_800000n);
  await expect(t(page, 'settled-principal')).toHaveText('1.513.200đ');
  await expect(t(page, 'settle')).toBeDisabled();
  await t(page, 'tab-overview').click();
  await expect(t(page, 'status-badge').first()).toHaveText('Đã quyết toán');
});

test('no-show: an event that ends with nobody scanned locks settlement for 48 h and refunds the holders', async ({ page }) => {
  const id = await createEvent('Ghost show', { endsIn: 900 });
  await faucet(GUEST);
  const g1 = await usdcOf(GUEST.address);
  await buy(GUEST, id, 0, 2);
  await client.request({ method: 'evm_increaseTime' as never, params: [3600] as never });
  await client.request({ method: 'evm_mine' as never });

  await installWallet(page);
  await signIn(page, `/#/e/${id}/money`);
  await expect(t(page, 'status-badge').first()).toHaveText('Thiếu lượt vào cửa');
  await expect(t(page, 'step-refunds')).toHaveAttribute('aria-current', 'step');
  await expect(t(page, 'step-ended')).toContainText('Chỉ 0/2 vé trả tiền đã vào cửa');
  await expect(t(page, 'settle')).toBeDisabled();
  await expect(t(page, 'settle-panel')).toContainText('Thiếu lượt vào cửa · giữ thêm 48 giờ');
  await expect(t(page, 'refund-count')).toHaveText('2');
  await t(page, 'refund-all').click();
  await t(page, 'refund-yes').click();
  await expect(t(page, 'refund-panel').getByTestId('tx-done')).toContainText('Đã hoàn 2 vé · 1.040.000đ');
  expect(await usdcOf(GUEST.address)).toBe(g1);
  await expect(t(page, 'float')).toHaveText('0đ');
});

test('a visit without a wallet lands on the events, with their figures and no way to act', async ({ page }) => {
  const id = await createEvent('Open House');
  await buy(GUEST, id, 0, 2);
  await page.goto('/');
  // No login wall: the list is there at once, marked read-only.
  await expect(t(page, 'no-wallet')).toBeVisible();
  await expect(t(page, 'read-only')).toBeVisible();
  await expect(t(page, `event-card-${id}`)).toContainText('2 / 14 vé đã phát hành');
  // The form to create an event can be looked at, not sent.
  await t(page, 'new-event').click();
  await expect(t(page, 'new-form')).toBeVisible();
  await expect(t(page, 'create')).toBeDisabled();

  await page.goto(`/#/e/${id}`);
  await expect(t(page, 'event-name')).toHaveText('Open House');
  await expect(t(page, 'issued')).toHaveText('2');
  await page.goto(`/#/e/${id}/money`);
  await expect(t(page, 'readonly-note')).toBeVisible();
  await expect(t(page, 'sales')).toHaveText('1.040.000đ');
  for (const button of ['issue-submit', 'cancel', 'settle']) await expect(t(page, button)).toBeDisabled();
  await page.goto(`/#/e/${id}/gate`);
  await expect(t(page, 'scanner-add')).toHaveCount(0);
  await expect(t(page, 'extend-panel')).toHaveCount(0);
  await page.reload();
  await expect(t(page, 'read-only')).toBeVisible();
  await expect(t(page, 'quorum-panel')).toBeVisible();
});

test('door running late: the organizer moves the end back after a confirm step; past 24 h in total the contract refuses in plain words', async ({ page }) => {
  const id = await createEvent('Late Doors');
  const before = (await read('getEvent', [BigInt(id)])).data.endsAt as bigint;
  await installWallet(page);
  await signIn(page, `/#/e/${id}/gate`);
  await t(page, 'extend-60').click();
  await expect(t(page, 'extend-confirm')).toContainText('Giờ kết thúc mới');
  await t(page, 'extend-no').click();
  expect((await read('getEvent', [BigInt(id)])).data.endsAt).toBe(before);
  await t(page, 'extend-120').click();
  await t(page, 'extend-yes').click();
  await expect(t(page, 'tx-done')).toContainText('Giờ kết thúc mới:');
  expect((await read('getEvent', [BigInt(id)])).data.endsAt).toBe(before + 7200n);

  // 22 h more on chain uses up the 24 h; the next step from the console is refused before the wallet is asked.
  await write(ORGANIZER, 'extendEvent', [BigInt(id), before + 86_400n]);
  await page.reload();
  await t(page, 'extend-30').click();
  await t(page, 'extend-yes').click();
  await expect(t(page, 'tx-failed')).toContainText('tổng cộng 24 giờ');
  expect((await read('getEvent', [BigInt(id)])).data.endsAt).toBe(before + 86_400n);
});
