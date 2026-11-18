// Runs one event from sale to settlement on the second Fuji deployment, the one that takes Circle's real USDC
// (0x5425890298aed601595a70AB815c96711a31Bc65) instead of the mock. Circle's faucet needs a browser, so the test USDC
// comes from a swap of test AVAX on Pangolin's Fuji pool; prices are in cents because that pool is small.
// Every purchase goes through Circle's own EIP-2612 permit (EIP-712 version "2").
//
// Before: USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65 ENV_SUFFIX=-usdc ./scripts/fuji-deploy.sh
// Run from the repo root: node scripts/fuji-usdc.mjs      (about 12 minutes: it waits for the event to end)
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
const run = { at: new Date().toISOString(), chainId: 43113, veGoc: BOX, usdc: USDC, vault: VAULT, txs: {}, counts: {} };
const save = () => fs.writeFileSync(`${ROOT}docs/fuji-run-usdc.json`, `${JSON.stringify(run, null, 1)}\n`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const now = async () => Number((await retry(() => pub.getBlock())).timestamp);
const usdcOf = (a) => retry(() => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] }));
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

// 1. Test USDC without a faucet login: swap test AVAX on Pangolin (Fuji).
if ((await usdcOf(B.address)) < 400_000n) {
  const wavax = await pub.readContract({ address: PANGOLIN_ROUTER, abi: routerAbi, functionName: 'WAVAX' });
  const amountIn = viem.parseEther('0.03');
  const [, out] = await pub.readContract({ address: PANGOLIN_ROUTER, abi: routerAbi, functionName: 'getAmountsOut', args: [amountIn, [wavax, USDC]] });
  const swap = await send(B, PANGOLIN_ROUTER, routerAbi, 'swapExactAVAXForTokens', [(out * 95n) / 100n, [wavax, USDC], B.address, BigInt((await now()) + 600)], { value: amountIn });
  run.txs.swapAvaxForUsdc = swap.hash;
  log(`swapped 0.03 AVAX for ${viem.formatUnits(await usdcOf(B.address), 6)} USDC on Pangolin`);
}
run.counts.guestBUsdc = (await usdcOf(B.address)).toString();

// 2. Event: GA 0.10 USDC, ends in 11 minutes. Mock yield reserve: 0.05 USDC from Guest B.
const t = await now();
const eventId = Number(await pub.readContract({ address: BOX, abi: boxAbi, functionName: 'eventCount' }));
run.txs.createEvent = (await send(org, BOX, boxAbi, 'createEvent', ['Circle USDC Night', 'Fuji', BigInt(t - 600), BigInt(t + 11 * 60), 4, ['GA'], [100_000n], [20]])).hash;
run.txs.setScanner = (await send(org, BOX, boxAbi, 'setScanner', [BigInt(eventId), gate.address, true])).hash;
await send(B, USDC, usdcAbi, 'approve', [VAULT, 50_000n]);
run.txs.fundReserve = (await send(B, VAULT, vaultAbi, 'fundReserve', [50_000n])).hash;
run.eventId = eventId;
save();
log(`event ${eventId} created, reserve funded`);

// 3. Guest B buys two tickets in one transaction each way: permit + purchase.
const bought = await send(B, BOX, boxAbi, 'buyWithPermit', [BigInt(eventId), 0n, 2n, ...(await permit(B, 200_000n))]);
run.txs.buyWithPermit = bought.hash;
run.counts.buyGas = bought.receipt.gasUsed.toString();
const [first] = viem.parseEventLogs({ abi: boxAbi, logs: bought.receipt.logs, eventName: 'Transfer' }).map((l) => l.args.tokenId);

// 4. Capped resale: 0.11 is the cap; Guest A buys with a permit of his own.
run.txs.list = (await send(B, BOX, boxAbi, 'list', [first, 110_000n])).hash;
run.txs.fundGuestA = (await send(B, USDC, usdcAbi, 'transfer', [A.address, 150_000n])).hash;
run.txs.buyListingWithPermit = (await send(A, BOX, boxAbi, 'buyListingWithPermit', [first, 110_000n, ...(await permit(A, 110_000n))])).hash;

// 5. Gate: the new holder's signature.
const deadline = BigInt((await now()) + 240);
const signature = await A.signTypedData({
  domain: { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX },
  types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'CheckIn', message: { tokenId: first, deadline },
});
run.txs.checkIn = (await send(gate, BOX, boxAbi, 'checkIn', [first, deadline, signature])).hash;
save();
log('bought, resold, checked in');

// 6. After the end: 1 of 2 paid tickets scanned, so the organizer settles at once; 3 % goes to the Safe in real USDC.
const endsAt = t + 11 * 60;
for (let n = await now(); n < endsAt + 2; n = await now()) { log(`waiting ${endsAt + 2 - n}s for the event to end`); await sleep(Math.min(30_000, (endsAt + 2 - n) * 1000 + 1500)); }
const safeBefore = await usdcOf(dep.feeRecipient), orgBefore = await usdcOf(org.address);
const settled = await send(org, BOX, boxAbi, 'settle', [BigInt(eventId), org.address]);
const [ev] = viem.parseEventLogs({ abi: boxAbi, logs: settled.receipt.logs, eventName: 'Settled' });
run.txs.settle = settled.hash;
run.counts.settle = {
  principalToOrganizer: ev.args.principal.toString(), fee: ev.args.fee.toString(), yieldPaid: ev.args.yieldPaid.toString(),
  safeGained: ((await usdcOf(dep.feeRecipient)) - safeBefore).toString(), organizerGained: ((await usdcOf(org.address)) - orgBefore).toString(),
};
run.finishedAt = new Date().toISOString();
save();
log('settled in Circle USDC. Done.');
