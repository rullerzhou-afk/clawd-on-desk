#!/usr/bin/env node
/**
 * Clawd Desktop Pet — OpenCode/Crush Plugin
 *
 * This plugin sends state updates to Clawd when OpenCode/Crush events occur.
 */

import { walkProcessTree } from "../../lib/process-tree.mjs";

const CLAWD_HOST = process.env.CLAWD_HOST || "127.0.0.1";
const CLAWD_PORT = parseInt(process.env.CLAWD_PORT || "23333", 10);
const CLAWD_TIMEOUT = parseInt(process.env.CLAWD_TIMEOUT || "500", 10);
const CLAWD_DEBUG = process.env.CLAWD_DEBUG === "1";

// Map OpenCode events to Clawd states
const EVENT_TO_STATE = {
  "session.created": "idle",
  "session.deleted": "sleeping",
  "session.error": "error",
  "chat.message": "thinking",
  "tool.execute.before": null,
  "tool.execute.after": null,
  "command.execute.before": "working",
  "experimental.session.compacting": "sweeping",
  "permission.ask": "attention",
};

// Cached process info
let _result = null;

function debug(...args) {
  if (CLAWD_DEBUG) console.log("[Clawd]", ...args);
}

function getProcessInfo() {
  if (!_result) {
    _result = walkProcessTree();
  }
  return _result;
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
  // Use sessionID from event - OpenCode sessionID is already unique
  // Don't combine with directory as ctx.directory may not be available on session.created
  let sessionId = extra.sessionID || extra.session_id || extra.info?.id || ctx.directory || "default";

  const procInfo = getProcessInfo();

  const payload = {
    state,
    event,
    agent_id: "opencode",
    cwd: ctx.directory,
    source_pid: procInfo.stablePid,
    session_id: sessionId,
  };

  // Remove sessionID/session_id/info from extra to avoid duplication
  const { sessionID, session_id, info, ...restExtra } = extra;
  Object.assign(payload, restExtra);

  if (procInfo.detectedEditor) payload.editor = procInfo.detectedEditor;
  if (procInfo.agentPid) payload.agent_pid = procInfo.agentPid;
  if (procInfo.pidChain.length) payload.pid_chain = procInfo.pidChain;

  return payload;
}

// Plugin export
const ClawdPlugin = async (ctx) => {
  getProcessInfo(); // Pre-resolve
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
      _result = null; // Reset cache
      getProcessInfo();
    },
  };
};

export default ClawdPlugin;
export { ClawdPlugin };
