# Clawd CloudBase CLI shell integration — auto-injected by clawd-on-desk
# Wraps tcb/cloudbase commands: detects ✖ in output → error, otherwise → success

if [ -z "$_CLAWD_TCB_LOADED" ]; then
_CLAWD_TCB_LOADED=1

_CLAWD_TCB_BIN=$(command -v tcb 2>/dev/null)
_CLAWD_CLOUDBASE_BIN=$(command -v cloudbase 2>/dev/null)

_clawd_notify() {
  local port=23333
  # Read port from Clawd runtime config
  if [ -f "$HOME/.clawd/runtime.json" ]; then
    local p
    p=$(grep -o '"port":[0-9]*' "$HOME/.clawd/runtime.json" 2>/dev/null | grep -o '[0-9]*')
    [ -n "$p" ] && port="$p"
  fi
  curl -sX POST "http://127.0.0.1:${port}/state" \
    -H Content-Type:application/json \
    -d "{\"state\":\"$1\",\"session_id\":\"tcb-shell\",\"event\":\"$2\",\"agent_id\":\"cloudbase-cli\"}" \
    >/dev/null 2>&1 &
}

tcb() {
  if [ -z "$_CLAWD_TCB_BIN" ]; then
    echo "tcb: command not found" >&2
    return 127
  fi
  local _out
  _out=$(mktemp /tmp/clawd-tcb-XXXXXX)
  "$_CLAWD_TCB_BIN" "$@" 2>&1 | tee "$_out"
  local _rc=${pipestatus[1]:-${PIPESTATUS[0]:-$?}}
  if grep -q '✖' "$_out" 2>/dev/null || [ "$_rc" -ne 0 ]; then
    _clawd_notify error ProcessExit
  else
    _clawd_notify attention ProcessExit
  fi
  rm -f "$_out"
  return "$_rc"
}

cloudbase() {
  if [ -z "$_CLAWD_CLOUDBASE_BIN" ]; then
    echo "cloudbase: command not found" >&2
    return 127
  fi
  local _out
  _out=$(mktemp /tmp/clawd-tcb-XXXXXX)
  "$_CLAWD_CLOUDBASE_BIN" "$@" 2>&1 | tee "$_out"
  local _rc=${pipestatus[1]:-${PIPESTATUS[0]:-$?}}
  if grep -q '✖' "$_out" 2>/dev/null || [ "$_rc" -ne 0 ]; then
    _clawd_notify error ProcessExit
  else
    _clawd_notify attention ProcessExit
  fi
  rm -f "$_out"
  return "$_rc"
}

fi
