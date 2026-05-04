#!/usr/bin/env bash
# Clawd Desktop Pet — Remote Hook Deployment
# Deploys hook files to a remote server and registers Claude Code hooks.
#
# Usage:
#   bash scripts/remote-deploy.sh user@host
#
# Prerequisites:
#   - SSH access to the remote server
#   - Node.js installed on the remote server
#   - Clawd running locally (for port detection)

set -euo pipefail

# ── Args ──

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/remote-deploy.sh user@host [--prefix NAME]"
  echo ""
  echo "Deploys Clawd hook files to a remote server so that"
  echo "Claude Code and Codex CLI states are synced back to your"
  echo "local Clawd via SSH reverse port forwarding."
  echo ""
  echo "Options:"
  echo "  --prefix NAME   Short name for this machine (shown in Sessions menu)."
  echo "                  If omitted, hostname is used automatically."
  exit 1
fi

SSH_TARGET="$1"
HOST_PREFIX=""
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) HOST_PREFIX="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/../hooks" && pwd)"
REMOTE_HOOKS_DIR='~/.claude/hooks'

# Files to deploy
FILES=(
  "$HOOKS_DIR/server-config.js"
  "$HOOKS_DIR/json-utils.js"
  "$HOOKS_DIR/shared-process.js"
  "$HOOKS_DIR/clawd-hook.js"
  "$HOOKS_DIR/install.js"
  "$HOOKS_DIR/codex-hook.js"
  "$HOOKS_DIR/codex-install.js"
  "$HOOKS_DIR/codex-install-utils.js"
  "$HOOKS_DIR/codex-remote-monitor.js"
  "$HOOKS_DIR/codex-session-index.js"
  "$HOOKS_DIR/codex-subagent-fields.js"
)

# ── Local port detection ──

LOCAL_PORT=23333
RUNTIME_JSON="$HOME/.clawd/runtime.json"

if [ -f "$RUNTIME_JSON" ]; then
  DETECTED_PORT=$(node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync('$RUNTIME_JSON', 'utf8')).port;
      if (Number.isInteger(p) && p >= 23333 && p <= 23337) console.log(p);
      else console.log(23333);
    } catch { console.log(23333); }
  " 2>/dev/null || echo 23333)
  LOCAL_PORT="$DETECTED_PORT"
fi

echo "Deploying Clawd hooks to $SSH_TARGET..."
echo "  Local Clawd port: $LOCAL_PORT"
echo ""

# ── Verify local files ──

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Missing file: $f"
    exit 1
  fi
done

# ── Remote prerequisites ──

echo "Checking remote prerequisites..."

# Create remote directory
ssh "$SSH_TARGET" "mkdir -p ~/.claude/hooks" || {
  echo "ERROR: Failed to create remote directory"
  exit 1
}

# Check Node.js
REMOTE_NODE=$(ssh "$SSH_TARGET" "command -v node && node --version 2>/dev/null || echo MISSING" 2>/dev/null)
if echo "$REMOTE_NODE" | grep -q "MISSING"; then
  echo "ERROR: Node.js not found on remote server"
  echo "Install Node.js on the remote server first."
  exit 1
fi
echo "  Remote node: $(echo "$REMOTE_NODE" | tail -1)"

# ── Deploy files ──

echo "Copying hook files..."
scp -q "${FILES[@]}" "$SSH_TARGET:~/.claude/hooks/" || {
  echo "ERROR: scp failed"
  exit 1
}
echo "  [OK] Files copied to ~/.claude/hooks/"

# ── Write host prefix ──

if [ -n "$HOST_PREFIX" ]; then
  echo "Writing host prefix: $HOST_PREFIX"
  ssh "$SSH_TARGET" "echo '$HOST_PREFIX' > ~/.claude/hooks/clawd-host-prefix"
  echo "  [OK] Prefix written to ~/.claude/hooks/clawd-host-prefix"
fi

# ── Register hooks ──

echo "Registering Claude Code hooks (remote mode)..."
ssh "$SSH_TARGET" "node ~/.claude/hooks/install.js --remote" || {
  echo "WARNING: Hook registration failed (Claude Code may not be installed on remote)"
}

echo "Registering Codex official hooks (remote mode)..."
ssh "$SSH_TARGET" "node ~/.claude/hooks/codex-install.js --remote" || {
  echo "WARNING: Codex official hook registration failed (Codex CLI may not be installed on remote)"
}

# ── Print SSH configuration ──

# Extract host and user from SSH target
SSH_HOST="${SSH_TARGET#*@}"
SSH_USER="${SSH_TARGET%@*}"
if [ "$SSH_USER" = "$SSH_TARGET" ]; then
  SSH_USER=""
fi

echo ""
echo "=========================================="
echo "  SSH Configuration"
echo "=========================================="
echo ""
echo "Add to your local ~/.ssh/config:"
echo ""
echo "  Host ${SSH_HOST}"
if [ -n "$SSH_USER" ]; then
echo "      User ${SSH_USER}"
fi
echo "      RemoteForward 127.0.0.1:23333 127.0.0.1:${LOCAL_PORT}"
echo "      ExitOnForwardFailure yes"
echo "      ServerAliveInterval 30"
echo "      ServerAliveCountMax 3"
echo ""
echo "Then connect with:  ssh ${SSH_HOST}"
echo ""
echo "=========================================="
echo "  Codex Remote Fallback"
echo "=========================================="
echo ""
echo "Codex official hooks were registered when ~/.codex exists."
echo "If hooks are unavailable or disabled on the remote Codex install,"
echo "you can still start the fallback Codex log monitor:"
echo ""
echo "  node ~/.claude/hooks/codex-remote-monitor.js"
echo ""
echo "Or run in background:"
echo ""
echo "  nohup node ~/.claude/hooks/codex-remote-monitor.js > /dev/null 2>&1 &"
echo ""
echo "The fallback monitor polls Codex JSONL logs and syncs states"
echo "back to your local Clawd through the SSH tunnel."
echo "If the tunnel disconnects, it keeps running silently"
echo "and resumes syncing when you reconnect."
echo ""
echo "Done!"
