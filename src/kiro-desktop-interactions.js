"use strict";

// A generous day-long limit preserves ordinary waits while bounding stale
// entries when a resolution or process-exit signal was missed.
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

function interactionKey(info) {
  return `${info.executionId}\0${info.toolCallId}\0${info.consentRound}`;
}

function createKiroDesktopInteractions({ now = Date.now } = {}) {
  const sessions = new Map();
  const listeners = new Set();
  function notify(sessionId) {
    for (const listener of listeners) listener(sessionId);
  }
  function clearSession(sessionId) {
    if (sessions.delete(sessionId)) notify(sessionId);
  }
  function pruneExpired() {
    const cutoff = now() - MAX_PENDING_AGE_MS;
    const changedSessions = [];
    for (const [sessionId, entries] of sessions) {
      let changed = false;
      for (const [key, entry] of entries) {
        if (entry.pendingSince >= cutoff) continue;
        entries.delete(key);
        changed = true;
      }
      if (!entries.size) sessions.delete(sessionId);
      if (changed) changedSessions.push(sessionId);
    }
    // Remove the full expired batch before listeners read back into the ledger.
    for (const sessionId of changedSessions) notify(sessionId);
  }
  return {
    add(sessionId, info) {
      pruneExpired();
      let entries = sessions.get(sessionId);
      if (!entries) {
        if (sessions.size >= 200) clearSession(sessions.keys().next().value);
        entries = new Map();
        sessions.set(sessionId, entries);
      }
      const key = interactionKey(info);
      if (entries.has(key)) return;
      entries.set(key, { ...info, interactionKey: key, pendingSince: now() });
      if (entries.size > 20) entries.delete(entries.keys().next().value);
      notify(sessionId);
    },
    resolve(sessionId, info) {
      const entries = sessions.get(sessionId);
      if (!entries?.delete(interactionKey(info))) return;
      if (!entries.size) sessions.delete(sessionId);
      notify(sessionId);
    },
    clearExecution(sessionId, executionId) {
      const entries = sessions.get(sessionId);
      if (!entries) return;
      let changed = false;
      for (const [key, entry] of entries) {
        if (entry.executionId === executionId) { entries.delete(key); changed = true; }
      }
      if (!entries.size) sessions.delete(sessionId);
      if (changed) notify(sessionId);
    },
    clearSession,
    clearAll() { for (const id of [...sessions.keys()]) clearSession(id); },
    getLatest(sessionId) {
      pruneExpired();
      const entries = sessions.get(sessionId);
      return entries ? [...entries.values()].at(-1) : null;
    },
    getPendingSessionIds() {
      // The existing state stale sweep reads this every ten seconds.
      pruneExpired();
      return new Set(sessions.keys());
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = { createKiroDesktopInteractions, interactionKey, MAX_PENDING_AGE_MS };
