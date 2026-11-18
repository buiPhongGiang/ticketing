// Creates the demo events on Avalanche Fuji and runs real activity through them, so the app and the console show a
// living night instead of an empty contract. Every step is a real transaction; the hashes are written to
// docs/fuji-run.json for the README.
//
//   0 Neon Pulse Festival   organizer = 2-of-3 Safe   ~100 tickets, 15 resales, 40 check-ins, a few listings
//   1 Saigon Indie Night    organizer wallet          a dozen tickets; left on sale so it can be cancelled on camera
//   2 Rooftop Session       organizer = Safe          ends ~30 min after seeding with the gate quorum met, unsettled
//   3 Hanoi Lantern Night   organizer wallet          cancelled, every holder refunded with one refundMany
//   4 Soundcheck Session    organizer wallet          ends with nobody scanned: no-show refunds, settle locked 48 h
//   5 Warm-up Set           organizer = Safe          ended with the quorum met and settled through the Safe
//
// Needs .env.fuji (see README), `node scripts/fuji-safe.mjs`, `./scripts/fuji-deploy.sh`, `forge build`.
// Run from the repo root: node scripts/fuji-seed.mjs    (takes about 16 minutes: it waits for events 4 and 5 to end)
import fs from 'node:fs';
import {
  appendEnv, artifact, connect, english, generateMnemonic, loadEnv, mnemonicToAccount, pool, privateKeyToAccount, retry, ROOT, safeExec, sender, sleep, viem,
} from './lib/fuji.mjs';

let env = loadEnv();
if (!env.SEED_MNEMONIC) {
  appendEnv({ SEED_MNEMONIC: `"${generateMnemonic(english)}"` }, 'Mnemonic for the sample-audience wallets used by scripts/fuji-seed.mjs (testnet only)');
  env = loadEnv();
}
const dep = JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment.json`, 'utf8'));
const BOX = dep.veGoc, USDC = dep.usdc, VAULT = dep.vault, SAFE = env.SAFE_ADDRESS;
const boxAbi = artifact('VeGoc').abi, usdcAbi = artifact('MockUSDC').abi;
const { pub, walletOf } = connect(env);
const send = sender(pub, walletOf);
const ctx = { pub, send };

const org = privateKeyToAccount(env.TICKET_ORGANIZER_KEY);
const owner2 = privateKeyToAccount(env.SAFE_OWNER_2_KEY);
const guestA = privateKeyToAccount(env.GUEST_A_KEY);
const guestB = privateKeyToAccount(env.GUEST_B_KEY);
const gate = privateKeyToAccount(env.GATE_KEY);
const crowd = Array.from({ length: 40 }, (_, i) => mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: i }));

const run = { at: new Date().toISOString(), chainId: 43113, veGoc: BOX, usdc: USDC, vault: VAULT, safe: SAFE, events: {}, txs: {}, counts: {} };
const save = () => fs.writeFileSync(`${ROOT}docs/fuji-run.json`, `${JSON.stringify(run, null, 1)}\n`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const chainNow = async () => Number((await retry(() => pub.getBlock())).timestamp);
const read = (functionName, args = []) => retry(() => pub.readContract({ address: BOX, abi: boxAbi, functionName, args }));
const U = (n) => BigInt(Math.round(n * 1e6));
const ict = (y, m, d, h, min = 0) => Math.floor(Date.UTC(y, m - 1, d, h - 7, min) / 1000); // Vietnam time, UTC+7

/** Token ids minted in a receipt (Transfer from the zero address). */
const minted = (receipt) => viem.parseEventLogs({ abi: boxAbi, logs: receipt.logs, eventName: 'Transfer' })
  .filter((l) => l.args.from === '0x0000000000000000000000000000000000000000').map((l) => l.args.tokenId);

// ------------------------------------------------------------------ 0. gas for the sample wallets

async function fundGas() {
  const need = [[owner2.address, viem.parseEther('0.001')], ...crowd.map((c) => [c.address, viem.parseEther('0.00005')])];
  const balances = await pool(need, 8, ([a]) => retry(() => pub.getBalance({ address: a })));
  const todo = need.filter(([, want], i) => balances[i] < want / 2n);
  let nonce = await pub.getTransactionCount({ address: gate.address, blockTag: 'pending' });
  const hashes = [];
  for (const [to, value] of todo) hashes.push(await retry(() => walletOf(gate).sendTransaction({ to, value, nonce: nonce++ }), 'fund'));
  await pool(hashes, 8, (hash) => retry(() => pub.waitForTransactionReceipt({ hash, timeout: 90_000 })));
  log(`gas sent to ${todo.length} wallets`);
}

async function fundUsdc() {
  await pool([...crowd, guestA, guestB], 6, async (w) => {
    const [bal, allowance] = await Promise.all([
      retry(() => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [w.address] })),
      retry(() => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'allowance', args: [w.address, BOX] })),
    ]);
    if (bal < U(600)) await send(w, USDC, usdcAbi, 'faucet');
    // The audience wallets approve once. Guest A and B keep no allowance, so the app shows the permit purchase.
    if (crowd.includes(w) && allowance < U(10_000)) await send(w, USDC, usdcAbi, 'approve', [BOX, viem.maxUint256]);
  });
  log('test USDC and approvals ready');
}

// ------------------------------------------------------------------ helpers

async function createEvent(key, viaSafe, name, venue, startsAt, endsAt, tiers) {
  const id = Number(await read('eventCount'));
  const args = [name, venue, BigInt(startsAt), BigInt(endsAt), 4, tiers.map((t) => t[0]), tiers.map((t) => U(t[1])), tiers.map((t) => t[2])];
  const created = viaSafe ? await safeExec(ctx, SAFE, org, owner2, BOX, boxAbi, 'createEvent', args) : { exec: (await send(org, BOX, boxAbi, 'createEvent', args)).hash };
  const scanner = viaSafe ? await safeExec(ctx, SAFE, owner2, org, BOX, boxAbi, 'setScanner', [BigInt(id), gate.address, true]) : { exec: (await send(org, BOX, boxAbi, 'setScanner', [BigInt(id), gate.address, true])).hash };
  run.events[key] = { id, name, organizer: viaSafe ? SAFE : org.address, startsAt, endsAt, createTx: created.exec, createApproveTx: created.approve, scannerTx: scanner.exec };
  save();
  log(`event ${id} ${name} (${viaSafe ? 'Safe' : 'wallet'})`);
  return id;
}

async function buy(w, eventId, tier, qty, price) {
  if (!crowd.includes(w)) await send(w, USDC, usdcAbi, 'approve', [BOX, U(price) * BigInt(qty)]);
  const { hash, receipt } = await send(w, BOX, boxAbi, 'buy', [BigInt(eventId), BigInt(tier), BigInt(qty)]);
  return { hash, ids: minted(receipt), holder: w };
}

async function checkIn(holder, tokenId) {
  const deadline = BigInt((await chainNow()) + 240); // the contract refuses anything more than 5 minutes ahead
  const signature = await holder.signTypedData({
    domain: { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX },
    types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'CheckIn', message: { tokenId, deadline },
  });
  return (await send(gate, BOX, boxAbi, 'checkIn', [tokenId, deadline, signature])).hash;
}

const groupBy = (items, key) => [...items.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map()).values()];

async function waitUntil(ts, what) {
  for (;;) {
    const now = await chainNow();
    if (now >= ts) return;
    log(`waiting ${ts - now}s for ${what}`);
    await sleep(Math.min(30_000, (ts - now) * 1000 + 1500));
  }
}

// ------------------------------------------------------------------ run

await fundGas();
await fundUsdc();

const neon = await createEvent('neon', true, 'Neon Pulse Festival', 'SECC Hall B, HCMC', ict(2026, 11, 19, 18), ict(2026, 12, 13, 23), [['GA', 25, 150], ['VIP', 60, 30]]);
const indie = await createEvent('indie', false, 'Saigon Indie Night', 'Soul Live Project, HCMC', ict(2026, 12, 5, 19), ict(2026, 12, 5, 23), [['GA', 15, 80]]);
let t = await chainNow();
const rooftop = await createEvent('rooftop', true, 'Rooftop Session', 'District 1, HCMC', t - 3600, t + 32 * 60, [['GA', 10, 40]]);
const lantern = await createEvent('lantern', false, 'Hanoi Lantern Night', 'Hoan Kiem, Hanoi', ict(2026, 11, 30, 19), ict(2026, 11, 30, 23), [['GA', 20, 60]]);
t = await chainNow();
const soundcheck = await createEvent('soundcheck', false, 'Soundcheck Session', 'Thao Dien, HCMC', t - 1800, t + 9 * 60, [['GA', 10, 30]]);
t = await chainNow();
const warmup = await createEvent('warmup', true, 'Warm-up Set', 'Binh Thanh, HCMC', t - 3600, t + 13 * 60, [['GA', 10, 30]]);

// --- 4 Soundcheck: four tickets, nobody scanned
const sc = await pool([crowd[0], crowd[1], crowd[2], guestA], 4, (w) => buy(w, soundcheck, 0, 1, 10));
run.txs.noShowBuy = sc[0].hash;

// --- 5 Warm-up: six tickets, four scanned (67 %, above the 20 % quorum)
const wu = await pool(crowd.slice(3, 9), 6, (w) => buy(w, warmup, 0, 1, 10));
for (const b of wu.slice(0, 4)) run.txs.warmupCheckIn = await checkIn(b.holder, b.ids[0]);
log('warm-up: 6 sold, 4 scanned');

// --- 2 Rooftop: fifteen tickets, nine scanned; left unsettled for the console
const rt = await pool([...crowd.slice(9, 21), guestA], 6, (w, i) => buy(w, rooftop, 0, i % 4 === 0 && w !== guestA ? 2 : 1, 10));
for (const b of rt.filter((b) => b.holder !== guestA).slice(0, 9)) await checkIn(b.holder, b.ids[0]);
log(`rooftop: ${rt.reduce((n, b) => n + b.ids.length, 0)} sold, 9 scanned`);

// --- 3 Lantern: five tickets, cancelled, everyone refunded in one transaction
const ln = [await buy(guestA, lantern, 0, 2, 20), await buy(guestB, lantern, 0, 1, 20), ...(await pool(crowd.slice(21, 23), 2, (w) => buy(w, lantern, 0, 1, 20)))];
run.txs.cancelBuy = ln[0].hash;
run.txs.cancel = (await send(org, BOX, boxAbi, 'cancelEvent', [BigInt(lantern)])).hash;
const lanternIds = ln.flatMap((b) => b.ids);
const refund = await send(org, BOX, boxAbi, 'refundMany', [lanternIds]);
run.txs.refundMany = refund.hash;
run.counts.refundMany = { tickets: lanternIds.length, gas: refund.receipt.gasUsed.toString() };
run.txs.cancelYield = (await send(org, BOX, boxAbi, 'settle', [BigInt(lantern), org.address])).hash;
save();
log('lantern: cancelled and refunded');

// --- 1 Indie: twelve tickets, one listed
const ind = [await buy(guestA, indie, 0, 2, 15), await buy(guestB, indie, 0, 1, 15), ...(await pool(crowd.slice(23, 30), 6, (w, i) => buy(w, indie, 0, i < 2 ? 2 : 1, 15)))];
await send(ind[2].holder, BOX, boxAbi, 'list', [ind[2].ids[0], U(15.75)]);
log(`indie: ${ind.reduce((n, b) => n + b.ids.length, 0)} sold`);

// --- 0 Neon Pulse: the lively one
const qty = [4, 3, 2, 3, 1, 4, 2, 3, 4, 2, 3, 1];
const np = await pool(crowd.slice(0, 36), 6, (w, i) => (i % 6 === 5 ? buy(w, neon, 1, 2, 60) : buy(w, neon, 0, qty[i % qty.length], 25)));
run.txs.neonBuy = np[0].hash;
const tickets = np.flatMap((b, i) => b.ids.map((id) => ({ id, holder: b.holder, vip: i % 6 === 5 })));
log(`neon: ${tickets.length} sold`);

// 19 listings between face value and the cap; 15 are bought by four other wallets, 4 stay listed
const marks = [10, 10, 8, 10, 5, 10, 0, 10, 8, 10, 4, 10, 10, 6, 10, 10, 2, 10, 8];
const forSale = tickets.filter((_, i) => i % 5 === 1).slice(0, marks.length);
forSale.forEach((tk, i) => { const face = U(tk.vip ? 60 : 25); tk.price = face + (face * BigInt(marks[i])) / 100n; });
// One wallet sends its transactions one after another; different wallets run side by side.
await pool(groupBy(forSale, (tk) => tk.holder.address), 6, async (mine) => {
  for (const tk of mine) tk.listTx = (await send(tk.holder, BOX, boxAbi, 'list', [tk.id, tk.price])).hash;
});
run.txs.neonList = forSale[0].listTx;
const buyers = crowd.slice(36, 40);
await pool(buyers, 4, async (buyer, b) => {
  for (const tk of forSale.slice(0, 15).filter((_, i) => i % buyers.length === b)) {
    tk.resaleTx = (await send(buyer, BOX, boxAbi, 'buyListing', [tk.id, tk.price])).hash;
    tk.holder = buyer;
  }
});
run.txs.neonResale = forSale[0].resaleTx;
log('neon: 15 resales, 4 listed');

// 40 holders walk in; each scan carries a signature made by the wallet that holds the ticket right now
const listed = new Set(forSale.slice(15).map((tk) => tk.id));
const scanned = tickets.filter((tk) => !listed.has(tk.id)).filter((_, i) => i % 5 !== 4).slice(0, 40);
for (const tk of scanned) run.txs.neonCheckIn = await checkIn(tk.holder, tk.id);
run.counts.neon = { sold: tickets.length, resales: 15, listed: 4, checkedIn: scanned.length };
save();
log('neon: 40 scanned');

// --- 4 Soundcheck after the end: a no-show
await waitUntil(run.events.soundcheck.endsAt + 2, 'Soundcheck Session to end');
run.txs.noShowClaim = (await send(sc[0].holder, BOX, boxAbi, 'claimRefund', [sc[0].ids[0]])).hash;
run.txs.noShowPushedByBystander = (await send(crowd[30], BOX, boxAbi, 'refundMany', [[sc[1].ids[0]]])).hash;
try {
  await pub.simulateContract({ address: BOX, abi: boxAbi, functionName: 'settle', args: [BigInt(soundcheck), org.address], account: org.address });
  run.counts.noShowSettle = 'UNEXPECTED: settle did not revert';
} catch (e) {
  run.counts.noShowSettle = String(e.cause?.data?.errorName ?? e.shortMessage ?? e.message).slice(0, 120);
}
run.counts.noShow = { sold: 4, scanned: 0, refunded: 2, stillRefundable: sc.slice(2).map((b) => Number(b.ids[0])), settleOpensAt: Number(await read('settleOpensAt', [BigInt(soundcheck)])) };
save();
log(`soundcheck: no-show refunds done; settle answers "${run.counts.noShowSettle}"`);

// --- 5 Warm-up after the end: quorum met, the Safe settles (owner 1 approves, owner 2 executes)
await waitUntil(run.events.warmup.endsAt + 2, 'Warm-up Set to end');
const before = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [SAFE] });
const settled = await safeExec(ctx, SAFE, org, owner2, BOX, boxAbi, 'settle', [BigInt(warmup), SAFE]);
const [log0] = viem.parseEventLogs({ abi: boxAbi, logs: settled.receipt.logs, eventName: 'Settled' });
run.txs.safeSettleApprove = settled.approve;
run.txs.safeSettleExecute = settled.exec;
run.counts.safeSettle = {
  principalToOrganizer: log0.args.principal.toString(), fee: log0.args.fee.toString(), yieldPaid: log0.args.yieldPaid.toString(),
  safeUsdcBefore: before.toString(), safeUsdcAfter: (await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [SAFE] })).toString(),
};
run.finishedAt = new Date().toISOString();
save();
log('warm-up: settled through the Safe. Done.');
