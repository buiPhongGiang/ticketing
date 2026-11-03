#!/usr/bin/env bash
# Starts a local anvil chain, deploys one event and writes app/.env.dev and admin/.env.dev.
# A physical phone cannot reach 127.0.0.1: run with RPC_HOST=<this machine's LAN IP>.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${PORT:-8545}"
RPC_HOST="${RPC_HOST:-127.0.0.1}"
RPC="http://127.0.0.1:$PORT"
MNEMONIC="test test test test test test test test test test test junk"

anvil --port "$PORT" --host 0.0.0.0 --silent &
ANVIL=$!
trap 'kill "$ANVIL" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

keys=(); addrs=()
for i in 0 1 2 3; do
  keys+=("$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$i")")
  addrs+=("$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$i")")
done

cd "$ROOT"
TICKET_NAME="Sự kiện thử" TICKET_SYMBOL=SHOW TICKET_SUPPLY=20 TICKET_PRICE_WEI=10000000000000000 ORGANIZER="${addrs[0]}" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "${keys[0]}" --broadcast --silent
CONTRACT="$(python3 -c "import json;print(json.load(open('broadcast/Deploy.s.sol/31337/run-latest.json'))['transactions'][0]['contractAddress'])")"
cast send "$CONTRACT" 'setScanner(address,bool)' "${addrs[3]}" true --rpc-url "$RPC" --private-key "${keys[0]}" >/dev/null

cat > "$ROOT/app/.env.dev" <<ENV
EXPO_PUBLIC_CHAIN_ID=31337
EXPO_PUBLIC_RPC_URL=http://$RPC_HOST:$PORT
EXPO_PUBLIC_CONTRACT=$CONTRACT
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Anvil
EXPO_PUBLIC_EVENT_NAME="Sự kiện thử"
EXPO_PUBLIC_EVENT_WHEN="21/11 19:00"
EXPO_PUBLIC_EVENT_VENUE="Sân khấu A"
EXPO_PUBLIC_DEV_KEYS=$(IFS=,; echo "${keys[*]}")
ENV
cat > "$ROOT/admin/.env.dev" <<ENV
VITE_CHAIN_ID=31337
VITE_RPC_URL=http://$RPC_HOST:$PORT
VITE_CONTRACT=$CONTRACT
VITE_NATIVE_SYMBOL=AVAX
VITE_NETWORK_NAME=Anvil
VITE_EVENT_NAME="Sự kiện thử"
VITE_EVENT_WHEN="21/11 19:00"
VITE_EVENT_VENUE="Sân khấu A"
VITE_DEPLOY_BLOCK=0
ENV
echo "Ready: contract $CONTRACT on $RPC. Wallets in the app: organizer, guest A, guest B, gate."
wait "$ANVIL"
