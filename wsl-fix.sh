#!/usr/bin/env bash
# Quick fix: manually re-run install.js with CLAWD_WSL_DISTRO set.
# This generates the correct plain-command hook format for WSL.
# Run INSIDE WSL.

set -e
HOOKS_DIR="$HOME/.claude/hooks"

echo "=== WSL Hook Fix ==="

if [ ! -d "$HOOKS_DIR" ]; then
  echo "❌ $HOOKS_DIR not found."
  echo "   Run Pair from Clawd Settings first, then re-run this script."
  exit 1
fi

if [ ! -f "$HOOKS_DIR/install.js" ]; then
  echo "❌ $HOOKS_DIR/install.js not found."
  echo "   Pair may have failed — check Clawd console logs."
  exit 1
fi

# Get the WSL distro name
DISTRO="${WSL_DISTRO_NAME:-unknown}"
echo "Distro: $DISTRO"

# Re-run install.js with CLAWD_WSL_DISTRO set
cd "$HOOKS_DIR"
echo "Running: CLAWD_WSL_DISTRO=$DISTRO node install.js"
CLAWD_WSL_DISTRO="$DISTRO" node install.js

echo ""
echo "=== Checking generated hooks ==="
echo ""

# Verify: look for QUOTED commands (the bug pattern)
QUOTED=$(grep -c '"command": *""' "$HOME/.claude/settings.json" 2>/dev/null || echo 0)
if [ "$QUOTED" -gt 0 ]; then
  echo "❌ FAILED: $QUOTED hook(s) still have double-quoted commands!"
  echo "   These will silently fail in WSL."
  echo "   Example:"
  grep -m1 '"command": *""' "$HOME/.claude/settings.json"
  echo ""
  echo "   Manual fix: edit ~/.claude/settings.json and remove the \" quotes"
  echo "   around the node path and script path in each hook command."
else
  echo "✅ Hook commands are plain (correct format for WSL)."
fi

echo ""
echo "=== Test Hook ==="
echo "Running a test hook now — check Clawd Dashboard..."
echo '{"session_id":"fix-test","cwd":"/tmp"}' | timeout 3 node "$HOOKS_DIR/clawd-hook.js" SessionStart 2>&1 || true
echo "Done. Check Dashboard for 'fix-test' session."
