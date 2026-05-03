const fs = require("fs");
const os = require("os");
const path = require("path");

const SESSION_INDEX_READ_MAX_BYTES = 512 * 1024;

function getCodexDir() {
  const configured = process.env.CODEX_HOME;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return path.join(os.homedir(), ".codex");
}

function bareCodexSessionId(sessionId) {
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("codex:") ? trimmed.slice("codex:".length) : trimmed;
}

function normalizeThreadName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readTail(filePath, maxBytes = SESSION_INDEX_READ_MAX_BYTES) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    if (len <= 0) return "";
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readCodexThreadName(sessionId, options = {}) {
  const id = bareCodexSessionId(sessionId);
  if (!id) return null;
  const codexDir = typeof options.codexDir === "string" && options.codexDir
    ? options.codexDir
    : getCodexDir();
  const indexPath = path.join(codexDir, "session_index.jsonl");
  const content = readTail(indexPath, options.maxBytes);
  if (!content) return null;

  let latest = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || entry.id !== id) continue;
      const name = normalizeThreadName(entry.thread_name);
      if (name) latest = name;
    } catch {}
  }
  return latest;
}

module.exports = {
  bareCodexSessionId,
  readCodexThreadName,
};
