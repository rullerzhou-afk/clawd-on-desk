// test/helpers/hook-offline-probe.js — preload for the #681 adapter contract test.
//
// Loaded via `node --require` in front of a REAL hook script, so the assertions
// run against the shipped adapter rather than a re-implementation of it. Three
// jobs, all of which must happen before the hook's own module body runs:
//
//   1. Block HTTP, so no POST escapes the test box (same shape as
//      hook-http-blocker.js, which this deliberately does not reuse — that one
//      does not need to record anything).
//   2. RECORD every execFileSync and refuse to actually run it. Recording is the
//      real assertion: with the #681 gate working, the count is 0. Refusing to
//      run it means a broken gate fails in milliseconds instead of cold-starting
//      a real PowerShell (~270ms) per adapter × 13.
//   3. Dump the recording on exit, since the parent can only see stdout/stderr
//      and the hooks own their stdout (that contract is under test too).
//
// The parent additionally points USERPROFILE/HOME at an empty directory, so
// os.homedir() — and therefore server-config's RUNTIME_CONFIG_PATH — resolves
// somewhere with no runtime.json. That is what makes the gate fire.

const fs = require("fs");
const http = require("http");
const cp = require("child_process");
const { EventEmitter } = require("events");

// ── 1. HTTP ──────────────────────────────────────────────────────────────────
function blockedRequest(autoFail = false) {
  const req = new EventEmitter();
  const fail = () => process.nextTick(() => req.emit("error", new Error("blocked by the #681 offline probe")));
  req.end = () => { fail(); return req; };
  req.destroy = () => req;
  req.setTimeout = () => req;
  if (autoFail) fail();
  return req;
}
http.get = () => blockedRequest(true);
http.request = () => blockedRequest();

// ── 2. execFileSync ──────────────────────────────────────────────────────────
const spawns = [];
cp.execFileSync = function recordingExecFileSync(file) {
  spawns.push(String(file));
  throw Object.assign(
    new Error("#681 probe: a spawn was attempted while Clawd is offline"),
    { code: "ECLAWDPROBE" }
  );
};

// ── 3. Report ────────────────────────────────────────────────────────────────
process.on("exit", () => {
  const out = process.env.CLAWD_PROBE_OUT;
  if (!out) return;
  try { fs.writeFileSync(out, JSON.stringify(spawns), "utf8"); } catch { /* best effort */ }
});
