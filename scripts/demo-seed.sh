#!/usr/bin/env bash
# Demo data on the local chain from dev-chain.sh: guest A buys 2 GA for event 0, guest B buys 1 VIP,
# and both buy tickets for events 1 and 2.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8545}"
MNEMONIC="test test test test test test test test test test test junk"
BOX=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
buy() { # wallet index, event, tier, quantity, total in USDC base units
  local key; key="$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1")"
  cast send "$USDC" 'approve(address,uint256)' "$BOX" "$5" --rpc-url "$RPC" --private-key "$key" >/dev/null
  cast send "$BOX" 'buy(uint256,uint256,uint256)' "$2" "$3" "$4" --rpc-url "$RPC" --private-key "$key" >/dev/null
}
buy 1 0 0 2 50000000
buy 2 0 1 1 60000000
buy 1 1 0 1 15000000
buy 2 2 0 2 20000000
echo "Seeded event 0 (3 tickets), event 1 (1), event 2 (2)"
