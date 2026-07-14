// test/clawd-hook-pid-cache.test.js — #634: the Claude adapter side of the
// shared-resolver migration.
//
// Two layers:
//  1. Adapter mapping — buildStateBody maps event→lifecycle, declares the cache
//     identity (namespace/sessionId/cacheCwd/cacheable), bypasses on remote, and
//     applies whatever metadata the resolver returns. A context-capturing fake
//     resolver pins the mapping without exercising the cache.
//  2. End-to-end Claude regression — buildStateBody wired to the REAL shared
//     resolver (mock-loaded shared-process for a counting execFileSync + forced
//     platform, real pid-cache on real temp files). This nails the §3.5 zero-
//     spawn guarantees through the actual integration, not a stand-in.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pidCache = require("../hooks/pid-cache");

const NS = "claude-code";
const CWD = "/repo/clawd-hook-cache-test";
const DEAD_PID = 2147483646;

// Isolate the cache directory (#634): the end-to-end SessionStart tests drive the
// real resolver, which sweeps the shared os.tmpdir() unless redirected. See
// pid-cache.js cacheDir(). The resolver reaches pid-cache through this same
// module object, so the override covers both layers.
let ISO_DIR;
before(() => {
  ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-cache-iso-"));
  pidCache.__setCacheDirForTests(ISO_DIR);
});
after(() => {
  pidCache.__setCacheDirForTests(null);
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
});

let seq = 0;
const usedV1 = [];
const usedV2 = [];
function freshSid() { const s = `clawd-hook-cache-${process.pid}-${seq++}`; usedV1.push(s); usedV2.push(s); return s; }
afterEach(() => {
  for (const s of usedV1.splice(0)) pidCache.dropPidCache(s, CWD);
  for (const s of usedV2.splice(0)) pidCache.dropPidCacheV2(NS, s, CWD);
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1 — adapter mapping (context-capturing fake resolver)
// ═══════════════════════════════════════════════════════════════════════════
describe("buildStateBody adapter → shared resolver context (#634)", () => {
  const { buildStateBody } = require("../hooks/clawd-hook.js");

  // Captures every resolver context and returns a preset metadata object.
  function capture(returns = emptyMeta()) {
    const calls = [];
    const fn = (ctx) => { calls.push(ctx); return returns; };
    fn.calls = calls;
    return fn;
  }
  function emptyMeta() {
    return { stablePid: null, terminalPid: null, snapshotOk: false, agentPid: null, agentCommandLine: "", detectedEditor: null, pidChain: [], foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null, cacheSource: "none" };
  }

  it("maps SessionStart→start, UserPromptSubmit→prompt, SessionEnd→end, everything else→event", () => {
    for (const [event, lifecycle] of [
      ["SessionStart", "start"],
      ["UserPromptSubmit", "prompt"],
      ["SessionEnd", "end"],
      ["PreToolUse", "event"],
      ["PostToolUse", "event"],
      ["Stop", "event"],
      ["Notification", "event"],
      ["SubagentStop", "event"],
    ]) {
      const r = capture();
      buildStateBody(event, { session_id: "s", cwd: CWD }, r);
      assert.strictEqual(r.calls.length, 1, `${event} calls the resolver once`);
      assert.strictEqual(r.calls[0].lifecycle, lifecycle, `${event} → ${lifecycle}`);
    }
  });

  it("Stop maps to event, NOT end (turn completion must not drop the cache)", () => {
    const r = capture();
    buildStateBody("Stop", { session_id: "s", cwd: CWD }, r);
    assert.strictEqual(r.calls[0].lifecycle, "event");
    assert.notStrictEqual(r.calls[0].lifecycle, "end");
  });

  it("declares namespace=claude-code and cacheCwd=payload.cwd", () => {
    const r = capture();
    buildStateBody("PreToolUse", { session_id: "s", cwd: "/some/where" }, r);
    assert.strictEqual(r.calls[0].namespace, "claude-code");
    assert.strictEqual(r.calls[0].cacheCwd, "/some/where");
    assert.strictEqual(r.calls[0].sessionId, "s");
  });

  it("cacheable is true only for a real session id AND a non-empty cwd", () => {
    const real = capture();
    buildStateBody("PreToolUse", { session_id: "sid", cwd: CWD }, real);
    assert.strictEqual(real.calls[0].cacheable, true);

    const def = capture();
    buildStateBody("PreToolUse", { session_id: "default", cwd: CWD }, def);
    assert.strictEqual(def.calls[0].cacheable, false, "session_id 'default' (#583) is non-cacheable");

    const noCwd = capture();
    buildStateBody("PreToolUse", { session_id: "sid" }, noCwd);
    assert.strictEqual(noCwd.calls[0].cacheable, false, "empty cwd is non-cacheable");

    const missingSid = capture();
    buildStateBody("PreToolUse", { cwd: CWD }, missingSid);
    assert.strictEqual(missingSid.calls[0].sessionId, "default", "missing session_id falls back to 'default'");
    assert.strictEqual(missingSid.calls[0].cacheable, false);
  });

  it("remote mode (CLAWD_REMOTE) bypasses the resolver entirely (zero context calls)", () => {
    const hadRemote = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    try {
      const r = capture();
      const body = buildStateBody("PreToolUse", { session_id: "s", cwd: CWD }, r);
      assert.strictEqual(r.calls.length, 0, "remote must not call the resolver context");
      assert.ok(!("source_pid" in body), "remote body carries no local pid");
      assert.strictEqual(typeof body.host, "string");
    } finally {
      if (hadRemote === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = hadRemote;
    }
  });

  it("applies a hit's stable subset (source_pid/agent_pid/headless/editor), omitting pid_chain", () => {
    const hit = { stablePid: 4242, terminalPid: null, snapshotOk: true, agentPid: 4242, agentCommandLine: "node claude-code --print", detectedEditor: "code", pidChain: [], foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null, cacheSource: "v2" };
    const body = buildStateBody("PostToolUse", { session_id: "s", cwd: CWD }, capture(hit));
    assert.strictEqual(body.source_pid, 4242);
    assert.strictEqual(body.agent_pid, 4242);
    assert.strictEqual(body.claude_pid, 4242, "backward-compat alias");
    assert.strictEqual(body.headless, true);
    assert.strictEqual(body.editor, "code");
    assert.ok(!("pid_chain" in body), "a hit omits pid_chain (server MERGE keeps the SessionStart one)");
  });

  it("empty metadata (prompt/end miss) applies NO pid fields — never a degraded process.ppid", () => {
    const body = buildStateBody("UserPromptSubmit", { session_id: "s", cwd: CWD }, capture(emptyMeta()));
    assert.ok(!("source_pid" in body));
    assert.ok(!("agent_pid" in body));
    assert.ok(!("claude_pid" in body));
    assert.ok(!("editor" in body));
    assert.ok(!("pid_chain" in body));
    assert.ok(!("wt_hwnd" in body));
  });

  it("applies wt_hwnd on a foreground-safe start, but never on a prompt", () => {
    const withHwnd = (extra) => ({ stablePid: 1, terminalPid: null, snapshotOk: true, agentPid: null, agentCommandLine: "", detectedEditor: null, pidChain: [], foregroundWtHwnd: "987654", tmuxSocket: null, tmuxClient: null, cacheSource: "fresh", ...extra });
    const startBody = buildStateBody("SessionStart", { session_id: "s", cwd: CWD }, capture(withHwnd()));
    assert.strictEqual(startBody.wt_hwnd, "987654");
    // Even if a (misbehaving) resolver surfaced a handle on prompt, the event
    // is foreground-safe so it *would* apply — but the real resolver returns
    // null foregroundWtHwnd for prompt, so model that here.
    const promptBody = buildStateBody("UserPromptSubmit", { session_id: "s", cwd: CWD }, capture(withHwnd({ foregroundWtHwnd: null })));
    assert.ok(!("wt_hwnd" in promptBody));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2 — end-to-end Claude regression (REAL resolver)
// ═══════════════════════════════════════════════════════════════════════════

function snapshotJson(procs) {
  return JSON.stringify(procs.map((p) => ({
    ProcessId: p.pid, Name: p.name, ParentProcessId: p.ppid,
    CommandLine: typeof p.cmd === "string" ? p.cmd : null,
  })));
}
// The resolver walks from process.ppid by default (main() passes no startPid),
// so the mock snapshot anchors the agent node.exe at process.ppid (alive: it's
// this process's parent), headless claude-code, under WindowsTerminal.
const PPID = process.ppid;
const HEADLESS_PROCS = [
  { pid: PPID, name: "node.exe", ppid: 600, cmd: "node C:/x/claude-code/cli.js --print" },
  { pid: 600, name: "windowsterminal.exe", ppid: 0 },
];
function liveSubset(extra = {}) {
  return { stablePid: process.pid, agentPid: process.pid, agentCommandLine: "node claude-code --print", detectedEditor: "code", ...extra };
}

// Loads clawd-hook wired to the REAL shared resolver: patches child_process for a
// counting execFileSync, forces process.platform, reloads shared-process then
// clawd-hook. Exposes the shared-process module so each test builds a FRESH
// resolver (clean in-process _cached).
function loadRealResolver({ platform }) {
  const cpKey = require.resolve("child_process");
  const spKey = require.resolve("../hooks/shared-process");
  const chKey = require.resolve("../hooks/clawd-hook");
  const origCp = require.cache[cpKey];
  const origSp = require.cache[spKey];
  const origCh = require.cache[chKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const hadRemote = process.env.CLAWD_REMOTE;
  delete process.env.CLAWD_REMOTE;

  const state = { snapshot: snapshotJson(HEADLESS_PROCS), spawns: 0 };
  const execFileSyncMock = (cmd, args) => {
    state.spawns++;
    if (cmd === "powershell.exe") return state.snapshot;
    const key = `${cmd} ${(args || []).join(" ")}`;
    if (key.includes("ppid=")) return "1\n";
    return "bash\n";
  };

  const realCp = require("child_process");
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: { ...realCp, execFileSync: execFileSyncMock } };
  Object.defineProperty(process, "platform", { ...origPlatform, value: platform });

  delete require.cache[spKey];
  const sp = require("../hooks/shared-process");
  delete require.cache[chKey];
  const ch = require("../hooks/clawd-hook");

  const CLAUDE_OPTS = {
    agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
  };
  const makeResolve = () => sp.createPidResolver({ ...CLAUDE_OPTS, platformConfig: sp.getPlatformConfig() });

  const restore = () => {
    Object.defineProperty(process, "platform", origPlatform);
    if (hadRemote !== undefined) process.env.CLAWD_REMOTE = hadRemote;
    if (origCp) require.cache[cpKey] = origCp; else delete require.cache[cpKey];
    if (origSp) require.cache[spKey] = origSp; else delete require.cache[spKey];
    if (origCh) require.cache[chKey] = origCh; else delete require.cache[chKey];
    require("../hooks/shared-process");
    require("../hooks/clawd-hook"); // put natively-loaded instances back
  };
  return { buildStateBody: ch.buildStateBody, makeResolve, state, restore };
}

describe("clawd-hook end-to-end with the real resolver — Windows", () => {
  let env;
  before(() => { env = loadRealResolver({ platform: "win32" }); });
  after(() => env.restore());

  function run(event, payload) {
    env.state.spawns = 0;
    const resolve = env.makeResolve();
    const body = buildStateBodyPrewarmAware(env, event, payload, resolve);
    return { body, spawns: env.state.spawns };
  }
  // Mirrors main(): prewarm no-arg resolve() on SessionStart before build.
  function buildStateBodyPrewarmAware(env, event, payload, resolve) {
    if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();
    return env.buildStateBody(event, payload, resolve);
  }

  it("SessionStart prewarm resolves exactly once (build reuses the prewarmed snapshot)", () => {
    const sid = freshSid();
    const { body, spawns } = run("SessionStart", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 1, "prewarm + start build = ONE snapshot");
    assert.strictEqual(body.source_pid, 600);
    assert.strictEqual(body.agent_pid, PPID);
    assert.ok(pidCache.readPidCacheV2(NS, sid, CWD), "SessionStart wrote v2");
  });

  it("UserPromptSubmit HIT: zero spawn, applies subset, no hook-side wt_hwnd", () => {
    const sid = freshSid();
    pidCache.writePidCacheV2(NS, sid, CWD, liveSubset());
    const { body, spawns } = run("UserPromptSubmit", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0, "prompt hit never spawns");
    assert.strictEqual(body.source_pid, process.pid);
    assert.strictEqual(body.agent_pid, process.pid);
    assert.strictEqual(body.headless, true, "headless derives from the cached agentCommandLine");
    assert.ok(!("wt_hwnd" in body), "prompt body never carries a hook-side wt_hwnd (server samples it)");
  });

  it("UserPromptSubmit MISS: zero spawn, ships no pid fields, writes nothing", () => {
    const sid = freshSid();
    const { body, spawns } = run("UserPromptSubmit", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0, "prompt miss never spawns");
    assert.ok(!("source_pid" in body));
    assert.ok(!("agent_pid" in body));
    assert.strictEqual(pidCache.readPidCacheV2(NS, sid, CWD), null, "a prompt miss must never write a v2");
  });

  it("UserPromptSubmit MISS with a dead cached PID: still zero spawn (no fallback)", () => {
    const sid = freshSid();
    pidCache.writePidCacheV2(NS, sid, CWD, { stablePid: DEAD_PID, agentPid: process.pid, agentCommandLine: "x", detectedEditor: "code" });
    const { body, spawns } = run("UserPromptSubmit", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0);
    assert.ok(!("source_pid" in body), "never ship the dead cached pid, never degrade to process.ppid");
  });

  it("SessionEnd HIT: zero spawn, fills the final body, drops the cache", () => {
    const sid = freshSid();
    pidCache.writePidCacheV2(NS, sid, CWD, liveSubset());
    const { body, spawns } = run("SessionEnd", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0);
    assert.strictEqual(body.source_pid, process.pid);
    assert.strictEqual(pidCache.readPidCacheV2(NS, sid, CWD), null, "SessionEnd dropped the cache");
  });

  it("SessionEnd MISS: zero spawn, no pid fields, never writes (reversed #630 fallback)", () => {
    const sid = freshSid();
    const { body, spawns } = run("SessionEnd", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0, "SessionEnd miss must never spawn");
    assert.ok(!("source_pid" in body));
    assert.strictEqual(pidCache.readPidCacheV2(NS, sid, CWD), null);
  });

  it("Windows prompt/end with session_id 'default' (non-cacheable) still zero spawn", () => {
    const p = run("UserPromptSubmit", { session_id: "default", cwd: CWD });
    assert.strictEqual(p.spawns, 0);
    assert.ok(!("source_pid" in p.body));
    const e = run("SessionEnd", { session_id: "default", cwd: CWD });
    assert.strictEqual(e.spawns, 0);
  });

  it("Windows prompt/end with an empty cwd (non-cacheable) still zero spawn", () => {
    const p = run("UserPromptSubmit", { session_id: freshSid(), cwd: "" });
    assert.strictEqual(p.spawns, 0);
    const e = run("SessionEnd", { session_id: freshSid(), cwd: "" });
    assert.strictEqual(e.spawns, 0);
  });

  it("Stop does NOT drop the cache (turn completion is not SessionEnd)", () => {
    const sid = freshSid();
    pidCache.writePidCacheV2(NS, sid, CWD, liveSubset());
    const { spawns } = run("Stop", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 0, "Stop hits the cache, no spawn");
    assert.ok(pidCache.readPidCacheV2(NS, sid, CWD), "Stop must NOT drop the cache");
  });

  it("ordinary event MISS falls back to one fresh resolve and repopulates", () => {
    const sid = freshSid();
    const { body, spawns } = run("PreToolUse", { session_id: sid, cwd: CWD });
    assert.strictEqual(spawns, 1, "an ordinary event miss resolves fresh once");
    assert.strictEqual(body.source_pid, 600);
    assert.deepStrictEqual(body.pid_chain, [PPID, 600], "the fresh path ships pid_chain");
    assert.ok(pidCache.readPidCacheV2(NS, sid, CWD), "event miss repopulated the cache");
  });

  it("agentCommandLine / headless are preserved on the fresh path", () => {
    const sid = freshSid();
    const { body } = run("PreToolUse", { session_id: sid, cwd: CWD });
    assert.strictEqual(body.headless, true, "the --print cmdline sets headless");
    assert.strictEqual(body.agent_pid, PPID);
  });

  it("tmux_socket is recomputed from the environment on a cache hit", () => {
    const sid = freshSid();
    pidCache.writePidCacheV2(NS, sid, CWD, liveSubset());
    const saved = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/win,200,5";
    try {
      const { body } = run("PreToolUse", { session_id: sid, cwd: CWD });
      assert.strictEqual(body.tmux_socket, "/tmp/tmux-1000/win");
    } finally {
      if (saved === undefined) delete process.env.TMUX; else process.env.TMUX = saved;
    }
  });

  it("remote mode never resolves a local PID (bypass before the resolver)", () => {
    const hadRemote = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    env.state.spawns = 0;
    try {
      const resolve = env.makeResolve();
      const body = env.buildStateBody("UserPromptSubmit", { session_id: freshSid(), cwd: CWD }, resolve);
      assert.strictEqual(env.state.spawns, 0, "remote must not spawn");
      assert.ok(!("source_pid" in body));
      assert.strictEqual(typeof body.host, "string");
    } finally {
      if (hadRemote === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = hadRemote;
    }
  });
});

describe("clawd-hook end-to-end with the real resolver — non-Windows", () => {
  let env;
  before(() => { env = loadRealResolver({ platform: "linux" }); });
  after(() => env.restore());

  it("UserPromptSubmit and SessionEnd still resolve fresh (no-fallback is Windows-only)", () => {
    env.state.spawns = 0;
    const r1 = env.makeResolve();
    env.buildStateBody("UserPromptSubmit", { session_id: freshSid(), cwd: CWD }, r1);
    const afterPrompt = env.state.spawns;
    const r2 = env.makeResolve();
    env.buildStateBody("SessionEnd", { session_id: freshSid(), cwd: CWD }, r2);
    assert.ok(afterPrompt >= 1, "non-Windows prompt resolves fresh");
    assert.ok(env.state.spawns > afterPrompt, "non-Windows SessionEnd resolves fresh too");
  });

  it("never creates a v2 cache file on non-Windows", () => {
    const sid = freshSid();
    const resolve = env.makeResolve();
    env.buildStateBody("PreToolUse", { session_id: sid, cwd: CWD }, resolve);
    assert.strictEqual(pidCache.readPidCacheV2(NS, sid, CWD), null, "non-Windows must not disk-cache");
  });
});
