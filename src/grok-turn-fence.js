"use strict";

// Grok-specific, bounded, in-memory turn-order fence (Phase 1).
//
// Grok's hook transport can deliver turn-scoped reports out of order:
//   - a cancelled turn report may arrive after a later UserPromptSubmit;
//   - a report for an unseen promptId may be a real bash-mode turn end;
//   - continuation Stops (stopHookActive / live background work / crons) are
//     not terminal even though their upstream event name is `Stop`.
//
// The adapter resolves the Stop matrix locally and only posts the resulting
// `state`/`event` pair plus a bounded opaque `prompt_id`. This component is the
// server-side arbiter for ordering. It is deliberately separate from the mature
// Codex fence: the domains differ on continuation Stops and on the
// Stop -> StopCancelled correction, and reusing the Codex lifecycle would widen
// the Phase 1 blast radius.
//
// Atomic ordering: `assess()` is read-only and returns a decision with an
// optional `commit()` that applies the mutation. Callers MUST call `commit()`
// only after the synchronous state update succeeds, so an update exception can
// never permanently mark an un-applied terminal event as handled.
//
// Never log the raw opaque id: only a short digest and the decision reason.

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_TOMBSTONES = 512;
const DEFAULT_MAX_PROMPT_ID_LENGTH = 128;

const WORK_STATES = new Set(["thinking", "working", "sweeping", "juggling"]);
// Terminal turn outcomes (an accepted one tombstones the turn). `StopFailure`
// is a failed turn end, so it is terminal for ordering just like `Stop`.
const TERMINAL_EVENTS = new Set(["Stop", "StopFailure"]);

// Reject rather than truncate: a truncated overlong id could collide with a
// different live turn and clear or overwrite it.
function normalizeGrokPromptId(value, maxLength = DEFAULT_MAX_PROMPT_ID_LENGTH) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function digestGrokPromptId(value) {
  if (typeof value !== "string" || !value) return "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function classifyGrokEvent({ event, state, notificationType }) {
  if (event === "UserPromptSubmit") return "start";
  // A late SessionStart (Windows Grok 1.0.30 can deliver it after the first
  // UserPromptSubmit) is a lifecycle boundary, not turn work. It is handled
  // explicitly so it can never regress an already-established turn.
  if (event === "SessionStart") return "session-start";
  if (event === "StopCancelled") return "correction";
  if (TERMINAL_EVENTS.has(event)) return "terminal";
  if (event === "SessionEnd") return "session-end";
  if (event === "Notification" && notificationType === "idle_prompt") return "session-settle";
  // Compaction is a session-presentation event: it may update the visual state
  // (sweeping/thinking) without a promptId, but it must never create, clear,
  // tombstone, settle, or switch the current turn.
  if (event === "PreCompact" || event === "PostCompact") return "presentation";
  // PostToolUseFailure is still turn work for ordering even though its state is
  // `error`; it must never be dropped as housekeeping.
  if (event === "PostToolUseFailure") return "work";
  if (!event && WORK_STATES.has(state)) return "continuation";
  if (WORK_STATES.has(state)) return "work";
  return "housekeeping";
}

function createGrokTurnFence(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : DEFAULT_MAX_SESSIONS;
  const maxTombstones = Number.isInteger(options.maxTombstones) && options.maxTombstones > 0
    ? options.maxTombstones
    : DEFAULT_MAX_TOMBSTONES;
  const maxPromptIdLength = Number.isInteger(options.maxPromptIdLength) && options.maxPromptIdLength > 0
    ? options.maxPromptIdLength
    : DEFAULT_MAX_PROMPT_ID_LENGTH;
  const records = new Map();
  const tombstones = new Map();

  function safeSessionId(value) {
    return String(value || "-").replace(/[\r\n]/g, "_");
  }

  function tombstoneKey(sessionId, turnId) {
    return `${sessionId}\u0000${turnId}`;
  }

  function logDecision(kind, input, reason = null) {
    const digest = digestGrokPromptId(input.promptId);
    debugLog(
      `grok-fence ${kind} sid=${safeSessionId(input.sessionId)}`
      + ` event=${input.event || "-"} turn=${digest || "-"}`
      + `${reason ? ` reason=${reason}` : ""}`
    );
  }

  function deleteRecord(sessionId, reason) {
    const record = records.get(sessionId);
    if (!record) return;
    records.delete(sessionId);
    for (const turnId of record.tombstones.keys()) {
      tombstones.delete(tombstoneKey(sessionId, turnId));
    }
    if (reason) debugLog(`grok-fence evict sid=${safeSessionId(sessionId)} reason=${reason}`);
  }

  function touchRecord(sessionId, record) {
    record.touchedAt = now();
    records.delete(sessionId);
    records.set(sessionId, record);
    while (records.size > maxSessions) {
      deleteRecord(records.keys().next().value, "session-capacity");
    }
  }

  // Return the committed record, or a detached candidate for a first-seen
  // session. Dropped decisions never call touchRecord(), so an unaccepted event
  // cannot create or refresh a record. `touchRecord` performs the LRU insert.
  function getRecord(sessionId) {
    return records.get(sessionId)
      || {
        currentTurnId: null,
        terminalLatch: null,
        // The one turn whose accepted `Stop` may still be corrected by a
        // same-turn `StopCancelled`. Cleared by any later turn boundary, so a
        // correction can never reach back into a turn that has been superseded.
        correctableTurnId: null,
        tombstones: new Map(),
        touchedAt: now(),
      };
  }

  function addTombstone(sessionId, record, turnId, event) {
    if (!turnId) return;
    record.tombstones.set(turnId, { terminalEvent: event, closedAt: now() });
    const key = tombstoneKey(sessionId, turnId);
    tombstones.set(key, { sessionId, turnId });
    while (tombstones.size > maxTombstones) {
      const oldestKey = tombstones.keys().next().value;
      const oldest = tombstones.get(oldestKey);
      tombstones.delete(oldestKey);
      const owner = oldest && records.get(oldest.sessionId);
      if (owner) owner.tombstones.delete(oldest.turnId);
      if (oldest) {
        debugLog(
          `grok-fence evict sid=${safeSessionId(oldest.sessionId)}`
          + ` turn=${digestGrokPromptId(oldest.turnId) || "-"} reason=tombstone-capacity`
        );
      }
    }
  }

  const noCommit = () => {};

  function assess(rawInput = {}) {
    const sessionId = typeof rawInput.sessionId === "string" && rawInput.sessionId
      ? rawInput.sessionId
      : "";
    if (!sessionId) return { accept: true, reason: "no-session", kind: "housekeeping", commit: noCommit };
    const promptId = normalizeGrokPromptId(rawInput.promptId, maxPromptIdLength);
    const input = { ...rawInput, sessionId, promptId };
    const kind = classifyGrokEvent(input);
    if (kind === "housekeeping") {
      return { accept: true, reason: "housekeeping", kind, commit: noCommit };
    }

    if (kind === "session-start") {
      // A SessionStart is only a new lifecycle when this session has no fence
      // history. Once a turn is active, terminal-latched/settling, or tombstoned
      // (including after a supersede), a late SessionStart must be dropped so it
      // cannot regress or resurrect the turn. SessionEnd clears the record, so a
      // genuine restart after teardown is still accepted. This branch never
      // creates, switches, or clears a turn.
      const existing = records.get(sessionId);
      if (existing) {
        logDecision("drop", input, "session-start-after-activity");
        return { accept: false, reason: "session-start-after-activity", kind, commit: null };
      }
      return { accept: true, reason: "session-start", kind, commit: noCommit };
    }

    const record = getRecord(sessionId);
    const tombstoned = !!(promptId && record.tombstones.has(promptId));

    // Turn-establishing and turn-ending kinds require a valid bounded promptId.
    // Prompt-less `work` (tool) events are handled below: they may only bind to
    // an already-active turn. Only explicitly session-scoped presentation/
    // settle paths (SessionEnd, idle_prompt, and housekeeping events) may omit
    // the id entirely.
    if (!promptId && (kind === "start" || kind === "continuation")) {
      logDecision("drop", input, "missing-prompt-id");
      return { accept: false, reason: "missing-prompt-id", kind, commit: null };
    }

    if (kind === "start") {
      return {
        accept: true,
        reason: "start",
        kind,
        commit: () => {
          // Retain bounded knowledge that the previous turn was superseded, so
          // a late terminal/correction for it can never overwrite the newer
          // turn even after the newer turn itself completes.
          if (promptId && record.currentTurnId && record.currentTurnId !== promptId) {
            addTombstone(sessionId, record, record.currentTurnId, "superseded");
          }
          record.currentTurnId = promptId;
          record.terminalLatch = null;
          // A new turn closes the correction window for the previous one.
          record.correctableTurnId = null;
          touchRecord(sessionId, record);
        },
      };
    }

    if (kind === "presentation") {
      // Visual-only: no fence mutation whatsoever, with or without a promptId.
      return { accept: true, reason: "presentation", kind, commit: noCommit };
    }

    if (kind === "work" || kind === "continuation") {
      if (promptId && tombstoned) {
        // A closed (completed or superseded) turn never reopens from late work.
        logDecision("drop", input, "closed-turn-id");
        return { accept: false, reason: "closed-turn-id", kind, commit: null };
      }
      if (record.terminalLatch) {
        logDecision("drop", input, "terminal-latch");
        return { accept: false, reason: "terminal-latch", kind, commit: null };
      }
      if (promptId && record.currentTurnId && record.currentTurnId !== promptId) {
        logDecision("drop", input, "unexpected-distinct-work");
        return { accept: false, reason: "unexpected-distinct-work", kind, commit: null };
      }
      if (!promptId && !record.currentTurnId) {
        // Prompt-less tool work (Grok 1.0.30 omits the id on tool events) may
        // only bind to a current turn that UserPromptSubmit already established.
        // It must never create/reopen a turn, so this also covers: before any
        // prompt, after a terminal latch, and after SessionEnd (record cleared).
        logDecision("drop", input, "no-active-turn");
        return { accept: false, reason: "no-active-turn", kind, commit: null };
      }
      return {
        accept: true,
        reason: kind,
        kind,
        commit: () => {
          // A continuation Stop must never latch or tombstone the turn, and a
          // prompt-less work event never creates one — it binds to the existing
          // currentId only.
          if (promptId && !record.currentTurnId) record.currentTurnId = promptId;
          touchRecord(sessionId, record);
        },
      };
    }

    if (kind === "session-end") {
      return {
        accept: true,
        reason: "session-end",
        kind,
        commit: () => {
          deleteRecord(sessionId, null);
          for (const [key, entry] of [...tombstones]) {
            if (entry && entry.sessionId === sessionId) tombstones.delete(key);
          }
        },
      };
    }

    if (kind === "session-settle") {
      return {
        accept: true,
        reason: "session-settle",
        kind,
        commit: () => {
          if (record.currentTurnId) addTombstone(sessionId, record, record.currentTurnId, "Notification");
          record.currentTurnId = null;
          record.terminalLatch = null;
          record.correctableTurnId = null;
          touchRecord(sessionId, record);
        },
      };
    }

    // Turn-terminal reports (Stop / StopFailure / StopCancelled) require a real
    // promptId. Only idle_prompt and SessionEnd may settle without one.
    if (!promptId) {
      logDecision("drop", input, "missing-prompt-id");
      return { accept: false, reason: "missing-prompt-id", kind, commit: null };
    }

    if (kind === "correction") {
      const existing = record.tombstones.get(promptId);
      // Only a genuinely accepted `Stop` may be corrected, and only while no
      // later turn boundary has intervened (`correctableTurnId`). A
      // `StopFailure`, a superseded turn, or a post-B correction of A is not
      // correctable; a duplicate StopCancelled drops.
      if (existing
        && existing.terminalEvent === "Stop"
        && record.correctableTurnId === promptId) {
        return {
          accept: true,
          reason: "corrective-terminal",
          kind,
          commit: () => {
            record.tombstones.set(promptId, { terminalEvent: "StopCancelled", closedAt: now() });
            record.currentTurnId = null;
            record.terminalLatch = null;
            record.correctableTurnId = null;
            touchRecord(sessionId, record);
          },
        };
      }
      if (tombstoned) {
        logDecision("drop", input, "duplicate-terminal");
        return { accept: false, reason: "duplicate-terminal", kind, commit: null };
      }
      if (record.currentTurnId && record.currentTurnId !== promptId) {
        logDecision("drop", input, "stale-terminal");
        return { accept: false, reason: "stale-terminal", kind, commit: null };
      }
      return {
        accept: true,
        reason: "terminal",
        kind,
        commit: () => {
          addTombstone(sessionId, record, promptId, "StopCancelled");
          record.currentTurnId = null;
          record.terminalLatch = null;
          record.correctableTurnId = null;
          touchRecord(sessionId, record);
        },
      };
    }

    // kind === "terminal"
    if (tombstoned) {
      logDecision("drop", input, "duplicate-terminal");
      return { accept: false, reason: "duplicate-terminal", kind, commit: null };
    }
    if (record.currentTurnId && record.currentTurnId !== promptId) {
      // A late terminal for an older turn arrives after a newer turn started.
      // Drop it: currentTurnId stays on the newer turn, and a duplicate of the
      // older id is dropped the same way (or as a superseded tombstone).
      logDecision("drop", input, "stale-terminal");
      return { accept: false, reason: "stale-terminal", kind, commit: null };
    }
    return {
      accept: true,
      reason: "terminal",
      kind,
      commit: () => {
        addTombstone(sessionId, record, promptId, input.event === "StopFailure" ? "StopFailure" : "Stop");
        record.currentTurnId = null;
        record.terminalLatch = {
          turnId: promptId,
          terminalEvent: input.event,
          closedAt: now(),
        };
        // Only an accepted `Stop` opens a same-turn correction window.
        record.correctableTurnId = input.event === "Stop" ? promptId : null;
        touchRecord(sessionId, record);
      },
    };
  }

  function clear() {
    records.clear();
    tombstones.clear();
  }

  function clearSession(sessionId) {
    const id = typeof sessionId === "string" ? sessionId : "";
    if (!id) return false;
    const had = records.has(id);
    deleteRecord(id, null);
    let removed = false;
    for (const [key, entry] of [...tombstones]) {
      if (entry && entry.sessionId === id) {
        tombstones.delete(key);
        removed = true;
      }
    }
    return had || removed;
  }

  function getSnapshot(sessionId) {
    const record = records.get(sessionId);
    if (!record) return null;
    return {
      currentTurnId: record.currentTurnId,
      terminalLatch: record.terminalLatch ? { ...record.terminalLatch } : null,
      correctableTurnId: record.correctableTurnId || null,
      tombstones: [...record.tombstones.entries()].map(([turnId, value]) => ({ turnId, ...value })),
      touchedAt: record.touchedAt,
    };
  }

  return {
    assess,
    clear,
    clearSession,
    getSnapshot,
    get size() { return records.size; },
    get tombstoneSize() { return tombstones.size; },
  };
}

createGrokTurnFence.DEFAULT_MAX_SESSIONS = DEFAULT_MAX_SESSIONS;
createGrokTurnFence.DEFAULT_MAX_TOMBSTONES = DEFAULT_MAX_TOMBSTONES;
createGrokTurnFence.DEFAULT_MAX_PROMPT_ID_LENGTH = DEFAULT_MAX_PROMPT_ID_LENGTH;
createGrokTurnFence.normalizeGrokPromptId = normalizeGrokPromptId;
createGrokTurnFence.digestGrokPromptId = digestGrokPromptId;
createGrokTurnFence.classifyGrokEvent = classifyGrokEvent;

module.exports = createGrokTurnFence;
