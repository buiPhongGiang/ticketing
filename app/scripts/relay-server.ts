// HTTP front of the relayer, with the limits that keep strangers from draining it once it sits on a public domain.
// Testnet only. Everything here is in memory: a restart clears the counters.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { parseEther } from 'viem';
import { exchangeRoute, ipBucket } from './exchange';

export interface Limits {
  /** Requests per client IP per minute, every route but the gate's. */
  ipPerMin: number;
  /** Per client IP per hour. */
  faucetPerIpHour: number;
  topUpPerIpHour: number;
  /** Whole relayer, per hour. */
  faucetPerHour: number;
  topUpPerHour: number;
  buyPerHour: number;
  gatePerHour: number;
  /** Gate requests per client IP per minute, once the PIN is right (a busy door scans often). */
  gateIpPerMin: number;
  /** Wrong gate PINs per client IP per 15 minutes, and for everyone per hour, before the gate stops answering. */
  pinFailsPerIp: number;
  pinFailsPerHour: number;
  /** Below this native balance (wei) the relayer refuses faucet and top-up, so purchases and the gate keep working. */
  minBalanceWei: bigint;
  /** Largest request body, bytes. */
  maxBody: number;
  /** VND payments started (and payouts recorded) per client IP per hour, and by everyone per hour. */
  payPerIpHour: number;
  payPerHour: number;
  /** Status polls and ledger reads per client IP per minute. */
  readIpPerMin: number;
  /** Webhook calls with a wrong signature per client IP per 15 minutes before the webhook stops answering it. */
  webhookFailsPerIp: number;
  /** Likes and comments written per client IP per hour (each account has its own, tighter limit in social.ts). */
  socialPerIpHour: number;
}

export const defaultLimits: Limits = {
  ipPerMin: 20, faucetPerIpHour: 3, topUpPerIpHour: 10,
  faucetPerHour: 30, topUpPerHour: 60, buyPerHour: 120, gatePerHour: 600, gateIpPerMin: 60,
  pinFailsPerIp: 5, pinFailsPerHour: 50, minBalanceWei: parseEther('0.02'), maxBody: 4096,
  payPerIpHour: 20, payPerHour: 200, readIpPerMin: 90, webhookFailsPerIp: 10, socialPerIpHour: 120,
};

/** RELAY_* variables override the defaults (RELAY_MIN_BALANCE in AVAX, e.g. 0.02). */
export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  const n = (name: string, d: number) => {
    const v = Number(env[name]);
    return env[name] !== undefined && env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : d;
  };
  const d = defaultLimits;
  return {
    ipPerMin: n('RELAY_IP_PER_MIN', d.ipPerMin),
    faucetPerIpHour: n('RELAY_FAUCET_PER_IP_HOUR', d.faucetPerIpHour),
    topUpPerIpHour: n('RELAY_TOPUP_PER_IP_HOUR', d.topUpPerIpHour),
    faucetPerHour: n('RELAY_FAUCET_PER_HOUR', d.faucetPerHour),
    topUpPerHour: n('RELAY_TOPUP_PER_HOUR', d.topUpPerHour),
    buyPerHour: n('RELAY_BUY_PER_HOUR', d.buyPerHour),
    gatePerHour: n('RELAY_GATE_PER_HOUR', d.gatePerHour),
    gateIpPerMin: n('RELAY_GATE_IP_PER_MIN', d.gateIpPerMin),
    pinFailsPerIp: n('GATE_PIN_FAILS_PER_IP', d.pinFailsPerIp),
    pinFailsPerHour: n('GATE_PIN_FAILS_PER_HOUR', d.pinFailsPerHour),
    minBalanceWei: env.RELAY_MIN_BALANCE ? parseEther(env.RELAY_MIN_BALANCE as `${number}`) : d.minBalanceWei,
    maxBody: n('RELAY_MAX_BODY', d.maxBody),
    payPerIpHour: n('RELAY_PAY_PER_IP_HOUR', d.payPerIpHour),
    payPerHour: n('RELAY_PAY_PER_HOUR', d.payPerHour),
    readIpPerMin: n('RELAY_READ_IP_PER_MIN', d.readIpPerMin),
    webhookFailsPerIp: n('RELAY_WEBHOOK_FAILS_PER_IP', d.webhookFailsPerIp),
    socialPerIpHour: n('RELAY_SOCIAL_PER_IP_HOUR', d.socialPerIpHour),
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.trim() || undefined;

/**
 * The address limits are counted against. Forwarding headers are believed only when the connection comes from this
 * machine (Caddy, cloudflared): CF-Connecting-IP first, else the last X-Forwarded-For hop, the one our proxy added.
 */
export function clientIp(remote: string | undefined, headers: IncomingHttpHeaders): string {
  const peer = remote ?? 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  const cf = one(headers['cf-connecting-ip']);
  if (cf) return cf;
  const xff = one(headers['x-forwarded-for'])?.split(',').map((s) => s.trim()).filter(Boolean);
  return xff?.length ? xff[xff.length - 1] : peer;
}

/** Fixed-window counters keyed by string. */
export function createCounters(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; ms: number; count: number }>();
  const live = (key: string, ms: number) => {
    let w = windows.get(key);
    if (!w || now() - w.start >= w.ms) {
      if (windows.size > 50_000) for (const [k, x] of windows) if (now() - x.start >= x.ms) windows.delete(k);
      w = { start: now(), ms, count: 0 };
      windows.set(key, w);
    }
    return w;
  };
  return {
    /** Counts one hit; false (and not counted) if the window is already full. */
    take(key: string, limit: number, ms: number): boolean {
      const w = live(key, ms);
      if (w.count >= limit) return false;
      w.count++;
      return true;
    },
    count: (key: string, ms: number) => live(key, ms).count,
    add: (key: string, ms: number) => { live(key, ms).count++; },
  };
}

export interface RelayBackend {
  /** `extra` carries what a signed webhook needs: the body exactly as sent and its x-vg-signature header. */
  handle(path: string, body: unknown, extra?: { raw: string; signature?: string; ip?: string }): Promise<{ status: number; json: unknown }>;
  /** The relayer's native balance in wei. */
  balance(): Promise<bigint>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const digest = (s: string) => createHash('sha256').update(s).digest();

export function createRelayServer({ backend, limits = defaultLimits, gatePin = '', now = Date.now, log = () => {} }: {
  backend: RelayBackend; limits?: Limits; gatePin?: string; now?: () => number; log?: (line: string) => void;
}): Server {
  const counters = createCounters(now);
  const pinDigest = gatePin ? digest(gatePin) : null;

  /** null: go ahead. Otherwise the refusal to send. */
  async function gateCheck(path: string, ip: string, headers: IncomingHttpHeaders): Promise<{ status: number; error: string } | null> {
    const busy = { status: 429, error: 'RateLimited' };
    if (path === '/faucet' || path === '/top-up' || path === '/buy') {
      if (!counters.take(`ip:${ip}`, limits.ipPerMin, MIN)) return busy;
    }
    if (path === '/faucet' || path === '/top-up') {
      if ((await backend.balance()) < limits.minBalanceWei) return { status: 503, error: 'RelayerLow' };
      const [perIp, all] = path === '/faucet' ? [limits.faucetPerIpHour, limits.faucetPerHour] : [limits.topUpPerIpHour, limits.topUpPerHour];
      if (counters.count(`g:${path}`, HOUR) >= all) return busy;
      if (!counters.take(`${path}:${ip}`, perIp, HOUR)) return busy;
      counters.add(`g:${path}`, HOUR);
      return null;
    }
    if (path === '/buy') return counters.take('g:/buy', limits.buyPerHour, HOUR) ? null : busy;
    // A started payment ends in relayer transactions (float, purchase, receipt), so it is capped like the faucet.
    if (path === '/pay/create' || path === '/pay/payout') {
      if (!counters.take(`ip:${ip}`, limits.ipPerMin, MIN)) return busy;
      if ((await backend.balance()) < limits.minBalanceWei) return { status: 503, error: 'RelayerLow' };
      if (counters.count('g:/pay', HOUR) >= limits.payPerHour) return busy;
      if (!counters.take(`/pay:${ip}`, limits.payPerIpHour, HOUR)) return busy;
      counters.add('g:/pay', HOUR);
      return null;
    }
    if (path === '/social/feed' || path === '/social/comments') return counters.take(`read:${ip}`, limits.readIpPerMin, MIN) ? null : busy;
    if (path === '/social/like' || path === '/social/comment') {
      if (!counters.take(`ip:${ip}`, limits.ipPerMin, MIN)) return busy;
      return counters.take(`/social:${ip}`, limits.socialPerIpHour, HOUR) ? null : busy;
    }
    if (path === '/pay/status' || path === '/pay/ledger') return counters.take(`read:${ip}`, limits.readIpPerMin, MIN) ? null : busy;
    // Seller notes on resale listings (exchange.ts): the read like the feed, the write like likes and comments.
    // An IPv6 client is counted by its /64, so one subscriber cannot show up as a new address for every request.
    const exchange = exchangeRoute(path);
    if (exchange === 'read') return counters.take(`read:${ipBucket(ip)}`, limits.readIpPerMin, MIN) ? null : busy;
    if (exchange === 'write') {
      if (!counters.take(`ip:${ipBucket(ip)}`, limits.ipPerMin, MIN)) return busy;
      return counters.take(`/social:${ipBucket(ip)}`, limits.socialPerIpHour, HOUR) ? null : busy;
    }
    if (path === '/mock-bank/transfer') return counters.take(`ip:${ip}`, limits.ipPerMin, MIN) ? null : busy;
    // The webhook is authenticated by its signature, checked by the backend; here only repeated bad ones are cut off.
    if (path === '/webhook/payment') return counters.count(`hookfail:${ip}`, 15 * MIN) >= limits.webhookFailsPerIp ? busy : null;
    if (path === '/gate/info' || path === '/gate/checkin') {
      if (!pinDigest) return { status: 404, error: 'Unknown' };
      if (counters.count(`pinfail:${ip}`, 15 * MIN) >= limits.pinFailsPerIp || counters.count('g:pinfail', HOUR) >= limits.pinFailsPerHour) return busy;
      const pin = one(headers['x-gate-pin']) ?? '';
      if (!timingSafeEqual(digest(pin), pinDigest)) {
        counters.add(`pinfail:${ip}`, 15 * MIN);
        counters.add('g:pinfail', HOUR);
        return { status: 401, error: 'GatePin' };
      }
      if (!counters.take(`gate:${ip}`, limits.gateIpPerMin, MIN)) return busy;
      if (path === '/gate/checkin' && !counters.take('g:/gate', limits.gatePerHour, HOUR)) return busy;
      return null;
    }
    // Unknown routes still count against the address, so probing costs the same as using.
    if (!counters.take(`ip:${ip}`, limits.ipPerMin, MIN)) return busy;
    return { status: 404, error: 'Unknown' };
  }

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-gate-pin, x-vg-signature');
    const send = (status: number, json: unknown) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json)); };
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST') { send(404, { error: 'Unknown' }); return; }
    if (Number(req.headers['content-length'] ?? 0) > limits.maxBody) { send(413, { error: 'Unknown' }); req.resume(); return; }
    const path = (req.url ?? '').split('?')[0];
    const ip = clientIp(req.socket.remoteAddress, req.headers);
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      body += c;
      if (body.length > limits.maxBody) { tooBig = true; send(413, { error: 'Unknown' }); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const refused = await gateCheck(path, ip, req.headers);
        let out: { status: number; json: unknown };
        if (refused) out = { status: refused.status, json: { error: refused.error } };
        else {
          let json: unknown = null;
          try { json = JSON.parse(body || 'null'); } catch {}
          out = await backend.handle(path, json, { raw: body, signature: one(req.headers['x-vg-signature']), ip });
          if (path === '/webhook/payment' && out.status === 401) counters.add(`hookfail:${ip}`, 15 * MIN);
        }
        // Never the body: it can hold what a guest wrote, a bank code or a salt. Time, address, route, status, error code.
        const code = (out.json as { error?: unknown } | null)?.error;
        log(`${new Date(now()).toISOString()} ${ip} ${path} ${out.status}${typeof code === 'string' && /^[A-Za-z]{1,40}$/.test(code) ? ` ${code}` : ''}`);
        send(out.status, out.json);
      } catch {
        send(500, { error: 'Unknown' });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
