"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_PREFIX = "codex:";
const SESSION_KEY_PREFIX = "s1.";
// `codex queue --thread` accepts either a UUID or an exact saved thread name.
// Keep names bounded and free of command-line control characters while still
// allowing the Unicode, spaces, punctuation, and emoji used by real titles.
const CODEX_THREAD_NAME_MAX_LENGTH = 512;
const CODEX_THREAD_NAME_INVALID_RE = /[\u0000-\u001f\u007f\ufffd]/u;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCodexThreadId(value) {
  if (typeof value !== "string") return null;
  // Check before trimming: a control character at either edge would otherwise
  // disappear and become an apparently valid thread name.
  if (CODEX_THREAD_NAME_INVALID_RE.test(value)) return null;
  let text = normalizeString(value);
  if (text.toLowerCase().startsWith(CODEX_PREFIX)) {
    text = text.slice(CODEX_PREFIX.length).trim();
  }
  if (!text || text.length > CODEX_THREAD_NAME_MAX_LENGTH) return null;
  return CODEX_THREAD_ID_RE.test(text) ? text.toLowerCase() : text;
}

function decodeSessionKeyRawId(value) {
  const text = normalizeString(value);
  if (!text.startsWith(SESSION_KEY_PREFIX)) return null;
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== "s1" || !parts[2]) return null;
  try {
    const decoded = Buffer.from(parts[2], "base64url").toString("utf8");
    return decoded || null;
  } catch {
    return null;
  }
}

function getCodexThreadId(entry) {
  if (!entry || entry.agentId !== "codex") return null;
  if (!isCodexDesktopOriginator(entry.codexOriginator || entry.originator)) return null;

  // rawSessionId is the authoritative Codex thread identity whenever it is
  // present. Do not silently switch to a stale canonical key when metadata
  // disagrees; that could enqueue text into a different thread after a reuse.
  const rawSessionId = normalizeString(entry.rawSessionId);
  const candidates = rawSessionId
    ? [rawSessionId]
    : [normalizeString(entry.id)];
  for (const candidate of candidates) {
    // Profile-scoped keys are opaque storage ids, not queue targets. Decode
    // them before the broad thread-name validator; otherwise a key such as
    // `s1.local.<base64>` would itself look like a valid exact name.
    const decoded = decodeSessionKeyRawId(candidate);
    const decodedThread = normalizeCodexThreadId(decoded);
    if (decodedThread) return decodedThread;
    if (candidate.startsWith(SESSION_KEY_PREFIX)) continue;
    const direct = normalizeCodexThreadId(candidate);
    if (direct) return direct;
  }
  return null;
}

function isCodexQueueTarget(entry) {
  return !!getCodexThreadId(entry)
    && !!entry
    && !entry.host
    // A WSL hook can report a Codex Desktop originator while its rollout and
    // queue store live in Linux. Running the Windows queue CLI here would
    // acknowledge success against the wrong store, so keep WSL on clipboard
    // fallback until a remote queue transport exists.
    && !normalizeString(entry.wslDistro)
    && String(entry.platform || "").trim().toLowerCase() !== "wsl"
    && entry.platform !== "webui"
    && entry.headless !== true
    && entry.hiddenFromHud !== true
    && entry.state !== "sleeping";
}

module.exports = {
  CODEX_THREAD_ID_RE,
  decodeSessionKeyRawId,
  getCodexThreadId,
  isCodexQueueTarget,
  normalizeCodexThreadId,
};
