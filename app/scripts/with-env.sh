#!/usr/bin/env bash
# Loads the app's network settings explicitly, so they cannot leak into the test build the way an
# auto-loaded .env.local would. Use ENV_FILE to pick another network.
set -euo pipefail
FILE="${ENV_FILE:-.env.dev}"
if [ ! -f "$FILE" ]; then
  echo "Không thấy $FILE. Chạy ../scripts/dev-chain.sh hoặc đặt ENV_FILE. Xem README." >&2
  exit 1
fi
set -a; . "./$FILE"; set +a
exec npx "$@"
