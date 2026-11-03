import { expect, Page, test } from '@playwright/test';

const RPC = 'http://127.0.0.1:8546';
const A = 1, B = 2, GATE = 3;
const A_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await res.json()).result;
}

async function useWallet(page: Page, index: number) {
  await page.getByTestId('wallet-chip').click();
  await page.getByTestId(`dev-wallet-${index}`).click();
  await expect(page.getByTestId('nav-tickets')).toBeVisible();
}

const ticketIds = (page: Page) => page.locator('[data-testid^="ticket-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('ticket-', '')));

async function buyOne(page: Page): Promise<string> {
  await page.getByTestId('nav-tickets').click();
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('refresh')).toBeEnabled();
  const before = await ticketIds(page);
  await page.getByTestId('nav-event').click();
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

async function transfer(page: Page, id: string, to: string) {
  await page.getByTestId(`ticket-${id}`).click();
  await page.getByTestId('transfer').click();
  await page.getByTestId('recipient').fill(to);
  await page.getByTestId('send-transfer').click();
}

async function scan(page: Page, raw: string) {
  await page.getByTestId('manual-code').fill(raw);
  await page.getByTestId('manual-submit').click();
}

test.beforeEach(async ({ page }) => {
  await rpc('evm_setAutomine', [true]);
  await page.goto('/');
  await expect(page.getByTestId('wallet-chip')).toBeVisible({ timeout: 60_000 });
});

test('entry right follows the ticket: old QR refused, last holder admitted, ticket then locked', async ({ page }) => {
  await useWallet(page, A);
  await expect(page.getByTestId('nav-gate')).toHaveCount(0);
  const id = await buyOne(page);
  const qrA = await qrOf(page, id);

  await transfer(page, id, B_ADDRESS);
  await expect(page.getByTestId('transferred')).toHaveText(/Quyền vào cửa đã chuyển/i);

  await useWallet(page, B);
  await page.getByTestId('nav-tickets').click();
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Bạn đang giữ vé');
  const qrB = await qrOf(page, id);

  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await scan(page, qrA);
  await expect(page.getByTestId('gate-rejected')).toContainText('Chủ vé đã thay đổi');
  await expect(page.getByTestId('gate-reason')).toHaveText('OwnerChanged');
  await page.getByTestId('next').click();

  await scan(page, qrB);
  await expect(page.getByTestId('gate-valid')).toContainText('Chưa cho khách vào');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('gate-admitted')).toBeVisible();
  await page.getByTestId('next').click();

  await scan(page, qrB);
  await expect(page.getByTestId('gate-reason')).toHaveText('AlreadyCheckedIn');
  await page.getByTestId('next').click();
  await page.getByTestId('exit-gate').click();

  await useWallet(page, B);
  await page.getByTestId('nav-tickets').click();
  await page.getByTestId(`ticket-${id}`).click();
  await expect(page.getByTestId('used')).toBeVisible();
  await expect(page.getByTestId('make-qr')).toHaveCount(0);

  await useWallet(page, A);
  await page.getByTestId('nav-tickets').click();
  await page.getByTestId(`ticket-${id}`).click();
  await expect(page.getByTestId('transferred')).toBeVisible();
});

test('nothing reads as admitted until the receipt succeeds', async ({ page }) => {
  await useWallet(page, A);
  const id = await buyOne(page);
  const qr = await qrOf(page, id);
  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await rpc('evm_setAutomine', [false]);
  await scan(page, qr);
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('gate-confirming')).toBeVisible();
  await expect(page.getByTestId('gate-admitted')).toHaveCount(0);
  await rpc('evm_mine');
  await expect(page.getByTestId('gate-admitted')).toBeVisible();
});

test('a pending transfer survives a restart and keeps the QR hidden', async ({ page }) => {
  await useWallet(page, A);
  const id = await buyOne(page);
  await rpc('evm_setAutomine', [false]);
  await transfer(page, id, B_ADDRESS);
  await expect(page.getByTestId('transferring')).toBeVisible();
  await expect(page.getByTestId('make-qr')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('wallet-chip')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-tickets').click();
  await expect(page.getByTestId(`ticket-${id}`)).toContainText('Đang chuyển cho');
  await page.getByTestId(`ticket-${id}`).click();
  await expect(page.getByTestId('transferring')).toBeVisible();
  await expect(page.getByTestId('make-qr')).toHaveCount(0);

  await rpc('evm_mine');
  await expect(page.getByTestId('transferred')).toBeVisible({ timeout: 15_000 });
});

test('losing the network after sending shows unknown, and looking up does not send twice', async ({ page }) => {
  await useWallet(page, A);
  const id = await buyOne(page);
  await rpc('evm_setAutomine', [false]);
  await transfer(page, id, B_ADDRESS);
  await expect(page.getByTestId('transferring')).toBeVisible();

  await page.route(`${RPC}/**`, (r) => r.abort());
  await expect(page.getByTestId('transfer-unknown')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('make-qr')).toHaveCount(0);

  await page.unroute(`${RPC}/**`);
  const inPool = async () => {
    const pool = (await rpc('txpool_content')) as { pending: Record<string, Record<string, unknown>> };
    return Object.values(pool.pending).reduce((n, byNonce) => n + Object.keys(byNonce).length, 0);
  };
  expect(await inPool()).toBe(1);
  await page.getByTestId('lookup').click();
  await expect(page.getByTestId('transferring')).toBeVisible();
  expect(await inPool()).toBe(1);
  await rpc('evm_mine');
  await expect(page.getByTestId('transferred')).toBeVisible({ timeout: 15_000 });
});

test('after a restart with no network, an unresolved purchase can still be found and looked up', async ({ page }) => {
  await useWallet(page, A);
  await page.getByTestId('nav-event').click();
  await rpc('evm_setAutomine', [false]);
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('purchase-pending')).toBeVisible();
  await page.route(`${RPC}/**`, (r) => r.abort());
  await expect(page.getByTestId('purchase-unknown')).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId('unresolved')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-tickets').click();
  await expect(page.getByTestId('unresolved')).toBeVisible();

  await page.unroute(`${RPC}/**`);
  await rpc('evm_mine');
  await page.getByTestId('unresolved-lookup').click();
  await expect(page.getByTestId('unresolved')).toHaveCount(0, { timeout: 15_000 });
});

test('refuses a QR about to expire, and a code that is not a ticket', async ({ page }) => {
  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await scan(page, 'not-a-ticket');
  await expect(page.getByTestId('gate-invalid')).toBeVisible();
  await page.getByTestId('next').click();
  await page.getByTestId('exit-gate').click();

  await useWallet(page, A);
  const id = await buyOne(page);
  const qr = await qrOf(page, id);
  const nearly = JSON.stringify({ ...JSON.parse(qr), deadline: String(Math.floor(Date.now() / 1000) + 10) });
  await useWallet(page, GATE);
  await page.getByTestId('nav-gate').click();
  await scan(page, nearly);
  await expect(page.getByTestId('gate-expiring')).toBeVisible();
  await expect(page.getByTestId('confirm')).toHaveAttribute('aria-disabled', 'true');
});

test('the dashboard is for the organizer and follows check-ins on chain', async ({ page }) => {
  const count = async (id: string) => Number(await page.getByTestId(id).textContent());

  await useWallet(page, A);
  await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
  const id = await buyOne(page);
  const qr = await qrOf(page, id);

  await useWallet(page, 0);
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId(`dash-ticket-${id}`).click();
  await expect(page.getByTestId('dash-selected')).toContainText(`Vé #${id}`);
  await expect(page.getByTestId('dash-selected')).toContainText('Chưa vào');
  const entered = await count('dash-entered');
  const waiting = await count('dash-waiting');

  await useWallet(page, GATE);
  await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
  await page.getByTestId('nav-gate').click();
  await scan(page, qr);
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('gate-admitted')).toBeVisible();
  await page.getByTestId('next').click();
  await page.getByTestId('exit-gate').click();

  await useWallet(page, 0);
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId(`dash-ticket-${id}`).click();
  await expect(page.getByTestId('dash-selected')).toContainText('Đã vào');
  expect(await count('dash-entered')).toBe(entered + 1);
  expect(await count('dash-waiting')).toBe(waiting - 1);

  await page.getByTestId('dash-tab-holders').click();
  await expect(page.getByTestId(`dash-holder-${A_ADDRESS}`)).toContainText('đã vào');

  await page.getByTestId('dash-tab-activity').click();
  const newest = page.locator('[data-testid^="dash-event-"]').first();
  await expect(newest).toContainText(`Vào cửa · Vé #${id}`);
  await expect(page.getByTestId('dash-activity')).toContainText(`Mua vé #${id}`);
});

test('losing the network keeps the last numbers and says they are old', async ({ page }) => {
  await useWallet(page, 0);
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('dash-entered')).toBeVisible();
  const before = await page.getByTestId('dash-entered').textContent();

  await page.route(`${RPC}/**`, (r) => r.abort());
  await page.getByTestId('dash-refresh').click();
  await expect(page.getByTestId('dash-stale')).toContainText('Không kết nối được mạng', { timeout: 30_000 });
  await expect(page.getByTestId('dash-entered')).toHaveText(before!);
  // A long message must not squeeze the icon beside it.
  expect((await page.getByTestId('dash-stale').locator('svg').boundingBox())!.width).toBe(24);

  await page.unroute(`${RPC}/**`);
  await page.getByTestId('dash-refresh').click();
  await expect(page.getByTestId('dash-stale')).toHaveCount(0, { timeout: 15_000 });
});
