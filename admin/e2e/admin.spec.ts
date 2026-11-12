import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const RPC = 'http://127.0.0.1:8550';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const ORGANIZER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const GUEST = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const GATE = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const abi = JSON.parse(readFileSync('../out/EventTicket.sol/EventTicket.json', 'utf8')).abi;
const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC) });

/** A stand-in for a browser wallet: real signatures and real transactions on anvil, driven from the test. */
async function installWallet(page: Page, start = ORGANIZER) {
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
      const wallet = createWalletClient({ account: w.account, chain, transport: http(RPC) });
      return { result: await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n }) };
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
async function signIn(page: Page) {
  await page.goto('/');
  await t(page, 'login').click();
  await expect(t(page, 'me')).toBeVisible();
}
async function write(account: typeof ORGANIZER, functionName: string, args: unknown[], value = 0n) {
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: CONTRACT, abi, functionName, args, value } as never) });
}
const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: CONTRACT, abi, functionName, args } as never) as Promise<any>;
async function checkIn(tokenId: bigint, holder: typeof GUEST, scanner: typeof GATE) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await holder.signTypedData({ domain: { name: 'EventTicket', version: '1', chainId: 31337, verifyingContract: CONTRACT }, types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'CheckIn', message: { tokenId, deadline } });
  await write(scanner, 'checkIn', [tokenId, deadline, signature]);
}

test('no wallet in the browser explains what to do', async ({ page }) => {
  await page.goto('/');
  await expect(t(page, 'no-wallet')).toContainText('MetaMask');
  await expect(t(page, 'me')).toHaveCount(0);
});

test('a wallet that is not the organizer cannot get in', async ({ page }) => {
  await installWallet(page, GUEST);
  await page.goto('/');
  await t(page, 'login').click();
  await expect(t(page, 'login-error')).toContainText('not the event organizer');
  await expect(t(page, 'me')).toHaveCount(0);
});

test('refusing to sign leaves you logged out', async ({ page }) => {
  const w = await installWallet(page);
  await page.goto('/');
  w.rejectNext = true;
  await t(page, 'login').click();
  await expect(t(page, 'login-error')).toContainText('rejected');
  await expect(t(page, 'me')).toHaveCount(0);
});

test('the organizer logs in, survives a reload, and is out after logout', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  await page.reload();
  await expect(t(page, 'me')).toBeVisible();
  await t(page, 'logout').click();
  await expect(t(page, 'login')).toBeVisible();
  await page.reload();
  await expect(t(page, 'login')).toBeVisible();
});

test('switching account in the wallet ends the session, even across a reload', async ({ page }) => {
  const w = await installWallet(page);
  await signIn(page);
  await page.evaluate(() => (window as any).__emit('accountsChanged', []));
  await expect(t(page, 'login')).toBeVisible();

  await t(page, 'login').click();
  await expect(t(page, 'me')).toBeVisible();
  w.account = GUEST;
  await page.reload();
  await expect(t(page, 'login')).toBeVisible();
});

test('mint validates input, then issues real tickets to the wallet', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  await t(page, 'view-mint').click();
  await t(page, 'mint-to').fill('not-an-address');
  await expect(t(page, 'mint-to-error')).toBeVisible();
  await expect(t(page, 'mint-submit')).toBeDisabled();
  await t(page, 'mint-to').fill(GUEST.address);
  await t(page, 'mint-quantity').fill('0');
  await expect(t(page, 'mint-quantity-error')).toBeVisible();
  await t(page, 'mint-quantity').fill('1000');
  await expect(t(page, 'mint-submit')).toBeDisabled();
  const before: bigint = await read('totalMinted');
  await t(page, 'mint-quantity').fill('2');
  await t(page, 'mint-submit').click();
  await expect(t(page, 'tx-done')).toContainText('Issued 2 tickets');
  expect(await read('totalMinted')).toBe(before + 2n);
  expect(await read('ownerOf', [before])).toBe(GUEST.address);
});

test('rejecting a transaction in the wallet changes nothing and says so', async ({ page }) => {
  const w = await installWallet(page);
  await signIn(page);
  await t(page, 'view-mint').click();
  const before = await read('totalMinted');
  await t(page, 'mint-to').fill(GUEST.address);
  w.rejectNext = true;
  await t(page, 'mint-submit').click();
  await expect(t(page, 'tx-failed')).toContainText('rejected');
  expect(await read('totalMinted')).toBe(before);
});

test('nothing reads as done until the receipt arrives', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  await t(page, 'view-mint').click();
  await t(page, 'mint-to').fill(GUEST.address);
  await client.request({ method: 'evm_setAutomine' as never, params: [false] as never });
  try {
    await t(page, 'mint-submit').click();
    await expect(t(page, 'tx-pending')).toBeVisible();
    await expect(t(page, 'tx-done')).toHaveCount(0);
    await client.request({ method: 'evm_mine' as never });
    await expect(t(page, 'tx-done')).toBeVisible();
  } finally {
    await client.request({ method: 'evm_setAutomine' as never, params: [true] as never });
  }
});

test('grants and revokes gate staff, and the chain agrees', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  await t(page, 'view-scanners').click();
  await t(page, 'scanner-address').fill('xyz');
  await expect(t(page, 'scanner-error')).toBeVisible();
  await t(page, 'scanner-address').fill(GATE.address);
  await t(page, 'scanner-add').click();
  await expect(t(page, 'tx-done')).toContainText('Gate access granted');
  expect(await read('isScanner', [GATE.address])).toBe(true);
  await expect(t(page, `scanner-${GATE.address}`)).toBeVisible({ timeout: 20_000 });

  await t(page, `revoke-${GATE.address}`).click();
  await expect(t(page, 'tx-done')).toContainText('Access revoked');
  expect(await read('isScanner', [GATE.address])).toBe(false);
  await expect(t(page, `scanner-${GATE.address}`)).toHaveCount(0, { timeout: 20_000 });
});

test('revenue separates sales from free tickets, and withdraw asks first then pays out', async ({ page }) => {
  await write(GUEST, 'buy', [3n], parseEther('0.03'));
  await installWallet(page);
  await signIn(page);
  await t(page, 'view-revenue').click();
  const available = () => t(page, 'available').textContent();
  await expect(t(page, 'sold')).toHaveText(/^[1-9]/, { timeout: 20_000 });
  const collectedBefore = await t(page, 'collected').textContent();
  expect(await available()).not.toBe('0 AVAX');

  const balanceBefore = await client.getBalance({ address: GATE.address });
  await t(page, 'withdraw-to').fill('bad');
  await expect(t(page, 'withdraw-error')).toBeVisible();
  await t(page, 'withdraw-to').fill(GATE.address);
  await t(page, 'withdraw').click();
  await t(page, 'withdraw-no').click();
  expect(await client.getBalance({ address: GATE.address })).toBe(balanceBefore);

  await t(page, 'withdraw').click();
  await expect(t(page, 'withdraw-confirm')).toContainText(GATE.address);
  await t(page, 'withdraw-yes').click();
  await expect(t(page, 'tx-done')).toContainText('Withdrew');
  expect(await client.getBalance({ address: GATE.address })).toBeGreaterThan(balanceBefore);
  expect(await client.getBalance({ address: CONTRACT })).toBe(0n);
  await expect(t(page, 'available')).toHaveText('0 AVAX');
  await expect(t(page, 'collected')).toHaveText(collectedBefore!);
  await expect(t(page, 'withdrawn')).toHaveText(collectedBefore!);
  await expect(t(page, 'withdraw')).toBeDisabled();
});

test('tickets can be searched, filtered and exported, including entry details', async ({ page }) => {
  await write(ORGANIZER, 'setScanner', [GATE.address, true]);
  const id: bigint = await read('totalMinted');
  await write(ORGANIZER, 'mint', [GUEST.address, 1n]);
  await checkIn(id, GUEST, GATE);

  await installWallet(page);
  await signIn(page);
  await t(page, 'view-overview').click();
  await t(page, `cell-${id}`).click();
  await expect(t(page, 'picked')).toContainText('Checked in');
  await expect(t(page, 'picked')).toContainText(GUEST.address);
  await expect(t(page, 'activity')).toContainText(`Check-in · Ticket #${id}`);

  await t(page, 'view-tickets').click();
  await t(page, 'search').fill(`#${id}`);
  await expect(t(page, 'ticket-table').locator('tbody tr')).toHaveCount(1);
  await expect(t(page, `row-${id}`)).toContainText('Checked in');
  await t(page, 'filter-waiting').click();
  await expect(t(page, 'no-result')).toBeVisible();
  await t(page, 'filter-entered').click();
  await t(page, 'search').fill('');
  await expect(t(page, `row-${id}`)).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), t(page, 'export').click()]);
  expect(download.suggestedFilename()).toBe('tickets-entered.csv');
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.replace('﻿', '').split('\r\n')[0]).toBe('Ticket,Holder,Status,Checked in at,Checked by');
  expect(csv).toContain(`${id},${GUEST.address},Checked in,`);
  expect(csv).toContain(GATE.address);
});

test('losing the network keeps the last numbers and says they are old', async ({ page }) => {
  await installWallet(page);
  await signIn(page);
  const before = await t(page, 'entered').textContent();
  await page.route(`${RPC}/**`, (r) => r.abort());
  await t(page, 'refresh').click();
  await expect(t(page, 'stale')).toContainText('Cannot reach the network', { timeout: 30_000 });
  await expect(t(page, 'entered')).toHaveText(before!);
  await page.unroute(`${RPC}/**`);
  await t(page, 'refresh').click();
  await expect(t(page, 'stale')).toHaveCount(0, { timeout: 15_000 });
});
