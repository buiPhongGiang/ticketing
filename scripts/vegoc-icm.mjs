// ICM both ways between the Fuji C-Chain and the venue L1 `vegoc` (chainId 510101). Prints every tx hash.
//   node scripts/vegoc-icm.mjs
// 1. Deploys once (addresses kept in docs/vegoc-icm.json):
//      Fuji:  AttendanceRelay (same code as the Dispatch one, destination vegoc) and VenueCheckIns
//      vegoc: AttendanceMirror and GateLog, by the venue key; the gate device key is allowed on GateLog
//    Each side names the other, so the vegoc addresses are computed from the venue key's nonce first.
// 2. Fuji -> vegoc: relays the outcome of finished events (EVENTS, default "2 3 4 5") and waits until Teleporter on
//    vegoc has executed each message (MessageExecuted) and AttendanceMirror holds the record.
// 3. vegoc -> Fuji: holders of tickets for GATE_EVENT (default 1) sign the app's check-in QR; the gate device records
//    the scans on GateLog (venue gas) and sends them with `attest`; waits until VenueCheckIns on Fuji has executed the
//    message, then prints its tally. BATCHES batches (default 2) of PER_BATCH scans (default 2). The last batch also
//    carries one ticket of another event, which Fuji must reject (WrongEvent).
// Needs .env.fuji (FUJI_RPC, TICKET_ORGANIZER_KEY for Fuji, ORGANIZER_KEY = venue on vegoc, GATE_KEY, GUEST_*_KEY,
// SEED_MNEMONIC), the local vegoc RPC, `forge build`, and `cd admin && npm ci` once.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { artifact, connect, mnemonicToAccount, privateKeyToAccount, retry, ROOT, sender, sleep, viem } from './lib/fuji.mjs';

const { createPublicClient, createWalletClient, http, defineChain, getContractAddress, decodeEventLog, parseAbi } = viem;

const VEGOC_RPC = process.env.VEGOC_RPC ?? 'http://127.0.0.1:9650/ext/bc/6M7vAPShYSv6WnXxWwA7ZAsMmRFuRRkTLqe2Pj8TCxX6TuHqG/rpc';
const VEGOC_ID = '0x0c24086a7db2d8933725cadfc9e64dcd75fb5f6861030e9781402b1b86cafe6a';
const FUJI_ID = '0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5';
const TELEPORTER = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
const BOX = JSON.parse(fs.readFileSync(`${ROOT}docs/fuji-deployment.json`, 'utf8')).veGoc;
const OUT = `${ROOT}docs/vegoc-icm.json`;
const EVENTS = (process.env.EVENTS ?? '2 3 4 5').split(/\s+/).filter(Boolean).map(Number);
const GATE_EVENT = BigInt(process.env.GATE_EVENT ?? 1);
const BATCHES = Number(process.env.BATCHES ?? 2);
const PER_BATCH = Number(process.env.PER_BATCH ?? 2);
// Teleporter v1 events on the destination chain.
const EXECUTED = '0x34795cc6b122b9a0ae684946319f1e14a577b4e8f9b3dda9ac94c21a54d3188c'; // MessageExecuted(bytes32,bytes32)
const FAILED = '0x4619adc1017b82e02eaefac01a43d50d6d8de4460774bc370c3ff0210d40c985'; // MessageExecutionFailed(...)

const vegoc = defineChain({
  id: 510101, name: 'vegoc', nativeCurrency: { name: 'VGC', symbol: 'VGC', decimals: 18 },
  rpcUrls: { default: { http: [VEGOC_RPC] } },
});
const { env, pub: fuji, walletOf: fujiWallet } = connect();
const vTransport = http(VEGOC_RPC, { retryCount: 3, timeout: 20_000 });
const vpub = createPublicClient({ chain: vegoc, transport: vTransport, pollingInterval: 300 });
const vWallet = (account) => createWalletClient({ account, chain: vegoc, transport: vTransport });
const sendFuji = sender(fuji, fujiWallet);
const sendVegoc = sender(vpub, vWallet);

const fujiDeployer = privateKeyToAccount(env.TICKET_ORGANIZER_KEY);
const venue = privateKeyToAccount(env.ORGANIZER_KEY);
const gateDevice = privateKeyToAccount(env.GATE_KEY);
const holders = [privateKeyToAccount(env.GUEST_A_KEY), privateKeyToAccount(env.GUEST_B_KEY),
  ...Array.from({ length: 40 }, (_, i) => mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: i }))];

const A = Object.fromEntries(['AttendanceRelay', 'AttendanceMirror', 'GateLog', 'VenueCheckIns', 'VeGoc'].map((n) => [n, artifact(n)]));
const teleporterAbi = parseAbi(['function messageReceived(bytes32) view returns (bool)']);

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {
  vegoc: { chainId: 510101, blockchainID: VEGOC_ID, rpc: 'local only', subnetID: 'EW5oFkzj5Xk2TXitcaKALxWkBDQQ4yMD5jT6Uyh9cZP5HhUkn' },
  teleporter: TELEPORTER, fujiBlockchainID: FUJI_ID, veGoc: BOX, fujiToVegoc: [], vegocToFuji: [],
};
const save = () => {
  state.updated = new Date().toISOString().slice(0, 19) + 'Z';
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
};

async function deploy(pub, walletOf, account, name, args) {
  const hash = await retry(() => walletOf(account).deployContract({ abi: A[name].abi, bytecode: A[name].bytecode.object, args }), `deploy ${name}`);
  const r = await retry(() => pub.waitForTransactionReceipt({ hash, timeout: 90_000 }), `receipt ${name}`);
  if (r.status !== 'success') throw new Error(`${name} deploy reverted: ${hash}`);
  console.log(`  ${name} ${r.contractAddress} (tx ${hash})`);
  return { address: r.contractAddress, tx: hash };
}

function verifyOnRoutescan(address, path, types, args) {
  try {
    const encoded = execFileSync('cast', ['abi-encode', `c(${types})`, ...args], { encoding: 'utf8' }).trim();
    execFileSync('forge', ['verify-contract', address, path, '--chain', '43113', '--verifier', 'custom', '--verifier-url',
      'https://api.routescan.io/v2/network/testnet/evm/43113/etherscan', '--etherscan-api-key', 'verifyContract',
      '--constructor-args', encoded, '--watch'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.log(`  verification of ${address} did not finish`);
  }
}

/** Waits until Teleporter on the destination chain logs MessageExecuted or MessageExecutionFailed for `id`. */
async function delivery(pub, id, fromBlock) {
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const logs = await retry(() => pub.request({ method: 'eth_getLogs', params: [{
      address: TELEPORTER, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', topics: [[EXECUTED, FAILED], id] }] }));
    if (logs.length) {
      return { receiveTx: logs[0].transactionHash, executed: logs[0].topics[0] === EXECUTED, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    }
    await sleep(2000);
  }
  return { receiveTx: null, executed: false, seconds: null };
}

// ------------------------------------------------------------------ 1. deploy
if (!state.gateLog?.setGateTx) {
  console.log('Deploying');
  if (!state.planned) {
    const n = BigInt(await vpub.getTransactionCount({ address: venue.address }));
    state.planned = { mirror: getContractAddress({ from: venue.address, nonce: n }), gateLog: getContractAddress({ from: venue.address, nonce: n + 1n }) };
    save();
  }
  const { mirror: mirrorAt, gateLog: gateAt } = state.planned;
  state.relay ??= await deploy(fuji, fujiWallet, fujiDeployer, 'AttendanceRelay', [BOX, TELEPORTER, VEGOC_ID, mirrorAt]);
  save();
  state.venueCheckIns ??= await deploy(fuji, fujiWallet, fujiDeployer, 'VenueCheckIns', [TELEPORTER, VEGOC_ID, gateAt, BOX]);
  save();
  state.mirror ??= await deploy(vpub, vWallet, venue, 'AttendanceMirror', [TELEPORTER, FUJI_ID, state.relay.address]);
  save();
  state.gateLog ??= await deploy(vpub, vWallet, venue, 'GateLog', [venue.address, TELEPORTER, FUJI_ID, state.venueCheckIns.address, 43113n, BOX]);
  save();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!same(state.mirror.address, mirrorAt) || !same(state.gateLog.address, gateAt)) {
    throw new Error('vegoc addresses differ from the computed ones (the venue key sent another tx in between); remove docs/vegoc-icm.json and start again');
  }
  const { hash } = await sendVegoc(venue, gateAt, A.GateLog.abi, 'setGate', [gateDevice.address, true]);
  state.gateLog.setGateTx = hash;
  state.venue = venue.address;
  state.gateDevice = gateDevice.address;
  save();
  verifyOnRoutescan(state.relay.address, 'src/icm/AttendanceRelay.sol:AttendanceRelay', 'address,address,bytes32,address', [BOX, TELEPORTER, VEGOC_ID, mirrorAt]);
  verifyOnRoutescan(state.venueCheckIns.address, 'src/icm/VenueCheckIns.sol:VenueCheckIns', 'address,bytes32,address,address', [TELEPORTER, VEGOC_ID, gateAt, BOX]);
}
const relay = state.relay.address, mirror = state.mirror.address, gateLog = state.gateLog.address, checkIns = state.venueCheckIns.address;
console.log(`Fuji: AttendanceRelay ${relay}, VenueCheckIns ${checkIns}\nvegoc: AttendanceMirror ${mirror}, GateLog ${gateLog}`);

// ------------------------------------------------------------------ 2. Fuji -> vegoc
console.log('\nFuji -> vegoc: event outcomes');
for (const e of EVENTS) {
  const done = await fuji.readContract({ address: relay, abi: A.AttendanceRelay.abi, functionName: 'messageOf', args: [BigInt(e)] });
  if (done !== `0x${'0'.repeat(64)}`) { console.log(`  event ${e} already relayed`); continue; }
  const from = await vpub.getBlockNumber();
  const { hash, receipt } = await sendFuji(fujiDeployer, relay, A.AttendanceRelay.abi, 'relay', [BigInt(e)]);
  const id = await fuji.readContract({ address: relay, abi: A.AttendanceRelay.abi, functionName: 'messageOf', args: [BigInt(e)] });
  const d = await delivery(vpub, id, from);
  const [organizer, outcome, paidSold, paidCheckedIn] = await vpub.readContract({ address: mirror, abi: A.AttendanceMirror.abi, functionName: 'records', args: [BigInt(e)] });
  const row = { event: e, sendTx: hash, gas: Number(receipt.gasUsed), messageID: id, ...d, mirrorRecord: { organizer, outcome, paidSold, paidCheckedIn } };
  state.fujiToVegoc.push(row);
  save();
  console.log(`  event ${e}: Fuji send ${hash} -> vegoc ${d.receiveTx} executed=${d.executed} after ${d.seconds}s; mirror outcome ${outcome} (${paidCheckedIn}/${paidSold})`);
}

// ------------------------------------------------------------------ 3. vegoc -> Fuji
console.log(`\nvegoc -> Fuji: door scans for event ${GATE_EVENT}`);
const domain = { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX };
const types = { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const own = [], foreign = [];
for (const h of holders) {
  const ts = await retry(() => fuji.readContract({ address: BOX, abi: A.VeGoc.abi, functionName: 'ticketsOf', args: [h.address] }));
  for (const t of ts) {
    if (t.checkedIn) continue;
    const seen = await vpub.readContract({ address: gateLog, abi: A.GateLog.abi, functionName: 'scanned', args: [GATE_EVENT, t.tokenId] });
    if (!seen) (t.eventId === GATE_EVENT ? own : foreign).push({ holder: h, tokenId: t.tokenId });
  }
}
for (let b = 0; b < BATCHES && own.length; b++) {
  const batch = own.splice(0, PER_BATCH);
  if (b === BATCHES - 1 && foreign.length) batch.push(foreign[0]);
  const now = Math.floor(Date.now() / 1000);
  const ids = [], deadlines = [], sigs = [];
  for (const s of batch) {
    const deadline = BigInt(now + 120);
    ids.push(s.tokenId);
    deadlines.push(deadline);
    sigs.push(await s.holder.signTypedData({ domain, types, primaryType: 'CheckIn', message: { tokenId: s.tokenId, deadline } }));
  }
  const scan = await sendVegoc(gateDevice, gateLog, A.GateLog.abi, 'checkInMany', [GATE_EVENT, ids, deadlines, sigs]);
  const from = await fuji.getBlockNumber();
  const att = await sendVegoc(gateDevice, gateLog, A.GateLog.abi, 'attest', [GATE_EVENT]);
  const log = att.receipt.logs.filter((l) => l.address.toLowerCase() === gateLog.toLowerCase())
    .map((l) => decodeEventLog({ abi: A.GateLog.abi, data: l.data, topics: l.topics })).find((x) => x.eventName === 'Attested');
  const id = log.args.messageID;
  const d = await delivery(fuji, id, from);
  const [accepted, paidAccepted, rejected, batches] = await fuji.readContract({ address: checkIns, abi: A.VenueCheckIns.abi, functionName: 'tallies', args: [GATE_EVENT] });
  const [venuePaid, paidSold, veGocPaid, met] = await fuji.readContract({ address: checkIns, abi: A.VenueCheckIns.abi, functionName: 'venueQuorum', args: [GATE_EVENT] });
  const row = {
    event: Number(GATE_EVENT), batch: Number(log.args.batch), tokenIds: ids.map(Number), scanTx: scan.hash, scanGas: Number(scan.receipt.gasUsed),
    attestTx: att.hash, messageID: id, ...d,
    fujiTally: { accepted, paidAccepted, rejected, batches }, venueQuorum: { venuePaid: Number(venuePaid), paidSold: Number(paidSold), veGocPaid: Number(veGocPaid), met },
  };
  state.vegocToFuji.push(row);
  save();
  console.log(`  batch ${row.batch} tokens ${row.tokenIds.join(',')}: vegoc scan ${scan.hash}, attest ${att.hash} -> Fuji ${d.receiveTx} executed=${d.executed} after ${d.seconds}s; Fuji tally accepted ${accepted} (paid ${paidAccepted}) rejected ${rejected}; venue ${venuePaid}/${paidSold} paid, quorum ${met}`);
}
console.log(`\nwrote ${OUT}`);
