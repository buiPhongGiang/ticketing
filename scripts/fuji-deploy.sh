#!/usr/bin/env bash
# Deploys FloatVault + VeGoc to Avalanche Fuji, verifies them on Routescan (Snowtrace) and writes the app and console
# env files. The payment token is a parameter:
#   ./scripts/fuji-deploy.sh                      deploys a MockUSDC with a faucet
#   USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65 ENV_SUFFIX=-usdc ./scripts/fuji-deploy.sh
#                                                 uses Circle's USDC on Fuji; writes app/.env.fuji-usdc etc.
# Needs .env.fuji with FUJI_RPC, TICKET_ORGANIZER_*, GUEST_A_*, GUEST_B_*, GATE_* (test wallets holding test AVAX) and
# SAFE_ADDRESS (run `node scripts/fuji-safe.mjs` first): the Safe receives the 3 % platform fee.
# Demo events and sample activity come afterwards from `node scripts/fuji-seed.mjs`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
[ -f .env.fuji ] || { echo "Missing .env.fuji (test wallets). See README." >&2; exit 1; }
set -a; . ./.env.fuji; set +a
RPC="$FUJI_RPC"
ORG="$TICKET_ORGANIZER_ADDRESS"; ORG_KEY="$TICKET_ORGANIZER_KEY"
SUFFIX="${ENV_SUFFIX:-}"
[ -n "${SAFE_ADDRESS:-}" ] || { echo "Missing SAFE_ADDRESS. Run: node scripts/fuji-safe.mjs" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC")" = 43113 ] || { echo "RPC is not Fuji (43113)." >&2; exit 1; }
send() { cast send "$@" --rpc-url "$RPC" >/dev/null; }

export FEE_RECIPIENT="$SAFE_ADDRESS" FEE_BPS="${FEE_BPS:-300}"
forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$ORG_KEY" --broadcast --silent
RUN=broadcast/Deploy.s.sol/43113/run-latest.json
read -r USDC VAULT BOX BLOCK < <(python3 - "$RUN" "${USDC_ADDRESS:-}" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
c = [t['contractAddress'] for t in r['transactions'] if t['transactionType'] == 'CREATE']
if sys.argv[2]:
    c = [sys.argv[2]] + c
print(*c, int(r['receipts'][0]['blockNumber'], 16))
PY
)
echo "USDC $USDC · FloatVault $VAULT · VeGoc $BOX · block $BLOCK · fee $FEE_BPS bps → $FEE_RECIPIENT"

FAUCET=0
if [ -z "${USDC_ADDRESS:-}" ]; then
  FAUCET=1
  # Mock yield is paid from each event's own reserve, funded by the organizer wallet when the seed script creates
  # the events: here that wallet takes faucet USDC and lets the vault pull from it.
  send "$USDC" 'faucet()' --private-key "$ORG_KEY"
  send "$USDC" 'approve(address,uint256)' "$VAULT" 115792089237316195423570985008687907853269984665640564039457584007913129639935 --private-key "$ORG_KEY"
fi

VERIFY=(--chain 43113 --verifier custom --verifier-url 'https://api.routescan.io/v2/network/testnet/evm/43113/etherscan' --etherscan-api-key verifyContract --watch)
verify() { forge verify-contract "$@" "${VERIFY[@]}" || echo "verification of $1 did not finish; rerun: forge verify-contract $*" >&2; }
[ "$FAUCET" = 1 ] && verify "$USDC" src/MockUSDC.sol:MockUSDC
verify "$VAULT" src/FloatVault.sol:FloatVault --constructor-args "$(cast abi-encode 'c(address)' "$USDC")"
verify "$BOX" src/VeGoc.sol:VeGoc --constructor-args "$(cast abi-encode 'c(address,address,address,uint256)' "$USDC" "$VAULT" "$FEE_RECIPIENT" "$FEE_BPS")"

cat > "app/.env.fuji$SUFFIX" <<ENV
EXPO_PUBLIC_CHAIN_ID=43113
EXPO_PUBLIC_RPC_URL=$RPC
EXPO_PUBLIC_CONTRACT=$BOX
EXPO_PUBLIC_USDC=$USDC
EXPO_PUBLIC_FAUCET=$FAUCET
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Fuji
EXPO_PUBLIC_EXPLORER=https://testnet.snowtrace.io
# The contract lets anyone create events; the app lists only these organizers (the team Safe and the organizer wallet).
EXPO_PUBLIC_ORGANIZERS=$SAFE_ADDRESS,$ORG
# Throwaway guest and gate keys only: anything here is readable from the app bundle. The organizer uses the admin console.
EXPO_PUBLIC_DEV_KEYS=$GUEST_A_KEY,$GUEST_B_KEY,$GATE_KEY
EXPO_PUBLIC_DEV_NAMES="Guest A,Guest B,Gate staff"
ENV
cat > "admin/.env.fuji$SUFFIX" <<ENV
VITE_CHAIN_ID=43113
VITE_RPC_URL=$RPC
VITE_CONTRACT=$BOX
VITE_USDC=$USDC
VITE_VAULT=$VAULT
VITE_NATIVE_SYMBOL=AVAX
VITE_NETWORK_NAME=Fuji
VITE_EXPLORER=https://testnet.snowtrace.io
VITE_DEPLOY_BLOCK=$BLOCK
VITE_LOG_CHUNK=${LOG_CHUNK:-20000}
# Safes this console trusts as organizers (verified against the canonical Safe proxy code and singleton as well).
VITE_SAFES=$SAFE_ADDRESS
# Avalanche Data API (Glacier): first paint of the activity feed; the chunked eth_getLogs scan still completes it.
VITE_DATA_API=https://glacier-api.avax.network
ENV
python3 - "$USDC" "$VAULT" "$BOX" "$BLOCK" "$FEE_RECIPIENT" "$FEE_BPS" "$RUN" > "docs/fuji-deployment$SUFFIX.json" <<'PY'
import json, sys
usdc, vault, box, block, fee_to, fee_bps, run = sys.argv[1:8]
txs = [t['hash'] for t in json.load(open(run))['transactions']]
print(json.dumps({'chainId': 43113, 'usdc': usdc, 'vault': vault, 'veGoc': box, 'deployBlock': int(block), 'feeRecipient': fee_to, 'feeBps': int(fee_bps), 'deployTxs': txs}, indent=1))
PY
echo "Ready on Fuji: https://testnet.snowtrace.io/address/$BOX"
