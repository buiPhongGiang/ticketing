// Shared helpers for the Fuji scripts: env loading, viem clients with retry, and Safe (v1.4.1) transactions.
// viem is loaded from admin/node_modules, so run `cd admin && npm ci` once before any script.
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const ROOT = new URL('../..', import.meta.url).pathname;
const require = createRequire(`${ROOT}admin/package.json`);
export const viem = require('viem');
export const { privateKeyToAccount, generatePrivateKey, mnemonicToAccount, generateMnemonic, english } = require('viem/accounts');
const { avalancheFuji } = require('viem/chains');
const { createPublicClient, createWalletClient, http, encodeFunctionData, pad, concat, parseAbi } = viem;

export const ENV_PATH = `${ROOT}.env.fuji`;
export function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) throw new Error('Missing .env.fuji (test wallets). See README.');
  return Object.fromEntries(
    fs.readFileSync(ENV_PATH, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
  );
}
/** Appends KEY=value lines to .env.fuji (gitignored). Never prints the values. */
export function appendEnv(pairs, comment) {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.appendFileSync(ENV_PATH, `\n${comment ? `# ${comment}\n` : ''}${lines}\n`);
}

export const artifact = (name) => JSON.parse(fs.readFileSync(`${ROOT}out/${name}.sol/${name}.json`, 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function connect(env = loadEnv()) {
  const transport = http(env.FUJI_RPC, { retryCount: 5, retryDelay: 400, timeout: 20_000 });
  const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 400 });
  const walletOf = (account) => createWalletClient({ account, chain: avalancheFuji, transport });
  return { env, pub, walletOf, chain: avalancheFuji };
}

/** Retries a call that failed on the way to the RPC (rate limit, dropped connection); contract reverts are not retried. */
export async function retry(fn, label = '', tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const text = String(e?.shortMessage ?? e?.message ?? e);
      const transient = /429|rate|timeout|timed out|fetch failed|ECONNRESET|socket|503|502|nonce too low|replacement|already known/i.test(text) && !/revert/i.test(text);
      if (!transient || i >= tries - 1) throw e;
      await sleep(600 * (i + 1));
      if (label) console.log(`  retry ${label} (${text.slice(0, 80)})`);
    }
  }
}

/** Sends one contract call and waits for a successful receipt. Returns { hash, receipt }. */
export function sender(pub, walletOf) {
  return async function send(account, address, abi, functionName, args = [], opts = {}) {
    // The node's estimate is exact for the state it saw. Other wallets' transactions land in between (a first
    // purchase initialises storage that later ones only update), so an unpadded limit can run out of gas.
    // The public RPC is several nodes behind one address. One of them can be a block behind and answer with a revert
    // for a call that depends on the transaction just mined, so a revert is asked again a few times before it counts.
    let estimate;
    for (let attempt = 0; ; attempt++) {
      try {
        estimate = await retry(() => pub.estimateContractGas({ account, address, abi, functionName, args, ...opts }), `estimate ${functionName}`);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(1500);
      }
    }
    const gas = (estimate * 14n) / 10n + 40_000n;
    const hash = await retry(() => walletOf(account).writeContract({ address, abi, functionName, args, gas, ...opts }), functionName);
    const receipt = await retry(() => pub.waitForTransactionReceipt({ hash, timeout: 90_000 }), `receipt ${functionName}`);
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, receipt };
  };
}

/** Runs async jobs with at most `limit` in flight. */
export async function pool(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await job(items[i], i);
    }
  }));
  return out;
}

// ------------------------------------------------------------------ Safe v1.4.1 (canonical deployment, live on Fuji)

export const SAFE = {
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
};
export const safeAbi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
  'function approveHash(bytes32 hashToApprove)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
export const factoryAbi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);
const ZERO = '0x0000000000000000000000000000000000000000';

/** "Approved hash" signatures (v = 1), one per owner, sorted by owner address as the Safe requires. */
export function approvedSignatures(owners) {
  const sorted = [...owners].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return concat(sorted.map((o) => concat([pad(o, { size: 32 }), pad('0x', { size: 32 }), '0x01'])));
}

/**
 * One call from the Safe to `to`, 2-of-n: `approver` records its approval on chain (approveHash), `executor` then
 * executes with both approvals. Returns the two transaction hashes.
 */
export async function safeExec({ pub, send }, safe, approver, executor, to, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  const nonce = await retry(() => pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }));
  const hash = await retry(() => pub.readContract({ address: safe, abi: safeAbi, functionName: 'getTransactionHash', args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce] }));
  const approve = await send(approver, safe, safeAbi, 'approveHash', [hash]);
  const signatures = approvedSignatures([approver.address, executor.address]);
  const exec = await send(executor, safe, safeAbi, 'execTransaction', [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures]);
  return { approve: approve.hash, exec: exec.hash, receipt: exec.receipt };
}
