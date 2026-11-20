#!/usr/bin/env bash
# Sends the outcome of finished VeGoc events from the Fuji C-Chain to the Dispatch test L1 over ICM (Teleporter).
#   ./scripts/fuji-icm.sh            deploys AttendanceRelay (once), relays events 2 to 5, waits for delivery on
#                                    Dispatch and writes docs/fuji-icm.json
# AttendanceRelay names AttendanceMirror's future address on Dispatch: the deployer's first contract there. The mirror
# is not deployed (the deployer holds no DIS), so Teleporter on Dispatch receives each message and stores it as not
# executed. `forge script script/MirrorDryRun.s.sol --fork-url $DISPATCH_RPC` shows on a fork of Dispatch that the
# stored message runs once the mirror exists.
# Needs .env.fuji with FUJI_RPC and TICKET_ORGANIZER_ADDRESS/_KEY (test AVAX).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
set -a; . ./.env.fuji; set +a
RPC="$FUJI_RPC"
DISPATCH_RPC=https://subnets.avax.network/dispatch/testnet/rpc
DISPATCH_ID=0x9f3be606497285d0ffbb5ac9ba24aa60346a9b1812479ed66cb329f394a4b1c7
TELEPORTER=0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf
BOX=$(python3 -c "import json;print(json.load(open('docs/fuji-deployment.json'))['veGoc'])" 2>/dev/null || true)
BOX=${BOX:-0x6f5802cdeea534b66067607875e2e284fec93ef2}
ORG="$TICKET_ORGANIZER_ADDRESS"; KEY="$TICKET_ORGANIZER_KEY"
EVENTS="${EVENTS:-2 3 4 5}"
OUT=docs/fuji-icm.json

MIRROR=$(cast compute-address "$ORG" --nonce "$(cast nonce "$ORG" --rpc-url "$DISPATCH_RPC")" | awk '{print $NF}')
RELAY=$(python3 -c "import json;print(json.load(open('$OUT'))['relay'])" 2>/dev/null || true)
if [ -z "$RELAY" ]; then
  RELAY=$(forge create src/icm/AttendanceRelay.sol:AttendanceRelay --rpc-url "$RPC" --private-key "$KEY" --broadcast \
    --constructor-args "$BOX" "$TELEPORTER" "$DISPATCH_ID" "$MIRROR" | awk '/Deployed to:/{print $3}')
  echo "AttendanceRelay $RELAY (mirror on Dispatch will be $MIRROR)"
  forge verify-contract "$RELAY" src/icm/AttendanceRelay.sol:AttendanceRelay --chain 43113 --verifier custom \
    --verifier-url 'https://api.routescan.io/v2/network/testnet/evm/43113/etherscan' --etherscan-api-key verifyContract \
    --constructor-args "$(cast abi-encode 'c(address,address,bytes32,address)' "$BOX" "$TELEPORTER" "$DISPATCH_ID" "$MIRROR")" \
    --watch || echo "verification did not finish" >&2
fi

ROWS=()
for E in $EVENTS; do
  if [ "$(cast call "$RELAY" 'messageOf(uint256)(bytes32)' "$E" --rpc-url "$RPC")" != 0x0000000000000000000000000000000000000000000000000000000000000000 ]; then
    echo "event $E already relayed"; continue
  fi
  T0=$(python3 -c 'import time;print(time.time())')
  TX=$(cast send "$RELAY" 'relay(uint256)' "$E" --rpc-url "$RPC" --private-key "$KEY" --json | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"],int(r["gasUsed"],16))')
  read -r HASH GAS <<<"$TX"
  ID=$(cast call "$RELAY" 'messageOf(uint256)(bytes32)' "$E" --rpc-url "$RPC")
  # Delivery: Teleporter on Dispatch marks the message received (the public relayer pays the gas there).
  for _ in $(seq 1 60); do
    [ "$(cast call "$TELEPORTER" 'messageReceived(bytes32)(bool)' "$ID" --rpc-url "$DISPATCH_RPC")" = true ] && break
    sleep 1
  done
  SECS=$(python3 -c "import time;print(round(time.time()-$T0,1))")
  RECEIVED=$(cast call "$TELEPORTER" 'messageReceived(bytes32)(bool)' "$ID" --rpc-url "$DISPATCH_RPC")
  FAILED=$(cast call "$TELEPORTER" 'receivedFailedMessageHashes(bytes32)(bytes32)' "$ID" --rpc-url "$DISPATCH_RPC")
  echo "event $E: tx $HASH gas $GAS message $ID received=$RECEIVED after ${SECS}s storedAsFailed=$FAILED"
  ROWS+=("{\"event\":$E,\"tx\":\"$HASH\",\"gas\":$GAS,\"messageID\":\"$ID\",\"receivedOnDispatch\":$RECEIVED,\"secondsUntilReceived\":$SECS,\"storedFailedMessageHash\":\"$FAILED\"}")
done

python3 - "$OUT" "$RELAY" "$MIRROR" "$BOX" "${ROWS[@]+"${ROWS[@]}"}" <<'PY'
import json, sys, datetime
out, relay, mirror, box, *rows = sys.argv[1:]
try:
    d = json.load(open(out))
except Exception:
    d = {"relay": relay, "veGoc": box, "mirrorOnDispatch": mirror, "teleporter": "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf",
         "dispatchBlockchainID": "0x9f3be606497285d0ffbb5ac9ba24aa60346a9b1812479ed66cb329f394a4b1c7",
         "mirrorDeployed": False, "messages": []}
d["messages"] += [json.loads(r) for r in rows]
d["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
json.dump(d, open(out, "w"), indent=2)
print(f"wrote {out}")
PY
