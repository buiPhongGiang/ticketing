// Checks, right before recording or a live demo, that every beat in DEMO_FLOWS.md can run: balances, purchase
// limits, and the on-chain state each one-shot beat needs. Read-only. Exits 1 if a check fails.
// Run from the repo root: node scripts/pre-record.mjs
import fs from 'node:fs';
import { artifact, connect, loadEnv, privateKeyToAccount, ROOT, safeAbi, viem } from './lib/fuji.mjs';

const env = loadEnv();
const dep = JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment.json`, 'utf8'));
const circle = fs.existsSync(`${ROOT}docs/fuji-deployment-usdc.json`) ? JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment-usdc.json`, 'utf8')) : null;
const { pub } = connect(env);
const boxAbi = artifact('VeGoc').abi, usdcAbi = artifact('MockUSDC').abi;
const A = privateKeyToAccount(env.GUEST_A_KEY).address, B = privateKeyToAccount(env.GUEST_B_KEY).address, GATE = privateKeyToAccount(env.GATE_KEY).address;
const ORG = privateKeyToAccount(env.TICKET_ORGANIZER_KEY).address, OWNER2 = env.SAFE_OWNER_2_ADDRESS, SAFE = env.SAFE_ADDRESS;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const usd = (x) => viem.formatUnits(x, 6);
let failed = 0;
const line = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ·  ${detail}` : ''}`); };
const note = (text) => console.log(`      ${text}`);

console.log(`VeGoc ${dep.veGoc} on Fuji, ${new Date().toISOString()}\n`);

// Gas and test USDC
for (const [name, address, min] of [['Guest A', A, '0.004'], ['Guest B', B, '0.004'], ['Gate staff', GATE, '0.004'], ['Organizer / Safe owner 1', ORG, '0.002'], ['Safe owner 2', OWNER2, '0.0003']]) {
  const bal = await pub.getBalance({ address });
  line(bal >= viem.parseEther(min), `${name} has gas`, `${viem.formatEther(bal)} AVAX (needs ${min})`);
}
for (const [name, address] of [['Guest A', A], ['Guest B', B]]) {
  const bal = await read(dep.usdc, usdcAbi, 'balanceOf', [address]);
  line(bal >= 100_000000n, `${name} has test USDC`, `${usd(bal)} USDC (needs 100; "+ Test USDC" in the app gives 1,000 every 5 minutes)`);
}

const now = Number((await pub.getBlock()).timestamp);
const events = await read(dep.veGoc, boxAbi, 'getEvents');
const live = (e) => !e.data.cancelled && now < Number(e.data.endsAt);
const ticketsOf = async (who) => read(dep.veGoc, boxAbi, 'ticketsOf', [who]);
const [ticketsA, ticketsB] = await Promise.all([ticketsOf(A), ticketsOf(B)]);

// Beats 2 to 9: buy, cap, waitlist resale, gate, on the showcase event
const show = events.find((e) => live(e) && same(e.data.organizer, SAFE) && e.tiers.length > 1) ?? events.find(live);
console.log(`\nShowcase: event ${show?.id} ${show?.data.name}`);
if (!show) line(false, 'a showcase event is on sale');
else {
  const id = show.id;
  line(same(show.data.organizer, SAFE), 'the showcase event is organized by the Safe');
  for (const [name, address] of [['Guest A', A], ['Guest B', B]]) {
    const bought = await read(dep.veGoc, boxAbi, 'boughtBy', [id, address]);
    const left = show.data.maxPerWallet === 0 ? 99 : show.data.maxPerWallet - Number(bought);
    line(left >= 1, `${name} can still buy on it`, `${left} of ${show.data.maxPerWallet} purchases left`);
  }
  const listings = await read(dep.veGoc, boxAbi, 'listings', [id]);
  const gaOpen = listings.filter((l) => l.tier === 0n);
  line(gaOpen.length === 0, 'no GA listing is open (Guest B can join the GA line)', gaOpen.length ? `open: ${gaOpen.map((l) => `#${l.tokenId}`).join(', ')}; buy or unlist them first` : `${listings.length} listing(s) in other tiers`);
  line(show.waiting[0] === 0n, 'nobody is in the GA line yet (Guest B will be first)', `${show.waiting[0]} waiting`);
  line(await read(dep.veGoc, boxAbi, 'isScanner', [id, GATE]), 'the gate wallet may scan it');
  note(`sold ${show.data.issued}, checked in ${show.data.checkedIn}, resales ${show.data.resales}, float ${usd(show.principal)} USDC`);
}

// Money beat 1: cancel, refund all, balance back
const cancelable = events.filter((e) => live(e) && same(e.data.organizer, ORG) && ticketsA.some((t) => t.eventId === e.id));
line(cancelable.length > 0, 'an event to cancel on camera (organizer wallet, Guest A holds tickets)', cancelable.map((e) => `event ${e.id} ${e.data.name}: ${usd(e.principal)} USDC, Guest A holds ${ticketsA.filter((t) => t.eventId === e.id).length}, Guest B ${ticketsB.filter((t) => t.eventId === e.id).length}`).join(' | '));

// Money beat 2: settlement by two Safe owners
const settleable = events.filter((e) => !e.data.cancelled && !e.data.settled && now >= Number(e.data.endsAt) && now >= Number(e.settleAt) && same(e.data.organizer, SAFE) && e.principal > 0n);
line(settleable.length > 0, 'an ended, unsettled Safe event with the gate quorum met', settleable.map((e) => `event ${e.id} ${e.data.name}: ${usd(e.principal)} USDC, ${e.paidCheckedIn}/${e.paidSold} scanned`).join(' | '));
const [owners, threshold] = await Promise.all([read(SAFE, safeAbi, 'getOwners'), read(SAFE, safeAbi, 'getThreshold')]);
line(owners.some((o) => same(o, ORG)) && owners.some((o) => same(o, OWNER2)) && threshold === 2n, 'both console profiles are owners of the 2-of-3 Safe', `${SAFE}, threshold ${threshold} of ${owners.length}`);

// No-show (caption or slide): events inside their 48-hour hold
const noShow = events.filter((e) => !e.data.cancelled && !e.data.settled && now >= Number(e.data.endsAt) && !e.quorumMet);
note(`no-show events: ${noShow.length ? noShow.map((e) => `event ${e.id} ${e.data.name} (settle opens ${new Date(Number(e.settleAt) * 1000).toISOString().slice(0, 16)} UTC, ${now < Number(e.settleAt) ? 'locked' : 'OPEN: the 48 h are over'})`).join(' | ') : 'none'}`);

// Optional beat: a purchase with Circle's USDC on the second deployment
if (circle) {
  console.log(`\nCircle USDC deployment ${circle.veGoc}`);
  const cEvents = await read(circle.veGoc, boxAbi, 'getEvents');
  const night = cEvents.find(live);
  line(!!night, 'an event is on sale there', night ? `event ${night.id} ${night.data.name}, ${usd(night.tiers[0].price)} USDC` : '');
  const bal = await read(circle.usdc, usdcAbi, 'balanceOf', [A]);
  line(night ? bal >= night.tiers[0].price : false, 'Guest A holds Circle USDC for a ticket', `${usd(bal)} USDC`);
}

console.log(failed ? `\n${failed} check(s) failed. One-shot beats are set up again with: node scripts/fuji-seed.mjs --restage (3 minutes, then 12 until the Safe event has ended).` : '\nReady to record.');
process.exit(failed ? 1 : 0);
