#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

// ── Usage extraction mode (spawned asynchronously) ──
if (process.argv[2] === "--usage") {
  const transcriptPath = process.argv[3];
  if (!transcriptPath) process.exit(0);

  const fs = require("fs");
  const readline = require("readline");

  // Read last ~50 lines to find the most recent assistant message with usage
  async function extractUsage() {
    try {
      const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      let lastUsage = null;
      let lastSessionId = null;

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId) lastSessionId = entry.sessionId;
          // Look for assistant messages with usage info
          if (entry.type === "assistant" && entry.message?.usage) {
            lastUsage = entry.message.usage;
          }
        } catch {}
      }

      if (lastUsage && lastSessionId) {
        const body = JSON.stringify({
          session_id: lastSessionId,
          usage: {
            input_tokens: lastUsage.input_tokens || 0,
            output_tokens: lastUsage.output_tokens || 0,
            cache_read_input_tokens: lastUsage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: lastUsage.cache_creation_input_tokens || 0,
          }
        });

        const req = require("http").request({
          hostname: "127.0.0.1",
          port: 23333,
          path: "/usage",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 2000,
        }, () => process.exit(0));
        req.on("error", () => process.exit(0));
        req.on("timeout", () => { req.destroy(); process.exit(0); });
        req.end(body);
      } else {
        process.exit(0);
      }
    } catch {
      process.exit(0);
    }
  }

  extractUsage();
  return; // Don't fall through to normal hook logic
}

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
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

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);

// Editor detection — process name → URI scheme name (for VS Code/Cursor tab focus)
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };

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
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : TERMINAL_NAMES_MAC;
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : SYSTEM_BOUNDARY_MAC;
  const editorMap = isWin ? EDITOR_MAP_WIN : EDITOR_MAP_MAC;
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
if (event === "SessionStart") getStablePid();

// Read stdin for session_id (Claude Code pipes JSON with session metadata)
const chunks = [];
let sent = false;

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let sessionId = "default";
  let cwd = "";
  let transcriptPath = null;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || "default";
    cwd = payload.cwd || "";
    transcriptPath = payload.transcript_path || null;
  } catch {}
  send(sessionId, cwd, transcriptPath);
});

// Safety: if stdin doesn't end in 400ms, send with default session
// (200ms was too aggressive on slow machines / AV scanning)
setTimeout(() => send("default", ""), 400);

function send(sessionId, cwd, transcriptPath) {
  if (sent) return;
  sent = true;

  const body = { state, session_id: sessionId, event };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  // Always walk to stable terminal PID — process.ppid is an ephemeral shell
  // that dies when the hook exits, so it's useless for later focus calls
  body.source_pid = getStablePid();
  if (_detectedEditor) body.editor = _detectedEditor;
  if (_claudePid) {
    body.agent_pid = _claudePid;
    body.claude_pid = _claudePid; // backward compat with older Clawd versions
  }
  if (_pidChain.length) body.pid_chain = _pidChain;

  const data = JSON.stringify(body);

  const req = require("http").request(
    {
      hostname: "127.0.0.1",
      port: 23333,
      path: "/state",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 500,  // 400ms stdin + 500ms HTTP = 900ms < 1000ms Claude Code budget
    },
    (res) => {
      // Spawn async process to extract usage from transcript
      if (transcriptPath) {
        const { spawn } = require("child_process");
        spawn(process.execPath, [__filename, "--usage", transcriptPath], {
          detached: true,
          stdio: "ignore"
        }).unref();
      }
      process.exit(0);
    }
  );
  req.on("error", (e) => {
    process.exit(0);
  });
  req.on("timeout", () => {
    req.destroy();
    process.exit(0);
  });
  req.end(data);
}
