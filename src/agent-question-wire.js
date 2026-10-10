"use strict";

// Reviewed native question contracts, not permissionApproval eligibility.
const SOURCES = Object.freeze({ opencode: "opencode-plugin", mimocode: "mimocode-plugin" });
const PROTOCOL = "clawd.question.v1";

function supportedVersion(agentId, version) {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return agentId === "opencode" ? major === 1 && (minor > 18 || (minor === 18 && patch >= 31))
    : agentId === "mimocode" && major === 0 && minor === 1 && patch >= 15;
}

function prepareQuestionRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.id !== "string" || !/^que[A-Za-z0-9_-]{1,124}$/.test(request.id)
    || typeof request.sessionID !== "string" || !/^ses[A-Za-z0-9_-]{1,124}$/.test(request.sessionID)
    || !request.tool || typeof request.tool.messageID !== "string" || !/^msg[A-Za-z0-9_-]{1,124}$/.test(request.tool.messageID)
    || typeof request.tool.callID !== "string" || !request.tool.callID || request.tool.callID.length > 128
    || !Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 5) return null;
  const questions = [];
  for (const [index, q] of request.questions.entries()) {
    if (!q || typeof q !== "object" || Array.isArray(q)
      || typeof q.question !== "string" || !q.question.trim() || q.question.length > 4000
      || typeof q.header !== "string" || q.header.length > 48
      || !Array.isArray(q.options) || q.options.length > 5
      || (q.multiple !== undefined && typeof q.multiple !== "boolean")
      || (q.custom !== undefined && typeof q.custom !== "boolean")
      || Object.keys(q).some(key => !["question", "header", "options", "multiple", "custom"].includes(key))) return null;
    const labels = new Set();
    const options = [];
    for (const option of q.options) {
      if (!option || typeof option.label !== "string" || !option.label
        || option.label.trim() !== option.label || option.label.length > 80
        || /[\u0000-\u001f\u007f]/.test(option.label) || labels.has(option.label)
        || typeof option.description !== "string" || option.description.length > 4000
        || Object.keys(option).some(key => key !== "label" && key !== "description")) return null;
      labels.add(option.label);
      options.push({ label: option.label, description: option.description });
    }
    if (!options.length && q.custom === false) return null;
    questions.push({ id: String(index), header: q.header, question: q.question,
      options, multiSelect: q.multiple === true, allowOther: q.custom !== false });
  }
  return { wire: request, displayInput: { questions } };
}

function validateQuestionAnswers(request, indexed) {
  if (!prepareQuestionRequest(request) || !indexed || typeof indexed !== "object" || Array.isArray(indexed)
    || Object.keys(indexed).length !== request.questions.length) return null;
  const answers = [];
  for (const [index, q] of request.questions.entries()) {
    const answer = indexed[String(index)];
    if (!Array.isArray(answer) || !answer.length || answer.length > 6
      || (q.multiple !== true && answer.length !== 1) || new Set(answer).size !== answer.length
      || answer.filter(value => !q.options.some(option => option.label === value)).length > 1
      || answer.some(value => typeof value !== "string" || !value.trim() || value.length > 4000
        || (q.custom === false && !q.options.some(option => option.label === value)))) return null;
    answers.push([...answer]);
  }
  return answers;
}

module.exports = { SOURCES, PROTOCOL, supportedVersion, prepareQuestionRequest, validateQuestionAnswers };
