#!/usr/bin/env node
// Clawd — Cursor Agent hook (stdin JSON, hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.cursor/hooks.json by hooks/cursor-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");

const HOOK_TO_STATE = {
  sessionStart: { state: "idle", event: "SessionStart" },
  sessionEnd: { state: "sleeping", event: "SessionEnd" },
  beforeSubmitPrompt: { state: "thinking", event: "UserPromptSubmit" },
  preToolUse: { state: "working", event: "PreToolUse" },
  postToolUse: { state: "working", event: "PostToolUse" },
  postToolUseFailure: { state: "error", event: "PostToolUseFailure" },
  subagentStart: { state: "juggling", event: "SubagentStart" },
  subagentStop: { state: "working", event: "SubagentStop" },
  preCompact: { state: "sweeping", event: "PreCompact" },
  afterAgentThought: { state: "thinking", event: "AfterAgentThought" },
};

const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "cursor.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
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

const CURSOR_NAMES_WIN = new Set(["cursor.exe"]);
const CURSOR_NAMES_MAC = new Set(["cursor"]);
const CURSOR_NAMES_LINUX = new Set(["cursor"]);

let _stablePid = null;
let _detectedEditor = null;
let _cursorPid = null;
let _pidChain = [];

function cursorNameSet() {
  const isWin = process.platform === "win32";
  if (isWin) return CURSOR_NAMES_WIN;
  return process.platform === "linux" ? CURSOR_NAMES_LINUX : CURSOR_NAMES_MAC;
}

function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (process.platform === "linux" ? TERMINAL_NAMES_LINUX : TERMINAL_NAMES_MAC);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (process.platform === "linux" ? SYSTEM_BOUNDARY_LINUX : SYSTEM_BOUNDARY_MAC);
  const editorMap = isWin ? EDITOR_MAP_WIN : (process.platform === "linux" ? EDITOR_MAP_LINUX : EDITOR_MAP_MAC);
  const cursorNames = cursorNameSet();
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _cursorPid = null;
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
    if (!_cursorPid && cursorNames.has(name)) _cursorPid = pid;
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

function stdoutForCursorHook(hookName) {
  if (hookName === "preToolUse" || hookName === "beforeShellExecution" || hookName === "beforeMCPExecution" || hookName === "beforeReadFile") {
    return JSON.stringify({ permission: "allow" });
  }
  if (hookName === "subagentStart") return JSON.stringify({ permission: "allow" });
  if (hookName === "beforeSubmitPrompt") return JSON.stringify({ continue: true });
  return "{}";
}

/** Maps Cursor preToolUse/postToolUse tool_name to assets/svg basenames (see state.js DISPLAY_HINT_SVGS). */
function displaySvgFromToolHook(hookName, payload) {
  if (hookName !== "preToolUse" && hookName !== "postToolUse") return undefined;
  const name = payload && payload.tool_name;
  if (!name || typeof name !== "string") return undefined;
  if (name === "Shell" || name.startsWith("MCP:")) return "clawd-working-building.svg";
  if (name === "Task") return "clawd-working-juggling.svg";
  if (name === "Write" || name === "Delete") return "clawd-working-typing.svg";
  if (name === "Read" || name === "Grep") return "clawd-idle-reading.svg";
  return undefined;
}

function resolveStateAndEvent(payload, hookName) {
  if (!hookName) return null;
  if (hookName === "stop") {
    const st = payload && payload.status;
    if (st === "error") return { state: "error", event: "StopFailure" };
    return { state: "attention", event: "Stop" };
  }
  return HOOK_TO_STATE[hookName] || null;
}

function runWithPayload(payload) {
  const argvOverride = process.argv[2];
  const hookNameResolved = argvOverride || (payload && payload.hook_event_name) || "";
  const mapped = resolveStateAndEvent(payload, hookNameResolved);
  if (!mapped) {
    process.stdout.write(stdoutForCursorHook(hookNameResolved) + "\n");
    process.exit(0);
    return;
  }

  const { state, event } = mapped;
  if (hookNameResolved === "sessionStart" && !process.env.CLAWD_REMOTE) getStablePid();

  const sessionId =
    (payload && (payload.conversation_id || payload.session_id)) || "default";
  let cwd = (payload && payload.cwd) || "";
  if (!cwd && payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) {
    cwd = payload.workspace_roots[0];
  }

  const body = { state, session_id: sessionId, event };
  body.agent_id = "cursor-agent";
  const hint = displaySvgFromToolHook(hookNameResolved, payload);
  if (hint !== undefined) body.display_svg = hint;
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = getStablePid();
    body.editor = _detectedEditor || "cursor";
    if (_cursorPid) {
      body.agent_pid = _cursorPid;
      body.cursor_pid = _cursorPid;
    }
    if (_pidChain.length) body.pid_chain = _pidChain;
  }

  const outLine = stdoutForCursorHook(hookNameResolved);
  const data = JSON.stringify(body);
  postStateToRunningServer(data, { timeoutMs: 100 }, () => {
    process.stdout.write(outLine + "\n");
    process.exit(0);
  });
}

let _ran = false;
let _stdinTimer = null;
function finishOnce(payload) {
  if (_ran) return;
  _ran = true;
  if (_stdinTimer) clearTimeout(_stdinTimer);
  runWithPayload(payload || {});
}

const chunks = [];
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
