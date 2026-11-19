"use strict";

// Codex hook payloads carry no thread source, but every rollout's first line
// (session_meta) does. Background threads (Guardian review, subagents) write
// rollouts with a non-user thread_source; when such a thread exits without
// Stop/Interrupt/SessionEnd its UserPromptSubmit-created HUD row lingers and
// pollutes the active-state computation. Classify from the rollout head so
// those rows can be retired like other internal threads. User-visible side
// chats keep thread_source "user" (or an unknown/missing head) and are never
// suppressed.
const fs = require("fs");

const INTERNAL_THREAD_SOURCES = new Set(["guardian_review", "subagent"]);
const HEAD_BYTES = 64 * 1024;

function readCodexThreadSource(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const record = JSON.parse(line);
    if (record && record.type === "session_meta" && record.payload
      && typeof record.payload.thread_source === "string") {
      return record.payload.thread_source;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function isInternalCodexThreadSource(source) {
  return INTERNAL_THREAD_SOURCES.has(source);
}

module.exports = {
  INTERNAL_THREAD_SOURCES,
  readCodexThreadSource,
  isInternalCodexThreadSource,
};