#!/usr/bin/env bash
# Deploys MockUSDC + FloatVault + TicketBox to Avalanche Fuji, creates the demo events, grants the gate wallet,
# gives the guest wallets test USDC, seeds a few purchases and writes app/.env.fuji and admin/.env.fuji.
# Needs .env.fuji with FUJI_RPC, TICKET_ORGANIZER_*, GUEST_A_*, GUEST_B_*, GATE_* (test wallets holding test AVAX).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
[ -f .env.fuji ] || { echo "Missing .env.fuji (test wallets). See README." >&2; exit 1; }
set -a; . ./.env.fuji; set +a
RPC="$FUJI_RPC"
ORG="$TICKET_ORGANIZER_ADDRESS"; ORG_KEY="$TICKET_ORGANIZER_KEY"
[ "$(cast chain-id --rpc-url "$RPC")" = 43113 ] || { echo "RPC is not Fuji (43113)." >&2; exit 1; }
send() { cast send "$@" --rpc-url "$RPC" >/dev/null; }

forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$ORG_KEY" --broadcast --silent
RUN=broadcast/Deploy.s.sol/43113/run-latest.json
read -r USDC VAULT BOX BLOCK < <(python3 - "$RUN" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
c = [t['contractAddress'] for t in r['transactions'] if t['transactionType'] == 'CREATE']
print(*c, int(r['receipts'][0]['blockNumber'], 16))
PY
)
echo "MockUSDC $USDC · FloatVault $VAULT · TicketBox $BOX · block $BLOCK"

NOW=$(date +%s)
SIG='createEvent(string,string,uint64,uint64,uint32,string[],uint128[],uint32[])'
# 0: main demo event · 1: event the organizer cancels on camera · 2: short event that has already ended (settle demo)
send "$BOX" "$SIG" "Neon Pulse Festival" "SECC Hall B, HCMC" 1795867200 1795885200 4 '["GA","VIP"]' '[25000000,60000000]' '[150,30]' --private-key "$ORG_KEY"
send "$BOX" "$SIG" "Saigon Indie Night" "Soul Live Project, HCMC" 1796472000 1796486400 4 '["GA"]' '[15000000]' '[80]' --private-key "$ORG_KEY"
send "$BOX" "$SIG" "Rooftop Session" "District 1, HCMC" $((NOW - 3600)) $((NOW + ${SHORT_EVENT_SECONDS:-900})) 4 '["GA"]' '[10000000]' '[40]' --private-key "$ORG_KEY"
for id in 0 1 2; do send "$BOX" 'setScanner(uint256,address,bool)' $id "$GATE_ADDRESS" true --private-key "$ORG_KEY"; done

for who in GUEST_A GUEST_B; do
  k="${who}_KEY"
  send "$USDC" 'faucet()' --private-key "${!k}"
  send "$USDC" 'approve(address,uint256)' "$BOX" 115792089237316195423570985008687907853269984665640564039457584007913129639935 --private-key "${!k}"
done
send "$BOX" 'buy(uint256,uint256,uint256)' 0 0 1 --private-key "$GUEST_B_KEY"
send "$BOX" 'buy(uint256,uint256,uint256)' 1 0 2 --private-key "$GUEST_A_KEY"
send "$BOX" 'buy(uint256,uint256,uint256)' 1 0 1 --private-key "$GUEST_B_KEY"
send "$BOX" 'buy(uint256,uint256,uint256)' 2 0 3 --private-key "$GUEST_A_KEY"
send "$BOX" 'buy(uint256,uint256,uint256)' 2 0 2 --private-key "$GUEST_B_KEY"

cat > app/.env.fuji <<ENV
EXPO_PUBLIC_CHAIN_ID=43113
EXPO_PUBLIC_RPC_URL=$RPC
EXPO_PUBLIC_CONTRACT=$BOX
EXPO_PUBLIC_USDC=$USDC
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Fuji
EXPO_PUBLIC_EXPLORER=https://testnet.snowtrace.io
# Throwaway guest and gate keys only: anything here is readable from the app bundle. The organizer uses the admin console.
EXPO_PUBLIC_DEV_KEYS=$GUEST_A_KEY,$GUEST_B_KEY,$GATE_KEY
EXPO_PUBLIC_DEV_NAMES="Guest A,Guest B,Gate staff"
ENV
cat > admin/.env.fuji <<ENV
VITE_CHAIN_ID=43113
VITE_RPC_URL=$RPC
VITE_CONTRACT=$BOX
VITE_USDC=$USDC
VITE_VAULT=$VAULT
VITE_NATIVE_SYMBOL=AVAX
VITE_NETWORK_NAME=Fuji
VITE_EXPLORER=https://testnet.snowtrace.io
VITE_DEPLOY_BLOCK=$BLOCK
VITE_LOG_CHUNK=${LOG_CHUNK:-2000}
ENV
echo "Ready on Fuji: https://testnet.snowtrace.io/address/$BOX"
