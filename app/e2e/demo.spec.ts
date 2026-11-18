import { expect, Page, test } from '@playwright/test';
import { encodeFunctionData } from 'viem';

const RPC = 'http://127.0.0.1:8546';
const A = 0, B = 1, GATE = 2; // dev wallet indexes in the app
const B_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const BOX = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ORGANIZER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await res.json()).result;
}

async function useWallet(page: Page, index: number) {
  if (await page.getByTestId('exit-gate').count()) await page.getByTestId('exit-gate').click();
  await page.getByTestId('wallet-chip').first().click();
  await page.getByTestId(`dev-wallet-${index}`).click();
  await expect(page.getByTestId('nav-tickets')).toBeVisible();
}

const ticketIds = (page: Page) => page.locator('[data-testid^="ticket-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('ticket-', '')));

async function buyOne(page: Page, eventId = '0'): Promise<string> {
  await page.getByTestId('nav-tickets').click();
  await expect(page.getByTestId('usdc-balance')).not.toHaveText('…');
  const before = await ticketIds(page);
  await page.getByTestId('nav-events').click();
  await page.getByTestId(`event-${eventId}`).click();
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('bought')).toBeVisible();
  await expect(page.locator('[data-testid^="ticket-"]')).toHaveCount(before.length + 1);
  const created = (await ticketIds(page)).filter((id) => !before.includes(id));
  expect(created).toHaveLength(1);
  return created[0];
}

async function qrOf(page: Page, id: string): Promise<string> {
  await page.getByTestId('nav-tickets').click();
  await page.getByTestId(`ticket-${id}`).click();
  await page.getByTestId('make-qr').click();
  const payload = await page.getByTestId('qr-payload').textContent();
  expect(payload).toBeTruthy();
  await page.getByTestId('nav-tickets').click();
  return payload!;
}

async function scan(page: Page, raw: string) {
  await page.getByTestId('manual-code').fill(raw);
  await page.getByTestId('manual-submit').click();
}

test.beforeEach(async ({ page }) => {
  await rpc('evm_setAutomine', [true]);
  await page.goto('/');
  await expect(page.getByTestId('wallet-chip').first()).toBeVisible({ timeout: 60_000 });
});

test('buy with USDC, resell at most +10 %, old QR refused, new holder admitted once', async ({ page }) => {
  await useWallet(page, A);
  const id = await buyOne(page);
  await expect(page.getByTestId('fee')).toContainText(/CONFIRMED IN \d+\.\d S · FEE [\d.,]+ n?AVAX/);
  await expect(page.getByTestId('network')).toHaveText('ANVIL');
  const oldQr = await qrOf(page, id);

  await page.getByTestId(`ticket-${id}`).click();
  await expect(page.getByTestId('cap')).toHaveText('27.50 USDC');
  await page.getByTestId('resell').click();
  await page.getByTestId('price').fill('30');
  await expect(page.getByTestId('over-cap')).toBeVisible();
  // The unit next to the price field must stay on screen at phone width (it used to be pushed off the right edge).
  await expect(page.getByTestId('price-unit')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('send-list')).toBeDisabled();
  await page.getByTestId('preset-Cap +10%').click();
  await page.getByTestId('send-list').click();
  await expect(page.getByTestId('notice')).toContainText(`#${id} listed for 27.50 USDC`);
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Listed');

  await useWallet(page, B);
  await page.getByTestId('nav-events').click();
  await page.getByTestId('event-0').click();
  await page.getByTestId(`buy-listing-${id}`).click();
  await expect(page.getByTestId('notice')).toContainText(`Bought #${id} on resale`);
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Yours');

  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await scan(page, oldQr);
  await expect(page.getByTestId('gate-rejected')).toContainText('Ticket changed hands');
  await expect(page.getByTestId('gate-reason')).toHaveText('OwnerChanged');
  await page.getByTestId('next').click();

  await useWallet(page, B);
  const newQr = await qrOf(page, id);
  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await scan(page, newQr);
  await expect(page.getByTestId('gate-valid')).toContainText('Test Fest · GA');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('gate-admitted')).toBeVisible();
  await page.getByTestId('next').click();
  await scan(page, newQr);
  await expect(page.getByTestId('gate-reason')).toHaveText('AlreadyCheckedIn');
  await page.getByTestId('next').click();

  await useWallet(page, B);
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Checked in');
  expect(B_ADDRESS).toBeTruthy();
});

test('waitlist: B joins the line, A lists, the ticket goes to B without anyone choosing', async ({ page }) => {
  await useWallet(page, B);
  await page.getByTestId('nav-events').click();
  await page.getByTestId('event-0').click();
  await expect(page.getByTestId('waiting-count')).toHaveText('GA · 0 WAITING');
  await page.getByTestId('join-waitlist').click();
  await expect(page.getByTestId('notice')).toContainText('In line for a resale ticket · 27.50 USDC paid in');
  await page.getByTestId('nav-events').click();
  await page.getByTestId('event-0').click();
  await expect(page.getByTestId('wait-position')).toContainText('The next GA ticket listed is yours');

  await useWallet(page, A);
  const id = await buyOne(page);
  await page.getByTestId(`ticket-${id}`).click();
  await page.getByTestId('resell').click();
  await page.getByTestId('preset-Cap +10%').click();
  await page.getByTestId('send-list').click();
  await expect(page.getByTestId('notice')).toContainText(`#${id} sold to the first in line · 27.50 USDC`);
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Sold on resale');

  await useWallet(page, B);
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Yours');
  await page.getByTestId('nav-events').click();
  await page.getByTestId('event-0').click();
  await expect(page.getByTestId('waiting-count')).toHaveText('GA · 0 WAITING');
  await expect(page.getByTestId('join-waitlist')).toBeVisible();
});

test('organizer cancels: the holder sees the refund and gets face value back', async ({ page }) => {
  await useWallet(page, A);
  const id = await buyOne(page, '1');
  const balance = await page.getByTestId('usdc-balance').textContent();
  // The organizer (unlocked on anvil) cancels event 1.
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'cancelEvent', inputs: [{ name: 'eventId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], functionName: 'cancelEvent', args: [1n] });
  await rpc('eth_sendTransaction', [{ from: ORGANIZER, to: BOX, data }]);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Refund 15.00 USDC');
  await page.getByTestId(`ticket-${id}`).click();
  await expect(page.getByTestId('cancelled')).toBeVisible();
  await page.getByTestId('refund').click();
  await expect(page.getByTestId('notice')).toContainText('Refunded 15.00 USDC');
  await expect(page.getByTestId(`ticket-${id}`)).toHaveCount(0);
  await expect(page.getByTestId('usdc-balance')).not.toHaveText(balance!);
});

test('events list shows the event, and the faucet enforces its cooldown', async ({ page }) => {
  await useWallet(page, B);
  await page.getByTestId('nav-events').click();
  await expect(page.getByTestId('event-0')).toContainText('Test Fest');
  await page.getByTestId('nav-tickets').click();
  await page.getByTestId('faucet').click();
  await expect(page.getByTestId('faucet-error')).toContainText('try again in 5 minutes');
});
