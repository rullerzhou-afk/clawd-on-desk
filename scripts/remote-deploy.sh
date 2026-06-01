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

quote_remote_arg() {
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

remote_node_command() {
  local script_name="$1"
  shift
  local node_q
  node_q="$(quote_remote_arg "$REMOTE_NODE_BIN")"
  printf '%s "$HOME/.claude/hooks/%s"' "$node_q" "$script_name"
  local arg
  for arg in "$@"; do
    printf ' %s' "$(quote_remote_arg "$arg")"
  done
}

REMOTE_NODE_PROBE=$(cat <<'REMOTE_NODE_PROBE_SCRIPT'
node_version_supported() {
  v="$1"
  major="${v#v}"
  major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 14 ]
}

emit_node() {
  p="$1"
  src="$2"
  if [ -z "$p" ]; then return 1; fi
  case "$p" in
    /*) ;;
    *) return 1 ;;
  esac
  if [ ! -x "$p" ]; then return 1; fi
  v="$("$p" --version 2>/dev/null)" || return 1
  node_version_supported "$v" || return 1
  printf 'CLAWD_REMOTE_NODE_BIN=%s\n' "$p"
  printf 'CLAWD_REMOTE_NODE_VERSION=%s\n' "$v"
  printf 'CLAWD_REMOTE_NODE_SOURCE=%s\n' "$src"
  exit 0
}

probe_login_shells() {
  for shell in "$SHELL" /bin/zsh /bin/bash /bin/sh
  do
    if [ -z "$shell" ]; then continue; fi
    case "$shell" in
      /*) ;;
      *) continue ;;
    esac
    if [ ! -x "$shell" ]; then continue; fi
    out="$("$shell" -lic 'printf "__CLAWD_REMOTE_NODE_PROBE__\n"; command -v node 2>/dev/null; which node 2>/dev/null; true' 2>/dev/null)"
    p="$(printf '%s\n' "$out" | awk 'found && $0 ~ /^\// { last=$0 } $0 == "__CLAWD_REMOTE_NODE_PROBE__" { found=1 } END { if (last) print last }')"
    emit_node "$p" "shell:$shell"
  done
}

p="$(command -v node 2>/dev/null || true)"
emit_node "$p" "path"

probe_login_shells

for p in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node \
  "$HOME"/.volta/bin/node \
  "$HOME"/.local/bin/node \
  "$HOME"/.nvm/current/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.fnm/node-versions/*/installation/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  "$HOME"/.asdf/installs/nodejs/*/bin/node \
  "$HOME"/.asdf/shims/node \
  "$HOME"/.mise/shims/node \
  "$HOME"/.local/share/mise/shims/node
do
  emit_node "$p" "candidate"
done

exit 127
REMOTE_NODE_PROBE_SCRIPT
)

# Files to deploy
FILES=(
  "$HOOKS_DIR/server-config.js"
  "$HOOKS_DIR/json-utils.js"
  "$HOOKS_DIR/shared-process.js"
  "$HOOKS_DIR/context-usage.js"
  "$HOOKS_DIR/clawd-hook.js"
  "$HOOKS_DIR/install.js"
  "$HOOKS_DIR/codex-hook.js"
  "$HOOKS_DIR/codex-assistant-output.js"
  "$HOOKS_DIR/codex-install.js"
  "$HOOKS_DIR/codex-install-utils.js"
  "$HOOKS_DIR/codex-remote-monitor.js"
  "$HOOKS_DIR/codex-session-index.js"
  "$HOOKS_DIR/codex-subagent-fields.js"
  "$HOOKS_DIR/copilot-hook.js"
  "$HOOKS_DIR/copilot-install.js"
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
REMOTE_NODE=$(ssh "$SSH_TARGET" "sh -c $(quote_remote_arg "$REMOTE_NODE_PROBE")" 2>/dev/null || true)
REMOTE_NODE_BIN=$(printf '%s\n' "$REMOTE_NODE" | sed -n 's/^CLAWD_REMOTE_NODE_BIN=//p' | head -n 1)
REMOTE_NODE_VERSION=$(printf '%s\n' "$REMOTE_NODE" | sed -n 's/^CLAWD_REMOTE_NODE_VERSION=//p' | head -n 1)
REMOTE_NODE_SOURCE=$(printf '%s\n' "$REMOTE_NODE" | sed -n 's/^CLAWD_REMOTE_NODE_SOURCE=//p' | head -n 1)
if [ -z "$REMOTE_NODE_BIN" ] || [ -z "$REMOTE_NODE_VERSION" ]; then
  echo "ERROR: Node.js not found on remote server"
  echo "Install Node.js on the remote server first."
  exit 1
fi
echo "  Remote node: $REMOTE_NODE_VERSION ($REMOTE_NODE_BIN via $REMOTE_NODE_SOURCE)"

# ── Deploy files ──

echo "Copying hook files..."
scp -q "${FILES[@]}" "$SSH_TARGET:~/.claude/hooks/" || {
  echo "ERROR: scp failed"
  exit 1
}
echo "  [OK] Files copied to ~/.claude/hooks/"

# ── Write host prefix ──

# Mirror the Node-side schema blacklist (src/remote-ssh-profile.js
# HOST_PREFIX_FORBIDDEN_RE) so the CLI path can't write a prefix the UI would
# refuse. Reject control chars + ' " ` $ \ ! before doing anything remote.
if [ -n "$HOST_PREFIX" ]; then
  if printf '%s' "$HOST_PREFIX" | LC_ALL=C grep -q $'[\x00-\x1f\x7f'\''"`$\\!]'; then
    echo "ERROR: --prefix contains forbidden chars (control chars or any of: ' \" \` \$ \\ !)"
    exit 1
  fi
  echo "Writing host prefix: $HOST_PREFIX"
  # Pipe via stdin so the prefix value never gets re-interpreted by the remote
  # shell — same defense as the Node deploy path (plan v7 §3.11). bash expands
  # $HOST_PREFIX once into printf's argument; printf %s writes the literal
  # bytes; ssh forwards stdin to `cat > path` on the remote.
  if printf '%s' "$HOST_PREFIX" | ssh "$SSH_TARGET" "cat > ~/.claude/hooks/clawd-host-prefix"; then
    echo "  [OK] Prefix written to ~/.claude/hooks/clawd-host-prefix"
  else
    echo "ERROR: failed to write host prefix"
    exit 1
  fi
fi

# ── Register hooks ──

echo "Registering Claude Code hooks (remote mode)..."
ssh "$SSH_TARGET" "$(remote_node_command install.js --remote)" || {
  echo "WARNING: Hook registration failed (Claude Code may not be installed on remote)"
}

echo "Registering Codex official hooks (remote mode)..."
ssh "$SSH_TARGET" "$(remote_node_command codex-install.js --remote)" || {
  echo "WARNING: Codex official hook registration failed (Codex CLI may not be installed on remote)"
}

echo "Registering Copilot CLI hooks (remote mode)..."
ssh "$SSH_TARGET" "$(remote_node_command copilot-install.js --remote)" || {
  echo "WARNING: Copilot CLI hook registration failed (Copilot CLI may not be installed on remote)"
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
echo "  $(remote_node_command codex-remote-monitor.js)"
echo ""
echo "Or run in background:"
echo ""
echo "  nohup $(remote_node_command codex-remote-monitor.js) > /dev/null 2>&1 &"
echo ""
echo "The fallback monitor polls Codex JSONL logs and syncs states"
echo "back to your local Clawd through the SSH tunnel."
echo "If the tunnel disconnects, it keeps running silently"
echo "and resumes syncing when you reconnect."
echo ""
echo "Done!"
