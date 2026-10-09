"use strict";

const resolveSessionId = require("./kirocrew-hook-session");

const HOOK_MAP = Object.freeze({
  AgentSpawn: Object.freeze({ state: "idle", event: "AgentSpawn" }),
  UserPromptSubmit: Object.freeze({ state: "thinking", event: "UserPromptSubmit" }),
  PostToolUse: Object.freeze({ state: "working", event: "PostToolUse" }),
  Stop: Object.freeze({ state: "attention", event: "Stop" }),
});

function resolveEventName(payload, fallbackEvent = "") {
  const fromStdin = payload && (payload.hook_event_name || payload.event || payload.Event);
  return typeof fromStdin === "string" && fromStdin ? fromStdin : fallbackEvent;
}

function buildKiroCrewHookPayload(payload, options = {}) {
  const eventName = resolveEventName(payload, options.eventName || "");
  const mapped = Object.prototype.hasOwnProperty.call(HOOK_MAP, eventName)
    ? HOOK_MAP[eventName]
    : null;
  if (!mapped) return null;
  const body = {
    state: mapped.state,
    session_id: resolveSessionId(payload),
    event: mapped.event,
    agent_id: "kirocrew",
  };
  if (typeof options.remoteHostPrefix === "string" && options.remoteHostPrefix) {
    body.host = options.remoteHostPrefix;
  }
  return body;
}

module.exports = { HOOK_MAP, buildKiroCrewHookPayload, resolveEventName };
