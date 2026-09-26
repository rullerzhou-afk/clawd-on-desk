#!/usr/bin/env bash
# ci/wayland-smoke.sh — one isolated packaged-AppImage scenario per invocation.
#
# Usage:
#   wayland-smoke.sh manual-x11 <AppImage>
#   wayland-smoke.sh auto-xwayland <AppImage>
#   wayland-smoke.sh native-wayland-contract <AppImage>
#   wayland-smoke.sh appimage-claude-hooks <AppImage>
#   wayland-smoke.sh appimage-wrapper-termination <AppImage>
#
# manual-x11 and auto-xwayland are full health checks: /state answers and an X
# client window exists. native-wayland-contract deliberately checks only the
# escape-hatch contract (no relaunch, no X11 browser, process remains alive).
# appimage-claude-hooks boots the packaged AppImage, then asserts the Claude
# hook commands persisted into the isolated HOME are content-addressed
# persistent targets (never the transient FUSE mount) and still load after the
# AppImage exits. weston --backend=headless has no real input seat or DRM
# render node, so it is not a deterministic environment for full native-Wayland
# Electron health.
# appimage-wrapper-termination removes the owned FUSE wrappers before asking
# the healthy browser to quit, and checks both the exit code and file cleanup.

set -euo pipefail

SCENARIO="${1:?usage: wayland-smoke.sh <manual-x11|auto-xwayland|native-wayland-contract|appimage-claude-hooks|appimage-wrapper-termination> <AppImage>}"
APPIMAGE_ARG="${2:?usage: wayland-smoke.sh <manual-x11|auto-xwayland|native-wayland-contract|appimage-claude-hooks|appimage-wrapper-termination> <AppImage>}"
case "$SCENARIO" in
  manual-x11 | auto-xwayland | native-wayland-contract | appimage-claude-hooks | appimage-wrapper-termination) ;;
  *) printf 'Unknown scenario: %s\n' "$SCENARIO" >&2; exit 2 ;;
esac

APPIMAGE="$(readlink -f "$APPIMAGE_ARG")"
RELAUNCH_MARK="relaunching under XWayland"
PASS=0
ORIGINAL_PWD="$PWD"
ARTIFACT_DIR="$ORIGINAL_PWD/wayland-smoke-artifacts/$SCENARIO"
mkdir -p "$ARTIFACT_DIR"

ISOLATION_ROOT="$(mktemp -d "/tmp/clawd-wayland-${SCENARIO}.XXXXXX")"
export HOME="$ISOLATION_ROOT/home"
export XDG_CONFIG_HOME="$ISOLATION_ROOT/config"
export XDG_CACHE_HOME="$ISOLATION_ROOT/cache"
export XDG_DATA_HOME="$ISOLATION_ROOT/data"
export XDG_RUNTIME_DIR="$ISOLATION_ROOT/runtime"
USER_DATA_DIR="$ISOLATION_ROOT/user-data"
RUNTIME_CONFIG="$HOME/.clawd/runtime.json"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
  "$XDG_RUNTIME_DIR" "$USER_DATA_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

WAYLAND_SOCKET="wayland-smoke-${SCENARIO}-$$"
WESTON_PID=""
APP_LAUNCH_PID=""
XDISPLAY=""

note() { printf '\n== %s ==\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf 'PASS %s: %s\n' "$PASS" "$*"; }

# poll <seconds> <cmd...> — retry cmd every 0.5s until the deadline.
poll() {
  local deadline
  deadline=$(($(date +%s) + $1))
  shift
  while true; do
    "$@" >/dev/null 2>&1 && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 0.5
  done
}

runtime_port() {
  node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const port = Number(value && value.port);
      if (value.app !== "clawd-on-desk" || !Number.isInteger(port) || port < 23333 || port > 23337) {
        process.exit(1);
      }
      process.stdout.write(String(port));
    } catch {
      process.exit(1);
    }
  ' "$RUNTIME_CONFIG"
}

state_ok() {
  local port
  port="$(runtime_port)" || return 1
  curl -fsS --max-time 2 "http://127.0.0.1:${port}/state" >/dev/null
}

server_ports_clear() {
  ! ss -H -ltn 2>/dev/null | grep -Eq ':(23333|23334|23335|23336|23337)[[:space:]]'
}

# Every AppImage launch carries this unique marker. It survives the automatic
# XWayland relaunch and appears on browser/renderer command lines, giving this
# invocation an exact ownership boundary without broad pkill patterns.
owned_pids() {
  local d pid cmd
  for d in /proc/[0-9]*; do
    [ -r "$d/cmdline" ] || continue
    pid="${d#/proc/}"
    cmd="$(tr '\0' ' ' 2>/dev/null <"$d/cmdline")" || continue
    case "$cmd" in
      *"--user-data-dir=$USER_DATA_DIR"*) printf '%s\n' "$pid" ;;
    esac
  done
}

browser_pids() {
  local want_flag="${1:-}" pid cmd exe
  while read -r pid; do
    [ -n "$pid" ] || continue
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    # AppImage's shell supervisor also carries the original arguments. It is
    # not an Electron browser, even when it has --ozone-platform on its argv.
    [ "${exe##*/}" = clawd-on-desk ] || continue
    cmd="$(tr '\0' ' ' 2>/dev/null <"/proc/$pid/cmdline")" || continue
    case "$cmd" in *"--type="*) continue ;; esac
    if [ "$want_flag" = "x11" ]; then
      case "$cmd" in *"--ozone-platform=x11"*) printf '%s\n' "$pid" ;; esac
    else
      printf '%s\n' "$pid"
    fi
  done < <(owned_pids)
}

has_browser() { [ -n "$(browser_pids)" ]; }
has_x11_browser() { [ -n "$(browser_pids x11)" ]; }
no_x11_browser() { [ -z "$(browser_pids x11)" ]; }
no_owned_processes() { [ -z "$(owned_pids)" ]; }

# Exact env value from this invocation's own processes. The AppImage runtime
# exports APPIMAGE/APPDIR to the launched process; reading them back from
# /proc/<owned pid>/environ attributes them to THIS mount instead of whatever
# `ls /tmp/.mount_*` happened to see before launch.
proc_env_value() {
  local key="$1" pid line
  while read -r pid; do
    [ -n "$pid" ] || continue
    line="$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/environ" | grep -m1 "^${key}=" || true)"
    if [ -n "$line" ]; then printf '%s' "${line#${key}=}"; return 0; fi
  done < <(owned_pids)
  return 1
}

appimage_mount_dir() {
  local mount pid line
  while read -r pid; do
    [ -n "$pid" ] || continue
    line="$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/environ" | grep -m1 '^APPDIR=' || true)"
    mount="${line#APPDIR=}"
    if [ -n "$mount" ] && mountpoint -q -- "$mount"; then
      printf '%s' "$mount"; return 0
    fi
  done < <(owned_pids)
  while read -r pid; do
    [ -n "$pid" ] || continue
    mount="$(grep -m1 -oE '/tmp/\.mount_[^ /]+' "/proc/$pid/maps" 2>/dev/null || true)"
    if [ -n "$mount" ]; then printf '%s' "$mount"; return 0; fi
  done < <(owned_pids)
  return 1
}

x_has_clawd() {
  xlsclients -display "$XDISPLAY" -l 2>/dev/null | grep -qi clawd ||
    xwininfo -root -tree -display "$XDISPLAY" 2>/dev/null | grep -qi clawd
}

dump_diagnostics() {
  note "diagnostics: scenario"
  printf 'scenario=%s\nisolation_root=%s\nuser_data=%s\nruntime_config=%s\n' \
    "$SCENARIO" "$ISOLATION_ROOT" "$USER_DATA_DIR" "$RUNTIME_CONFIG"
  note "diagnostics: app log"
  cat "$ARTIFACT_DIR/app.log" 2>/dev/null || true
  note "diagnostics: Chromium log"
  tail -n 120 "$ARTIFACT_DIR/electron-child.log" 2>/dev/null || true
  note "diagnostics: Weston log"
  tail -n 80 "$ARTIFACT_DIR/weston.log" 2>/dev/null || true
  note "diagnostics: runtime.json"
  cat "$RUNTIME_CONFIG" 2>/dev/null || true
  note "diagnostics: owned processes"
  for pid in $(owned_pids); do
    ps -o pid,ppid,pgid,sid,stat,etime,args -p "$pid" 2>/dev/null || true
  done
  note "diagnostics: Clawd/AppImage processes"
  ps ax -o pid,ppid,pgid,sid,stat,etime,args |
    grep -iE 'clawd|\.mount_|AppImage|relauncher' |
    grep -v grep || true
  note "diagnostics: server ports"
  ss -tlnp 2>/dev/null | grep -E ':(23333|23334|23335|23336|23337)[[:space:]]' ||
    echo "(nothing listening)"
  note "diagnostics: X clients on ${XDISPLAY:-unset}"
  [ -n "${XDISPLAY:-}" ] &&
    xlsclients -display "$XDISPLAY" -l 2>/dev/null | head -30 || true
}

fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}

kill_owned_processes() {
  local pid pgid own_pgid
  local -a pgids=()
  own_pgid="$(ps -o pgid= -p $$ | tr -d ' ')"

  while read -r pid; do
    [ -n "$pid" ] || continue
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$pgid" ] || continue
    [ "$pgid" = "$own_pgid" ] && continue
    case " ${pgids[*]:-} " in
      *" $pgid "*) ;;
      *) pgids+=("$pgid") ;;
    esac
  done < <(owned_pids)

  for pgid in "${pgids[@]:-}"; do
    [ -n "$pgid" ] && kill -TERM -- "-$pgid" 2>/dev/null || true
  done
  poll 8 no_owned_processes && return 0

  for pid in $(owned_pids); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  poll 5 no_owned_processes || true
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  [ "$rc" -eq 0 ] || dump_diagnostics
  kill_owned_processes
  if [ -n "$APP_LAUNCH_PID" ]; then
    wait "$APP_LAUNCH_PID" 2>/dev/null || true
  fi
  if [ -n "$WESTON_PID" ]; then
    kill "$WESTON_PID" 2>/dev/null || true
    wait "$WESTON_PID" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

launch_app() {
  local log_file="$ARTIFACT_DIR/app.log"
  : >"$log_file"
  setsid "$@" "--user-data-dir=$USER_DATA_DIR" >"$log_file" 2>&1 &
  APP_LAUNCH_PID=$!
}

chmod +x "$APPIMAGE"
server_ports_clear || fail "a Clawd state port was occupied before launch"

note "starting isolated weston (headless) + Xwayland"
weston --backend=headless --xwayland --socket="$WAYLAND_SOCKET" \
  --width=1280 --height=800 --idle-time=0 >"$ARTIFACT_DIR/weston.log" 2>&1 &
WESTON_PID=$!
poll 15 test -S "$XDG_RUNTIME_DIR/$WAYLAND_SOCKET" ||
  fail "Weston Wayland socket never appeared"

# Weston starts Xwayland lazily. Probe a small display range to trigger it, then
# read the assigned display from the compositor log.
for _ in 1 2 3; do
  XDISPLAY="$(grep -oE 'display :[0-9]+' "$ARTIFACT_DIR/weston.log" |
    tail -1 | grep -oE ':[0-9]+' || true)"
  [ -n "$XDISPLAY" ] && break
  for n in 0 1 2 3 4 5; do
    if env DISPLAY=":$n" timeout 2 xdpyinfo >/dev/null 2>&1; then
      XDISPLAY=":$n"
      break 2
    fi
  done
  sleep 1
done
[ -n "$XDISPLAY" ] || fail "could not find the Xwayland display"
poll 15 env DISPLAY="$XDISPLAY" xdpyinfo ||
  fail "Xwayland on $XDISPLAY did not answer"

export WAYLAND_DISPLAY="$WAYLAND_SOCKET"
export XDG_SESSION_TYPE=wayland
export DISPLAY="$XDISPLAY"
export LIBGL_ALWAYS_SOFTWARE=1
export ELECTRON_ENABLE_LOGGING=file
export ELECTRON_LOG_FILE="$ARTIFACT_DIR/electron-child.log"
printf 'weston pid=%s, Xwayland display=%s\n' "$WESTON_PID" "$XDISPLAY"

case "$SCENARIO" in
  manual-x11 | appimage-wrapper-termination)
    note "manual --ozone-platform=x11"
    launch_app "$APPIMAGE" --ozone-platform=x11
    poll 90 state_ok || fail "manual X11: state server from runtime.json never answered"
    kill -0 "$APP_LAUNCH_PID" 2>/dev/null || fail "manual X11: launch process died"
    poll 60 has_x11_browser || fail "manual X11: no browser with --ozone-platform=x11"
    poll 60 x_has_clawd || fail "manual X11: no Clawd client/window on the X server"
    grep -q "$RELAUNCH_MARK" "$ARTIFACT_DIR/app.log" &&
      fail "manual X11 triggered the automatic relaunch"
    ok "manual X11 boots healthy with an X client window and no relaunch"
    if [ "$SCENARIO" = appimage-wrapper-termination ]; then
      MOUNT_DIR="$(appimage_mount_dir)" || fail "could not locate the owned FUSE mount"
      python3 "$(dirname "$0")/appimage-wrapper-shutdown.py" \
        "$APPIMAGE" "$USER_DATA_DIR" "$RUNTIME_CONFIG" "$MOUNT_DIR" >"$ARTIFACT_DIR/wrapper-shutdown.json"
      poll 15 no_owned_processes || fail "owned processes remained after wrapper-first shutdown"
      wait "$APP_LAUNCH_PID" || fail "AppImage supervisor reported an abnormal main exit"
      APP_LAUNCH_PID=""
      python3 - "$ARTIFACT_DIR/wrapper-shutdown.json" <<'PY'
import json, pathlib, sys
result = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not pathlib.Path(result["runtimeDirectory"]).exists(), "private runtime files were not cleaned up"
PY
      ok "wrapper-first shutdown exits cleanly from regular backing files"
    fi
    ;;

  auto-xwayland)
    note "plain launch must relaunch onto XWayland"
    launch_app "$APPIMAGE"
    poll 30 grep -q "$RELAUNCH_MARK" "$ARTIFACT_DIR/app.log" ||
      fail "initial process never logged the XWayland relaunch"
    ok "initial process planned and logged the XWayland relaunch"

    poll 30 sh -c "! kill -0 $APP_LAUNCH_PID 2>/dev/null" ||
      fail "throwaway process was still alive after 30 seconds"
    if wait "$APP_LAUNCH_PID"; then
      first_rc=0
    else
      first_rc=$?
    fi
    APP_LAUNCH_PID=""
    [ "$first_rc" -eq 0 ] || fail "throwaway process exited rc=$first_rc instead of 0"
    ok "throwaway process exited 0"

    poll 45 has_x11_browser ||
      fail "no replacement browser carried --ozone-platform=x11"
    first_x11_pids="$(browser_pids x11 | sort | tr '\n' ' ')"
    ok "replacement browser runs with --ozone-platform=x11 (pid(s): $first_x11_pids)"

    poll 90 state_ok || fail "replacement state server from runtime.json never answered"
    ok "replacement GET /state answers"
    poll 30 grep -q "state server listening" "$ARTIFACT_DIR/app.log" ||
      fail "replacement logs did not flow back to the launching terminal"
    ok "replacement logs are inherited"
    poll 60 x_has_clawd ||
      fail "replacement has no Clawd client/window on the X server"
    ok "replacement window is an XWayland client"

    sleep 5
    later_x11_pids="$(browser_pids x11 | sort | tr '\n' ' ')"
    [ "$first_x11_pids" = "$later_x11_pids" ] ||
      fail "browser pid set changed ('$first_x11_pids' -> '$later_x11_pids')"
    relaunch_lines="$(grep -c "$RELAUNCH_MARK" "$ARTIFACT_DIR/app.log")"
    [ "$relaunch_lines" -eq 1 ] ||
      fail "expected exactly one relaunch log line, got $relaunch_lines"
    ok "exactly one relaunch and a stable browser pid set"
    ;;

  native-wayland-contract)
    note "CLAWD_OZONE_PLATFORM=wayland packaged escape-hatch contract"
    export CLAWD_OZONE_PLATFORM=wayland
    launch_app "$APPIMAGE"
    poll 15 has_browser || fail "native Wayland browser process never appeared"
    sleep 15
    kill -0 "$APP_LAUNCH_PID" 2>/dev/null ||
      fail "native Wayland launch process did not remain alive for the contract window"
    has_browser ||
      fail "native Wayland browser did not remain alive for the contract window"
    grep -q "$RELAUNCH_MARK" "$ARTIFACT_DIR/app.log" &&
      fail "native Wayland override triggered the XWayland relaunch"
    no_x11_browser ||
      fail "native Wayland override produced a browser with --ozone-platform=x11"
    ok "packaged native-Wayland override stays alive without relaunching to X11"
    ;;

  appimage-claude-hooks)
    note "packaged Claude hooks must persist outside the FUSE mount"
    # Deterministic Claude Code version so the versioned hooks (PreCompact /
    # PostCompact / StopFailure) are always registered: exactly 14 managed
    # state commands under default prefs.
    CLAUDE_FIXTURE_BIN="$ISOLATION_ROOT/claude-fixture-bin"
    mkdir -p "$CLAUDE_FIXTURE_BIN"
    printf '#!/bin/sh\nprintf "2.1.274 (Claude Code)\\n"\n' >"$CLAUDE_FIXTURE_BIN/claude"
    chmod +x "$CLAUDE_FIXTURE_BIN/claude"
    export PATH="$CLAUDE_FIXTURE_BIN:$PATH"

    launch_app "$APPIMAGE"
    poll 90 state_ok || fail "appimage-claude-hooks: state server from runtime.json never answered"

    CLAUDE_SETTINGS="$HOME/.claude/settings.json"
    poll 60 test -f "$CLAUDE_SETTINGS" ||
      fail "appimage-claude-hooks: isolated Claude settings.json was never written"
    ok "isolated Claude settings.json written"

    # Attribute the marker/mount assertions to THIS launch, not a pre-existing
    # /tmp/.mount_* directory: read APPIMAGE/APPDIR back from an owned pid.
    poll 30 proc_env_value APPIMAGE >/dev/null ||
      fail "appimage-claude-hooks: could not read APPIMAGE from an owned process"
    APPIMAGE_RUN_VALUE="$(proc_env_value APPIMAGE)"
    [ -n "$APPIMAGE_RUN_VALUE" ] || fail "appimage-claude-hooks: APPIMAGE env value was empty"
    MOUNT_DIR="$(appimage_mount_dir || true)"
    [ -n "$MOUNT_DIR" ] || fail "appimage-claude-hooks: could not locate this launch's FUSE mount"
    [ -d "$MOUNT_DIR" ] || fail "appimage-claude-hooks: FUSE mount $MOUNT_DIR is not a directory"

    if ! node - "$CLAUDE_SETTINGS" "$APPIMAGE_RUN_VALUE" <<'NODE'
const fs = require("fs");
const path = require("path");
const [settingsPath, appImageValue] = process.argv.slice(2);
const CORE = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop", "Notification",
  "Elicitation",
];
const VERSIONED = ["PreCompact", "PostCompact", "StopFailure"];
const EXPECTED = new Set([...CORE, ...VERSIONED]);
const fail = (message) => { process.stderr.write(`smoke: ${message}\n`); process.exit(1); };
let settings;
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
catch (err) { fail(`settings.json unreadable: ${err.message}`); }
const hooks = settings.hooks || {};
const commands = [];
for (const [event, entries] of Object.entries(hooks)) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : [entry]) {
      if (hook && hook.type === "command" && typeof hook.command === "string" && hook.command.includes("clawd-hook.js")) {
        commands.push({ event, command: hook.command });
      }
    }
  }
}
const events = [...new Set(commands.map((c) => c.event))].sort();
const expectedEvents = [...EXPECTED].sort();
if (commands.length !== 14) fail(`expected exactly 14 managed state commands, got ${commands.length}: ${events.join(", ")}`);
if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
  fail(`managed state event set drifted: ${events.join(", ")}`);
}
const generations = new Set();
for (const { event, command } of commands) {
  if (command.includes(".mount_")) fail(`${event} command still points at a FUSE mount: ${command}`);
  if (command.includes("app.asar.unpacked")) fail(`${event} command points into app.asar.unpacked: ${command}`);
  const match = command.match(/appimage-hooks[\\/]([a-f0-9]{20})[\\/]/);
  if (!match) fail(`${event} command is not in ~/.clawd/appimage-hooks/<generation>: ${command}`);
  generations.add(match[1]);
  const script = command.match(/"([^"]+clawd-hook\.js)"/);
  if (!script || !fs.existsSync(script[1])) fail(`${event} target script is missing: ${command}`);
}
if (generations.size !== 1) fail(`expected one shared generation, got ${generations.size}`);
const generation = path.join(process.env.HOME, ".clawd", "appimage-hooks", [...generations][0]);
const marker = fs.readFileSync(path.join(generation, ".clawd-appimage-path"), "utf8").trim();
// The materializer hashes and records the exact (trimmed) APPIMAGE value the
// process saw; it is not realpath-canonicalized.
if (marker !== appImageValue) fail(`marker ${marker} != APPIMAGE value ${appImageValue}`);
// auto-start and statusline are opt-in defaults: their absence must not be
// misread as a smoke gap, but whatever managed command does exist must be persistent.
if (settings.statusLine && typeof settings.statusLine.command === "string"
  && settings.statusLine.command.includes("claude-statusline.js")
  && !settings.statusLine.command.includes("appimage-hooks")) {
  fail(`statusLine is not on the persistent generation: ${settings.statusLine.command}`);
}
for (const name of ["clawd-hook.js", "auto-start.js", "claude-statusline.js"]) {
  if (!fs.existsSync(path.join(generation, name))) fail(`generation is missing ${name}`);
}
process.stdout.write(`${generation}\n`);
NODE
    then
      fail "appimage-claude-hooks: settings inspection failed"
    fi
    ok "exactly the 14 core+versioned commands share one persistent generation"

    kill_owned_processes
    poll 15 server_ports_clear || fail "Clawd state port remained occupied after teardown"
    poll 15 test ! -d "$MOUNT_DIR" || fail "this launch's FUSE mount $MOUNT_DIR survived teardown"
    ok "this launch's FUSE mount is gone"

    SETTINGS_GEN="$(node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const first=(s.hooks&&s.hooks.UserPromptSubmit||[]).flatMap((e)=>Array.isArray(e.hooks)?e.hooks:[]).find((h)=>typeof h.command==="string"&&h.command.includes("clawd-hook.js"));
const m=first&&first.command.match(/"([^"]+clawd-hook\.js)"/);
if(!m){process.exit(1)}process.stdout.write(m[1]);
' "$CLAUDE_SETTINGS")"
    [ -n "$SETTINGS_GEN" ] || fail "appimage-claude-hooks: could not locate the persistent hook script"
    OFFLINE_LOG="$ARTIFACT_DIR/offline-hook.log"
    set +e
    printf '{"session_id":"ci-smoke","hook_event_name":"UserPromptSubmit","cwd":"/tmp"}\n' |
      timeout 30 node "$SETTINGS_GEN" UserPromptSubmit >"$OFFLINE_LOG" 2>&1
    OFFLINE_RC=$?
    set -e
    [ "$OFFLINE_RC" -eq 0 ] || fail "offline state hook exited $OFFLINE_RC"
    [ ! -s "$OFFLINE_LOG" ] ||
      fail "offline state hook wrote output: $(head -c 400 "$OFFLINE_LOG")"
    ok "state hook closure loads offline with exit 0 and empty output"
    ;;
esac

kill_owned_processes
poll 15 server_ports_clear || fail "Clawd state port remained occupied after teardown"
note "ALL $PASS CHECKS PASSED"
