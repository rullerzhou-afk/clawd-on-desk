#!/bin/zsh
# Clawd dance party: put Clawd in his headphones-groove state and shuffle his
# album. Ctrl-C (or kill) stops the music and lets him go back to work.
# Usage: clawd-dance [minutes]        shuffle ~/.clawd/dance/tracks/
#        clawd-dance chip [minutes]   play the original chiptune song instead

TRACKS_DIR="${HOME}/.clawd/dance/tracks"
CHIP="${HOME}/.clawd/dance/clawd-dance-track.wav"
PORT=$(python3 -c "import json;print(json.load(open('${HOME}/.clawd/runtime.json'))['port'])" 2>/dev/null || echo 23333)
URL="http://127.0.0.1:${PORT}/state"
SID="custom-dance-party"

MODE=album
if [[ "$1" == "chip" ]]; then MODE=chip; shift; fi

groove() {
  curl -s -m 2 -X POST "$URL" -H 'content-type: application/json' \
    -d "{\"state\":\"juggling\",\"session_id\":\"${SID}\"}" >/dev/null
}

cleanup() {
  kill "$PLAYER_PID" 2>/dev/null
  curl -s -m 2 -X POST "$URL" -H 'content-type: application/json' \
    -d "{\"state\":\"idle\",\"session_id\":\"${SID}\"}" >/dev/null
  echo "\nparty over. Clawd back to work."
  exit 0
}
trap cleanup INT TERM

END=0
if [[ -n "$1" ]]; then END=$(( $(date +%s) + $1 * 60 )); fi

echo "🦀🎧 Clawd dance party ($MODE) — Ctrl-C to stop"
while :; do
  if [[ "$MODE" == "chip" ]]; then
    playlist=("$CHIP")
  else
    playlist=($(ls "$TRACKS_DIR"/*.mp3 2>/dev/null | sort -R))
    [[ ${#playlist[@]} -eq 0 ]] && playlist=("$CHIP")
  fi
  for track in "${playlist[@]}"; do
    groove                     # re-assert groove per track (beats state timeouts)
    echo "▶ ${track:t}"
    afplay "$track" &
    PLAYER_PID=$!
    wait "$PLAYER_PID"
    if (( END > 0 && $(date +%s) >= END )); then cleanup; fi
  done
done
