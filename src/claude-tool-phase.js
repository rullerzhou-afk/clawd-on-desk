"use strict";

const {
  normalizeClaudePhaseId: normalizeIdentity,
  normalizeClaudeBatchToolUseIds,
} = require("../hooks/claude-tool-batch");

const MAX_SESSIONS = 200;
const MAX_TOOLS = 256;
const MAX_RETIRED_PROMPTS = 16;
const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const TERMINAL_EVENTS = new Set(["Stop", "StopFailure", "ApiError", "SessionEnd"]);

// A phase hint is weaker than permissions, completion, or subagent lifecycle.
// This ledger only authorizes a main-session batch boundary; its caller owns
// those stronger gates and must run this check before mutating any of them.
function createClaudeToolPhaseLedger(options = {}) {
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0
    ? Math.min(options.maxSessions, MAX_SESSIONS)
    : MAX_SESSIONS;
  const maxTools = Number.isSafeInteger(options.maxTools) && options.maxTools > 0
    ? Math.min(options.maxTools, MAX_TOOLS)
    : MAX_TOOLS;
  const records = new Map();

  function remember(set, value, limit) {
    if (!value) return;
    set.delete(value);
    set.add(value);
    while (set.size > limit) set.delete(set.values().next().value);
  }

  function touch(sessionId, record) {
    records.delete(sessionId);
    records.set(sessionId, record);
    while (records.size > maxSessions) records.delete(records.keys().next().value);
  }

  function makeRecord() {
    return {
      promptId: null,
      open: false,
      unconfirmable: false,
      tools: new Map(),
      retiredToolIds: new Set(),
      retiredPromptIds: new Set(),
    };
  }

  function retireCurrent(record, retirePrompt = true) {
    if (retirePrompt) remember(record.retiredPromptIds, record.promptId, MAX_RETIRED_PROMPTS);
    for (const id of record.tools.keys()) remember(record.retiredToolIds, id, maxTools);
    record.tools.clear();
  }

  function observe(rawInput = {}) {
    const input = rawInput && typeof rawInput === "object" ? rawInput : {};
    const isBatch = input.event === "PostToolBatch";
    const isChild = typeof input.subagentId === "string" && !!input.subagentId.trim();
    if (isChild) return { accept: !isBatch, reason: isBatch ? "subagent-batch" : "subagent-event" };

    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
      return { accept: !isBatch, reason: "no-session" };
    }
    const event = input.event;
    const isPrompt = event === "UserPromptSubmit";
    const isPre = event === "PreToolUse"
      || (event === "SubagentStart" && input.subagentLifecycleSource === "synthetic-tool"
        && normalizeIdentity(input.toolUseId) !== null);
    const isPost = POST_EVENTS.has(event);
    const isTerminal = TERMINAL_EVENTS.has(event);
    if (!isPrompt && !isPre && !isPost && !isBatch && !isTerminal) {
      return { accept: true, reason: "legacy-event" };
    }
    const promptId = normalizeIdentity(input.promptId);
    let record = records.get(sessionId);
    if (!record && (isPrompt || (isTerminal && promptId))) {
      record = makeRecord();
      if (isTerminal) record.promptId = promptId;
    }
    if (!record) return { accept: !isBatch, reason: "no-ledger" };
    touch(sessionId, record);

    if (promptId && record.retiredPromptIds.has(promptId)) {
      return { accept: false, reason: "retired-prompt" };
    }
    if (isPrompt) {
      // A duplicated async prompt callback must not discard tools already
      // observed for that exact prompt, overwrite working with thinking, or
      // reopen a completed turn.
      if (promptId && promptId === record.promptId) {
        return { accept: false, reason: record.open ? "duplicate-prompt" : "closed-prompt" };
      }
      retireCurrent(record);
      record.promptId = promptId;
      record.open = true;
      record.unconfirmable = !promptId;
      return { accept: true, reason: "new-prompt" };
    }
    if (promptId && record.promptId && promptId !== record.promptId) {
      return { accept: false, reason: "different-prompt" };
    }
    const toolUseId = normalizeIdentity(input.toolUseId);
    if ((isPre || isPost) && toolUseId && record.retiredToolIds.has(toolUseId)) {
      return { accept: false, reason: "retired-tool" };
    }
    if (!record.promptId && !isBatch) {
      return { accept: true, reason: "legacy-uncorrelated-turn" };
    }
    if (isTerminal) {
      retireCurrent(record, false);
      record.promptId = promptId || record.promptId;
      record.open = false;
      record.unconfirmable = true;
      return { accept: true, reason: "terminal" };
    }

    if (isBatch) {
      if (!record.open) return { accept: false, reason: "closed-turn" };
      if (!promptId || !record.promptId || promptId !== record.promptId) {
        return { accept: false, reason: "uncorrelated-batch" };
      }
      const ids = normalizeClaudeBatchToolUseIds(input.toolUseIds);
      if (!ids) return { accept: false, reason: "invalid-batch" };
      if (record.unconfirmable) return { accept: false, reason: "uncertain-tools" };
      for (const id of ids) {
        const tool = record.tools.get(id);
        if (!tool || record.retiredToolIds.has(id)) return { accept: false, reason: "unknown-batch-tool" };
        if (tool.batchSettled) return { accept: false, reason: "settled-batch" };
      }
      const batchIds = new Set(ids);
      // Even a PostToolUse-completed sibling still needs its own batch
      // boundary. An older partial batch must not override a newer cohort.
      for (const [id, tool] of record.tools) {
        if (!tool.batchSettled && !batchIds.has(id)) {
          return { accept: false, reason: "other-unsettled-tools" };
        }
      }
      for (const id of ids) record.tools.get(id).batchSettled = true;
      return { accept: true, thinking: true, reason: "batch-settled" };
    }

    const knownTool = toolUseId ? record.tools.get(toolUseId) : null;
    if (knownTool && knownTool.batchSettled) {
      return { accept: false, reason: "settled-tool-tail" };
    }
    if (!record.open) {
      // A fresh PreToolUse can follow a vetoed Stop without a new prompt.
      // Preserve that legacy continuation, but do not infer a new phase turn.
      return { accept: isPre || !promptId, reason: "closed-turn" };
    }
    if (!promptId || !record.promptId || !toolUseId) {
      record.unconfirmable = true;
      return { accept: true, reason: "uncorrelated-tool" };
    }
    if (isPre) {
      if (!knownTool) {
        if (record.tools.size >= maxTools) {
          record.unconfirmable = true;
          return { accept: true, reason: "tool-capacity" };
        }
        record.tools.set(toolUseId, { completed: false, batchSettled: false });
      }
      return { accept: true, reason: "tool-start" };
    }
    if (!knownTool) {
      // Async Post may beat Pre. Fail closed for the phase hint instead of
      // inventing its start or guessing that another turn's tool is current.
      record.unconfirmable = true;
      return { accept: true, reason: "unknown-tool-result" };
    }
    knownTool.completed = true;
    return { accept: true, reason: "tool-result" };
  }

  return {
    observe,
    clear() { records.clear(); },
    get size() { return records.size; },
  };
}

module.exports = { createClaudeToolPhaseLedger };
