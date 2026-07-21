"use strict";

const crypto = require("crypto");

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
const MAX_PERMISSION_SUGGESTIONS = 20;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_ELICITATION_HEADER = 48;
const MAX_ELICITATION_PROMPT = 240;
const MAX_ELICITATION_OPTION_LABEL = 80;
const MAX_ELICITATION_OPTION_DESCRIPTION = 160;
const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

function truncateDeep(obj, depth) {
  if ((depth || 0) > 10) return obj;
  if (Array.isArray(obj)) return obj.map(v => truncateDeep(v, (depth || 0) + 1));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = truncateDeep(v, (depth || 0) + 1);
    return out;
  }
  return typeof obj === "string" && obj.length > PREVIEW_MAX
    ? obj.slice(0, PREVIEW_MAX) + "\u2026" : obj;
}

function clampPreviewText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}\u2026` : trimmed;
}

function normalizePermissionSuggestions(rawSuggestions) {
  const suggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter((entry) => entry && typeof entry === "object")
    : [];
  const addRulesItems = suggestions.filter((entry) => entry.type === "addRules");
  const nonAddRules = suggestions.filter((entry) => entry.type !== "addRules");
  const mergedAddRules = addRulesItems.length > 1
    ? {
        type: "addRules",
        destination: addRulesItems[0].destination || "localSettings",
        behavior: addRulesItems[0].behavior || "allow",
        rules: addRulesItems.flatMap((entry) => (
          Array.isArray(entry.rules) ? entry.rules : [{ toolName: entry.toolName, ruleContent: entry.ruleContent }]
        )),
      }
    : addRulesItems[0] || null;

  if (!mergedAddRules) return nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS);
  if (nonAddRules.length + 1 <= MAX_PERMISSION_SUGGESTIONS) return [...nonAddRules, mergedAddRules];
  return [
    ...nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS - 1),
    mergedAddRules,
  ];
}

function normalizeElicitationToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return toolInput;
  if (!Array.isArray(toolInput.questions)) return toolInput;

  const questions = toolInput.questions
    .slice(0, MAX_ELICITATION_QUESTIONS)
    .map((question) => {
      if (!question || typeof question !== "object") return null;
      const options = Array.isArray(question.options)
        ? question.options
          .slice(0, MAX_ELICITATION_OPTIONS)
          .map((option) => {
            if (!option || typeof option !== "object") return null;
            return {
              ...option,
              label: clampPreviewText(option.label, MAX_ELICITATION_OPTION_LABEL),
              description: clampPreviewText(option.description, MAX_ELICITATION_OPTION_DESCRIPTION),
            };
          })
          .filter(Boolean)
        : [];

      const normalized = {
        ...question,
        header: clampPreviewText(question.header, MAX_ELICITATION_HEADER),
        question: clampPreviewText(question.question, MAX_ELICITATION_PROMPT),
        options,
      };
      if (!normalized.question) return null;
      return normalized;
    })
    .filter(Boolean);

  return {
    ...toolInput,
    questions,
  };
}

function normalizeHookToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function normalizeCodexPermissionToolInput(rawInput, description) {
  const base = rawInput && typeof rawInput === "object" ? truncateDeep(rawInput) : {};
  const trimmedDescription = typeof description === "string" && description.trim()
    ? description.trim()
    : null;
  if (!trimmedDescription) return base;
  return {
    ...base,
    description: trimmedDescription,
  };
}

function findPendingPermissionForStateEvent(pendingPermissions, options) {
  const sessionId = typeof options.sessionId === "string" && options.sessionId
    ? options.sessionId
    : "default";
  const sessionPending = pendingPermissions.filter((perm) => (
    perm
      && perm.res
      && perm.sessionId === sessionId
      && (options.requireAgentOwnership === true
        ? perm.agentId === options.agentId
        : (!options.agentId || !perm.agentId || perm.agentId === options.agentId))
  ));
  if (!sessionPending.length) return null;

  const toolUseId = normalizeHookToolUseId(options.toolUseId);
  if (toolUseId) {
    const matchByToolUseId = sessionPending.find((perm) => perm.toolUseId === toolUseId);
    if (matchByToolUseId) return matchByToolUseId;
  }

  const toolName = typeof options.toolName === "string" && options.toolName
    ? options.toolName
    : null;
  const toolInputFingerprint = typeof options.toolInputFingerprint === "string" && options.toolInputFingerprint
    ? options.toolInputFingerprint
    : null;
  if (toolName && toolInputFingerprint) {
    const matchesByFingerprint = sessionPending.filter((perm) => (
      perm.toolName === toolName
        && perm.toolInputFingerprint === toolInputFingerprint
        && (!toolUseId || !perm.toolUseId)
    ));
    if (matchesByFingerprint.length === 1) return matchesByFingerprint[0];
  }

  const allowSingletonFallback = options.allowSingletonFallback === true;
  return allowSingletonFallback && sessionPending.length === 1 ? sessionPending[0] : null;
}

module.exports = {
  PREVIEW_MAX,
  MAX_PERMISSION_SUGGESTIONS,
  MAX_ELICITATION_QUESTIONS,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_HEADER,
  MAX_ELICITATION_PROMPT,
  MAX_ELICITATION_OPTION_LABEL,
  MAX_ELICITATION_OPTION_DESCRIPTION,
  TOOL_MATCH_STRING_MAX,
  TOOL_MATCH_ARRAY_MAX,
  TOOL_MATCH_OBJECT_KEYS_MAX,
  TOOL_MATCH_DEPTH_MAX,
  truncateDeep,
  clampPreviewText,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeHookToolUseId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  normalizeCodexPermissionToolInput,
  findPendingPermissionForStateEvent,
};
