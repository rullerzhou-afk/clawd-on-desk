"use strict";

const crypto = require("crypto");
const { formatDetail } = require("./bubble-format");

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
const DETAIL_TEXT_MAX_BYTES = 128 * 1024;
const ELICITATION_DETAIL_CONTENT_BYTES = DETAIL_TEXT_MAX_BYTES - (8 * 1024);
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
const DETAIL_JSON_DEPTH_MAX = 8;
const DETAIL_JSON_ARRAY_MAX = 64;
const DETAIL_JSON_OBJECT_KEYS_MAX = 64;

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

function clampUtf8Text(value, maxBytes = DETAIL_TEXT_MAX_BYTES) {
  const text = typeof value === "string" ? value : String(value == null ? "" : value);
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  if (limit === 0) return { text: "", truncated: text.length > 0 };

  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (limit <= suffixBytes) return { text: "", truncated: true };

  let low = 0;
  let high = text.length;
  const contentLimit = limit - suffixBytes;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= contentLimit) low = mid;
    else high = mid - 1;
  }
  // Do not leave a dangling UTF-16 high surrogate before the ellipsis.
  if (low > 0) {
    const last = text.charCodeAt(low - 1);
    if (last >= 0xD800 && last <= 0xDBFF) low -= 1;
  }
  return { text: `${text.slice(0, low)}${suffix}`, truncated: true };
}

function serializeBoundedDetailJson(value) {
  let truncated = false;
  const seen = new WeakSet();

  function clone(current, depth) {
    if (depth > DETAIL_JSON_DEPTH_MAX) {
      truncated = true;
      return "[Depth limit]";
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        truncated = true;
        return "[Circular]";
      }
      seen.add(current);
      if (current.length > DETAIL_JSON_ARRAY_MAX) truncated = true;
      const result = current.slice(0, DETAIL_JSON_ARRAY_MAX).map((item) => clone(item, depth + 1));
      seen.delete(current);
      return result;
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) {
        truncated = true;
        return "[Circular]";
      }
      seen.add(current);
      const keys = Object.keys(current).sort();
      if (keys.length > DETAIL_JSON_OBJECT_KEYS_MAX) truncated = true;
      const result = {};
      for (const key of keys.slice(0, DETAIL_JSON_OBJECT_KEYS_MAX)) {
        result[key] = clone(current[key], depth + 1);
      }
      seen.delete(current);
      return result;
    }
    if (typeof current === "bigint") return String(current);
    if (typeof current === "undefined") return null;
    return current;
  }

  let text = "";
  try {
    text = JSON.stringify(clone(value, 0), null, 2);
  } catch {
    truncated = true;
  }
  return { text, truncated };
}

function preparePermissionDetail(toolName, rawInput, options = {}) {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? rawInput
    : {};
  const description = typeof options.description === "string" && options.description.trim()
    ? options.description.trim()
    : null;
  const detailInput = description ? { ...input, description } : input;
  let structuralTruncated = false;
  const rawText = formatDetail(toolName, detailInput, {
    mode: "detail",
    isAntigravity: options.isAntigravity === true,
    formatUnknownDetail(value) {
      const serialized = serializeBoundedDetailJson(value);
      structuralTruncated = serialized.truncated;
      return serialized.text;
    },
  });
  const maxBytes = options.maxBytes === undefined ? DETAIL_TEXT_MAX_BYTES : options.maxBytes;
  const bounded = clampUtf8Text(rawText, maxBytes);
  return {
    detailText: bounded.text,
    detailTruncated: structuralTruncated || bounded.truncated,
  };
}

function createUtf8Budget(maxBytes) {
  let remaining = Math.max(0, Math.floor(Number(maxBytes) || 0));
  return {
    take(value) {
      const bounded = clampUtf8Text(value, remaining);
      remaining = Math.max(0, remaining - Buffer.byteLength(bounded.text, "utf8"));
      return bounded;
    },
  };
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
  return prepareElicitationToolInput(toolInput).displayInput;
}

// Keep the renderer's bounded display text separate from the protocol payload
// used to build updatedInput. The wire answer key is the exact upstream
// question string; putting that string through preview clamping before reply
// silently changes the key and makes Claude/Hermes discard the answer.
//
// Unsupported/ambiguous shapes are not partially rendered. The route hands
// those requests back to the agent's native UI, because truncating questions
// or options would let the user approve a different choice set than the agent
// actually sent.
function prepareElicitationToolInput(toolInput) {
  const wireInput = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput
    : {};
  const rawQuestions = Array.isArray(wireInput.questions) ? wireInput.questions : [];
  if (!rawQuestions.length) {
    return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "no-questions" };
  }
  if (rawQuestions.length > MAX_ELICITATION_QUESTIONS) {
    return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "too-many-questions" };
  }

  const answerKeys = new Set();
  const displayQuestions = new Set();
  const questions = [];
  const detailQuestions = [];
  for (let index = 0; index < rawQuestions.length; index++) {
    const question = rawQuestions[index];
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "invalid-question" };
    }
    const answerKey = typeof question.question === "string" ? question.question : "";
    if (!answerKey.trim()) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "missing-answer-key" };
    }
    if (answerKeys.has(answerKey)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-answer-key" };
    }
    answerKeys.add(answerKey);
    const detailBudget = createUtf8Budget(
      Math.floor(ELICITATION_DETAIL_CONTENT_BYTES / rawQuestions.length)
    );

    // The question itself is the context the user must understand before any
    // option description, so it gets first claim on the shared detail budget.
    const detailHeader = detailBudget.take(
      typeof question.header === "string" ? question.header.trim() : ""
    );
    const detailQuestion = detailBudget.take(answerKey.trim());

    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (rawOptions.length > MAX_ELICITATION_OPTIONS) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "too-many-options" };
    }
    const options = [];
    const detailOptions = [];
    const optionAnswerKeys = new Set();
    for (const option of rawOptions) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "invalid-option" };
      }
      const rawLabel = typeof option.label === "string" ? option.label : "";
      const displayLabel = clampPreviewText(rawLabel, MAX_ELICITATION_OPTION_LABEL);
      // The renderer returns the displayed label as the answer value. Until
      // the wire contract carries stable option ids too, never render a label
      // whose preview normalization would change the upstream answer.
      if (!displayLabel) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "missing-option-label" };
      }
      if (displayLabel !== rawLabel) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "unsafe-option-label-preview" };
      }
      if (optionAnswerKeys.has(rawLabel)) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-option-label" };
      }
      optionAnswerKeys.add(rawLabel);
      options.push({
        label: displayLabel,
        description: clampPreviewText(option.description, MAX_ELICITATION_OPTION_DESCRIPTION),
      });
      const detailDescription = detailBudget.take(
        typeof option.description === "string" ? option.description.trim() : ""
      );
      detailOptions.push({
        label: rawLabel,
        description: detailDescription.text,
        detailTruncated: detailDescription.truncated,
      });
    }
    const displayQuestion = clampPreviewText(answerKey, MAX_ELICITATION_PROMPT);
    if (displayQuestions.has(displayQuestion)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-display-question" };
    }
    displayQuestions.add(displayQuestion);
    questions.push({
      id: String(index),
      header: clampPreviewText(question.header, MAX_ELICITATION_HEADER),
      question: displayQuestion,
      displayQuestion,
      multiSelect: question.multiSelect === true,
      options,
    });
    detailQuestions.push({
      id: String(index),
      header: detailHeader.text,
      question: detailQuestion.text,
      displayQuestion: detailQuestion.text,
      multiSelect: question.multiSelect === true,
      options: detailOptions,
      detailTruncated: detailHeader.truncated || detailQuestion.truncated,
    });
  }

  return {
    displayInput: { questions },
    detailDisplayInput: { questions: detailQuestions },
    detailTruncated: detailQuestions.some((question) => (
      question.detailTruncated === true
      || question.options.some((option) => option.detailTruncated === true)
    )),
    wireInput,
    canAnswer: true,
    reason: null,
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
  const sourceAgentId = typeof options.agentId === "string" && options.agentId
    ? options.agentId
    : null;
  const hasSubagentScope = Object.prototype.hasOwnProperty.call(options, "subagentId");
  const sourceSubagentId = typeof options.subagentId === "string" && options.subagentId
    ? options.subagentId
    : null;
  const sessionPending = pendingPermissions.filter((perm) => (
    perm && perm.res && perm.sessionId === sessionId
      && (!sourceAgentId || perm.agentId === sourceAgentId)
      && (!hasSubagentScope || (perm.subagentId || null) === sourceSubagentId)
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
  DETAIL_TEXT_MAX_BYTES,
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
  clampUtf8Text,
  serializeBoundedDetailJson,
  preparePermissionDetail,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  prepareElicitationToolInput,
  normalizeHookToolUseId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  normalizeCodexPermissionToolInput,
  findPendingPermissionForStateEvent,
};
