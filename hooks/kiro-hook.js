#!/usr/bin/env node
// Clawd — Kiro CLI hook (stdin JSON with hook_event_name; exit code gating)
// Registered in ~/.kiro/agents/clawd.json by hooks/kiro-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");

// Kiro CLI hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  agentSpawn:       { state: "idle",      event: "agentSpawn" },
  userPromptSubmit: { state: "thinking",  event: "userPromptSubmit" },
  preToolUse:       { state: "working",   event: "preToolUse" },
  postToolUse:      { state: "working",   event: "postToolUse" },
  stop:             { state: "attention", event: "stop" },
};

// Walk the process tree to find the terminal app PID.
// Duplicated because hook scripts must be zero-dependency.
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

const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

const KIRO_NAMES_WIN = new Set(["kiro.exe"]);
const KIRO_NAMES_MAC = new Set(["kiro"]);
const KIRO_NAMES_LINUX = new Set(["kiro"]);

let _stablePid = null;
let _detectedEditor = null;
let _kiroPid = null;
let _pidChain = [];

function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  const kiroNames = isWin ? KIRO_NAMES_WIN : (process.platform === "linux" ? KIRO_NAMES_LINUX : KIRO_NAMES_MAC);
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _kiroPid = null;
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
    if (!_kiroPid && kiroNames.has(name)) _kiroPid = pid;
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

// Read stdin JSON, extract event, post state, exit 0
const chunks = [];
let _ran = false;
let _stdinTimer = null;

function finishOnce(payload) {
  if (_ran) return;
  _ran = true;
  if (_stdinTimer) clearTimeout(_stdinTimer);

  const hookName = (payload && payload.hook_event_name) || "";
  const mapped = HOOK_MAP[hookName];

  if (!mapped) {
    process.exit(0);
    return;
  }

  const { state, event } = mapped;

  if (hookName === "agentSpawn" && !process.env.CLAWD_REMOTE) getStablePid();

  // Kiro CLI stdin has no session_id — use "default" (all sessions merged)
  const sessionId = "default";
  const cwd = (payload && payload.cwd) || "";

  const body = { state, session_id: sessionId, event };
  body.agent_id = "kiro-cli";
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = getStablePid();
    if (_detectedEditor) body.editor = _detectedEditor;
    if (_kiroPid) body.agent_pid = _kiroPid;
    if (_pidChain.length) body.pid_chain = _pidChain;
  }

  const data = JSON.stringify(body);
  postStateToRunningServer(data, { timeoutMs: 100 }, () => {
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
