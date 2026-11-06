"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const RECORD_TYPES = Object.freeze({
  PENDING: "pending_interaction",
  RESOLVED: "interaction_resolved",
  TURN_END: "turn_end",
  REBASELINE: "monitor_rebaseline",
  UNTRACKED: "monitor_untracked",
});
const MAX_READ_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fileIdentity(stat) {
  return stat.ino ? `${stat.dev}:${stat.ino}` : `birth:${stat.birthtimeMs}`;
}

function parseRecord(line, sessionId, cwd, earliestTimestamp) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const timestamp = typeof record?.timestamp === "number" ? record.timestamp : Date.parse(record?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < earliestTimestamp) return null;
  const payload = record.payload;
  if (!payload || typeof payload.executionId !== "string" || !payload.executionId) return null;
  const { type, executionId, toolCallId, consentRound } = payload;
  if (type === RECORD_TYPES.TURN_END) {
    if (typeof payload.stopReason !== "string" || typeof payload.boundarySource !== "string") return null;
    return { type, sessionId, executionId, stopReason: payload.stopReason, boundarySource: payload.boundarySource };
  }
  if (typeof toolCallId !== "string" || !toolCallId || !Number.isInteger(consentRound) || consentRound < 0) return null;
  const info = { type, sessionId, executionId, toolCallId, consentRound };
  if (type === RECORD_TYPES.RESOLVED) return info;
  if (type !== RECORD_TYPES.PENDING) return null;
  if (!["tool_approval", "user_input"].includes(payload.interactionType) || typeof payload.question !== "string") return null;
  return { ...info, interactionType: payload.interactionType,
    question: payload.question.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200), cwd };
}

class KiroDesktopLogMonitor {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir || path.join(os.homedir(), ".kiro", "sessions");
    this.now = options.now || Date.now;
    this.onRecord = options.onRecord || (() => {});
    this.log = options.log || (() => {});
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 5000;
    this.files = new Map();
    this.retired = new Map();
    this.timers = [];
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.firstDiscovery = true;
    this.discover();
    this.timers.push(this.setInterval(() => this.discover(), this.discoveryIntervalMs));
    this.timers.push(this.setInterval(() => this.poll(), this.pollIntervalMs));
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) this.clearInterval(timer);
    this.timers = [];
    this.files.clear();
    this.retired.clear();
  }

  emit(record) { if (this.running) this.onRecord(record); }

  listDirectories(directory) {
    try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()); }
    catch { return []; }
  }

  discover() {
    if (!this.running) return;
    const candidates = [];
    for (const bucket of this.listDirectories(this.sessionsDir)) {
      const bucketDir = path.join(this.sessionsDir, bucket.name);
      for (const session of this.listDirectories(bucketDir)) {
        const filename = path.join(bucketDir, session.name, "messages.jsonl");
        try {
          const stat = fs.statSync(filename);
          if (stat.isFile() && this.now() - stat.mtimeMs <= MAX_AGE_MS) {
            candidates.push({ filename, sessionId: session.name, stat });
          }
        } catch { /* A session may disappear during discovery. */ }
      }
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.filename.localeCompare(b.filename));
    const selected = candidates.slice(0, 64);
    const selectedPaths = new Set(selected.map(entry => entry.filename));
    for (const [filename, file] of this.files) {
      if (selectedPaths.has(filename)) continue;
      this.files.delete(filename);
      this.retired.delete(filename);
      this.retired.set(filename, file);
      if (this.retired.size > 500) this.retired.delete(this.retired.keys().next().value);
      this.emit({ type: RECORD_TYPES.UNTRACKED, sessionId: file.sessionId });
    }
    for (const candidate of selected) {
      if (this.files.has(candidate.filename)) continue;
      let file = this.retired.get(candidate.filename);
      this.retired.delete(candidate.filename);
      if (!file) {
        file = { ...candidate, identity: fileIdentity(candidate.stat), offset: 0, discarding: false };
        if (this.firstDiscovery) {
          try { this.baseline(file, candidate.stat); }
          catch (err) { this.log(`Kiro IDE session baseline failed: ${err.message}`); continue; }
        }
      }
      this.files.set(candidate.filename, file);
    }
    this.firstDiscovery = false;
  }

  baseline(file, stat) {
    // Preserve an incomplete tail so a later newline can finish it. A tail
    // larger than the line limit is discarded without retaining its bytes.
    const length = Math.min(stat.size, MAX_LINE_BYTES + 1);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file.filename, "r");
    try { fs.readSync(fd, buffer, 0, length, stat.size - length); }
    finally { fs.closeSync(fd); }
    const newline = buffer.lastIndexOf(10);
    file.offset = newline >= 0 ? stat.size - length + newline + 1 : Math.max(0, stat.size - length);
    file.discarding = newline < 0 && stat.size > MAX_LINE_BYTES;
    if (file.discarding) file.offset = stat.size;
    file.identity = fileIdentity(stat);
  }

  readWorkspace(file) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(path.dirname(file.filename), "session.json"), "utf8"));
      return typeof data.workspacePaths?.[0] === "string" ? data.workspacePaths[0] : "";
    } catch { return ""; }
  }

  poll() {
    if (!this.running) return;
    for (const file of this.files.values()) {
      try { this.readFile(file); }
      catch (err) { this.log(`Kiro IDE session read failed: ${err.message}`); }
    }
  }

  readFile(file) {
    const fd = fs.openSync(file.filename, "r");
    try {
      const stat = fs.fstatSync(fd);
      let boundaryChanged = false;
      if (file.offset > 0 && file.offset <= stat.size && !file.discarding) {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, file.offset - 1);
        boundaryChanged = byte[0] !== 10;
      }
      if (file.identity !== fileIdentity(stat) || stat.size < file.offset || boundaryChanged) {
        this.baseline(file, stat);
        this.emit({ type: RECORD_TYPES.REBASELINE, sessionId: file.sessionId });
        return;
      }
      const length = Math.min(MAX_READ_BYTES, stat.size - file.offset);
      if (!length) return;
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, file.offset);
      const cwd = this.readWorkspace(file);
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        if (!file.discarding && index - start <= MAX_LINE_BYTES) {
          const record = parseRecord(buffer.subarray(start, index).toString("utf8"), file.sessionId,
            cwd, this.startedAt - 5000);
          if (record) this.emit(record);
        }
        file.discarding = false;
        start = index + 1;
      }
      file.offset += start;
      if (file.discarding || bytesRead - start > MAX_LINE_BYTES) {
        file.discarding = true;
        file.offset += bytesRead - start;
      }
    } finally { fs.closeSync(fd); }
  }
}

module.exports = { KiroDesktopLogMonitor, RECORD_TYPES, parseRecord, fileIdentity };
