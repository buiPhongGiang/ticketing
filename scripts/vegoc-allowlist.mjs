// Permissioned writes on the venue L1 `vegoc`, and ICM both ways after the 21/11 network upgrade. Prints every hash
// and every refusal.
//   node scripts/vegoc-allowlist.mjs
// Since the upgrade, TxAllowList (precompile 0x0200…0002) decides who may send any transaction on vegoc. The organizer
// (ORGANIZER_KEY, the venue) is an admin; the gate device and the ICM relayer are enabled.
// 1. Roles read from the precompile.
// 2. An outsider wallet (OUTSIDER_KEY_FILE, default ~/.avalanche-team1/outsider.key) tries to record a door scan on
//    GateLog: the L1 refuses the transaction before it reaches the contract.
// 3. A new gate device: a fresh key (kept in .env.fuji as GATE2_KEY, never printed) gets VGC for gas, is refused too,
//    then the organizer enables it on TxAllowList and on GateLog. It records a holder-signed scan for GATE_EVENT and
//    sends it to VenueCheckIns on Fuji with `attest` (vegoc -> Fuji over ICM); the script waits for MessageExecuted.
// 4. Offboarding: the organizer sets the device back to None on TxAllowList and off GateLog; its next scan is refused.
// 5. Fuji -> vegoc: a short test event is created on VeGoc (ends after ~90 s), relayed by AttendanceRelay when over,
//    and AttendanceMirror on vegoc must hold its outcome.
// Results: docs/vegoc-allowlist.json. Needs the same setup as scripts/vegoc-icm.mjs (run that once first).
import fs from 'node:fs';
import os from 'node:os';
import { appendEnv, artifact, connect, generatePrivateKey, mnemonicToAccount, privateKeyToAccount, retry, ROOT, sender, sleep, viem } from './lib/fuji.mjs';

const { createPublicClient, createWalletClient, http, defineChain, decodeEventLog, parseAbi, parseEther, encodeFunctionData } = viem;

const VEGOC_RPC = process.env.VEGOC_RPC ?? 'http://127.0.0.1:9650/ext/bc/6M7vAPShYSv6WnXxWwA7ZAsMmRFuRRkTLqe2Pj8TCxX6TuHqG/rpc';
const TX_ALLOW_LIST = '0x0200000000000000000000000000000000000002';
const TELEPORTER = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
const RELAYER = '0x474044236309DC089A92c5AB9A3daF853831F1DC';
const EXECUTED = '0x34795cc6b122b9a0ae684946319f1e14a577b4e8f9b3dda9ac94c21a54d3188c';
const FAILED = '0x4619adc1017b82e02eaefac01a43d50d6d8de4460774bc370c3ff0210d40c985';
const GATE_EVENT = BigInt(process.env.GATE_EVENT ?? 1);
const ICM = JSON.parse(fs.readFileSync(`${ROOT}docs/vegoc-icm.json`, 'utf8'));
const BOX = ICM.veGoc;
const OUT = `${ROOT}docs/vegoc-allowlist.json`;
const ROLE = ['None', 'Enabled', 'Admin', 'Manager'];

const vegoc = defineChain({ id: 510101, name: 'vegoc', nativeCurrency: { name: 'VGC', symbol: 'VGC', decimals: 18 }, rpcUrls: { default: { http: [VEGOC_RPC] } } });
const vTransport = http(VEGOC_RPC, { retryCount: 2, timeout: 20_000 });
const vpub = createPublicClient({ chain: vegoc, transport: vTransport, pollingInterval: 300 });
const vWallet = (account) => createWalletClient({ account, chain: vegoc, transport: vTransport });
const sendVegoc = sender(vpub, vWallet);
const { env, pub: fuji, walletOf: fujiWallet } = connect();
const sendFuji = sender(fuji, fujiWallet);

const allowAbi = parseAbi([
  'function readAllowList(address) view returns (uint256)',
  'function setEnabled(address)',
  'function setNone(address)',
]);
const A = Object.fromEntries(['GateLog', 'VenueCheckIns', 'VeGoc', 'AttendanceRelay', 'AttendanceMirror'].map((n) => [n, artifact(n)]));
const organizer = privateKeyToAccount(env.ORGANIZER_KEY);
const fujiDeployer = privateKeyToAccount(env.TICKET_ORGANIZER_KEY);
const outsider = privateKeyToAccount(fs.readFileSync(process.env.OUTSIDER_KEY_FILE ?? `${os.homedir()}/.avalanche-team1/outsider.key`, 'utf8').trim());
if (!env.GATE2_KEY) {
  const key = generatePrivateKey();
  appendEnv({ GATE2_ADDRESS: privateKeyToAccount(key).address, GATE2_KEY: key }, 'Second gate device on vegoc (scripts/vegoc-allowlist.mjs)');
  env.GATE2_KEY = key;
}
const gate2 = privateKeyToAccount(env.GATE2_KEY);
const gateLog = ICM.gateLog.address, checkIns = ICM.venueCheckIns.address, relay = ICM.relay.address, mirror = ICM.mirror.address;
const holders = [privateKeyToAccount(env.GUEST_A_KEY), privateKeyToAccount(env.GUEST_B_KEY),
  ...Array.from({ length: 40 }, (_, i) => mnemonicToAccount(env.SEED_MNEMONIC, { addressIndex: i }))];

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
Object.assign(state, { chain: 'vegoc 510101', txAllowList: TX_ALLOW_LIST, gateLog, venueCheckIns: checkIns, organizer: organizer.address, outsider: outsider.address, newGate: gate2.address });
const save = () => {
  state.updated = new Date().toISOString().slice(0, 19) + 'Z';
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
};

const role = async (a) => ROLE[Number(await vpub.readContract({ address: TX_ALLOW_LIST, abi: allowAbi, functionName: 'readAllowList', args: [a] }))];

/** Signs the app's check-in QR for one unscanned ticket of GATE_EVENT. */
async function nextQr() {
  for (const h of holders) {
    const ts = await retry(() => fuji.readContract({ address: BOX, abi: A.VeGoc.abi, functionName: 'ticketsOf', args: [h.address] }));
    for (const t of ts) {
      if (t.checkedIn || t.eventId !== GATE_EVENT) continue;
      if (await vpub.readContract({ address: gateLog, abi: A.GateLog.abi, functionName: 'scanned', args: [GATE_EVENT, t.tokenId] })) continue;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
      const signature = await h.signTypedData({
        domain: { name: 'VeGoc', version: '1', chainId: 43113, verifyingContract: BOX },
        types: { CheckIn: [{ name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'CheckIn', message: { tokenId: t.tokenId, deadline },
      });
      return { tokenId: t.tokenId, deadline, signature };
    }
  }
  throw new Error(`no unscanned ticket of event ${GATE_EVENT} left among the test holders`);
}

/** Sends a GateLog.checkIn without asking the node to estimate first, and returns the node's refusal (or the hash). */
async function tryScan(account, qr) {
  const data = encodeFunctionData({ abi: A.GateLog.abi, functionName: 'checkIn', args: [GATE_EVENT, qr.tokenId, qr.deadline, qr.signature] });
  try {
    const hash = await vWallet(account).sendTransaction({ to: gateLog, data, gas: 300_000n });
    return { hash };
  } catch (e) {
    const text = String(e?.details ?? e?.shortMessage ?? e?.message ?? e).split('\n')[0];
    return { refused: text };
  }
}

async function delivery(pub, id, fromBlock) {
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const logs = await retry(() => pub.request({ method: 'eth_getLogs', params: [{ address: TELEPORTER, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', topics: [[EXECUTED, FAILED], id] }] }));
    if (logs.length) return { receiveTx: logs[0].transactionHash, executed: logs[0].topics[0] === EXECUTED, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    await sleep(2000);
  }
  return { receiveTx: null, executed: false, seconds: null };
}

// ------------------------------------------------------------------ 1. roles
state.rolesBefore = {};
for (const [name, a] of [['organizer', organizer.address], ['gate', ICM.gateDevice], ['relayer', RELAYER], ['outsider', outsider.address], ['newGate', gate2.address]]) {
  state.rolesBefore[name] = await role(a);
}
console.log('TxAllowList roles:', JSON.stringify(state.rolesBefore));

// ------------------------------------------------------------------ 2. outsider
const qr1 = await nextQr();
const out = await tryScan(outsider, qr1);
state.outsiderScan = { tokenId: Number(qr1.tokenId), ...out };
save();
console.log(`outsider scan of token ${qr1.tokenId}: ${out.refused ? `refused: ${out.refused}` : `ACCEPTED ${out.hash}`}`);
if (!out.refused) throw new Error('the outsider was not refused');

// ------------------------------------------------------------------ 3. new gate device
if (!state.enable) {
  const bal = await vpub.getBalance({ address: gate2.address });
  if (bal < parseEther('0.5')) {
    const hash = await vWallet(organizer).sendTransaction({ to: gate2.address, value: parseEther('1') });
    await vpub.waitForTransactionReceipt({ hash });
    state.fundTx = hash;
    console.log(`organizer sends 1 VGC for gas to the new gate ${gate2.address}: ${hash}`);
  }
  const before = await tryScan(gate2, qr1);
  state.newGateBeforeEnable = before;
  console.log(`new gate before it is enabled: ${before.refused ? `refused: ${before.refused}` : `ACCEPTED ${before.hash}`}`);
  if (!before.refused) throw new Error('the new gate was not refused before being enabled');
  const en = await sendVegoc(organizer, TX_ALLOW_LIST, allowAbi, 'setEnabled', [gate2.address]);
  const sg = await sendVegoc(organizer, gateLog, A.GateLog.abi, 'setGate', [gate2.address, true]);
  state.enable = { setEnabledTx: en.hash, setGateTx: sg.hash, role: await role(gate2.address) };
  save();
  console.log(`organizer TxAllowList.setEnabled(new gate) ${en.hash}; GateLog.setGate ${sg.hash}; role now ${state.enable.role}`);
}

if (!state.scan?.executed) {
  const qr = await nextQr();
  const scan = await sendVegoc(gate2, gateLog, A.GateLog.abi, 'checkIn', [GATE_EVENT, qr.tokenId, qr.deadline, qr.signature]);
  const from = await fuji.getBlockNumber();
  const att = await sendVegoc(gate2, gateLog, A.GateLog.abi, 'attest', [GATE_EVENT]);
  const log = att.receipt.logs.filter((l) => l.address.toLowerCase() === gateLog.toLowerCase())
    .map((l) => decodeEventLog({ abi: A.GateLog.abi, data: l.data, topics: l.topics })).find((x) => x.eventName === 'Attested');
  console.log(`new gate scans token ${qr.tokenId}: ${scan.hash}; attest batch ${log.args.batch}: ${att.hash}`);
  const d = await delivery(fuji, log.args.messageID, from);
  const [accepted, paidAccepted, rejected, batches] = await fuji.readContract({ address: checkIns, abi: A.VenueCheckIns.abi, functionName: 'tallies', args: [GATE_EVENT] });
  const [venuePaid, paidSold, , met] = await fuji.readContract({ address: checkIns, abi: A.VenueCheckIns.abi, functionName: 'venueQuorum', args: [GATE_EVENT] });
  state.scan = { event: Number(GATE_EVENT), tokenId: Number(qr.tokenId), scanTx: scan.hash, attestTx: att.hash, batch: Number(log.args.batch), messageID: log.args.messageID, ...d,
    fujiTally: { accepted, paidAccepted, rejected, batches }, venueQuorum: { venuePaid: Number(venuePaid), paidSold: Number(paidSold), met } };
  save();
  console.log(`  -> Fuji VenueCheckIns ${d.receiveTx} executed=${d.executed} after ${d.seconds}s; tally accepted ${accepted} (paid ${paidAccepted}), rejected ${rejected}; venue ${venuePaid}/${paidSold} paid, quorum ${met}`);
}

// ------------------------------------------------------------------ 4. offboarding
if (!state.offboard) {
  const sn = await sendVegoc(organizer, TX_ALLOW_LIST, allowAbi, 'setNone', [gate2.address]);
  const sg = await sendVegoc(organizer, gateLog, A.GateLog.abi, 'setGate', [gate2.address, false]);
  const qr = await nextQr();
  const after = await tryScan(gate2, qr);
  state.offboard = { setNoneTx: sn.hash, setGateTx: sg.hash, role: await role(gate2.address), scanAfter: after };
  save();
  console.log(`organizer TxAllowList.setNone(new gate) ${sn.hash}; GateLog.setGate(false) ${sg.hash}; next scan: ${after.refused ? `refused: ${after.refused}` : `ACCEPTED ${after.hash}`}`);
}
state.rolesAfter = { organizer: await role(organizer.address), gate: await role(ICM.gateDevice), relayer: await role(RELAYER), outsider: await role(outsider.address), newGate: await role(gate2.address) };
save();

// ------------------------------------------------------------------ 5. Fuji -> vegoc after the upgrade
if (!state.fujiToVegoc?.executed) {
  let id = state.testEvent?.id;
  if (id === undefined) {
    const now = BigInt((await fuji.getBlock()).timestamp);
    const { hash, receipt } = await sendFuji(fujiDeployer, BOX, A.VeGoc.abi, 'createEvent',
      ['ICM check after vegoc upgrade', 'vegoc L1', now - 60n, now + 90n, 1, ['Test'], [0n], [1]]);
    const ev = receipt.logs.filter((l) => l.address.toLowerCase() === BOX.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: A.VeGoc.abi, data: l.data, topics: l.topics }); } catch { return null; } })
      .find((x) => x?.eventName === 'EventCreated');
    id = Number(ev.args.eventId);
    state.testEvent = { id, createTx: hash, endsAt: Number(now + 90n) };
    save();
    console.log(`\nFuji: test event ${id} created ${hash}, ends in 90 s`);
  }
  while (BigInt((await fuji.getBlock()).timestamp) <= BigInt(state.testEvent.endsAt)) await sleep(5000);
  if (!state.fujiToVegoc?.sendTx) {
    const vegocFrom = Number(await vpub.getBlockNumber());
    const { hash } = await sendFuji(fujiDeployer, relay, A.AttendanceRelay.abi, 'relay', [BigInt(id)]);
    const messageID = await fuji.readContract({ address: relay, abi: A.AttendanceRelay.abi, functionName: 'messageOf', args: [BigInt(id)] });
    state.fujiToVegoc = { event: id, sendTx: hash, messageID, vegocFrom };
    save();
  }
  const { sendTx: hash, messageID: msg, vegocFrom } = state.fujiToVegoc;
  const d = await delivery(vpub, msg, BigInt(vegocFrom));
  const [org, outcome, paidSold, paidCheckedIn] = await vpub.readContract({ address: mirror, abi: A.AttendanceMirror.abi, functionName: 'records', args: [BigInt(id)] });
  state.fujiToVegoc = { event: id, sendTx: hash, messageID: msg, vegocFrom, ...d, mirrorRecord: { organizer: org, outcome, paidSold, paidCheckedIn } };
  save();
  console.log(`Fuji relay ${hash} -> vegoc ${d.receiveTx} executed=${d.executed} after ${d.seconds}s; mirror outcome ${outcome} (${paidCheckedIn}/${paidSold})`);
}
console.log(`\nwrote ${OUT}`);
