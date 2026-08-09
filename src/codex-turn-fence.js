"use strict";

const { normalizeCodexTurnId, digestCodexTurnId } = require("./codex-turn-id");

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_CLOSED_TURNS = 512;

const START_EVENTS = new Set(["UserPromptSubmit", "event_msg:task_started"]);
const TERMINAL_EVENTS = new Set(["Stop", "event_msg:task_complete", "event_msg:turn_aborted"]);
const WORKING_STATES = new Set(["thinking", "working", "juggling", "sweeping"]);

function createCodexTurnFence(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : DEFAULT_MAX_SESSIONS;
  const maxClosedTurns = Number.isInteger(options.maxClosedTurns) && options.maxClosedTurns > 0
    ? options.maxClosedTurns
    : DEFAULT_MAX_CLOSED_TURNS;
  const records = new Map();
  const closedLru = new Map();

  function safeSessionId(value) {
    return String(value || "-").replace(/[\r\n]/g, "_");
  }

  function logDecision(kind, input, reason = null) {
    const digest = digestCodexTurnId(input.turnId);
    debugLog(
      `codex-fence ${kind} sid=${safeSessionId(input.sessionId)}`
      + ` source=${input.source || "-"} event=${input.event || "-"}`
      + ` turn=${digest || "-"}${reason ? ` reason=${reason}` : ""}`
    );
  }

  function closedKey(sessionId, turnId) {
    return `${sessionId}\u0000${turnId}`;
  }

  function deleteRecord(sessionId, reason) {
    const record = records.get(sessionId);
    if (!record) return;
    records.delete(sessionId);
    for (const turnId of record.closedTurnIds.keys()) {
      closedLru.delete(closedKey(sessionId, turnId));
    }
    if (reason) {
      debugLog(`codex-fence evict sid=${safeSessionId(sessionId)} reason=${reason}`);
    }
  }

  function touchRecord(sessionId, record) {
    record.touchedAt = now();
    records.delete(sessionId);
    records.set(sessionId, record);
    while (records.size > maxSessions) {
      deleteRecord(records.keys().next().value, "session-capacity");
    }
  }

  function getRecord(sessionId, create) {
    let record = records.get(sessionId) || null;
    if (!record && create) {
      record = {
        currentTurnId: null,
        terminalLatch: null,
        closedTurnIds: new Map(),
        touchedAt: now(),
      };
    }
    if (record) touchRecord(sessionId, record);
    return record;
  }

  function addClosedTurn(sessionId, record, turnId, event) {
    if (!turnId || record.closedTurnIds.has(turnId)) return;
    const closedAt = now();
    record.closedTurnIds.set(turnId, { terminalEvent: event, closedAt });
    const key = closedKey(sessionId, turnId);
    closedLru.set(key, { sessionId, turnId });
    while (closedLru.size > maxClosedTurns) {
      const oldestKey = closedLru.keys().next().value;
      const oldest = closedLru.get(oldestKey);
      closedLru.delete(oldestKey);
      const owner = oldest && records.get(oldest.sessionId);
      if (owner) owner.closedTurnIds.delete(oldest.turnId);
      if (oldest) {
        debugLog(
          `codex-fence evict sid=${safeSessionId(oldest.sessionId)}`
          + ` turn=${digestCodexTurnId(oldest.turnId) || "-"} reason=tombstone-capacity`
        );
      }
    }
  }

  function observe(rawInput = {}) {
    const sessionId = typeof rawInput.sessionId === "string" && rawInput.sessionId
      ? rawInput.sessionId
      : null;
    if (!sessionId) return { accept: true, reason: "no-session" };
    const input = {
      ...rawInput,
      sessionId,
      turnId: normalizeCodexTurnId(rawInput.turnId),
    };
    const syntheticOpenStart = input.syntheticBackfill === true
      && input.turnBoundaryOpen === true
      && !!input.turnId;
    const isStart = START_EVENTS.has(input.event) || syntheticOpenStart;
    const isTerminal = TERMINAL_EVENTS.has(input.event);
    const isWork = !isStart && !isTerminal && WORKING_STATES.has(input.state);
    if (!isStart && !isTerminal && !isWork) {
      return { accept: true, reason: "housekeeping" };
    }

    const record = getRecord(sessionId, true);
    const isClosed = !!(input.turnId && record.closedTurnIds.has(input.turnId));

    if (isClosed) {
      const reason = isTerminal ? "duplicate-terminal" : "closed-turn-id";
      logDecision("drop", input, reason);
      return { accept: false, reason };
    }

    if (isStart) {
      const hadLatch = !!record.terminalLatch;
      record.currentTurnId = input.turnId;
      record.terminalLatch = null;
      touchRecord(sessionId, record);
      if (!input.turnId) logDecision("ambiguity", input, "idless-start");
      if (hadLatch || input.syntheticBackfill === true) logDecision("reopen", input);
      return { accept: true, reason: "start" };
    }

    if (isWork) {
      if (record.terminalLatch) {
        logDecision("drop", input, input.syntheticBackfill ? "synthetic-ambiguous" : "terminal-latch");
        return { accept: false, reason: input.syntheticBackfill ? "synthetic-ambiguous" : "terminal-latch" };
      }
      if (!record.currentTurnId && input.turnId) {
        record.currentTurnId = input.turnId;
        touchRecord(sessionId, record);
      } else if (record.currentTurnId && input.turnId && record.currentTurnId !== input.turnId) {
        logDecision("drop", input, "unexpected-distinct-work");
        return { accept: false, reason: "unexpected-distinct-work" };
      }
      return { accept: true, reason: "work" };
    }

    if (input.turnId) addClosedTurn(sessionId, record, input.turnId, input.event);
    if (input.turnId && record.currentTurnId && record.currentTurnId !== input.turnId) {
      touchRecord(sessionId, record);
      logDecision("drop", input, "stale-terminal");
      return { accept: false, reason: "stale-terminal" };
    }

    record.currentTurnId = null;
    record.terminalLatch = {
      turnId: input.turnId,
      terminalEvent: input.event,
      closedAt: now(),
    };
    touchRecord(sessionId, record);
    logDecision("terminal", input);
    if (!input.turnId) logDecision("ambiguity", input, "idless-terminal");
    return { accept: true, reason: "terminal" };
  }

  function clear() {
    records.clear();
    closedLru.clear();
  }

  function getSnapshot(sessionId) {
    const record = records.get(sessionId);
    if (!record) return null;
    return {
      currentTurnId: record.currentTurnId,
      terminalLatch: record.terminalLatch ? { ...record.terminalLatch } : null,
      closedTurnIds: [...record.closedTurnIds.keys()],
      touchedAt: record.touchedAt,
    };
  }

  return {
    observe,
    clear,
    getSnapshot,
    get size() { return records.size; },
    get closedSize() { return closedLru.size; },
  };
}

createCodexTurnFence.DEFAULT_MAX_SESSIONS = DEFAULT_MAX_SESSIONS;
createCodexTurnFence.DEFAULT_MAX_CLOSED_TURNS = DEFAULT_MAX_CLOSED_TURNS;
createCodexTurnFence.START_EVENTS = START_EVENTS;
createCodexTurnFence.TERMINAL_EVENTS = TERMINAL_EVENTS;

module.exports = createCodexTurnFence;
