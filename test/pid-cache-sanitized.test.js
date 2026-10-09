// test/pid-cache-sanitized.test.js — #681 Slice A2, the privacy boundary.
//
// v1 persisted the agent's whole command line into a %TEMP% file so a later
// cache hit could re-run one regex against it. That file outlives the hook, is
// readable by anything running as this user, and — because the sweep only
// collects caches whose PIDs are DEAD — a long-lived session's copy is never
// collected at all. All of it, to answer "is this `claude -p`?".
//
// A2 keeps the boolean and drops the line. This file is the proof: a
// SECRET_SENTINEL is planted in a legacy v1 command line and must not appear in
// the v2 file, the HTTP body, or anything logged — while `headless` still
// derives correctly from it.
//
// Cache directory is isolated per-file: these tests author fixtures and let the
// real sweep run, and neither may touch the developer's actual %TEMP% caches.

"use strict";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pc = require("../hooks/pid-cache");
const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");

// A string that could only have come from the raw command line.
const SECRET_SENTINEL = "SUPER-SECRET-c0ffee-DO-NOT-PERSIST";
const NS = "claude-code";
const CWD = "/repo/sanitized-under-test";

let ISO_DIR;
before(() => {
  ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pidcache-sanitized-iso-"));
  pc.__setCacheDirForTests(ISO_DIR);
});
after(() => {
  pc.__setCacheDirForTests(null);
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

let seq = 0;
const used = [];
const freshSid = () => { const s = `san-${process.pid}-${seq++}`; used.push(s); return s; };
afterEach(() => {
  for (const s of used.splice(0)) { pc.dropPidCache(s, CWD); pc.dropPidCacheV2(NS, s, CWD); }
});

const AGENT_OPTS = {
  agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
  agentCmdlineCheck: (c) => c.includes("claude-code"),
  headlessCheck: (c) => /\s(-p|--print)(\s|$)/.test(c || ""),
  readRuntimeIdentity: () => ({ ok: true, reason: null, port: 23333, ownerPid: process.pid }),
  env: {},
};

function snapshotJson(procs) {
  return JSON.stringify(procs.map((p) => ({
    ProcessId: p.pid, Name: p.name, ParentProcessId: p.ppid,
    CommandLine: typeof p.cmd === "string" ? p.cmd : null,
  })));
}

// A live tree whose agent command line contains the sentinel AND --print.
//
// BOTH pids must be genuinely alive, or the resolver's double-liveness check
// turns every intended cache HIT into a miss and the tests below pass/fail for
// the wrong reason. So the agent is this process's parent and the terminal is
// this process — the only two pids a unit test can be sure of.
function mkResolver({ cmd = `node C:/x/claude-code/cli.js --print --token ${SECRET_SENTINEL}` } = {}) {
  const out = snapshotJson([
    { pid: process.ppid, name: "node.exe", ppid: process.pid, cmd },
    { pid: process.pid, name: "windowsterminal.exe", ppid: 0 },
  ]);
  const { mod, cleanup } = loadSharedProcessWithMock({
    execFileSyncMock: () => out,
    platform: "win32",
  });
  const resolve = mod.createPidResolver({
    ...AGENT_OPTS, platformConfig: mod.getPlatformConfig(), startPid: process.ppid,
  });
  return { resolve, cleanup };
}

const ctx = (sessionId, lifecycle) => ({ namespace: NS, sessionId, cacheCwd: CWD, lifecycle, cacheable: true });
const readV2Raw = (sid) => fs.readFileSync(pc.cacheFilePathV2(NS, sid, CWD), "utf8");

// A legacy v1 as a pre-#681 Clawd would have left it: raw command line included.
function plantLegacyV1(sid, { cmd = `node claude-code --print --token ${SECRET_SENTINEL}` } = {}) {
  pc.writePidCache(sid, CWD, {
    // Same live-pid requirement as mkResolver: a v1 whose pids are dead is not
    // promoted at all, so a dead fixture would silently skip the code under test.
    stablePid: process.pid, agentPid: process.ppid,
    agentCommandLine: cmd, detectedEditor: "code",
  });
  assert.match(pc.readPidCache(sid, CWD).agentCommandLine, /SUPER-SECRET/, "fixture precondition");
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Fresh resolve never persists the line
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 A2 — a fresh walk caches the boolean, never the command line", () => {
  it("start: the v2 file has headless and no trace of the sentinel", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    try {
      const meta = resolve(ctx(sid, "start"));
      assert.strictEqual(meta.headless, true, "derived in memory from the live walk");

      const raw = readV2Raw(sid);
      assert.ok(!raw.includes(SECRET_SENTINEL), "the sentinel must not reach disk");
      assert.ok(!raw.includes("--print"), "nor any fragment of the command line");
      assert.ok(!raw.includes("agentCommandLine"), "nor even the key");
      assert.strictEqual(JSON.parse(raw).headless, true);
    } finally { cleanup(); }
  });

  it("the v2 key set is exactly the fields something consumes", () => {
    // Pinned deliberately: every key here is data that lands on disk and
    // outlives the process. Adding one is a privacy decision, so make it fail
    // loudly rather than slip in during a refactor.
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    try {
      resolve(ctx(sid, "start"));
      assert.deepStrictEqual(Object.keys(JSON.parse(readV2Raw(sid))).sort(), [
        "agentPid", "cwd", "detectedEditor", "headless", "namespace", "stablePid", "ts", "version",
      ]);
    } finally { cleanup(); }
  });

  it("event miss repopulates v2 sanitized too (not just start)", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    try {
      resolve(ctx(sid, "event"));
      assert.ok(!readV2Raw(sid).includes(SECRET_SENTINEL));
    } finally { cleanup(); }
  });

  it("headless false is stored as false, not omitted — an absent boolean invalidates the entry", () => {
    const { resolve, cleanup } = mkResolver({ cmd: `node C:/x/claude-code/cli.js --token ${SECRET_SENTINEL}` });
    const sid = freshSid();
    try {
      const meta = resolve(ctx(sid, "start"));
      assert.strictEqual(meta.headless, false, "no -p/--print in this command line");
      assert.strictEqual(JSON.parse(readV2Raw(sid)).headless, false);
      assert.ok(!readV2Raw(sid).includes(SECRET_SENTINEL));
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD).headless, false, "and it still reads back as a hit");
    } finally { cleanup(); }
  });

  it("a cache hit carries the boolean and an EMPTY command line", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    try {
      resolve(ctx(sid, "start"));
      const hit = resolve(ctx(sid, "event"));
      assert.strictEqual(hit.cacheSource, "v2");
      assert.strictEqual(hit.headless, true, "headless survives the round-trip");
      assert.strictEqual(hit.agentCommandLine, "", "a hit must never reconstruct a command line");
    } finally { cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. v1 → v2 promotion launders the legacy line out
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 A2 — v1→v2 promotion derives in memory and removes the legacy file", () => {
  for (const lifecycle of ["prompt", "event"]) {
    it(`${lifecycle}: promotes with headless derived, writes no sentinel, deletes the v1`, () => {
      const { resolve, cleanup } = mkResolver();
      const sid = freshSid();
      plantLegacyV1(sid);
      try {
        const meta = resolve(ctx(sid, lifecycle));
        assert.strictEqual(meta.headless, true, "derived from the legacy line, in memory");
        assert.strictEqual(meta.agentCommandLine, "", "and the line itself does not ride along");

        const raw = readV2Raw(sid);
        assert.ok(!raw.includes(SECRET_SENTINEL), "the promoted v2 must be sanitized");
        assert.strictEqual(pc.readPidCache(sid, CWD), null, "and the legacy v1 must be gone");
      } finally { cleanup(); }
    });
  }

  it("a non-headless legacy line promotes to headless:false", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    plantLegacyV1(sid, { cmd: `node claude-code --token ${SECRET_SENTINEL}` });
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(meta.headless, false);
      assert.ok(!readV2Raw(sid).includes(SECRET_SENTINEL));
    } finally { cleanup(); }
  });

  it("end: the final body uses the legacy v1's derived boolean, then the file is gone", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    plantLegacyV1(sid);
    try {
      const meta = resolve(ctx(sid, "end"));
      assert.strictEqual(meta.headless, true);
      assert.strictEqual(meta.agentCommandLine, "");
      assert.strictEqual(pc.readPidCache(sid, CWD), null, "end drops the legacy v1");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "and creates no short-lived v2");
    } finally { cleanup(); }
  });

  it("start over a legacy v1: fresh walk wins, legacy file removed", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    plantLegacyV1(sid);
    try {
      resolve(ctx(sid, "start"));
      assert.ok(!readV2Raw(sid).includes(SECRET_SENTINEL));
      assert.strictEqual(pc.readPidCache(sid, CWD), null);
    } finally { cleanup(); }
  });

  it("a live v2 alongside a stray v1 collects the v1 on the next hit", (t) => {
    // The residual path: if a promotion's delete ever loses its race, nothing
    // else would collect the v1 — the sweep needs a dead pid, and this session's
    // are alive. So the hit path drops it.
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    try {
      resolve(ctx(sid, "start"));               // writes a sanitized v2
      plantLegacyV1(sid);                       // a v1 reappears next to it
      const hit = resolve(ctx(sid, "event"));   // straight v2 hit — promotion not involved
      assert.strictEqual(hit.cacheSource, "v2");
      assert.strictEqual(pc.readPidCache(sid, CWD), null,
        "a stray v1 must not survive alongside a live v2 — it is the only copy of the raw line");
    } finally { cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Privacy holds even when the write fails
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 A2 — a failed v2 write does not buy privacy back", () => {
  it("serves the event from memory, drops the v1 anyway, and never spawns", (t) => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    plantLegacyV1(sid);
    t.mock.method(pc, "writePidCacheV2IfAbsent", () => false);
    try {
      const meta = resolve(ctx(sid, "prompt"));
      assert.strictEqual(meta.headless, true, "the current event is unaffected");
      assert.strictEqual(meta.agentCommandLine, "");
      assert.strictEqual(pc.readPidCache(sid, CWD), null,
        "#681 §4.4.6: privacy first — the raw line goes even though nothing replaced it");
      assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "and no v2 landed");
    } finally { cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The reader refuses the pre-A2 shape outright
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 A2 — readPidCacheV2 rejects any v2 that still carries a command line", () => {
  it("a pre-A2 v2 (agentCommandLine, no headless) reads as a MISS, not a hit", () => {
    const sid = freshSid();
    fs.writeFileSync(pc.cacheFilePathV2(NS, sid, CWD), JSON.stringify({
      version: 2, namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2,
      agentCommandLine: `claude --print ${SECRET_SENTINEL}`, detectedEditor: "code", ts: Date.now(),
    }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null,
      "the sanitized boolean is mandatory — an old-shaped file is not a valid cache");
  });

  it("even a v2 carrying BOTH is projected down — the line can never escape the reader", () => {
    const sid = freshSid();
    fs.writeFileSync(pc.cacheFilePathV2(NS, sid, CWD), JSON.stringify({
      version: 2, namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2,
      headless: true, agentCommandLine: `claude --print ${SECRET_SENTINEL}`,
      detectedEditor: "code", ts: Date.now(),
    }));
    const got = pc.readPidCacheV2(NS, sid, CWD);
    assert.ok(got, "shape is otherwise valid");
    assert.ok(!("agentCommandLine" in got), "readPidCacheV2 returns a projection, not the parsed object");
    assert.ok(!JSON.stringify(got).includes(SECRET_SENTINEL));
    assert.strictEqual(got.headless, true);
  });

  it("the sweep treats a pre-A2 v2 as corrupt and collects it (given the age floor + dead pid)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    fs.writeFileSync(file, JSON.stringify({
      version: 2, namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2,
      agentCommandLine: `claude --print ${SECRET_SENTINEL}`, ts: Date.now(),
    }));
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(file, ancient, ancient);

    pc.sweepStalePidCaches({ isProcessAlive: () => true }); // alive pids: only the SHAPE can condemn it
    assert.strictEqual(fs.existsSync(file), false,
      "an old-shaped v2 must not be left sitting in %TEMP% just because its pids are alive");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Nothing writes a command line anywhere, on any path
// ═══════════════════════════════════════════════════════════════════════════

describe("#681 A2 — no file under the cache dir ever contains the sentinel", () => {
  it("after a full start → prompt → event → end lifecycle over a legacy v1", () => {
    const { resolve, cleanup } = mkResolver();
    const sid = freshSid();
    plantLegacyV1(sid);
    try {
      // The one legitimate carrier is the legacy v1 fixture itself; every file
      // written FROM here on must be clean, and the v1 must not survive.
      for (const lifecycle of ["start", "prompt", "event", "end"]) resolve(ctx(sid, lifecycle));

      const offenders = fs.readdirSync(ISO_DIR).filter((name) => {
        try { return fs.readFileSync(path.join(ISO_DIR, name), "utf8").includes(SECRET_SENTINEL); }
        catch { return false; }
      });
      assert.deepStrictEqual(offenders, [], "no cache file may contain the raw command line after the session");
    } finally { cleanup(); }
  });

  it("writePidCache — the only function that can still persist a line — has no callers left", () => {
    // It survives solely so migration tests can author legacy fixtures. If
    // production code starts calling it again, v1 files come back and A2 is
    // silently undone.
    const hooksDir = path.join(__dirname, "..", "hooks");
    const callers = fs.readdirSync(hooksDir)
      .filter((f) => f.endsWith(".js") && f !== "pid-cache.js")
      .filter((f) => /\bwritePidCache\s*\(/.test(fs.readFileSync(path.join(hooksDir, f), "utf8")));
    assert.deepStrictEqual(callers, [], "nothing in hooks/ may write a v1 cache any more (#681)");
  });
});
