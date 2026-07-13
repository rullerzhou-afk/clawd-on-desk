// test/pid-cache.test.js — Unit tests for hooks/pid-cache.js
// (#627; lease rewrite #627-residual §4.4)
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const pc = require("../hooks/pid-cache");

const CWD = "/repo/pidcache-under-test";
let seq = 0;
const usedSids = [];
function freshSid() {
  const sid = `pidcache-test-${process.pid}-${seq++}`;
  usedSids.push(sid);
  return sid;
}

afterEach(() => {
  // Clean up any cache files these tests created.
  for (const sid of usedSids.splice(0)) pc.dropPidCache(sid, CWD);
});

// agentPid must be a positive integer: readPidCache now REQUIRES it (write
// condition already needs snapshotOk && agentPid; the hit path liveness-checks it).
const SUBSET = {
  stablePid: 1234,
  agentPid: 5678,
  agentCommandLine: "claude --print",
  detectedEditor: "code",
};

describe("pid-cache canCache()", () => {
  it("false for missing / default session id or empty cwd", () => {
    assert.strictEqual(pc.canCache("", CWD), false);
    assert.strictEqual(pc.canCache(null, CWD), false);
    assert.strictEqual(pc.canCache("default", CWD), false);
    assert.strictEqual(pc.canCache("real-sid", ""), false);
  });

  it("true for a real session id + cwd", () => {
    assert.strictEqual(pc.canCache("real-sid", CWD), true);
  });
});

describe("pid-cache cacheFilePath()", () => {
  it("returns null when caching is disabled", () => {
    assert.strictEqual(pc.cacheFilePath("default", CWD), null);
    assert.strictEqual(pc.cacheFilePath("sid", ""), null);
  });

  it("is stable for the same (sid, cwd) and differs across sessions", () => {
    const a = pc.cacheFilePath("sid-A", CWD);
    const a2 = pc.cacheFilePath("sid-A", CWD);
    const b = pc.cacheFilePath("sid-B", CWD);
    assert.strictEqual(a, a2);
    assert.notStrictEqual(a, b);
    assert.ok(a.includes(pc.CACHE_PREFIX));
  });
});

describe("pid-cache read/write/drop", () => {
  it("round-trips the stable subset with cwd + ts stamped", () => {
    const sid = freshSid();
    assert.strictEqual(pc.writePidCache(sid, CWD, SUBSET), true);
    const got = pc.readPidCache(sid, CWD);
    assert.ok(got);
    assert.strictEqual(got.stablePid, 1234);
    assert.strictEqual(got.agentPid, 5678);
    assert.strictEqual(got.agentCommandLine, "claude --print");
    assert.strictEqual(got.detectedEditor, "code");
    assert.strictEqual(got.cwd, CWD);
    assert.strictEqual(typeof got.ts, "number");
  });

  it("writePidCache is a no-op (false) when caching is disabled", () => {
    assert.strictEqual(pc.writePidCache("default", CWD, SUBSET), false);
    assert.strictEqual(pc.writePidCache("sid", "", SUBSET), false);
    assert.strictEqual(pc.readPidCache("default", CWD), null);
  });

  it("readPidCache returns null after drop", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    pc.dropPidCache(sid, CWD);
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("dropPidCache on a missing file does not throw", () => {
    assert.doesNotThrow(() => pc.dropPidCache(freshSid(), CWD));
  });

  it("readPidCache returns null on a missing file (no throw)", () => {
    assert.strictEqual(pc.readPidCache(freshSid(), CWD), null);
  });

  it("readPidCache returns null when the stored cwd disagrees (second identity guard)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: "/some/other/cwd", ts: Date.now() }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("readPidCache tolerates a corrupt file (null, no throw)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, "{ not json");
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  // agentPid shape tightened to REQUIRED positive integer (Codex NICE, 630 plan §8).
  it("readPidCache returns null when agentPid is missing or non-positive", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, JSON.stringify({ stablePid: 1234, cwd: CWD, ts: Date.now() }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null, "missing agentPid → null");
    fs.writeFileSync(file, JSON.stringify({ stablePid: 1234, agentPid: 0, cwd: CWD, ts: Date.now() }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null, "agentPid 0 → null");
    fs.writeFileSync(file, JSON.stringify({ stablePid: 1234, agentPid: -5, cwd: CWD, ts: Date.now() }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null, "negative agentPid → null");
  });
});

describe("pid-cache lease semantics (#627 residual §4.4): reads consult NO clock", () => {
  it("a freshly-written entry is a hit", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    assert.ok(pc.readPidCache(sid, CWD));
  });

  it("an ancient mtime does not expire the read (mtime is not consulted at all)", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    const file = pc.cacheFilePath(sid, CWD);
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
    fs.utimesSync(file, ancient, ancient);
    assert.ok(pc.readPidCache(sid, CWD), "mtime age must never expire a read under the lease model");
  });

  it("an ancient ts does not expire the read (ts is debug-only, not a validity clock)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: CWD, ts: Date.now() - 30 * 24 * 60 * 60 * 1000 }));
    assert.ok(pc.readPidCache(sid, CWD), "ts age must never expire a read under the lease model");
  });

  it("both mtime and ts ancient simultaneously is still a hit (shape + cwd only)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    const veryOld = Date.now() - 365 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: CWD, ts: veryOld }));
    const oldDate = new Date(veryOld);
    fs.utimesSync(file, oldDate, oldDate);
    const got = pc.readPidCache(sid, CWD);
    assert.ok(got);
    assert.strictEqual(got.stablePid, 1234);
    assert.strictEqual(got.agentPid, 5678);
  });

  it("touchPidCache bumps mtime but leaves ts unchanged", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    const file = pc.cacheFilePath(sid, CWD);
    const tsBefore = JSON.parse(fs.readFileSync(file, "utf8")).ts;
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(file, old, old);
    const mtimeAged = fs.statSync(file).mtimeMs;
    pc.touchPidCache(sid, CWD);
    assert.ok(fs.statSync(file).mtimeMs > mtimeAged, "touch must move mtime forward");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ts, tsBefore, "touch must NOT change ts");
  });

  it("touchPidCache does not create a missing file (SessionEnd drop race)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    assert.doesNotThrow(() => pc.touchPidCache(sid, CWD));
    assert.strictEqual(fs.existsSync(file), false, "touch must not create a missing file");
  });

  it("touchPidCache is a no-op when caching is disabled", () => {
    assert.doesNotThrow(() => pc.touchPidCache("default", CWD));
    assert.doesNotThrow(() => pc.touchPidCache("sid", ""));
  });

  it("no longer exports IDLE_TTL_MS / ABSOLUTE_CAP_MS (deleted per the lease rewrite)", () => {
    assert.strictEqual(pc.IDLE_TTL_MS, undefined);
    assert.strictEqual(pc.ABSOLUTE_CAP_MS, undefined);
    assert.strictEqual(typeof pc.SWEEP_AGE_MS, "number");
  });
});

describe("pid-cache sweepStalePidCaches() — age floor + injected liveness (§4.4)", () => {
  function alwaysAlive() { return true; }
  function neverAlive() { return false; }

  it("young file (mtime within SWEEP_AGE_MS) is skipped without even consulting liveness", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET); // fresh mtime
    let livenessCalls = 0;
    pc.sweepStalePidCaches({ isProcessAlive: () => { livenessCalls++; return false; } });
    assert.strictEqual(fs.existsSync(file), true, "young file must be skipped regardless of liveness");
    assert.strictEqual(livenessCalls, 0, "the age floor must short-circuit before liveness is ever checked");
  });

  it("old + both PIDs alive → kept", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({ isProcessAlive: alwaysAlive });

    assert.strictEqual(fs.existsSync(file), true, "old-but-alive file must survive — age alone never deletes");
  });

  it("old + either PID dead → deleted", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({ isProcessAlive: neverAlive });

    assert.strictEqual(fs.existsSync(file), false, "old + dead PID must be swept");
  });

  it("old + stablePid alive but agentPid dead → deleted (either death is enough)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({
      isProcessAlive: (pid) => pid === SUBSET.stablePid, // agentPid (5678) reports dead
    });

    assert.strictEqual(fs.existsSync(file), false);
  });

  it("old + corrupt shape → deleted regardless of liveness", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, "{ not json");
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({ isProcessAlive: alwaysAlive });

    assert.strictEqual(fs.existsSync(file), false, "corrupt shape is always treated as dead, even if isProcessAlive would say alive");
  });

  it("P2 race: a file replaced between the death verdict and the unlink survives", () => {
    // Simulates: sweep judges the OLD file dead, but a concurrent
    // SessionStart's writePidCache atomically replaces it before the unlink.
    // The injected liveness callback runs exactly in that window (after the
    // sweep has read the old JSON, before it deletes), so replacing the file
    // inside it reproduces the race deterministically. The pre-unlink mtime
    // re-check must notice the replacement and keep the NEW file — deleting
    // it would strand a cache-only prompt/end (they never re-resolve) until
    // the next ordinary event's miss-fallback, i.e. one avoidable flash.
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({
      isProcessAlive: () => {
        pc.writePidCache(sid, CWD, SUBSET); // concurrent SessionStart rewrite (fresh mtime)
        return false; // and the old file's PIDs report dead
      },
    });

    assert.strictEqual(fs.existsSync(file), true, "the replacement written mid-sweep must survive the unlink");
    assert.ok(pc.readPidCache(sid, CWD), "the new cache entry must still be readable after the sweep");
  });

  it("defaults isProcessAlive to always-alive when not injected (never deletes purely on age)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);

    pc.sweepStalePidCaches({}); // no isProcessAlive passed

    assert.strictEqual(fs.existsSync(file), true, "without injected liveness, age-only can never delete a shape-valid file");
  });

  it("ignores files outside our prefix", () => {
    const dir = require("os").tmpdir();
    const foreignFile = path.join(dir, `not-clawd-${process.pid}-${seq++}.json`);
    fs.writeFileSync(foreignFile, "{}");
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(foreignFile, old, old);
    try {
      pc.sweepStalePidCaches({ isProcessAlive: neverAlive });
      assert.strictEqual(fs.existsSync(foreignFile), true, "sweep must not touch files outside its own prefix");
    } finally {
      try { fs.unlinkSync(foreignFile); } catch {}
    }
  });

  it("accepts an explicit nowMs for deterministic age-floor math", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    pc.writePidCache(sid, CWD, SUBSET);
    const writtenMtime = fs.statSync(file).mtimeMs;
    // "now" far enough in the future that the file looks old relative to it.
    const future = writtenMtime + pc.SWEEP_AGE_MS + 60_000;
    pc.sweepStalePidCaches({ nowMs: future, isProcessAlive: neverAlive });
    assert.strictEqual(fs.existsSync(file), false);
  });
});

describe("pid-cache module boundary (#627 residual §4.4)", () => {
  it("does not require ./shared-process (would create a PR2 circular dependency)", () => {
    const src = fs.readFileSync(require.resolve("../hooks/pid-cache.js"), "utf8");
    assert.ok(
      !/require\(["']\.\/shared-process["']\)/.test(src),
      "pid-cache.js must stay independent of shared-process.js — liveness is dependency-injected instead"
    );
    // Cross-check via the actual module graph too, not just source text.
    const key = require.resolve("../hooks/pid-cache.js");
    delete require.cache[key];
    require("../hooks/pid-cache.js");
    const sharedProcessKey = require.resolve("../hooks/shared-process.js");
    const loadedChildren = (require.cache[key].children || []).map((c) => c.id);
    assert.ok(
      !loadedChildren.includes(sharedProcessKey),
      "pid-cache.js's module.children must not include shared-process.js"
    );
  });
});
