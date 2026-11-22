// Gas relayer for the guest app, testnet only. Sends purchases with buyFor, grants test USDC, tops up fees, and sends
// the key-less gate's check-ins (POST /gate/checkin with the x-gate-pin header).
//
//   cd app && npm run relayer                       # local anvil (.env.dev), relayer = anvil's public key #9
//   cd app && ENV_FILE=.env.fuji npm run relayer    # Fuji, relayer = GATE_KEY from ../.env.fuji (never printed)
//
// Then start the app with EXPO_PUBLIC_RELAYER_URL=http://<this machine>:8787 in its env file.
// Process env: PORT (8787), HOST (127.0.0.1; 0.0.0.0 to reach it from a phone), GATE_PIN (empty: no gate routes),
// RELAY_* / GATE_PIN_FAILS_* limits (see relay-server.ts).
// Likes and comments (social.ts): SOCIAL_FILE (JSON file; unset: memory only).
// Seller notes on resale listings (exchange.ts): EXCHANGE_FILE (JSON file; unset: memory only).
// VND payments (payments.ts): PAY_WEBHOOK_SECRET (empty: no pay routes), PAY_RECEIPTS (PaymentReceipts address, else
// EXPO_PUBLIC_RECEIPTS from the env file), PAY_LEDGER (JSON file for the reconciliation list), PAY_VND_PER_USDC (26000).
import { readFileSync } from 'node:fs';
import { errorCode } from '../src/lib';
import { createRelayer } from '../src/lib/relayer';
import type { Address, Hex } from '../src/lib/types';
import { createExchange, exchangeChain } from './exchange';
import { createPayments } from './payments';
import { createRelayServer, limitsFromEnv } from './relay-server';
import { createSocial } from './social';

const parse = (path: string): Record<string, string> => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
const env = parse(process.env.ENV_FILE ?? '.env.dev');
const chainId = Number(env.EXPO_PUBLIC_CHAIN_ID);
const ANVIL_9 = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
const key = (process.env.RELAYER_KEY ?? (chainId === 43113 ? parse('../.env.fuji').GATE_KEY : ANVIL_9)) as Hex;
const relayer = createRelayer({
  rpcUrl: env.EXPO_PUBLIC_RPC_URL, chainId, privateKey: key,
  contract: env.EXPO_PUBLIC_CONTRACT as Address, usdc: env.EXPO_PUBLIC_USDC as Address,
  receipts: ((process.env.PAY_RECEIPTS ?? env.EXPO_PUBLIC_RECEIPTS) || undefined) as Address | undefined,
}, errorCode);
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST || '127.0.0.1';
const limits = limitsFromEnv(process.env);
const gatePin = process.env.GATE_PIN ?? '';

// The webhook secret is shared with the payment gateway. This build's gateway is the mock bank in payments.ts.
const secret = process.env.PAY_WEBHOOK_SECRET ?? '';
const payments = secret
  ? createPayments({ chain: relayer.pay, secret, ledgerFile: process.env.PAY_LEDGER || undefined, rate: BigInt(process.env.PAY_VND_PER_USDC || 26_000), log: (l) => console.log(l) })
  : null;
// Likes and comments: off chain, in one JSON file (SOCIAL_FILE; unset: kept in memory only).
const social = createSocial({
  scope: { chainId, contract: env.EXPO_PUBLIC_CONTRACT as Address }, file: process.env.SOCIAL_FILE || undefined,
  eventExists: relayer.eventExists, holdsTicket: relayer.holdsTicket, log: (l) => console.log(l),
});
// Seller notes on resale listings: off chain, one JSON file (EXCHANGE_FILE; unset: memory only). Every ten minutes
// a few stored notes are checked against the chain and the ones whose listing is gone are removed.
const exchange = createExchange({
  scope: { chainId, contract: env.EXPO_PUBLIC_CONTRACT as Address }, file: process.env.EXCHANGE_FILE || undefined,
  chain: exchangeChain({ rpcUrl: env.EXPO_PUBLIC_RPC_URL, contract: env.EXPO_PUBLIC_CONTRACT as Address }),
});
setInterval(() => { exchange.sweep().catch(() => {}); }, 600_000).unref();
const backend = {
  balance: relayer.balance,
  handle: (path: string, body: unknown, extra?: { raw: string; signature?: string; ip?: string }) =>
    payments?.handles(path) ? payments.handle(path, body, extra) : social.handles(path) ? social.handle(path, body, extra?.ip) : exchange.handles(path) ? exchange.handle(path, body, extra?.ip) : relayer.handle(path, body),
};

createRelayServer({ backend, limits, gatePin, log: (l) => console.log(l) })
  .listen(port, host, () => console.log(`relayer ${relayer.address} on chain ${chainId}, ${host}:${port}, gate ${gatePin ? 'on' : 'off'}, VND payments ${payments ? 'on (mock bank)' : 'off'}, limits ${JSON.stringify(limits, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`));
