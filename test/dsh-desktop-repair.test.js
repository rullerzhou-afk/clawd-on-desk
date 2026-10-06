"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PACKAGE_NAME,
  DSH_VERSION_FAMILIES,
  installDeepSeekHarnessBridge,
  uninstallDeepSeekHarnessBridge,
  resolveManagedRoot,
} = require("../hooks/dsh-install");
const { __test: dshInstallTest } = require("../hooks/dsh-install");
const { desktopFound: platformDesktopFound, symlinkDir } = require("./dsh-desktop-fixtures");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const FAMILY = DSH_VERSION_FAMILIES[0];
const FAMILY_VERSION = FAMILY.minVersion;
const FAMILY_RANGE = FAMILY.range;

const NO_DESKTOP = Object.freeze({
  status: "not-found",
  appRoot: null,
  launcherPath: null,
  staticVersion: null,
  checkedPaths: [],
  reason: null,
});

function desktopFound(harness) {
  return platformDesktopFound(harness.root);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packageDir(dshHome, profile) {
  return path.join(dshHome, "profiles", profile, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
}

function makeHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-repair-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "dsh"), "#!/bin/sh\n");
  return { root, dshHome: path.join(root, ".dsh"), managedRoot: path.join(root, "managed"), binDir };
}

function managedRootOf(harness) {
  return resolveManagedRoot({ managedRoot: harness.managedRoot });
}

function targetBundleHash() {
  return dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, { supportedDshRange: FAMILY_RANGE });
}

function writeGeneration(dir, bundleHash) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SOURCE_DIR, dir, { recursive: true });
  writeJson(path.join(dir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: FAMILY_RANGE,
    installedDshVersion: FAMILY_VERSION,
    installedDshVersionAssumedAtStaging: false,
    sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
}

// Dependency present, bundle line missing: the state DSH leaves when a plugin
// is disabled.
function writeIncompleteProfile(harness, profile) {
  const bundleHash = targetBundleHash();
  const generationDir = path.join(managedRootOf(harness), "generations", bundleHash);
  writeGeneration(generationDir, bundleHash);
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  writeJson(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  const local = packageDir(harness.dshHome, profile);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.cpSync(generationDir, local, { recursive: true });
  return { generationDir, bundleHash, profileDir };
}

function writeForeignProfile(harness, profile) {
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  writeJson(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: "file:/foreign" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
  });
  const local = packageDir(harness.dshHome, profile);
  writeJson(path.join(local, "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "9.9.9" });
  return profileDir;
}

function recordFor(harness, profile, state, overrides = {}) {
  const bundleHash = targetBundleHash();
  return {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    profile,
    state,
    targetBundleHash: bundleHash,
    targetGenerationDir: path.join(managedRootOf(harness), "generations", bundleHash),
    hostVersion: FAMILY_VERSION,
    carrierKind: profile === "desktop" ? "desktop" : "npm",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeRecord(harness, profile, record) {
  const filePath = dshInstallTest.repairOperationPath({ managedRoot: harness.managedRoot, profile });
  writeJson(filePath, record);
  return filePath;
}

function recordPath(harness, profile) {
  return dshInstallTest.repairOperationPath({ managedRoot: harness.managedRoot, profile });
}

// A fake dsh CLI that follows upstream add semantics: an already-present
// dependency is kept and the bundle line is NOT re-enabled.
function makeCli(harness, options = {}) {
  const calls = [];
  const runDshCommand = async (args) => {
    calls.push([...args]);
    const profile = args[args.indexOf("--profile") + 1];
    const action = args[3];
    const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
    const manifest = readJson(manifestPath);
    if (action === "remove") {
      if (options.beforeRemove) await options.beforeRemove({ profile });
      if (options.failRemove) return { code: 1, stderr: "remove denied" };
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      fs.rmSync(packageDir(harness.dshHome, profile), { recursive: true, force: true });
      if (options.afterRemove) await options.afterRemove({ profile });
      return { code: 0 };
    }
    if (action === "add") {
      if (options.failAdd) return { code: 1, stderr: "add denied" };
      const generationDir = args[4];
      const depPresent = Object.prototype.hasOwnProperty.call(
        manifest.dependencies || {},
        BRIDGE_PACKAGE_NAME
      );
      if (!depPresent) {
        manifest.dependencies ||= {};
        manifest.dsh ||= { profile: { bundles: [] } };
        manifest.dsh.profile ||= { bundles: [] };
        manifest.dsh.profile.bundles ||= [];
        manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
        if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
          manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
        }
        writeJson(manifestPath, manifest);
      }
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(generationDir, target, { recursive: true });
      if (options.afterAdd) await options.afterAdd({ profile });
      return { code: 0 };
    }
    return { code: 1, stderr: `unexpected args: ${args.join(" ")}` };
  };
  return { calls, runDshCommand };
}

// A profile whose package is a symlink to the generation, the layout a real
// `dsh plugin add` produces (and `dsh plugin remove` leaves behind).
function writeIncompleteLinkedProfile(harness, profile) {
  const bundleHash = targetBundleHash();
  const generationDir = path.join(managedRootOf(harness), "generations", bundleHash);
  writeGeneration(generationDir, bundleHash);
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  writeJson(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `link:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  const local = packageDir(harness.dshHome, profile);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  symlinkDir(generationDir, local);
  return { generationDir, bundleHash, profileDir };
}

// A fake CLI matching the observed upstream behavior: remove deletes the
// dependency and bundle row but leaves the node_modules link in place.
function makeLinkingCli(harness) {
  const calls = [];
  const runDshCommand = async (args) => {
    calls.push([...args]);
    const profile = args[args.indexOf("--profile") + 1];
    const action = args[3];
    const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
    const manifest = readJson(manifestPath);
    if (action === "remove") {
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      // Leave the link, like the real command does.
      return { code: 0 };
    }
    if (action === "add") {
      const generationDir = args[4];
      manifest.dependencies ||= {};
      manifest.dsh ||= { profile: { bundles: [] } };
      manifest.dsh.profile ||= { bundles: [] };
      manifest.dsh.profile.bundles ||= [];
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `link:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      symlinkDir(generationDir, target);
      return { code: 0 };
    }
    return { code: 1, stderr: `unexpected args: ${args.join(" ")}` };
  };
  return { calls, runDshCommand };
}

function orchOptions(harness, cli, overrides = {}) {
  return {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstalled: true,
    pnpmAvailable: true,
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: cli.runDshCommand,
    clawdVersion: "1.2.3",
    dshVersion: FAMILY_VERSION,
    dshInstallRoot: null,
    silent: true,
    env: { PATH: harness.binDir },
    desktopDiscovery: NO_DESKTOP,
    ...overrides,
  };
}

function desktopOptions(harness, cli, overrides = {}) {
  return orchOptions(harness, cli, {
    // A desktop-only scenario must not let web pick up the injected command.
    commandInfo: null,
    dshCommand: false,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
    ...overrides,
  });
}

function profileManifest(harness, profile) {
  return readJson(path.join(harness.dshHome, "profiles", profile, "package.json"));
}

function bundlePresent(harness, profile) {
  const manifest = profileManifest(harness, profile);
  return Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    && manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME);
}

function dependencyPresent(harness, profile) {
  const manifest = profileManifest(harness, profile);
  return Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, BRIDGE_PACKAGE_NAME);
}

function mutationOrder(cli) {
  return cli.calls
    .filter((args) => args[3] === "remove" || args[3] === "add")
    .map((args) => args[3]);
}

// ---------------------------------------------------------------------------
// Two-step repair success
// ---------------------------------------------------------------------------

for (const profile of ["web", "desktop"]) {
  test(`a disabled ${profile} plugin is repaired with remove then add`, async (t) => {
    const harness = makeHarness(t);
    const { generationDir } = writeIncompleteProfile(harness, profile);
    const states = [];
    const cli = makeCli(harness, {
      beforeRemove: () => { states.push(readJson(recordPath(harness, profile)).state); },
      afterAdd: () => { states.push(readJson(recordPath(harness, profile)).state); },
    });
    const options = profile === "web"
      ? orchOptions(harness, cli, { operation: "explicit-repair" })
      : desktopOptions(harness, cli, { operation: "explicit-repair" });
    const result = await installDeepSeekHarnessBridge(options);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.updated, true);
    assert.deepStrictEqual(states, ["remove-pending", "removed-add-pending"]);
    assert.deepStrictEqual(mutationOrder(cli), ["remove", "add"]);
    assert.strictEqual(bundlePresent(harness, profile), true);
    assert.strictEqual(dependencyPresent(harness, profile), true);
    assert.strictEqual(fs.existsSync(recordPath(harness, profile)), false);
    assert.strictEqual(fs.existsSync(generationDir), true);
    if (profile === "desktop") {
      assert.strictEqual(result.restartRequired, true);
      assert.strictEqual(result.firstInstall, false);
    }
  });
}

for (const profile of ["web", "desktop"]) {
  test(`a disabled ${profile} plugin with an upstream-retained link is repaired`, async (t) => {
    const harness = makeHarness(t);
    const { generationDir } = writeIncompleteLinkedProfile(harness, profile);
    const cli = makeLinkingCli(harness);
    const options = profile === "web"
      ? orchOptions(harness, cli, { operation: "explicit-repair" })
      : desktopOptions(harness, cli, { operation: "explicit-repair" });
    const result = await installDeepSeekHarnessBridge(options);
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(mutationOrder(cli), ["remove", "add"]);
    assert.strictEqual(bundlePresent(harness, profile), true);
    assert.strictEqual(dependencyPresent(harness, profile), true);
    assert.strictEqual(fs.existsSync(recordPath(harness, profile)), false);
    assert.strictEqual(fs.existsSync(generationDir), true);
  });

  test(`a disabled ${profile} plugin resumes when remove left the link behind`, async (t) => {
    const harness = makeHarness(t);
    const { generationDir } = writeIncompleteLinkedProfile(harness, profile);
    writeRecord(harness, profile, recordFor(harness, profile, "remove-pending"));
    const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
    const manifest = readJson(manifestPath);
    delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== BRIDGE_PACKAGE_NAME);
    writeJson(manifestPath, manifest);
    assert.strictEqual(fs.lstatSync(packageDir(harness.dshHome, profile)).isSymbolicLink(), true);

    const cli = makeLinkingCli(harness);
    const options = profile === "web"
      ? orchOptions(harness, cli, { operation: "explicit-repair" })
      : desktopOptions(harness, cli, { operation: "explicit-repair" });
    const result = await installDeepSeekHarnessBridge(options);
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(mutationOrder(cli), ["add"]);
    assert.strictEqual(bundlePresent(harness, profile), true);
    assert.strictEqual(fs.existsSync(recordPath(harness, profile)), false);
    assert.strictEqual(fs.existsSync(generationDir), true);
  });
}

test("a repair does not remove for a recorded target that fails verification", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const alternate = writeAlternateGeneration(harness);
  fs.appendFileSync(path.join(alternate.dir, "lib", "index.js"), "\n// tampered\n", "utf8");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetBundleHash: alternate.hash,
    targetGenerationDir: alternate.dir,
  }));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

test("a repair does not add when the target is corrupted after remove", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness, {
    afterRemove: () => {
      fs.appendFileSync(path.join(generationDir, "lib", "index.js"), "\n// tampered after remove\n", "utf8");
    },
  });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-target-integrity-failed");
  assert.deepStrictEqual(mutationOrder(cli), ["remove"]);
  assert.strictEqual(dependencyPresent(harness, "web"), false);
});

test("the old generation is only cleaned after the repair converges", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const staleHash = "a".repeat(64);
  const staleDir = path.join(managedRootOf(harness), "generations", staleHash);
  writeGeneration(staleDir, staleHash);
  let staleDuringAdd = false;
  const cli = makeCli(harness, {
    afterAdd: () => { staleDuringAdd = fs.existsSync(staleDir); },
  });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(staleDuringAdd, true);
  assert.strictEqual(fs.existsSync(staleDir), false);
});

test("a repair converge clears its own inspection latch before cleaning generations", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const staleHash = "e".repeat(64);
  const staleDir = path.join(managedRootOf(harness), "generations", staleHash);
  writeGeneration(staleDir, staleHash);
  const latchPath = path.join(managedRootOf(harness), "inspection-required.json");
  writeJson(latchPath, { owner: "clawd-on-desk", schemaVersion: 1, reason: "previous-remove-failed", detail: "" });

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(latchPath), false);
  assert.strictEqual(fs.existsSync(staleDir), false);
});

test("startup sync still only reports a disabled plugin", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "startup-sync" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "plugin-disabled-in-dsh");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

// ---------------------------------------------------------------------------
// Failures keep the record
// ---------------------------------------------------------------------------

test("a failed remove keeps the record and writes an inspection latch", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness, { failRemove: true });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-remove-failed");
  assert.strictEqual(readJson(recordPath(harness, "web")).state, "remove-pending");
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
  assert.strictEqual(dependencyPresent(harness, "web"), true);
});

test("a failed add keeps removed-add-pending and the generation, then a retry finishes", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  const failing = makeCli(harness, { failAdd: true });
  const first = await installDeepSeekHarnessBridge(orchOptions(harness, failing, { operation: "explicit-repair" }));
  assert.strictEqual(first.status, "error");
  assert.strictEqual(first.reason, "repair-add-failed");
  assert.strictEqual(readJson(recordPath(harness, "web")).state, "removed-add-pending");
  assert.strictEqual(dependencyPresent(harness, "web"), false);
  assert.strictEqual(fs.existsSync(generationDir), true);

  const retry = makeCli(harness);
  const second = await installDeepSeekHarnessBridge(orchOptions(harness, retry, { operation: "explicit-repair" }));
  assert.strictEqual(second.status, "ok");
  assert.deepStrictEqual(mutationOrder(retry), ["add"]);
  assert.strictEqual(bundlePresent(harness, "web"), true);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

test("a remove interrupted before the record update resumes from removed-add-pending", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const manifest = profileManifest(harness, "web");
  delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== BRIDGE_PACKAGE_NAME);
  writeJson(path.join(harness.dshHome, "profiles", "web", "package.json"), manifest);
  fs.rmSync(packageDir(harness.dshHome, "web"), { recursive: true, force: true });

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(mutationOrder(cli), ["add"]);
  assert.strictEqual(bundlePresent(harness, "web"), true);
  assert.strictEqual(fs.existsSync(generationDir), true);
});

test("a version change between remove and add stops the repair", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness);
  let versions = 0;
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "explicit-repair",
    dshVersion: undefined,
    runCommand: async () => {
      versions += 1;
      return { code: 0, stdout: versions <= 2 ? `${FAMILY_VERSION}\n` : "0.1.1-rc.2\n" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-changed");
  assert.strictEqual(readJson(recordPath(harness, "web")).state, "remove-pending");
  assert.strictEqual(fs.existsSync(generationDir), true);
  assert.strictEqual(dependencyPresent(harness, "web"), false);
});

test("an unwritable record stops before remove", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "explicit-repair",
    __testRepairOperationHooks: {
      beforeWrite() { throw new Error("simulated disk full"); },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-record-unwritable");
  assert.deepStrictEqual(mutationOrder(cli), []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
  assert.strictEqual(dependencyPresent(harness, "web"), true);
});

// ---------------------------------------------------------------------------
// Invalid records and foreign packages
// ---------------------------------------------------------------------------

test("an invalid repair record is reported without running any command", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  fs.writeFileSync(recordPath(harness, "web"), "{ not-json", "utf8");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-record-invalid");
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

test("an unreadable repair record is reported without running any command", {
  skip: process.platform === "win32",
}, async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const filePath = writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  fs.chmodSync(filePath, 0o000);
  t.after(() => { try { fs.chmodSync(filePath, 0o600); } catch {} });
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-record-unreadable");
  assert.deepStrictEqual(cli.calls, []);
});

test("a foreign package stops the repair and keeps the record", async (t) => {
  const harness = makeHarness(t);
  writeForeignProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
  assert.strictEqual(fs.existsSync(packageDir(harness.dshHome, "web")), true);
});

// ---------------------------------------------------------------------------
// Resume and re-prepare
// ---------------------------------------------------------------------------

function writeAlternateGeneration(harness) {
  const staging = path.join(managedRootOf(harness), "generations", ".alt-staging");
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(SOURCE_DIR, staging, { recursive: true });
  fs.appendFileSync(path.join(staging, "lib", "index.js"), "\n// alternate generation\n", "utf8");
  const hash = dshInstallTest.hashBridgeDirectorySync(fs, staging, { supportedDshRange: FAMILY_RANGE });
  const dir = path.join(managedRootOf(harness), "generations", hash);
  fs.renameSync(staging, dir);
  writeJson(path.join(dir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash: hash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: FAMILY_RANGE,
    installedDshVersion: FAMILY_VERSION,
    installedDshVersionAssumedAtStaging: false,
    sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  return { dir, hash };
}

// A generation written with an old-style exact contract, e.g. `=0.2.0-rc.2`,
// whose files and marker are otherwise intact.
function writeContractGeneration(harness, version) {
  const contract = dshInstallTest.dshContractForVersion(version);
  const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, contract);
  const dir = path.join(managedRootOf(harness), "generations", bundleHash);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SOURCE_DIR, dir, { recursive: true });
  writeJson(path.join(dir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: contract.supportedDshRange,
    installedDshVersion: version,
    installedDshVersionAssumedAtStaging: false,
    sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  return { dir, hash: bundleHash, contract };
}

test("a repair target whose contract is not the current family's is not used", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const historical = writeContractGeneration(harness, FAMILY_VERSION);
  assert.notStrictEqual(historical.contract.supportedDshRange, FAMILY_RANGE);
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetBundleHash: historical.hash,
    targetGenerationDir: historical.dir,
  }));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

test("a healthy profile that is not the recorded target is repaired to the record's target", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const setupCli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, setupCli, { operation: "explicit-repair" }));
  const alternate = writeAlternateGeneration(harness);
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetBundleHash: alternate.hash,
    targetGenerationDir: alternate.dir,
  }));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  assert.strictEqual(profileManifest(harness, "web").dependencies[BRIDGE_PACKAGE_NAME], `file:${alternate.dir}`);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

test("an already healthy profile that is the recorded target converges", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  // Finish the repair once so the profile is healthy.
  const setupCli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, setupCli, { operation: "explicit-repair" }));
  // A stale record still pointing at the (now healthy) target.
  writeRecord(harness, "web", recordFor(harness, "web", "removed-add-pending"));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, false);
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

test("a deleted record target that is not the linked generation is re-prepared and finished", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  const alternate = writeAlternateGeneration(harness);
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetBundleHash: alternate.hash,
    targetGenerationDir: alternate.dir,
  }));
  fs.rmSync(alternate.dir, { recursive: true, force: true });

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(bundlePresent(harness, "web"), true);
  assert.strictEqual(dependencyPresent(harness, "web"), true);
  assert.strictEqual(fs.existsSync(generationDir), true);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

test("a symlinked generation that disappeared stops for manual inspection", async (t) => {
  const harness = makeHarness(t);
  const bundleHash = targetBundleHash();
  const generationDir = path.join(managedRootOf(harness), "generations", bundleHash);
  writeGeneration(generationDir, bundleHash);
  const profileDir = path.join(harness.dshHome, "profiles", "web");
  writeJson(path.join(profileDir, "package.json"), {
    name: "dsh-profile-web",
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: `file:${generationDir}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  // DSH `link:` layout: the profile node_modules entry is a symlink.
  const local = packageDir(harness.dshHome, "web");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  symlinkDir(generationDir, local);
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  fs.rmSync(generationDir, { recursive: true, force: true });

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

test("Doctor shows a diagnose role when a record coexists with a foreign package", async (t) => {
  const harness = makeHarness(t);
  writeForeignProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const targets = dshInstallTest.inspectDshTargetsSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    desktopDiscovery: NO_DESKTOP,
  }, { operation: "doctor" });
  assert.strictEqual(targets.web.role, "diagnose");
  assert.strictEqual(targets.web.reason, "foreign-package");
});

test("startup sync reports a pending repair record without running commands", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "startup-sync" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-pending");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

// ---------------------------------------------------------------------------
// Uninstall with a record
// ---------------------------------------------------------------------------

test("uninstall clears the record once the registration is gone", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const setupCli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, setupCli, { operation: "explicit-repair" }));
  writeRecord(harness, "web", recordFor(harness, "web", "removed-add-pending"));

  const cli = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.registrationRemoved, true);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), false);
});

test("uninstall keeps the record when the registration cannot be removed", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const cli = makeCli(harness, { failRemove: true });
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

// ---------------------------------------------------------------------------
// Manual fallback for web
// ---------------------------------------------------------------------------

test("an incomplete web profile without a CLI gets remove and add manual commands", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "explicit-repair",
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "cli-unavailable");
  const lines = result.manualCommand.split("\n");
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /'plugin' '--profile' 'web' 'remove'/);
  assert.match(lines[1], /'plugin' '--profile' 'web' 'add'/);
  assert.ok(lines[0].includes(`@deepseek-ai/dsh@${FAMILY_VERSION}`));
  assert.ok(lines[1].includes(`@deepseek-ai/dsh@${FAMILY_VERSION}`));
  assert.ok(lines[0].includes("DSH_HOME="));
  assert.ok(lines[1].includes("DSH_HOME="));
});

// ---------------------------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------------------------

test("a pending repair record keeps its target generation alive", async (t) => {
  const harness = makeHarness(t);
  const bundleHash = targetBundleHash();
  const generationDir = path.join(managedRootOf(harness), "generations", bundleHash);
  writeGeneration(generationDir, bundleHash);
  // Only the record references this generation; no profile dependency does.
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  await dshInstallTest.cleanUnreferencedGenerations(null, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(fs.existsSync(generationDir), true);
});

test("an invalid repair record also keeps generations alive", async (t) => {
  const harness = makeHarness(t);
  const bundleHash = targetBundleHash();
  const generationDir = path.join(managedRootOf(harness), "generations", bundleHash);
  writeGeneration(generationDir, bundleHash);
  fs.writeFileSync(recordPath(harness, "web"), "{ broken", "utf8");
  await dshInstallTest.cleanUnreferencedGenerations(null, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(fs.existsSync(generationDir), true);
});

// ---------------------------------------------------------------------------
// The record target's marker must only be treated as stale when it is missing
// ---------------------------------------------------------------------------

for (const kind of ["corrupt-json", "foreign-owner", "unreadable"]) {
  test(`an existing ${kind} record-target marker stops the repair`, {
    skip: kind === "unreadable" && process.platform === "win32",
  }, async (t) => {
    const harness = makeHarness(t);
    writeIncompleteProfile(harness, "web");
    const alternate = writeAlternateGeneration(harness);
    const marker = path.join(alternate.dir, "clawd-manifest.json");
    if (kind === "corrupt-json") {
      fs.writeFileSync(marker, "{ broken marker", "utf8");
    } else if (kind === "foreign-owner") {
      const value = readJson(marker);
      value.owner = "other-app";
      writeJson(marker, value);
    } else {
      fs.chmodSync(marker, 0o000);
      t.after(() => { try { fs.chmodSync(marker, 0o600); } catch {} });
    }
    writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
      targetBundleHash: alternate.hash,
      targetGenerationDir: alternate.dir,
    }));

    const cli = makeCli(harness);
    const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "repair-needs-inspection");
    assert.deepStrictEqual(cli.calls, []);
    assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
    assert.strictEqual(fs.existsSync(alternate.dir), true);
  });
}

test("an invalid inspection record stops a two-step repair before any command", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending"));
  const latch = path.join(managedRootOf(harness), "inspection-required.json");
  writeJson(latch, { owner: "clawd-on-desk", schemaVersion: 1, reason: "previous-add-unknown" });
  const external = path.join(harness.root, "external-inspection-record");
  writeJson(external, { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });

  let replaced = false;
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "explicit-repair",
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        if (replaced) return;
        replaced = true;
        fs.unlinkSync(latch);
        fs.symlinkSync(external, latch);
      },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
  assert.deepStrictEqual(readJson(external), { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
});

test("an inspection record invalidated after add keeps the record during convergence", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const latch = path.join(managedRootOf(harness), "inspection-required.json");
  const cli = makeCli(harness, {
    afterAdd: () => {
      fs.mkdirSync(path.dirname(latch), { recursive: true });
      fs.symlinkSync(path.join(harness.root, "missing-inspection-record"), latch);
    },
  });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.deepStrictEqual(mutationOrder(cli), ["remove", "add"]);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
});

test("a record target path that cannot hold a marker stops the repair", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const bogus = path.join(harness.root, "record-target-file");
  fs.writeFileSync(bogus, "not a directory", "utf8");
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetGenerationDir: bogus,
  }));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});

test("a record target reached through a link stops the repair", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "web");
  const alternate = writeAlternateGeneration(harness);
  const link = path.join(managedRootOf(harness), "generations", "linked-target");
  symlinkDir(alternate.dir, link);
  writeRecord(harness, "web", recordFor(harness, "web", "remove-pending", {
    targetBundleHash: alternate.hash,
    targetGenerationDir: link,
  }));

  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-needs-inspection");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(fs.existsSync(recordPath(harness, "web")), true);
});
