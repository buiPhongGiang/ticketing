import { afterEach, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { clientIp, createRelayServer, defaultLimits, limitsFromEnv, type Limits } from '../scripts/relay-server';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const TO = '0x00000000000000000000000000000000000000aa';
/** A relayer that sends nothing: it only records what reached it. */
async function start(limits: Partial<Limits> = {}, opts: { balance?: bigint; gatePin?: string; log?: (line: string) => void } = {}) {
  const calls: string[] = [];
  const backend = {
    handle: async (path: string, _body: unknown, extra?: { raw: string; signature?: string; ip?: string }) => {
      calls.push(path);
      if (path === '/social/comment') return extra?.ip === '198.51.100.20' ? { status: 200, json: { comment: { text: 'bí mật của khách', author: TO }, ip: extra.ip } } : { status: 403, json: { error: 'NeedTicket' } };
      if (path === '/webhook/payment') return extra?.signature === 'good' ? { status: 200, json: { ok: true, raw: extra.raw } } : { status: 401, json: { error: 'BadSignature' } };
      return { status: 200, json: { hash: '0x01' } };
    },
    balance: async () => opts.balance ?? 10n ** 18n,
  };
  const server = createRelayServer({ backend, limits: { ...defaultLimits, ...limits }, gatePin: opts.gatePin, log: opts.log });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { post, calls };
}

test('client IP: forwarding headers only from this machine; CF-Connecting-IP, else the last X-Forwarded-For hop', () => {
  expect(clientIp('203.0.113.9', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('203.0.113.9');
  expect(clientIp('127.0.0.1', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('1.1.1.1');
  expect(clientIp('::ffff:127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 10.0.0.4' })).toBe('10.0.0.4');
  expect(clientIp('::1', {})).toBe('::1');
});

test('per-IP rate limit: the 4th request in a minute from one address is refused, another address still passes', async () => {
  const r = await start({ ipPerMin: 3, buyPerHour: 100 });
  const a = { 'x-forwarded-for': '198.51.100.1' };
  for (let i = 0; i < 3; i++) expect((await r.post('/buy', { buyer: TO }, a)).status).toBe(200);
  expect(await r.post('/buy', { buyer: TO }, a)).toEqual({ status: 429, json: { error: 'RateLimited' } });
  expect((await r.post('/buy', { buyer: TO }, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
  expect(r.calls).toHaveLength(4);
});

test('global hourly caps: faucet, top-up and buy stop for everyone once the hour is used, whatever the address', async () => {
  const r = await start({ faucetPerHour: 2, topUpPerHour: 1, buyPerHour: 2 });
  const from = (n: number) => ({ 'cf-connecting-ip': `192.0.2.${n}` });
  expect((await r.post('/faucet', { to: TO }, from(1))).status).toBe(200);
  expect((await r.post('/faucet', { to: TO }, from(2))).status).toBe(200);
  expect((await r.post('/faucet', { to: TO }, from(3))).status).toBe(429);
  expect((await r.post('/top-up', { to: TO }, from(4))).status).toBe(200);
  expect((await r.post('/top-up', { to: TO }, from(5))).status).toBe(429);
  expect((await r.post('/buy', { buyer: TO }, from(6))).status).toBe(200);
  expect((await r.post('/buy', { buyer: TO }, from(7))).status).toBe(200);
  expect((await r.post('/buy', { buyer: TO }, from(8))).status).toBe(429);
  expect(r.calls).toEqual(['/faucet', '/faucet', '/top-up', '/buy', '/buy']);
});

test('faucet per address per hour: one address cannot use the whole hourly cap', async () => {
  const r = await start({ faucetPerIpHour: 1 });
  expect((await r.post('/faucet', { to: TO }, { 'x-forwarded-for': '192.0.2.10' })).status).toBe(200);
  expect((await r.post('/faucet', { to: TO }, { 'x-forwarded-for': '192.0.2.10' })).status).toBe(429);
  expect((await r.post('/faucet', { to: TO }, { 'x-forwarded-for': '192.0.2.11' })).status).toBe(200);
});

test('balance floor: below it faucet and top-up refuse (nothing sent), purchases still go through', async () => {
  const r = await start({ minBalanceWei: 2n * 10n ** 16n }, { balance: 10n ** 16n });
  expect(await r.post('/faucet', { to: TO })).toEqual({ status: 503, json: { error: 'RelayerLow' } });
  expect(await r.post('/top-up', { to: TO })).toEqual({ status: 503, json: { error: 'RelayerLow' } });
  expect((await r.post('/buy', { buyer: TO })).status).toBe(200);
  expect(r.calls).toEqual(['/buy']);
});

test('request size: a body over the limit is refused with 413 and never reaches the relayer', async () => {
  const r = await start({ maxBody: 200 });
  expect((await r.post('/buy', { buyer: TO, pad: 'x'.repeat(300) })).status).toBe(413);
  expect(r.calls).toEqual([]);
});

test('gate: off without a PIN; wrong PIN refused; right PIN passes; 5 wrong PINs lock that address out', async () => {
  const off = await start();
  expect((await off.post('/gate/checkin', { raw: '{}' }, { 'x-gate-pin': '' })).status).toBe(404);

  const r = await start({}, { gatePin: '4826-1937' });
  expect(await r.post('/gate/info', {}, { 'x-gate-pin': 'nope' })).toEqual({ status: 401, json: { error: 'GatePin' } });
  expect((await r.post('/gate/info', {})).status).toBe(401);
  expect((await r.post('/gate/checkin', { raw: '{}' }, { 'x-gate-pin': '4826-1937' })).status).toBe(200);
  const ip = { 'x-forwarded-for': '203.0.113.50' };
  for (let i = 0; i < 5; i++) expect((await r.post('/gate/info', {}, { ...ip, 'x-gate-pin': `guess${i}` })).status).toBe(401);
  expect(await r.post('/gate/info', {}, { ...ip, 'x-gate-pin': '4826-1937' })).toEqual({ status: 429, json: { error: 'RateLimited' } });
  expect((await r.post('/gate/info', {}, { 'x-gate-pin': '4826-1937' })).status).toBe(200);
  expect(r.calls).toEqual(['/gate/checkin', '/gate/info']);
});

test('gate: global caps on wrong PINs (spread over many addresses) and on check-ins per hour', async () => {
  const r = await start({ pinFailsPerHour: 3, gatePerHour: 1 }, { gatePin: 'p' });
  for (let i = 0; i < 3; i++) await r.post('/gate/info', {}, { 'x-forwarded-for': `10.1.0.${i}`, 'x-gate-pin': 'x' });
  expect((await r.post('/gate/info', {}, { 'x-gate-pin': 'p' })).status).toBe(429);

  const s = await start({ gatePerHour: 1 }, { gatePin: 'p' });
  expect((await s.post('/gate/checkin', { raw: '{}' }, { 'x-gate-pin': 'p' })).status).toBe(200);
  expect((await s.post('/gate/checkin', { raw: '{}' }, { 'x-gate-pin': 'p' })).status).toBe(429);
});

test('limits come from the env, with defaults for anything unset or malformed', () => {
  const l = limitsFromEnv({ RELAY_FAUCET_PER_HOUR: '0', RELAY_MIN_BALANCE: '0.5', RELAY_IP_PER_MIN: 'lots' });
  expect(l.faucetPerHour).toBe(0);
  expect(l.minBalanceWei).toBe(5n * 10n ** 17n);
  expect(l.ipPerMin).toBe(defaultLimits.ipPerMin);
});

test('VND payments: starting one is capped per address and per hour; status polls have their own, wider limit', async () => {
  const r = await start({ payPerIpHour: 2, payPerHour: 3, ipPerMin: 50, readIpPerMin: 4 });
  const from = (n: number) => ({ 'cf-connecting-ip': `192.0.2.${n}` });
  expect((await r.post('/pay/create', {}, from(1))).status).toBe(200);
  expect((await r.post('/pay/create', {}, from(1))).status).toBe(200);
  expect((await r.post('/pay/create', {}, from(1))).status).toBe(429);
  expect((await r.post('/pay/payout', {}, from(2))).status).toBe(200);
  expect((await r.post('/pay/create', {}, from(3))).status).toBe(429);
  for (let i = 0; i < 4; i++) expect((await r.post('/pay/status', {}, from(1))).status).toBe(200);
  expect((await r.post('/pay/status', {}, from(1))).status).toBe(429);
  expect((await r.post('/pay/ledger', {}, from(4))).status).toBe(200);
  expect((await r.post('/mock-bank/transfer', {}, from(4))).status).toBe(200);
});

test('VND payments stop being started when the relayer is low on gas', async () => {
  const r = await start({}, { balance: 1n });
  expect(await r.post('/pay/create', {})).toEqual({ status: 503, json: { error: 'RelayerLow' } });
  expect(r.calls).toEqual([]);
});

test('payment webhook: the backend gets the body exactly as sent plus x-vg-signature; repeated bad signatures are cut off', async () => {
  const r = await start({ webhookFailsPerIp: 2 });
  const raw = '{"code":"VG1",  "amountVnd":"390000"}';
  expect(await r.post('/webhook/payment', raw, { 'x-vg-signature': 'good', 'x-forwarded-for': '198.51.100.7' })).toEqual({ status: 200, json: { ok: true, raw } });
  const bad = { 'x-vg-signature': 'bad', 'x-forwarded-for': '198.51.100.8' };
  expect((await r.post('/webhook/payment', raw, bad)).status).toBe(401);
  expect((await r.post('/webhook/payment', raw, bad)).status).toBe(401);
  expect((await r.post('/webhook/payment', raw, bad)).status).toBe(429);
  expect((await r.post('/webhook/payment', raw, { 'x-vg-signature': 'good', 'x-forwarded-for': '198.51.100.7' })).status).toBe(200);
});

test('logs hold time, address, route, status and error code only: never what a guest wrote or what the backend answered', async () => {
  const lines: string[] = [];
  const r = await start({}, { log: (l) => lines.push(l) });
  const ok = await r.post('/social/comment', { text: 'bí mật của khách' }, { 'x-forwarded-for': '198.51.100.20' });
  expect(ok.json).toMatchObject({ ip: '198.51.100.20' }); // the backend is told the client address for its own limits
  await r.post('/social/comment', { text: 'x' }, { 'x-forwarded-for': '198.51.100.21' });
  await r.post('/buy', { buyer: TO }, { 'x-forwarded-for': '198.51.100.22' });
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z 198\.51\.100\.20 \/social\/comment 200$/);
  expect(lines[1]).toMatch(/ 198\.51\.100\.21 \/social\/comment 403 NeedTicket$/);
  expect(lines[2]).toMatch(/ 198\.51\.100\.22 \/buy 200$/);
  expect(lines.join('\n')).not.toMatch(/bí mật|0x01|hash|comment":/);
});

test('likes and comments: reads share the read limit, writes are capped per address per hour', async () => {
  const r = await start({ socialPerIpHour: 2, ipPerMin: 50, readIpPerMin: 3 });
  const a = { 'x-forwarded-for': '198.51.100.30' };
  expect((await r.post('/social/like', {}, a)).status).toBe(200);
  expect((await r.post('/social/like', {}, a)).status).toBe(200);
  expect((await r.post('/social/like', {}, a)).status).toBe(429);
  expect((await r.post('/social/like', {}, { 'x-forwarded-for': '198.51.100.31' })).status).toBe(200);
  for (let i = 0; i < 3; i++) expect((await r.post('/social/feed', {}, a)).status).toBe(200);
  expect((await r.post('/social/comments', {}, a)).status).toBe(429);
});
