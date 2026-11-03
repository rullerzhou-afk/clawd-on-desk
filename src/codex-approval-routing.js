"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const HEAD_LIMIT = 256 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_TOOLS = new Set(["Bash", "apply_patch"]);
const delegate = (reason) => ({ owner: "codex", reason });

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep)
    && relative !== ".." && !path.isAbsolute(relative);
}
function readHead(fd, size) {
  const chunks = [];
  let offset = 0;
  while (offset < Math.min(size, HEAD_LIMIT)) {
    const buffer = Buffer.alloc(Math.min(8192, size - offset, HEAD_LIMIT - offset));
    const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) return null;
    const newline = buffer.subarray(0, count).indexOf(10);
    if (newline !== -1) {
      chunks.push(buffer.subarray(0, newline));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    chunks.push(buffer.subarray(0, count));
    offset += count;
  }
  return null;
}

function readApprovalRecord(buffer, start, end) {
  // Codex writes the outer type before payload, within the first 128 bytes
  // (the observed maximum was byte 98).
  // Quotes inside JSON string values are escaped, so they cannot mimic a type field.
  const prefix = buffer.subarray(start, Math.min(end, start + 128)).toString("utf8");
  const type = prefix.match(/"type"\s*:\s*"([^"]+)"/);
  if (!type || (type[1] !== "turn_context" && type[1] !== "event_msg")) return null;
  return JSON.parse(buffer.subarray(start, end).toString("utf8"));
}

// The transcript is advisory evidence for shell/file approval only. MCP and
// app invocations can override the turn's reviewer; they always stay native.
// Unknown evidence delegates without deciding, so detection cannot grant access.
function resolveCodexApprovalRoute(data = {}, options = {}) {
  if (!HUMAN_TOOLS.has(data.tool_name)) return delegate("request-reviewer-unavailable");
  if (data.host || data.wsl_distro || data.wsl_sourced === true) return delegate("nonlocal");
  if (data.permission_mode !== "default") return delegate("noninteractive-or-unknown-mode");
  const session = typeof data.session_id === "string"
    ? data.session_id.replace(/^codex:/, "") : "";
  if (!UUID.test(session) || typeof data.turn_id !== "string"
    || !data.turn_id || data.turn_id.length > 128) return delegate("missing-identity");
  if (typeof data.transcript_path !== "string" || !path.isAbsolute(data.transcript_path)) {
    return delegate("missing-transcript");
  }
  let fd;
  try {
    const configuredHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    if (!path.isAbsolute(configuredHome)) return delegate("nonabsolute-codex-home");
    // Windows Codex supplies \\?\ paths. Node's JS realpath walker can
    // fail on their drive root (EISDIR on "C:"); the native API resolves the
    // same file/junction identity without weakening the containment checks.
    const home = fs.realpathSync.native(configuredHome);
    const file = fs.realpathSync.native(data.transcript_path);
    const roots = ["sessions", "archived_sessions"].flatMap((name) => {
      try { return [fs.realpathSync.native(path.join(home, name))]; } catch { return []; }
    });
    if (!roots.some((root) => inside(root, file))) return delegate("foreign-transcript");
    fd = fs.openSync(file, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return delegate("not-a-file");
    const head = readHead(fd, before.size);
    const metaId = head && head.type === "session_meta" && head.payload
      ? (head.payload.session_id || head.payload.id) : null;
    if (typeof metaId !== "string" || metaId.toLowerCase() !== session.toLowerCase()) {
      return delegate("session-mismatch");
    }
    const budget = Math.max(1, Math.min(MAX_SCAN_BYTES, options.maxScanBytes || MAX_SCAN_BYTES));
    const length = Math.min(before.size, budget);
    const start = before.size - length;
    const buffer = Buffer.alloc(length);
    let readOffset = length;
    // End of the previous block's first cut record, to be completed by the next block.
    let scanEnd = length;
    let foundContext = false;
    while (readOffset > 0 && !foundContext) {
      const count = Math.min(SCAN_CHUNK_BYTES, readOffset);
      readOffset -= count;
      if (fs.readSync(fd, buffer, readOffset, count, start + readOffset) !== count) return delegate("incomplete-read");
      // A partial final record could be a settings change, so it invalidates
      // rather than reuses older evidence.
      if (buffer[length - 1] !== 10) return delegate("partial-record");
      const first = start + readOffset ? buffer.indexOf(10, readOffset) + 1 : readOffset;
      for (let pos = first; pos < scanEnd;) {
        const end = buffer.indexOf(10, pos);
        const record = readApprovalRecord(buffer, pos, end);
        if (record && record.type === "turn_context" && record.payload && typeof record.payload === "object") {
          foundContext = true;
          break;
        }
        pos = end + 1;
      }
      scanEnd = first;
    }
    if (!length) return delegate("partial-record");
    // Ignore the first cut record; the next block can complete it during the search.
    const firstRecordOffset = start + readOffset ? buffer.indexOf(10, readOffset) + 1 : readOffset;
    if (start && firstRecordOffset === 0) return delegate("no-complete-record");
    let context = null;
    for (let pos = firstRecordOffset; pos < length;) {
      const end = buffer.indexOf(10, pos);
      const record = readApprovalRecord(buffer, pos, end);
      pos = end + 1;
      if (!record) continue;
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if (record.type === "turn_context") {
        context = payload.turn_id === data.turn_id ? payload : null;
      } else if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
        const settings = payload.thread_settings;
        // Repeated settings keep evidence only when both approval fields match.
        // Policy can be an object, so compare its contents rather than its identity.
        if (!context || !settings || typeof settings !== "object"
          || !Object.hasOwn(settings, "approvals_reviewer") || !Object.hasOwn(settings, "approval_policy")
          || settings.approvals_reviewer !== context.approvals_reviewer
          || !isDeepStrictEqual(settings.approval_policy, context.approval_policy)) {
          context = null;
        }
      } else if (context && record.type === "event_msg"
        && (payload.type === "task_complete" || payload.type === "turn_aborted"
          || (payload.type === "task_started" && payload.turn_id !== data.turn_id))) {
        context = null;
      }
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(file);
    if (before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      return delegate("transcript-changed");
    }
    if (!context || context.approvals_reviewer !== "user"
      || !["on-request", "untrusted", "on-failure"].includes(context.approval_policy)) {
      return delegate("automatic-or-unknown-reviewer");
    }
    return { owner: "clawd", reason: "current-human-reviewer" };
  } catch {
    return delegate("unreadable-transcript");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { resolveCodexApprovalRoute };
