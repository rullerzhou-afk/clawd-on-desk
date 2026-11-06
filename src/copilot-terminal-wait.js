"use strict";

// Track requests Copilot is waiting for the user to answer in its terminal.
// pending keeps multiple unanswered requests for the same object.
// unconsumed pairs early tool completions with notifications that arrive later.
// boundaryTs prevents an old notification from reopening a completed turn.
// Remote waits cannot observe process exit, so cap pending requests at two hours.
// The sixty-second completion window only pairs out-of-order delivery, limiting
// how long an unmatched completion can suppress a later request for the same object.
const MAX_PENDING_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_UNCONSUMED_AGE_MS = 60 * 1000;

function createCopilotTerminalWait({ now = Date.now } = {}) {
  const sessions = new Map();
  const listeners = new Set();
  function notify(sessionId) {
    for (const listener of listeners) listener(sessionId);
  }
  function hasPending(session) {
    return session.pending.size > 0;
  }
  function clearSession(sessionId) {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (session && hasPending(session)) notify(sessionId);
  }
  function pruneExpired() {
    const changedSessions = [];
    const at = now();
    for (const [sessionId, session] of sessions) {
      let changed = false;
      for (const [key, entries] of session.pending) {
        const retained = entries.filter(entry => at - entry.pendingSince <= MAX_PENDING_AGE_MS);
        if (retained.length === entries.length) continue;
        changed = true;
        if (retained.length) session.pending.set(key, retained);
        else session.pending.delete(key);
      }
      for (const [key, entries] of session.unconsumed) {
        const retained = entries.filter(entry => at - entry.at <= MAX_UNCONSUMED_AGE_MS);
        if (retained.length) session.unconsumed.set(key, retained);
        else session.unconsumed.delete(key);
      }
      if (changed) changedSessions.push(sessionId);
    }
    // Finish the batch before listeners read back into the ledger.
    for (const sessionId of changedSessions) notify(sessionId);
  }
  function take(entriesByKey, key, matches) {
    const entries = entriesByKey.get(key);
    const index = entries?.findIndex(matches) ?? -1;
    if (index < 0) return false;
    entries.splice(index, 1);
    if (!entries.length) entriesByKey.delete(key);
    return true;
  }
  function clearThrough(entriesByKey, ts) {
    let changed = false;
    for (const [key, entries] of entriesByKey) {
      const retained = ts === null ? [] : entries.filter(entry => entry.ts !== null && entry.ts > ts);
      if (retained.length === entries.length) continue;
      changed = true;
      if (retained.length) entriesByKey.set(key, retained);
      else entriesByKey.delete(key);
    }
    return changed;
  }
  function append(entriesByKey, key, entry, clockField) {
    const entries = entriesByKey.get(key) || [];
    entries.push(entry);
    entriesByKey.set(key, entries);
    let count = 0;
    let oldestKey = key;
    let oldestAt = Infinity;
    for (const [candidate, queue] of entriesByKey) {
      count += queue.length;
      if (queue[0][clockField] < oldestAt) {
        oldestAt = queue[0][clockField];
        oldestKey = candidate;
      }
    }
    if (count > 20) take(entriesByKey, oldestKey, () => true);
  }

  return {
    onHook(sessionId, event, opts = {}) {
      pruneExpired();
      const boundary = ["userPromptSubmitted", "agentStop", "sessionEnd"].includes(event);
      const notification = event === "Notification" && !!opts.copilotWaitKey;
      const completion = (event === "postToolUse" || event === "postToolUseFailure") && opts.copilotToolKeys?.length;
      if (!boundary && !notification && !completion) return;
      let session = sessions.get(sessionId);
      if (!session) {
        if (sessions.size >= 200) clearSession(sessions.keys().next().value);
        session = { pending: new Map(), unconsumed: new Map(), boundaryTs: 0 };
        sessions.set(sessionId, session);
      }
      const ts = Number.isFinite(opts.copilotEventTs) && opts.copilotEventTs > 0 ? opts.copilotEventTs : null;
      if (boundary) {
        // A late boundary must not retire requests from a newer prompt.
        const changed = clearThrough(session.pending, ts);
        clearThrough(session.unconsumed, ts);
        session.boundaryTs = Math.max(session.boundaryTs, ts || 0);
        if (changed) notify(sessionId);
      } else if (notification) {
        if (ts !== null && ts <= session.boundaryTs) return;
        const key = opts.copilotWaitKey;
        if (take(session.unconsumed, key, entry => ts === null || entry.ts === null || entry.ts >= ts)) return;
        append(session.pending, key, { ts, pendingSince: now() }, "pendingSince");
        notify(sessionId);
      } else {
        let changed = false;
        for (const key of new Set(opts.copilotToolKeys)) {
          if (take(session.pending, key, entry => ts === null || entry.ts === null || entry.ts <= ts)) changed = true;
          else append(session.unconsumed, key, { ts, at: now() }, "at");
        }
        if (changed) notify(sessionId);
      }
    },
    clearSession,
    clearAll() {
      const pendingIds = [...sessions].filter(([, session]) => hasPending(session)).map(([id]) => id);
      sessions.clear();
      for (const id of pendingIds) notify(id);
    },
    getPendingSessionIds() {
      // Reuse the state's ten-second stale sweep instead of another timer.
      pruneExpired();
      return new Set([...sessions].filter(([, session]) => hasPending(session)).map(([id]) => id));
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = { createCopilotTerminalWait, MAX_PENDING_AGE_MS, MAX_UNCONSUMED_AGE_MS };
