#!/usr/bin/env bash
# Starts a local anvil chain, deploys MockUSDC + FloatVault + VeGoc (3 % platform fee to wallet #0), funds the
# mock-yield reserve, creates three demo events and writes app/.env.dev and admin/.env.dev.
# Wallets: #0 organizer, #1 guest A, #2 guest B, #3 gate staff.
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
send() { cast send "$@" --rpc-url "$RPC" >/dev/null; }

cd "$ROOT"
FEE_RECIPIENT="${addrs[0]}" FEE_BPS=300 forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "${keys[0]}" --broadcast --silent
# Deterministic on a fresh anvil: deployer #0, nonces 0-2.
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
VAULT=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
BOX=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0

# Mock yield is paid from a reserve somebody funded: the organizer puts in 500 faucet USDC.
send "$USDC" 'faucet()' --private-key "${keys[0]}"
send "$USDC" 'approve(address,uint256)' "$VAULT" 500000000 --private-key "${keys[0]}"
send "$VAULT" 'fundReserve(uint256)' 500000000 --private-key "${keys[0]}"

NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
SIG='createEvent(string,string,uint64,uint64,uint32,string[],uint128[],uint32[])'
send "$BOX" "$SIG" "Neon Pulse Festival" "SECC Hall B, HCMC" $((NOW + 864000)) $((NOW + 882000)) 4 '["GA","VIP"]' '[25000000,60000000]' '[150,30]' --private-key "${keys[0]}"
send "$BOX" "$SIG" "Saigon Indie Night" "Soul Live Project, HCMC" $((NOW + 1468800)) $((NOW + 1483200)) 4 '["GA"]' '[15000000]' '[80]' --private-key "${keys[0]}"
send "$BOX" "$SIG" "Rooftop Session" "District 1, HCMC" $((NOW - 3600)) $((NOW + 600)) 4 '["GA"]' '[10000000]' '[40]' --private-key "${keys[0]}"
for id in 0 1 2; do send "$BOX" 'setScanner(uint256,address,bool)' $id "${addrs[3]}" true --private-key "${keys[0]}"; done
# The guests take test USDC but give no allowance: the app then buys with an EIP-2612 permit in one transaction.
for i in 1 2; do send "$USDC" 'faucet()' --private-key "${keys[$i]}"; done

cat > "$ROOT/app/.env.dev" <<ENV
EXPO_PUBLIC_CHAIN_ID=31337
EXPO_PUBLIC_RPC_URL=http://$RPC_HOST:$PORT
EXPO_PUBLIC_CONTRACT=$BOX
EXPO_PUBLIC_USDC=$USDC
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Anvil
EXPO_PUBLIC_DEV_KEYS=${keys[1]},${keys[2]},${keys[3]}
EXPO_PUBLIC_DEV_NAMES="Guest A,Guest B,Gate staff"
ENV
cat > "$ROOT/admin/.env.dev" <<ENV
VITE_CHAIN_ID=31337
VITE_RPC_URL=http://$RPC_HOST:$PORT
VITE_CONTRACT=$BOX
VITE_USDC=$USDC
VITE_VAULT=$VAULT
VITE_NATIVE_SYMBOL=AVAX
VITE_NETWORK_NAME=Anvil
VITE_DEPLOY_BLOCK=0
ENV
echo "Ready: VeGoc $BOX, USDC $USDC on $RPC. App wallets: guest A, guest B, gate. Admin: wallet #0."
wait "$ANVIL"
