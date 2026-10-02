"use strict";

// #1026 r1 ownership / integrity / transaction hardening:
//   - indeterminate nearest-ancestor + Windows volume-root failure
//   - realpath-failure must not grant ownership
//   - owner-record validation and bounded knownRegisteredPaths
//   - lock record validation and stale takeover
//   - inspectGeneration content-address strictness
//   - complete-plan validation before any destructive write

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, afterEach } = require("node:test");

const mg = require("../hooks/opencode-family-managed-generation");
const ownership = require("../hooks/opencode-family-entry-ownership");
const jsonc = require("../hooks/opencode-family-jsonc");
const { getFamilyConfig } = require("../agents/opencode-family");

const OPENCODE_CFG = getFamilyConfig("opencode");
const tempDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeTarget(home) {
  return mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
}

describe("#1026 r1 missingPathStillAbsent hardening", () => {
  it("treats a non-ENOENT ancestor stat error as indeterminate", () => {
    const specifier = "/root/blocked/opencode-plugin";
    const fakeFs = {
      statSync(value) {
        if (value === specifier) { const e = new Error("gone"); e.code = "ENOENT"; throw e; }
        if (value === "/root/blocked" || value === "/root") { const e = new Error("denied"); e.code = "EACCES"; throw e; }
        const e = new Error("gone"); e.code = "ENOENT"; throw e;
      },
      readdirSync() { return []; },
    };
    const result = jsonc.missingPathStillAbsent(specifier, { fs: fakeFs, platform: "linux" });
    assert.strictEqual(result.absent, false);
    assert.match(result.reason, /ancestor-stat-EACCES|no-existing-ancestor/);
  });

  it("fails closed when the Windows volume root cannot be enumerated", () => {
    const specifier = "C:\\nope\\opencode-plugin";
    const fakeFs = {
      statSync() { const e = new Error("gone"); e.code = "ENOENT"; throw e; },
      readdirSync(value) {
        if (value === "C:\\") { const e = new Error("denied"); e.code = "EPERM"; throw e; }
        if (value === "c:\\") { const e = new Error("denied"); e.code = "EPERM"; throw e; }
        return [];
      },
    };
    const result = jsonc.missingPathStillAbsent(specifier, { fs: fakeFs, platform: "win32" });
    assert.strictEqual(result.absent, false);
    assert.match(result.reason, /volume-root-unreadable|ancestor/);
  });
});

describe("#1026 r1 realpath failure never grants ownership", () => {
  const baseCtx = {
    pluginDirName: "opencode-plugin",
    expectedCanonicalDir: "/expected/opencode-plugin",
    targetRoot: null,
    sourcePluginDir: null,
    knownRegisteredPaths: new Set(),
    canonicalize: (p) => String(p).replace(/\\/g, "/"),
    exists: () => true,
    probeIndeterminate: () => false,
    inspectExpectedGeneration: () => ({ ok: true }),
    inspectManagedBoundary: () => ({ state: "corrupt" }),
    bundleBytesMatch: () => false,
    isClawdLike: () => true,
  };

  it("classifies an existing entry whose realpath cannot resolve as unknown", () => {
    const result = ownership.classifyPluginEntries(["/alias/opencode-plugin"], {
      ...baseCtx,
      canonicalizeStrict: () => null,
    });
    assert.strictEqual(result.entries[0].category, "unknown");
    assert.strictEqual(result.entries[0].reason, "realpath-unresolved");
  });

  it("still allows a resolved existing entry to classify normally", () => {
    const result = ownership.classifyPluginEntries(["/alias/opencode-plugin"], {
      ...baseCtx,
      canonicalizeStrict: (p) => String(p).replace(/\\/g, "/"),
    });
    assert.strictEqual(result.entries[0].category, "clawd-like-modified");
  });
});

describe("#1026 r1 owner record validation", () => {
  const OWNER_OPTS = { platform: process.platform, pluginDirName: "opencode-plugin" };
  function writeOwner(target, record) {
    fs.mkdirSync(target.targetRoot, { recursive: true });
    fs.writeFileSync(target.ownerPath, JSON.stringify(record, null, 2));
  }
  function readOwner(target) {
    return mg.readOwnerRecord(target, "opencode", fs, OWNER_OPTS);
  }
  function baseRecord(target) {
    return {
      schema: 1,
      owner: "clawd-on-desk.opencode-family.target",
      agentId: "opencode",
      canonicalConfigDir: target.canonicalConfigDir,
      configDirHash: target.configDirHash,
      activeSourceRoot: "C:/src",
      activeSourceMarker: "C:/src/opencode-plugin/index.mjs",
      knownRegisteredPaths: [],
      updatedAt: "x",
    };
  }

  it("rejects a record missing canonicalConfigDir", () => {
    const target = makeTarget(tmp("clawd-own-val-"));
    const record = baseRecord(target);
    delete record.canonicalConfigDir;
    writeOwner(target, record);
    assert.strictEqual(readOwner(target).state, "corrupt");
  });

  it("rejects a configDirHash that does not hash canonicalConfigDir", () => {
    const target = makeTarget(tmp("clawd-own-hash-"));
    const record = baseRecord(target);
    record.configDirHash = "b".repeat(64);
    writeOwner(target, record);
    assert.strictEqual(readOwner(target).state, "corrupt");
  });

  it("rejects a marker outside the plugin directory or the source root", () => {
    const target = makeTarget(tmp("clawd-own-pair-"));
    const record = baseRecord(target);
    record.activeSourceMarker = "C:/src/index.mjs"; // wrong plugin dir
    writeOwner(target, record);
    assert.strictEqual(readOwner(target).state, "corrupt");

    const target2 = makeTarget(tmp("clawd-own-pair2-"));
    const record2 = baseRecord(target2);
    record2.activeSourceMarker = "C:/other/opencode-plugin/index.mjs"; // wrong root
    writeOwner(target2, record2);
    assert.strictEqual(readOwner(target2).state, "corrupt");

    const target3 = makeTarget(tmp("clawd-own-pair3-"));
    const record3 = baseRecord(target3);
    record3.activeSourceMarker = "C:/src/mimocode-plugin/index.mjs"; // wrong agent plugin dir
    writeOwner(target3, record3);
    assert.strictEqual(readOwner(target3).state, "corrupt");
  });

  it("reads a released record (both source fields null) as released, not ok", () => {
    const target = makeTarget(tmp("clawd-own-rel-"));
    const record = baseRecord(target);
    record.activeSourceRoot = null;
    record.activeSourceMarker = null;
    writeOwner(target, record);
    assert.strictEqual(readOwner(target).state, "released");
  });

  it("compares source identity canonically for read and release (Windows case/alias folded)", () => {
    const target = makeTarget(tmp("clawd-own-canon-"));
    mg.writeOwnerRecord(target, {
      agentId: "opencode",
      activeSourceRoot: "C:/Src",
      activeSourceMarker: "C:/Src/opencode-plugin/index.mjs",
      knownRegisteredPaths: [],
    }, fs, { platform: process.platform });
    if (process.platform === "win32") {
      // Case-different marker still validates structurally on Windows.
      const record = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
      record.activeSourceMarker = "c:\\SRC\\opencode-plugin\\INDEX.MJS";
      fs.writeFileSync(target.ownerPath, JSON.stringify(record, null, 2));
      assert.strictEqual(readOwner(target).state, "owned");
    }
    const release = mg.releaseOwnerRecord(
      target,
      "opencode",
      "c:\\src",
      "C:\\src\\opencode-plugin\\index.mjs",
      fs,
      OWNER_OPTS
    );
    if (process.platform === "win32") {
      assert.strictEqual(release.released, true);
      assert.strictEqual(readOwner(target).state, "released");
    } else {
      assert.strictEqual(release.released, false);
      assert.strictEqual(release.state, "other-source");
    }
  });

  it("rejects an over-cap, empty or relative history", () => {
    const over = makeTarget(tmp("clawd-own-over-"));
    const overRecord = baseRecord(over);
    overRecord.knownRegisteredPaths = Array.from({ length: mg.KNOWN_PATH_LIMIT + 1 }, (_, i) => `/managed/${i}/opencode-plugin`);
    writeOwner(over, overRecord);
    assert.strictEqual(readOwner(over).state, "corrupt");

    const empty = makeTarget(tmp("clawd-own-empty-"));
    const emptyRecord = baseRecord(empty);
    emptyRecord.knownRegisteredPaths = [""];
    writeOwner(empty, emptyRecord);
    assert.strictEqual(readOwner(empty).state, "corrupt");

    const rel = makeTarget(tmp("clawd-own-relp-"));
    const relRecord = baseRecord(rel);
    relRecord.knownRegisteredPaths = ["relative/opencode-plugin"];
    writeOwner(rel, relRecord);
    assert.strictEqual(readOwner(rel).state, "corrupt");

    const dup = makeTarget(tmp("clawd-own-dup-"));
    const dupRecord = baseRecord(dup);
    dupRecord.knownRegisteredPaths = ["/managed/a/opencode-plugin", "/managed/A/opencode-plugin"];
    writeOwner(dup, dupRecord);
    if (process.platform === "win32") {
      assert.strictEqual(readOwner(dup).state, "corrupt");
    }
  });

  it("accepts a valid capped history and preserves foreign/corrupt bytes", () => {
    const target = makeTarget(tmp("clawd-own-capok-"));
    const record = baseRecord(target);
    record.knownRegisteredPaths = Array.from({ length: mg.KNOWN_PATH_LIMIT }, (_, i) => `/managed/${i}/opencode-plugin`);
    writeOwner(target, record);
    assert.strictEqual(readOwner(target).state, "owned");

    const foreign = makeTarget(tmp("clawd-own-foreign-"));
    fs.mkdirSync(foreign.targetRoot, { recursive: true });
    fs.writeFileSync(foreign.ownerPath, "{ not json");
    const before = fs.readFileSync(foreign.ownerPath, "utf8");
    assert.strictEqual(readOwner(foreign).state, "corrupt");
    assert.strictEqual(fs.readFileSync(foreign.ownerPath, "utf8"), before);
  });

  it("always retains the newly registered path and evicts oldest history at the cap", () => {
    const target = makeTarget(tmp("clawd-own-cap-"));
    for (let i = 0; i < mg.KNOWN_PATH_LIMIT + 5; i++) {
      mg.writeOwnerRecord(target, {
        agentId: "opencode",
        activeSourceRoot: "C:/src",
        activeSourceMarker: "C:/src/opencode-plugin/index.mjs",
        knownRegisteredPaths: [`/managed/gen-${i}/opencode-plugin`],
      }, fs, { platform: process.platform });
    }
    const record = readOwner(target).record;
    assert.ok(record.knownRegisteredPaths.length <= mg.KNOWN_PATH_LIMIT);
    const newest = `/managed/gen-${mg.KNOWN_PATH_LIMIT + 4}/opencode-plugin`;
    assert.ok(record.knownRegisteredPaths.includes(newest), "newest path must survive the cap");
  });

  it("liveness requires a regular file (directory / dangling are not live)", () => {
    const root = tmp("clawd-own-live-");
    const marker = path.join(root, "opencode-plugin", "index.mjs");
    fs.mkdirSync(marker, { recursive: true });
    assert.strictEqual(mg.isLiveSourceMarker(marker, fs), false);
    fs.rmdirSync(marker);
    fs.writeFileSync(marker, "");
    assert.strictEqual(mg.isLiveSourceMarker(marker, fs), true);
    fs.rmSync(marker);
    assert.strictEqual(mg.isLiveSourceMarker(marker, fs), false);
  });
});

describe("#1026 r1 lock validation and stale takeover", () => {
  function lockRecord(overrides = {}) {
    return {
      schema: 1,
      owner: "clawd-on-desk.opencode-family.target.lock",
      token: "t",
      pid: process.pid,
      operation: "register",
      startedAt: new Date().toISOString(),
      timeoutMs: 1000,
      ...overrides,
    };
  }
  function seedLock(target, record) {
    fs.mkdirSync(target.lockPath, { recursive: true });
    fs.writeFileSync(target.lockFilePath, JSON.stringify(record));
  }

  it("never takes over a lock with a malformed PID / timestamp / operation", () => {
    for (const bad of [{ pid: 1.5 }, { pid: -1 }, { startedAt: "nope" }, { operation: "" }]) {
      const target = makeTarget(tmp("clawd-lock-bad-"));
      seedLock(target, lockRecord({ startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...bad }));
      const result = mg.acquireTargetLock(target, { operation: "register", fs });
      assert.strictEqual(result.ok, false, JSON.stringify(bad));
      assert.strictEqual(result.reason, "locked");
    }
  });

  it("quarantines a fully valid stale lock whose PID is provably dead", () => {
    const target = makeTarget(tmp("clawd-lock-stale-"));
    seedLock(target, lockRecord({
      pid: 2000000000, // ESRCH on this host
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeoutMs: 1000,
    }));
    const result = mg.acquireTargetLock(target, { operation: "register", fs });
    assert.strictEqual(result.ok, true);
    const record = JSON.parse(fs.readFileSync(target.lockFilePath, "utf8"));
    assert.strictEqual(record.pid, process.pid);
    mg.releaseTargetLock(target, result.lock, fs);
  });

  it("does not take over a live-PID stale-looking lock", () => {
    const target = makeTarget(tmp("clawd-lock-live-"));
    seedLock(target, lockRecord({
      pid: process.pid,
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeoutMs: 1000,
    }));
    const result = mg.acquireTargetLock(target, { operation: "register", fs });
    assert.strictEqual(result.ok, false);
  });

  it("interactive acquire sleeps once and re-attempts after the lock is freed", () => {
    const target = makeTarget(tmp("clawd-lock-retry-"));
    seedLock(target, lockRecord({ pid: process.pid }));
    const sleeps = [];
    const result = mg.acquireTargetLock(target, {
      operation: "register",
      fs,
      retry: true,
      retryDelayMs: 7,
      sleep: (ms) => {
        sleeps.push(ms);
        // Simulate the holder releasing during the bounded wait.
        fs.rmSync(target.lockFilePath, { force: true });
        fs.rmdirSync(target.lockPath);
      },
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(sleeps, [7], "exactly one bounded wait");
    mg.releaseTargetLock(target, result.lock, fs);
  });

  it("interactive acquire returns locked after the single wait when still held", () => {
    const target = makeTarget(tmp("clawd-lock-retry2-"));
    seedLock(target, lockRecord({ pid: process.pid }));
    const sleeps = [];
    const result = mg.acquireTargetLock(target, {
      operation: "register",
      fs,
      retry: true,
      retryDelayMs: 5,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "locked");
    assert.deepStrictEqual(sleeps, [5]);
  });

  it("startup automatic acquire never waits or re-attempts", () => {
    const target = makeTarget(tmp("clawd-lock-auto-"));
    seedLock(target, lockRecord({ pid: process.pid }));
    const sleeps = [];
    const result = mg.acquireTargetLock(target, {
      operation: "register",
      fs,
      retry: false,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(sleeps, []);
  });

  it("release never recursively deletes unexpected content and reports failure", () => {
    const target = makeTarget(tmp("clawd-lock-foreign-"));
    const held = mg.acquireTargetLock(target, { operation: "register", fs });
    assert.strictEqual(held.ok, true);
    // Foreign content appears after acquisition, before release.
    const foreign = path.join(target.lockPath, "foreign.txt");
    fs.writeFileSync(foreign, "keep me");
    const nested = path.join(target.lockPath, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "deep.txt"), "keep me too");

    const released = mg.releaseTargetLock(target, held.lock, fs);
    assert.strictEqual(released, false, "non-empty lock dir must not be reported released");
    assert.strictEqual(fs.readFileSync(foreign, "utf8"), "keep me");
    assert.strictEqual(fs.readFileSync(path.join(nested, "deep.txt"), "utf8"), "keep me too");
    // Only the verified record was deleted.
    assert.strictEqual(fs.existsSync(target.lockFilePath), false);
  });
});

describe("#1026 r1 inspectGeneration strictness", () => {
  function buildGeneration() {
    const home = tmp("clawd-gen-strict-");
    const target = makeTarget(home);
    const srcRoot = tmp("clawd-gen-src-");
    const pluginDir = path.join(srcRoot, "hooks", "opencode-plugin");
    const familyDir = path.join(srcRoot, "hooks", "opencode-family-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(familyDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), "export default async () => ({});\n");
    fs.writeFileSync(path.join(pluginDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(familyDir, "core.mjs"), "export const c = 1;\n");
    fs.writeFileSync(path.join(familyDir, "session-ids.mjs"), "export const s = 1;\n");
    // opencode v2 entry — part of the bundle (issue #1039).
    const v2Dir = path.join(srcRoot, "hooks", OPENCODE_CFG.v2PluginDirName);
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(path.join(v2Dir, "index.mjs"), "export default { id: 'x', setup: async () => () => {} };\n");
    const materialized = mg.materializeGeneration(target, OPENCODE_CFG, pluginDir, { fs, platform: process.platform });
    assert.strictEqual(materialized.ok, true, materialized.message);
    return materialized.generationDir;
  }

  it("rejects a generation directory whose name is not the 64-hex content address", () => {
    const genDir = buildGeneration();
    const renamed = `${genDir}-nothex`;
    fs.renameSync(genDir, renamed);
    const result = mg.inspectGeneration(renamed, OPENCODE_CFG, "opencode", { fs });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "generation-dir-not-content-addressed");
  });

  it("rejects extra or missing manifest file entries", () => {
    const genDir = buildGeneration();
    const manifestPath = path.join(genDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files["opencode-plugin/extra.mjs"] = { sha256: "a".repeat(64), bytes: 0 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = mg.inspectGeneration(genDir, OPENCODE_CFG, "opencode", { fs });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "manifest-file-set-mismatch");
  });

  it("rejects a self-consistent forged manifest whose bundle hash cannot be recomputed", () => {
    const genDir = buildGeneration();
    const manifestPath = path.join(genDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // Keep per-file entries valid but mutate a file so the recomputed content
    // address no longer matches (recompute catches what the self-describing
    // manifest would otherwise hide).
    const indexPath = path.join(genDir, "opencode-plugin/index.mjs");
    fs.writeFileSync(indexPath, "export default async () => ({ changed: true });\n");
    const bytes = fs.readFileSync(indexPath);
    const crypto = require("crypto");
    manifest.files["opencode-plugin/index.mjs"] = {
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = mg.inspectGeneration(genDir, OPENCODE_CFG, "opencode", { fs });
    assert.strictEqual(result.ok, false);
    assert.ok(["bundle-hash-recompute-mismatch", "manifest-hash-mismatch"].includes(result.reason), result.reason);
  });
});

describe("#1026 r1 complete-plan validation before writes", () => {
  it("does not mutate masked lower files when the effective edit is a conflict", () => {
    const dir = tmp("clawd-plan-");
    const legacy = "/legacy/opencode-plugin";
    const canonical = "/managed/opencode-plugin";
    // Higher-priority effective file declares a conflicting Clawd tuple pair;
    // lower file carries a safe owned entry that the old order would have
    // cleaned BEFORE discovering the conflict.
    const jsoncPath = path.join(dir, "opencode.jsonc");
    const jsonPath = path.join(dir, "opencode.json");
    fs.writeFileSync(jsoncPath, JSON.stringify({ plugin: [[legacy, { a: 1 }], [legacy, { b: 2 }]] }), "utf8");
    fs.writeFileSync(jsonPath, JSON.stringify({ plugin: [legacy] }), "utf8");
    const jsoncBefore = fs.readFileSync(jsoncPath, "utf8");
    const jsonBefore = fs.readFileSync(jsonPath, "utf8");

    const ctx = {
      pluginDirName: "opencode-plugin",
      expectedCanonicalDir: canonical,
      targetRoot: null,
      sourcePluginDir: legacy,
      knownRegisteredPaths: new Set(),
      canonicalize: (p) => String(p).replace(/\\/g, "/"),
      canonicalizeStrict: (p) => String(p).replace(/\\/g, "/"),
      exists: () => true,
      probeIndeterminate: () => false,
      inspectExpectedGeneration: () => ({ ok: true }),
      inspectManagedBoundary: () => ({ state: "corrupt" }),
      bundleBytesMatch: () => false,
      isClawdLike: () => false,
    };
    const candidates = jsonc.readCandidates(OPENCODE_CFG, jsoncPath);
    const apply = jsonc.applyManagedRegister({
      cfg: OPENCODE_CFG,
      configPath: jsoncPath,
      candidates,
      makeContext: () => ctx,
      canonicalEntry: canonical,
      options: { fs, platform: process.platform },
    });
    assert.strictEqual(apply.status, "error");
    assert.match(apply.reason, /tuple-options-conflict|ownership-conflict/);
    assert.deepStrictEqual(apply.mutatedPaths, []);
    assert.strictEqual(fs.readFileSync(jsoncPath, "utf8"), jsoncBefore);
    assert.strictEqual(fs.readFileSync(jsonPath, "utf8"), jsonBefore, "masked lower file must be untouched");
  });
});

describe("#1026 r2 generation rename retry delay", () => {
  function makeSource() {
    const srcRoot = tmp("clawd-rename-src-");
    const pluginDir = path.join(srcRoot, "hooks", "opencode-plugin");
    const familyDir = path.join(srcRoot, "hooks", "opencode-family-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(familyDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), "export default async () => ({});\n");
    fs.writeFileSync(path.join(pluginDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(familyDir, "core.mjs"), "export const c = 1;\n");
    fs.writeFileSync(path.join(familyDir, "session-ids.mjs"), "export const s = 1;\n");
    // opencode v2 entry — part of the bundle (issue #1039).
    const v2Dir = path.join(srcRoot, "hooks", OPENCODE_CFG.v2PluginDirName);
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(path.join(v2Dir, "index.mjs"), "export default { id: 'x', setup: async () => () => {} };\n");
    return pluginDir;
  }

  function fakeFsWithRename(renameImpl) {
    return new Proxy(fs, {
      get(target, prop) {
        if (prop === "renameSync") return renameImpl;
        return target[prop];
      },
    });
  }

  it("sleeps between transient EPERM retries (not after the last attempt) and then succeeds", () => {
    const target = makeTarget(tmp("clawd-rename-ok-"));
    const pluginDir = makeSource();
    const sleeps = [];
    let calls = 0;
    // Only the staging→generation promotion rename fails; writeFileAtomic's
    // own temp renames (used while populating staging) must still work.
    const fakeFs = fakeFsWithRename((from, to) => {
      if (path.basename(String(from)).startsWith(".staging-")) {
        calls++;
        if (calls <= 2) {
          const err = new Error("busy");
          err.code = "EPERM";
          throw err;
        }
      }
      return fs.renameSync(from, to);
    });
    const result = mg.materializeGeneration(target, OPENCODE_CFG, pluginDir, {
      fs: fakeFs,
      platform: process.platform,
      sleep: (ms) => sleeps.push(ms),
      renameRetryDelayMs: 3,
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(sleeps, [3, 3], "one delay before each retry, none after the last");
  });

  it("sleeps exactly attempts-1 times and cleans staging when the rename keeps failing", () => {
    const target = makeTarget(tmp("clawd-rename-fail-"));
    const pluginDir = makeSource();
    const sleeps = [];
    const fakeFs = fakeFsWithRename((from, to) => {
      if (path.basename(String(from)).startsWith(".staging-")) {
        const err = new Error("busy");
        err.code = "EPERM";
        throw err;
      }
      return fs.renameSync(from, to);
    });
    const result = mg.materializeGeneration(target, OPENCODE_CFG, pluginDir, {
      fs: fakeFs,
      platform: process.platform,
      sleep: (ms) => sleeps.push(ms),
      renameRetryDelayMs: 2,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "generation-write-failed");
    assert.deepStrictEqual(sleeps, [2, 2]);
    const leftovers = fs.existsSync(target.generationsDir)
      ? fs.readdirSync(target.generationsDir).filter((name) => name.startsWith(".staging-"))
      : [];
    assert.deepStrictEqual(leftovers, [], "only this staging dir may be cleaned");
  });
});

describe("#1026 r4 lock write-failure ownership", () => {
  function renameHookFs(hook) {
    return new Proxy(fs, {
      get(target, prop) {
        if (prop === "renameSync") return hook;
        return target[prop];
      },
    });
  }
  function foreignRecord(token) {
    return {
      schema: 1,
      owner: "clawd-on-desk.opencode-family.target.lock",
      token,
      pid: process.pid,
      operation: "register",
      startedAt: new Date().toISOString(),
      timeoutMs: 1000,
    };
  }
  function tryAcquire(target, fakeFs) {
    try {
      const result = mg.acquireTargetLock(target, { operation: "register", fs: fakeFs });
      return { result, error: null };
    } catch (err) {
      return { result: null, error: err };
    }
  }

  it("preserves a foreign valid lock.json and directory byte-identical", () => {
    const target = makeTarget(tmp("clawd-r4-foreign-"));
    const foreign = foreignRecord("foreign-token");
    const foreignText = JSON.stringify(foreign, null, 2);
    const fakeFs = renameHookFs((from, to) => {
      fs.writeFileSync(to, foreignText);
      const err = new Error("rename failed");
      err.code = "EACCES";
      throw err;
    });
    const { error } = tryAcquire(target, fakeFs);
    assert.ok(error, "acquisition must surface the write failure");
    assert.strictEqual(error.code, "EACCES");
    assert.strictEqual(error.message, "rename failed");
    assert.strictEqual(error.lockPath, target.lockPath);
    assert.match(error.inspection, /foreign|preserved/);
    assert.strictEqual(fs.readFileSync(target.lockFilePath, "utf8"), foreignText);
    assert.strictEqual(fs.existsSync(target.lockPath), true);
  });

  it("preserves a corrupt/unreadable lock.json", () => {
    const target = makeTarget(tmp("clawd-r4-corrupt-"));
    const fakeFs = renameHookFs((from, to) => {
      fs.writeFileSync(to, "{ not json");
      const err = new Error("rename failed");
      err.code = "EACCES";
      throw err;
    });
    const { error } = tryAcquire(target, fakeFs);
    assert.ok(error);
    assert.strictEqual(fs.readFileSync(target.lockFilePath, "utf8"), "{ not json");
    assert.strictEqual(fs.existsSync(target.lockPath), true);
    assert.match(error.inspection, /preserved|foreign|non-empty/);
  });

  it("removes only this invocation's exact-token record, then the empty directory", () => {
    const target = makeTarget(tmp("clawd-r4-owned-"));
    const fakeFs = renameHookFs((from, to) => {
      // Leave OUR record behind, as if the rename failed after the target
      // file was written.
      fs.writeFileSync(to, fs.readFileSync(from, "utf8"));
      const err = new Error("rename raced");
      err.code = "EACCES";
      throw err;
    });
    const { error } = tryAcquire(target, fakeFs);
    assert.ok(error);
    assert.match(error.inspection, /our own record/);
    assert.strictEqual(fs.existsSync(target.lockFilePath), false);
    assert.strictEqual(fs.existsSync(target.lockPath), false);
  });

  it("cleans only the empty directory when no target record was created", () => {
    const target = makeTarget(tmp("clawd-r4-none-"));
    const fakeFs = renameHookFs(() => {
      const err = new Error("no write");
      err.code = "EACCES";
      throw err;
    });
    const { error } = tryAcquire(target, fakeFs);
    assert.ok(error);
    assert.strictEqual(error.code, "EACCES");
    assert.match(error.inspection, /no target record|empty/);
    assert.strictEqual(fs.existsSync(target.lockPath), false);
  });
});
