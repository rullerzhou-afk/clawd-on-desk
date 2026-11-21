"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dsh = require("../hooks/dsh-install");
const { __test: dshTest } = dsh;
const { desktopFound, symlinkDir } = require("./dsh-desktop-fixtures");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const INSTALL_ID = "a".repeat(64);
const LEASE_ID = "b".repeat(32);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packageDir(profileDir) {
  return path.join(profileDir, "node_modules", ...dsh.BRIDGE_PACKAGE_NAME.split("/"));
}

function copySource(t, mutate) {
  if (!mutate) return SOURCE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-remote-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(SOURCE_DIR, root, { recursive: true });
  mutate(root);
  return root;
}

function makeFakeCli(harness) {
  const calls = [];
  const runDshCommand = async (args, options = {}) => {
    calls.push({
      args: [...args],
      commandInfo: options.commandInfo || null,
      dshHomeEnv: options.env ? options.env.DSH_HOME : null,
    });
    const action = args[3];
    const manifestPath = path.join(harness.desktopProfileDir, "package.json");
    const manifest = readJson(manifestPath);
    manifest.dependencies ||= {};
    manifest.dsh ||= { profile: { bundles: [] } };
    manifest.dsh.profile ||= { bundles: [] };
    manifest.dsh.profile.bundles ||= [];
    if (action === "add") {
      const generationDir = args[4];
      manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(dsh.BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(dsh.BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.desktopProfileDir);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      symlinkDir(generationDir, target);
      return { code: 0 };
    }
    if (action === "remove") {
      delete manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== dsh.BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
      return { code: 0 };
    }
    return { code: 1, stderr: `unexpected dsh args: ${args.join(" ")}` };
  };
  return { calls, runDshCommand };
}

function makeHarness(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-remote-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dshHome = path.join(root, ".dsh");
  const desktopProfileDir = path.join(dshHome, "profiles", "desktop");
  const webProfileDir = path.join(dshHome, "profiles", "web");
  const remoteRoot = path.join(root, "remote-integrations", "deepseek-harness");
  const managedRoot = path.join(root, ".clawd", "integrations", "deepseek-harness");
  for (const profileDir of [desktopProfileDir, webProfileDir]) {
    writeJson(path.join(profileDir, "package.json"), {
      name: `dsh-profile-${path.basename(profileDir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    });
  }
  const harness = {
    root,
    dshHome,
    desktopProfileDir,
    webProfileDir,
    remoteRoot,
    managedRoot,
    identityPath: path.join(root, "clawd-remote.json"),
    hostPrefixPath: path.join(root, "clawd-host-prefix"),
  };
  harness.cli = makeFakeCli(harness);
  harness.deployment = remoteDeployment(harness);
  harness.options = () => ({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    sourceDir: harness.sourceDir || SOURCE_DIR,
    remoteRoot: harness.remoteRoot,
    profile: "desktop",
    installId: INSTALL_ID,
    profileId: "remote-a",
    runtimeKey: "runtime-a",
    layoutVersion: 1,
    deployment: harness.deployment,
    clawdVersion: "1.5.0",
    dshVersion: dsh.SUPPORTED_DSH_VERSION,
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: harness.cli.runDshCommand,
    desktopDiscovery: { ...desktopFound(root), status: "found" },
    allowLocalMigration: false,
    silent: true,
  });
  return harness;
}

function remoteDeployment(harness, overrides = {}) {
  return {
    kind: "ssh-remote",
    descriptorVersion: 1,
    installId: INSTALL_ID,
    profileId: "remote-a",
    runtimeKey: "runtime-a",
    layoutVersion: 1,
    identityPath: harness.identityPath,
    hostPrefixPath: harness.hostPrefixPath,
    ...overrides,
  };
}

function installRoots(harness, dshHome = harness.dshHome) {
  const canonical = dshTest.resolveCanonicalDshHome({ dshHome, platform: process.platform });
  const normalize = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const namespace = crypto.createHash("sha256").update(normalize.replace(/\\/g, "/"), "utf8").digest("hex");
  const installRoot = path.join(harness.remoteRoot, INSTALL_ID);
  const homeRoot = path.join(installRoot, "homes", namespace);
  return { canonical, installRoot, homeRoot, generationsDir: path.join(homeRoot, "generations"), recordPath: path.join(installRoot, "deployment.json") };
}

function writeHistoricalLocalGeneration(harness, sourceDir = SOURCE_DIR) {
  const contract = dshTest.dshContractForVersion(dsh.SUPPORTED_DSH_VERSION);
  const bundleHash = dshTest.hashBridgeDirectorySync(fs, sourceDir, contract);
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.cpSync(sourceDir, generationDir, { recursive: true });
  writeJson(path.join(generationDir, "clawd-manifest.json"), {
    owner: dsh.MANAGED_OWNER,
    schemaVersion: 1,
    protocolVersion: dsh.BRIDGE_PROTOCOL_VERSION,
    packageName: dsh.BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.4.0",
    supportedDshRange: contract.supportedDshRange,
    installedDshVersion: dsh.SUPPORTED_DSH_VERSION,
    installedDshVersionAssumedAtStaging: false,
    verifiedDshArtifact: contract.verifiedDshArtifact,
    verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
    sourceAuditBaselineCommit: "test",
    installedAt: new Date().toISOString(),
  });
  return { bundleHash, generationDir };
}

function linkProfileTo(harness, profileDir, generationDir) {
  const manifestPath = path.join(profileDir, "package.json");
  const manifest = readJson(manifestPath);
  manifest.dependencies ||= {};
  manifest.dsh ||= { profile: { bundles: [] } };
  manifest.dsh.profile ||= { bundles: [] };
  manifest.dsh.profile.bundles ||= [];
  manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
  if (!manifest.dsh.profile.bundles.includes(dsh.BRIDGE_PACKAGE_NAME)) {
    manifest.dsh.profile.bundles.push(dsh.BRIDGE_PACKAGE_NAME);
  }
  writeJson(manifestPath, manifest);
  const target = packageDir(profileDir);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  symlinkDir(generationDir, target);
}

test("DSH remote: install creates an immutable generation and a desktop-only deployment record", async (t) => {
  const harness = makeHarness(t);
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.firstInstall, true);
  assert.strictEqual(result.restartRequired, false);
  const roots = installRoots(harness);
  assert.match(result.generationId, /^[a-f0-9]{64}$/);
  assert.strictEqual(result.generation, path.join(roots.generationsDir, result.generationId));
  assert.ok(fs.existsSync(path.join(result.generation, "lib", "index.js")));
  const manifest = readJson(path.join(result.generation, "clawd-manifest.json"));
  assert.strictEqual(manifest.bundleHash.length, 64);
  assert.strictEqual(manifest.generationId, result.generationId);
  assert.deepStrictEqual(manifest.deployment, harness.deployment);
  const record = readJson(roots.recordPath);
  assert.strictEqual(record.phase, "installed");
  assert.strictEqual(record.generationId, result.generationId);
  assert.strictEqual(record.installId, INSTALL_ID);
  assert.strictEqual(record.desktopProfileDir, harness.desktopProfileDir);
  const desktop = readJson(path.join(harness.desktopProfileDir, "package.json"));
  assert.ok(desktop.dependencies[dsh.BRIDGE_PACKAGE_NAME].includes(roots.installRoot));
  assert.ok(desktop.dsh.profile.bundles.includes(dsh.BRIDGE_PACKAGE_NAME));
  const web = readJson(path.join(harness.webProfileDir, "package.json"));
  assert.strictEqual(web.dependencies[dsh.BRIDGE_PACKAGE_NAME], undefined);
  assert.strictEqual(web.dsh.profile.bundles.includes(dsh.BRIDGE_PACKAGE_NAME), false);
  // Remote entries never write local notices.
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "notices-desktop.json")), false);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "notices-web.json")), false);
});

test("DSH remote: install reuses an identical deployment without rewriting the generation", async (t) => {
  const harness = makeHarness(t);
  const first = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const callsAfterFirst = harness.cli.calls.length;
  const second = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(second.status, "ok");
  assert.strictEqual(second.updated, false);
  assert.strictEqual(second.restartRequired, false);
  assert.strictEqual(second.generationId, first.generationId);
  assert.strictEqual(harness.cli.calls.length, callsAfterFirst, "a verified identical deployment must not run plugin add");
  const generations = fs.readdirSync(path.dirname(first.generation));
  assert.deepStrictEqual(generations.filter((name) => !name.startsWith(".")), [first.generationId]);
});

test("DSH remote: install creates a new generation when the bridge bytes change", async (t) => {
  const harness = makeHarness(t);
  const first = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  harness.sourceDir = copySource(t, (dir) => {
    fs.appendFileSync(path.join(dir, "lib", "index.js"), "\n// changed bytes\n", "utf8");
  });
  const second = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(second.status, "ok");
  assert.strictEqual(second.updated, true);
  assert.strictEqual(second.restartRequired, true);
  assert.notStrictEqual(second.generationId, first.generationId);
  const generations = fs.readdirSync(path.dirname(first.generation)).filter((name) => !name.startsWith("."));
  assert.deepStrictEqual(generations.sort(), [first.generationId, second.generationId].sort());
  const record = readJson(installRoots(harness).recordPath);
  assert.strictEqual(record.generationId, second.generationId);
});

test("DSH remote: install changes generation identity when only the deployment changes", async (t) => {
  const harness = makeHarness(t);
  const first = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const nextDeployment = remoteDeployment(harness, { runtimeKey: "runtime-b" });
  const second = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(second.generationId, first.generationId);
  const third = await dsh.installRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    runtimeKey: "runtime-b",
    deployment: nextDeployment,
  });
  assert.strictEqual(third.status, "ok");
  assert.notStrictEqual(third.generationId, first.generationId);
  const manifest = readJson(path.join(third.generation, "clawd-manifest.json"));
  assert.strictEqual(manifest.deployment.runtimeKey, "runtime-b");
  assert.strictEqual(manifest.bundleHash, readJson(path.join(first.generation, "clawd-manifest.json")).bundleHash);
});

test("DSH remote: generation reuse compares the full deployment descriptor", async (t) => {
  const harness = makeHarness(t);
  const contract = dshTest.dshContractForVersion(dsh.SUPPORTED_DSH_VERSION);
  const bundle = await dshTest.readSourceBundle({ sourceDir: SOURCE_DIR, contract });
  const deployment = dshTest.normalizeRemoteDeployment(harness.deployment, { platform: process.platform });
  const generationId = dshTest.remoteGenerationId(bundle.bundleHash, deployment, { platform: process.platform });
  const roots = installRoots(harness);
  const generationDir = path.join(roots.generationsDir, generationId);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.cpSync(SOURCE_DIR, generationDir, { recursive: true });
  writeJson(path.join(generationDir, "clawd-manifest.json"), {
    owner: dsh.MANAGED_OWNER,
    schemaVersion: 1,
    protocolVersion: dsh.BRIDGE_PROTOCOL_VERSION,
    packageName: dsh.BRIDGE_PACKAGE_NAME,
    bundleHash: bundle.bundleHash,
    generationId,
    // Same generation id, different deployment: this combination is corrupt
    // and must never be reused in place.
    deployment: { ...deployment, runtimeKey: "runtime-b" },
    sourceClawdVersion: "1.5.0",
    supportedDshRange: contract.supportedDshRange,
    installedDshVersion: dsh.SUPPORTED_DSH_VERSION,
    installedDshVersionAssumedAtStaging: false,
    verifiedDshArtifact: contract.verifiedDshArtifact,
    verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
    sourceAuditBaselineCommit: "test",
    installedAt: new Date().toISOString(),
  });
  await assert.rejects(
    dshTest.promoteRemoteGeneration(bundle, deployment, {
      ...harness.options(),
      contract,
      remoteRoot: harness.remoteRoot,
      installId: INSTALL_ID,
      canonicalDshHome: roots.canonical,
    }),
    /matching deployment marker/,
  );
});

test("DSH remote: install refuses a local Clawd link unless migration is explicitly allowed", async (t) => {
  const harness = makeHarness(t);
  const local = writeHistoricalLocalGeneration(harness);
  linkProfileTo(harness, harness.desktopProfileDir, local.generationDir);
  linkProfileTo(harness, harness.webProfileDir, local.generationDir);
  const refused = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(refused.status, "error");
  assert.strictEqual(refused.reason, "local-migration-required");
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
  const desktop = readJson(path.join(harness.desktopProfileDir, "package.json"));
  assert.ok(desktop.dependencies[dsh.BRIDGE_PACKAGE_NAME].includes(local.generationDir));

  const migrated = await dsh.installRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    allowLocalMigration: true,
  });
  assert.strictEqual(migrated.status, "ok");
  console.log("MIGRATED_RESULT", JSON.stringify({status:migrated.status, firstInstall:migrated.firstInstall, restartRequired:migrated.restartRequired, reason:migrated.reason}));
  assert.strictEqual(migrated.restartRequired, true, "a migration always needs a desktop restart");
  const migratedDesktop = readJson(path.join(harness.desktopProfileDir, "package.json"));
  assert.ok(migratedDesktop.dependencies[dsh.BRIDGE_PACKAGE_NAME].includes(INSTALL_ID));
  // Web keeps the old local generation and its directory is left untouched.
  const web = readJson(path.join(harness.webProfileDir, "package.json"));
  assert.ok(web.dependencies[dsh.BRIDGE_PACKAGE_NAME].includes(local.generationDir));
  assert.ok(fs.existsSync(local.generationDir));
});

test("DSH remote: install refuses a bridge owned by something else and writes nothing", async (t) => {
  const harness = makeHarness(t);
  const foreign = path.join(harness.root, "foreign-generation");
  fs.mkdirSync(foreign, { recursive: true });
  writeJson(path.join(foreign, "package.json"), { name: dsh.BRIDGE_PACKAGE_NAME, version: "9.9.9" });
  linkProfileTo(harness, harness.desktopProfileDir, foreign);
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "bridge-ownership-conflict");
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: install refuses to drift to a different DSH home", async (t) => {
  const harness = makeHarness(t);
  const roots = installRoots(harness);
  writeJson(roots.recordPath, {
    schemaVersion: 1,
    installId: INSTALL_ID,
    profileId: "remote-a",
    dshHome: path.join(harness.root, "another-home"),
    desktopProfileDir: path.join(harness.root, "another-home", "profiles", "desktop"),
    generationId: "c".repeat(64),
    phase: "installed",
  });
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "dsh-home-changed");
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: inspect reports the loaded winner and whether it is this deployment", async (t) => {
  const harness = makeHarness(t);
  const missing = await dsh.inspectRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    deployment: undefined,
  });
  assert.strictEqual(missing.status, "skipped");
  assert.strictEqual(missing.reason, "deployment-record-missing");

  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const inspect = await dsh.inspectRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    deployment: undefined,
  });
  assert.strictEqual(inspect.status, "ok");
  assert.strictEqual(inspect.phase, "installed");
  assert.strictEqual(inspect.generationId, installed.generationId);
  assert.strictEqual(inspect.desktop.kind, "ours");
  assert.strictEqual(inspect.desktop.withinDeployment, true);
  assert.strictEqual(inspect.desktop.hashMatches, true);
  assert.strictEqual(inspect.desktop.manifestDeploymentMatches, true);
  assert.strictEqual(inspect.desktop.generationId, installed.generationId);
  assert.strictEqual(fs.realpathSync.native(inspect.desktop.winnerRealpath), fs.realpathSync.native(installed.generation));
});

test("DSH remote: install repairs a declaration whose junction is missing", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
  const inspect = await dsh.inspectRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    deployment: undefined,
  });
  assert.strictEqual(inspect.desktop.kind, "ours-unlinked");
  assert.strictEqual(inspect.desktop.withinDeployment, false);
  assert.strictEqual(inspect.desktop.hashMatches, false);
  harness.cli.calls.length = 0;
  const repaired = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(repaired.status, "ok");
  assert.strictEqual(repaired.generationId, installed.generationId);
  assert.deepStrictEqual(harness.cli.calls.map((call) => call.args[3]), ["remove", "add"]);
  assert.ok(fs.existsSync(packageDir(harness.desktopProfileDir)));
});

test("DSH remote: install refuses a foreign package that wins over our declaration", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const foreign = path.join(harness.root, "foreign-winner");
  fs.mkdirSync(foreign, { recursive: true });
  writeJson(path.join(foreign, "package.json"), { name: dsh.BRIDGE_PACKAGE_NAME, version: "9.9.9" });
  fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
  symlinkDir(foreign, packageDir(harness.desktopProfileDir));
  harness.cli.calls.length = 0;
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "bridge-ownership-conflict");
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: install refuses a local winner when the declaration is ours", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const local = writeHistoricalLocalGeneration(harness);
  fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
  symlinkDir(local.generationDir, packageDir(harness.desktopProfileDir));
  harness.cli.calls.length = 0;
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "bridge-ownership-conflict");
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: a profiles-fallback package can be the loaded winner", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
  const fallbackTarget = path.join(harness.dshHome, "profiles", "node_modules", ...dsh.BRIDGE_PACKAGE_NAME.split("/"));
  fs.mkdirSync(path.dirname(fallbackTarget), { recursive: true });
  symlinkDir(installed.generation, fallbackTarget);
  const inspect = await dsh.inspectRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    deployment: undefined,
  });
  assert.strictEqual(inspect.desktop.kind, "ours");
  assert.strictEqual(inspect.desktop.hashMatches, true);
});

test("DSH remote: uninstall binding follows the deployment record home, not the environment", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const otherHome = path.join(harness.root, "home-a");
  const otherProfile = path.join(otherHome, "profiles", "desktop");
  const otherManaged = path.join(harness.root, "managed-a");
  const otherGeneration = writeHistoricalLocalGeneration({ managedRoot: otherManaged });
  writeJson(path.join(otherProfile, "package.json"), {
    name: "desktop", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  linkProfileTo({ desktopProfileDir: otherProfile, webProfileDir: otherProfile }, otherProfile, otherGeneration.generationDir);
  const otherManifestBefore = fs.readFileSync(path.join(otherProfile, "package.json"), "utf8");
  const otherLinkBefore = fs.realpathSync.native(packageDir(otherProfile));

  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    dshHome: otherHome,
  });
  assert.strictEqual(result.status, "ok", JSON.stringify(result));
  assert.strictEqual(fs.existsSync(installed.generation), false);
  const expectedHome = dshTest.resolveCanonicalDshHome({ dshHome: harness.dshHome, platform: process.platform });
  assert.ok(harness.cli.calls.length > 0);
  for (const call of harness.cli.calls) assert.strictEqual(call.dshHomeEnv, expectedHome);
  assert.strictEqual(fs.readFileSync(path.join(otherProfile, "package.json"), "utf8"), otherManifestBefore);
  assert.strictEqual(fs.realpathSync.native(packageDir(otherProfile)), otherLinkBefore);
  assert.ok(fs.existsSync(otherGeneration.generationDir));
});

test("DSH remote: uninstall keeps a generation when the web reference is unreadable", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  linkProfileTo(harness, harness.webProfileDir, installed.generation);
  fs.writeFileSync(path.join(harness.webProfileDir, "package.json"), "{", "utf8");
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "uninstall-unconfirmed");
  assert.ok(result.conflicts.some((item) => item.kind === "reference-unknown"));
  assert.ok(fs.existsSync(installed.generation));
  assert.ok(fs.existsSync(installRoots(harness).recordPath), "the record is kept for a later retry");
});

function removeEntriesButKeepJunction(harness, onBeforeUnlink = null) {
  return async (args, options = {}) => {
    if (args[3] === "remove") {
      const manifestPath = path.join(harness.desktopProfileDir, "package.json");
      const manifest = readJson(manifestPath);
      delete manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== dsh.BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      if (onBeforeUnlink) onBeforeUnlink();
      return { code: 0 };
    }
    return harness.cli.runDshCommand(args, options);
  };
}

test("DSH remote: uninstall removes the junction dsh plugin remove leaves behind", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const link = packageDir(harness.desktopProfileDir);
  let targetIntactDuringCleanup = false;
  const options = {
    ...harness.options(),
    runDshCommand: removeEntriesButKeepJunction(harness),
    __testManagedProfileResidueHooks: {
      beforeIsolateMove: ({ linkDir, expectedGeneration }) => {
        assert.strictEqual(fs.realpathSync.native(linkDir), fs.realpathSync.native(expectedGeneration));
        assert.ok(fs.existsSync(path.join(expectedGeneration, "lib", "index.js")));
        targetIntactDuringCleanup = true;
      },
    },
  };
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(options);
  assert.strictEqual(result.status, "ok", JSON.stringify(result));
  assert.strictEqual(targetIntactDuringCleanup, true);
  assert.strictEqual(fs.existsSync(link), false, "only the link is removed");
  assert.strictEqual(fs.existsSync(installed.generation), false, "GC runs after the link cleanup");
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
});

test("DSH remote: uninstall leaves a foreign or local leftover junction untouched", async (t) => {
  for (const kind of ["foreign", "local"]) {
    const harness = makeHarness(t);
    const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
    const manifestPath = path.join(harness.desktopProfileDir, "package.json");
    const manifest = readJson(manifestPath);
    delete manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== dsh.BRIDGE_PACKAGE_NAME);
    writeJson(manifestPath, manifest);
    let target;
    if (kind === "foreign") {
      target = path.join(harness.root, "foreign-junction-target");
      fs.mkdirSync(target, { recursive: true });
      writeJson(path.join(target, "package.json"), { name: dsh.BRIDGE_PACKAGE_NAME });
    } else {
      target = writeHistoricalLocalGeneration(harness).generationDir;
    }
    const link = packageDir(harness.desktopProfileDir);
    fs.rmSync(link, { recursive: true, force: true });
    symlinkDir(target, link);
    const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
    assert.notStrictEqual(result.status, "ok", kind);
    assert.ok(fs.existsSync(link), kind);
    assert.strictEqual(fs.realpathSync.native(link), fs.realpathSync.native(target), kind);
    assert.ok(fs.existsSync(installed.generation), kind);
  }
});

test("DSH remote: uninstall succeeds when only the junction remains", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const manifestPath = path.join(harness.desktopProfileDir, "package.json");
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== dsh.BRIDGE_PACKAGE_NAME);
  writeJson(manifestPath, manifest);
  const link = packageDir(harness.desktopProfileDir);
  assert.ok(fs.existsSync(link));
  harness.cli.calls.length = 0;
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "ok", JSON.stringify(result));
  assert.strictEqual(harness.cli.calls.filter((call) => call.args[3] === "remove").length, 0, "no plugin remove is needed");
  assert.strictEqual(fs.existsSync(link), false);
  assert.strictEqual(fs.existsSync(installed.generation), false);
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
});

test("DSH remote: uninstall does not treat an unreadable desktop manifest as missing", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const manifestPath = path.join(harness.desktopProfileDir, "package.json");
  fs.rmSync(manifestPath, { force: true });
  fs.mkdirSync(manifestPath);
  harness.cli.calls.length = 0;
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "uninstall-unconfirmed");
  assert.strictEqual(result.healthReason, "profile-unreadable");
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: install and uninstall use the verified desktop carrier", async (t) => {
  const harness = makeHarness(t);
  const options = harness.options();
  delete options.commandInfo;
  const discovery = desktopFound(harness.root);
  options.desktopDiscovery = discovery;
  // On Windows the installer runs the Electron binary that dsh.cmd names;
  // elsewhere it runs the launcher itself.
  const carrier = process.platform === "win32"
    ? path.join(discovery.appRoot, "DeepSeek Harness.exe")
    : discovery.launcherPath;
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(options);
  assert.strictEqual(installed.status, "ok");
  assert.ok(harness.cli.calls.length > 0);
  for (const call of harness.cli.calls) {
    assert.ok(call.commandInfo, "installer must receive the detected carrier");
    assert.strictEqual(call.commandInfo.command, carrier);
  }
  harness.cli.calls.length = 0;
  const uninstallOptions = { ...options, desktopDiscovery: discovery };
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(uninstallOptions);
  assert.strictEqual(result.status, "ok");
  assert.ok(harness.cli.calls.length > 0);
  assert.strictEqual(harness.cli.calls.at(-1).commandInfo.command, carrier);
});

test("DSH remote: inspect compares against the caller's expected deployment", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const expected = remoteDeployment(harness, { runtimeKey: "runtime-b" });
  const inspect = await dsh.inspectRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    deployment: expected,
  });
  assert.strictEqual(inspect.status, "ok");
  assert.strictEqual(inspect.desktop.manifestDeploymentMatches, false);
});

test("DSH remote: installer rejects a stale deployment lease after acquiring the lock", async (t) => {
  const harness = makeHarness(t);
  const leaseFile = path.join(harness.root, "deployment-lease.json");
  writeJson(leaseFile, { leaseId: LEASE_ID });
  const options = { ...harness.options(), leaseFile, leaseOwner: "c".repeat(32) };
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(options);
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "lease-lost");
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);

  const changed = { ...harness.options(), leaseFile, leaseOwner: LEASE_ID };
  changed.__testMutationLockHooks = {
    beforeOwnerWrite: async () => { writeJson(leaseFile, { leaseId: "d".repeat(32) }); },
  };
  const raced = await dsh.installRemoteDeepSeekHarnessDeployment(changed);
  assert.strictEqual(raced.status, "error");
  assert.strictEqual(raced.reason, "lease-lost");
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
});

test("DSH remote: uninstall revalidates the deployment lease under the lock", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const leaseFile = path.join(harness.root, "deployment-lease.json");
  writeJson(leaseFile, { leaseId: LEASE_ID });
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment({
    ...harness.options(),
    leaseFile,
    leaseOwner: "c".repeat(32),
  });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "lease-lost");
  assert.ok(fs.existsSync(installed.generation));
  assert.strictEqual(readJson(installRoots(harness).recordPath).phase, "installed");
});

test("DSH remote: installer takes the shared local mutation lock", async (t) => {
  const harness = makeHarness(t);
  const lockDir = path.join(harness.managedRoot, "mutation.lock");
  writeJson(path.join(lockDir, "owner.json"), {
    owner: dsh.MANAGED_OWNER,
    schemaVersion: 2,
    token: "e".repeat(32),
    pid: process.pid,
    operationTimeoutMs: 120000,
    createdAt: new Date().toISOString(),
  });
  const result = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "error");
  assert.ok(result.message.includes(lockDir), result.message);
  assert.strictEqual(fs.existsSync(installRoots(harness).recordPath), false);
  assert.strictEqual(harness.cli.calls.length, 0);

  fs.rmSync(lockDir, { recursive: true, force: true });
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(installed.status, "ok");
  writeJson(path.join(lockDir, "owner.json"), {
    owner: dsh.MANAGED_OWNER,
    schemaVersion: 2,
    token: "f".repeat(32),
    pid: process.pid,
    operationTimeoutMs: 120000,
    createdAt: new Date().toISOString(),
  });
  harness.cli.calls.length = 0;
  const uninstall = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(uninstall.status, "error");
  assert.ok(uninstall.message.includes(lockDir), uninstall.message);
  assert.strictEqual(harness.cli.calls.length, 0);
  assert.strictEqual(readJson(installRoots(harness).recordPath).phase, "installed");
});

test("DSH remote: clear-latch is the explicit way out of a remote inspection latch", async (t) => {
  const harness = makeHarness(t);
  const roots = installRoots(harness);
  const latchPath = path.join(roots.installRoot, "inspection-required-desktop.json");
  writeJson(latchPath, { owner: dsh.MANAGED_OWNER, schemaVersion: 1, reason: "manual" });
  const blocked = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(blocked.reason, "inspection-required");
  const cleared = await dsh.clearRemoteInspectionLatchForDeployment(harness.options());
  assert.strictEqual(cleared.status, "ok");
  assert.strictEqual(fs.existsSync(latchPath), false);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(installed.status, "ok");
});

test("DSH remote: uninstall removes only this deployment and leaves the web profile alone", async (t) => {
  const harness = makeHarness(t);
  const local = writeHistoricalLocalGeneration(harness);
  linkProfileTo(harness, harness.webProfileDir, local.generationDir);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const roots = installRoots(harness);
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.registrationRemoved, true);
  const desktop = readJson(path.join(harness.desktopProfileDir, "package.json"));
  assert.strictEqual(desktop.dependencies[dsh.BRIDGE_PACKAGE_NAME], undefined);
  assert.strictEqual(desktop.dsh.profile.bundles.includes(dsh.BRIDGE_PACKAGE_NAME), false);
  assert.ok(!fs.existsSync(installed.generation));
  assert.strictEqual(fs.existsSync(roots.recordPath), false);
  assert.strictEqual(fs.existsSync(roots.installRoot), false);
  const web = readJson(path.join(harness.webProfileDir, "package.json"));
  assert.ok(web.dependencies[dsh.BRIDGE_PACKAGE_NAME].includes(local.generationDir));
  assert.ok(fs.existsSync(local.generationDir));
  assert.ok(fs.existsSync(harness.managedRoot), "the local managed root must not be touched");
});

test("DSH remote: uninstall keeps a generation still referenced by the web profile", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  linkProfileTo(harness, harness.webProfileDir, installed.generation);
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "ok");
  assert.ok(fs.existsSync(installed.generation), "a generation referenced by web must be retained");
  assert.deepStrictEqual(result.remaining.generations, [installed.generationId]);
});

test("DSH remote: install refuses a bundle-only profile it cannot prove belongs to this deployment", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  // DSH can leave the bundle line behind after disabling the plugin. With the
  // dependency gone there is no resolvable link, so this deployment cannot
  // prove ownership from disk and must not write.
  const manifestPath = path.join(harness.desktopProfileDir, "package.json");
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[dsh.BRIDGE_PACKAGE_NAME];
  writeJson(manifestPath, manifest);
  fs.rmSync(packageDir(harness.desktopProfileDir), { recursive: true, force: true });
  harness.cli.calls.length = 0;
  const refused = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(refused.status, "error");
  assert.strictEqual(refused.reason, "bridge-ownership-conflict");
  assert.strictEqual(harness.cli.calls.length, 0);
});

test("DSH remote: install latches an unknown plugin add under the remote root", async (t) => {
  const harness = makeHarness(t);
  const options = harness.options();
  let firstAdd = true;
  options.runDshCommand = async (args) => {
    if (firstAdd && args[3] === "add") {
      firstAdd = false;
      return { code: 1, timedOut: true, stderr: "plugin add timed out" };
    }
    return harness.cli.runDshCommand(args);
  };
  const failed = await dsh.installRemoteDeepSeekHarnessDeployment(options);
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(failed.reason, "plugin-add-failed");
  const roots = installRoots(harness);
  assert.ok(fs.existsSync(path.join(roots.installRoot, "inspection-required-desktop.json")));
  assert.strictEqual(readJson(roots.recordPath).phase, "installing");
  const retried = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(retried.status, "error");
  assert.strictEqual(retried.reason, "inspection-required");
});

test("DSH remote: CLI validates every argument before any write", () => {
  const base = [
    "--remote", "--profile", "desktop", "--clawd-version", "1.5.0",
    "--remote-root", "/tmp/remote", "--install-id", INSTALL_ID,
    "--profile-id", "remote-a", "--runtime-key", "runtime-a", "--layout-version", "1",
    "--identity-path", "/tmp/remote/identity.json", "--host-prefix-path", "/tmp/remote/host-prefix",
  ];
  const parsed = dshTest.parseRemoteCliArgs(base);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.mode, "install");
  assert.strictEqual(parsed.layoutVersion, "1");
  assert.strictEqual(dshTest.parseRemoteCliArgs([...base, "--unknown"]).errors.length > 0, true);
  for (const missing of ["--clawd-version", "--remote-root", "--install-id", "--identity-path"]) {
    const index = base.indexOf(missing);
    const argv = base.filter((_value, position) => position !== index && position !== index + 1);
    assert.ok(dshTest.parseRemoteCliArgs(argv).errors.length > 0, missing);
  }
  assert.ok(dshTest.parseRemoteCliArgs(base.map((value) => value === "desktop" ? "web" : value)).errors.length > 0);
  assert.ok(dshTest.parseRemoteCliArgs(base.map((value) => value === INSTALL_ID ? "not-hex" : value)).errors.length > 0);
  assert.ok(dshTest.parseRemoteCliArgs([...base, "--identity-path", "relative.json"]).errors.length > 0);
  assert.strictEqual(dshTest.isRemoteCliInvocation(["--repair"]), false);
  assert.strictEqual(dshTest.isRemoteCliInvocation(["--remote-inspect"]), true);
  assert.strictEqual(dshTest.isRemoteCliInvocation(["--remote-clear-latch"]), true);
  const clearLatch = dshTest.parseRemoteCliArgs([
    "--remote-clear-latch", "--remote-root", "/tmp/remote", "--install-id", INSTALL_ID,
  ]);
  assert.deepStrictEqual(clearLatch.errors, []);
  assert.strictEqual(clearLatch.mode, "clear-latch");
  const inspectWithExpected = dshTest.parseRemoteCliArgs([
    "--remote-inspect", "--remote-root", "/tmp/remote", "--install-id", INSTALL_ID,
    "--profile-id", "remote-a", "--runtime-key", "runtime-b", "--layout-version", "1",
    "--identity-path", "/tmp/remote/identity.json", "--host-prefix-path", "/tmp/remote/host-prefix",
  ]);
  assert.deepStrictEqual(inspectWithExpected.errors, []);
  const expected = dshTest.remoteCliOptions(inspectWithExpected);
  assert.strictEqual(expected.deployment.runtimeKey, "runtime-b");
  const inspectWithoutExpected = dshTest.parseRemoteCliArgs([
    "--remote-inspect", "--remote-root", "/tmp/remote", "--install-id", INSTALL_ID,
  ]);
  assert.deepStrictEqual(inspectWithoutExpected.errors, []);
  assert.strictEqual(dshTest.remoteCliOptions(inspectWithoutExpected).deployment, null);
});

test("DSH remote: CLI result envelope is written as one sentinel line and an optional result file", async (t) => {
  const harness = makeHarness(t);
  await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  const resultFile = path.join(harness.root, "cli-result.json");
  const child = spawnSync(process.execPath, [
    path.join(__dirname, "..", "hooks", "dsh-install.js"),
    "--remote-inspect", "--profile", "desktop",
    "--remote-root", harness.remoteRoot, "--install-id", INSTALL_ID,
    "--result-file", resultFile,
  ], { encoding: "utf8", env: { ...process.env, DSH_HOME: harness.dshHome } });
  assert.strictEqual(child.status, 0, child.stderr);
  const lines = String(child.stdout || "").split(/\r?\n/).filter((line) => line.startsWith(dsh.DSH_RESULT_SENTINEL));
  assert.strictEqual(lines.length, 1);
  const envelope = JSON.parse(lines[0].slice(dsh.DSH_RESULT_SENTINEL.length));
  assert.strictEqual(envelope.operation, "remote-inspect");
  assert.strictEqual(envelope.status, "ok");
  assert.deepStrictEqual(readJson(resultFile), envelope);
});

test("DSH remote: production residue check refuses a generation under another installId", async (t) => {
  const harness = makeHarness(t);
  const canonicalHome = dshTest.resolveCanonicalDshHome({ dshHome: harness.dshHome, platform: process.platform });
  const roots = dshTest.remoteInstallRoots({
    remoteRoot: harness.remoteRoot,
    installId: INSTALL_ID,
    canonicalDshHome: canonicalHome,
    platform: process.platform,
  });
  const otherInstallId = "f".repeat(64);
  const otherRoots = dshTest.remoteInstallRoots({
    remoteRoot: harness.remoteRoot,
    installId: otherInstallId,
    canonicalDshHome: canonicalHome,
    platform: process.platform,
  });
  const otherDeployment = remoteDeployment(harness, { installId: otherInstallId });
  const contract = dshTest.dshContractForVersion(dsh.SUPPORTED_DSH_VERSION);
  const bundle = await dshTest.readSourceBundle({ sourceDir: SOURCE_DIR, contract });
  const generationId = dshTest.remoteGenerationId(bundle.bundleHash, otherDeployment, { platform: process.platform });
  const generationDir = path.join(otherRoots.generationsDir, generationId);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.cpSync(SOURCE_DIR, generationDir, { recursive: true });
  writeJson(path.join(generationDir, "clawd-manifest.json"), {
    owner: dsh.MANAGED_OWNER,
    schemaVersion: 1,
    protocolVersion: dsh.BRIDGE_PROTOCOL_VERSION,
    packageName: dsh.BRIDGE_PACKAGE_NAME,
    bundleHash: bundle.bundleHash,
    generationId,
    deployment: dshTest.normalizeRemoteDeployment(otherDeployment, { platform: process.platform }),
    sourceClawdVersion: "1.5.0",
    supportedDshRange: contract.supportedDshRange,
    installedDshVersion: dsh.SUPPORTED_DSH_VERSION,
    installedDshVersionAssumedAtStaging: false,
    verifiedDshArtifact: contract.verifiedDshArtifact,
    verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
    sourceAuditBaselineCommit: "test",
    installedAt: new Date().toISOString(),
  });
  linkProfileTo(harness, harness.desktopProfileDir, generationDir);
  const marker = readJson(path.join(generationDir, "clawd-manifest.json"));
  const health = {
    status: "managed-residue",
    dependencyPresent: false,
    bundlePresent: false,
    installationResolved: null,
    profileResolved: {
      packageDir: fs.realpathSync.native(generationDir),
      packageManifest: readJson(path.join(generationDir, "package.json")),
      clawdManifest: marker,
      actualBundleHash: dshTest.hashBridgeDirectorySync(fs, generationDir, contract),
    },
    marker,
    profileDir: harness.desktopProfileDir,
  };
  const link = packageDir(harness.desktopProfileDir);
  const result = await dshTest.unlinkManagedProfileResidue(health, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    platform: process.platform,
    residueExpectedGeneration: generationDir,
    residueGenerationCheck: dshTest.remoteResidueGenerationCheck(roots, INSTALL_ID, {
      platform: process.platform,
    }),
  });
  assert.strictEqual(result.removed, false);
  assert.strictEqual(result.reason, "residue-target-mismatch");
  assert.ok(fs.existsSync(link));
  assert.ok(fs.existsSync(generationDir));
});

test("DSH remote: uninstall removes empty shared directories and preserves their parent", async (t) => {
  const harness = makeHarness(t);
  const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(installed.status, "ok", JSON.stringify(installed));
  const rmdir = t.mock.method(fs.promises, "rmdir");
  const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
  assert.strictEqual(result.status, "ok", JSON.stringify(result));
  assert.strictEqual(fs.existsSync(installRoots(harness).installRoot), false);
  assert.strictEqual(fs.existsSync(harness.remoteRoot), false);
  assert.strictEqual(fs.existsSync(path.dirname(harness.remoteRoot)), false);
  assert.strictEqual(fs.existsSync(harness.root), true);
  assert.strictEqual(rmdir.mock.calls.some((call) => call.arguments[0] === harness.root), false);
});

for (const location of ["deployment", "integration"]) {
  test(`DSH remote: uninstall preserves another ${location} in the shared directories`, async (t) => {
    const harness = makeHarness(t);
    const installed = await dsh.installRemoteDeepSeekHarnessDeployment(harness.options());
    assert.strictEqual(installed.status, "ok", JSON.stringify(installed));
    const sibling = location === "deployment"
      ? path.join(harness.remoteRoot, "c".repeat(64), "deployment.json")
      : path.join(path.dirname(harness.remoteRoot), "other-agent", "settings.json");
    writeJson(sibling, { keep: true });
    const before = fs.readFileSync(sibling);
    const result = await dsh.uninstallOwnedRemoteDeepSeekHarnessDeployment(harness.options());
    assert.strictEqual(result.status, "ok", JSON.stringify(result));
    assert.strictEqual(fs.existsSync(installRoots(harness).installRoot), false);
    assert.deepStrictEqual(fs.readFileSync(sibling), before);
    assert.strictEqual(fs.existsSync(harness.remoteRoot), location === "deployment");
    assert.strictEqual(fs.existsSync(path.dirname(harness.remoteRoot)), true);
  });
}
