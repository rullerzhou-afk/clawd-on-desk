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
  inspectDeepSeekHarnessDiskSync,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-keepalive-"));
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
  return dir;
}

function writeStrayGeneration(harness, hash = "a".repeat(64)) {
  return writeGeneration(path.join(managedRootOf(harness), "generations", hash), hash);
}

function writeProfile(harness, profile, { dependency = null, bundles = [] } = {}) {
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  writeJson(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: dependency ? { [BRIDGE_PACKAGE_NAME]: dependency } : {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", ...bundles] } },
  });
  return profileDir;
}

function writeLatch(harness, profile, content) {
  const fileName = profile === "desktop" ? "inspection-required-desktop.json" : "inspection-required.json";
  const filePath = path.join(managedRootOf(harness), fileName);
  if (typeof content === "string") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  } else {
    writeJson(filePath, content || { owner: "clawd-on-desk", schemaVersion: 1, reason: "test", detail: "" });
  }
  return filePath;
}

function latchPath(harness, profile) {
  const fileName = profile === "desktop" ? "inspection-required-desktop.json" : "inspection-required.json";
  return path.join(managedRootOf(harness), fileName);
}

function writeResidue(harness, profile) {
  const dir = path.join(harness.dshHome, "profiles", profile, "node_modules", "@dsh-external");
  const residue = path.join(dir, "dsh-clawd-bridge.clawd-removing-x");
  fs.mkdirSync(residue, { recursive: true });
  return residue;
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

function makeCli(harness, options = {}) {
  const calls = [];
  const runDshCommand = async (args) => {
    calls.push([...args]);
    const profile = args[args.indexOf("--profile") + 1];
    const action = args[3];
    const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
    const manifest = fs.existsSync(manifestPath)
      ? readJson(manifestPath)
      : { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
    if (action === "remove") {
      if (options.failRemove) return { code: 1, stderr: "remove denied" };
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      fs.rmSync(packageDir(harness.dshHome, profile), { recursive: true, force: true });
      return { code: 0 };
    }
    if (action === "add") {
      if (options.failAdd) return { code: 1, stderr: "add denied" };
      const generationDir = args[4];
      manifest.dependencies ||= {};
      manifest.dsh ||= { profile: { bundles: [] } };
      manifest.dsh.profile ||= { bundles: [] };
      manifest.dsh.profile.bundles ||= [];
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(generationDir, target, { recursive: true });
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
    commandInfo: null,
    dshCommand: false,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
    ...overrides,
  });
}

// Fresh successful install of the acting profile, which triggers the shared
// generation cleanup at the end.
function installWeb(harness, overrides = {}) {
  const cli = makeCli(harness);
  return installDeepSeekHarnessBridge(orchOptions(harness, cli, overrides));
}

function installDesktop(harness, overrides = {}) {
  const profileDir = path.join(harness.dshHome, "profiles", "desktop");
  if (!fs.existsSync(path.join(profileDir, "package.json"))) {
    writeProfile(harness, "desktop");
  }
  const cli = makeCli(harness);
  return installDeepSeekHarnessBridge(desktopOptions(harness, cli, overrides));
}

// ---------------------------------------------------------------------------
// Symmetric: acting on web while desktop has state, and vice versa
// ---------------------------------------------------------------------------

for (const [acting, other] of [["web", "desktop"], ["desktop", "web"]]) {
  const act = acting === "web" ? installWeb : installDesktop;

  test(`${acting} install succeeds and does not clean while ${other} has a removal residue`, async (t) => {
    const harness = makeHarness(t);
    const stray = writeStrayGeneration(harness);
    const residue = writeResidue(harness, other);
    const result = await act(harness);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(fs.existsSync(stray), true);
    assert.strictEqual(fs.existsSync(residue), true);
  });

  test(`${acting} install succeeds and does not clean while ${other} only has an inspection latch`, async (t) => {
    const harness = makeHarness(t);
    const stray = writeStrayGeneration(harness);
    const latch = writeLatch(harness, other);
    const result = await act(harness);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(fs.existsSync(stray), true);
    assert.strictEqual(fs.existsSync(latch), true);
  });

  test(`${acting} install succeeds and does not clean while ${other} has a corrupt inspection latch`, async (t) => {
    const harness = makeHarness(t);
    const stray = writeStrayGeneration(harness);
    const latch = writeLatch(harness, other, "{ not-json");
    const result = await act(harness);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(fs.existsSync(stray), true);
    assert.strictEqual(fs.existsSync(latch), true);
  });
}

// ---------------------------------------------------------------------------
// Pause conditions
// ---------------------------------------------------------------------------

test("an unreadable profiles directory pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const error = new Error("EACCES: permission denied");
  error.code = "EACCES";
  const result = await installWeb(harness, {
    __testKeepaliveHooks: { readdirProfilesError: error },
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
});

test("a symlinked profile directory pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const realDesktop = path.join(harness.root, "real-desktop");
  fs.mkdirSync(path.join(realDesktop, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(harness.dshHome, "profiles"), { recursive: true });
  symlinkDir(realDesktop, path.join(harness.dshHome, "profiles", "desktop"));
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
});

test("an unparseable profile manifest pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const profileDir = path.join(harness.dshHome, "profiles", "desktop");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), "{ broken", "utf8");
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
});

test("an invalid operation record on the other side pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  fs.mkdirSync(path.join(managedRootOf(harness)), { recursive: true });
  fs.writeFileSync(
    dshInstallTest.repairOperationPath({ managedRoot: harness.managedRoot, profile: "desktop" }),
    "{ broken",
    "utf8"
  );
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
});

// ---------------------------------------------------------------------------
// Reference / keep-alive across profiles
// ---------------------------------------------------------------------------

test("a desktop profile symlink keeps its generation referenced", async (t) => {
  const harness = makeHarness(t);
  const generation = writeStrayGeneration(harness);
  const realDesktop = path.join(harness.root, "real-desktop");
  const link = path.join(realDesktop, "node_modules", "@dsh-external", "dsh-clawd-bridge");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.mkdirSync(path.join(harness.dshHome, "profiles"), { recursive: true });
  symlinkDir(generation, link);
  symlinkDir(realDesktop, path.join(harness.dshHome, "profiles", "desktop"));
  const referenced = await dshInstallTest.isGenerationReferenced(generation, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(referenced, true);
});

test("the other side's valid operation record keeps its generation and cleans the rest", async (t) => {
  const harness = makeHarness(t);
  const protectedHash = "b".repeat(64);
  const protectedDir = writeStrayGeneration(harness, protectedHash);
  const stray = writeStrayGeneration(harness, "c".repeat(64));
  writeRecord(harness, "desktop", recordFor(harness, "desktop", "remove-pending", {
    targetBundleHash: protectedHash,
    targetGenerationDir: protectedDir,
  }));
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(protectedDir), true);
  assert.strictEqual(fs.existsSync(stray), false);
});

test("a dangling inspection latch symlink pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const latch = latchPath(harness, "desktop");
  fs.mkdirSync(path.dirname(latch), { recursive: true });
  fs.symlinkSync(path.join(harness.root, "missing-latch-target"), latch);

  const result = await installWeb(harness);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
});

test("an unreadable inspection latch pauses cleanup", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const latch = latchPath(harness, "desktop");
  const error = new Error("EACCES: permission denied");
  error.code = "EACCES";
  const realLstat = fs.promises.lstat;
  fs.promises.lstat = async (file, ...args) => {
    if (file === latch) throw error;
    return realLstat.call(fs.promises, file, ...args);
  };
  try {
    const result = await installWeb(harness);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(fs.existsSync(stray), true);
  } finally {
    fs.promises.lstat = realLstat;
  }
});

test("a broken web manual reference pauses desktop cleanup and is left untouched", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.writeFileSync(referencePath, "{ not-json", "utf8");
  const before = fs.readFileSync(referencePath);
  const cleanup = await dshInstallTest.cleanUnreferencedGenerations(null, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(cleanup.paused, true);
  assert.match(cleanup.reason, /manual-reference-invalid/);
  const result = await installDesktop(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), true);
  assert.deepStrictEqual(fs.readFileSync(referencePath), before);
});

// ---------------------------------------------------------------------------
// Discard on add failure
// ---------------------------------------------------------------------------

test("a failed add does not discard the created generation while the other side has a latch", async (t) => {
  const harness = makeHarness(t);
  writeLatch(harness, "desktop");
  const cli = makeCli(harness, { failAdd: true });
  const created = path.join(managedRootOf(harness), "generations", targetBundleHash());
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(fs.existsSync(created), true);
});

// ---------------------------------------------------------------------------
// Own latch ordering
// ---------------------------------------------------------------------------

test("a resolved inspection latch is cleared before the shared cleanup runs", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const latch = writeLatch(harness, "web");
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(latch), false);
  assert.strictEqual(fs.existsSync(stray), false);
});

// ---------------------------------------------------------------------------
// Uninstall warning when paused
// ---------------------------------------------------------------------------

test("a paused cleanup after uninstall is reported as a warning", async (t) => {
  const harness = makeHarness(t);
  await installWeb(harness);
  const stray = writeStrayGeneration(harness, "d".repeat(64));
  const error = new Error("EACCES: permission denied");
  error.code = "EACCES";
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), {
    __testKeepaliveHooks: { readdirProfilesError: error },
  }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.registrationRemoved, true);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
  assert.ok(result.warnings.some((line) => line.includes("profiles-unreadable")));
  assert.strictEqual(fs.existsSync(stray), true);
});

// ---------------------------------------------------------------------------
// No blocker: behavior is unchanged
// ---------------------------------------------------------------------------

test("cleanup still removes unreferenced generations when nothing is pending", async (t) => {
  const harness = makeHarness(t);
  const stray = writeStrayGeneration(harness);
  const result = await installWeb(harness);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(stray), false);
});

// ---------------------------------------------------------------------------
// Strict inspection-record clearing
// ---------------------------------------------------------------------------

test("clearInspectionLatch deletes a valid record and ignores a missing one", async (t) => {
  const harness = makeHarness(t);
  const options = { managedRoot: harness.managedRoot, profile: "web" };
  await dshInstallTest.clearInspectionLatch(options);
  const latch = writeLatch(harness, "web");
  await dshInstallTest.clearInspectionLatch(options);
  assert.strictEqual(fs.existsSync(latch), false);
});

test("clearInspectionLatch refuses a symlinked record and leaves the target intact", async (t) => {
  const harness = makeHarness(t);
  const latch = latchPath(harness, "web");
  const target = path.join(harness.root, "external-inspection-record");
  writeJson(target, { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
  fs.mkdirSync(path.dirname(latch), { recursive: true });
  fs.symlinkSync(target, latch);

  await assert.rejects(
    () => dshInstallTest.clearInspectionLatch({ managedRoot: harness.managedRoot, profile: "web" }),
    /ownership is invalid/
  );
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
  assert.deepStrictEqual(readJson(target), { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
});

test("clearInspectionLatch refuses a dangling record", async (t) => {
  const harness = makeHarness(t);
  const latch = latchPath(harness, "web");
  fs.mkdirSync(path.dirname(latch), { recursive: true });
  fs.symlinkSync(path.join(harness.root, "missing-inspection-record"), latch);

  await assert.rejects(
    () => dshInstallTest.clearInspectionLatch({ managedRoot: harness.managedRoot, profile: "web" }),
    /ownership is invalid/
  );
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
});

test("an inspection-record lstat error makes disk health inspection-required", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  const latch = latchPath(harness, "web");
  const fakeFs = Object.create(fs);
  fakeFs.lstatSync = (filePath, ...args) => {
    if (path.resolve(filePath) === path.resolve(latch)) {
      const error = new Error("EACCES: permission denied");
      error.code = "EACCES";
      throw error;
    }
    return fs.lstatSync(filePath, ...args);
  };

  const health = inspectDeepSeekHarnessDiskSync({
    fs: fakeFs,
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    profile: "web",
    dshInstallRoot: null,
    platform: process.platform,
  });
  assert.strictEqual(health.status, "inspection-required");
  assert.strictEqual(health.inspectionLatch.reason, "inspection-latch-unreadable");
});

test("a symlinked inspection record makes disk health inspection-required", async (t) => {
  const harness = makeHarness(t);
  writeProfile(harness, "web");
  const latch = latchPath(harness, "web");
  const target = path.join(harness.root, "external-inspection-record");
  writeJson(target, { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
  fs.mkdirSync(path.dirname(latch), { recursive: true });
  fs.symlinkSync(target, latch);

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    profile: "web",
    dshInstallRoot: null,
    platform: process.platform,
  });
  assert.strictEqual(health.status, "inspection-required");
  assert.strictEqual(health.inspectionLatch.invalid, true);
});
