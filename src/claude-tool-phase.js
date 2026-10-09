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
// those stronger gates. Existing hooks are admitted normally; proven old
// evidence may preserve the phase without dropping message/lifecycle handling.
// accept=false drops only a batch hint. preservePhase retains normal metadata
// and exact permission cleanup. thinking is a gated presentation hint;
// errorCue retains a real failure, and countToolCall admits a first delayed Pre
// solely to recap accounting without refreshing session state or liveness.
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
      earlyBatches: [],
      queuedBatches: new Map(),
      retiredToolIds: new Set(),
      retiredFirstPres: new Map(),
      retiredPromptIds: new Set(),
    };
  }

  function retireCurrent(record, retirePrompt = true) {
    if (retirePrompt) remember(record.retiredPromptIds, record.promptId, MAX_RETIRED_PROMPTS);
    for (const [id, tool] of record.tools) {
      remember(record.retiredToolIds, id, maxTools);
      // preObserved means an ordinary Pre (including a synthetic Agent/Task
      // start) reached the ledger; a result/batch alone cannot set it.
      if (!tool.preObserved) record.retiredFirstPres.set(id, record.promptId);
    }
    for (const batch of record.earlyBatches) {
      for (const id of batch) {
        remember(record.retiredToolIds, id, maxTools);
        if (!record.tools.has(id)) record.retiredFirstPres.set(id, record.promptId);
      }
    }
    for (const id of record.retiredFirstPres.keys()) {
      if (!record.retiredToolIds.has(id)) record.retiredFirstPres.delete(id);
    }
    record.tools.clear();
    record.earlyBatches = [];
    record.queuedBatches.clear();
  }

  function preservePhase(reason, retired = false) {
    return { accept: true, preservePhase: true, retired, reason };
  }

  function observe(rawInput = {}) {
    const input = rawInput && typeof rawInput === "object" ? rawInput : {};
    const isBatch = input.event === "PostToolBatch";
    const isChild = typeof input.subagentId === "string" && !!input.subagentId.trim();

    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
      return { accept: !isBatch, reason: "no-session" };
    }
    if (isChild) {
      const record = records.get(sessionId);
      // The State tracker supplies this private proof only for a known live
      // native child. An unknown/duplicate Stop cannot retire phase evidence.
      if (record && input.confirmedNativeChildEnd === true) {
        for (const tool of record.tools.values()) {
          if (tool.batchSettled) tool.nativeChildEnded = true;
        }
      }
      return { accept: !isBatch, reason: isBatch ? "subagent-batch" : "subagent-event" };
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
    if (!record && (isPrompt || (promptId && (isPre || isPost || isTerminal)))) {
      record = makeRecord();
    }
    if (!record) return { accept: !isBatch, reason: "no-ledger" };
    touch(sessionId, record);

    // SessionEnd disposes the session, not a prompt. A final packet can carry
    // an older prompt identity and must still reach lifecycle/permission cleanup.
    if (event === "SessionEnd") {
      retireCurrent(record, false);
      record.open = false;
      record.unconfirmable = true;
      return { accept: true, reason: "session-end" };
    }
    const toolUseId = normalizeIdentity(input.toolUseId);
    const countRetiredFirstPre = () => {
      if (!isPre || !promptId || !toolUseId
        || record.retiredFirstPres.get(toolUseId) !== promptId) return false;
      record.retiredFirstPres.delete(toolUseId);
      return true;
    };
    if (promptId && record.retiredPromptIds.has(promptId)) {
      return isBatch ? { accept: false, reason: "retired-prompt" }
        : { ...preservePhase("retired-prompt", true), countToolCall: countRetiredFirstPre() };
    }
    if (isPrompt) {
      // prompt_id identifies a query loop, not an individual message. Claude
      // can emit multiple genuine UserPromptSubmit events under the same id.
      // Keep the tool evidence, but let normal message handling run.
      if (promptId && promptId === record.promptId) {
        return { accept: true, reason: "same-prompt-message" };
      }
      const queued = record.queuedBatches.get(promptId) || [];
      retireCurrent(record);
      record.promptId = promptId;
      record.earlyBatches = queued;
      record.open = true;
      record.unconfirmable = !promptId;
      return { accept: true, reason: "new-prompt" };
    }
    if ((isPre || isPost) && toolUseId && record.retiredToolIds.has(toolUseId)) {
      return { ...preservePhase("retired-tool", true), countToolCall: countRetiredFirstPre() };
    }
    // A queued message can acquire a new prompt id without another Submit
    // hook. Ordinary tool or terminal evidence may adopt that identity; a
    // terminal immediately retires it, retaining only bounded first-Pre
    // accounting evidence. A batch itself
    // must never replace the current ledger or invent its tool starts.
    if (!isBatch && promptId && promptId !== record.promptId) {
      if (record.open) {
        // Unseen ordinary traffic is not proof that the open query ended.
        // Retain its identity so its own Stop still completes normally.
        record.unconfirmable = true;
        record.earlyBatches = [];
        return { accept: true, reason: "different-open-prompt" };
      }
      const queued = record.queuedBatches.get(promptId) || [];
      retireCurrent(record);
      record.promptId = promptId;
      record.earlyBatches = queued;
      record.open = true;
      record.unconfirmable = false;
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
      if (!record.open) {
        // A queued turn may omit Submit, and its batch can beat its first Pre.
        // Keep bounded evidence without adopting or reopening that turn. Only
        // a later ordinary callback with the exact new prompt may adopt it.
        const ids = normalizeClaudeBatchToolUseIds(input.toolUseIds);
        if (input.allowThinking !== false && promptId && record.promptId && promptId !== record.promptId
          && ids && !ids.some(id => record.retiredToolIds.has(id))) {
          const queued = record.queuedBatches.get(promptId) || [];
          if (queued.some(batch => batch.size === ids.length && ids.every(id => batch.has(id)))) {
            return { accept: false, reason: "queued-batch" };
          }
          const total = [...record.queuedBatches.values()].flat().reduce((n, batch) => n + batch.size, 0);
          if (total + ids.length <= maxTools && (record.queuedBatches.has(promptId)
            || record.queuedBatches.size < MAX_RETIRED_PROMPTS)) {
            queued.push(new Set(ids));
            record.queuedBatches.set(promptId, queued);
            return { accept: false, reason: "queued-batch" };
          }
        }
        return { accept: false, reason: "closed-turn" };
      }
      if (!promptId || !record.promptId || promptId !== record.promptId) {
        return { accept: false, reason: "uncorrelated-batch" };
      }
      const ids = normalizeClaudeBatchToolUseIds(input.toolUseIds);
      if (!ids) return { accept: false, reason: "invalid-batch" };
      if (record.unconfirmable) return { accept: false, reason: "uncertain-tools" };
      let missingStart = false;
      for (const id of ids) {
        const tool = record.tools.get(id);
        if (record.retiredToolIds.has(id)) return { accept: false, reason: "unknown-batch-tool" };
        if (!tool) missingStart = true;
        else if (tool.batchSettled) return { accept: false, reason: "settled-batch" };
      }
      const batchIds = new Set(ids);
      // Even a PostToolUse-completed sibling still needs its own batch
      // boundary. An older partial batch must not override a newer cohort.
      for (const [id, tool] of record.tools) {
        if (!tool.batchSettled && !batchIds.has(id)) {
          return { accept: false, reason: "other-unsettled-tools" };
        }
      }
      if (missingStart) {
        // Batch hooks skip PID discovery and can overtake fast Pre/Post hooks.
        // Retain the whole boundary, but never invent starts or change phase
        // until every named tool has supplied ordinary correlated evidence.
        const duplicate = record.earlyBatches.some(batch => batch.size === batchIds.size
          && ids.every(id => batch.has(id)));
        const retainedIds = record.earlyBatches.reduce((count, batch) => count + batch.size, 0);
        if (!duplicate && retainedIds + ids.length > maxTools) {
          record.unconfirmable = true;
          record.earlyBatches = [];
          return { accept: false, reason: "early-batch-capacity" };
        }
        if (!duplicate) record.earlyBatches.push(batchIds);
        return { accept: false, reason: "early-batch" };
      }
      for (const id of ids) record.tools.get(id).batchSettled = true;
      record.earlyBatches = record.earlyBatches.filter(batch => !ids.some(id => batch.has(id)));
      return { accept: true, thinking: true, reason: "batch-settled" };
    }

    const knownTool = toolUseId ? record.tools.get(toolUseId) : null;
    if (knownTool && knownTool.batchSettled) {
      if (isPre) {
        const countToolCall = knownTool.preObserved !== true;
        knownTool.preObserved = true;
        // SubagentStart still owns collaboration lifecycle after Batch→Post.
        // Its tool may be settled, but the launched child is not finished.
        if (event === "SubagentStart") return knownTool.nativeChildEnded
          ? { ...preservePhase("settled-subagent-tail"), countToolCall }
          : { accept: true, reason: "settled-subagent-start" };
        return { ...preservePhase("settled-tool-tail"), countToolCall };
      }
      // Async batch and result hooks can arrive in either order. A current
      // failure still owns its normal error cue and permission cleanup.
      return event === "PostToolUseFailure"
        ? { accept: true, preservePhase: true, errorCue: true, reason: "settled-tool-failure" }
        : preservePhase("settled-tool-tail");
    }
    if (!record.open) {
      // A vetoed Stop resumes the same query loop with no new Submit. Fresh,
      // identified tool starts reopen and register that continuation. Unknown
      // results retain legacy behavior but cannot prove a batch boundary.
      if (isPre && promptId && toolUseId) {
        record.open = true;
        record.unconfirmable = false;
      } else {
        return { accept: true, reason: "closed-turn" };
      }
    }
    if (!promptId || !record.promptId || !toolUseId) {
      record.unconfirmable = true;
      return { accept: true, reason: "uncorrelated-tool" };
    }
    const earlyBatchTool = record.earlyBatches.some(batch => batch.has(toolUseId));
    if (isPre || earlyBatchTool) {
      if (!knownTool) {
        if (record.tools.size >= maxTools) {
          record.unconfirmable = true;
          return { accept: true, reason: "tool-capacity" };
        }
        record.tools.set(toolUseId, { batchSettled: false, preObserved: isPre });
      }
      if (isPre) record.tools.get(toolUseId).preObserved = true;
      if (!record.unconfirmable) {
        const ready = record.earlyBatches.find(batch => [...batch].every(id => record.tools.has(id)));
        if (ready) {
          const otherUnsettled = [...record.tools].some(([id, tool]) => !tool.batchSettled && !ready.has(id));
          for (const id of ready) record.tools.get(id).batchSettled = true;
          record.earlyBatches = record.earlyBatches.filter(batch => ![...ready].some(id => batch.has(id)));
          if (input.allowThinking === false) return {
            accept: true, errorCue: event === "PostToolUseFailure", reason: "reordered-batch-suppressed",
          };
          // Newer work can start before this older boundary's delayed tail.
          // Settle the old evidence without replacing that newer work's phase.
          if (otherUnsettled) return event === "PostToolUseFailure"
            ? { accept: true, preservePhase: true, errorCue: true, reason: "settled-tool-failure" }
            : preservePhase("settled-tool-tail");
          return { accept: true, thinking: true, errorCue: event === "PostToolUseFailure",
            reason: "reordered-batch-settled" };
        }
      }
      return { accept: true, reason: isPre ? "tool-start" : "early-batch-result" };
    }
    if (!knownTool) {
      // A fast tool's result can beat its own Pre; real turns have shown this.
      // Record it as unsettled work for this turn so its own batch can settle
      // it and an earlier batch cannot cross it. If that batch has already
      // settled it, the late Pre only backfills the start and its recap tool
      // call; otherwise the Pre is an ordinary tool start.
      if (record.tools.size >= maxTools) {
        record.unconfirmable = true;
        return { accept: true, reason: "tool-capacity" };
      }
      record.tools.set(toolUseId, { batchSettled: false, preObserved: false });
      return { accept: true, reason: "result-before-start" };
    }
    return { accept: true, reason: "tool-result" };
  }

  return {
    observe,
    clear() { records.clear(); },
    get size() { return records.size; },
  };
}

module.exports = { createClaudeToolPhaseLedger };
