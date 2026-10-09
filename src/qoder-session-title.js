"use strict";

// Qoder and WorkBuddy share session-scoped ai-title/custom-title JSONL records.
const {
  TITLE_EVENTS: QODER_TITLE_EVENTS,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  normalizeSessionTitle: normalizeQoderSessionTitle,
  createJsonlSessionTitleTracker,
} = require("./jsonl-session-title");

function normalizeQoderSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare = trimmed.startsWith("qoder:") ? trimmed.slice(6) : trimmed;
  return bare || null;
}

function createQoderSessionTitleTracker(options = {}) {
  return createJsonlSessionTitleTracker({ ...options, normalizeSessionId: normalizeQoderSessionId });
}

module.exports = {
  QODER_TITLE_EVENTS,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  normalizeQoderSessionId,
  normalizeQoderSessionTitle,
  createQoderSessionTitleTracker,
};
