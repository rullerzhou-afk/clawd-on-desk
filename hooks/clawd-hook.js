#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const { postStateToRunningServer } = require("./server-config");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

// Walk the process tree to find the terminal app PID.
// Claude Code spawns hooks through multiple transient layers (workers, shells).
// We walk up until we find a known terminal app, then let focusTerminalWindow
// walk the remaining hops (it has its own parent walk with MainWindowHandle check).
// Runs synchronously during stdin buffering (~100ms per level × 5-6 levels).
// Known terminal/launcher apps — outermost match becomes the focus target.
// focusTerminalWindow() walks further up via MainWindowHandle if needed,
// so including launchers (e.g. antigravity) that host terminals is correct.
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
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

// Editor detection — process name → URI scheme name (for VS Code/Cursor tab focus)
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

// Claude Code process detection — for liveness check in main.js
const CLAUDE_NAMES_WIN = new Set(["claude.exe"]);
const CLAUDE_NAMES_MAC = new Set(["claude"]);

let _stablePid = null;
let _detectedEditor = null; // "code" or "cursor" — for URI scheme terminal tab focus
let _claudePid = null;       // Claude Code process PID — for crash/orphan detection
let _pidChain = [];          // all PIDs visited during tree walk

function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _claudePid = null;
  const claudeNames = isWin ? CLAUDE_NAMES_WIN : CLAUDE_NAMES_MAC;
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
        // macOS: VS Code binary is "Electron" — check full comm path for editor detection
        if (!_detectedEditor) {
          const fullLower = commOut.toLowerCase();
          if (fullLower.includes("visual studio code")) _detectedEditor = "code";
          else if (fullLower.includes("cursor.app")) _detectedEditor = "cursor";
        }
        parentPid = parseInt(ppidOut, 10);
      }
    } catch { break; }
    _pidChain.push(pid);
    if (!_detectedEditor && editorMap[name]) _detectedEditor = editorMap[name];
    // Claude Code detection: direct binary match, or node.exe running claude-code
    if (!_claudePid) {
      if (claudeNames.has(name)) {
        _claudePid = pid;
      } else if (name === "node.exe" || name === "node") {
        try {
          const cmdOut = isWin
            ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                { encoding: "utf8", timeout: 500, windowsHide: true })
            : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
          if (cmdOut.includes("claude-code") || cmdOut.includes("@anthropic-ai")) _claudePid = pid;
        } catch {}
      }
    }
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  // Prefer outermost known terminal; fall back to highest non-system PID
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

// Pre-resolve on SessionStart (runs during stdin buffering, not after)
// Remote mode: skip PID collection — remote PIDs are meaningless on the local machine
// and could collide with local PIDs, confusing the process-alive checks in state.js.
if (event === "SessionStart" && !process.env.CLAWD_REMOTE) getStablePid();

// Read stdin for session_id (Claude Code pipes JSON with session metadata)
const chunks = [];
let sent = false;

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let sessionId = "default";
  let cwd = "";
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || "default";
    cwd = payload.cwd || "";
  } catch {}
  send(sessionId, cwd);
});

// Safety: if stdin doesn't end in 400ms, send with default session
// (200ms was too aggressive on slow machines / AV scanning)
setTimeout(() => send("default", ""), 400);

function send(sessionId, cwd) {
  if (sent) return;
  sent = true;

  const body = { state, session_id: sessionId, event };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  if (!process.env.CLAWD_REMOTE) {
    // Walk to stable terminal PID — process.ppid is an ephemeral shell
    // that dies when the hook exits, so it's useless for later focus calls
    body.source_pid = getStablePid();
    if (_detectedEditor) body.editor = _detectedEditor;
    if (_claudePid) {
      body.agent_pid = _claudePid;
      body.claude_pid = _claudePid; // backward compat with older Clawd versions
    }
    if (_pidChain.length) body.pid_chain = _pidChain;
  }

  const data = JSON.stringify(body);
  postStateToRunningServer(
    data,
    { timeoutMs: 100 }, // runtime port first, then a small local fallback range
    () => process.exit(0)
  );
}
