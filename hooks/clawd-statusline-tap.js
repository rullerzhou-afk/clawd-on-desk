#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code statusLine stdin tap
//
// Claude Code (v2.1.80+) invokes the configured statusLine command on every
// prompt (~300ms) and pipes a JSON status object to its stdin. That object
// carries `rate_limits` — the live subscriber usage Clawd's usage gauge needs.
// By tapping that stream we get Claude usage with ZERO calls to the
// per-access-token usage API (which 429s, stickily, after ~5 polls). This is
// the primary usage source; the API poll in src/usage-gauge-runtime.js is only
// a fallback for users who don't run Claude Code.
//
// Responsibilities:
//   1. Read the full stdin JSON.
//   2. Extract ONLY rate_limits.five_hour / seven_day (used_percentage +
//      resets_at). Everything else on stdin (session_id, cwd, transcript_path,
//      …) is sensitive and is dropped.
//   3. Atomically write ~/.clawd/statusline.json (mode 0600) in the claude-hud
//      external-usage snapshot shape: { updated_at, five_hour, seven_day }.
//   4. Throttle writes to once per ~30s (the stream fires ~3x/second).
//   5. Stay a transparent proxy for any existing statusLine: with
//      `--chain "<cmd>"`, pipe the original stdin to <cmd> and pass its stdout
//      straight through, so we never break claude-hud or a user's statusline.
//
// Node built-ins only (hook-script constraint). No same-dir helpers required.

const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const WRITE_THROTTLE_MS = 30 * 1000;
const STDIN_TIMEOUT_MS = 1500;
const MAX_STDIN_BYTES = 4 * 1024 * 1024; // guard against an unbounded pipe

function defaultSnapshotPath() {
  return path.join(os.homedir(), ".clawd", "statusline.json");
}

// Parse the --chain "<command>" argument (the original statusLine command to
// proxy). Returns the command string or null. Accepts `--chain X`, `--chain=X`.
function parseChainArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chain") return typeof args[i + 1] === "string" ? args[i + 1] : null;
    if (typeof a === "string" && a.startsWith("--chain=")) return a.slice("--chain=".length);
  }
  return null;
}

// Pull a single { used_percentage, resets_at } window out of a rate_limits
// entry. Returns null unless used_percentage is a finite number — the snapshot
// reader treats a window with only resets_at as malformed.
function extractWindow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pct = Number(entry.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const out = { used_percentage: pct };
  if (entry.resets_at != null) out.resets_at = entry.resets_at;
  return out;
}

// Build the snapshot object from a parsed stdin payload, or null if there are
// no usable rate_limits. ONLY rate_limits are read; the rest of stdin is
// discarded so no session_id / cwd / transcript_path can leak to disk.
function buildSnapshot(stdinObj, nowMs) {
  if (!stdinObj || typeof stdinObj !== "object") return null;
  const rl = stdinObj.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const fiveHour = extractWindow(rl.five_hour);
  const sevenDay = extractWindow(rl.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const snapshot = { updated_at: new Date(nowMs).toISOString() };
  if (fiveHour) snapshot.five_hour = fiveHour;
  if (sevenDay) snapshot.seven_day = sevenDay;
  return snapshot;
}

// True if the existing snapshot was written within WRITE_THROTTLE_MS of now.
// CC fires the statusLine ~3x/second; without this we'd rewrite the file
// hundreds of times a minute. Throttle off the snapshot's own updated_at so it
// survives across process invocations (each tap call is a fresh process).
function isThrottled(snapshotPath, nowMs, throttleMs, readFileSync) {
  try {
    const raw = readFileSync(snapshotPath, "utf8");
    const parsed = JSON.parse(raw);
    const prev = Date.parse(parsed && parsed.updated_at);
    if (!Number.isFinite(prev)) return false;
    return nowMs - prev < throttleMs;
  } catch {
    return false;
  }
}

function writeSnapshotAtomic(snapshotPath, snapshot, deps = {}) {
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  const dir = path.dirname(snapshotPath);
  const base = path.basename(snapshotPath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  try {
    writeFileSync(tmpPath, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, snapshotPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// Core, fully injectable for tests: given the raw stdin text, decide whether to
// write the snapshot (respecting the throttle) and do so. Returns a small
// status object describing what happened. Never throws.
function processStdin(rawText, deps = {}) {
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const snapshotPath = deps.snapshotPath || defaultSnapshotPath();
  const throttleMs = Number.isFinite(deps.throttleMs) ? deps.throttleMs : WRITE_THROTTLE_MS;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { wrote: false, reason: "unparseable" };
  }
  const snapshot = buildSnapshot(parsed, nowMs);
  if (!snapshot) return { wrote: false, reason: "no-rate-limits" };
  if (isThrottled(snapshotPath, nowMs, throttleMs, readFileSync)) {
    return { wrote: false, reason: "throttled", snapshot };
  }
  try {
    writeSnapshotAtomic(snapshotPath, snapshot, deps);
  } catch (err) {
    return { wrote: false, reason: "write-failed", error: err && err.message, snapshot };
  }
  return { wrote: true, snapshot };
}

// Read stdin to completion (or timeout) without blocking forever. Caps the
// buffered size so a hostile/huge pipe can't exhaust memory.
function readStdin(maxBytes, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("error", finish);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Keep what we have; the parser will likely fail and we no-op safely.
        finish();
        return;
      }
      chunks.push(chunk);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.on("data", onData);
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
    } catch {
      finish();
    }
  });
}

// Transparent proxy: feed `rawText` to the chained command's stdin and copy its
// stdout to ours. On any failure we still exit cleanly (CC just renders a blank
// statusline) rather than breaking the user's prompt.
function runChain(chainCommand, rawText, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(chainCommand, {
        shell: true,
        stdio: ["pipe", "inherit", "inherit"],
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    try {
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.write(rawText);
        child.stdin.end();
      }
    } catch {
      resolve();
    }
  });
}

async function main(argv) {
  const rawText = await readStdin(MAX_STDIN_BYTES, STDIN_TIMEOUT_MS);
  // Tap first (writing the snapshot is the whole point), then proxy. A bad
  // snapshot write must never block the chained statusline from rendering.
  try {
    processStdin(rawText, {});
  } catch {}
  const chainCommand = parseChainArg(argv);
  if (chainCommand) {
    await runChain(chainCommand, rawText, {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    () => process.exit(0)
  );
}

module.exports = {
  WRITE_THROTTLE_MS,
  defaultSnapshotPath,
  parseChainArg,
  extractWindow,
  buildSnapshot,
  isThrottled,
  writeSnapshotAtomic,
  processStdin,
  readStdin,
  runChain,
};
