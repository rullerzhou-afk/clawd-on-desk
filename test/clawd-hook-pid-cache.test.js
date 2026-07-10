// test/clawd-hook-pid-cache.test.js — #627 cache wiring in buildStateBody
// (bounded sliding TTL §8). clawd-hook.js captures `isWin` at module load, so we
// force process.platform and re-require it to exercise both the Windows (cache)
// and non-Windows paths deterministically on any host.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const pidCache = require("../hooks/pid-cache");

const CWD = "/repo/clawd-hook-cache-test";
const DEAD_PID = 2147483646;

let seq = 0;
const usedSids = [];
function freshSid() {
  const sid = `clawd-hook-cache-${process.pid}-${seq++}`;
  usedSids.push(sid);
  return sid;
}
afterEach(() => {
  for (const sid of usedSids.splice(0)) pidCache.dropPidCache(sid, CWD);
});

// A healthy resolve() result. stablePid = this test process (guaranteed alive).
// agentPid = 4242 is a placeholder for the FRESH path (which does not
// liveness-check agentPid); cache-HIT tests write their own subset with a LIVE
// agentPid because the hit path now double-checks processAlive(agentPid).
function goodResolved(extra = {}) {
  return {
    stablePid: process.pid,
    terminalPid: process.pid,
    snapshotOk: true,
    agentPid: 4242,
    agentCommandLine: "claude --print",
    detectedEditor: "code",
    pidChain: [111, 222],
    foregroundWtHwnd: null,
    tmuxSocket: null,
    tmuxClient: null,
    ...extra,
  };
}

// A cached subset whose stablePid AND agentPid are both alive (this process),
// so the hit path's double liveness check passes.
function liveSubset(extra = {}) {
  return {
    stablePid: process.pid,
    agentPid: process.pid,
    agentCommandLine: "claude --print",
    detectedEditor: "code",
    ...extra,
  };
}

function loadClawdHook(platform) {
  const key = require.resolve("../hooks/clawd-hook.js");
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const hadRemote = process.env.CLAWD_REMOTE;
  delete process.env.CLAWD_REMOTE;
  Object.defineProperty(process, "platform", { ...origPlatform, value: platform });
  delete require.cache[key];
  const mod = require("../hooks/clawd-hook.js");
  const restore = () => {
    Object.defineProperty(process, "platform", origPlatform);
    if (hadRemote !== undefined) process.env.CLAWD_REMOTE = hadRemote;
    delete require.cache[key];
    require("../hooks/clawd-hook.js"); // put a natively-loaded instance back
  };
  return { buildStateBody: mod.buildStateBody, restore };
}

describe("buildStateBody pid cache — Windows", () => {
  let buildStateBody, restore;
  before(() => { ({ buildStateBody, restore } = loadClawdHook("win32")); });
  after(() => restore());

  it("cache miss → resolves once, writes cache, fresh body carries pid_chain", () => {
    const sid = freshSid();
    let calls = 0;
    const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1);
    assert.strictEqual(body.source_pid, process.pid);
    assert.strictEqual(body.agent_pid, 4242);
    assert.strictEqual(body.claude_pid, 4242);
    assert.strictEqual(body.headless, true);
    assert.strictEqual(body.editor, "code");
    assert.deepStrictEqual(body.pid_chain, [111, 222]);

    const cached = pidCache.readPidCache(sid, CWD);
    assert.ok(cached, "miss must populate the cache");
    assert.strictEqual(cached.stablePid, process.pid);
    assert.strictEqual(cached.agentPid, 4242);
  });

  it("cache hit → no resolve, replicates claude_pid + headless, omits pid_chain", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    let calls = 0;
    const body = buildStateBody("PostToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 0, "cache hit must not spawn a resolve");
    assert.strictEqual(body.source_pid, process.pid);
    assert.strictEqual(body.agent_pid, process.pid);
    assert.strictEqual(body.claude_pid, process.pid, "M3: backward-compat alias must be present on the cache path");
    assert.strictEqual(body.headless, true, "M3: headless derivation must run on the cache path");
    assert.strictEqual(body.editor, "code");
    assert.strictEqual(body.pid_chain, undefined, "cache-hit body must omit pid_chain (server MERGE keeps SessionStart's)");
    assert.strictEqual(body.wt_hwnd, undefined);
  });

  it("cache hit refreshes the idle TTL: touches mtime, keeps ts, no resolve (sliding TTL §8)", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    const file = pidCache.cacheFilePath(sid, CWD);
    const tsBefore = JSON.parse(fs.readFileSync(file, "utf8")).ts;
    // Age mtime toward idle expiry (but still within it) so the touch is observable.
    const aged = (Date.now() - (pidCache.IDLE_TTL_MS - 2000)) / 1000;
    fs.utimesSync(file, aged, aged);
    const mtimeAged = fs.statSync(file).mtimeMs;
    let calls = 0;
    buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 0, "hit must not resolve");
    assert.ok(fs.statSync(file).mtimeMs > mtimeAged, "hit must bump mtime = renew idle TTL");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ts, tsBefore, "hit must not change ts (absolute-cap anchor)");
  });

  it("M1: dead cached stablePid → fresh resolve, never ships the dead pid", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, { stablePid: DEAD_PID, agentPid: process.pid, agentCommandLine: "claude", detectedEditor: "code" });
    let calls = 0;
    const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1, "dead source_pid must trigger a fresh resolve");
    assert.strictEqual(body.source_pid, process.pid, "ships the fresh pid, not the dead cached one");
  });

  it("dead cached agentPid → fresh resolve (do not renew a dead session, sliding TTL §8)", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, { stablePid: process.pid, agentPid: DEAD_PID, agentCommandLine: "claude", detectedEditor: "code" });
    let calls = 0;
    const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1, "dead agentPid must trigger a fresh resolve");
    assert.strictEqual(body.source_pid, process.pid);
  });

  it("M2: degraded resolve (snapshotOk false) is not cached", () => {
    const sid = freshSid();
    const degraded = { stablePid: 999, terminalPid: null, snapshotOk: false, agentPid: null, agentCommandLine: "", detectedEditor: null, pidChain: [], foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null };
    const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => degraded);
    assert.strictEqual(body.source_pid, 999, "still reports the degraded pid for this one event");
    assert.strictEqual(body.agent_pid, undefined);
    assert.strictEqual(pidCache.readPidCache(sid, CWD), null, "a degraded snapshot must not poison the cache");
  });

  it("M2: snapshotOk true but no agentPid is not cached", () => {
    const sid = freshSid();
    const noAgent = goodResolved({ agentPid: null, agentCommandLine: "" });
    buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => noAgent);
    assert.strictEqual(pidCache.readPidCache(sid, CWD), null);
  });

  it("M2: a degraded fresh resolve does not overwrite an existing good cache", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    // UserPromptSubmit always re-resolves; feed it a degraded (snapshotOk:false) result.
    const degraded = { stablePid: 999, terminalPid: null, snapshotOk: false, agentPid: null, agentCommandLine: "", detectedEditor: null, pidChain: [], foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null };
    buildStateBody("UserPromptSubmit", { session_id: sid, cwd: CWD }, () => degraded);
    const after = pidCache.readPidCache(sid, CWD);
    assert.ok(after, "existing good cache must survive a degraded resolve");
    assert.strictEqual(after.stablePid, process.pid, "stablePid untouched");
    assert.strictEqual(after.agentPid, process.pid, "agentPid untouched");
  });

  it("cache-hit path recomputes tmux_socket from the environment", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    const saved = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/win,200,5";
    try {
      const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => goodResolved());
      assert.strictEqual(body.tmux_socket, "/tmp/tmux-1000/win");
    } finally {
      if (saved === undefined) delete process.env.TMUX;
      else process.env.TMUX = saved;
    }
  });

  it("M5: SessionEnd reads the cache, drops it, and does not resolve", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    let calls = 0;
    const body = buildStateBody("SessionEnd", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 0, "SessionEnd hit uses the cache, no spawn");
    assert.strictEqual(body.source_pid, process.pid);
    assert.strictEqual(pidCache.readPidCache(sid, CWD), null, "SessionEnd must drop the cache");
  });

  it("M5: SessionEnd on a miss resolves for the body but never writes back", () => {
    const sid = freshSid();
    let calls = 0;
    buildStateBody("SessionEnd", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1);
    assert.strictEqual(pidCache.readPidCache(sid, CWD), null, "SessionEnd must never write the cache");
  });

  it("UserPromptSubmit stays fresh: resolves, reports wt_hwnd, and refreshes the cache", () => {
    const sid = freshSid();
    let calls = 0;
    const body = buildStateBody("UserPromptSubmit", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved({ foregroundWtHwnd: "987654" }); });
    assert.strictEqual(calls, 1);
    assert.strictEqual(body.wt_hwnd, "987654");
    assert.ok(pidCache.readPidCache(sid, CWD), "UserPromptSubmit refreshes the cache");
  });

  it("caching disabled for session_id 'default' → always resolves, keeps pid_chain", () => {
    let calls = 0;
    const body = buildStateBody("PreToolUse", { session_id: "default", cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(body.pid_chain, [111, 222]);
  });
});

describe("buildStateBody pid cache — non-Windows", () => {
  let buildStateBody, restore;
  before(() => { ({ buildStateBody, restore } = loadClawdHook("linux")); });
  after(() => restore());

  it("never consults or writes the cache; always resolves with pid_chain", () => {
    const sid = freshSid();
    pidCache.writePidCache(sid, CWD, liveSubset());
    let calls = 0;
    const body = buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, () => { calls++; return goodResolved(); });
    assert.strictEqual(calls, 1, "non-Windows always resolves");
    assert.deepStrictEqual(body.pid_chain, [111, 222], "fresh path includes pid_chain");
  });
});
