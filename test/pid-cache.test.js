// test/pid-cache.test.js — Unit tests for hooks/pid-cache.js (#627)
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

  it("readPidCache returns null past the TTL", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    // Write a file directly with a stale timestamp.
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: CWD, ts: Date.now() - (pc.CACHE_TTL_MS + 1000) }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("readPidCache returns null when the stored cwd disagrees (second identity guard)", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, JSON.stringify({ ...SUBSET, cwd: "/some/other/cwd", ts: Date.now() }));
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });

  it("readPidCache tolerates a corrupt file", () => {
    const sid = freshSid();
    const file = pc.cacheFilePath(sid, CWD);
    fs.writeFileSync(file, "{ not json");
    assert.strictEqual(pc.readPidCache(sid, CWD), null);
  });
});

describe("pid-cache sweepStalePidCaches()", () => {
  it("removes only our own prefix files older than 2x TTL, keeps fresh ones", () => {
    const staleSid = freshSid();
    const freshSidId = freshSid();
    const staleFile = pc.cacheFilePath(staleSid, CWD);
    const freshFile = pc.cacheFilePath(freshSidId, CWD);
    pc.writePidCache(staleSid, CWD, SUBSET);
    pc.writePidCache(freshSidId, CWD, SUBSET);
    // Age the stale one well past 2x TTL via mtime.
    const old = (Date.now() - 3 * pc.CACHE_TTL_MS) / 1000;
    fs.utimesSync(staleFile, old, old);

    pc.sweepStalePidCaches();

    assert.strictEqual(fs.existsSync(staleFile), false, "stale file swept");
    assert.strictEqual(fs.existsSync(freshFile), true, "fresh file kept");
  });
});
