"use strict";
// Clawd — TraeCode session title lock.
//
// Trae sends no session_title field and its AI-generated title lives in an
// encrypted/cloud store the hook cannot read (verified live: payloads, env
// vars, and every local store carry no title). The hook therefore derives the
// HUD title from the first user prompt — but the hook process is stateless
// (one invocation per event), so it cannot remember which sessions already
// have a title. This module gives it a cross-process, first-wins memory:
// the first UserPromptSubmit of a session claims the title and a marker file
// records it; later prompts for the same session see the marker and skip.
//
// The marker lives in the OS temp dir (same choice as pid-cache), keyed by a
// hash of (namespace, sessionId, cwd). Writes use linkSync — an atomic
// create-if-absent — so two concurrent hook invocations cannot both win.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MARKER_PREFIX = "clawd-traecode-title-";
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

let _cacheDirOverride = null;

function cacheDir() {
  return _cacheDirOverride
    || process.env.TRAECODE_TITLE_CACHE_DIR
    || os.tmpdir();
}

function markerFile(namespace, sessionId, cwd) {
  const hash = crypto
    .createHash("sha1")
    .update(namespace || "")
    .update("\0")
    .update(sessionId || "")
    .update("\0")
    .update(cwd || "")
    .digest("hex");
  return path.join(cacheDir(), `${MARKER_PREFIX}${hash}.json`);
}

function readTitle(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed.title === "string" && parsed.title ? parsed.title : null;
  } catch {
    return null;
  }
}

// Atomically claim the title for a session. Returns:
//   { claimed: true,  title }   — this call set the title
//   { claimed: false, title }   — session already titled, or nothing to claim
function claimTitle(namespace, sessionId, cwd, title) {
  const file = markerFile(namespace, sessionId, cwd);
  const existing = readTitle(file);
  if (existing) return { claimed: false, title: existing };
  if (typeof title !== "string" || !title.trim()) return { claimed: false, title: null };

  const tmpPath = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ title, at: Date.now() }), "utf8");
    fs.linkSync(tmpPath, file); // atomic create-if-absent; EEXIST on a race
    fs.unlinkSync(tmpPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    if (err && err.code === "EEXIST") return { claimed: false, title: readTitle(file) };
    return { claimed: false, title: null }; // IO failure: best-effort, send nothing
  }
  return { claimed: true, title };
}

// Best-effort cleanup of stale markers; cheap enough to run when a new session
// claims a title. Never throws — a failure just leaves stale files in tmp.
function sweepStaleMarkers() {
  try {
    const dir = cacheDir();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file);
      } catch { /* racing unlink or gone */ }
    }
  } catch { /* dir unreadable */ }
}

function __setCacheDirForTests(dir) {
  _cacheDirOverride = dir || null;
}

module.exports = {
  MARKER_PREFIX,
  claimTitle,
  sweepStaleMarkers,
  markerFile,
  __setCacheDirForTests,
};
