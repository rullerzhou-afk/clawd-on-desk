"use strict";

// Read the rollout head to identify Guardian review threads, which can exit
// without a terminal hook and leave a stale HUD row. Real delegated threads
// (source.subagent.thread_spawn) need their official events to keep flowing
// through updateSessionFromServer for turn fencing, parent counts, official
// terminal cleanup of those counts, and permission bubbles.
const fs = require("fs");
const { normalizeCodexThreadId } = require("./codex-thread-id");

const INTERNAL_THREAD_SOURCES = new Set(["guardian_review"]);
const HEAD_BYTES = 64 * 1024;
const UNSETTLED = Object.freeze({ settled: false, source: null });
const NO_SOURCE = Object.freeze({ settled: true, source: null });

function readCodexThreadSource(transcriptPath, expectedThreadId) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return UNSETTLED;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const newline = buf.subarray(0, bytesRead).indexOf(0x0a);
    // Allow a short, incomplete head to finish writing. Give up at the limit.
    const unparsed = bytesRead === HEAD_BYTES ? NO_SOURCE : UNSETTLED;
    if (newline === -1) return unparsed;
    let record;
    try {
      record = JSON.parse(buf.toString("utf8", 0, newline));
    } catch {
      return unparsed;
    }
    if (record?.type !== "session_meta") return NO_SOURCE;
    const expectedId = normalizeCodexThreadId(expectedThreadId);
    const rolloutId = normalizeCodexThreadId(record.payload?.id);
    if (!expectedId || expectedId !== rolloutId) return UNSETTLED;
    const source = record.payload.thread_source;
    return { settled: true, source: typeof source === "string" ? source : null };
  } catch {
    return UNSETTLED;
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
