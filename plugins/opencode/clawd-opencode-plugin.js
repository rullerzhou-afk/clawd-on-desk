#!/usr/bin/env node
/**
 * Clawd Desktop Pet — OpenCode/Crush Plugin
 *
 * This plugin sends state updates to Clawd when OpenCode/Crush events occur.
 * Reuses logic from hooks/clawd-hook.js for process tree walking and terminal detection.
 */

import { execSync } from "child_process";
import { basename } from "path";

const CLAWD_HOST = process.env.CLAWD_HOST || "127.0.0.1";
const CLAWD_PORT = parseInt(process.env.CLAWD_PORT || "23333", 10);
const CLAWD_TIMEOUT = parseInt(process.env.CLAWD_TIMEOUT || "500", 10);
const CLAWD_DEBUG = process.env.CLAWD_DEBUG === "1";

// Map OpenCode events to Clawd states
const EVENT_TO_STATE = {
  // Session events
  "session.created": "idle",
  "session.deleted": "sleeping",
  "session.error": "error",

  // Chat events
  "chat.message": "thinking",

  // Tool events (state determined by tool name)
  "tool.execute.before": null,
  "tool.execute.after": null,

  // Command events
  "command.execute.before": "working",

  // Experimental
  "experimental.session.compacting": "sweeping",

  // Permission
  "permission.ask": "attention",
};

// Terminal app detection
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

const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };

const OPENCODE_NAMES_WIN = new Set(["opencode.exe", "crush.exe"]);
const OPENCODE_NAMES_MAC = new Set(["opencode", "crush"]);

// Cached process info
let _stablePid = null;
let _detectedEditor = null;
let _opencodePid = null;
let _pidChain = [];

function debug(...args) {
  if (CLAWD_DEBUG) console.log("[Clawd]", ...args);
}

function getStablePid() {
  if (_stablePid) return _stablePid;

  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : TERMINAL_NAMES_MAC;
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : SYSTEM_BOUNDARY_MAC;
  const editorMap = isWin ? EDITOR_MAP_WIN : EDITOR_MAP_MAC;
  const opencodeNames = isWin ? OPENCODE_NAMES_WIN : OPENCODE_NAMES_MAC;

  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;
  _opencodePid = null;

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
        const ppidOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = basename(commOut).toLowerCase();
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

    if (!_opencodePid) {
      if (opencodeNames.has(name)) {
        _opencodePid = pid;
      } else if (name === "node.exe" || name === "node" || name === "bun") {
        try {
          const cmdOut = isWin
            ? execSync(`wmic process where "ProcessId=${pid}" get CommandLine /format:csv`,
                { encoding: "utf8", timeout: 500, windowsHide: true })
            : execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", timeout: 500 });
          if (cmdOut.includes("opencode") || cmdOut.includes("crush")) _opencodePid = pid;
        } catch {}
      }
    }

    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }

  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

function getToolState(tool) {
  const thinkingTools = ["read", "glob", "grep", "lsp", "webfetch", "websearch"];
  const toolLower = (tool || "").toLowerCase();
  if (thinkingTools.some(t => toolLower.includes(t))) return "thinking";
  return "working";
}

function getCommandState(command) {
  const thinkingCommands = ["help", "clear", "config", "doctor", "init"];
  const cmdLower = (command || "").toLowerCase();
  if (thinkingCommands.some(c => cmdLower.includes(c))) return "thinking";
  return "working";
}

async function sendToClawd(payload) {
  const data = JSON.stringify(payload);
  const url = `http://${CLAWD_HOST}:${CLAWD_PORT}/state`;

  debug("Sending:", payload);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLAWD_TIMEOUT);

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      body: data,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch {
    // Silently ignore (Clawd may not be running)
  }
}

function buildPayload(ctx, event, state, extra = {}) {
  // Build a unique session_id that includes the directory
  // OpenCode can run multiple sessions in different directories
  // We need to distinguish them by combining sessionID with directory

  // Try multiple sources for sessionID:
  // 1. extra.sessionID (direct from hook input)
  // 2. extra.session_id (alternative naming)
  // 3. extra.info?.id (from session.created event: { sessionID, info })
  let sessionId = extra.sessionID || extra.session_id || extra.info?.id;

  // Combine sessionID with directory for uniqueness across directories
  if (sessionId && ctx.directory) {
    sessionId = `${sessionId}:${ctx.directory}`;
  } else if (!sessionId) {
    sessionId = ctx.directory || "default";
  }

  const payload = {
    state,
    event,
    agent_id: "opencode",
    cwd: ctx.directory,
    source_pid: getStablePid(),
    session_id: sessionId,
  };

  // Remove sessionID/session_id/info from extra to avoid duplication
  const { sessionID, session_id, info, ...restExtra } = extra;
  Object.assign(payload, restExtra);

  if (_detectedEditor) payload.editor = _detectedEditor;
  if (_opencodePid) payload.agent_pid = _opencodePid;
  if (_pidChain.length) payload.pid_chain = _pidChain;

  return payload;
}

// Plugin export
const ClawdPlugin = async (ctx) => {
  getStablePid();
  debug("Plugin loaded, ctx.directory:", ctx.directory);

  return {
    // Handle all bus events
    async event({ event }) {
      const state = EVENT_TO_STATE[event.type];
      if (!state) return;

      debug("Event:", event.type, "full event:", JSON.stringify(event));
      const payload = buildPayload(ctx, event.type, state, event.properties || event);
      await sendToClawd(payload);
    },

    // Handle new chat messages
    async "chat.message"(input, output) {
      debug("chat.message:", input.sessionID);
      const payload = buildPayload(ctx, "chat.message", "thinking", {
        sessionID: input.sessionID,
        messageID: input.messageID,
      });
      await sendToClawd(payload);
    },

    // Handle tool execution before
    async "tool.execute.before"(input, output) {
      const state = getToolState(input.tool);
      debug("tool.execute.before:", input.tool, "->", state);
      const payload = buildPayload(ctx, "tool.execute.before", state, {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
      });
      await sendToClawd(payload);
    },

    // Handle tool execution after
    async "tool.execute.after"(input, output) {
      const hasError = output.metadata?.error || output.output?.includes("error");
      const state = hasError ? "error" : "working";
      debug("tool.execute.after:", input.tool, "->", state);
      const payload = buildPayload(ctx, "tool.execute.after", state, {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        title: output.title,
      });
      await sendToClawd(payload);
    },

    // Handle command execution
    async "command.execute.before"(input, output) {
      const state = getCommandState(input.command);
      debug("command.execute.before:", input.command, "->", state);
      const payload = buildPayload(ctx, "command.execute.before", state, {
        sessionID: input.sessionID,
        command: input.command,
      });
      await sendToClawd(payload);
    },

    // Handle session compaction
    async "experimental.session.compacting"(input, output) {
      debug("session.compacting:", input.sessionID);
      const payload = buildPayload(ctx, "experimental.session.compacting", "sweeping", {
        sessionID: input.sessionID,
      });
      await sendToClawd(payload);
    },

    // Handle permission requests
    async "permission.ask"(input, output) {
      debug("permission.ask");
      const payload = buildPayload(ctx, "permission.ask", "attention", {
        permission: input,
      });
      await sendToClawd(payload);
    },

    // Handle config changes
    async config(input) {
      debug("config hook called");
      _stablePid = null;
      getStablePid();
    },
  };
};

export default ClawdPlugin;
export { ClawdPlugin };
