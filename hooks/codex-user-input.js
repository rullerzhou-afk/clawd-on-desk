"use strict";

// Shared, zero-dependency parser for Codex request_user_input transcript
// records. This file is deployed beside both local and remote monitors, so it
// intentionally uses no dependencies outside Node built-ins / hooks/.

const LIMITS = Object.freeze({
  callId: 128,
  questionId: 64,
  header: 48,
  question: 240,
  optionLabel: 80,
  optionDescription: 160,
  questions: 3,
  options: 3,
  autoResolutionMs: 240000,
});

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
}

function normalizeCallId(value) {
  const callId = cleanText(value, LIMITS.callId);
  return callId || null;
}

function normalizeQuestion(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = cleanText(value.question, LIMITS.question);
  if (!question) return null;
  const id = cleanText(value.id, LIMITS.questionId) || `question_${index + 1}`;
  const header = cleanText(value.header, LIMITS.header);
  const options = Array.isArray(value.options)
    ? value.options.slice(0, LIMITS.options).map((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return null;
      const label = cleanText(option.label, LIMITS.optionLabel);
      if (!label) return null;
      return {
        label,
        description: cleanText(option.description, LIMITS.optionDescription),
      };
    }).filter(Boolean)
    : [];
  return {
    id,
    header,
    question,
    options,
    isOther: value.isOther === true,
    isSecret: value.isSecret === true,
  };
}

function normalizeRequestArguments(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.slice(0, LIMITS.questions).map(normalizeQuestion).filter(Boolean)
    : [];
  if (!questions.length) return null;
  const rawAutoResolutionMs = Number(parsed.autoResolutionMs ?? parsed.auto_resolution_ms);
  const autoResolutionMs = Number.isFinite(rawAutoResolutionMs) && rawAutoResolutionMs > 0
    ? Math.min(LIMITS.autoResolutionMs, Math.floor(rawAutoResolutionMs))
    : null;
  return { questions, autoResolutionMs };
}

function parseCodexUserInputRecord(record) {
  if (!record || record.type !== "response_item") return null;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const callId = normalizeCallId(payload.call_id ?? payload.callId);
  if (!callId) return null;
  if (payload.type === "function_call" && payload.name === "request_user_input") {
    const request = normalizeRequestArguments(payload.arguments);
    return request ? { phase: "request", callId, ...request } : null;
  }
  if (payload.type === "function_call_output") {
    return { phase: "resolved", callId };
  }
  return null;
}

function normalizeCodexUserInputWire(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = value.phase === "request" || value.phase === "resolved" ? value.phase : null;
  const callId = normalizeCallId(value.call_id ?? value.callId);
  if (!phase || !callId) return null;
  if (phase === "resolved") return { phase, callId };
  const request = normalizeRequestArguments(value);
  return request ? { phase, callId, ...request } : null;
}

module.exports = {
  LIMITS,
  normalizeCodexUserInputWire,
  normalizeRequestArguments,
  parseCodexUserInputRecord,
};
