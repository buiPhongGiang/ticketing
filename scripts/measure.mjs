// Measures gas, fee and time for the four main actions on Avalanche Fuji, three rounds, and writes
// docs/fuji-measure.json. Each transaction is signed first; the clock starts when it is sent.
//   "in block"  = the block's own millisecond timestamp (Avalanche blocks carry `timestampMilliseconds`) minus the send time
//   "receipt"   = the moment this script held the receipt, polling a public RPC every 100 ms
// Fresh wallets from SEED_MNEMONIC take faucet USDC: 40 buys and lists, 41 buys the resale, 42 waits in line and
// 43 sells to the line. The gate wallet checks in.
// Run from the repo root after `cd admin && npm ci` and `forge build`: node scripts/measure.mjs
import fs from 'node:fs';
import { artifact, connect, loadEnv, mnemonicToAccount, privateKeyToAccount, retry, ROOT, sender, viem } from './lib/fuji.mjs';

const env = loadEnv();
const dep = JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment.json`, 'utf8'));
const BOX = dep.veGoc, USDC = dep.usdc, EVENT = 0n;
const boxAbi = artifact('VeGoc').abi, usdcAbi = artifact('MockUSDC').abi;
const { pub, walletOf } = connect(env);
const send = sender(pub, walletOf);
const buyer = mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: 40 });
const reseller = mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: 41 });
const waiter = mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: 42 });
const seller = mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: 43 });
const gate = privateKeyToAccount(env.GATE_KEY);
const ROUNDS = 3;

for (const w of [buyer, reseller, waiter, seller]) {
  if ((await pub.getBalance({ address: w.address })) < viem.parseEther('0.00002')) {
    const hash = await walletOf(gate).sendTransaction({ to: w.address, value: viem.parseEther('0.00005') });
    await pub.waitForTransactionReceipt({ hash });
  }
  if ((await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [w.address] })) < 200_000000n) await send(w, USDC, usdcAbi, 'faucet');
}

async function permit(owner, value) {
  const [nonce, block] = await Promise.all([pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'nonces', args: [owner.address] }), pub.getBlock()]);
  const deadline = block.timestamp + 1200n;
  const sig = await owner.signTypedData({
    domain: { name: 'Mock USDC', version: '1', chainId: 43113, verifyingContract: USDC },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', message: { owner: owner.address, spender: BOX, value, nonce, deadline },
  });
  const { r, s, v, yParity } = viem.parseSignature(sig);
  return [deadline, Number(v ?? BigInt(yParity + 27)), r, s];
}

const rows = [];
async function timed(label, account, functionName, args) {
  const wallet = walletOf(account);
  const data = viem.encodeFunctionData({ abi: boxAbi, functionName, args });
  const request = await retry(() => wallet.prepareTransactionRequest({ to: BOX, data }));
  request.gas = (request.gas * 12n) / 10n; // the app adds the same 20 % to the node's estimate
  const raw = await wallet.signTransaction(request);
  const sentAt = Date.now();
  const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 60_000 });
  const receiptMs = Date.now() - sentAt;
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  const block = await pub.request({ method: 'eth_getBlockByNumber', params: [viem.numberToHex(receipt.blockNumber), false] });
  const inBlockMs = Number(BigInt(block.timestampMilliseconds)) - sentAt;
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  rows.push({ label, hash, gas: Number(receipt.gasUsed), gasPriceWei: receipt.effectiveGasPrice.toString(), feeWei: feeWei.toString(), inBlockMs, receiptMs });
  console.log(label.padEnd(34), `${receipt.gasUsed} gas`, `${inBlockMs} ms in block`, `${receiptMs} ms receipt`, hash);
  return receipt;
}

for (let i = 0; i < ROUNDS; i++) {
  const bought = await timed('Buy 1 GA (permit + purchase)', buyer, 'buyWithPermit', [EVENT, 0n, 1n, ...(await permit(buyer, 25_000000n))]);
  const [id] = viem.parseEventLogs({ abi: boxAbi, logs: bought.logs, eventName: 'Transfer' }).map((l) => l.args.tokenId);
  await timed('List at the cap (+10 %)', buyer, 'list', [id, 27_500000n]);
  await timed('Buy the listing (permit + resale)', reseller, 'buyListingWithPermit', [id, 27_500000n, ...(await permit(reseller, 27_500000n))]);
  const deadline = (await pub.getBlock()).timestamp + 240n;
  const signature = await reseller.signTypedData({
    domain: { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX },
    types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'CheckIn', message: { tokenId: id, deadline },
  });
  await timed('Gate check-in', gate, 'checkIn', [id, deadline, signature]);
}

// The waitlist: a wallet pays in the cap and takes a place in line; the next listing goes to it in the seller's
// own transaction.
for (let i = 0; i < ROUNDS; i++) {
  const bought = await send(seller, BOX, boxAbi, 'buyWithPermit', [EVENT, 0n, 1n, ...(await permit(seller, 25_000000n))]);
  const [id] = viem.parseEventLogs({ abi: boxAbi, logs: bought.receipt.logs, eventName: 'Transfer' }).map((l) => l.args.tokenId);
  await timed('Join the waitlist (permit + deposit)', waiter, 'joinWaitlistWithPermit', [EVENT, 0n, ...(await permit(waiter, 27_500000n))]);
  await timed('List, sold to the first in line', seller, 'list', [id, 27_500000n]);
}

// What the same gas costs on the C-Chain right now.
const mainnet = viem.createPublicClient({ transport: viem.http('https://api.avax.network/ext/bc/C/rpc') });
const mainnetBaseFeeWei = BigInt(await mainnet.request({ method: 'eth_baseFee' }));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = [...new Set(rows.map((r) => r.label))].map((label) => {
  const rs = rows.filter((r) => r.label === label);
  const gas = median(rs.map((r) => r.gas));
  return {
    label, runs: rs.length, gas, inBlockMs: median(rs.map((r) => r.inBlockMs)), receiptMs: median(rs.map((r) => r.receiptMs)),
    fujiFeeWei: median(rs.map((r) => Number(r.feeWei))).toString(), mainnetFeeAvax: viem.formatEther(BigInt(gas) * mainnetBaseFeeWei), tx: (rs.find((r) => r.gas === gas) ?? rs[0]).hash,
  };
});
const out = { at: new Date().toISOString(), rpc: env.FUJI_RPC, veGoc: BOX, rounds: ROUNDS, mainnetBaseFeeWei: mainnetBaseFeeWei.toString(), summary, rows };
fs.writeFileSync(`${ROOT}docs/fuji-measure.json`, `${JSON.stringify(out, null, 1)}\n`);
console.table(summary.map(({ label, gas, inBlockMs, receiptMs, mainnetFeeAvax }) => ({ label, gas, inBlockMs, receiptMs, mainnetFeeAvax })));
