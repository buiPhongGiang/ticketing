// Regenerates app/src/lib/abi.ts from the Foundry artifacts. Run from the repo root after `forge build`.
import fs from 'node:fs';
const abi = (name) => JSON.stringify(JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, 'utf8')).abi, null, 2);
fs.writeFileSync('app/src/lib/abi.ts',
  '// Generated from the Foundry artifacts in ../../../out (run `node scripts/gen-abi.mjs` after `forge build`).\n' +
  `export const abi = ${abi('VeGoc')} as const;\n\nexport const usdcAbi = ${abi('MockUSDC')} as const;\n\nexport const vaultAbi = ${abi('FloatVault')} as const;\n`);
