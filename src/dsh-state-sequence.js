"use strict";

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The fence is upstream-protocol scoped. DSH session ids are only unique
// within one upstream profile, so a remote session gets its own namespace and
// its own capacity. A local session keeps the exact key and capacity it had
// before remote support existed.
function createDshStateSequenceFence(options = {}) {
  const localSessions = new Map();
  const remoteSessions = new Map();
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : 512;
  let clock = 0;

  function remember(sessions, key, record) {
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

  function remoteProfileId(remoteProfile) {
    if (remoteProfile === undefined || remoteProfile === null) return null;
    const value = remoteProfile.profileId;
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function accept({ sessionId, event, eventSeq, sessionSeq, remoteProfile } = {}) {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!key || !key.startsWith("deepseek-harness:")) {
      return { accepted: false, reason: "invalid-session" };
    }
    const profileId = remoteProfileId(remoteProfile);
    if (profileId === "") return { accepted: false, reason: "invalid-session" };
    const remote = profileId !== null;
    const sessions = remote ? remoteSessions : localSessions;
    // The remote namespace keeps the raw DSH id intact after a profile prefix,
    // matching the local key prefix while remaining disjoint.
    const fenceKey = remote ? `${profileId}:${key}` : key;
    if (event === "SessionStart") {
      const watermark = nonNegativeSafeInteger(sessionSeq);
      if (watermark === null) return { accepted: false, reason: "missing-session-watermark" };
      const current = sessions.get(fenceKey);
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
      remember(sessions, fenceKey, {
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
      const current = sessions.get(fenceKey) || {
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
      remember(sessions, fenceKey, current);
      return { accepted: true, reason: "end" };
    }

    const sequence = nonNegativeSafeInteger(eventSeq);
    if (sequence === null) return { accepted: false, reason: "missing-event-seq" };
    const current = sessions.get(fenceKey) || {
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
    remember(sessions, fenceKey, current);
    return { accepted: true, reason: "event" };
  }

  function clear(sessionId, remoteProfile) {
    const profileId = remoteProfileId(remoteProfile);
    const sessions = profileId === null ? localSessions : remoteSessions;
    if (sessionId === undefined) sessions.clear();
    else if (profileId === null) sessions.delete(sessionId);
    else sessions.delete(`${profileId}:${sessionId}`);
  }

  function snapshot(sessionId, remoteProfile) {
    const profileId = remoteProfileId(remoteProfile);
    const sessions = profileId === null ? localSessions : remoteSessions;
    const key = profileId === null ? sessionId : `${profileId}:${sessionId}`;
    const record = sessions.get(key);
    if (!record) return null;
    const { touchedAt: _touchedAt, ...publicRecord } = record;
    return publicRecord;
  }

  return { accept, clear, snapshot };
}

module.exports = { createDshStateSequenceFence, nonNegativeSafeInteger };
