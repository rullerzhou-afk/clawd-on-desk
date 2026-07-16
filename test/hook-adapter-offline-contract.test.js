// test/hook-adapter-offline-contract.test.js — #681 Slice A1, adapter contract.
//
// The claim this file has to earn: tightening the SHARED resolver to return an
// unavailable shape is safe for all 13 adapters WITHOUT touching any of them.
//
// It is not enough to assert the shape in isolation. Six adapters (codex,
// copilot, cursor, kimi, kiro, codebuddy) do a bare `pidChain.length` with no
// Array.isArray guard, and two of those (cursor, codebuddy) would swallow the
// resulting TypeError in a .catch() that rewrites their gating stdout — cursor's
// {"continue":true} and codebuddy's {"decision":"allow"} would silently become
// {}. A shape-only unit test cannot see that. So each adapter is run here as its
// REAL script, in a subprocess, with:
//
//   - USERPROFILE/HOME pointed at an empty dir  → no runtime.json → gate fires
//   - CLAWD_REMOTE unset                        → the local Windows path, not remote
//   - execFileSync recorded + refused           → proves zero spawn
//   - HTTP blocked                              → the POST fails, like a real offline box
//
// and then checked for the three things that actually matter: exit code, stdout,
// and spawn count.
//
// Windows-only: the gate is a Windows-only construct. On POSIX these scripts
// resolve via ps and are expected to spawn, which is the documented contract.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOKS_DIR = path.resolve(__dirname, "..", "hooks");
const PROBE = path.resolve(__dirname, "helpers", "hook-offline-probe.js");

// Every createPidResolver consumer. Cross-checked against
// `grep -l createPidResolver hooks/*.js` — if a 14th adapter appears without a
// row here, the count assertion at the bottom fails.
//
// `stdout` is the EXACT bytes the agent must still receive while Clawd is
// offline — including the trailing newline both gating adapters append via
// writeStdoutOnce(outLine + "\n"), because that newline is part of what the
// agent parses. Empty string = this adapter gates on exit code and must stay
// silent. null = not asserted here (its own suite owns the stdout contract).
//
// `argv` matters more than it looks. clawd-hook.js and copilot-hook.js take the
// event name from process.argv[2], NOT from the stdin payload — omit it and they
// exit before resolving anything, so a "zero spawn" assertion passes for the
// wrong reason. A real-machine audit caught exactly that: copilot spawned 0
// PowerShells whether Clawd was up or down, because it was never really running.
// The vacuity guard at the bottom of this file exists to stop that recurring.
const ADAPTERS = [
  { name: "clawd-hook.js", argv: ["PreToolUse"], payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: "" },
  { name: "codex-hook.js", payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: "" },
  { name: "copilot-hook.js", argv: ["sessionStart"], payload: { hook_event_name: "sessionStart", session_id: "s-681", cwd: "D:/repo" }, stdout: "" },
  { name: "cursor-hook.js", payload: { hook_event_name: "beforeSubmitPrompt", cwd: "D:/repo" }, stdout: `${JSON.stringify({ continue: true })}\n` },
  { name: "gemini-hook.js", payload: { hook_event_name: "SessionStart", cwd: "D:/repo" }, stdout: null },
  { name: "kimi-hook.js", payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: "" },
  { name: "kiro-hook.js", payload: { hook_event_name: "preToolUse", cwd: "D:/repo" }, stdout: "" },
  { name: "codebuddy-hook.js", payload: { hook_event_name: "PreToolUse", cwd: "D:/repo" }, stdout: `${JSON.stringify({ decision: "allow" })}\n` },
  { name: "antigravity-hook.js", payload: { hook_event_name: "PreToolUse", cwd: "D:/repo" }, stdout: null },
  { name: "qoder-hook.js", payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: null },
  { name: "qoderwork-hook.js", payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: null },
  { name: "qwen-code-hook.js", payload: { hook_event_name: "PreToolUse", session_id: "s-681", cwd: "D:/repo" }, stdout: null },
  { name: "reasonix-hook.js", payload: { event: "PreToolUse", cwd: "D:/repo", toolName: "bash" }, stdout: "" },
];

let fakeHome;
let probeOut;

before(() => {
  // An empty home: server-config's RUNTIME_CONFIG_PATH resolves under it, finds
  // nothing, and the resolver gate reads "Clawd is offline". Verified upfront
  // that Node's os.homedir() honors USERPROFILE on Windows.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-681-offline-home-"));
  probeOut = path.join(fakeHome, "spawns.json");
});

after(() => {
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

// A live runtime naming THIS process, which is trivially alive. Used only by the
// vacuity guard below — every other case here wants Clawd to look gone.
const LIVE_RUNTIME = () => ({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid });

function runHookOffline(adapter, { runtimeJson } = {}) {
  const clawdDir = path.join(fakeHome, ".clawd");
  fs.rmSync(clawdDir, { recursive: true, force: true });
  if (runtimeJson !== undefined) {
    fs.mkdirSync(clawdDir, { recursive: true });
    fs.writeFileSync(path.join(clawdDir, "runtime.json"), JSON.stringify(runtimeJson), "utf8");
  }
  try { fs.unlinkSync(probeOut); } catch { /* first run */ }

  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CLAWD_PROBE_OUT: probeOut };
  delete env.CLAWD_REMOTE;

  const argv = ["--require", PROBE, path.join(HOOKS_DIR, adapter.name), ...(adapter.argv || [])];
  const result = spawnSync(process.execPath, argv, {
    input: `${JSON.stringify(adapter.payload)}\n`,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    env,
  });

  let spawns = null;
  try { spawns = JSON.parse(fs.readFileSync(probeOut, "utf8")); } catch { /* hook never exited cleanly */ }
  return { ...result, spawns };
}

describe("#681 — every adapter survives a clean offline with zero spawn", { skip: process.platform !== "win32" }, () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: no PowerShell, no crash, stdout intact`, () => {
      const r = runHookOffline(adapter);

      assert.ok(Array.isArray(r.spawns),
        `${adapter.name} did not exit cleanly enough to report — status=${r.status}, stderr=${r.stderr}`);
      assert.deepStrictEqual(r.spawns, [],
        `${adapter.name} spawned ${JSON.stringify(r.spawns)} while Clawd was offline — this is #681`);
      assert.strictEqual(r.status, 0, `${adapter.name} must exit 0; stderr=${r.stderr}`);
      assert.strictEqual(r.stderr, "", `${adapter.name} must not surface an error to the agent`);

      if (adapter.stdout !== null) {
        assert.strictEqual(r.stdout, adapter.stdout,
          `${adapter.name} stdout must be unchanged by the resolver going quiet — a TypeError on `
          + `pidChain.length would silently rewrite this to "{}"`);
      }
    });
  }

  // VACUITY GUARD. "Zero spawn" only means something if the adapter would
  // otherwise have spawned. Every row above must therefore attempt exactly one
  // spawn when Clawd looks ALIVE — if it attempts zero either way, the row is
  // decoration and the offline assertion proves nothing about it.
  //
  // This is not hypothetical: a real-machine audit found copilot-hook.js
  // reporting zero spawns online AND offline, because it takes its event from
  // argv[2] and the harness only fed it stdin. It had been passing this suite
  // without ever running.
  describe("the offline assertions are not vacuous", () => {
    for (const adapter of ADAPTERS) {
      it(`${adapter.name}: attempts exactly one spawn when Clawd is alive`, () => {
        const r = runHookOffline(adapter, { runtimeJson: LIVE_RUNTIME() });
        assert.ok(Array.isArray(r.spawns), `${adapter.name} did not report — stderr=${r.stderr}`);
        assert.strictEqual(r.spawns.length, 1,
          `${adapter.name} must attempt exactly one snapshot with a live Clawd — got `
          + `${JSON.stringify(r.spawns)}. Zero here means this adapter never runs, so its `
          + `offline case above proves nothing.`);
        assert.match(r.spawns[0], /powershell/i, "and it is the snapshot PowerShell");
      });
    }
  });

  it("covers every createPidResolver consumer in hooks/ (fails when a 14th adapter lands)", () => {
    const consumers = fs.readdirSync(HOOKS_DIR)
      .filter((f) => f.endsWith("-hook.js"))
      .filter((f) => fs.readFileSync(path.join(HOOKS_DIR, f), "utf8").includes("createPidResolver("))
      .sort();
    assert.deepStrictEqual(consumers, ADAPTERS.map((a) => a.name).sort(),
      "a new createPidResolver adapter must be added to ADAPTERS above and proven offline-safe");
    assert.strictEqual(consumers.length, 13, "the plan and AGENTS.md both say 13");
  });
});

describe("#681 — a stale runtime.json is not a live Clawd", { skip: process.platform !== "win32" }, () => {
  // Rows chosen to cover both stdout-gating adapters (where a crash would be
  // silent) plus a plain state adapter. Full coverage of the identity matrix
  // itself lives in test/server-config.test.js; this is the end-to-end proof
  // that the identity actually reaches the spawn decision inside a real hook.
  const SAMPLE = ADAPTERS.filter((a) => ["cursor-hook.js", "codebuddy-hook.js", "kiro-hook.js"].includes(a.name));
  const STALE = [
    ["a crashed instance's leftover file (dead ownerPid)",
      { app: "clawd-on-desk", port: 23333, ownerPid: 2147483646 }],
    ["a pre-#681 Clawd's file (no ownerPid at all)",
      { app: "clawd-on-desk", port: 23333 }],
    ["some other tool's runtime.json at that path",
      { app: "not-clawd", port: 23333, ownerPid: 1 }],
  ];

  for (const [label, runtimeJson] of STALE) {
    for (const adapter of SAMPLE) {
      it(`${adapter.name}: ${label} ⇒ still zero spawn`, () => {
        const r = runHookOffline(adapter, { runtimeJson });
        assert.deepStrictEqual(r.spawns, [], `${adapter.name} spawned despite ${label}`);
        assert.strictEqual(r.status, 0);
        if (adapter.stdout !== null) assert.strictEqual(r.stdout, adapter.stdout);
      });
    }
  }

  it("CLAWD_REMOTE suppresses the local walk even with a perfectly live runtime.json", () => {
    const clawdDir = path.join(fakeHome, ".clawd");
    fs.mkdirSync(clawdDir, { recursive: true });
    fs.writeFileSync(
      path.join(clawdDir, "runtime.json"),
      JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid }),
      "utf8"
    );
    try { fs.unlinkSync(probeOut); } catch { /* first run */ }

    const adapter = ADAPTERS.find((a) => a.name === "kiro-hook.js");
    const r = spawnSync(process.execPath, ["--require", PROBE, path.join(HOOKS_DIR, adapter.name)], {
      input: `${JSON.stringify(adapter.payload)}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CLAWD_PROBE_OUT: probeOut, CLAWD_REMOTE: "1" },
    });

    let spawns = null;
    try { spawns = JSON.parse(fs.readFileSync(probeOut, "utf8")); } catch { /* ignore */ }
    assert.deepStrictEqual(spawns, [], "a remote hook must never walk THIS machine's process tree");
    assert.strictEqual(r.status, 0);
  });
});
