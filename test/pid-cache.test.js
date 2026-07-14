// test/pid-cache.test.js — Unit tests for hooks/pid-cache.js
// (#627; lease rewrite #627-residual §4.4; v2 #634)
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pc = require("../hooks/pid-cache");

// Isolate the cache directory for this whole file (#634): the sweep and its
// fake-liveness tests would otherwise scan the shared os.tmpdir() — interfering
// with concurrently-running test PROCESSES and deleting a developer's real >24h
// caches. With an isolated dir, each sweep only ever sees this file's own files.
let ISO_DIR;
before(() => {
  ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pidcache-test-iso-"));
  pc.__setCacheDirForTests(ISO_DIR);
});
after(() => {
  pc.__setCacheDirForTests(null);
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
});

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

describe("pid-cache readPidCacheEntry — single-observation subset + identity (#634 §5.5)", () => {
  it("returns a subset and identity read from the SAME bytes", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    const entry = pc.readPidCacheEntry(sid, CWD);
    assert.ok(entry);
    // The whole point: the parsed subset and the delete-guard identity are the
    // same observation, so identity.raw must parse back to the subset exactly.
    assert.deepStrictEqual(JSON.parse(entry.identity.raw), entry.subset);
    assert.strictEqual(entry.subset.stablePid, 1234);
    assert.strictEqual(entry.subset.agentPid, 5678);
    assert.strictEqual(entry.identity.size, Buffer.byteLength(entry.identity.raw));
    assert.strictEqual(typeof entry.identity.mtimeMs, "number");
  });

  it("returns null when caching is disabled / file missing / shape invalid", () => {
    assert.strictEqual(pc.readPidCacheEntry("default", CWD), null, "caching disabled");
    assert.strictEqual(pc.readPidCacheEntry(freshSid(), CWD), null, "missing file");
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, "{ not json");
    assert.strictEqual(pc.readPidCacheEntry(sid, CWD), null, "corrupt file");
    fs.writeFileSync(file, JSON.stringify({ stablePid: 1, cwd: CWD, ts: Date.now() }));
    assert.strictEqual(pc.readPidCacheEntry(sid, CWD), null, "missing agentPid → shape invalid");
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: "/other", ts: Date.now() }));
    assert.strictEqual(pc.readPidCacheEntry(sid, CWD), null, "cwd mismatch");
  });

  it("readPidCache and readPidCacheEntry agree on the same file", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    assert.deepStrictEqual(pc.readPidCacheEntry(sid, CWD).subset, pc.readPidCache(sid, CWD));
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
    const dir = ISO_DIR; // the sweep/cache scan this isolated dir, not the real temp dir
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

// ═══════════════════════════════════════════════════════════════════════════
// Cache v2 (#634): namespaced, versioned, non-overlapping prefix.
// ═══════════════════════════════════════════════════════════════════════════

const NS = "claude-code";
const usedV2 = [];
function freshSidV2() {
  const sid = `pidcache2-test-${process.pid}-${seq++}`;
  usedV2.push(sid);
  return sid;
}
afterEach(() => {
  for (const sid of usedV2.splice(0)) pc.dropPidCacheV2(NS, sid, CWD);
});

const SUBSET_V2 = {
  stablePid: 4321,
  agentPid: 8765,
  agentCommandLine: "claude --print",
  detectedEditor: "code",
};

describe("pid-cache v2 — path + key (§5.2)", () => {
  it("v1 and v2 prefixes are mutually exclusive under startsWith (clean sweep classification)", () => {
    assert.strictEqual(pc.CACHE_PREFIX_V2.startsWith(pc.CACHE_PREFIX), false);
    assert.strictEqual(pc.CACHE_PREFIX.startsWith(pc.CACHE_PREFIX_V2), false);
    assert.strictEqual(pc.CACHE_PREFIX_V2, "clawd-pidcache2-");
    assert.strictEqual(pc.CACHE_VERSION_V2, 2);
  });

  it("cacheFilePathV2 returns null when any identity ingredient is empty", () => {
    assert.strictEqual(pc.cacheFilePathV2("", "sid", CWD), null);
    assert.strictEqual(pc.cacheFilePathV2(NS, "", CWD), null);
    assert.strictEqual(pc.cacheFilePathV2(NS, "sid", ""), null);
  });

  it("v2 path uses the clawd-pidcache2- prefix and is stable per (namespace, sid, cwd)", () => {
    const a = pc.cacheFilePathV2(NS, "sid-A", CWD);
    const a2 = pc.cacheFilePathV2(NS, "sid-A", CWD);
    assert.strictEqual(a, a2);
    assert.ok(path.basename(a).startsWith(pc.CACHE_PREFIX_V2));
  });

  it("the key varies with version+namespace+sessionId+cacheCwd (NUL-separated, no cross-field collision)", () => {
    // namespace is in the key: two agents that share a sid+cwd never collide.
    assert.notStrictEqual(pc.cacheFilePathV2("gemini", "sid", CWD), pc.cacheFilePathV2("qoder", "sid", CWD));
    // sessionId and cacheCwd both participate.
    assert.notStrictEqual(pc.cacheFilePathV2(NS, "sid-A", CWD), pc.cacheFilePathV2(NS, "sid-B", CWD));
    assert.notStrictEqual(pc.cacheFilePathV2(NS, "sid", "/a"), pc.cacheFilePathV2(NS, "sid", "/b"));
    // NUL separators mean "a"+"bc" and "ab"+"c" cannot alias.
    assert.notStrictEqual(pc.cacheFilePathV2(NS, "a", "bc"), pc.cacheFilePathV2(NS, "ab", "c"));
    // v1 and v2 of the same (sid, cwd) never share a file.
    assert.notStrictEqual(pc.cacheFilePath("sid", CWD), pc.cacheFilePathV2(NS, "sid", CWD));
  });
});

describe("pid-cache v2 — read/write/shape", () => {
  it("round-trips the v2 shape: version + namespace + cwd + ts, and NO pidChain/foregroundWtHwnd/tmuxClient", () => {
    const sid = freshSidV2();
    assert.strictEqual(pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2), true);
    const got = pc.readPidCacheV2(NS, sid, CWD);
    assert.ok(got);
    assert.strictEqual(got.version, 2);
    assert.strictEqual(got.namespace, NS);
    assert.strictEqual(got.cwd, CWD);
    assert.strictEqual(got.stablePid, 4321);
    assert.strictEqual(got.agentPid, 8765);
    assert.strictEqual(got.agentCommandLine, "claude --print");
    assert.strictEqual(got.detectedEditor, "code");
    assert.strictEqual(typeof got.ts, "number");
    // Only the stable subset is cached — the volatile fields never touch disk.
    assert.ok(!("pidChain" in got), "pidChain must never be cached");
    assert.ok(!("foregroundWtHwnd" in got), "foregroundWtHwnd must never be cached");
    assert.ok(!("tmuxClient" in got), "tmuxClient must never be cached");
  });

  it("different namespaces never read each other's cache (even at the same sid+cwd)", () => {
    const sid = freshSidV2();
    pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2);
    assert.ok(pc.readPidCacheV2(NS, sid, CWD), "own namespace hits");
    assert.strictEqual(pc.readPidCacheV2("gemini", sid, CWD), null, "another namespace must miss");
    pc.dropPidCacheV2("gemini", sid, CWD); // no-op cleanup
  });

  it("readPidCacheV2 rejects version / namespace / cwd mismatch and non-positive pids", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    const base = { namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2, ts: Date.now() };
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 1 }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "wrong version → null");
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 2, namespace: "gemini" }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "stored namespace mismatch → null");
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 2, cwd: "/other" }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "cwd mismatch → null");
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 2, agentPid: 0 }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "non-positive agentPid → null");
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 2, stablePid: -1 }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "negative stablePid → null");
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 2, ts: "not-a-number" }));
    assert.strictEqual(pc.readPidCacheV2(NS, sid, CWD), null, "non-number ts → null (mirrors v1 shape guard)");
  });

  it("v2 read consults NO clock (ancient mtime + ts is still a hit)", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    fs.writeFileSync(file, JSON.stringify({ version: 2, namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2, ts: Date.now() - 365 * 24 * 60 * 60 * 1000 }));
    const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, ancient, ancient);
    assert.ok(pc.readPidCacheV2(NS, sid, CWD), "age must never expire a v2 read under the lease model");
  });

  it("touch/drop v2 behave like v1 (touch bumps mtime, never creates; drop removes)", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    assert.doesNotThrow(() => pc.touchPidCacheV2(NS, sid, CWD)); // missing file: no-op, no create
    assert.strictEqual(fs.existsSync(file), false);
    pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(file, old, old);
    const aged = fs.statSync(file).mtimeMs;
    pc.touchPidCacheV2(NS, sid, CWD);
    assert.ok(fs.statSync(file).mtimeMs > aged, "touch bumps mtime");
    pc.dropPidCacheV2(NS, sid, CWD);
    assert.strictEqual(fs.existsSync(file), false);
  });
});

describe("pid-cache v2 — writePidCacheV2IfAbsent (no-clobber promotion, §5.5/§6.10)", () => {
  it("returns 'created' and writes the file when absent", () => {
    const sid = freshSidV2();
    assert.strictEqual(pc.writePidCacheV2IfAbsent(NS, sid, CWD, SUBSET_V2), "created");
    assert.ok(pc.readPidCacheV2(NS, sid, CWD));
  });

  it("returns 'exists' and NEVER overwrites an already-present file", () => {
    const sid = freshSidV2();
    pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2); // pre-existing (the 'fresh' one)
    const result = pc.writePidCacheV2IfAbsent(NS, sid, CWD, {
      stablePid: 111, agentPid: 222, agentCommandLine: "STALE", detectedEditor: "vim",
    });
    assert.strictEqual(result, "exists", "must report the file already exists");
    const got = pc.readPidCacheV2(NS, sid, CWD);
    assert.strictEqual(got.agentCommandLine, "claude --print", "the pre-existing file must NOT be overwritten");
    assert.strictEqual(got.agentPid, 8765);
  });

  it("returns false (no throw) when caching is disabled", () => {
    assert.strictEqual(pc.writePidCacheV2IfAbsent(NS, "sid", "", SUBSET_V2), false);
    assert.strictEqual(pc.writePidCacheV2IfAbsent("", "sid", CWD, SUBSET_V2), false);
  });

  it("leaves no leftover temp files after a successful create", () => {
    const sid = freshSidV2();
    pc.writePidCacheV2IfAbsent(NS, sid, CWD, SUBSET_V2);
    const dir = ISO_DIR; // the sweep/cache scan this isolated dir, not the real temp dir
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".nc.tmp"));
    assert.deepStrictEqual(leftovers, [], "the sibling temp must be unlinked after linking");
  });
});

describe("pid-cache sweep — dual prefix v1 + v2 (§5.4)", () => {
  function neverAlive() { return false; }
  function alwaysAlive() { return true; }

  it("sweeps an old dead v2 file", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);
    pc.sweepStalePidCaches({ isProcessAlive: neverAlive });
    assert.strictEqual(fs.existsSync(file), false, "old + dead v2 must be swept");
  });

  it("keeps an old but alive v2 file (age alone never deletes)", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    pc.writePidCacheV2(NS, sid, CWD, SUBSET_V2);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);
    pc.sweepStalePidCaches({ isProcessAlive: alwaysAlive });
    assert.strictEqual(fs.existsSync(file), true, "old-but-alive v2 must survive");
  });

  it("classifies v1 and v2 independently in one pass (both dead → both swept)", () => {
    const sid1 = freshSid(); // v1 uses the v1 cleanup list
    const sid2 = freshSidV2();
    const v1File = pc.cacheFilePath(sid1, CWD);
    const v2File = pc.cacheFilePathV2(NS, sid2, CWD);
    pc.writePidCache(sid1, CWD, SUBSET);
    pc.writePidCacheV2(NS, sid2, CWD, SUBSET_V2);
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(v1File, old, old);
    fs.utimesSync(v2File, old, old);
    pc.sweepStalePidCaches({ isProcessAlive: neverAlive });
    assert.strictEqual(fs.existsSync(v1File), false, "dead v1 swept");
    assert.strictEqual(fs.existsSync(v2File), false, "dead v2 swept");
  });

  it("a v2-prefixed file missing version:2 is corrupt → swept when old, even if PIDs report alive", () => {
    const sid = freshSidV2();
    const file = pc.cacheFilePathV2(NS, sid, CWD);
    // shape looks alive but lacks the v2 version tag → corrupt for a v2 file.
    fs.writeFileSync(file, JSON.stringify({ namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2, ts: Date.now() }));
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    fs.utimesSync(file, old, old);
    pc.sweepStalePidCaches({ isProcessAlive: alwaysAlive });
    assert.strictEqual(fs.existsSync(file), false, "a v2 file without version:2 is treated as dead");
  });

  it("a v2 file with a malformed namespace/cwd/ts is corrupt → swept when old (full v2 shape)", () => {
    const old = new Date(Date.now() - (pc.SWEEP_AGE_MS + 60_000));
    for (const bad of [
      { version: 2, cwd: CWD, stablePid: 1, agentPid: 2, ts: Date.now() },              // missing namespace
      { version: 2, namespace: NS, stablePid: 1, agentPid: 2, ts: Date.now() },          // missing cwd
      { version: 2, namespace: NS, cwd: CWD, stablePid: 1, agentPid: 2 },                // missing ts
      { version: 2, namespace: "", cwd: CWD, stablePid: 1, agentPid: 2, ts: Date.now() },// empty namespace
    ]) {
      const sid = freshSidV2();
      const file = pc.cacheFilePathV2(NS, sid, CWD);
      fs.writeFileSync(file, JSON.stringify(bad));
      fs.utimesSync(file, old, old);
      pc.sweepStalePidCaches({ isProcessAlive: alwaysAlive });
      assert.strictEqual(fs.existsSync(file), false, `malformed v2 shape must be swept: ${JSON.stringify(bad)}`);
    }
  });
});
