"use strict";

const STATE_NOTIFY_TOOL_NAME = "ClawdStateNotify";
const SUPPORTED_AGENTS = new Set(["hermes", "codex"]);
const NOTIFY_STATES = new Set(["thinking", "working", "attention", "error"]);
const CLEAR_STATES = new Set(["idle", "sleeping"]);

function normalizeAgentId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeState(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEvent(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactMetadataValue(value, maxLen = 48) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  if (!text) return "";
  const redacted = text
    .replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, "<redacted>")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
  return redacted.length > maxLen ? `${redacted.slice(0, Math.max(0, maxLen - 1))}…` : redacted;
}

function shouldShowStateNotify(input = {}) {
  const agentId = normalizeAgentId(input.agentId);
  const state = normalizeState(input.state);
  const event = normalizeEvent(input.event);

  if (input.headless === true) return false;
  if (!SUPPORTED_AGENTS.has(agentId)) return false;
  if (!NOTIFY_STATES.has(state)) return false;
  if (event === "PermissionRequest" || event === "Elicitation") return false;
  if (event === "SessionEnd") return false;

  return true;
}

function shouldClearStateNotify(input = {}) {
  const state = normalizeState(input.state);
  const event = normalizeEvent(input.event);
  return event === "SessionEnd" || CLEAR_STATES.has(state);
}

function buildStateNotifyCopy(input = {}) {
  const lang = input.lang === "zh-TW" ? "zh-TW" : (input.lang === "zh" ? "zh" : "en");
  const agentId = normalizeAgentId(input.agentId);
  const state = normalizeState(input.state);
  const agentLabel = agentId === "codex" ? "Codex" : "Phoebe";

  const dictionary = {
    en: {
      thinking: "Thinking",
      working: "Working",
      attention: "Done",
      error: "Stuck",
    },
    zh: {
      thinking: "思考中",
      working: "處理中",
      attention: "完成",
      error: "卡住了",
    },
    "zh-TW": {
      thinking: "思考中",
      working: "處理中",
      attention: "完成",
      error: "卡住了",
    },
  };
  const locale = dictionary[lang] || dictionary.en;
  const statusLabel = locale[state] || dictionary.en[state] || dictionary.en.thinking;

  return {
    badgeLabel: `${agentLabel.toUpperCase()} · ${statusLabel}`,
    agentLabel,
    statusLabel,
    state,
  };
}

module.exports = {
  STATE_NOTIFY_TOOL_NAME,
  SUPPORTED_AGENTS,
  NOTIFY_STATES,
  shouldShowStateNotify,
  shouldClearStateNotify,
  buildStateNotifyCopy,
  compactMetadataValue,
};
