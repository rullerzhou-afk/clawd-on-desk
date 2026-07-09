// test/pid-cache.test.js — Unit tests for hooks/pid-cache.js
// (#627, bounded sliding TTL §8)
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

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

  // agentPid shape tightened to REQUIRED positive integer (Codex NICE).
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

describe("pid-cache bounded sliding TTL (§8)", () => {
  it("fresh mtime + fresh ts (within both clocks) → hit", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    assert.ok(pc.readPidCache(sid, CWD));
  });

  it("idle-expired: mtime older than IDLE_TTL_MS → null (even with fresh ts)", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    const file = pc.cacheFilePath(sid, CWD);
    const old = (Date.now() - (pc.IDLE_TTL_MS + 1000)) / 1000;
    fs.utimesSync(file, old, old); // age mtime; JSON ts stays fresh
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("absolute-cap-expired: ts older than ABSOLUTE_CAP_MS → null (even with fresh mtime)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    // Stale ts, fresh mtime (writeFileSync stamps mtime = now).
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: CWD, ts: Date.now() - (pc.ABSOLUTE_CAP_MS + 1000) }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("touchPidCache bumps mtime but leaves ts unchanged", () => {
    const sid = freshSid();
    pc.writePidCache(sid, CWD, SUBSET);
    const file = pc.cacheFilePath(sid, CWD);
    const tsBefore = JSON.parse(fs.readFileSync(file, "utf8")).ts;
    const old = (Date.now() - (pc.IDLE_TTL_MS - 1000)) / 1000;
    fs.utimesSync(file, old, old);
    const mtimeAged = fs.statSync(file).mtimeMs;
    pc.touchPidCache(sid, CWD);
    assert.ok(fs.statSync(file).mtimeMs > mtimeAged, "touch must move mtime forward");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ts, tsBefore, "touch must NOT change ts");
  });

  // NB: we deliberately do NOT test "touch revives an idle-expired file". Under
  // utimesSync that mechanically works, but it is NOT the helper's contract:
  // touch is only ever called ON A HIT (readPidCache already passed), so a
  // genuinely-expired entry never reaches touch. Pinning revival as expected
  // behavior would mislead future callers. The hit-path renewal contract is
  // covered end-to-end in clawd-hook-pid-cache.test.js.

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
});

describe("pid-cache sweepStalePidCaches()", () => {
  it("removes only our prefix files idle past 2x IDLE_TTL_MS, keeps fresh ones", () => {
    const staleSid = freshSid();
    const freshSidId = freshSid();
    const staleFile = pc.cacheFilePath(staleSid, CWD);
    const freshFile = pc.cacheFilePath(freshSidId, CWD);
    pc.writePidCache(staleSid, CWD, SUBSET);
    pc.writePidCache(freshSidId, CWD, SUBSET);
    const old = (Date.now() - 3 * pc.IDLE_TTL_MS) / 1000;
    fs.utimesSync(staleFile, old, old);

    pc.sweepStalePidCaches();

    assert.strictEqual(fs.existsSync(staleFile), false, "stale (idle) file swept");
    assert.strictEqual(fs.existsSync(freshFile), true, "fresh file kept");
  });

  it("sweep keys off mtime, not ts: old ts + fresh mtime is kept", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    // Past absolute cap by ts, but mtime fresh (just written).
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: CWD, ts: Date.now() - 10 * pc.ABSOLUTE_CAP_MS }));
    pc.sweepStalePidCaches();
    assert.strictEqual(fs.existsSync(file), true, "sweep must key off mtime, not ts");
  });
});
