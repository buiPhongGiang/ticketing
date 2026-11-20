// One run on Fuji of the two guest-facing claims, with the app's own chain layer:
//  1. A brand-new device key (never funded with AVAX) gets test USDC and buys a GA ticket for event 0 through the
//     relayer (`buyFor`). The relayer key is the GATE test wallet, standing in for the platform.
//  2. The gate (GATE key) reads its holder list, loses the network, checks the guest's QR on the device and queues the
//     entry; back online the queue is flushed as a normal check-in.
// Writes docs/fuji-offline-gate.json. Keys are read from ../.env.fuji and never printed.
//   cd app && npx vite-node scripts/fuji-offline-gate.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { createLocalSigner, createPrivateKey, createTicketService, errorCode, memoryStore, type JournalEntry, type TicketService } from '../src/lib';
import { createOfflineGate } from '../src/lib/offline';
import { createRelayer } from '../src/lib/relayer';
import type { Address, Hex } from '../src/lib/types';

const parse = (path: string): Record<string, string> => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
const app = parse('.env.fuji');
const secrets = parse('../.env.fuji');
const config = {
  chainId: Number(app.EXPO_PUBLIC_CHAIN_ID), rpcUrl: app.EXPO_PUBLIC_RPC_URL,
  contract: app.EXPO_PUBLIC_CONTRACT as Address, usdc: app.EXPO_PUBLIC_USDC as Address, nativeSymbol: 'AVAX',
};
if (config.chainId !== 43113) throw new Error('Fuji only');
const pub = createPublicClient({ transport: http(config.rpcUrl) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function final(s: TicketService, id: string): Promise<JournalEntry> {
  for (let i = 0; i < 120; i++) {
    const e = await s.lookup(id);
    if (e.state === 'succeeded' || e.state === 'reverted') return e;
    await sleep(1000);
  }
  throw new Error('timeout');
}

const relayer = createRelayer({ rpcUrl: config.rpcUrl, chainId: 43113, privateKey: secrets.GATE_KEY as Hex, contract: config.contract, usdc: config.usdc }, errorCode);
const guestSigner = createLocalSigner(createPrivateKey());
const guest = createTicketService({ config, signer: guestSigner, store: memoryStore(), relayer });
const gateService = createTicketService({ config, signer: createLocalSigner(secrets.GATE_KEY as Hex), store: memoryStore() });
const out: Record<string, unknown> = { ranAt: new Date().toISOString(), guest: guestSigner.address, relayer: relayer.address };

console.log('guest', guestSigner.address);
const f = await final(guest, (await guest.faucet()).id);
out.faucetTx = f.hash;
console.log('test USDC', f.state, f.hash);
const b = await final(guest, (await guest.buy('0', 0, 1)).id);
out.relayedBuyTx = b.hash;
console.log('relayed buy', b.state, b.hash);
if (b.state !== 'succeeded') throw new Error('buy failed');
const [ticket] = await guest.listTickets();
out.tokenId = ticket.tokenId;
out.guestAvaxAfterBuy = (await pub.getBalance({ address: guestSigner.address })).toString();

let offline = false;
const chain = new Proxy(gateService, { get: (t, k) => (offline ? async () => { throw new Error('offline'); } : (t as any)[k]) });
const gate = createOfflineGate({ store: memoryStore(), chain: chain as TicketService, scope: 'fuji' });
const snap = await gate.refresh();
out.snapshotTickets = Object.keys(snap.tickets).length;
console.log('holder list', out.snapshotTickets, 'tickets');

offline = true;
const qr = (await guest.createQr(ticket.tokenId)).encoded;
const verdict = await gate.admit(qr);
out.offlineVerdict = verdict.kind;
console.log('offline check', verdict.kind);
if (verdict.kind !== 'ok') throw new Error(`offline verdict ${verdict.kind}`);
out.secondScan = (await gate.admit(qr)).kind === 'rejected' ? 'rejected (AlreadyCheckedIn)' : 'accepted';
offline = false;
const report = await gate.flush();
const sent = (await gate.queue())[0];
const c = await final(gateService, sent.hash!);
out.flush = { sent: report.sent, conflicts: report.conflicts.length };
out.checkInTx = c.hash;
out.checkInState = c.state;
out.checkedInOnChain = (await guest.getTicket(ticket.tokenId)).checkedIn;
console.log('check-in from the queue', c.state, c.hash);
writeFileSync('../docs/fuji-offline-gate.json', `${JSON.stringify(out, null, 2)}\n`);
