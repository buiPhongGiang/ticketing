#!/usr/bin/env bash
# Demo data on the local chain from dev-chain.sh: wallet #1 buys 3 tickets, wallet #2 buys 2.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8545}"
MNEMONIC="test test test test test test test test test test test junk"
CONTRACT="$(grep '^VITE_CONTRACT=' "$ROOT/admin/.env.dev" | cut -d= -f2)"
PRICE="$(cast call "$CONTRACT" 'price()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)"
buy() { # wallet index, quantity
  cast send "$CONTRACT" 'buy(uint256)' "$2" --value "$((PRICE * $2))" --rpc-url "$RPC" \
    --private-key "$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1")" >/dev/null
}
buy 1 3
buy 2 2
echo "Seeded: wallet #1 bought 3, wallet #2 bought 2 on $CONTRACT"
