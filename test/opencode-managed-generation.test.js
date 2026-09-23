"use strict";

// #1026 managed-generation tests: bundle/manifest transaction, target owner
// record, cross-process lock, entry ownership classifier, managed installer
// register/unregister results and the plugin orphan inert gate.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { describe, it, afterEach } = require("node:test");

const mg = require("../hooks/opencode-family-managed-generation");
const ownership = require("../hooks/opencode-family-entry-ownership");
const { getFamilyConfig } = require("../agents/opencode-family");
const {
  registerOpencodePlugin,
  unregisterOpencodePlugin,
  resolveSourcePluginDir,
} = require("../hooks/opencode-install");
const { registerMimocodePlugin, unregisterMimocodePlugin } = require("../hooks/mimocode-install");

const OPENCODE_CFG = getFamilyConfig("opencode");
const MIMOCODE_CFG = getFamilyConfig("mimocode");

const tempDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeHome(prefix) {
  const home = tmp(prefix);
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  return home;
}

describe("#1026 registry gate", () => {
  it("enables managed materialization for opencode only", () => {
    assert.strictEqual(OPENCODE_CFG.managedMaterialization, true);
    assert.strictEqual(MIMOCODE_CFG.managedMaterialization, false);
  });

  it("keeps MiMo's legacy broad-basename register/unregister behavior (flag does not leak)", () => {
    const dir = tmp("clawd-mimo-legacy-");
    const configPath = path.join(dir, "mimocode.jsonc");
    const stale = "/old/install/mimocode-plugin";
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [stale] }), "utf8");
    const newPath = "/new/install/mimocode-plugin";

    const reg = registerMimocodePlugin({ silent: true, configPath, pluginDir: newPath });
    assert.strictEqual(reg.added, true);
    assert.deepStrictEqual(readJson(configPath).plugin, [newPath]);

    const unreg = unregisterMimocodePlugin({ silent: true, configPath, pluginDir: newPath });
    assert.strictEqual(unreg.removed, 1);
    assert.deepStrictEqual(readJson(configPath).plugin, []);
  });
});

describe("#1026 canonicalizer", () => {
  it("folds Windows case and separators into one identity", () => {
    const a = mg.canonicalizeTargetPath("C:\\Users\\Foo\\.config\\opencode\\", "win32", fs);
    const b = mg.canonicalizeTargetPath("c:/users/foo/.config/opencode", "win32", fs);
    assert.strictEqual(a, b);
  });

  it("treats a junction/symlink alias as the same identity via realpath", () => {
    const root = tmp("clawd-canon-");
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, "junction");
    } catch {
      return; // symlink privilege unavailable on this host — covered by lexical case above
    }
    const a = mg.canonicalizeTargetPath(real, process.platform, fs);
    const b = mg.canonicalizeTargetPath(link, process.platform, fs);
    assert.strictEqual(a, b);
  });

  it("keeps a symlinked HOME target hash stable before and after the config leaf exists", () => {
    const root = tmp("clawd-canon-missing-");
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    fs.mkdirSync(realHome);
    try {
      fs.symlinkSync(realHome, linkedHome, "junction");
    } catch {
      return; // symlink privilege unavailable on this host
    }

    const before = mg.resolveManagedTarget({
      cfg: OPENCODE_CFG,
      agentId: "opencode",
      homeDir: linkedHome,
      fs,
      platform: process.platform,
    });
    assert.strictEqual(before.canonicalConfigDirResolved, true);
    fs.mkdirSync(path.join(realHome, ".config", "opencode"), { recursive: true });
    const after = mg.resolveManagedTarget({
      cfg: OPENCODE_CFG,
      agentId: "opencode",
      homeDir: linkedHome,
      fs,
      platform: process.platform,
    });
    assert.strictEqual(after.canonicalConfigDirResolved, true);
    assert.strictEqual(before.canonicalConfigDir, after.canonicalConfigDir);
    assert.strictEqual(before.configDirHash, after.configDirHash);
    assert.strictEqual(before.targetRoot, after.targetRoot);
  });

  it("does not anchor a missing config suffix to a file when realpath reports ENOENT", () => {
    const home = tmp("clawd-canon-file-ancestor-");
    fs.writeFileSync(path.join(home, ".config"), "not a directory", "utf8");
    const windowsLikeRealpath = (value) => {
      try {
        return fs.realpathSync(value);
      } catch (error) {
        if (error && error.code === "ENOTDIR") {
          const mapped = new Error(error.message);
          mapped.code = "ENOENT";
          throw mapped;
        }
        throw error;
      }
    };
    windowsLikeRealpath.native = windowsLikeRealpath;
    const windowsLikeFs = new Proxy(fs, {
      get(target, key, receiver) {
        if (key === "realpathSync") return windowsLikeRealpath;
        return Reflect.get(target, key, receiver);
      },
    });

    const target = mg.resolveManagedTarget({
      cfg: OPENCODE_CFG,
      agentId: "opencode",
      homeDir: home,
      fs: windowsLikeFs,
      platform: process.platform,
    });

    assert.strictEqual(target.canonicalConfigDirResolved, false);
  });
});

describe("#1026 managed installer register/unregister", () => {
  it("fails closed before mutation when no config-dir ancestor identity can be resolved", () => {
    const home = makeHome("clawd-managed-unresolved-");
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ["third-party"] }), "utf8");
    const before = fs.readFileSync(configPath);
    const deniedRealpath = () => {
      const err = new Error("identity denied");
      err.code = "EACCES";
      throw err;
    };
    deniedRealpath.native = deniedRealpath;
    const deniedFs = new Proxy(fs, {
      get(target, key, receiver) {
        if (key === "realpathSync") return deniedRealpath;
        return Reflect.get(target, key, receiver);
      },
    });

    const registered = registerOpencodePlugin({ silent: true, homeDir: home, fs: deniedFs });
    assert.strictEqual(registered.status, "error");
    assert.strictEqual(registered.reason, "config-dir-identity-unresolved");
    assert.deepStrictEqual(fs.readFileSync(configPath), before);
    assert.strictEqual(fs.existsSync(path.join(home, ".clawd")), false);

    const unregistered = unregisterOpencodePlugin({ silent: true, homeDir: home, fs: deniedFs });
    assert.strictEqual(unregistered.status, "error");
    assert.strictEqual(unregistered.reason, "config-dir-identity-unresolved");
    assert.strictEqual(unregistered.registrationRemoved, false);
    assert.deepStrictEqual(fs.readFileSync(configPath), before);
    assert.strictEqual(fs.existsSync(path.join(home, ".clawd")), false);
  });

  it("fails closed before mutation when a config-dir ancestor is a file", () => {
    const home = tmp("clawd-managed-enotdir-");
    fs.writeFileSync(path.join(home, ".config"), "not a directory", "utf8");

    const registered = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(registered.status, "error");
    assert.strictEqual(registered.reason, "config-dir-identity-unresolved");
    assert.strictEqual(fs.readFileSync(path.join(home, ".config"), "utf8"), "not a directory");
    assert.strictEqual(fs.existsSync(path.join(home, ".clawd")), false);

    const unregistered = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(unregistered.status, "error");
    assert.strictEqual(unregistered.reason, "config-dir-identity-unresolved");
    assert.strictEqual(unregistered.registrationRemoved, false);
    assert.strictEqual(fs.readFileSync(path.join(home, ".config"), "utf8"), "not a directory");
    assert.strictEqual(fs.existsSync(path.join(home, ".clawd")), false);
  });

  it("skips when the host config dir is missing and never creates ~/.clawd", () => {
    const home = tmp("clawd-home-empty-");
    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.reason, "opencode-not-found");
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(fs.existsSync(path.join(home, ".clawd")), false);
  });

  it("registers a verified, user-writable managed generation instead of the source dir", () => {
    const home = makeHome("clawd-managed-reg-");
    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, true);
    const config = readJson(path.join(home, ".config", "opencode", "opencode.json"));
    assert.strictEqual(config.plugin.length, 1);
    const entry = config.plugin[0];
    assert.ok(entry.includes("/.clawd/integrations/opencode-family/opencode/homes/"), entry);
    assert.ok(/\/generations\/[0-9a-f]{64}\/opencode-plugin$/.test(entry), entry);
    assert.ok(!entry.includes("app.asar"), entry);

    const pluginDir = entry.replace(/\//g, path.sep);
    const genDir = path.dirname(pluginDir);
    const inspected = mg.inspectGeneration(genDir, OPENCODE_CFG, "opencode", { fs });
    assert.strictEqual(inspected.ok, true, `expected valid generation: ${inspected.reason}`);
    // Bundle bytes equal the source bundle.
    const sourceFiles = mg.readSourceBundle(OPENCODE_CFG, resolveSourcePluginDir(), fs).files;
    assert.strictEqual(mg.bundleBytesMatch(pluginDir, OPENCODE_CFG, sourceFiles, fs), true);

    // Owner record exists and is self-owned.
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const owner = mg.readOwnerRecord(target, "opencode", fs, { platform: process.platform, pluginDirName: "opencode-plugin" });
    assert.strictEqual(owner.state, "owned");
    assert.strictEqual(owner.record.activeSourceRoot, path.dirname(resolveSourcePluginDir()));
  });

  it("is idempotent: a second register reuses the generation and keeps the config byte-identical", () => {
    const home = makeHome("clawd-managed-idem-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const first = fs.readFileSync(configPath, "utf8");
    const second = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), first);
  });

  it("refuses to edit when a configPath override has no home/managedRoot/pluginDir", () => {
    const dir = tmp("clawd-managed-override-");
    const configPath = path.join(dir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [] }), "utf8");
    const result = registerOpencodePlugin({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "managed-root-required-for-config-override");
    assert.deepStrictEqual(readJson(configPath).plugin, []);
  });

  it("configPath-only unregister preserves an unproven missing basename and warns managed-root-unknown", () => {
    const dir = tmp("clawd-managed-config-only-");
    const configPath = path.join(dir, "opencode.json");
    const managed = "/some/home/.clawd/integrations/opencode-family/opencode/homes/x/generations/" + "a".repeat(64) + "/opencode-plugin";
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [managed, "@vendor/keep"] }), "utf8");
    const result = unregisterOpencodePlugin({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.managedFilesRemoved, false);
    assert.ok(result.warnings.some((w) => w.includes("managed-root-unknown")));
    assert.deepStrictEqual(readJson(configPath).plugin, [managed, "@vendor/keep"]);
  });

  it("uninstall removes the config entry, the generation, and releases the self-owned record", () => {
    const home = makeHome("clawd-managed-unreg-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const entry = readJson(configPath).plugin[0];
    const genDir = path.dirname(entry.replace(/\//g, path.sep));

    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.activeEntryRemaining, false);
    assert.strictEqual(result.managedFilesRemoved, true);
    assert.deepStrictEqual(readJson(configPath).plugin, []);
    assert.strictEqual(fs.existsSync(genDir), false);
  });

  it("retires the canonical generation before a cleanup failure so reinstall can recover", () => {
    const home = makeHome("clawd-managed-unreg-busy-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const entry = readJson(configPath).plugin[0];
    const genDir = path.dirname(entry.replace(/\//g, path.sep));
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });

    const busyFs = Object.create(fs);
    busyFs.rmSync = (candidate, options) => {
      if (path.basename(candidate).startsWith(".cleanup-")) {
        const err = new Error("simulated busy generation");
        err.code = "EBUSY";
        throw err;
      }
      return fs.rmSync(candidate, options);
    };

    const removed = unregisterOpencodePlugin({ silent: true, homeDir: home, fs: busyFs });
    assert.strictEqual(removed.status, "ok");
    assert.strictEqual(removed.registrationRemoved, true);
    assert.strictEqual(removed.managedFilesRemoved, false);
    assert.strictEqual(fs.existsSync(genDir), false, "canonical hash slot must be retired before recursive cleanup");
    assert.strictEqual(removed.residualPaths.length, 1);
    assert.ok(path.basename(removed.residualPaths[0]).startsWith(".cleanup-"));
    assert.strictEqual(fs.existsSync(removed.residualPaths[0]), true);
    assert.ok(removed.warnings.some((warning) => warning.includes("managed generation cleanup incomplete")));
    assert.deepStrictEqual(readJson(configPath).plugin, []);
    assert.strictEqual(mg.readOwnerRecord(target, "opencode", fs, {
      platform: process.platform,
      pluginDirName: "opencode-plugin",
    }).state, "released");

    const restored = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(restored.status, "ok", JSON.stringify(restored));
    assert.strictEqual(restored.added, true);
    assert.strictEqual(mg.inspectGeneration(genDir, OPENCODE_CFG, "opencode", { fs }).ok, true);
  });

  it("quarantines an old released partial deletion proven by owner history before reinstall", () => {
    const home = makeHome("clawd-managed-recover-released-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const entry = readJson(configPath).plugin[0];
    const genDir = path.dirname(entry.replace(/\//g, path.sep));
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf8");
    const sourcePluginDir = resolveSourcePluginDir();
    const released = mg.releaseOwnerRecord(
      target,
      "opencode",
      path.dirname(sourcePluginDir),
      path.join(sourcePluginDir, "index.mjs"),
      fs,
      { platform: process.platform, pluginDirName: "opencode-plugin" },
    );
    assert.strictEqual(released.released, true);
    fs.rmSync(path.join(genDir, "manifest.json"));

    const restored = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(restored.status, "ok", JSON.stringify(restored));
    assert.strictEqual(restored.added, true);
    assert.strictEqual(restored.residualPaths.length, 1);
    assert.ok(path.basename(restored.residualPaths[0]).startsWith(".recovery-"));
    assert.ok(restored.warnings.some((warning) => warning.includes("released managed residual was quarantined")));
    assert.strictEqual(fs.existsSync(restored.residualPaths[0]), true, "suspicious old bytes must be preserved out of band");
    assert.strictEqual(mg.inspectGeneration(genDir, OPENCODE_CFG, "opencode", { fs }).ok, true);
    assert.deepStrictEqual(readJson(configPath).plugin, [entry]);
  });

  it("does not recover a released corrupt generation absent from owner history", () => {
    const home = makeHome("clawd-managed-recover-unproven-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const entry = readJson(configPath).plugin[0];
    const genDir = path.dirname(entry.replace(/\//g, path.sep));
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf8");
    const sourcePluginDir = resolveSourcePluginDir();
    mg.releaseOwnerRecord(
      target,
      "opencode",
      path.dirname(sourcePluginDir),
      path.join(sourcePluginDir, "index.mjs"),
      fs,
      { platform: process.platform, pluginDirName: "opencode-plugin" },
    );
    const owner = readJson(target.ownerPath);
    owner.knownRegisteredPaths = [];
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2), "utf8");
    fs.rmSync(path.join(genDir, "manifest.json"));

    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "generation-conflict");
    assert.strictEqual(fs.existsSync(genDir), true);
    assert.deepStrictEqual(readJson(configPath).plugin, []);
  });

  it("keeps a foreign owner record byte-identical and warns", () => {
    const home = makeHome("clawd-managed-foreign-owner-");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    fs.mkdirSync(target.targetRoot, { recursive: true });
    const foreign = {
      schema: 1,
      owner: "clawd-on-desk.opencode-family.target",
      agentId: "opencode",
      canonicalConfigDir: target.canonicalConfigDir,
      configDirHash: target.configDirHash,
      activeSourceRoot: "C:/other/source",
      activeSourceMarker: "C:/other/source/opencode-plugin/index.mjs",
      knownRegisteredPaths: [],
      updatedAt: "x",
    };
    fs.writeFileSync(target.ownerPath, JSON.stringify(foreign, null, 2));
    const before = fs.readFileSync(target.ownerPath, "utf8");
    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(fs.readFileSync(target.ownerPath, "utf8"), before);
    assert.ok(result.warnings.some((w) => w.includes("another live source")));
  });

  it("refuses to overwrite a foreign/corrupt owner record", () => {
    const home = makeHome("clawd-managed-bad-owner-");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    fs.mkdirSync(target.targetRoot, { recursive: true });
    fs.writeFileSync(target.ownerPath, "{ not json");
    const before = fs.readFileSync(target.ownerPath, "utf8");
    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "owner-inspection-required");
    assert.strictEqual(fs.readFileSync(target.ownerPath, "utf8"), before);
  });

  it("returns a packaging error and leaves config untouched when a source asset is missing", () => {
    const home = makeHome("clawd-managed-packaging-");
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ["@vendor/keep"] }), "utf8");
    // Drive readSourceBundle to fail by pointing the installer at a fake
    // source via a pluginDir override is not a materialization case; instead
    // call the materializer directly with a bogus source dir.
    const bogus = path.join(tmp("clawd-bogus-src-"), "opencode-plugin");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const result = mg.materializeGeneration(target, OPENCODE_CFG, bogus, { fs, platform: process.platform });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "packaging-error");
    assert.deepStrictEqual(readJson(configPath).plugin, ["@vendor/keep"]);
  });

  it("conflicts instead of overwriting a tampered generation", () => {
    const home = makeHome("clawd-managed-conflict-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const pluginDir = readJson(configPath).plugin[0].replace(/\//g, path.sep);
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), "// tampered\n", "utf8");

    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    // Fail closed without overwriting: the pre-scan sees the expected
    // generation is corrupt (managed-corrupt); a direct materialization would
    // report generation-conflict. Both are zero-config-mutation.
    assert.ok(/generation-conflict|managed-corrupt/.test(result.reason), result.reason);
    assert.strictEqual(fs.readFileSync(path.join(pluginDir, "index.mjs"), "utf8"), "// tampered\n");
  });
});

describe("#1026 generator materialization", () => {
  function makeFakeSource(root, pluginName) {
    const hooks = path.join(root, "my app (x86)", "hooks");
    const pluginDir = path.join(hooks, pluginName);
    const familyDir = path.join(hooks, "opencode-family-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(familyDir, { recursive: true });
    const bytes = {
      "index.mjs": "export default async () => ({});\n",
      "package.json": '{"name":"x"}\n',
    };
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), bytes["index.mjs"]);
    fs.writeFileSync(path.join(pluginDir, "package.json"), bytes["package.json"]);
    fs.writeFileSync(path.join(familyDir, "core.mjs"), "export const core = 1;\n");
    fs.writeFileSync(path.join(familyDir, "session-ids.mjs"), "export const ids = 1;\n");
    // opencode v2 entry (issue #1039): part of the bundle now that OPENCODE_CFG
    // declares v2PluginDirName.
    const v2Dir = path.join(hooks, OPENCODE_CFG.v2PluginDirName);
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(path.join(v2Dir, "index.mjs"), "export default { id: 'x', setup: async () => () => {} };\n");
    return { pluginDir, familyDir };
  }

  it("materializes source paths containing spaces into a verified generation", () => {
    const srcRoot = tmp("clawd-src-space-");
    const { pluginDir: srcPluginDir } = makeFakeSource(srcRoot, "opencode-plugin");
    const home = makeHome("clawd-mat-space-");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });

    const result = mg.materializeGeneration(target, OPENCODE_CFG, srcPluginDir, { fs, platform: process.platform });
    assert.strictEqual(result.ok, true, result.message);
    const files = mg.readSourceBundle(OPENCODE_CFG, srcPluginDir, fs).files;
    assert.strictEqual(mg.bundleBytesMatch(result.pluginDir, OPENCODE_CFG, files, fs), true);
    assert.strictEqual(mg.inspectGeneration(result.generationDir, OPENCODE_CFG, "opencode", { fs }).ok, true);
  });

  it("bundleHash is deterministic and changes with any file byte", () => {
    const srcRoot = tmp("clawd-src-hash-");
    const { pluginDir } = makeFakeSource(srcRoot, "opencode-plugin");
    const files = mg.readSourceBundle(OPENCODE_CFG, pluginDir, fs).files;
    const h1 = mg.computeBundleHash("opencode", files);
    const h2 = mg.computeBundleHash("opencode", [...files].reverse());
    assert.strictEqual(h1, h2, "path ordering must not matter");
    const mutated = files.map((f, i) => (i === 0 ? { ...f, bytes: Buffer.concat([f.bytes, Buffer.from("x")]) } : f));
    assert.notStrictEqual(mg.computeBundleHash("opencode", mutated), h1);
  });
});

describe("#1026 target lock", () => {
  it("does not let a second acquire in, and lets a different configDir proceed", () => {
    const home = makeHome("clawd-managed-lock-");
    const targetA = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const first = mg.acquireTargetLock(targetA, { operation: "register", fs });
    assert.strictEqual(first.ok, true);
    const second = mg.acquireTargetLock(targetA, { operation: "register", fs });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "locked");
    mg.releaseTargetLock(targetA, first.lock, fs);

    const targetB = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", managedRoot: tmp("clawd-lock-b-"), fs, platform: process.platform });
    const other = mg.acquireTargetLock(targetB, { operation: "register", fs });
    assert.strictEqual(other.ok, true);
    mg.releaseTargetLock(targetB, other.lock, fs);
  });

  it("releases only its own token", () => {
    const home = makeHome("clawd-managed-lock-token-");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const held = mg.acquireTargetLock(target, { operation: "register", fs });
    assert.strictEqual(mg.releaseTargetLock(target, { token: "not-mine" }, fs), false);
    assert.strictEqual(fs.existsSync(target.lockFilePath), true);
    assert.strictEqual(mg.releaseTargetLock(target, held.lock, fs), true);
  });

  it("does not take over a live-PID lock", () => {
    const home = makeHome("clawd-managed-lock-live-");
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    fs.mkdirSync(target.lockPath, { recursive: true });
    fs.writeFileSync(target.lockFilePath, JSON.stringify({
      schema: 1,
      owner: "clawd-on-desk.opencode-family.target.lock",
      token: "t",
      pid: process.pid,
      operation: "register",
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeoutMs: 1000,
    }));
    const result = mg.acquireTargetLock(target, { operation: "register", fs });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "locked");
  });
});

describe("#1026 entry ownership classifier", () => {
  const ctx = {
    pluginDirName: "opencode-plugin",
    expectedCanonicalDir: "/home/u/.clawd/integrations/opencode-family/opencode/homes/h/generations/" + "a".repeat(64) + "/opencode-plugin",
    targetRoot: "/home/u/.clawd/integrations/opencode-family/opencode/homes/h",
    sourcePluginDir: "/app/hooks/opencode-plugin",
    knownRegisteredPaths: new Set(),
    canonicalize: (p) => String(p).replace(/\\/g, "/"),
    exists: () => false,
    inspectExpectedGeneration: () => ({ ok: true }),
    inspectManagedBoundary: () => ({ state: "corrupt" }),
    bundleBytesMatch: () => false,
    isClawdLike: () => false,
  };

  it("parses strings and length-2 tuples only", () => {
    assert.strictEqual(ownership.parseEntry("/x/opencode-plugin").shape, "string");
    const tuple = ownership.parseEntry(["/x/opencode-plugin", { model: "m" }]);
    assert.strictEqual(tuple.shape, "tuple");
    assert.deepStrictEqual(tuple.options, { model: "m" });
    assert.strictEqual(ownership.parseEntry(["/x/opencode-plugin", 1, 2]).malformed, true);
    assert.strictEqual(ownership.parseEntry(42).malformed, true);
  });

  it("classifies npm specifiers, foreign basenames and modified copies", () => {
    const result = ownership.classifyPluginEntries([
      "@vendor/opencode-plugin",
      "/opt/other/opencode-plugin",
      "/app/hooks/opencode-plugin",
    ], {
      ...ctx,
      exists: (p) => p !== "/app/hooks/opencode-plugin",
    });
    assert.strictEqual(result.entries[0].category, "foreign");
    assert.strictEqual(result.entries[1].category, "foreign");
    assert.strictEqual(result.entries[2].category, "legacy-source-exact");
  });

  it("fails closed on a modified Clawd-like copy and never plans an append", () => {
    const result = ownership.planEffectiveArray(["/opt/copy/opencode-plugin"], {
      ...ctx,
      exists: () => true,
      isClawdLike: () => true,
    }, { canonicalEntry: ctx.expectedCanonicalDir, configPath: "/c/opencode.json" });
    assert.strictEqual(result.action, "needs-review");
    assert.strictEqual(result.reason, "clawd-like-modified");
  });

  it("converges safe duplicates and keeps one canonical tuple's options", () => {
    const plan = ownership.planEffectiveArray([
      [ctx.expectedCanonicalDir, { model: "m" }],
      ctx.expectedCanonicalDir,
    ], {
      ...ctx,
      inspectExpectedGeneration: () => ({ ok: true }),
    }, { canonicalEntry: ctx.expectedCanonicalDir, configPath: "/c/opencode.json" });
    assert.strictEqual(plan.action, "edit");
    assert.deepStrictEqual(plan.remove, [1]);
    assert.strictEqual(plan.replace.length, 1);
    assert.strictEqual(plan.replace[0].index, 0);
    // Replacement carries the SPECIFIER only; the tuple's options are never
    // re-emitted as a nested value (#1026 r1 P0).
    assert.strictEqual(plan.replace[0].specifier, ctx.expectedCanonicalDir);
    assert.strictEqual(plan.replace[0].tuple, true);
    assert.strictEqual(plan.replace[0].value, undefined);
  });

  it("refuses conflicting tuple options", () => {
    const plan = ownership.planEffectiveArray([
      [ctx.expectedCanonicalDir, { model: "a" }],
      ["/app/hooks/opencode-plugin", { model: "b" }],
    ], ctx, { canonicalEntry: ctx.expectedCanonicalDir, configPath: "/c/opencode.json" });
    assert.strictEqual(plan.action, "ownership-conflict");
  });

  it("treats a unique missing basename-like path as ambiguous without stronger ownership evidence", () => {
    const result = ownership.classifyPluginEntries(["/old/opencode-plugin"], {
      ...ctx,
      exists: () => false,
    });
    assert.strictEqual(result.entries[0].category, "unknown");
    assert.strictEqual(result.entries[0].reason, "ambiguous-missing-basename");
  });

  it("treats multiple missing basename-like paths as unknown (fail closed)", () => {
    const result = ownership.classifyPluginEntries(["/old/opencode-plugin", "/older/opencode-plugin"], {
      ...ctx,
      exists: () => false,
    });
    assert.ok(result.entries.every((entry) => entry.category === "unknown"));
  });
});

describe("#1026 r3 dead-owner takeover / race-to-noop / release reporting", () => {
  function canonical(p) {
    return mg.canonicalizeTargetPath(p, process.platform, fs);
  }
  function currentSourceRoot() {
    return path.dirname(resolveSourcePluginDir());
  }
  function currentSourceMarker() {
    return path.join(resolveSourcePluginDir(), "index.mjs");
  }

  it("takes over a dead previous source owner when config is already current", () => {
    const home = makeHome("clawd-r3-takeover-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const configBefore = fs.readFileSync(configPath, "utf8");

    // Structurally valid owner pointing at a source whose marker is gone.
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = path.join(home, "dead-src");
    owner.activeSourceMarker = path.join(home, "dead-src", "opencode-plugin", "index.mjs");
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "ok", JSON.stringify(result));
    assert.strictEqual(result.ownerUpdated, true);
    assert.strictEqual(result.skipped, false);

    const after = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    assert.strictEqual(canonical(after.activeSourceRoot), canonical(currentSourceRoot()));
    assert.strictEqual(canonical(after.activeSourceMarker), canonical(currentSourceMarker()));
    // Config was already canonical: it must not be rewritten.
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), configBefore);
  });

  it("Doctor-equivalent registration also recovers the dead owner", () => {
    const home = makeHome("clawd-r3-doctor-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = path.join(home, "dead-src");
    owner.activeSourceMarker = path.join(home, "dead-src", "opencode-plugin", "index.mjs");
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    const result = registerOpencodePlugin({ silent: true, homeDir: home, source: "doctor", automatic: false });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.ownerUpdated, true);
    const after = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    assert.strictEqual(canonical(after.activeSourceRoot), canonical(currentSourceRoot()));
  });

  it("still returns owner-conflict and preserves bytes for a live other source", () => {
    const home = makeHome("clawd-r3-live-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const otherRoot = path.join(home, "other-src");
    const otherMarker = path.join(otherRoot, "opencode-plugin", "index.mjs");
    fs.mkdirSync(path.dirname(otherMarker), { recursive: true });
    fs.writeFileSync(otherMarker, "export default async () => ({});\n");
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = otherRoot;
    owner.activeSourceMarker = otherMarker;
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));
    const ownerBefore = fs.readFileSync(target.ownerPath, "utf8");

    const result = registerOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "owner-conflict");
    assert.strictEqual(fs.readFileSync(target.ownerPath, "utf8"), ownerBefore);
  });

  it("unregister returns owner-conflict before mutating a live other source", () => {
    const home = makeHome("clawd-r3-live-unregister-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const otherRoot = path.join(home, "other-src");
    const otherMarker = path.join(otherRoot, "opencode-plugin", "index.mjs");
    fs.mkdirSync(path.dirname(otherMarker), { recursive: true });
    fs.writeFileSync(otherMarker, "export default async () => ({});\n");
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = otherRoot;
    owner.activeSourceMarker = otherMarker;
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    const snapshot = (root) => {
      const out = [];
      const walk = (dir, relative = "") => {
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name);
          const rel = path.join(relative, name);
          const stat = fs.lstatSync(full);
          if (stat.isDirectory()) walk(full, rel);
          else out.push([rel, fs.readFileSync(full).toString("base64")]);
        }
      };
      walk(root);
      return out;
    };
    const before = {
      config: fs.readFileSync(configPath, "utf8"),
      owner: fs.readFileSync(target.ownerPath, "utf8"),
      tree: snapshot(target.targetRoot),
      marker: fs.readFileSync(otherMarker, "utf8"),
    };

    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "owner-conflict");
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), before.config);
    assert.strictEqual(fs.readFileSync(target.ownerPath, "utf8"), before.owner);
    assert.deepStrictEqual(snapshot(target.targetRoot), before.tree);
    assert.strictEqual(fs.readFileSync(otherMarker, "utf8"), before.marker);
  });

  it("race-to-no-op: converges state between preflight and lock and does nothing", () => {
    const home = makeHome("clawd-r3-noop-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const configBefore = fs.readFileSync(configPath, "utf8");
    const gensBefore = fs.readdirSync(target.generationsDir).sort();

    // Preflight would need a takeover (dead owner).
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = path.join(home, "dead-src");
    owner.activeSourceMarker = path.join(home, "dead-src", "opencode-plugin", "index.mjs");
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    let ownerAfterConverge = null;
    const result = registerOpencodePlugin({
      silent: true,
      homeDir: home,
      testHooks: {
        beforeAcquireLock: () => {
          // Simulate another process having converged the owner.
          const converged = { ...owner };
          converged.activeSourceRoot = currentSourceRoot();
          converged.activeSourceMarker = currentSourceMarker();
          fs.writeFileSync(target.ownerPath, JSON.stringify(converged, null, 2));
          ownerAfterConverge = fs.readFileSync(target.ownerPath, "utf8");
        },
      },
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.ownerUpdated, false);
    assert.deepStrictEqual(result.mutatedPaths, []);
    assert.strictEqual(fs.readFileSync(target.ownerPath, "utf8"), ownerAfterConverge, "owner bytes untouched by this run");
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), configBefore);
    assert.deepStrictEqual(fs.readdirSync(target.generationsDir).sort(), gensBefore, "no new generation");
  });

  it("surfaces a failed lock release as success-with-warning, not clean success", () => {
    const home = makeHome("clawd-r3-release-");
    registerOpencodePlugin({ silent: true, homeDir: home });
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    // Make this source dead so the run performs a real owner takeover.
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = path.join(home, "dead-src");
    owner.activeSourceMarker = path.join(home, "dead-src", "opencode-plugin", "index.mjs");
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    const lockDir = target.lockPath;
    const fakeFs = new Proxy(fs, {
      get(targetFs, prop) {
        if (prop === "rmdirSync") {
          return (dir, ...rest) => {
            if (String(dir) === String(lockDir)) {
              const err = new Error("busy");
              err.code = "ENOTEMPTY";
              throw err;
            }
            return fs.rmdirSync(dir, ...rest);
          };
        }
        return targetFs[prop];
      },
    });

    const result = registerOpencodePlugin({ silent: true, homeDir: home, fs: fakeFs });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.lockReleaseFailed, true);
    assert.ok(result.warnings.some((w) => w.includes(lockDir)), "warning must name the lock path");
    assert.ok(result.residualPaths.includes(lockDir));
    // The owner takeover still happened.
    const after = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    assert.strictEqual(canonical(after.activeSourceRoot), canonical(currentSourceRoot()));
  });
});

describe("#1026 plugin orphan inert gate", () => {
  function writeManagedLayout(root, { ownerOverrides = {}, writeOwner = true, agentId = "opencode" } = {}) {
    const crypto = require("crypto");
    const canonicalConfigDir = path.join(root, ".config", "opencode");
    const configHash = crypto.createHash("sha256").update(canonicalConfigDir).digest("hex");
    const bundleHash = "a".repeat(64);
    const agentHome = path.join(root, ".clawd", "integrations", "opencode-family", agentId, "homes", configHash);
    const genDir = path.join(agentHome, "generations", bundleHash);
    const familyDir = path.join(genDir, "opencode-family-plugin");
    fs.mkdirSync(familyDir, { recursive: true });
    const sourceFamily = path.join(__dirname, "..", "hooks", "opencode-family-plugin");
    fs.copyFileSync(path.join(sourceFamily, "core.mjs"), path.join(familyDir, "core.mjs"));
    fs.copyFileSync(path.join(sourceFamily, "session-ids.mjs"), path.join(familyDir, "session-ids.mjs"));
    const marker = path.join(root, "app", "hooks", "opencode-plugin", "index.mjs");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "export default async () => ({});\n");
    if (writeOwner) {
      fs.writeFileSync(path.join(agentHome, "owner.json"), JSON.stringify({
        schema: 1,
        owner: "clawd-on-desk.opencode-family.target",
        agentId,
        canonicalConfigDir,
        configDirHash: configHash,
        activeSourceRoot: path.dirname(path.dirname(marker)),
        activeSourceMarker: marker,
        knownRegisteredPaths: [],
        updatedAt: "x",
        ...ownerOverrides,
      }, null, 2));
    }
    return { corePath: path.join(familyDir, "core.mjs"), marker };
  }

  it("returns an empty handler before any side effect when the owner record is missing", async () => {
    const root = tmp("clawd-inert-missing-");
    const { corePath } = writeManagedLayout(root, { writeOwner: false });
    const fakeHome = tmp("clawd-inert-home-");
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const mod = await import(pathToFileURL(corePath).href);
      const gate = mod.evaluateManagedLayoutGate(pathToFileURL(corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
      assert.strictEqual(gate.mode, "inert");
      const plugin = mod.createOpencodeFamilyPlugin({ agentId: "opencode", hookSource: "opencode-plugin", logFileName: "opencode-plugin.log", sessionIdPrefix: "opencode:" });
      const handler = await plugin({});
      assert.strictEqual(typeof handler.event, "function");
      // resetDebugLog() would have created the debug log; inert must not.
      assert.strictEqual(fs.existsSync(path.join(fakeHome, ".clawd", "opencode-plugin.log")), false);
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile; else delete process.env.USERPROFILE;
    }
  });

  it("goes inert on a foreign owner, agent mismatch and a missing source marker", async () => {
    const core = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
    const mod = await import(pathToFileURL(core).href);

    const foreign = tmp("clawd-inert-foreign-");
    const foreignLayout = writeManagedLayout(foreign, { ownerOverrides: { owner: "someone-else" } });
    assert.strictEqual(
      mod.evaluateManagedLayoutGate(pathToFileURL(foreignLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" }).mode,
      "inert"
    );

    const mismatch = tmp("clawd-inert-agent-");
    const mismatchLayout = writeManagedLayout(mismatch, { agentId: "mimocode" });
    assert.strictEqual(
      mod.evaluateManagedLayoutGate(pathToFileURL(mismatchLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" }).mode,
      "inert"
    );

    const deadMarker = tmp("clawd-inert-marker-");
    const deadLayout = writeManagedLayout(deadMarker);
    assert.strictEqual(
      mod.evaluateManagedLayoutGate(pathToFileURL(deadLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" }).mode,
      "managed-live"
    );
    fs.rmSync(deadLayout.marker);
    const after = mod.evaluateManagedLayoutGate(pathToFileURL(deadLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(after.mode, "inert");
    assert.strictEqual(after.reason, "source-marker-missing");
  });

  it("source-direct layouts are never treated as inert", async () => {
    const sourceCore = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
    const mod = await import(pathToFileURL(sourceCore).href);
    const result = mod.evaluateManagedLayoutGate(pathToFileURL(sourceCore).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(result.mode, "source-direct");
  });

  it("goes inert when the owner source root/marker shape is wrong", async () => {
    const core = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
    const mod = await import(pathToFileURL(core).href);

    // Wrong plugin directory under the same root.
    const wrongPlugin = tmp("clawd-inert-plugin-");
    const wrongLayout = writeManagedLayout(wrongPlugin);
    const wrongOwnerPath = path.join(path.dirname(path.dirname(path.dirname(path.dirname(wrongLayout.corePath)))), "owner.json");
    const wrongOwner = JSON.parse(fs.readFileSync(wrongOwnerPath, "utf8"));
    wrongOwner.activeSourceMarker = path.join(path.dirname(wrongOwner.activeSourceRoot), "mimocode-plugin", "index.mjs");
    fs.writeFileSync(wrongOwnerPath, JSON.stringify(wrongOwner, null, 2));
    const wrongGate = mod.evaluateManagedLayoutGate(pathToFileURL(wrongLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(wrongGate.mode, "inert");
    assert.strictEqual(wrongGate.reason, "source-marker-plugin-dir");

    // Root/marker mismatch.
    const wrongRoot = tmp("clawd-inert-root-");
    const rootLayout = writeManagedLayout(wrongRoot);
    const rootOwnerPath = path.join(path.dirname(path.dirname(path.dirname(path.dirname(rootLayout.corePath)))), "owner.json");
    const rootOwner = JSON.parse(fs.readFileSync(rootOwnerPath, "utf8"));
    rootOwner.activeSourceRoot = path.join(wrongRoot, "elsewhere");
    fs.writeFileSync(rootOwnerPath, JSON.stringify(rootOwner, null, 2));
    const rootGate = mod.evaluateManagedLayoutGate(pathToFileURL(rootLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(rootGate.mode, "inert");
    assert.strictEqual(rootGate.reason, "source-marker-root-mismatch");

    // No active source root at all.
    const released = tmp("clawd-inert-released-");
    const releasedLayout = writeManagedLayout(released, { ownerOverrides: { activeSourceRoot: null, activeSourceMarker: null } });
    const releasedGate = mod.evaluateManagedLayoutGate(pathToFileURL(releasedLayout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(releasedGate.mode, "inert");
  });

  it("goes inert on malformed owner records (missing dir, bad hash, oversized history)", async () => {
    const core = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
    const mod = await import(pathToFileURL(core).href);
    const gate = (layout) => mod.evaluateManagedLayoutGate(pathToFileURL(layout.corePath).href, {
      agentId: "opencode",
      pluginDirName: "opencode-plugin",
    }).mode;

    const missingDir = tmp("clawd-inert-nodir-");
    assert.strictEqual(gate(writeManagedLayout(missingDir, {
      ownerOverrides: { canonicalConfigDir: undefined },
    })), "inert");

    const badHash = tmp("clawd-inert-badhash-");
    assert.strictEqual(gate(writeManagedLayout(badHash, {
      ownerOverrides: { canonicalConfigDir: "/some/other/dir" },
    })), "inert");

    const overCap = tmp("clawd-inert-overcap-");
    assert.strictEqual(gate(writeManagedLayout(overCap, {
      ownerOverrides: { knownRegisteredPaths: Array.from({ length: 17 }, (_, i) => `/managed/${i}/opencode-plugin`) },
    })), "inert");

    const relative = tmp("clawd-inert-relpath-");
    assert.strictEqual(gate(writeManagedLayout(relative, {
      ownerOverrides: { knownRegisteredPaths: ["relative/opencode-plugin"] },
    })), "inert");
  });

  it("goes inert when the active source marker is a directory (#1026 r1)", async () => {
    const root = tmp("clawd-inert-dir-");
    const layout = writeManagedLayout(root);
    fs.rmSync(layout.marker);
    fs.mkdirSync(layout.marker, { recursive: true });
    const core = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
    const mod = await import(pathToFileURL(core).href);
    const gate = mod.evaluateManagedLayoutGate(pathToFileURL(layout.corePath).href, { agentId: "opencode", pluginDirName: "opencode-plugin" });
    assert.strictEqual(gate.mode, "inert");
    assert.strictEqual(gate.reason, "source-marker-not-a-file");
  });
});

describe("#1026 r1 tuple migration (OpenCode 1.18.31 contract)", () => {
  // Evidence recorded in hooks/opencode-family-entry-ownership.js:
  // `opencode debug config` on 1.18.31 accepts [specifier, optionsObject] and
  // rejects a non-object second item. These tests pin the end-to-end writeback.
  function configWith(value) {
    const dir = tmp("clawd-tuple-");
    const configPath = path.join(dir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: value }, null, 2), "utf8");
    return configPath;
  }

  it("migrates a legacy tuple in place, preserving the options object value-for-value", () => {
    const legacy = resolveSourcePluginDir().replace(/\\/g, "/");
    const options = { model: "keep", nested: { effort: "high", list: [1, 2, 3] } };
    const configPath = configWith([[legacy, options]]);
    const canonical = "/managed/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir: canonical });
    assert.strictEqual(result.status, "ok", JSON.stringify(result));

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Exactly one entry, still a tuple, specifier replaced, options untouched.
    assert.strictEqual(written.plugin.length, 1);
    assert.ok(Array.isArray(written.plugin[0]));
    assert.strictEqual(written.plugin[0][0], canonical);
    assert.deepStrictEqual(written.plugin[0][1], options);
    assert.ok(!JSON.stringify(written.plugin[0]).includes('[[["'), "tuple must not nest");
  });

  it("converges duplicate tuples with identical options to one canonical entry", () => {
    const legacy = resolveSourcePluginDir().replace(/\\/g, "/");
    const options = { model: "m" };
    const configPath = configWith([[legacy, options], [legacy, options]]);
    const canonical = "/managed/opencode-plugin";

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir: canonical });
    assert.strictEqual(result.status, "ok", JSON.stringify(result));
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepStrictEqual(written.plugin, [[canonical, options]]);
  });

  it("refuses conflicting tuple options with zero config mutation", () => {
    const legacy = resolveSourcePluginDir().replace(/\\/g, "/");
    const configPath = configWith([[legacy, { model: "a" }], [legacy, { model: "b" }]]);
    const before = fs.readFileSync(configPath, "utf8");

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir: "/managed/opencode-plugin" });
    assert.strictEqual(result.status, "error");
    assert.match(result.reason, /tuple-options-conflict|ownership-conflict/);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), before);
  });

  it("preserves a malformed tuple (non-object options) instead of corrupting it", () => {
    const legacy = resolveSourcePluginDir().replace(/\\/g, "/");
    const configPath = configWith([[legacy, "/not-an-object"]]);
    const before = fs.readFileSync(configPath, "utf8");

    const result = registerOpencodePlugin({ silent: true, configPath, pluginDir: "/managed/opencode-plugin" });
    assert.strictEqual(result.status, "ok", JSON.stringify(result));
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // The malformed entry is left byte-preserved and canonical is appended.
    assert.deepStrictEqual(written.plugin, [[legacy, "/not-an-object"], "/managed/opencode-plugin"]);
    assert.notStrictEqual(fs.readFileSync(configPath, "utf8"), before);
  });
});

describe("#1026 r1 uninstall must never report a remaining active entry removed", () => {
  function homeConfig(home, pluginArray) {
    const dir = path.join(home, ".config", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: pluginArray }, null, 2), "utf8");
    return configPath;
  }

  function dirConfig(dir, pluginArray) {
    const configPath = path.join(dir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: pluginArray }, null, 2), "utf8");
    return configPath;
  }

  function makeModifiedCopy(root) {
    const copy = path.join(root, "workaround", "opencode-plugin");
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "index.mjs"), 'import { createOpencodeFamilyPlugin } from "../opencode-family-plugin/core.mjs";\nexport default createOpencodeFamilyPlugin({});\n');
    fs.mkdirSync(path.join(root, "workaround", "opencode-family-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, "workaround", "opencode-family-plugin", "core.mjs"), "");
    return copy.replace(/\\/g, "/");
  }

  it("returns error (registrationRemoved:false) for a lone modified Clawd-like entry with no targetRoot", () => {
    const home = tmp("clawd-uninstall-mod-");
    const copy = makeModifiedCopy(home);
    const configPath = homeConfig(home, [copy]);

    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).plugin, [copy]);
    assert.ok(result.details && result.details.length >= 1, "must carry precise remediation");
  });

  it("returns error for multiple missing basename-like candidates (ambiguous/unknown)", () => {
    const home = tmp("clawd-uninstall-ambig-");
    const configPath = homeConfig(home, ["/a/opencode-plugin", "/b/opencode-plugin"]);

    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).plugin, ["/a/opencode-plugin", "/b/opencode-plugin"]);
  });

  it("returns error for a managed-corrupt entry that stays active", () => {
    const home = tmp("clawd-uninstall-corrupt-");
    // Create the config directory before deriving its canonical managed target.
    // On macOS /var resolves to /private/var only after the path exists; doing
    // this in the opposite order accidentally builds the corrupt fixture under
    // a different configDirHash and tests an unrelated absent target.
    const configPath = homeConfig(home, []);
    const target = mg.resolveManagedTarget({ cfg: OPENCODE_CFG, agentId: "opencode", homeDir: home, fs, platform: process.platform });
    const genDir = path.join(target.generationsDir, "a".repeat(64));
    const pluginDir = path.join(genDir, "opencode-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(genDir, "manifest.json"), "{ broken");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [pluginDir.replace(/\\/g, "/")] }), "utf8");

    const result = unregisterOpencodePlugin({ silent: true, homeDir: home });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.strictEqual(result.activeEntryRemaining, true);
  });

  it("configPath-only sweep also fails closed on an active modified entry", () => {
    const root = tmp("clawd-uninstall-cpo-");
    const copy = makeModifiedCopy(root);
    const configPath = dirConfig(root, [copy]);

    const result = unregisterOpencodePlugin({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.registrationRemoved, false);
    assert.ok(result.warnings.some((w) => w.includes("managed-root-unknown")));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).plugin, [copy]);
  });

  it("unregister re-checks a legacy-missing candidate just before writing", () => {
    // Classification says the path is missing (stale scan), but the real fs
    // now shows it exists — the sweep must abort with zero mutation.
    const home = tmp("clawd-uninstall-recheck-");
    const realPlugin = path.join(home, "opencode-plugin");
    fs.mkdirSync(realPlugin, { recursive: true });
    // Classification uses an injected `exists:false` (a stale scan), but the
    // path really exists on disk — the pre-write recheck must abort.
    const configPath = dirConfig(home, [realPlugin.replace(/\\/g, "/")]);
    const jsonc = require("../hooks/opencode-family-jsonc");

    const staleCtx = {
      pluginDirName: "opencode-plugin",
      expectedCanonicalDir: null,
      targetRoot: null,
      sourcePluginDir: null,
      knownRegisteredPaths: new Set([realPlugin.replace(/\\/g, "/")]),
      canonicalize: (p) => String(p).replace(/\\/g, "/"),
      canonicalizeStrict: (p) => String(p).replace(/\\/g, "/"),
      exists: () => false,
      probeIndeterminate: () => false,
      inspectExpectedGeneration: () => ({ ok: true }),
      inspectManagedBoundary: () => ({ state: "corrupt" }),
      bundleBytesMatch: () => false,
      isClawdLike: () => false,
    };
    const candidates = jsonc.readCandidates(OPENCODE_CFG, configPath);
    const apply = jsonc.applyManagedUnregister({
      cfg: OPENCODE_CFG,
      configPath,
      candidates,
      makeContext: () => staleCtx,
      options: { fs, platform: process.platform },
    });
    assert.ok(apply.error, "expected the pre-write recheck to fail closed");
    assert.strictEqual(apply.mutatedPaths.length, 0);
  });
});
