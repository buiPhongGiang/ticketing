// Creates the team's 2-of-3 Safe on Avalanche Fuji from the canonical Safe v1.4.1 contracts that are already
// deployed there, and records its address in .env.fuji as SAFE_ADDRESS.
// Owners: the ticket organizer wallet (TICKET_ORGANIZER_*) and two more keys this script generates on first run
// (SAFE_OWNER_2_*, SAFE_OWNER_3_*; saved to the gitignored .env.fuji, never printed).
// Run from the repo root: node scripts/fuji-safe.mjs
import { appendEnv, connect, factoryAbi, generatePrivateKey, loadEnv, privateKeyToAccount, SAFE, safeAbi, sender, viem } from './lib/fuji.mjs';

let env = loadEnv();
if (env.SAFE_ADDRESS) { console.log('Safe already recorded:', env.SAFE_ADDRESS); process.exit(0); }
if (!env.SAFE_OWNER_2_KEY) {
  const k2 = generatePrivateKey(), k3 = generatePrivateKey();
  appendEnv({
    SAFE_OWNER_2_ADDRESS: privateKeyToAccount(k2).address, SAFE_OWNER_2_KEY: k2,
    SAFE_OWNER_3_ADDRESS: privateKeyToAccount(k3).address, SAFE_OWNER_3_KEY: k3,
  }, 'Second and third owner of the 2-of-3 Safe (testnet only)');
  env = loadEnv();
}
const { pub, walletOf } = connect(env);
const send = sender(pub, walletOf);
const deployer = privateKeyToAccount(env.TICKET_ORGANIZER_KEY);
const owners = [deployer.address, env.SAFE_OWNER_2_ADDRESS, env.SAFE_OWNER_3_ADDRESS];
const ZERO = '0x0000000000000000000000000000000000000000';
const initializer = viem.encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [owners, 2n, ZERO, '0x', SAFE.fallbackHandler, ZERO, 0n, ZERO] });
const { hash, receipt } = await send(deployer, SAFE.factory, factoryAbi, 'createProxyWithNonce', [SAFE.singletonL2, initializer, BigInt(Date.now())]);
const [created] = viem.parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: 'ProxyCreation' });
const safe = created.args.proxy;
const [threshold, onChainOwners, version] = await Promise.all([
  pub.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
  pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }),
  pub.readContract({ address: safe, abi: safeAbi, functionName: 'VERSION' }),
]);
appendEnv({ SAFE_ADDRESS: safe, SAFE_CREATE_TX: hash }, '2-of-3 Safe: organizer of the showcase events and platform fee recipient');
console.log(`Safe ${version} ${safe} · threshold ${threshold} of ${onChainOwners.length} · owners ${onChainOwners.join(', ')}`);
console.log(`created in ${hash}`);
