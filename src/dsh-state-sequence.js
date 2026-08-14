"use strict";

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createDshStateSequenceFence(options = {}) {
  const sessions = new Map();
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : 512;
  let clock = 0;

  function remember(key, record) {
    record.touchedAt = ++clock;
    sessions.set(key, record);
    if (sessions.size <= maxSessions) return;
    let candidate = null;
    for (const [sessionId, value] of sessions) {
      if (sessionId === key) continue;
      if (!candidate
        || (value.ended && !candidate.value.ended)
        || (value.ended === candidate.value.ended && value.touchedAt < candidate.value.touchedAt)) {
        candidate = { sessionId, value };
      }
    }
    if (candidate) sessions.delete(candidate.sessionId);
  }

  function accept({ sessionId, event, eventSeq, sessionSeq } = {}) {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!key || !key.startsWith("deepseek-harness:")) {
      return { accepted: false, reason: "invalid-session" };
    }
    if (event === "SessionStart") {
      const watermark = nonNegativeSafeInteger(sessionSeq);
      if (watermark === null) return { accepted: false, reason: "missing-session-watermark" };
      const current = sessions.get(key);
      if (current && !current.ended && current.startWatermark === watermark) {
        return { accepted: false, reason: "duplicate-start" };
      }
      if (current && !current.ended) {
        return { accepted: false, reason: "active-session-restart" };
      }
      // DSH may reopen an untouched seeded/ended session without appending an
      // event, so session.seq can legitimately equal the disposal watermark.
      // Sender FIFO plus the plugin lifetime fence contain old-lifecycle work.
      if (current && current.ended && watermark < current.endWatermark) {
        return { accepted: false, reason: "stale-session-restart" };
      }
      remember(key, {
        startWatermark: watermark,
        lastEventSeq: watermark - 1,
        endWatermark: null,
        ended: false,
      });
      return { accepted: true, reason: "start" };
    }
    if (event === "SessionEnd") {
      const watermark = nonNegativeSafeInteger(sessionSeq);
      if (watermark === null) return { accepted: false, reason: "missing-session-watermark" };
      const current = sessions.get(key) || {
        startWatermark: 0,
        lastEventSeq: -1,
        endWatermark: null,
        ended: false,
      };
      if (current.ended && watermark <= current.endWatermark) {
        return { accepted: false, reason: "duplicate-end" };
      }
      if (watermark <= current.lastEventSeq) {
        return { accepted: false, reason: "stale-end-watermark" };
      }
      current.ended = true;
      current.endWatermark = watermark;
      remember(key, current);
      return { accepted: true, reason: "end" };
    }

    const sequence = nonNegativeSafeInteger(eventSeq);
    if (sequence === null) return { accepted: false, reason: "missing-event-seq" };
    const current = sessions.get(key) || {
      startWatermark: sequence,
      lastEventSeq: sequence - 1,
      endWatermark: null,
      ended: false,
    };
    if (current.ended) return { accepted: false, reason: "session-ended" };
    if (sequence < current.startWatermark || sequence <= current.lastEventSeq) {
      return { accepted: false, reason: "stale-event" };
    }
    current.lastEventSeq = sequence;
    remember(key, current);
    return { accepted: true, reason: "event" };
  }

  function clear(sessionId) {
    if (sessionId === undefined) sessions.clear();
    else sessions.delete(sessionId);
  }

  function snapshot(sessionId) {
    const record = sessions.get(sessionId);
    if (!record) return null;
    const { touchedAt: _touchedAt, ...publicRecord } = record;
    return publicRecord;
  }

  return { accept, clear, snapshot };
}

module.exports = { createDshStateSequenceFence, nonNegativeSafeInteger };
