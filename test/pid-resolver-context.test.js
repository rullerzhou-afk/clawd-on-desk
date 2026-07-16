// test/pid-resolver-context.test.js — PR2 (#634) shared resolver lifecycle
// context + v1→v2 promotion + the Slice 1 no-arg compatibility red line.
//
// The resolver's fresh path re-requires child_process at call time, so
// loadSharedProcessWithMock injects a counting execFileSync (spawn counter) and
// forces process.platform. The cache side uses the REAL pid-cache with real temp
// files (like clawd-hook-pid-cache.test.js), and node:test's t.mock.method spies
// on the pid-cache module object to assert call counts / inject failures.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");
const pc = require("../hooks/pid-cache");

// Isolate the cache directory (#634): startLifecycle triggers a real sweep, and
// without isolation it would scan the shared os.tmpdir() — deleting other test
// processes' fixtures and a developer's real >24h caches. The resolver reaches
// pid-cache through the SAME module object, so this override covers it too.
let ISO_DIR;
before(() => {
  ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-test-iso-"));
  pc.__setCacheDirForTests(ISO_DIR);
});
after(() => {
  pc.__setCacheDirForTests(null);
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
});

const NS = "claude-code";
const CWD = "/repo/resolver-under-test";
const DEAD_PID = 2147483646;
const AGENT_OPTS = {
  agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
  agentCmdlineCheck: (c) => c.includes("claude-code"),
  // #681: the resolver derives `headless` in memory and caches only the boolean,
  // so the fixtures below use "--print" vs plain "claude" as the discriminator
  // where they used to compare raw command lines.
  headlessCheck: (c) => /\s(-p|--print)(\s|$)/.test(c || ""),
  // #681: without a passing gate the Windows resolver refuses to spawn at all,
  // and every lifecycle assertion below would pass for the wrong reason (zero
  // spawn because Clawd looks offline, not because the cache was hit). Injected,
  // never read from the real ~/.clawd. See test/shared-process.test.js LIVE_GATE.
  readRuntimeIdentity: () => ({ ok: true, reason: null, port: 23333, ownerPid: process.pid }),
  env: {},
};

let seq = 0;
const usedV1 = [];
const usedV2 = [];
function freshSid() { const s = `res-${process.pid}-${seq++}`; usedV1.push(s); usedV2.push(s); return s; }
afterEach(() => {
  for (const s of usedV1.splice(0)) pc.dropPidCache(s, CWD);
  for (const s of usedV2.splice(0)) pc.dropPidCacheV2(NS, s, CWD);
});

function snapshotJson(procs) {
  return JSON.stringify(procs.map((p) => ({
    ProcessId: p.pid, Name: p.name, ParentProcessId: p.ppid,
    CommandLine: typeof p.cmd === "string" ? p.cmd : null,
  })));
}
// A live agent tree: node.exe (this process → alive) under windowsterminal.exe.
// agentPid resolves to process.pid, so `start`/`event` meet the write condition.
function liveProcs() {
  return [
    { pid: process.pid, name: "node.exe", ppid: 600, cmd: "node C:/x/claude-code/cli.js" },
    { pid: 600, name: "windowsterminal.exe", ppid: 0 },
  ];
}
// A cached LEGACY (v1) subset whose BOTH pids are this (alive) process, so the
// resolver's double-liveness check treats it as a hit. v1 is the shape that
// still carries a raw command line — nothing writes it any more (#681), so this
// only ever authors migration fixtures.
function liveSubset(extra = {}) {
  return { stablePid: process.pid, agentPid: process.pid, agentCommandLine: "claude --print", detectedEditor: "code", ...extra };
}
// The SANITIZED (v2) subset: a derived boolean where v1 had the command line.
function liveV2Subset(extra = {}) {
  return { stablePid: process.pid, agentPid: process.pid, headless: true, detectedEditor: "code", ...extra };
}

// Build a resolver over a mock-loaded shared-process. `snapshot` is returned by
// every execFileSync (the Windows snapshot); `spawns()` counts calls.
function mkResolver({ platform = "win32", procs, startPid, snapshot, identity } = {}) {
  let spawns = 0;
  const out = snapshot !== undefined ? snapshot : snapshotJson(procs || liveProcs());
  const { mod, cleanup } = loadSharedProcessWithMock({
    execFileSyncMock: () => { spawns++; return out; },
    platform,
  });
  const cfg = mod.getPlatformConfig();
  const resolve = mod.createPidResolver({
    platformConfig: cfg,
    startPid: startPid || process.pid,
    ...AGENT_OPTS,
    // #681: AGENT_OPTS declares a live gate by default; `identity` overrides it
    // for the cases that need Clawd to look offline.
    ...(identity ? { readRuntimeIdentity: () => identity } : {}),
  });
  return { mod, resolve, cleanup, spawns: () => spawns };
}

function ctx(sessionId, lifecycle, cacheable = true, extra = {}) {
  return { namespace: NS, sessionId, cacheCwd: CWD, lifecycle, cacheable, ...extra };
}

const NO_ARG_FIELDS = [
  "agentCommandLine", "agentPid", "detectedEditor", "foregroundWtHwnd", "pidChain",
  "snapshotOk", "stablePid", "terminalPid", "tmuxClient", "tmuxSocket",
].sort();

const ALL_CACHE_METHODS = [
  "readPidCache", "writePidCache", "touchPidCache", "dropPidCache",
  "readPidCacheV2", "writePidCacheV2", "writePidCacheV2IfAbsent", "touchPidCacheV2", "dropPidCacheV2",
  "sweepStalePidCaches", "cacheFilePath", "cacheFilePathV2",
];

// ═══════════════════════════════════════════════════════════════════════════
// Slice 1 no-arg compatibility red line (§5.1)
// ═══════════════════════════════════════════════════════════════════════════
describe("resolver no-arg compatibility (§5.1 red line)", () => {
  it("first + second no-arg call: identical full object, same ref, exactly one snapshot", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    try {
      const r1 = resolve();
      const r2 = resolve();
      assert.strictEqual(spawns(), 1, "no-arg: exactly one snapshot across two calls");
      assert.strictEqual(r1, r2, "no-arg: subsequent call returns the SAME cached object");
      assert.deepStrictEqual(Object.keys(r1).sort(), NO_ARG_FIELDS, "exact 5c2b1f0 field set");
      assert.ok(!("cacheSource" in r1), "no-arg result must NOT carry the context-only cacheSource field");
      assert.strictEqual(r1.agentPid, process.pid);
      assert.strictEqual(r1.stablePid, 600);
    } finally { cleanup(); }
  });

  it("no-arg path performs ZERO cache read/write/touch/drop/promotion/sweep", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spies = ALL_CACHE_METHODS.map((m) => [m, t.mock.method(pc, m)]);
    try {
      resolve();
      resolve();
      for (const [name, spy] of spies) {
        assert.strictEqual(spy.mock.calls.length, 0, `no-arg path must never call pidCache.${name}`);
      }
    } finally { cleanup(); }
  });

  it("no-arg path produces no clawd-pidcache2-* file (never calls a v2 write)", (t) => {
    // Asserted via the write mechanism rather than a global tmpdir scan: the
    // temp dir is shared with concurrently-running tests that legitimately
    // create v2 files, so a before/after directory diff is racy. Zero calls to
    // either v2 write path deterministically means no clawd-pidcache2-* file can
    // be produced from here.
    const { resolve, cleanup } = mkResolver();
    const wrote = t.mock.method(pc, "writePidCacheV2");
    const wroteNoClobber = t.mock.method(pc, "writePidCacheV2IfAbsent");
    try {
      resolve();
      resolve();
      assert.strictEqual(wrote.mock.calls.length, 0, "no-arg must never write a v2 file");
      assert.strictEqual(wroteNoClobber.mock.calls.length, 0, "no-arg must never no-clobber-write a v2 file");
    } finally { cleanup(); }
  });

  it("an unmigrated adapter (Gemini-shaped resolver) is unaffected: same fields + spawn count, zero cache files", (t) => {
    // Slice 1 migrates only Claude. Any other adapter keeps calling resolve()
    // no-arg; its behavior must be byte-for-byte with 5c2b1f0.
    let spawns = 0;
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: () => { spawns++; return snapshotJson([
        { pid: process.pid, name: "node.exe", ppid: 700, cmd: "node C:/x/gemini/cli.js" },
        { pid: 700, name: "windowsterminal.exe", ppid: 0 },
      ]); },
      platform: "win32",
    });
    const spies = ALL_CACHE_METHODS.map((m) => t.mock.method(pc, m));
    try {
      const cfg = mod.getPlatformConfig();
      const resolve = mod.createPidResolver({
        platformConfig: cfg, startPid: process.pid,
        agentNames: { win: new Set(["node.exe"]), mac: new Set(["node"]) },
        agentCmdlineCheck: (c) => c.includes("gemini"),
        readRuntimeIdentity: () => ({ ok: true, reason: null, port: 23333, ownerPid: process.pid }),
        env: {},
      });
      const r1 = resolve();
      const r2 = resolve();
      assert.strictEqual(spawns, 1);
      assert.strictEqual(r1, r2);
      assert.deepStrictEqual(Object.keys(r1).sort(), NO_ARG_FIELDS);
      for (const spy of spies) assert.strictEqual(spy.mock.calls.length, 0, "unmigrated adapter must not touch pid-cache");
    } finally { cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle matrix (Windows) (§5.1)
// ═══════════════════════════════════════════════════════════════════════════
describe("resolver lifecycle — start", () => {
  it("reuses a no-arg prewarm: the start context does NOT spawn a second time", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    try {
      resolve();                          // prewarm (no-arg)
      assert.strictEqual(spawns(), 1);
      const meta = resolve(ctx(sid, "start"));
      assert.strictEqual(spawns(), 1, "start must reuse the prewarmed snapshot, not spawn again");
      assert.strictEqual(meta.cacheSource, "fresh");
      assert.ok(pc.readPidCacheV2(NS, sid, CWD), "start wrote v2");
    } finally { cleanup(); }
  });

  it("writes v2 only when snapshotOk && agentPid; a degraded snapshot writes nothing", () => {
    // agentless tree: no claude-code cmd → agentPid null → no write.
    const { resolve, cleanup } = mkResolver({ procs: [
      { pid: process.pid, name: "node.exe", ppid: 600, cmd: "node other.js" },
      { pid: 600, name: "windowsterminal.exe", ppid: 0 },
    ]});
    const sid = freshSid();
    try {
      const meta = resolve(ctx(sid, "start"));
      assert.strictEqual(meta.agentPid, null);
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "no agentPid → no v2 write");
    } finally { cleanup(); }
  });

  it("triggers a low-frequency sweep (cacheable start only)", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    const sid = freshSid();
    try {
      resolve(ctx(sid, "start"));
      assert.strictEqual(spy.mock.calls.length, 1, "cacheable start sweeps once");
      resolve.call(null); // no-op to be safe
    } finally { cleanup(); }
  });

  it("non-cacheable start still resolves fresh but writes nothing and does not sweep", (t) => {
    const { resolve, cleanup, spawns } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      const meta = resolve(ctx("default", "start", false, { cacheCwd: "" }));
      assert.strictEqual(meta.cacheSource, "fresh");
      assert.strictEqual(spawns(), 1, "start may fresh");
      assert.strictEqual(spy.mock.calls.length, 0, "non-cacheable start does not sweep");
    } finally { cleanup(); }
  });
});

describe("resolver lifecycle — prompt (cache-only, no fallback)", () => {
  it("hit: zero spawn, stable subset, never fakes pidChain/foregroundWtHwnd/tmuxClient", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCacheV2(NS, sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0, "prompt hit must not spawn");
      assert.strictEqual(meta.cacheSource, "v2");
      assert.strictEqual(meta.stablePid, process.pid);
      assert.deepStrictEqual(meta.pidChain, []);
      assert.strictEqual(meta.foregroundWtHwnd, null);
      assert.strictEqual(meta.tmuxClient, null);
    } finally { cleanup(); }
  });

  it("miss / corrupt / dead-PID / cacheable=false: all zero spawn + empty metadata", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    try {
      // plain miss
      let m = resolve(ctx(freshSid(), "prompt"));
      assert.strictEqual(m.cacheSource, "none");
      assert.strictEqual(m.stablePid, null);
      // corrupt file
      const sidC = freshSid();
      fs.writeFileSync(pc.cacheFilePathV2(NS, sidC, CWD), "{ not json");
      m = resolve(ctx(sidC, "prompt"));
      assert.strictEqual(m.cacheSource, "none");
      // dead cached PID
      const sidD = freshSid();
      pc.writePidCacheV2(NS, sidD, CWD, { stablePid: DEAD_PID, agentPid: process.pid, agentCommandLine: "x", detectedEditor: "code" });
      m = resolve(ctx(sidD, "prompt"));
      assert.strictEqual(m.cacheSource, "none", "dead cached stablePid is not a hit");
      // cacheable=false (default sid / empty cwd)
      m = resolve(ctx("default", "prompt", false, { cacheCwd: "" }));
      assert.strictEqual(m.cacheSource, "none");
      assert.strictEqual(spawns(), 0, "NONE of the prompt paths may spawn");
    } finally { cleanup(); }
  });
});

describe("resolver lifecycle — event", () => {
  it("hit: zero spawn", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCacheV2(NS, sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "event"));
      assert.strictEqual(spawns(), 0, "event hit must not spawn");
      assert.strictEqual(meta.cacheSource, "v2");
    } finally { cleanup(); }
  });

  it("miss: at most one fresh, then repopulates v2", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    try {
      const meta = resolve(ctx(sid, "event"));
      assert.strictEqual(spawns(), 1, "event miss: exactly one fresh");
      assert.strictEqual(meta.cacheSource, "fresh");
      assert.ok(pc.readPidCacheV2(NS, sid, CWD), "event miss repopulated v2");
    } finally { cleanup(); }
  });

  it("non-cacheable event may fresh (no-fallback is prompt/end only)", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    try {
      const meta = resolve(ctx("default", "event", false, { cacheCwd: "" }));
      assert.strictEqual(spawns(), 1, "non-cacheable event resolves fresh");
      assert.strictEqual(meta.cacheSource, "fresh");
    } finally { cleanup(); }
  });
});

describe("resolver lifecycle — end (cache-only, drop, no write-back)", () => {
  it("hit: zero spawn, fills body from cache, drops it, never writes back", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCacheV2(NS, sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(spawns(), 0, "end hit must not spawn");
      assert.strictEqual(meta.stablePid, process.pid, "end used the cache for the final body");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "end dropped v2");
    } finally { cleanup(); }
  });

  it("miss: zero spawn, empty metadata, still drops (idempotent), never writes", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(spawns(), 0, "end miss must not spawn");
      assert.strictEqual(meta.cacheSource, "none");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "end miss never wrote a v2");
    } finally { cleanup(); }
  });
});

describe("resolver lifecycle — non-Windows keeps fresh runtime behavior", () => {
  it("every lifecycle resolves fresh and touches no disk cache", (t) => {
    // ps mock: ppid=1 stops the walk immediately; comm=bash.
    let spawns = 0;
    const { mod, cleanup } = loadSharedProcessWithMock({
      execFileSyncMock: (cmd, args) => {
        spawns++;
        const key = `${cmd} ${(args || []).join(" ")}`;
        if (key.includes("ppid=")) return "1\n";
        return "bash\n";
      },
      platform: "linux",
    });
    const spies = ALL_CACHE_METHODS.map((m) => t.mock.method(pc, m));
    try {
      const cfg = mod.getPlatformConfig();
      const resolve = mod.createPidResolver({ platformConfig: cfg, startPid: 4242, ...AGENT_OPTS });
      for (const lifecycle of ["start", "prompt", "event", "end"]) {
        const meta = resolve(ctx(freshSid(), lifecycle));
        assert.strictEqual(meta.cacheSource, "fresh", `${lifecycle} is fresh on non-Windows`);
      }
      // One resolver instance reuses its in-process snapshot across calls (same
      // as 5c2b1f0); each real hook event is a fresh process. What matters here:
      // the ps walk ran and NO disk cache was consulted on any lifecycle.
      assert.ok(spawns >= 1, "the fresh ps walk ran");
      for (const spy of spies) assert.strictEqual(spy.mock.calls.length, 0, "non-Windows must not touch the disk cache");
    } finally { cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v1 → v2 promotion (§5.5)
// ═══════════════════════════════════════════════════════════════════════════
describe("resolver v1→v2 promotion (Claude only)", () => {
  it("normal promotion: zero spawn, writes v2, deletes the (unchanged) v1", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0, "promotion is zero spawn");
      assert.strictEqual(meta.cacheSource, "v1");
      assert.strictEqual(meta.stablePid, process.pid);
      assert.ok(pc.readPidCacheV2(NS, sid, CWD), "promotion wrote v2");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "unchanged v1 deleted after a confirmed v2 write");
    } finally { cleanup(); }
  });

  it("a v1 with a dead PID is not promoted and prompt falls through to empty", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, { stablePid: DEAD_PID, agentPid: process.pid, agentCommandLine: "claude", detectedEditor: "code" });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0);
      assert.strictEqual(meta.cacheSource, "none", "dead v1 is not promoted");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "no v2 from a dead v1");
      assert.ok(pc.readPidCache(sid, CWD), "dead v1 is left for the sweep, not deleted");
    } finally { cleanup(); }
  });

  // BASELINE INVERTED BY #681. #634 kept the v1 on a failed v2 write, so a later
  // event could retry the promotion instead of re-resolving. That trade assumed
  // v1 and v2 hold the same data. They no longer do — v1 is the only file with
  // the raw command line — so the raw line would sit in %TEMP% for the rest of
  // the session to save a possible future flash. #681 chooses privacy: drop v1,
  // serve this event from memory, accept at most one later re-resolve.
  it("v2 write FAILURE: serves from memory, does NOT spawn, and STILL deletes the legacy v1", (t) => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    t.mock.method(pc, "writePidCacheV2IfAbsent", () => false); // simulate a write/link failure
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0, "a v2 write failure must not trigger a fresh resolve");
      assert.strictEqual(meta.cacheSource, "v1", "the current event is still served, from memory");
      assert.strictEqual(meta.stablePid, process.pid);
      assert.strictEqual(meta.headless, true, "derived in memory from the v1 we read");
      assert.strictEqual(meta.agentCommandLine, "", "and the raw line never rides along");
      assert.strictEqual(pc.readPidCache(sid, CWD), null,
        "the legacy v1 must be gone even though no v2 replaced it — privacy over one avoidable re-resolve");
    } finally { cleanup(); }
  });

  it("after a v2 write failure dropped v1, the next OFFLINE event is still zero spawn", (t) => {
    // The cost of the privacy choice above is bounded: the next event misses and
    // re-resolves — but only if Clawd is actually running. Offline, the #681 gate
    // still refuses, so the failure mode this whole issue is about cannot return.
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    const offline = mkResolver({
      identity: { ok: false, reason: "runtime-missing", port: null, ownerPid: null },
    });
    t.mock.method(pc, "writePidCacheV2IfAbsent", () => false);
    try {
      offline.resolve(ctx(sid, "prompt"));
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "v1 dropped");
      const second = offline.resolve(ctx(freshSid(), "event")); // a miss → would fresh, if allowed
      assert.strictEqual(offline.spawns(), 0, "still zero spawn while Clawd is offline");
      assert.strictEqual(second.stablePid, null);
    } finally { offline.cleanup(); }
  });

  it("v1 identity changed between read and delete: v1 is kept (deleted only when unchanged)", (t) => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    const v1File = pc.cacheFilePath(sid, CWD);
    const realIfAbsent = pc.writePidCacheV2IfAbsent;
    t.mock.method(pc, "writePidCacheV2IfAbsent", (...a) => {
      // A concurrent SessionStart atomically replaces the v1 right before our
      // post-write delete check — same key, different content/size.
      fs.writeFileSync(v1File, JSON.stringify({ ...liveSubset({ agentCommandLine: "claude --REPLACED" }), cwd: CWD, ts: Date.now() }));
      return realIfAbsent(...a);
    });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(meta.cacheSource, "v1");
      assert.ok(pc.readPidCache(sid, CWD), "a replaced v1 must NOT be deleted (left for the sweep)");
      assert.match(pc.readPidCache(sid, CWD).agentCommandLine, /REPLACED/);
    } finally { cleanup(); }
  });

  it("recheck finds a concurrent v2 already present: prefer it, do not overwrite — and still drop the legacy v1", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    // The v1 says headless; the concurrent v2 says NOT headless. Whichever value
    // comes back names the file that was actually used.
    pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --print" }));
    pc.writePidCacheV2(NS, sid, CWD, liveV2Subset({ headless: false, detectedEditor: "cursor" }));
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0);
      assert.strictEqual(meta.cacheSource, "v2", "recheck prefers the existing v2");
      assert.strictEqual(meta.headless, false, "the fresher v2 wins, not the stale v1");
      assert.strictEqual(meta.detectedEditor, "cursor");
      assert.strictEqual(pc.readPidCache(sid, CWD), null,
        "#681: yielding to the concurrent v2 must not leave the legacy raw command line behind");
    } finally { cleanup(); }
  });

  it("no-clobber closes the recheck-is-not-CAS race: a fresh v2 written mid-promotion survives", (t) => {
    // A concurrent SessionStart writes a FRESH v2 AFTER promotion's recheck saw
    // none, right before promotion's no-clobber link. The link then fails EEXIST
    // ("exists"), so promotion uses the fresh v2 and the stale v1 never
    // overwrites it (plan §6.10). Verified on Windows NTFS: fs.linkSync onto an
    // existing path throws EEXIST and does not clobber.
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --print" })); // stale v1: headless
    const realIfAbsent = pc.writePidCacheV2IfAbsent;
    t.mock.method(pc, "writePidCacheV2IfAbsent", (...a) => {
      // fresh concurrent v2: NOT headless, distinct editor → identifiable
      pc.writePidCacheV2(NS, sid, CWD, liveV2Subset({ headless: false, detectedEditor: "cursor" }));
      return realIfAbsent(...a); // real no-clobber now sees the fresh v2 → "exists"
    });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0, "no fresh spawn");
      assert.strictEqual(meta.cacheSource, "v2", "promotion yields to the concurrent fresh v2");
      const surviving = pc.readPidCacheV2(NS, sid, CWD);
      assert.strictEqual(surviving.headless, false, "the fresh v2 must NOT be overwritten by the stale v1");
      assert.strictEqual(surviving.detectedEditor, "cursor");
    } finally { cleanup(); }
  });

  it("end first-sees-v1: uses it for the final body, drops it, creates NO short-lived v2", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(spawns(), 0);
      assert.strictEqual(meta.cacheSource, "v1", "end used the v1 for the final body");
      assert.strictEqual(meta.stablePid, process.pid);
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "end must NOT create a v2");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "end dropped the v1");
    } finally { cleanup(); }
  });

  it("start writes v2 then best-effort cleans a pre-existing v1, with no extra fresh", () => {
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());   // leftover v1 from before the upgrade
    try {
      resolve();                                 // prewarm
      const meta = resolve(ctx(sid, "start"));
      assert.strictEqual(spawns(), 1, "start reuses prewarm — no extra fresh for the v1 cleanup");
      assert.strictEqual(meta.cacheSource, "fresh");
      assert.ok(pc.readPidCacheV2(NS, sid, CWD), "start wrote v2");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "start cleaned the stale v1");
    } finally { cleanup(); }
  });

  it("start v2 write FAILURE still drops a pre-existing v1 (privacy-first, like promotion)", (t) => {
    // REVERSED baseline. The earlier High finding pinned the opposite ("keep v1
    // promotable"), and that was re-judged in review: a DEAD v1 can never be
    // promoted, the sweep has a 24h age floor, and nothing writes v1 any more —
    // so keeping it on a failed start write left a crashed session's raw
    // command line on disk with NO collector. The v1 goes in all outcomes, the
    // same trade claudePromote makes; the session's worst case is one re-fresh.
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    t.mock.method(pc, "writePidCacheV2", () => false); // simulate a write failure
    try {
      resolve(ctx(sid, "start"));
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "the v2 write failed, so no v2 exists");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "the v1 must be dropped even on a failed v2 write");
    } finally { cleanup(); }
  });

  it("event fresh + v2 write FAILURE drops a DEAD v1 — the resumed-crash scenario", (t) => {
    // The exact hole the review's P1 described: a crashed session leaves a
    // <24h v1 whose PIDs are dead. Dead ⇒ readLiveV1 never returns it, so
    // promotion (and promotion's delete) never runs; <24h ⇒ the sweep skips it.
    // A usable fresh walk on the SAME key is the only collector left — it must
    // drop the v1 even when its own v2 write fails.
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset({ stablePid: DEAD_PID, agentPid: DEAD_PID }));
    t.mock.method(pc, "writePidCacheV2", () => false);
    try {
      const meta = resolve(ctx(sid, "event"));
      assert.strictEqual(meta.cacheSource, "fresh", "dead v1 cannot promote — event went fresh");
      assert.strictEqual(pc.readPidCache(sid, CWD), null,
        "the dead v1's raw command line must not outlive a usable fresh walk");
    } finally { cleanup(); }
  });

  it("a non-Claude namespace never reads v1", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    try {
      const meta = resolve({ namespace: "gemini", sessionId: sid, cacheCwd: CWD, lifecycle: "prompt", cacheable: true });
      assert.strictEqual(meta.cacheSource, "none", "non-Claude prompt miss stays empty (no v1 read)");
      assert.ok(pc.readPidCache(sid, CWD), "the v1 is untouched by a non-Claude namespace");
    } finally { cleanup(); }
  });

  it("promotion interleaved with a concurrent end/drop leaves at most a sweepable orphan, never a spawn", (t) => {
    // The accepted residual (plan §7.3): a promotion that writes v2 while a
    // concurrent SessionEnd drops it may leave an orphan. It must never spawn.
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    const realIfAbsent = pc.writePidCacheV2IfAbsent;
    t.mock.method(pc, "writePidCacheV2IfAbsent", (...a) => {
      const r = realIfAbsent(...a);
      pc.dropPidCacheV2(NS, sid, CWD); // concurrent SessionEnd drop, right after our write
      return r;
    });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0, "the interleave must never fall back to a spawn");
      assert.strictEqual(meta.cacheSource, "v1", "still returns the validated v1 metadata");
      // Whether a v2 orphan remains is unspecified (accepted residual); the
      // read-side double-liveness + sweep bound the consequence.
    } finally { cleanup(); }
  });

  it("event fresh write FAILURE: writes exactly once (false), does NOT sweep, produces no v2", (t) => {
    // A clean miss (no v1, no v2) reaches the event fresh→write path. On a failed
    // write the population is incomplete, so it must NOT count as a sweep entry
    // point and must leave no v2. (The previous version disabled the promotion
    // no-clobber write with a v1 present, so it returned the promoted v1 and
    // never reached this fresh write at all — it did not cover this branch.)
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    const writeSpy = t.mock.method(pc, "writePidCacheV2", () => false);
    const sweepSpy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      resolve(ctx(sid, "event"));
      assert.strictEqual(spawns(), 1, "the event miss still resolves fresh once");
      assert.strictEqual(writeSpy.mock.calls.length, 1, "the fresh v2 write is attempted exactly once");
      assert.strictEqual(writeSpy.mock.calls[0].result, false, "and it reports failure");
      assert.strictEqual(sweepSpy.mock.calls.length, 0, "a FAILED population is not a sweep entry point");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "no v2 is produced");
    } finally { cleanup(); }
  });

});

describe("resolver v1→v2 promotion — identity binds the exact bytes read (High, §5.5)", () => {
  it("promotion reads the v1 through the SINGLE-observation readPidCacheEntry, never the legacy split read", (t) => {
    // The structural guard for Codex's between-reads race: the bug required a
    // separate readPidCache (content) + identity read that a concurrent write
    // could straddle. If the resolver ever regresses to that split, this fails.
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    const entrySpy = t.mock.method(pc, "readPidCacheEntry");
    const legacySpy = t.mock.method(pc, "readPidCache");
    try {
      resolve(ctx(sid, "prompt")); // v2 miss → promotion
      assert.ok(entrySpy.mock.calls.length >= 1, "promotion uses readPidCacheEntry (one observation)");
      assert.strictEqual(legacySpy.mock.calls.length, 0, "and NEVER the legacy separate readPidCache");
    } finally { cleanup(); }
  });

  it("a v1 replaced after the read (before the delete-guard) survives; the content read is promoted", (t) => {
    // Codex's deterministic repro: a concurrent writer replaces the v1 after the
    // resolver read it. Pre-fix, the separate identity read captured the NEW file
    // and the delete-guard then deleted it while promoting the OLD content
    // ({returned:OLD, survivingV1:null}). Now the subset AND identity come from
    // ONE observation, so the NEW v1 survives and the OLD is promoted.
    // #681 note: the raw command line no longer rides on the metadata, so OLD vs
    // NEW is discriminated by what each one DERIVES to. OLD is `claude --print`
    // (headless), NEW is plain `claude` (interactive) — so meta.headless === true
    // proves the promotion derived from the bytes it actually read, which is a
    // strictly sharper assertion than comparing the line back out.
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --print --OLD" }));
    const realIfAbsent = pc.writePidCacheV2IfAbsent;
    t.mock.method(pc, "writePidCacheV2IfAbsent", (...a) => {
      // fires AFTER the single-observation read, BEFORE the delete-guard.
      pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --NEW" }));
      return realIfAbsent(...a);
    });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(spawns(), 0);
      assert.strictEqual(meta.headless, true, "promoted the content it actually read (OLD was --print)");
      const surviving = pc.readPidCache(sid, CWD);
      assert.ok(surviving, "the concurrently-written NEW v1 must SURVIVE");
      assert.match(surviving.agentCommandLine, /NEW/, "and it is the NEW content, not deleted");
    } finally { cleanup(); }
  });
});

describe("resolver end — v1 delete is identity-verified, not blind (Medium, §5.5)", () => {
  it("a v1 replaced DURING end survives; end used the v1 it actually read", (t) => {
    // Codex's repro: end read the OLD v1, a concurrent writer wrote a NEW v1,
    // and the blind drop deleted it ({returned:OLD-END, survivingV1:null}). Now
    // the valid v1 is deleted only via its own read-identity.
    // As above: OLD-END is `--print` (headless), NEW-END is not, so the derived
    // boolean identifies which bytes the final body came from.
    const { resolve, cleanup, spawns } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --print --OLD-END" }));
    const realDropV2 = pc.dropPidCacheV2;
    t.mock.method(pc, "dropPidCacheV2", (...a) => {
      // end reads the v1 entry, then drops v2, then delete-guards v1 — replace in
      // the drop-v2 step so it lands between the v1 read and the v1 delete.
      pc.writePidCache(sid, CWD, liveSubset({ agentCommandLine: "claude --NEW-END" }));
      return realDropV2(...a);
    });
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(spawns(), 0);
      assert.strictEqual(meta.headless, true, "end used the v1 it read for the final body (OLD-END was --print)");
      assert.strictEqual(meta.agentCommandLine, "", "#681: not even the last event of a session ships the raw line");
      const surviving = pc.readPidCache(sid, CWD);
      assert.ok(surviving, "the concurrently-written NEW v1 must SURVIVE end's identity-verified delete");
      assert.match(surviving.agentCommandLine, /NEW-END/);
    } finally { cleanup(); }
  });

  it("end still deletes the v1 it read when unchanged (no concurrent writer)", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    pc.writePidCache(sid, CWD, liveSubset());
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(meta.cacheSource, "v1");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "an unchanged v1 is dropped on end");
    } finally { cleanup(); }
  });
});

describe("resolver sweep triggering (§5.4: once per process)", () => {
  it("no-start adapter path: the first successful event population triggers a sweep", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      resolve(ctx(freshSid(), "event")); // miss → fresh → write → sweep
      assert.strictEqual(spy.mock.calls.length, 1, "first event population sweeps once");
    } finally { cleanup(); }
  });

  it("sweeps AT MOST once per resolver instance (a second event does not re-sweep)", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      resolve(ctx(freshSid(), "event"));
      resolve(ctx(freshSid(), "event"));
      assert.strictEqual(spy.mock.calls.length, 1, "the once-per-process guard holds across events");
    } finally { cleanup(); }
  });

  it("start sweeps; a later event in the same process does not sweep again", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      resolve(); // prewarm
      resolve(ctx(freshSid(), "start"));
      resolve(ctx(freshSid(), "event"));
      assert.strictEqual(spy.mock.calls.length, 1, "start already swept; the event must not re-sweep");
    } finally { cleanup(); }
  });

  it("a prompt (cache-only) never triggers a sweep", (t) => {
    const { resolve, cleanup } = mkResolver();
    const spy = t.mock.method(pc, "sweepStalePidCaches");
    try {
      resolve(ctx(freshSid(), "prompt"));
      assert.strictEqual(spy.mock.calls.length, 0, "prompt is cache-only; no sweep");
    } finally { cleanup(); }
  });
});
