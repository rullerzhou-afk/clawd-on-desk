#!/usr/bin/env node
// Clawd Desktop Pet — Cursor Hook Script
// Zero dependencies, fast cold start
// Usage: node cursor-hook.js
// Reads stdin JSON from Cursor with hook_event_name, conversation_id, etc.

const { postStateToRunningServer } = require("./server-config");

// Cursor camelCase event → { state, event (PascalCase for server compat) }
const HOOK_MAP = {
  sessionStart:        { state: "idle",         event: "SessionStart" },
  sessionEnd:          { state: "sleeping",     event: "SessionEnd" },
  beforeSubmitPrompt:  { state: "thinking",     event: "UserPromptSubmit" },
  preToolUse:          { state: "working",      event: "PreToolUse" },
  postToolUse:         { state: "working",      event: "PostToolUse" },
  postToolUseFailure:  { state: "error",        event: "PostToolUseFailure" },
  subagentStart:       { state: "juggling",     event: "SubagentStart" },
  subagentStop:        { state: "working",      event: "SubagentStop" },
  preCompact:          { state: "sweeping",     event: "PreCompact" },
  stop:                { state: "attention",    event: "Stop" },
};

// Stdout response for gating hooks — always allow, never block
function stdoutForEvent(hookName) {
  if (hookName === "preToolUse" || hookName === "subagentStart") {
    return JSON.stringify({ permission: "allow" });
  }
  if (hookName === "beforeSubmitPrompt") {
    return JSON.stringify({ continue: true });
  }
  return "{}";
}

// Walk the process tree to find the terminal/editor PID.
// Duplicated because hook scripts must be zero-dependency.
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
  "cursor.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);
const TERMINAL_NAMES_LINUX = new Set([
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
]);

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);

let _stablePid = null;
let _pidChain = [];

function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  for (let i = 0; i < 8; i++) {
    let name, parentPid;
    try {
      if (isWin) {
        const out = execSync(
          `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
          { encoding: "utf8", timeout: 1500, windowsHide: true }
        );
        const lines = out.trim().split("\n").filter(l => l.includes(","));
        if (!lines.length) break;
        const parts = lines[lines.length - 1].split(",");
        name = (parts[1] || "").trim().toLowerCase();
        parentPid = parseInt(parts[2], 10);
      } else {
        const cp = require("child_process");
        const ppidOut = cp.execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const commOut = cp.execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = require("path").basename(commOut).toLowerCase();
        parentPid = parseInt(ppidOut, 10);
      }
    } catch { break; }
    _pidChain.push(pid);
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

// Read stdin JSON, extract event, post state, write stdout
const chunks = [];
let _ran = false;
let _stdinTimer = null;

function finishOnce(payload) {
  if (_ran) return;
  _ran = true;
  if (_stdinTimer) clearTimeout(_stdinTimer);

  const hookName = (payload && payload.hook_event_name) || "";
  let mapped = HOOK_MAP[hookName];

  if (!mapped) {
    process.stdout.write(stdoutForEvent(hookName) + "\n");
    process.exit(0);
    return;
  }

  // stop with status=error → error state
  if (hookName === "stop" && payload.status === "error") {
    mapped = { state: "error", event: "StopFailure" };
  }

  const { state, event } = mapped;

  if (hookName === "sessionStart") getStablePid();

  // conversation_id is the stable session ID across turns
  const sessionId = (payload && (payload.conversation_id || payload.session_id)) || "default";
  const cwd = (payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) || "";
  const isHeadless = !!(payload && payload.is_background_agent);

  const body = { state, session_id: sessionId, event };
  body.agent_id = "cursor";
  body.editor = "cursor";
  if (cwd) body.cwd = cwd;
  if (isHeadless) body.headless = true;
  body.source_pid = getStablePid();
  if (_pidChain.length) body.pid_chain = _pidChain;

  const outLine = stdoutForEvent(hookName);
  const data = JSON.stringify(body);
  postStateToRunningServer(data, { timeoutMs: 100 }, () => {
    process.stdout.write(outLine + "\n");
    process.exit(0);
  });
}

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let payload = {};
  try {
    const raw = Buffer.concat(chunks).toString();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  finishOnce(payload);
});

_stdinTimer = setTimeout(() => finishOnce({}), 400);
