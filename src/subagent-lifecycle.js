"use strict";

const MAX_CHILD_ID_LENGTH = 256;

function normalizeChildId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CHILD_ID_LENGTH || /[\0\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function collectConfirmedIds(value) {
  const ids = new Set();
  const source = value instanceof Set
    ? value
    : (Array.isArray(value) ? value : []);
  for (const candidate of source) {
    const id = normalizeChildId(candidate);
    if (id) ids.add(id);
  }
  return ids;
}

function cloneSubagentTracker(sessionOrTracker) {
  const raw = sessionOrTracker && sessionOrTracker.subagentTracker
    ? sessionOrTracker.subagentTracker
    : sessionOrTracker;
  return {
    confirmedIds: collectConfirmedIds(raw && raw.confirmedIds),
    legacyFloor: !!(raw && raw.legacyFloor === true),
    recoveredFloor: !!(raw && raw.recoveredFloor === true),
  };
}

function clearSubagentTracker(tracker) {
  tracker.confirmedIds.clear();
  tracker.legacyFloor = false;
  tracker.recoveredFloor = false;
  return tracker;
}

function getSubagentVisualCount(sessionOrTracker) {
  const tracker = cloneSubagentTracker(sessionOrTracker);
  return Math.max(
    tracker.confirmedIds.size,
    tracker.legacyFloor ? 1 : 0,
    tracker.recoveredFloor ? 1 : 0,
  );
}

function hasConfirmedSubagents(sessionOrTracker) {
  const raw = sessionOrTracker && sessionOrTracker.subagentTracker
    ? sessionOrTracker.subagentTracker
    : sessionOrTracker;
  return !!(raw && raw.confirmedIds instanceof Set && raw.confirmedIds.size > 0);
}

function hasSubagentHoldEvidence(sessionOrTracker) {
  const raw = sessionOrTracker && sessionOrTracker.subagentTracker
    ? sessionOrTracker.subagentTracker
    : sessionOrTracker;
  return !!(
    raw
    && (
      (raw.confirmedIds instanceof Set && raw.confirmedIds.size > 0)
      || raw.legacyFloor === true
    )
  );
}

module.exports = {
  MAX_CHILD_ID_LENGTH,
  clearSubagentTracker,
  cloneSubagentTracker,
  getSubagentVisualCount,
  hasConfirmedSubagents,
  hasSubagentHoldEvidence,
  normalizeChildId,
};
