"use strict";

// src/roam-fence.js — validated loader for the optional roam fence file.
//
// The fence lets users limit where free roam wanders. Settings writes a JSON
// rectangle as fractions of the work area; external tools may rewrite that
// same file while the app runs.
// User-facing contract: docs/guides/roam-fence.md (keep both in sync).
//
// File: ~/.clawd/roam-area.json
// Format:
//   {
//     "enabled": true,     // boolean, required — anything else is invalid
//     "left": 0.25,        // fractions of the work area, all optional
//     "top": 0.0,          // (missing edges default to the full range)
//     "right": 0.75,
//     "bottom": 1.0
//   }
// Validation is strict: `enabled` must be a real boolean and every present
// edge a finite number with 0 <= left < right <= 1 and 0 <= top < bottom <= 1.
// Strings that would coerce through Number() are rejected.
//
// Live-update timing: roam starts refresh() when it ARMS the pause before a
// walk. Because that read is asynchronous, a save around or after arming may
// affect the pending walk if the in-flight refresh observes it; otherwise the
// cached fence remains and a later scheduled refresh retries. Wall-clock delay
// therefore has no fixed guarantee. No restart needed.
//
// Failure semantics (never fail open — PR #810 review, pass 3):
//   • before the first confirmed read      → status UNKNOWN (get() returns
//     null); roam skips its round rather than roaming the full area on a
//     fence that merely hasn't loaded yet
//   • file missing (ENOENT), no fence yet  → confirmed "no fence" immediately
//   • file missing (ENOENT), fence active  → an isolated ENOENT is treated as
//     a replace-style save in flight: the last-known-good fence is retained;
//     only a second consecutive ENOENT confirms removal and disables the fence
//   • malformed JSON / invalid schema      → keep last known good state
//     (or stay UNKNOWN before the first valid read) + one deduplicated warning
//   • transient read errors (EACCES…)      → keep last known good state
//   • not a regular file / oversized file  → treated as invalid content. The
//     production reader uses ONE non-blocking file handle (open → fstat →
//     bounded read → close), so a FIFO swapped in at any point cannot hang
//     the refresh and an oversized file cannot bypass the cap
// A partially written save therefore cannot momentarily restore full-area
// roaming; the previous fence keeps applying until a valid save lands.

const MAX_FENCE_FILE_BYTES = 64 * 1024;

const INACTIVE = Object.freeze({
  active: false,
  left: 0,
  top: 0,
  right: 1,
  bottom: 1,
});

function parseFence(raw) {
  // Windows editors (and some JSON writers) prepend a UTF-8 BOM; JSON.parse
  // rejects it, so strip a leading U+FEFF before parsing.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  if (typeof parsed.enabled !== "boolean") return null;
  const left = parsed.left === undefined ? 0 : parsed.left;
  const top = parsed.top === undefined ? 0 : parsed.top;
  const right = parsed.right === undefined ? 1 : parsed.right;
  const bottom = parsed.bottom === undefined ? 1 : parsed.bottom;
  for (const v of [left, top, right, bottom]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  if (!(left >= 0 && right <= 1 && left < right)) return null;
  if (!(top >= 0 && bottom <= 1 && top < bottom)) return null;
  if (!parsed.enabled) return { ...INACTIVE };
  return { active: true, left, top, right, bottom };
}

// deps are injectable for tests:
//   { readFile: async (path) => string, stat: async (path) => fs.Stats-like,
//     openFile: async (path, flags) => fs.promises.FileHandle-like,
//     warn: (message) => void, filePath }
// When readFile is injected without stat, the stat guard is skipped — unit
// tests feed content directly and must not hit the real filesystem.
module.exports = function createRoamFenceLoader(deps = {}) {
  const readFile = deps.readFile || null;
  const statFile = deps.stat || null;
  const fs = require("fs");
  const openFile = deps.openFile || ((...args) => fs.promises.open(...args));
  // Production reader: ONE file handle — open (non-blocking, so opening a
  // FIFO cannot hang), fstat the handle (no stat/read TOCTOU), bounded read
  // of at most MAX+1 bytes, close in finally. Injected readFile/stat or
  // openFile deps let tests exercise either path without touching real files.
  const readFenceBounded = async (p) => {
    const fh = await openFile(
      p,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        const e = new Error("not a regular file");
        e.code = "EFENCEGUARD";
        e.guardReason = "not a regular file";
        throw e;
      }
      if (st.size > MAX_FENCE_FILE_BYTES) {
        const e = new Error("file too large");
        e.code = "EFENCEGUARD";
        e.guardReason = `file larger than ${MAX_FENCE_FILE_BYTES} bytes`;
        throw e;
      }
      const buf = Buffer.alloc(MAX_FENCE_FILE_BYTES + 1);
      let total = 0;
      while (total < buf.length) {
        const { bytesRead } = await fh.read(
          buf,
          total,
          buf.length - total,
          total,
        );
        // FileHandle.read() may legally return fewer bytes than requested.
        // Only a zero-byte read confirms EOF for an unmodified regular file.
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      // Re-stat the same handle after reaching EOF. The bounded read catches
      // growth observed while reading; the second stat also catches growth
      // that landed after the EOF read but before classification.
      const finalSt = await fh.stat();
      if (total > MAX_FENCE_FILE_BYTES || finalSt.size > MAX_FENCE_FILE_BYTES) {
        const e = new Error("file too large");
        e.code = "EFENCEGUARD";
        e.guardReason = `file larger than ${MAX_FENCE_FILE_BYTES} bytes`;
        throw e;
      }
      if (finalSt.size !== st.size || finalSt.size !== total) {
        const e = new Error("file changed while being read");
        e.code = "EFENCEGUARD";
        e.guardReason = "file changed while being read";
        throw e;
      }
      return buf.toString("utf8", 0, total);
    } finally {
      await fh.close().catch(() => {});
    }
  };
  const warn = deps.warn || ((message) => console.warn(message));
  const filePath =
    deps.filePath ||
    require("path").join(require("os").homedir(), ".clawd", "roam-area.json");

  // null = UNKNOWN: nothing confirmed yet. Roam treats it as "hold this
  // round" — see pickRandomTarget() in src/roam.js.
  let state = null;
  let enoentSeenWhileActive = false;
  let lastWarnKey = null;
  let pending = null;
  let trailingRequested = false;

  function warnOnce(key, reason) {
    // Dedup: the same broken content produces exactly one warning, not one
    // per 4s roam pause. A different problem (or a fix followed by a new
    // break) warns again.
    if (lastWarnKey === key) return;
    lastWarnKey = key;
    const consequence = state
      ? state.active
        ? "keeping the previous fence"
        : "fence stays disabled"
      : "free roam stays paused until the file is fixed or removed";
    warn(`[roam-fence] ${filePath}: ${reason}; ${consequence}.`);
  }

  // One read: stat guard → read → classify. Extracted so refresh() can run a
  // trailing read when a request arrived while another read was in flight.
  async function readOnce(batch) {
    try {
      let raw;
      if (readFile) {
        // Test seam: injected content reader with an optional separate
        // stat guard (the production path guards on the open handle).
        if (statFile) {
          const st = await statFile(filePath);
          if (st && typeof st.isFile === "function" && !st.isFile()) {
            enoentSeenWhileActive = false;
            warnOnce("not-file", "not a regular file");
            return;
          }
          if (st && Number.isFinite(st.size) && st.size > MAX_FENCE_FILE_BYTES) {
            enoentSeenWhileActive = false;
            warnOnce(
              `size:${st.size}`,
              `file is ${st.size} bytes (limit ${MAX_FENCE_FILE_BYTES})`,
            );
            return;
          }
        }
        raw = await readFile(filePath);
      } else {
        raw = await readFenceBounded(filePath);
      }
      enoentSeenWhileActive = false;
      const next = parseFence(raw);
      if (next) {
        state = next;
        lastWarnKey = null;
      } else {
        warnOnce(`invalid:${raw}`, "invalid fence JSON");
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // A replace-style save (unlink + rename) can expose one ENOENT
        // between two valid reads. Never drop an active fence on the first
        // one — require a second consecutive ENOENT as confirmation.
        if (state && state.active && batch && batch.enoentVoteCast) {
          // Concurrent refresh callers share one read batch. Its trailing read
          // exists to observe a replacement that landed after the first read;
          // it must not turn the same short missing-file window into both of
          // the independent ENOENT confirmations required to disable a fence.
          return;
        }
        if (batch) batch.enoentVoteCast = true;
        if (state && state.active && !enoentSeenWhileActive) {
          enoentSeenWhileActive = true;
        } else {
          enoentSeenWhileActive = false;
          state = { ...INACTIVE };
          lastWarnKey = null;
        }
      } else if (err && err.code === "EFENCEGUARD") {
        // Guard violation from the single-handle reader: treated exactly
        // like invalid content — keep last known good, warn once per cause.
        enoentSeenWhileActive = false;
        warnOnce(`guard:${err.guardReason}`, err.guardReason);
      } else {
        // #810 round-3: any non-ENOENT outcome breaks the consecutive-ENOENT
        // streak — valid → ENOENT → EACCES → ENOENT is NOT two consecutive
        // misses and must not disable the fence. Warn (deduplicated) so a
        // persistently unreadable file is diagnosable rather than silent.
        enoentSeenWhileActive = false;
        warnOnce(
          `read-error:${(err && err.code) || "unknown"}`,
          `read failed (${(err && err.code) || err})`,
        );
      }
    }
  }

  // Async and coalesced: roam kicks this fire-and-forget when scheduling a
  // walk, then reads get() at pick time seconds later — no synchronous disk
  // I/O ever happens inside target selection.
  // #810 round-3: a request that arrives while a read is in flight marks a
  // trailing read instead of being dropped — the in-flight read may have
  // captured pre-edit content, so the LAST requester's view must win. The
  // returned promise settles only after the trailing read completes.
  function refresh() {
    if (pending) {
      trailingRequested = true;
      return pending;
    }
    pending = (async () => {
      const batch = { enoentVoteCast: false };
      try {
        do {
          trailingRequested = false;
          await readOnce(batch);
        } while (trailingRequested);
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    // null until the loader has confirmed a real status (valid file,
    // valid enabled:false, or confirmed-missing).
    get: () => state,
    refresh,
    filePath,
  };
};

module.exports.parseFence = parseFence;
