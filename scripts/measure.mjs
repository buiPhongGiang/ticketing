// Measures fee and time-to-receipt on Fuji for the main TicketBox actions, using the guest/gate test wallets.
// Run from the repo root after `cd admin && npm ci` (viem is loaded from admin/node_modules): node scripts/measure.mjs
// Spends a little test USDC and AVAX from the guest and gate wallets in .env.fuji; prints and saves measure-results.json.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(`${ROOT}admin/package.json`);
const { createPublicClient, createWalletClient, http, formatEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { avalancheFuji } = require('viem/chains');
const env = Object.fromEntries(fs.readFileSync(`${ROOT}.env.fuji`, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const abi = JSON.parse(fs.readFileSync(`${ROOT}out/TicketBox.sol/TicketBox.json`, 'utf8')).abi;
const BOX = '0x9516fd269065a17ffd5004df8141373a84161d6e';
const transport = http(env.FUJI_RPC);
const pub = createPublicClient({ chain: avalancheFuji, transport });
const acct = (k) => privateKeyToAccount(env[k]);
const A = acct('GUEST_A_KEY'), B = acct('GUEST_B_KEY'), G = acct('GATE_KEY');
const results = [];
async function run(label, account, functionName, args) {
  const w = createWalletClient({ account, chain: avalancheFuji, transport });
  const t0 = performance.now();
  const hash = await w.writeContract({ address: BOX, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  const ms = Math.round(performance.now() - t0);
  const fee = r.gasUsed * r.effectiveGasPrice;
  results.push({ label, hash, status: r.status, gas: r.gasUsed.toString(), feeAVAX: formatEther(fee), ms });
  console.log(label, r.status, hash, `${r.gasUsed} gas`, formatEther(fee), 'AVAX', `${ms} ms`);
  return r;
}
const total = await pub.readContract({ address: BOX, abi, functionName: 'totalMinted' });
await run('buy (1 GA, USDC)', A, 'buy', [0n, 0n, 1n]);
const id = total; // next token id
await run('list at cap (+10%)', A, 'list', [id, 27_500_000n]);
await run('buy resale listing', B, 'buyListing', [id, 27_500_000n]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
const signature = await B.signTypedData({ domain: { name: 'TicketBox', version: '1', chainId: 43113, verifyingContract: BOX }, types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'CheckIn', message: { tokenId: id, deadline } });
await run('gate check-in', G, 'checkIn', [id, deadline, signature]);
fs.writeFileSync(`${ROOT}measure-results.json`, JSON.stringify({ at: new Date().toISOString(), tokenId: id.toString(), results }, null, 1));
