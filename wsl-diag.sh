#!/usr/bin/env bash
# WSL Hook Diagnostic — run inside WSL to check why hooks aren't firing.
# Usage: bash wsl-diag.sh
set -e

echo "=== WSL Hook Diagnostic ==="
echo ""

# 1. Environment
echo "--- 1. Environment ---"
echo "WSL_DISTRO_NAME = ${WSL_DISTRO_NAME:-<NOT SET>}"
echo "CLAWD_WSL_DISTRO = ${CLAWD_WSL_DISTRO:-<NOT SET>}"
echo "HOME = $HOME"
echo ""

# 2. Hook files
echo "--- 2. Hook Files ---"
HOOKS_DIR="$HOME/.claude/hooks"
if [ -d "$HOOKS_DIR" ]; then
  echo "Hook dir exists: $HOOKS_DIR"
  echo "Files:"
  ls -la "$HOOKS_DIR"/*.js 2>/dev/null | awk '{print "  " $NF}' || echo "  (no .js files!)"
else
  echo "Hook dir MISSING: $HOOKS_DIR"
  echo "  → Pair has NOT been run, or it failed silently."
fi
echo ""

# 3. Settings.json hook registration
echo "--- 3. Hook Registration (settings.json) ---"
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  echo "Settings file exists."
  echo ""

  # Check for command hooks with QUOTES (the bug pattern)
  echo "  Checking for QUOTED hook commands (BUG — quotes cause silent failure):"
  quoted_count=$(grep -c '"command": *""' "$SETTINGS" 2>/dev/null || echo 0)
  if [ "$quoted_count" -gt 0 ]; then
    echo "  ❌ FOUND $quoted_count hook(s) with double-quoted command!"
    echo "     These hooks will SILENTLY FAIL in WSL."
    echo "     Example:"
    grep -m1 '"command": *""' "$SETTINGS" | head -1 | sed 's/^/       /'
  else
    echo "  ✅ No double-quoted commands found."
  fi
  echo ""

  # Show actual hook commands
  echo "  Hook commands registered:"
  python3 -c "
import json, sys
with open('$SETTINGS') as f:
    s = json.load(f)
hooks = s.get('hooks', {})
for event, entries in sorted(hooks.items()):
    if not isinstance(entries, list):
        continue
    for e in entries:
        if isinstance(e, dict) and 'command' in e:
            cmd = e['command']
            has_quotes = cmd.startswith('\"') or cmd.startswith(\"'\\\"\")
            status = '❌ QUOTED' if has_quotes else '✅ plain'
            print(f'  {event:25s} {status}  {cmd[:100]}')
" 2>/dev/null || echo "  (Python not available, skipping detailed check)"
  echo ""

  # Check for CLAWD_WSL_DISTRO env prefix in hook commands (old approach)
  wsl_prefix_count=$(grep -c 'CLAWD_WSL_DISTRO' "$SETTINGS" 2>/dev/null || echo 0)
  if [ "$wsl_prefix_count" -gt 0 ]; then
    echo "  ℹ️  CLAWD_WSL_DISTRO prefix found in hook commands (old approach, not harmful)"
  fi
else
  echo "  Settings file MISSING: $SETTINGS"
  echo "  → Claude Code may not be installed in this WSL distro."
fi
echo ""

# 4. Node.js
echo "--- 4. Node.js ---"
NODE_PATH=$(command -v node 2>/dev/null || echo "")
if [ -n "$NODE_PATH" ]; then
  echo "node found: $NODE_PATH"
  echo "version: $(node --version 2>/dev/null || echo 'unknown')"
else
  echo "❌ node NOT FOUND in PATH!"
fi
echo ""

# 5. Network — can we reach Clawd server?
echo "--- 5. Clawd Server Connectivity ---"
for port in 23333 23334 23335; do
  if curl -s --max-time 1 "http://127.0.0.1:$port/state" 2>/dev/null | grep -q '"ok":true'; then
    echo "✅ Clawd reachable at 127.0.0.1:$port"
  else
    echo "   No Clawd at 127.0.0.1:$port"
  fi
done
echo ""

# 6. Manual hook test
echo "--- 6. Manual Hook Execution Test ---"
if [ -f "$HOOKS_DIR/clawd-hook.js" ] && [ -n "$NODE_PATH" ]; then
  echo "Running: echo '{\"session_id\":\"diag-test\"}' | $NODE_PATH $HOOKS_DIR/clawd-hook.js SessionStart"
  echo '{"session_id":"diag-test","cwd":"/tmp"}' | timeout 3 "$NODE_PATH" "$HOOKS_DIR/clawd-hook.js" SessionStart 2>&1 || true
  echo ""
  echo "(Watch Clawd Dashboard — a 'diag-test' session should appear if hooks work)"
else
  echo "  Skipped — hook file or node not available."
fi
echo ""

# 7. Summary
echo "=== Summary ==="
echo ""
HAS_DIR=false; [ -d "$HOOKS_DIR" ] && HAS_DIR=true
HAS_SETTINGS=false; [ -f "$SETTINGS" ] && HAS_SETTINGS=true
HAS_NODE=false; [ -n "$NODE_PATH" ] && HAS_NODE=true

if $HAS_DIR && $HAS_SETTINGS && $HAS_NODE; then
  echo "✅ All prerequisites present."
  echo ""
  if [ "$quoted_count" -gt 0 ] 2>/dev/null; then
    echo "🔴 ROOT CAUSE: Hook commands have QUOTES."
    echo "   Fix: delete and re-Pair from Clawd Settings → Agents."
    echo "   Or manually run inside WSL:"
    echo "     rm -rf ~/.claude/hooks/"
    echo "     # Then click Pair in Clawd Settings again"
  else
    echo "✅ Hook commands are plain (correct format)."
    echo "   If hooks still don't fire, check:"
    echo "   1. Is Clawd running on Windows? (check system tray)"
    echo "   2. Run manual test above and check Dashboard"
    echo "   3. claude --version inside WSL to verify CC version"
  fi
else
  echo "⚠️  Missing prerequisites:"
  $HAS_DIR || echo "   - Hook directory not found (Run Pair in Settings)"
  $HAS_SETTINGS || echo "   - settings.json not found (Install Claude Code in WSL)"
  $HAS_NODE || echo "   - Node.js not found (Install Node.js in WSL)"
fi
