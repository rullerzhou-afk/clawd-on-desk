"use strict";

const fs = require("fs");

const QODER_TITLE_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
]);
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 256;
const FILE_ANCHOR_BYTES = 64;
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]+/g;
const SESSION_TITLE_MAX = 80;
const CUSTOM_TITLE_MARKER = Buffer.from('"custom-title"');
const AI_TITLE_MARKER = Buffer.from('"ai-title"');

function normalizeQoderSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bare = trimmed.startsWith("qoder:") ? trimmed.slice("qoder:".length) : trimmed;
  return bare || null;
}

function normalizeQoderSessionTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  const characters = Array.from(collapsed);
  return characters.length > SESSION_TITLE_MAX
    ? `${characters.slice(0, SESSION_TITLE_MAX - 1).join("")}\u2026`
    : collapsed;
}

function createEntry(sessionId) {
  return {
    sessionId,
    filePath: null,
    device: null,
    inode: null,
    offset: 0,
    modifiedTimeMs: null,
    changedTimeMs: null,
    anchor: Buffer.alloc(0),
    partial: Buffer.alloc(0),
    discardingLongLine: false,
    aiTitle: null,
    customTitle: null,
  };
}

function effectiveTitle(entry) {
  return entry.customTitle || entry.aiTitle || null;
}

function updateAnchor(entry, bytes) {
  if (!bytes || bytes.length === 0) return;
  if (bytes.length >= FILE_ANCHOR_BYTES) {
    entry.anchor = Buffer.from(bytes.subarray(bytes.length - FILE_ANCHOR_BYTES));
    return;
  }
  const combined = entry.anchor.length
    ? Buffer.concat([entry.anchor, bytes])
    : Buffer.from(bytes);
  entry.anchor = combined.length > FILE_ANCHOR_BYTES
    ? Buffer.from(combined.subarray(combined.length - FILE_ANCHOR_BYTES))
    : combined;
}

function applyTitleLine(entry, line) {
  if (!line || line.length === 0) return;
  let candidate = line;
  if (candidate[candidate.length - 1] === 0x0d) candidate = candidate.subarray(0, candidate.length - 1);
  if (candidate.length >= 3 && candidate[0] === 0xef && candidate[1] === 0xbb && candidate[2] === 0xbf) {
    candidate = candidate.subarray(3);
  }
  if (candidate.indexOf(CUSTOM_TITLE_MARKER) < 0 && candidate.indexOf(AI_TITLE_MARKER) < 0) return;

  let record;
  try { record = JSON.parse(candidate.toString("utf8")); } catch { return; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const recordSessionId = normalizeQoderSessionId(record.sessionId);
  if (!recordSessionId || recordSessionId !== entry.sessionId) return;

  if (record.type === "custom-title") {
    const title = normalizeQoderSessionTitle(record.customTitle);
    if (title) entry.customTitle = title;
    return;
  }
  if (record.type === "ai-title") {
    const title = normalizeQoderSessionTitle(record.aiTitle);
    if (title) entry.aiTitle = title;
  }
}

function consumeChunk(entry, chunk, maxLineBytes) {
  let incoming = chunk;
  if (entry.discardingLongLine) {
    const newline = incoming.indexOf(0x0a);
    if (newline < 0) return;
    entry.discardingLongLine = false;
    incoming = incoming.subarray(newline + 1);
  }
  if (incoming.length === 0) return;

  const data = entry.partial.length
    ? Buffer.concat([entry.partial, incoming])
    : incoming;
  entry.partial = Buffer.alloc(0);

  let start = 0;
  let newline;
  while ((newline = data.indexOf(0x0a, start)) >= 0) {
    const line = data.subarray(start, newline);
    if (line.length <= maxLineBytes) applyTitleLine(entry, line);
    start = newline + 1;
  }

  const remainder = data.subarray(start);
  if (remainder.length > maxLineBytes) {
    entry.discardingLongLine = true;
    return;
  }
  if (remainder.length) entry.partial = Buffer.from(remainder);
}

function createQoderSessionTitleTracker(options = {}) {
  const fsApi = options.fs || fs;
  const chunkBytes = Number.isSafeInteger(options.chunkBytes) && options.chunkBytes > 0
    ? options.chunkBytes
    : DEFAULT_CHUNK_BYTES;
  const maxLineBytes = Number.isSafeInteger(options.maxLineBytes) && options.maxLineBytes > 0
    ? options.maxLineBytes
    : DEFAULT_MAX_LINE_BYTES;
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : DEFAULT_MAX_SESSIONS;
  const onScan = typeof options.onScan === "function" ? options.onScan : null;
  const entries = new Map();

  function touchEntry(sessionId) {
    let entry = entries.get(sessionId);
    if (!entry) entry = createEntry(sessionId);
    else entries.delete(sessionId);
    entries.set(sessionId, entry);
    while (entries.size > maxSessions) entries.delete(entries.keys().next().value);
    return entry;
  }

  function resetFileState(entry, filePath, stat) {
    entry.filePath = filePath;
    entry.device = stat.dev;
    entry.inode = stat.ino;
    entry.offset = 0;
    entry.modifiedTimeMs = stat.mtimeMs;
    entry.changedTimeMs = stat.ctimeMs;
    entry.anchor = Buffer.alloc(0);
    entry.partial = Buffer.alloc(0);
    entry.discardingLongLine = false;
  }

  function readInto(fd, buffer, position, metrics) {
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, position);
    metrics.readOps++;
    metrics.bytesRead += Math.max(0, bytesRead);
    return bytesRead;
  }

  function anchorMatches(fd, entry, metrics) {
    if (!entry.anchor.length || entry.offset < entry.anchor.length) return entry.offset === 0;
    const actual = Buffer.allocUnsafe(entry.anchor.length);
    let total = 0;
    while (total < actual.length) {
      const view = actual.subarray(total);
      const bytesRead = readInto(fd, view, entry.offset - entry.anchor.length + total, metrics);
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    return total === actual.length && actual.equals(entry.anchor);
  }

  function scan(entry, filePath, event) {
    const startedAt = Date.now();
    const metrics = {
      event,
      sessionId: entry.sessionId,
      reset: false,
      readOps: 0,
      bytesRead: 0,
      contentBytesRead: 0,
      startOffset: entry.offset,
      endOffset: entry.offset,
      fileSize: null,
      durationMs: 0,
      ok: false,
    };
    let fd;
    try {
      fd = fsApi.openSync(filePath, "r");
      const stat = fsApi.fstatSync(fd);
      if (!stat || typeof stat.isFile !== "function" || !stat.isFile() || stat.size < 0) {
        return effectiveTitle(entry);
      }
      metrics.fileSize = stat.size;

      let reset = entry.filePath !== filePath
        || entry.device !== stat.dev
        || entry.inode !== stat.ino
        || stat.size < entry.offset;
      if (!reset && entry.offset > 0 && !anchorMatches(fd, entry, metrics)) reset = true;
      if (!reset && stat.size === entry.offset && (
        entry.modifiedTimeMs !== stat.mtimeMs
        || entry.changedTimeMs !== stat.ctimeMs
      )) {
        reset = true;
      }
      if (reset) {
        resetFileState(entry, filePath, stat);
        metrics.reset = true;
      }

      metrics.startOffset = entry.offset;
      const buffer = Buffer.allocUnsafe(chunkBytes);
      let position = entry.offset;
      while (position < stat.size) {
        const length = Math.min(buffer.length, stat.size - position);
        const bytesRead = readInto(fd, buffer.subarray(0, length), position, metrics);
        if (bytesRead <= 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        consumeChunk(entry, chunk, maxLineBytes);
        updateAnchor(entry, chunk);
        position += bytesRead;
        metrics.contentBytesRead += bytesRead;
      }
      entry.offset = position;
      entry.filePath = filePath;
      entry.device = stat.dev;
      entry.inode = stat.ino;
      entry.modifiedTimeMs = stat.mtimeMs;
      entry.changedTimeMs = stat.ctimeMs;
      metrics.endOffset = position;
      metrics.ok = position === stat.size;
      return effectiveTitle(entry);
    } catch {
      return effectiveTitle(entry);
    } finally {
      if (fd !== undefined) {
        try { fsApi.closeSync(fd); } catch {}
      }
      metrics.durationMs = Math.max(0, Date.now() - startedAt);
      if (onScan) {
        try { onScan({ ...metrics }); } catch {}
      }
    }
  }

  function resolve(input = {}) {
    if (!QODER_TITLE_EVENTS.has(input.event)) return null;
    const sessionId = normalizeQoderSessionId(input.sessionId);
    if (!sessionId) return null;
    const entry = touchEntry(sessionId);
    const filePath = typeof input.transcriptPath === "string" ? input.transcriptPath.trim() : "";
    const title = filePath ? scan(entry, filePath, input.event) : effectiveTitle(entry);
    if (input.event === "SessionEnd") entries.delete(sessionId);
    return title;
  }

  function clear(sessionId = null) {
    if (sessionId === null || sessionId === undefined) {
      const count = entries.size;
      entries.clear();
      return count;
    }
    const normalized = normalizeQoderSessionId(sessionId);
    return normalized && entries.delete(normalized) ? 1 : 0;
  }

  return {
    resolve,
    clear,
    size: () => entries.size,
  };
}

module.exports = {
  QODER_TITLE_EVENTS,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  normalizeQoderSessionId,
  normalizeQoderSessionTitle,
  createQoderSessionTitleTracker,
};
