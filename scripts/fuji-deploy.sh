#!/usr/bin/env bash
# Deploys one event to Avalanche Fuji testnet with the wallets in .env.fuji, funds the other test wallets,
# grants the gate wallet, seeds a few purchases, and writes app/.env.fuji and admin/.env.fuji.
# Prerequisite: ORGANIZER_ADDRESS holds test AVAX from the faucet (https://core.app/tools/testnet-faucet/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
[ -f .env.fuji ] || { echo "Missing .env.fuji (test wallets). See README." >&2; exit 1; }
set -a; . ./.env.fuji; set +a
RPC="$FUJI_RPC"
PRICE_WEI="${TICKET_PRICE_WEI:-1000000000000000}"   # 0.001 AVAX
FUND_WEI="${FUND_WEI:-50000000000000000}"            # 0.05 AVAX to each other wallet
# The official public RPC allows 100-block log queries; publicnode.com allows 2000 (set LOG_CHUNK=2000).

[ "$(cast chain-id --rpc-url "$RPC")" = 43113 ] || { echo "RPC is not Fuji (43113)." >&2; exit 1; }
balance="$(cast balance "$ORGANIZER_ADDRESS" --rpc-url "$RPC")"
echo "Organizer $ORGANIZER_ADDRESS has $(cast from-wei "$balance") AVAX"
[ "$balance" != 0 ] || { echo "Fund the organizer from the faucet first." >&2; exit 1; }

TICKET_NAME="Demo Night" TICKET_SYMBOL=SHOW TICKET_SUPPLY=20 TICKET_PRICE_WEI="$PRICE_WEI" ORGANIZER="$ORGANIZER_ADDRESS" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$ORGANIZER_KEY" --broadcast --silent
RUN=broadcast/Deploy.s.sol/43113/run-latest.json
CONTRACT="$(python3 -c "import json;print(json.load(open('$RUN'))['transactions'][0]['contractAddress'])")"
DEPLOY_BLOCK="$(python3 -c "import json;print(int(json.load(open('$RUN'))['receipts'][0]['blockNumber'],16))")"
echo "Contract $CONTRACT at block $DEPLOY_BLOCK"

for who in GUEST_A GUEST_B GATE; do
  addr_var="${who}_ADDRESS"
  cast send "${!addr_var}" --value "$FUND_WEI" --rpc-url "$RPC" --private-key "$ORGANIZER_KEY" >/dev/null
done
cast send "$CONTRACT" 'setScanner(address,bool)' "$GATE_ADDRESS" true --rpc-url "$RPC" --private-key "$ORGANIZER_KEY" >/dev/null
# Sample sales: guest A buys 3, guest B buys 2.
cast send "$CONTRACT" 'buy(uint256)' 3 --value "$((PRICE_WEI * 3))" --rpc-url "$RPC" --private-key "$GUEST_A_KEY" >/dev/null
cast send "$CONTRACT" 'buy(uint256)' 2 --value "$((PRICE_WEI * 2))" --rpc-url "$RPC" --private-key "$GUEST_B_KEY" >/dev/null

cat > app/.env.fuji <<ENV
EXPO_PUBLIC_CHAIN_ID=43113
EXPO_PUBLIC_RPC_URL=$RPC
EXPO_PUBLIC_CONTRACT=$CONTRACT
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Fuji
EXPO_PUBLIC_EVENT_NAME="Demo Night"
EXPO_PUBLIC_EVENT_WHEN="21/11 19:00"
EXPO_PUBLIC_EVENT_VENUE="Stage A"
# Throwaway guest and gate keys only: anything here is readable from the app bundle. The organizer uses the admin console.
EXPO_PUBLIC_DEV_KEYS=$GUEST_A_KEY,$GUEST_B_KEY,$GATE_KEY
EXPO_PUBLIC_DEV_NAMES="Guest A,Guest B,Gate staff"
ENV
cat > admin/.env.fuji <<ENV
VITE_CHAIN_ID=43113
VITE_RPC_URL=$RPC
VITE_CONTRACT=$CONTRACT
VITE_NATIVE_SYMBOL=AVAX
VITE_NETWORK_NAME=Fuji
VITE_EVENT_NAME="Demo Night"
VITE_EVENT_WHEN="21/11 19:00"
VITE_EVENT_VENUE="Stage A"
VITE_DEPLOY_BLOCK=$DEPLOY_BLOCK
VITE_LOG_CHUNK=${LOG_CHUNK:-100}
ENV
echo "Ready on Fuji: https://testnet.snowtrace.io/address/$CONTRACT"
echo "Admin: cd admin && npx vite --mode fuji   ·   App: cd app && ENV_FILE=.env.fuji npm run web"
