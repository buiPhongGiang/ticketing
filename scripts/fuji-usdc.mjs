// Runs the second Fuji deployment, the one that takes Circle's real USDC
// (0x5425890298aed601595a70AB815c96711a31Bc65) instead of the mock. Circle's faucet needs a browser, so the test USDC
// comes from a swap of test AVAX on Pangolin's Fuji pool; tickets cost 0.05 USDC because that pool is small.
// Every purchase goes through Circle's own EIP-2612 permit (EIP-712 version "2").
//
//   event 0  Circle USDC Night     6 Dec, after Demo Day; left on sale so a purchase with the real token can be shown
//   event 1  Circle USDC Session   ends after 10 minutes: purchase, capped resale, check-in, settlement with the 3 % fee
//
// It also records what a purchase costs in gas with Circle's token: the first one ever on the deployment (cold
// storage) and later ones (warm), which is the number to compare with the mock.
//
// Before: USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65 ENV_SUFFIX=-usdc ./scripts/fuji-deploy.sh
// Run from the repo root: node scripts/fuji-usdc.mjs      (about 12 minutes: it waits for event 1 to end)
import fs from 'node:fs';
import { artifact, connect, loadEnv, privateKeyToAccount, retry, ROOT, sender, sleep, viem } from './lib/fuji.mjs';

const env = loadEnv();
const dep = JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment-usdc.json`, 'utf8'));
const BOX = dep.veGoc, USDC = dep.usdc, VAULT = dep.vault;
const boxAbi = artifact('VeGoc').abi, vaultAbi = artifact('FloatVault').abi;
const usdcAbi = viem.parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function nonces(address) view returns (uint256)', 'function name() view returns (string)',
  'function version() view returns (string)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)',
]);
const PANGOLIN_ROUTER = '0x2D99ABD9008Dc933ff5c0CD271B88309593aB921';
const routerAbi = viem.parseAbi([
  'function WAVAX() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactAVAXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
]);
const { pub, walletOf } = connect(env);
const send = sender(pub, walletOf);
const org = privateKeyToAccount(env.TICKET_ORGANIZER_KEY);
const A = privateKeyToAccount(env.GUEST_A_KEY), B = privateKeyToAccount(env.GUEST_B_KEY), gate = privateKeyToAccount(env.GATE_KEY);
const PRICE = 50_000n, CAP = 55_000n; // 0.05 USDC, +10 %
const run = { at: new Date().toISOString(), chainId: 43113, veGoc: BOX, usdc: USDC, vault: VAULT, priceUsdc: '0.05', events: {}, txs: {}, gas: {}, counts: {} };
const save = () => fs.writeFileSync(`${ROOT}docs/fuji-run-usdc.json`, `${JSON.stringify(run, null, 1)}\n`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const now = async () => Number((await retry(() => pub.getBlock())).timestamp);
const usdcOf = (a) => retry(() => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] }));
const ict = (y, m, d, h) => Math.floor(Date.UTC(y, m - 1, d, h - 7) / 1000);
const [tokenName, tokenVersion] = await Promise.all([
  pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'name' }), pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'version' }),
]);
run.token = { name: tokenName, permitVersion: tokenVersion };

/** Circle's EIP-2612 permit for `value`, spent by VeGoc. */
async function permit(owner, value) {
  const deadline = BigInt((await now()) + 1200);
  const nonce = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'nonces', args: [owner.address] });
  const sig = await owner.signTypedData({
    domain: { name: tokenName, version: tokenVersion, chainId: 43113, verifyingContract: USDC },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', message: { owner: owner.address, spender: BOX, value, nonce, deadline },
  });
  const { r, s, v, yParity } = viem.parseSignature(sig);
  return [deadline, Number(v ?? BigInt(yParity + 27)), r, s];
}
async function buy(w, eventId, qty) {
  const r = await send(w, BOX, boxAbi, 'buyWithPermit', [BigInt(eventId), 0n, BigInt(qty), ...(await permit(w, PRICE * BigInt(qty)))]);
  return { hash: r.hash, gas: Number(r.receipt.gasUsed), ids: viem.parseEventLogs({ abi: boxAbi, logs: r.receipt.logs, eventName: 'Transfer' }).map((l) => l.args.tokenId) };
}
async function checkIn(holder, tokenId) {
  const deadline = BigInt((await now()) + 240);
  const signature = await holder.signTypedData({
    domain: { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX },
    types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'CheckIn', message: { tokenId, deadline },
  });
  // Sent by the organizer wallet, which is a scanner here too, so this script can run while the gate wallet is busy.
  return send(org, BOX, boxAbi, 'checkIn', [tokenId, deadline, signature]);
}

// 1. Test USDC without a faucet login: swap test AVAX on Pangolin (Fuji) when the wallets run low.
if ((await usdcOf(A.address)) + (await usdcOf(B.address)) + (await usdcOf(org.address)) < 450_000n) {
  const wavax = await pub.readContract({ address: PANGOLIN_ROUTER, abi: routerAbi, functionName: 'WAVAX' });
  const amountIn = viem.parseEther('0.02');
  const [, out] = await pub.readContract({ address: PANGOLIN_ROUTER, abi: routerAbi, functionName: 'getAmountsOut', args: [amountIn, [wavax, USDC]] });
  const swap = await send(B, PANGOLIN_ROUTER, routerAbi, 'swapExactAVAXForTokens', [(out * 95n) / 100n, [wavax, USDC], B.address, BigInt((await now()) + 600)], { value: amountIn });
  run.txs.swapAvaxForUsdc = swap.hash;
  log(`swapped 0.02 AVAX for USDC on Pangolin`);
}
if ((await usdcOf(A.address)) < 120_000n) run.txs.fundGuestA = (await send(org, USDC, usdcAbi, 'transfer', [A.address, 150_000n])).hash;

// 2. Two events; the organizer wallet funds each event's mock-yield reserve with 0.005 USDC.
async function createEvent(key, name, startsAt, endsAt, supply) {
  const id = Number(await pub.readContract({ address: BOX, abi: boxAbi, functionName: 'eventCount' }));
  const createTx = (await send(org, BOX, boxAbi, 'createEvent', [name, 'Fuji', BigInt(startsAt), BigInt(endsAt), 4, ['GA'], [PRICE], [supply]])).hash;
  const scannerTx = (await send(org, BOX, boxAbi, 'setScanner', [BigInt(id), gate.address, true])).hash;
  await send(org, BOX, boxAbi, 'setScanner', [BigInt(id), org.address, true]);
  const reserveTx = (await send(org, VAULT, vaultAbi, 'fundReserve', [BigInt(id), 5_000n])).hash;
  run.events[key] = { id, name, startsAt, endsAt, createTx, scannerTx, reserveTx };
  save();
  return id;
}
await send(org, USDC, usdcAbi, 'approve', [VAULT, 10_000n]);
const night = await createEvent('night', 'Circle USDC Night', ict(2026, 12, 6, 19), ict(2026, 12, 6, 23), 200);
const t = await now();
const session = await createEvent('session', 'Circle USDC Session', t - 600, t + 10 * 60, 20);
log(`events ${night} and ${session} created`);

// 3. Purchases with Circle's permit. The first ever on this deployment pays for cold storage; the next ones are
//    what a purchase costs once the event has sales.
const first = await buy(B, session, 2);
const second = await buy(A, session, 1);
const third = await buy(B, night, 1);
run.txs.buyWithPermit = first.hash;
run.txs.buyWithPermitWarm = second.hash;
run.txs.buyOnTheLongEvent = third.hash;
run.gas = { firstPurchaseEverTwoTickets: first.gas, purchaseOneTicketWarmEvent: second.gas, firstPurchaseOfAnEventOneTicket: third.gas };

// 4. Capped resale: 0.055 is the cap; Guest A buys with a permit of his own.
const list = await send(B, BOX, boxAbi, 'list', [first.ids[0], CAP]);
run.txs.list = list.hash;
const resale = await send(A, BOX, boxAbi, 'buyListingWithPermit', [first.ids[0], CAP, ...(await permit(A, CAP))]);
run.txs.buyListingWithPermit = resale.hash;
run.gas.resaleWithPermit = Number(resale.receipt.gasUsed);

// 5. Gate: two of the three tickets are scanned, each with its holder's signature.
const scan = await checkIn(A, first.ids[0]);
run.txs.checkIn = scan.hash;
run.gas.checkIn = Number(scan.receipt.gasUsed);
await checkIn(A, second.ids[0]);
save();
log('bought, resold, checked in');

// 6. After the end: 2 of 3 paid tickets scanned, so the organizer settles at once; 3 % goes to the Safe in real USDC.
const endsAt = run.events.session.endsAt;
for (let n = await now(); n < endsAt + 2; n = await now()) { log(`waiting ${endsAt + 2 - n}s for the event to end`); await sleep(Math.min(30_000, (endsAt + 2 - n) * 1000 + 1500)); }
const safeBefore = await usdcOf(dep.feeRecipient), orgBefore = await usdcOf(org.address);
const settled = await send(org, BOX, boxAbi, 'settle', [BigInt(session), org.address]);
const [ev] = viem.parseEventLogs({ abi: boxAbi, logs: settled.receipt.logs, eventName: 'Settled' });
run.txs.settle = settled.hash;
run.counts.settle = {
  principalToOrganizer: ev.args.principal.toString(), fee: ev.args.fee.toString(), yieldPaid: ev.args.yieldPaid.toString(),
  safeGained: ((await usdcOf(dep.feeRecipient)) - safeBefore).toString(), organizerGained: ((await usdcOf(org.address)) - orgBefore).toString(),
};
// Leave Guest A with enough of Circle's USDC for a few purchases on camera.
if ((await usdcOf(A.address)) < 200_000n) run.txs.topUpGuestA = (await send(org, USDC, usdcAbi, 'transfer', [A.address, 150_000n])).hash;
run.counts.balances = { guestA: (await usdcOf(A.address)).toString(), guestB: (await usdcOf(B.address)).toString(), organizer: (await usdcOf(org.address)).toString() };
run.finishedAt = new Date().toISOString();
save();
log('settled in Circle USDC. Done.');
