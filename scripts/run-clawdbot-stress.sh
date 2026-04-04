#!/usr/bin/env bash
set -euo pipefail

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is not installed. Install first: https://k6.io/docs/get-started/installation/" >&2
  exit 1
fi

SUITE="${1:-quick}"
BASE_URL="${2:-${BASE_URL:-http://127.0.0.1:23333}}"
API_PATH="${API_PATH:-/state}"
METHOD="${METHOD:-POST}"
TARGET_MODE="${TARGET_MODE:-auto}"

if [[ "$SUITE" != "quick" && "$SUITE" != "steady" && "$SUITE" != "spike" && "$SUITE" != "soak" ]]; then
  echo "Invalid suite: $SUITE"
  echo "Usage: bash scripts/run-clawdbot-stress.sh [quick|steady|spike|soak] [base_url]"
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="logs/perf/${TS}-${SUITE}"
mkdir -p "$OUT_DIR"

SUMMARY_JSON="${OUT_DIR}/summary.json"
RAW_JSON="${OUT_DIR}/raw.json"
META_TXT="${OUT_DIR}/meta.txt"

cat > "$META_TXT" <<EOF
suite=$SUITE
base_url=$BASE_URL
api_path=$API_PATH
method=$METHOD
started_at=$(date '+%Y-%m-%d %H:%M:%S')
EOF

echo "Running k6 suite: $SUITE"
echo "Output directory: $OUT_DIR"
echo ""

k6 run \
  perf/k6/clawdbot-stress.js \
  --env SUITE="$SUITE" \
  --env BASE_URL="$BASE_URL" \
  --env API_PATH="$API_PATH" \
  --env METHOD="$METHOD" \
  --env TARGET_MODE="$TARGET_MODE" \
  --env AUTH_TOKEN="${AUTH_TOKEN:-}" \
  --env AUTH_HEADER="${AUTH_HEADER:-Authorization}" \
  --env AUTH_PREFIX="${AUTH_PREFIX:-Bearer}" \
  --env THINK_TIME_MS="${THINK_TIME_MS:-200}" \
  --summary-export "$SUMMARY_JSON" \
  --out "json=$RAW_JSON"

echo ""
echo "Done."
echo "Summary: $SUMMARY_JSON"
echo "Raw: $RAW_JSON"
