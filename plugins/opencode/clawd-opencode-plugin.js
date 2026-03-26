#!/usr/bin/env node
/**
 * Clawd Desktop Pet — OpenCode/Crush Plugin
 *
 * This plugin sends state updates to Clawd when OpenCode/Crush events occur.
 * Reuses logic from hooks/clawd-hook.js for process tree walking and terminal detection.
 *
 * Installation:
 * 1. Add to your opencode.json:
 *    {
 *      "plugin": ["file:///path/to/clawd-on-desk/plugins/opencode/clawd-opencode-plugin.js"]
 *    }
 *
 * 2. Or install as npm package (if published):
 *    {
 *      "plugin": ["@clawd/opencode-plugin"]
 *    }
 */

import { Plugin } from "@opencode-ai/plugin";
import { execSync } from "child_process";
import { basename } from "path";

const CLAWD_HOST = process.env.CLAWD_HOST || "127.0.0.1";
const CLAWD_PORT = parseInt(process.env.CLAWD_PORT || "23333", 10);
const CLAWD_TIMEOUT = parseInt(process.env.CLAWD_TIMEOUT || "500", 10);

// Map OpenCode events to Clawd states
const EVENT_TO_STATE = {
  // Session events
  "session.created": "idle",
  "session.deleted": "sleeping",
  "session.error": "error",

  // Chat events
  "chat.message": "thinking",

  // Tool events (state determined by tool name)
  "tool.execute.before": null, // dynamic
  "tool.execute.after": null,  // dynamic

  // Command events
  "command.execute.before": "working",

  // Experimental
  "experimental.session.compacting": "sweeping",

  // Permission
  "permission.ask": "attention",
};

// Terminal app detection (same as clawd-hook.js)
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

// Editor detection
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };

// OpenCode/Crush process detection
const OPENCODE_NAMES_WIN = new Set(["opencode.exe", "crush.exe"]);
const OPENCODE_NAMES_MAC = new Set(["opencode", "crush"]);

// Cached process info
let _stablePid = null;
let _detectedEditor = null;
let _opencodePid = null;
let _pidChain = [];

/**
 * Walk process tree to find stable terminal PID
 * Same logic as clawd-hook.js for terminal focus support
 */
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

    // OpenCode/Crush detection
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

/**
 * Determine tool state based on tool name
 * Reading/searching tools = thinking, modifying tools = working
 */
function getToolState(tool) {
  const thinkingTools = ["read", "glob", "grep", "lsp", "webfetch", "websearch"];
  const workingTools = ["bash", "edit", "write", "notebookedit"];

  const toolLower = (tool || "").toLowerCase();
  if (thinkingTools.some(t => toolLower.includes(t))) return "thinking";
  if (workingTools.some(t => toolLower.includes(t))) return "working";
  return "working";
}

/**
 * Determine command state based on command name
 */
function getCommandState(command) {
  const thinkingCommands = ["help", "clear", "config", "doctor", "init"];
  const workingCommands = ["commit", "pr", "review", "mcp"];

  const cmdLower = (command || "").toLowerCase();
  if (thinkingCommands.some(c => cmdLower.includes(c))) return "thinking";
  if (workingCommands.some(c => cmdLower.includes(c))) return "working";
  return "working";
}

/**
 * Send state to Clawd HTTP server
 * Uses same HTTP request pattern as clawd-hook.js
 */
async function sendToClawd(payload) {
  const data = JSON.stringify(payload);
  const url = `http://${CLAWD_HOST}:${CLAWD_PORT}/state`;

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
    // Silently ignore errors (Clawd may not be running)
  }
}

/**
 * Build Clawd payload from event context
 * Includes process tree info for terminal focus support
 */
function buildPayload(ctx, event, state, extra = {}) {
  const payload = {
    state,
    event,
    agent_id: "opencode",
    cwd: ctx.directory,
    source_pid: getStablePid(),
    ...extra,
  };

  // Add editor detection
  if (_detectedEditor) payload.editor = _detectedEditor;

  // Add OpenCode PID for liveness detection
  if (_opencodePid) {
    payload.agent_pid = _opencodePid;
  }

  // Add PID chain for debugging
  if (_pidChain.length) payload.pid_chain = _pidChain;

  return payload;
}

// Plugin export
export const ClawdPlugin = async (ctx) => {
  // Pre-resolve stable PID on plugin init
  getStablePid();

  return {
    // Handle all bus events
    async event({ event }) {
      let state = EVENT_TO_STATE[event.type];
      if (!state) return;

      const payload = buildPayload(ctx, event.type, state, event.properties);
      await sendToClawd(payload);
    },

    // Handle new chat messages
    async "chat.message"(input, output) {
      const payload = buildPayload(ctx, "chat.message", "thinking", {
        sessionID: input.sessionID,
        messageID: input.messageID,
      });
      await sendToClawd(payload);
    },

    // Handle tool execution before
    async "tool.execute.before"(input, output) {
      const state = getToolState(input.tool);
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
      const payload = buildPayload(ctx, "command.execute.before", state, {
        sessionID: input.sessionID,
        command: input.command,
      });
      await sendToClawd(payload);
    },

    // Handle session compaction
    async "experimental.session.compacting"(input, output) {
      const payload = buildPayload(ctx, "experimental.session.compacting", "sweeping", {
        sessionID: input.sessionID,
      });
      await sendToClawd(payload);
    },

    // Handle permission requests
    async "permission.ask"(input, output) {
      const payload = buildPayload(ctx, "permission.ask", "attention", {
        permission: input,
      });
      await sendToClawd(payload);
    },

    // Handle config changes
    async config(input) {
      // Refresh stable PID when config changes
      _stablePid = null;
      getStablePid();
    },
  };
};

// Default export
export default ClawdPlugin;
