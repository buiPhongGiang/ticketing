#!/usr/bin/env bash
# Loads the app's network settings explicitly, so they cannot leak into the test build the way an
# auto-loaded .env.local would. Use ENV_FILE to pick another network.
set -euo pipefail
FILE="${ENV_FILE:-.env.dev}"
if [ ! -f "$FILE" ]; then
  echo "Missing $FILE. Run ../scripts/dev-chain.sh or set ENV_FILE. See README." >&2
  exit 1
fi
set -a; . "./$FILE"; set +a
exec npx "$@"
