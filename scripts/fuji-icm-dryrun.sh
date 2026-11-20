#!/usr/bin/env bash
# For each message in docs/fuji-icm.json: reads the message as sent on the Fuji C-Chain, then on a fork of the Dispatch
# test L1 checks that Teleporter stored that exact message, puts AttendanceMirror at its destination and retries it.
# Read-only on both chains; needs no key.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
FUJI=${FUJI_RPC_URL:-https://avalanche-fuji-c-chain-rpc.publicnode.com}
DISPATCH=https://subnets.avax.network/dispatch/testnet/rpc
SEND_TOPIC=0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8 # SendCrossChainMessage
python3 -c "import json;[print(m['tx'],m['messageID']) for m in json.load(open('docs/fuji-icm.json'))['messages']]" |
while read -r TX ID; do
  LOG=$(cast receipt "$TX" --rpc-url "$FUJI" --json | python3 -c "import json,sys;print(next(l['data'] for l in json.load(sys.stdin)['logs'] if l['topics'][0]=='$SEND_TOPIC'))")
  SEND_LOG=$LOG MESSAGE_ID=$ID forge script script/MirrorDryRun.s.sol --fork-url "$DISPATCH" 2>&1 | sed -n '/== Logs ==/,/^$/p'
done
