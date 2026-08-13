"use strict";

const { normalizeCodexTurnId, digestCodexTurnId } = require("./codex-turn-id");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_EXACT_MARKS = 8;

function createCodexOfficialActivity(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : DEFAULT_MAX_SESSIONS;
  const maxExactMarks = Number.isInteger(options.maxExactMarks) && options.maxExactMarks > 0
    ? options.maxExactMarks
    : DEFAULT_MAX_EXACT_MARKS;
  const sessions = new Map();

  function isRecent(timestamp) {
    return Number.isFinite(timestamp) && now() - timestamp <= ttlMs;
  }

  function pruneRecord(record) {
    for (const [turnId, timestamp] of record.exact) {
      if (!isRecent(timestamp)) record.exact.delete(turnId);
    }
    if (!isRecent(record.lastIdlessOfficialAt)) record.lastIdlessOfficialAt = null;
    if (!isRecent(record.lastAnyOfficialAt)) record.lastAnyOfficialAt = null;
  }

  function hasMarks(record) {
    return record.lastAnyOfficialAt !== null
      || record.lastIdlessOfficialAt !== null
      || record.exact.size > 0;
  }

  function touch(sessionId, record) {
    sessions.delete(sessionId);
    sessions.set(sessionId, record);
  }

  function pruneAllExpired() {
    for (const [sessionId, record] of sessions) {
      pruneRecord(record);
      if (!hasMarks(record)) sessions.delete(sessionId);
    }
  }

  function mark(sessionId, rawTurnId) {
    if (!sessionId) return;
    const turnId = normalizeCodexTurnId(rawTurnId);
    const timestamp = now();
    let record = sessions.get(String(sessionId));
    if (!record) record = { lastAnyOfficialAt: null, lastIdlessOfficialAt: null, exact: new Map() };
    pruneRecord(record);
    record.lastAnyOfficialAt = timestamp;
    if (turnId) {
      record.exact.delete(turnId);
      record.exact.set(turnId, timestamp);
      while (record.exact.size > maxExactMarks) record.exact.delete(record.exact.keys().next().value);
    } else {
      record.lastIdlessOfficialAt = timestamp;
    }
    touch(String(sessionId), record);
    if (sessions.size > maxSessions) pruneAllExpired();
    while (sessions.size > maxSessions) {
      const evicted = sessions.keys().next().value;
      sessions.delete(evicted);
      debugLog(`codex-official-activity evict sid=${String(evicted).replace(/[\r\n]/g, "_")} reason=session-capacity`);
    }
  }

  function hasRecent(sessionId, rawTurnId) {
    const key = String(sessionId || "");
    const record = sessions.get(key);
    if (!record) return false;
    pruneRecord(record);
    if (!hasMarks(record)) {
      sessions.delete(key);
      return false;
    }
    touch(key, record);
    const turnId = normalizeCodexTurnId(rawTurnId);
    if (!turnId) return isRecent(record.lastAnyOfficialAt);
    return isRecent(record.lastIdlessOfficialAt) || isRecent(record.exact.get(turnId));
  }

  function clear() {
    sessions.clear();
  }

  function getSnapshot(sessionId) {
    const record = sessions.get(String(sessionId || ""));
    if (!record) return null;
    return {
      lastAnyOfficialAt: record.lastAnyOfficialAt,
      lastIdlessOfficialAt: record.lastIdlessOfficialAt,
      exact: [...record.exact.keys()].map((turnId) => digestCodexTurnId(turnId)),
    };
  }

  return {
    mark,
    hasRecent,
    clear,
    getSnapshot,
    get size() { return sessions.size; },
  };
}

createCodexOfficialActivity.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
createCodexOfficialActivity.DEFAULT_MAX_SESSIONS = DEFAULT_MAX_SESSIONS;
createCodexOfficialActivity.DEFAULT_MAX_EXACT_MARKS = DEFAULT_MAX_EXACT_MARKS;

module.exports = createCodexOfficialActivity;
