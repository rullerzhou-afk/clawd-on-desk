"use strict";

// #1026 Doctor: managed OpenCode generation inspector, Fix policy, masked
// supplementary warning and the MiMo no-regression contract.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, afterEach } = require("node:test");

const { checkAgentIntegrations } = require("../src/doctor-detectors/agent-integrations");
const { registerOpencodePlugin } = require("../hooks/opencode-install");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");

const tempDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeHome() {
  const home = tmp("clawd-doc-managed-");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  return home;
}

function managedDescriptor(home, overrides = {}) {
  const parentDir = path.join(home, ".config", "opencode");
  return {
    agentId: "opencode",
    agentName: "OpenCode",
    eventSource: "plugin-event",
    parentDir,
    configPath: path.join(parentDir, "opencode.json"),
    configMode: "file",
    autoInstall: true,
    marker: "opencode-plugin",
    detection: "opencode-plugin",
    configJsonc: true,
    configCandidates: ["opencode.jsonc", "opencode.json", "config.json"].map((n) => path.join(parentDir, n)),
    managedMaterialization: true,
    managedHomeDir: home,
    ...overrides,
  };
}

function runOne(descriptor, v2Host = "v2") {
  return checkAgentIntegrations({
    fs,
    platform: process.platform,
    prefs: {},
    descriptors: [descriptor],
    server: null,
    // Hermetic host verdict: production probes the real binary inside the
    // inspector (upstream PR #1045 review); tests pin it explicitly.
    v2Host,
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("#1026 managed OpenCode Doctor", () => {
  it("reports a healthy canonical managed generation as ok", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("issue #1039: a healthy v2-host install is verified from the plugins key", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "ok");
    assert.ok(Array.isArray(detail.v2Entries) && detail.v2Entries.length === 1, "v2 entry listed");
    assert.ok(/v2 plugins-key entry verified/.test(detail.detail), detail.detail);
  });

  it("PR #1182 follow-up: the v1.3.0 dual-key config is repairable on a v2 host and Repair sweeps the v1 entry", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    // Rebuild what v1.3.0 wrote on a v2 host: the v1 entry (sibling dir of the
    // same generation) under `plugin` next to the v2 entry under `plugins`.
    const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const v1Entry = path.join(path.dirname(cfg.plugins[0]), "opencode-plugin").replace(/\\/g, "/");
    writeJson(cfgPath, { ...cfg, plugin: [v1Entry] });

    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "duplicate-entry");
    assert.strictEqual(detail.v2EntryState, "ok");
    assert.ok(detail.fixAction, "repairable via Fix");
    assert.match(detail.detail, /leftover legacy v1 plugin entry/);

    const repair = registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    assert.strictEqual(repair.status, "ok", repair.message);
    const repaired = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.deepStrictEqual(repaired.plugin, [], "v1 entry swept");
    assert.deepStrictEqual(repaired.plugins, cfg.plugins, "v2 entry untouched");

    const after = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(after.status, "ok");
  });

  it("PR #1182 follow-up: a swept v2 install downgraded to 1.x reports the leftover v2 entry, not not-connected", () => {
    for (const plugin of [[], ["@vendor/keep"]]) {
      const home = makeHome();
      registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
      // The v2-host sweep leaves an empty (or foreign-only) `plugin` array.
      const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      writeJson(cfgPath, { ...cfg, plugin });

      const detail = runOne(managedDescriptor(home), "v1").details[0];
      assert.strictEqual(detail.status, "broken-path", JSON.stringify(plugin));
      assert.strictEqual(detail.v2EntryState, "leftover");
      assert.ok(detail.fixAction, "repairable via Fix");

      const repair = registerOpencodePlugin({ silent: true, v2Host: "v1", homeDir: home });
      assert.strictEqual(repair.status, "ok", repair.message);
      assert.strictEqual(runOne(managedDescriptor(home), "v1").details[0].status, "ok");
    }
  });

  it("issue #1039: a leftover v1 entry without the v2 key is a repairable legacy-path, never ok", () => {
    const home = makeHome();
    // Simulate a pre-#1039 install: a v1 `plugin` entry with no `plugins` key.
    // opencode 2.x rejects that function entry, so Repair must convert it.
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      plugin: [require("../hooks/opencode-install").resolveSourcePluginDir().replace(/\\/g, "/")],
    });

    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "legacy-path");
    assert.strictEqual(detail.v2EntryState, "missing");
    assert.ok(detail.fixAction, "repairable via Fix");
    assert.match(detail.detail, /v2 entry is not registered/);
  });

  it("issue #1045 review: a detected 1.x host makes the missing v2 key fully ok", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v1", homeDir: home });

    const detail = runOne(managedDescriptor(home), "v1").details[0];
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.v2EntryState, "not-required");
    assert.strictEqual(detail.fixAction, undefined);
    assert.match(detail.detail, /not required/);
  });

  it("requires manual review for retained v2 keys without owned entries on a v1 host", () => {
    for (const plugins of [[], ["third-party@latest"], { package: "third-party" }]) {
      const home = makeHome();
      registerOpencodePlugin({ silent: true, v2Host: "v1", homeDir: home });
      const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, plugins }));
      const before = fs.readFileSync(cfgPath, "utf8");
      const detail = runOne(managedDescriptor(home), "v1").details[0];
      assert.strictEqual(detail.status, "needs-review");
      assert.strictEqual(detail.fixAction, undefined);
      assert.match(detail.detail, /rejects even when empty/);
      assert.strictEqual(fs.readFileSync(cfgPath, "utf8"), before);
    }
  });

  it("issue #1045 review: an unknown host with a missing v2 key is ok too", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v1", homeDir: home });

    const detail = runOne(managedDescriptor(home), "unknown").details[0];
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.v2EntryState, "not-required");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("issue #1045 review: a leftover v2 entry on a 1.x host is repairable and Repair sweeps it", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const cfgPath = path.join(home, ".config", "opencode", "opencode.json");

    // The host downgraded to 1.x while the v2 entry is still registered.
    const detail = runOne(managedDescriptor(home), "v1").details[0];
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.v2EntryState, "leftover");
    assert.ok(detail.fixAction, "repairable via Fix");

    // Fix → syncOpencodePlugin → register under the detected v1 host.
    const repair = registerOpencodePlugin({ silent: true, v2Host: "v1", homeDir: home });
    assert.strictEqual(repair.status, "ok", repair.message);
    assert.strictEqual(Object.hasOwn(JSON.parse(fs.readFileSync(cfgPath, "utf8")), "plugins"), false);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const leftover = (cfg.plugins || []).filter((entry) => String(entry).includes("opencode-plugin-v2"));
    assert.deepStrictEqual(leftover, [], "v2 leftover swept");
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1, "v1 entry survives the sweep");

    const after = runOne(managedDescriptor(home), "v1").details[0];
    assert.strictEqual(after.status, "ok");
  });

  it("reports no Clawd entry as a repairable not-connected", () => {
    const home = makeHome();
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), { plugin: ["@vendor/keep"] });
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "not-connected");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "opencode" });
  });

  it("requires manual review for an unverified legacy-looking source entry", () => {
    const home = makeHome();
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), { plugin: ["/app/hooks/opencode-plugin"] });
    // This literal is not the resolved source path for the current checkout.
    // A basename match alone cannot establish ownership.
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.fixAction, undefined);
    assert.ok(detail.opencodeRemediation && detail.opencodeRemediation.length >= 1);
  });

  it("reports a modified Clawd-like copy as needs-review with no Fix and remediation", () => {
    const home = makeHome();
    const copy = path.join(home, "workaround", "opencode-plugin");
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "index.mjs"), 'import { createOpencodeFamilyPlugin } from "../opencode-family-plugin/core.mjs";\nexport default createOpencodeFamilyPlugin({});\n');
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), { plugin: [copy.replace(/\\/g, "/")] });

    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.fixAction, undefined);
    assert.match(detail.detail, /manual review/i);
    assert.ok(detail.opencodeRemediation && detail.opencodeRemediation.length >= 1);
    assert.strictEqual(detail.opencodeRemediation[0].remediation.index, 0);
  });

  it("keeps the aggregate pass when a masked lower-priority file adds only foreign v1 entries", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const jsonPath = path.join(home, ".config", "opencode", "opencode.json");
    const jsoncPath = path.join(home, ".config", "opencode", "opencode.jsonc");
    // Promote the registered config to the higher-priority .jsonc, then add a
    // masked lower-priority .json that declares only a foreign npm plugin.
    // Foreign entries must never turn the healthy v2 install into a failure.
    fs.writeFileSync(jsoncPath, fs.readFileSync(jsonPath, "utf8"));
    fs.rmSync(jsonPath);
    writeJson(jsonPath, { plugin: ["@vendor/keep"] });

    const report = runOne(managedDescriptor(home));
    const detail = report.details[0];
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.fixAction, undefined);
    assert.strictEqual(report.status, "pass");
  });

  it("reports owner-conflict (other live source) as needs-review with no Fix", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const target = require("../hooks/opencode-family-managed-generation").resolveManagedTarget({
      cfg: require("../agents/opencode-family").getFamilyConfig("opencode"),
      agentId: "opencode",
      homeDir: home,
      fs,
      platform: process.platform,
    });
    const otherMarker = path.join(home, "other-app", "hooks", "opencode-plugin", "index.mjs");
    fs.mkdirSync(path.dirname(otherMarker), { recursive: true });
    fs.writeFileSync(otherMarker, "x");
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = path.dirname(path.dirname(otherMarker));
    owner.activeSourceMarker = otherMarker;
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));

    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.fixAction, undefined);
    assert.ok(detail.ownerConflict);
    assert.match(detail.detail, /another live Clawd source/);
  });

  it("MiMo (flag=false) never produces the managed duplicate-entry status", () => {
    const home = tmp("clawd-doc-mimo-");
    const parentDir = path.join(home, ".config", "mimocode");
    fs.mkdirSync(parentDir, { recursive: true });
    const descriptor = {
      agentId: "mimocode",
      agentName: "MiMo Code",
      eventSource: "plugin-event",
      parentDir,
      configPath: path.join(parentDir, "mimocode.jsonc"),
      configMode: "file",
      autoInstall: true,
      marker: "mimocode-plugin",
      detection: "opencode-plugin",
      configJsonc: true,
      configCandidates: ["mimocode.jsonc", "mimocode.json", "config.json"].map((n) => path.join(parentDir, n)),
      managedMaterialization: false,
      managedHomeDir: home,
    };
    fs.writeFileSync(path.join(parentDir, "mimocode.jsonc"), JSON.stringify({
      plugin: ["/a/mimocode-plugin", "/b/mimocode-plugin"],
    }));
    const detail = runOne(descriptor).details[0];
    assert.notStrictEqual(detail.status, "duplicate-entry");
  });

  function managedTarget(home) {
    return require("../hooks/opencode-family-managed-generation").resolveManagedTarget({
      cfg: require("../agents/opencode-family").getFamilyConfig("opencode"),
      agentId: "opencode",
      homeDir: home,
      fs,
      platform: process.platform,
    });
  }

  it("never reports ok when the owner record is missing", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const target = managedTarget(home);
    fs.rmSync(target.ownerPath);
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("never reports ok when the owner record is released", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const target = managedTarget(home);
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.activeSourceRoot = null;
    owner.activeSourceMarker = null;
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "needs-review");
    assert.strictEqual(detail.ownerRecordState, "released");
  });

  it("never reports ok when the source marker is dead or a directory", () => {
    // Use a fake source root under the temp home so the REAL packaged source is
    // never mutated by a test.
    function pointOwnerAt(home, markerPath) {
      registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
      const target = managedTarget(home);
      const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
      owner.activeSourceRoot = path.join(home, "fake-src");
      owner.activeSourceMarker = markerPath;
      fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));
    }

    const dead = makeHome();
    pointOwnerAt(dead, path.join(dead, "fake-src", "opencode-plugin", "index.mjs"));
    assert.strictEqual(runOne(managedDescriptor(dead)).details[0].status, "needs-review");

    const dir = makeHome();
    const dirMarker = path.join(dir, "fake-src", "opencode-plugin", "index.mjs");
    fs.mkdirSync(dirMarker, { recursive: true });
    pointOwnerAt(dir, dirMarker);
    assert.strictEqual(runOne(managedDescriptor(dir)).details[0].status, "needs-review");
  });

  it("never reports ok when the owner record is malformed", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const target = managedTarget(home);
    fs.writeFileSync(target.ownerPath, "{ not json");
    assert.strictEqual(runOne(managedDescriptor(home)).details[0].status, "needs-review");
  });

  it("never reports ok when the owner config identity mismatches", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const target = managedTarget(home);
    const owner = JSON.parse(fs.readFileSync(target.ownerPath, "utf8"));
    owner.canonicalConfigDir = path.join(home, "some", "other", "config");
    fs.writeFileSync(target.ownerPath, JSON.stringify(owner, null, 2));
    assert.strictEqual(runOne(managedDescriptor(home)).details[0].status, "needs-review");
  });

  it("surfaces duplicate top-level plugin keys as config-corrupt", () => {
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "opencode.json"),
      '{\n  "plugin": ["/a/opencode-plugin"],\n  "plugin": ["/b/opencode-plugin"]\n}'
    );
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "config-corrupt");
  });

  it("PR #1045 follow-up: surfaces duplicate top-level plugins keys as config-corrupt without throwing", () => {
    const home = makeHome();
    const configText = '{\n  "plugins": ["/a/opencode-plugin-v2"],\n  "plugins": ["/b/opencode-plugin-v2"]\n}\n';
    fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), configText);
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.fixAction, undefined);
    assert.match(detail.detail, /"plugins"/);
    assert.strictEqual(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"), configText);
  });

  it("PR #1045 follow-up: config-corrupt names the candidate file that actually failed", () => {
    const home = makeHome();
    // The failing candidate is opencode.jsonc, NOT the descriptor's default
    // opencode.json.
    const jsoncPath = path.join(home, ".config", "opencode", "opencode.jsonc");
    const text = '{\n  "plugins": ["/a/opencode-plugin-v2"],\n  "plugins": ["/b/opencode-plugin-v2"]\n}\n';
    fs.writeFileSync(jsoncPath, text);
    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.configPath, jsoncPath);
    assert.ok(detail.detail.includes(jsoncPath), detail.detail);
    assert.strictEqual(/opencode\.json:/.test(detail.detail), false, "detail must not name a different path");
  });

  it("reports a masked safe owned entry as repairable, not ok", () => {
    const home = makeHome();
    registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    const jsonPath = path.join(home, ".config", "opencode", "opencode.json");
    const jsoncPath = path.join(home, ".config", "opencode", "opencode.jsonc");
    // Effective canonical lives in .jsonc; masked .json carries a legacy source.
    fs.writeFileSync(jsoncPath, fs.readFileSync(jsonPath, "utf8"));
    fs.rmSync(jsonPath);
    writeJson(jsonPath, { plugin: [require("../hooks/opencode-install").resolvePluginDir().replace(/\\/g, "/")] });

    const detail = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(detail.status, "duplicate-entry");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "opencode" });
  });

  // The pre-#1039 four-file generation must keep classifying as an owned-stale
  // shape so Repair can migrate it. This builds a
  // REAL four-file generation (manifest, bundleHash and owner record all
  // consistent with four files) rather than deleting the v2 key from a current
  // five-file one — the old test never exercised this upgrade path.
  function writeLegacyFourFileGeneration(home) {
    const mg = require("../hooks/opencode-family-managed-generation");
    const family = require("../agents/opencode-family");
    const cfg = family.getFamilyConfig("opencode");
    const sourcePluginDir = require("../hooks/opencode-install").resolveSourcePluginDir();
    const bundle = mg.readSourceBundle(cfg, sourcePluginDir, fs);
    const fourFiles = bundle.files.filter((file) => !file.rel.startsWith(`${cfg.v2PluginDirName}/`));
    assert.strictEqual(fourFiles.length, 4, "legacy generation holds exactly four files");
    const bundleHash = mg.computeBundleHash("opencode", fourFiles);
    const target = mg.resolveManagedTarget({
      cfg, agentId: "opencode", homeDir: home, fs, platform: process.platform,
    });
    const genDir = mg.generationDir(target, bundleHash);
    for (const file of fourFiles) {
      const abs = path.join(genDir, ...file.rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.bytes);
    }
    fs.writeFileSync(
      path.join(genDir, "manifest.json"),
      JSON.stringify(mg.buildManifest("opencode", fourFiles, bundleHash, null), null, 2)
    );
    mg.writeOwnerRecord(target, {
      agentId: "opencode",
      activeSourceRoot: path.dirname(sourcePluginDir),
      activeSourceMarker: path.join(sourcePluginDir, "index.mjs"),
      knownRegisteredPaths: [path.join(genDir, cfg.pluginDirName)],
    }, fs, { platform: process.platform, pluginDirName: cfg.pluginDirName });
    const entry = path.join(genDir, cfg.pluginDirName).replace(/\\/g, "/");
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), { plugin: [entry] });
    return { genDir, entry, bundleHash, cfg };
  }

  it("PR #1045 follow-up: migrates a real four-file legacy generation through Repair", () => {
    const home = makeHome();
    const legacy = writeLegacyFourFileGeneration(home);
    assert.strictEqual(fs.existsSync(path.join(legacy.genDir, legacy.cfg.v2PluginDirName)), false);

    // 1. Doctor sees a repairable owned-stale generation, never ok.
    const before = runOne(managedDescriptor(home)).details[0];
    assert.ok(["legacy-path", "broken-path"].includes(before.status), `unexpected status ${before.status}`);
    assert.ok(before.fixAction, "the legacy generation must be repairable");

    // 2. Repair (register under a v2 host) materializes a new five-file
    //    generation, registers ONLY the v2 plugins key, and sweeps the legacy
    //    v1 entry (opencode 2.x rejects the v1 function entry).
    const repaired = registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    assert.strictEqual(repaired.status, "ok", repaired.message);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
    assert.ok(
      !(cfg.plugin || []).some((entry) => String(entry).includes("opencode-plugin")),
      "legacy v1 entry swept"
    );
    const v2Entry = cfg.plugins.find((entry) => String(entry).includes("opencode-plugin-v2"));
    assert.ok(v2Entry, "v2 plugins key registered");
    const migratedGenDir = path.dirname(String(v2Entry).replace(/\//g, path.sep));
    assert.notStrictEqual(path.resolve(migratedGenDir), path.resolve(legacy.genDir), "migrated to the five-file hash");
    for (const rel of ["index.mjs", "package.json"]) {
      assert.ok(fs.existsSync(path.join(migratedGenDir, legacy.cfg.pluginDirName, rel)));
    }
    assert.ok(fs.existsSync(path.join(migratedGenDir, legacy.cfg.v2PluginDirName, "index.mjs")), "five-file generation");

    // 3. Doctor is healthy after the migration.
    const after = runOne(managedDescriptor(home)).details[0];
    assert.strictEqual(after.status, "ok");
    assert.strictEqual(after.fixAction, undefined);

    // 4. A second Repair is a no-op with a byte-identical config.
    const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
    const stable = fs.readFileSync(cfgPath, "utf8");
    const again = registerOpencodePlugin({ silent: true, v2Host: "v2", homeDir: home });
    assert.strictEqual(again.skipped, true, "second Repair is a no-op");
    assert.strictEqual(fs.readFileSync(cfgPath, "utf8"), stable);
  });

  it("the real opencode descriptor opts into the managed inspector", () => {
    const descriptor = getAgentDescriptor("opencode");
    assert.strictEqual(descriptor.managedMaterialization, true);
    assert.ok(typeof descriptor.managedHomeDir === "string" && descriptor.managedHomeDir);
    const mimo = getAgentDescriptor("mimocode");
    assert.strictEqual(mimo.managedMaterialization, false);
  });
});
