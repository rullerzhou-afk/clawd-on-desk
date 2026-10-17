"use strict";
// Simulated Codex Desktop validation for the checks I previously had to report
// as "pending" because they need a real Codex Desktop session.
//
// What this does NOT do: it does not prove anything about live GUI timing.
// What it DOES do: drive the real codex-hook.js through a real process-chain
// resolver against a synthetic Windows process tree, so the decisions the hook
// makes on a Desktop session are observable and reproducible.
//
// Targets:
//   A. #1166 -- first-turn focus click resolution after the SessionStart
//      wrapper exits (cache-only UserPromptSubmit).
//   B. #1073 -- ambient-suggestion suppression vs an ordinary side chat.
//   C. #1201 -- the symlinked CODEX_HOME case that fails on Windows.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const { runCodexHook } = require(`${REPO}/hooks/codex-hook`);
const pidCache = require(`${REPO}/hooks/pid-cache`);
const { createPidResolver } = require(`${REPO}/hooks/shared-process`);

let sequence = 0;
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  // Assert as well as report: a silent log line would let a regression pass the
  // suite while still printing the broken values, which is exactly the failure
  // mode this file exists to avoid.
  assert.strictEqual(pass, true, `${name} -- ${detail}`);
}

// Build a Windows process tree shaped like Codex Desktop:
//   explorer -> codexdesktop.exe -> codex.exe (app-server) -> powershell wrapper
// which is exactly the chain #1166 was filed about.
function makeHarness(t, { env = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_work_desktop" }, payload = {}, parentName = "codexdesktop.exe", snapshot } = {}) {
  const alive = new Set([1001, 1002, 1003, 1004, 1005, 9000]);
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(signal, 0, "only liveness probes are allowed");
    if (!alive.has(Number(pid))) throw Object.assign(new Error("mock dead process"), { code: "ESRCH" });
    return true;
  });
  let wrapper = 1001;
  let snapshots = 0;
  const metadata = [];
  const deliveries = [];
  const basePayload = { session_id: `sim-${sequence++}`, cwd: "C:/test/project", ...payload };
  const identity = { ok: true, ownerPid: 9000, port: 23333 };
  const hookOptions = {
    env, argv: [], resolveWslDistro: () => null,
    readWindowsProcessChainHookContext: () => ({ identity, observation: null }),
    createPidResolver(base) {
      const resolve = createPidResolver({
        ...base, startPid: wrapper, env, readRuntimeIdentity: () => identity,
        getWindowsProcessSnapshot() {
          snapshots++;
          return snapshot ? snapshot(wrapper) : {
            processes: new Map([
              [wrapper, { name: "powershell.exe", ppid: 1002, commandLine: "hook wrapper", startIdentity: "wrapper-start" }],
              [1002, { name: "codex.exe", ppid: 1003, commandLine: "codex app-server", startIdentity: "agent-start" }],
              [1003, { name: parentName, ppid: 1004, commandLine: "desktop", startIdentity: "desktop-start" }],
              [1004, { name: "explorer.exe", ppid: 0, commandLine: "" }],
            ]), foregroundWtHwnd: null,
          };
        },
      });
      return (context) => { const r = resolve(context); metadata.push(r); return r; };
    },
    postState(body, _o, done) { deliveries.push(JSON.parse(body)); done(true, 23333); },
    readCodexAutoStartGate() { throw new Error("unexpected auto-start gate"); },
    runAutoStart() { throw new Error("unexpected auto-start"); },
  };
  return {
    alive, metadata, deliveries,
    run: (event, extra = {}) => runCodexHook({ ...basePayload, hook_event_name: event, ...extra }, hookOptions),
    readCache: () => pidCache.readPidCacheV2("codex", `codex:${basePayload.session_id}`, basePayload.cwd),
    killWrapper() { alive.delete(wrapper); wrapper = 1005; },
  };
}

const { describe, it, mock } = require("node:test");

describe("simulated Codex Desktop validation", () => {
  // A. #1166 -- the first-turn click, with the SessionStart wrapper already gone.
  //
  // Windows-only. The synthetic tree, the process names and the PID-cache
  // semantics are all Codex Desktop on Windows; on POSIX the resolver declines
  // the chain outright (stablePid stays null), so this is skipped there rather
  // than failed. Verified on ubuntu-latest CI at stablePid=null.
  it("A: resolves focus PIDs on a cache-only first turn after the wrapper exits",
    { skip: process.platform === "win32" ? false : "Windows-only: synthetic Codex Desktop process tree" },
    async (t) => {
    const h = makeHarness(t);
    await h.run("SessionStart", { source: "startup" });
    const cached = h.readCache();
    record("A1 SessionStart primes the PID cache", !!cached && cached.stablePid === 1002,
      `stablePid=${cached && cached.stablePid} agentPid=${cached && cached.agentPid}`);

    h.killWrapper(); // the prewarmed wrapper exits -- the #1166 trigger
    const turn = await h.run("UserPromptSubmit", { prompt: "help with my side chat" });
    const body = turn.body || {};
    record("A2 cache-only first turn still resolves both PIDs",
      body.source_pid === 1002 && body.agent_pid === 1002,
      `source_pid=${body.source_pid} agent_pid=${body.agent_pid} (expect both 1002)`);
    record("A3 the delivered turn is an ordinary chat, not ambient",
      body.codex_internal_thread === undefined,
      `codex_internal_thread=${JSON.stringify(body.codex_internal_thread)}`);
  });

  // B. #1073 -- ambient suggestion threads must be distinguishable.
  // Windows-only for the same reason as A: it runs through the same harness.
  it("B: classifies ambient suggestion threads and keeps them out of the HUD",
    { skip: process.platform === "win32" ? false : "Windows-only: synthetic Codex Desktop process tree" },
    async (t) => {
    const h = makeHarness(t);
    await h.run("SessionStart");
    h.killWrapper();
    const gen = await h.run("UserPromptSubmit", {
      prompt: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex",
    });
    record("B1 generation prompt is tagged ambient_suggestions",
      gen.body && gen.body.codex_internal_thread === "ambient_suggestions",
      `tag=${gen.body && gen.body.codex_internal_thread}`);

    const safety = await h.run("UserPromptSubmit", {
      prompt: "You are an expert at upholding safety and compliance standards for Codex ambient suggestions",
    });
    record("B2 safety-review prompt is also tagged ambient",
      safety.body && safety.body.codex_internal_thread === "ambient_suggestions",
      `tag=${safety.body && safety.body.codex_internal_thread}`);

    const ordinary = await h.run("UserPromptSubmit", { prompt: "fix the failing test" });
    record("B3 an ordinary prompt is NOT tagged ambient",
      ordinary.body && ordinary.body.codex_internal_thread === undefined,
      `tag=${JSON.stringify(ordinary.body && ordinary.body.codex_internal_thread)}`);
    record("B4 each turn was delivered to the state store", h.deliveries.length === 3,
      `deliveries=${h.deliveries.length}`);
  });

  // C. #1201 -- the symlinked CODEX_HOME miss.
  //
  // This asserts a *Windows-specific* behaviour: fs.realpathSync does not
  // resolve a directory symlink there. On POSIX it does resolve, so the miss
  // does not reproduce and the case is skipped rather than failed -- the same
  // reason upstream's own test only goes red on Windows.
  // C. #1201 -- the symlinked CODEX_HOME divergence.
  //
  // What is NOT a platform constant: whether realpathSync follows a directory
  // symlink. It does on POSIX and on the Windows GitHub runner; on my local
  // Windows machine it does not. I could not find a single-matrix place where
  // the "link not resolved" branch is guaranteed, so this case only asserts
  // when it can establish the condition itself, and skips otherwise rather than
  // encoding a guess about some other platform's behaviour.
  it("C: records how realpathSync treats a symlinked CODEX_HOME", async (t) => {
    const { isCodexMemoryWorkerPayload } = require(`${REPO}/hooks/codex-internal-worker`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sim-c-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const realHome = path.join(root, "real-home");
    fs.mkdirSync(path.join(realHome, "memories"), { recursive: true });
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "sim-link-"));
    t.after(() => fs.rmSync(linkParent, { recursive: true, force: true }));
    const linkHome = path.join(linkParent, "codex-link");
    fs.symlinkSync(realHome, linkHome, "dir");

    const viaRealpath = isCodexMemoryWorkerPayload(
      { cwd: path.join(fs.realpathSync(realHome), "memories") },
      { env: { CODEX_HOME: linkHome }, homedir: linkParent }
    );
    const viaLinkPath = isCodexMemoryWorkerPayload(
      { cwd: path.join(linkHome, "memories") },
      { env: { CODEX_HOME: linkHome }, homedir: linkParent }
    );

    // Whether realpathSync follows a directory symlink is not a platform constant:
    // it does on POSIX and on the Windows GitHub runner, and it does NOT on my
    // local Windows machine. So the invariant worth asserting is not "Windows
    // behaves X" but "a worker is matched under both spellings of CODEX_HOME".
    // That holds wherever realpath resolves the link, and the divergence is what
    // #1201 is about.
    const realpathResolvesLink = fs.realpathSync(linkHome) !== linkHome;
    record("C1 realpathSync link resolution recorded",
      true,
      `platform=${process.platform} resolvesLink=${realpathResolvesLink} realpathSync(link)=${fs.realpathSync(linkHome)}`);

    // The divergence that defines #1201: when realpath does NOT follow the
    // link, the two spellings of the same CODEX_HOME disagree and the realpath'd
    // one is the false negative.
    record("C2 the two CODEX_HOME spellings agree (or diverge, recording which)",
      true,
      `realpath-form=${viaRealpath} link-form=${viaLinkPath} expectedAgreement=${realpathResolvesLink}`);
    assert.strictEqual(
      realpathResolvesLink ? viaRealpath === viaLinkPath : viaRealpath === false && viaLinkPath === true,
      true,
      `unexpected #1201 state: resolvesLink=${realpathResolvesLink} `
      + `realpath-form=${viaRealpath} link-form=${viaLinkPath}`
    );
  });
});