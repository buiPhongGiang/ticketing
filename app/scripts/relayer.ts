// Gas relayer for the guest app, testnet only. Sends purchases with buyFor, grants test USDC, tops up fees.
//
//   cd app && npm run relayer                       # local anvil (.env.dev), relayer = anvil's public key #9
//   cd app && ENV_FILE=.env.fuji npm run relayer    # Fuji, relayer = GATE_KEY from ../.env.fuji (never printed)
//
// Then start the app with EXPO_PUBLIC_RELAYER_URL=http://<this machine>:8787 in its env file.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { errorCode } from '../src/lib';
import { createRelayer } from '../src/lib/relayer';
import type { Address, Hex } from '../src/lib/types';

const parse = (path: string): Record<string, string> => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
const env = parse(process.env.ENV_FILE ?? '.env.dev');
const chainId = Number(env.EXPO_PUBLIC_CHAIN_ID);
const ANVIL_9 = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
const key = (process.env.RELAYER_KEY ?? (chainId === 43113 ? parse('../.env.fuji').GATE_KEY : ANVIL_9)) as Hex;
const relayer = createRelayer({
  rpcUrl: env.EXPO_PUBLIC_RPC_URL, chainId, privateKey: key,
  contract: env.EXPO_PUBLIC_CONTRACT as Address, usdc: env.EXPO_PUBLIC_USDC as Address,
}, errorCode);
const port = Number(process.env.PORT ?? 8787);

createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let json: unknown = null;
    try { json = JSON.parse(body || 'null'); } catch {}
    const out = req.method === 'POST' ? await relayer.handle(req.url ?? '', json) : { status: 404, json: { error: 'Unknown' } };
    console.log(new Date().toISOString(), req.url, out.status, JSON.stringify(out.json));
    res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
  });
}).listen(port, () => console.log(`relayer ${relayer.address} on chain ${chainId}, port ${port}`));
