#!/usr/bin/env bash
# Deploys PaymentReceipts to Avalanche Fuji and verifies it on Routescan (Snowtrace). The only wallet allowed to
# record is the relayer (GATE_ADDRESS in .env.fuji: the relayer runs with the gate key). One transaction.
#   ./scripts/fuji-receipts.sh
# Then set EXPO_PUBLIC_RECEIPTS (app), VITE_RECEIPTS (console) and PAY_RECEIPTS (relayer) to the printed address.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
[ -f .env.fuji ] || { echo "Missing .env.fuji (test wallets). See README." >&2; exit 1; }
set -a; . ./.env.fuji; set +a
[ "$(cast chain-id --rpc-url "$FUJI_RPC")" = 43113 ] || { echo "RPC is not Fuji (43113)." >&2; exit 1; }
OUT="$(forge create src/PaymentReceipts.sol:PaymentReceipts --rpc-url "$FUJI_RPC" --private-key "$TICKET_ORGANIZER_KEY" --broadcast --constructor-args "[$GATE_ADDRESS]")"
ADDRESS="$(echo "$OUT" | awk '/Deployed to:/ {print $3}')"
echo "$OUT" | grep -E 'Deployed to|Transaction hash'
forge verify-contract "$ADDRESS" src/PaymentReceipts.sol:PaymentReceipts \
  --constructor-args "$(cast abi-encode 'c(address[])' "[$GATE_ADDRESS]")" \
  --chain 43113 --verifier custom --verifier-url 'https://api.routescan.io/v2/network/testnet/evm/43113/etherscan' --etherscan-api-key verifyContract --watch
