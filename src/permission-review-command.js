"use strict";

// Optional external review command (issue #995).
//
// Clawd runs one user-configured executable when permission automation is
// about to answer `allow` by itself, hands it the request on stdin, and reads
// its exit code. The command can only DOWNGRADE that decision: exit 0 means
// "no objection to the automatic allow"; every other outcome -- a non-zero
// code, a timeout, a missing or non-executable command, an unreadable
// configuration -- ends at the normal human card. It can never turn an ask or
// a deny into an allow, rewrite the request, or grant session trust.
//
// Deliberately NOT a shell: the setting is an argv array, and argv[0] is the
// executable. Nothing here expands variables, globs or quoting. On Windows a
// `.cmd`/`.bat` shim therefore cannot run (Node would need a shell); that is
// the fail-closed direction this module documents rather than a gap it works
// around.
//
// The call is synchronous from the permission request's point of view: the
// route awaits it before the entry can reach any automatic-allow path, so a
// "late" verdict is impossible -- there is no window in which an allow is
// emitted and a review result arrives afterwards. The process itself is async
// so the Electron main thread is never blocked; only that one request waits.

const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60_000;

const MAX_COMMAND_PARTS = 32;
const MAX_COMMAND_PART_LENGTH = 4096;
const MAX_COMMAND_TOTAL_LENGTH = 16 * 1024;

// A review may print as much as it likes; only this much is retained. The note
// shown to a human is the last non-empty stdout line, further bounded below.
// 160 characters is roughly three lines in a card badge at the largest text
// scale, and short enough to stay readable in Telegram/Feishu.
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 160;

// Bounded concurrency: a burst of permission requests must not fork a review
// process per request without limit. Beyond this the request fails toward the
// human without running anything.
const MAX_CONCURRENT_REVIEWS = 4;

// The payload is the accepted request. A pathological tool input must not be
// serialized into an unbounded string handed to a child process.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const NOT_REVIEWED_TAG = "not-inspected";

// Process-global registry so the app can terminate in-flight reviews on quit.
// A gate script that is still running after Clawd exits has no reader left.
const activeReviews = new Set();

function isStringArray(value) {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}

/**
 * Normalize the configured command to a fresh argv array.
 *
 * Returns [] for "not configured" (undefined/null/empty). A non-empty value
 * that is not a bounded array of non-empty, NUL-free strings normalizes to []
 * as well: the setting is rejected at load time, which is the documented
 * "off" fallback for a malformed configuration. Never returns a shared array.
 */
function normalizePermissionReviewCommand(value) {
  if (value === undefined || value === null) return [];
  if (!isStringArray(value)) return [];
  if (value.length === 0) return [];
  if (value.length > MAX_COMMAND_PARTS) return [];
  let total = 0;
  for (const part of value) {
    if (part.length === 0) return [];
    if (part.length > MAX_COMMAND_PART_LENGTH) return [];
    if (part.includes("\0")) return [];
    total += part.length;
  }
  if (total > MAX_COMMAND_TOTAL_LENGTH) return [];
  return value.slice();
}

function normalizePermissionReviewTimeoutMs(value) {
  if (!Number.isInteger(value)) return DEFAULT_TIMEOUT_MS;
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return value;
}

// The note is display-only. Control characters are stripped so a gate script
// cannot inject terminal escapes or break the one-line card badge, and the
// value is bounded so a chatty command cannot grow the card without limit.
function sanitizeReviewNote(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NOTE_LENGTH ? cleaned.slice(0, MAX_NOTE_LENGTH) : cleaned;
}

function lastNonEmptyLine(stdout) {
  if (typeof stdout !== "string" || !stdout) return null;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const note = sanitizeReviewNote(lines[i]);
    if (note) return note;
  }
  return null;
}

/**
 * True for any stamp that does NOT explicitly allow. A missing stamp (an
 * adapter that never reviewed the request) and a malformed one both hold:
 * the direction that costs a card is the safe one.
 */
function reviewStampAllows(stamp) {
  return !!(stamp && stamp.hold === false);
}

function buildReviewPayload({ toolName, toolInput, agentId, sessionId, cwd } = {}) {
  return {
    tool: typeof toolName === "string" ? toolName : "",
    toolInput: toolInput && typeof toolInput === "object" ? toolInput : {},
    agent: typeof agentId === "string" ? agentId : "",
    sessionId: typeof sessionId === "string" ? sessionId : "",
    cwd: typeof cwd === "string" ? cwd : "",
  };
}

function terminateReviewChild(child) {
  if (!child || typeof child !== "object") return;
  const pid = typeof child.pid === "number" ? child.pid : null;
  if (process.platform === "win32") {
    // child.kill() only terminates the direct child; a gate that runs a shell
    // wrapper would leave its descendants behind. taskkill /T walks the tree.
    if (pid !== null) {
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        if (killer && typeof killer.on === "function") killer.on("error", () => {});
      } catch {}
    }
    try { child.kill(); } catch {}
    return;
  }
  // POSIX: the child was spawned detached, so it leads its own process group.
  // A negative pid signals the whole group, reaching a shell wrapper's
  // children as well.
  if (pid !== null) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

function cancelledReviewResult(reason) {
  return {
    hold: true,
    tag: "cancelled",
    exitCode: null,
    note: null,
    warning: false,
    cancelled: true,
    reason: typeof reason === "string" && reason ? reason : "cancelled",
  };
}

/**
 * Run the configured command once.
 *
 * `signal` is an AbortSignal owned by the request. When it aborts, the child
 * (and its process group) is killed and the promise settles with a `cancelled`
 * stamp; nothing waits for the timeout. This is the "discard late results once
 * the request or its authorization changes" half of the contract: the caller
 * aborts from `res.on("close")`, a DND flip, or an agent gate flip, and never
 * creates an entry from a result nobody can act on.
 *
 * Resolves, never rejects. The returned object is the stamp the permission
 * layer consumes:
 *   { hold: false, tag: "allowed", exitCode: 0, note, warning: false }
 *   { hold: true,  tag: "exit-1" | "exit-2" | "exit-<n>" | "signal" |
 *                         "timeout" | "unavailable" | "busy" | "cancelled" |
 *                         "payload-too-large", exitCode, note, warning }
 */
function runPermissionReviewCommand(options = {}) {
  const command = normalizePermissionReviewCommand(options.command);
  if (command.length === 0) {
    return Promise.resolve({
      hold: false,
      tag: "not-configured",
      exitCode: null,
      note: null,
      warning: false,
    });
  }
  const signal = options.signal || null;
  if (signal && signal.aborted === true) {
    return Promise.resolve(cancelledReviewResult(signal.reason));
  }
  if (activeReviews.size >= MAX_CONCURRENT_REVIEWS) {
    return Promise.resolve({
      hold: true,
      tag: "busy",
      exitCode: null,
      note: null,
      warning: false,
    });
  }

  const timeoutMs = normalizePermissionReviewTimeoutMs(options.timeoutMs);
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn;
  const payload = buildReviewPayload(options.payload);
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (_err) {
    return Promise.resolve({
      hold: true,
      tag: "payload-too-large",
      exitCode: null,
      note: null,
      warning: false,
    });
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    return Promise.resolve({
      hold: true,
      tag: "payload-too-large",
      exitCode: null,
      note: null,
      warning: false,
    });
  }

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let abortListener = null;
    let stdoutBytes = 0;
    let stdout = "";
    // Decode incrementally so a multi-byte character split across chunks is
    // not turned into a replacement character in the note shown to a human.
    const stdoutDecoder = new StringDecoder("utf8");

    const entry = { child: null, stop: null };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal && abortListener) {
        try { signal.removeEventListener("abort", abortListener); } catch {}
      }
      activeReviews.delete(entry);
      resolve(result);
    };

    try {
      child = spawnImpl(command[0], command.slice(1), {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // POSIX only: a process group of its own is what makes terminateReviewChild
        // able to reach a shell wrapper's children. Windows uses taskkill /T.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({
        hold: true,
        tag: "unavailable",
        exitCode: null,
        note: null,
        warning: false,
        error: err && err.message,
      });
      return;
    }

    entry.child = child;
    entry.stop = () => {
      terminateReviewChild(child);
      finish(cancelledReviewResult("app-quitting"));
    };
    activeReviews.add(entry);

    if (signal) {
      abortListener = () => {
        terminateReviewChild(child);
        finish(cancelledReviewResult(signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    // The result is bounded by MAX_STDOUT_BYTES; extra bytes are drained (so
    // the child never blocks on a full pipe) and discarded.
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes >= MAX_STDOUT_BYTES) return;
      const room = MAX_STDOUT_BYTES - stdoutBytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdoutBytes += slice.length;
      stdout += stdoutDecoder.write(slice);
    });
    // stderr is drained and discarded: it is diagnostic output for the user's
    // own script, may contain secrets, and the exit code is the whole answer.
    child.stderr.on("data", () => {});

    child.on("error", (err) => {
      // ENOENT / EACCES / EINVAL (a .cmd shim without a shell) all land here.
      finish({
        hold: true,
        tag: "unavailable",
        exitCode: null,
        note: null,
        warning: false,
        error: err && err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut || settled) return;
      stdout += stdoutDecoder.end();
      if (code === 0) {
        finish({
          hold: false,
          tag: "allowed",
          exitCode: 0,
          note: lastNonEmptyLine(stdout),
          warning: false,
        });
        return;
      }
      if (code === 1) {
        finish({
          hold: true,
          tag: "exit-1",
          exitCode: 1,
          note: lastNonEmptyLine(stdout),
          warning: false,
        });
        return;
      }
      if (code === 2) {
        finish({
          hold: true,
          tag: "exit-2",
          exitCode: 2,
          note: lastNonEmptyLine(stdout),
          warning: true,
        });
        return;
      }
      finish({
        hold: true,
        tag: typeof code === "number" ? `exit-${code}` : "signal",
        exitCode: typeof code === "number" ? code : null,
        note: lastNonEmptyLine(stdout),
        warning: false,
        signal: signal || null,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminateReviewChild(child);
      finish({
        hold: true,
        tag: "timeout",
        exitCode: null,
        note: null,
        warning: false,
      });
    }, timeoutMs);

    try {
      child.stdin.on("error", () => {});
      child.stdin.end(serialized, "utf8");
    } catch (_err) {
      // A failed write leaves the child with EOF; its exit code still decides.
    }
  });
}

/** Terminate every in-flight review (app quit). Idempotent. */
function stopActivePermissionReviews() {
  for (const entry of [...activeReviews]) {
    if (typeof entry.stop === "function") {
      entry.stop();
    } else {
      terminateReviewChild(entry.child);
    }
  }
  activeReviews.clear();
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_CONCURRENT_REVIEWS,
  MAX_STDOUT_BYTES,
  MAX_NOTE_LENGTH,
  NOT_REVIEWED_TAG,
  buildReviewPayload,
  lastNonEmptyLine,
  normalizePermissionReviewCommand,
  normalizePermissionReviewTimeoutMs,
  reviewStampAllows,
  runPermissionReviewCommand,
  sanitizeReviewNote,
  stopActivePermissionReviews,
};
