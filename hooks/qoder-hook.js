#!/usr/bin/env node
// Clawd — Qoder IDE hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.qoder/settings.json by hooks/qoder-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");

// Qoder hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  UserPromptSubmit: { state: "thinking", event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",  event: "PreToolUse" },
  PostToolUse:      { state: "working",  event: "PostToolUse" },
  PostToolUseFailure: { state: "error",  event: "PostToolUseFailure" },
  Stop:             { state: "attention", event: "Stop" },
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

const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor", "qoder.exe": "qoder" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor", "qoder": "qoder" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code", "qoder": "qoder" };

const QODER_NAMES_WIN = new Set(["qoder.exe"]);
const QODER_NAMES_MAC = new Set(["qoder"]);
const QODER_NAMES_LINUX = new Set(["qoder"]);

let _stablePid = null;
let _detectedEditor = null;
let _qoderPid = null;
let _pidChain = [];

function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  const qoderNames = isWin ? QODER_NAMES_WIN : (process.platform === "linux" ? QODER_NAMES_LINUX : QODER_NAMES_MAC);
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _qoderPid = null;
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
    if (!_qoderPid && qoderNames.has(name)) _qoderPid = pid;
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

// Qoder gating hooks need stdout JSON response
// exit 0 with empty JSON = allow, exit 2 = block
function stdoutForEvent(hookName) {
  // For PreToolUse, return empty JSON to allow execution
  // The hook script exits 0 to indicate success/allow
  return "{}";
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
  const mapped = HOOK_MAP[hookName];

  if (!mapped) {
    process.stdout.write(stdoutForEvent(hookName) + "\n");
    process.exit(0);
    return;
  }

  const { state, event } = mapped;

  // Pre-resolve PID on first event if not remote
  if (!process.env.CLAWD_REMOTE) getStablePid();

  const sessionId = (payload && payload.session_id) || "default";
  const cwd = (payload && payload.cwd) || "";

  const body = { state, session_id: sessionId, event };
  body.agent_id = "qoder";
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = getStablePid();
    if (_detectedEditor) body.editor = _detectedEditor;
    if (_qoderPid) {
      body.agent_pid = _qoderPid;
      body.qoder_pid = _qoderPid;
    }
    if (_pidChain.length) body.pid_chain = _pidChain;
  }

  const outLine = stdoutForEvent(hookName);
  const data = JSON.stringify(body);
  postStateToRunningServer(data, { timeoutMs: 100 }, () => {
    process.stdout.write(outLine + "\n");
    process.exit(0);
  });
}

// Fallback: if stdin doesn't arrive in 400ms, send minimal response
_stdinTimer = setTimeout(() => finishOnce(null), 400);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let payload = null;
  try {
    payload = JSON.parse(chunks.join(""));
  } catch {}
  finishOnce(payload);
});
