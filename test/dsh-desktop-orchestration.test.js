"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PACKAGE_NAME,
  DSH_RESTART_HINT,
  DSH_VERSION_FAMILIES,
  SUPPORTED_DSH_VERSION,
  installDeepSeekHarnessBridge,
  registerDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
  unregisterDeepSeekHarness,
  readDeepSeekHarnessNotices,
} = require("../hooks/dsh-install");
const { __test: dshInstallTest } = require("../hooks/dsh-install");
const { buildCleanupOptionsForHome } = require("../hooks/cleanup-integrations");
const { desktopFound: platformDesktopFound, symlinkDir } = require("./dsh-desktop-fixtures");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");
const FAMILY = DSH_VERSION_FAMILIES[0];
const FAMILY_VERSION = FAMILY.minVersion;

const NO_DESKTOP = Object.freeze({
  status: "not-found",
  appRoot: null,
  launcherPath: null,
  staticVersion: null,
  checkedPaths: [],
  reason: null,
});

// A desktop-only scenario must also suppress web's carrier, otherwise the
// operation-mode re-resolution finds the injected command and web applies.
const NO_WEB_COMMAND = Object.freeze({ commandInfo: null, dshCommand: false });

function desktopFound(harness, staticVersion = null) {
  return platformDesktopFound(harness.root, staticVersion);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-orch-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harness = {
    root,
    dshHome: path.join(root, ".dsh"),
    managedRoot: path.join(root, "managed"),
  };
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "dsh"), "#!/bin/sh\n");
  harness.binDir = binDir;
  return harness;
}

function writeProfileManifest(harness, profile, { bundles = [], name = `dsh-profile-${profile}` } = {}) {
  const profileDir = path.join(harness.dshHome, "profiles", profile);
  writeJson(path.join(profileDir, "package.json"), {
    name,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", ...bundles] } },
  });
  return profileDir;
}

// A manifest with our dependency present but no bundle entry: the state DSH
// leaves behind when a plugin is disabled.
function writeIncompleteProfile(harness, profile) {
  const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, {
    supportedDshRange: FAMILY.range,
  });
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.cpSync(SOURCE_DIR, generationDir, { recursive: true });
  writeJson(path.join(generationDir, "clawd-manifest.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: BRIDGE_PACKAGE_NAME,
    bundleHash,
    sourceClawdVersion: "1.2.3",
    supportedDshRange: FAMILY.range,
    installedDshVersion: FAMILY_VERSION,
  });
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

// A fake dsh CLI that mutates whichever profile --profile names.
function makeCli(harness) {
  const calls = [];
  const runDshCommand = async (args) => {
    calls.push([...args]);
    const profile = args[args.indexOf("--profile") + 1];
    const action = args[3];
    const profileDir = path.join(harness.dshHome, "profiles", profile);
    if (action === "add") {
      const generationDir = args[4];
      const manifest = fs.existsSync(path.join(profileDir, "package.json"))
        ? readJson(path.join(profileDir, "package.json"))
        : { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
      manifest.dependencies ||= {};
      manifest.dsh ||= { profile: { bundles: [] } };
      manifest.dsh.profile ||= { bundles: [] };
      manifest.dsh.profile.bundles ||= [];
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(path.join(profileDir, "package.json"), manifest);
      const target = packageDir(harness.dshHome, profile);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(generationDir, target, { recursive: true });
      return { code: 0 };
    }
    if (action === "remove") {
      const manifest = readJson(path.join(profileDir, "package.json"));
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
        .filter((name) => name !== BRIDGE_PACKAGE_NAME);
      writeJson(path.join(profileDir, "package.json"), manifest);
      fs.rmSync(packageDir(harness.dshHome, profile), { recursive: true, force: true });
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

function profileManifest(harness, profile) {
  return readJson(path.join(harness.dshHome, "profiles", profile, "package.json"));
}

function dependencyPath(harness, profile) {
  const manifestPath = path.join(harness.dshHome, "profiles", profile, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  return readJson(manifestPath).dependencies[BRIDGE_PACKAGE_NAME] || null;
}

// ---------------------------------------------------------------------------
// Matrix rows
// ---------------------------------------------------------------------------

test("only web applies when desktop is absent", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.message, DSH_RESTART_HINT);
  assert.deepStrictEqual(cli.calls, [["plugin", "--profile", "web", "add", dependencyPathTarget(harness)]]);
  assert.strictEqual(result.targets.desktop.role, "not-applicable");
});

function dependencyPathTarget(harness) {
  // The CLI's add target appears in the recorded call; read it back from the
  // manifest the fake CLI wrote.
  const spec = dependencyPath(harness, "web");
  return spec ? spec.replace(/^file:/, "") : spec;
}

test("only desktop is installed and uninstalled without a web manual command", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    ...NO_WEB_COMMAND,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(installed.status, "ok");
  assert.strictEqual(installed.manualCommand, undefined);
  assert.ok(cli.calls.every((args) => args[2] === "desktop"));
  assert.strictEqual(dependencyPath(harness, "web"), null);

  const removed = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, {
    ...NO_WEB_COMMAND,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(removed.status, "ok");
  assert.strictEqual(removed.registrationRemoved, true);
  assert.strictEqual(dependencyPath(harness, "desktop"), null);
});

test("a web command initializes a missing web profile on install", async (t) => {
  const harness = makeHarness(t);
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.ok(cli.calls.some((args) => args[2] === "web"));
  assert.ok(dependencyPath(harness, "web"));
});

test("startup sync reports an uninitialized web profile instead of creating it", async (t) => {
  const harness = makeHarness(t);
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "startup-sync" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-required");
  assert.deepStrictEqual(cli.calls, []);
});

test("a found but uninitialized desktop is skipped with an open-once hint", async (t) => {
  const harness = makeHarness(t);
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    ...NO_WEB_COMMAND,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "no-applicable-target");
  assert.match(result.message, /open the DeepSeek Harness desktop app once/);
  assert.deepStrictEqual(cli.calls, []);
});

test("one success and one failure reports ok with a desktop warning", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    desktopDiscovery: desktopFound(harness, "0.9.0"),
  }));
  assert.strictEqual(result.status, "ok");
  assert.ok(result.warnings.some((line) => line.startsWith("desktop:")));
});

test("two healthy targets report ok without an update", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { desktopDiscovery: desktopFound(harness) }));
  const callsAfterFirst = cli.calls.length;
  const second = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { desktopDiscovery: desktopFound(harness) }));
  assert.strictEqual(second.status, "ok");
  assert.strictEqual(second.updated, false);
  assert.strictEqual(cli.calls.length, callsAfterFirst);
});

test("a failure plus a not-applicable target is an error, and all not-applicable is skipped", async (t) => {
  const failureHarness = makeHarness(t);
  writeProfileManifest(failureHarness, "web");
  const cli = makeCli(failureHarness);
  const failure = await installDeepSeekHarnessBridge(orchOptions(failureHarness, cli, {
    desktopDiscovery: desktopFound(failureHarness, "0.9.0"),
  }));
  assert.strictEqual(failure.status, "ok"); // web succeeded

  const emptyHarness = makeHarness(t);
  const emptyCli = makeCli(emptyHarness);
  const empty = await installDeepSeekHarnessBridge(orchOptions(emptyHarness, emptyCli, {
    ...NO_WEB_COMMAND,
    env: { PATH: "" },
  }));
  assert.strictEqual(empty.status, "skipped");
  assert.strictEqual(empty.reason, "no-applicable-target");
  assert.deepStrictEqual(emptyCli.calls, []);
});

test("desktop probe failures keep their three distinct reasons", async (t) => {
  const cases = [
    { runCommand: async () => ({ code: 1 }), reason: "carrier-failed" },
    { runCommand: async () => ({ code: 0, stdout: "garbage" }), reason: "version-invalid" },
    { runCommand: async () => ({ code: 0, stdout: "0.9.0" }), reason: "version-unsupported" },
  ];
  for (const entry of cases) {
    const harness = makeHarness(t);
    writeProfileManifest(harness, "desktop");
    const cli = makeCli(harness);
    const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
      env: { PATH: "" },
      dshVersion: undefined,
      desktopDiscovery: desktopFound(harness),
      runCommand: entry.runCommand,
    }));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, entry.reason);
    assert.deepStrictEqual(cli.calls, []);
  }
});

// ---------------------------------------------------------------------------
// Startup sync must not touch a disabled plugin
// ---------------------------------------------------------------------------

test("startup sync reports a disabled web plugin and changes nothing", async (t) => {
  const harness = makeHarness(t);
  const { generationDir } = writeIncompleteProfile(harness, "web");
  const cli = makeCli(harness);
  const manifestBefore = fs.readFileSync(path.join(harness.dshHome, "profiles", "web", "package.json"));
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "startup-sync",
    clawdVersion: "9.9.9",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "plugin-disabled-in-dsh");
  assert.deepStrictEqual(cli.calls, []);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(harness.dshHome, "profiles", "web", "package.json")),
    manifestBefore
  );
  assert.strictEqual(fs.existsSync(generationDir), true);
});

test("startup sync reports a disabled desktop plugin and changes nothing", async (t) => {
  const harness = makeHarness(t);
  writeIncompleteProfile(harness, "desktop");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    ...NO_WEB_COMMAND,
    operation: "startup-sync",
    clawdVersion: "9.9.9",
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "plugin-disabled-in-dsh");
  assert.deepStrictEqual(cli.calls, []);
});

// ---------------------------------------------------------------------------
// Version changes under the lock
// ---------------------------------------------------------------------------

test("an install aborts when the host version changes under the lock", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  let probes = 0;
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async () => {
      probes += 1;
      return { code: 0, stdout: probes === 1 ? "0.1.0-rc.6" : "0.1.1-rc.2" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-changed");
  assert.deepStrictEqual(cli.calls, []);
});

test("an uninstall aborts when the host version changes under the lock", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const callsAfterInstall = cli.calls.length;
  let probes = 0;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async () => {
      probes += 1;
      return { code: 0, stdout: probes === 1 ? "0.1.0-rc.6" : "0.1.1-rc.2" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-changed");
  assert.strictEqual(cli.calls.length, callsAfterInstall);
});

// ---------------------------------------------------------------------------
// Uninstall summary
// ---------------------------------------------------------------------------

test("uninstall reports ok and registrationRemoved when everything is gone", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.registrationRemoved, true);
});

test("uninstall reports false when the registration is owned but removal failed", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { desktopDiscovery: desktopFound(harness) }));
  const failing = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, failing, {
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
    runDshCommand: async (args) => (args[2] === "desktop"
      ? { code: 1, stderr: "desktop remove denied" }
      : failing.runDshCommand(args)),
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
});

test("uninstall reports null when a residue prevents confirmation", async (t) => {
  const harness = makeHarness(t);
  const linkDir = path.join(harness.dshHome, "profiles", "web", "node_modules", "@dsh-external");
  fs.mkdirSync(path.join(linkDir, "dsh-clawd-bridge.clawd-removing-x"), { recursive: true });
  const cli = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, null);
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.healthReason, "profile-removal-residue");
  assert.ok(result.residuePath);
});

test("a desktop registration keeps its evidence when the app is gone", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { ...NO_WEB_COMMAND, env: { PATH: "" }, desktopDiscovery: desktopFound(harness) }));
  const callsAfterInstall = cli.calls.length;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, {
    ...NO_WEB_COMMAND,
    env: { PATH: "" },
    desktopDiscovery: NO_DESKTOP,
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(cli.calls.length, callsAfterInstall);
});

test("a registration restored under the lock cannot be reported as removed", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const profileManifestPath = path.join(harness.dshHome, "profiles", "web", "package.json");
  const registered = readJson(profileManifestPath);

  // Clear the registration so the pre-operation evidence says "none".
  const empty = readJson(profileManifestPath);
  empty.dependencies = {};
  empty.dsh.profile.bundles = [];
  writeJson(profileManifestPath, empty);
  fs.rmSync(packageDir(harness.dshHome, "web"), { recursive: true, force: true });

  let changed = false;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), {
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        if (changed) return;
        changed = true;
        writeJson(profileManifestPath, registered);
        symlinkDir(installed.generation, packageDir(harness.dshHome, "web"));
      },
    },
  }));

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(result.targets.web.result.registrationAfter, "present");
  assert.ok(readJson(profileManifestPath).dependencies[BRIDGE_PACKAGE_NAME]);
});

test("a confirmed removal stays removed when only the generation cleanup fails", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const error = new Error("injected generation cleanup denied");
  error.code = "EACCES";
  const realRm = fs.promises.rm;
  fs.promises.rm = async (file, ...args) => {
    if (file === installed.generation) throw error;
    return realRm.call(fs.promises, file, ...args);
  };
  try {
    const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness)));
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.registrationRemoved, true);
    assert.strictEqual(result.targets.web.result.registrationAfter, "removed");
    assert.strictEqual(
      !!readJson(path.join(harness.dshHome, "profiles", "web", "package.json")).dependencies[BRIDGE_PACKAGE_NAME],
      false
    );
  } finally {
    fs.promises.rm = realRm;
  }
});

test("unregisterDeepSeekHarness maps removed and skipped from the top level", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const removed = await unregisterDeepSeekHarness(orchOptions(harness, cli));
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(removed.skipped, false);
  const again = await unregisterDeepSeekHarness(orchOptions(harness, cli));
  assert.strictEqual(again.removed, false);
  assert.strictEqual(again.skipped, true);
});

// ---------------------------------------------------------------------------
// Failed add: partial-mutation detection
// ---------------------------------------------------------------------------

function failingAddCli(onAdd) {
  return {
    runDshCommand: async (args) => {
      if (args[3] === "add") return onAdd(args) || { code: 1, stderr: "add failed" };
      return { code: 1, stderr: `unexpected args: ${args.join(" ")}` };
    },
  };
}

test("a failed add that rewrote only the lock file keeps the generation and writes a record", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const lockfile = path.join(harness.dshHome, "profiles", "web", "pnpm-lock.yaml");
  let attempted = null;
  const cli = failingAddCli((args) => {
    attempted = args[4];
    fs.writeFileSync(lockfile, `newTarget: ${attempted}\n`);
    return { code: 1, stderr: "add failed after lock write" };
  });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.ok(attempted);
  assert.strictEqual(fs.existsSync(attempted), true, "the candidate generation is kept");
  assert.strictEqual(fs.existsSync(dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" })), true);
});

test("a failed add that rewrote only the manifest keeps the generation and writes a record", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const manifestPath = path.join(harness.dshHome, "profiles", "web", "package.json");
  let attempted = null;
  const cli = failingAddCli((args) => {
    attempted = args[4];
    const manifest = readJson(manifestPath);
    manifest.partialMutation = true;
    writeJson(manifestPath, manifest);
    return { code: 1, stderr: "add failed after manifest write" };
  });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(fs.existsSync(attempted), true);
  assert.strictEqual(fs.existsSync(dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" })), true);
});

test("a failed add that changed nothing discards the generation", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  let attempted = null;
  const cli = failingAddCli((args) => { attempted = args[4]; return { code: 1, stderr: "add failed" }; });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "plugin-add-failed");
  assert.strictEqual(fs.existsSync(attempted), false);
  assert.strictEqual(fs.existsSync(dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" })), false);
});

test("a failed add with an unreadable lock file is treated as a partial mutation", {
  skip: process.platform === "win32",
}, async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const lockfile = path.join(harness.dshHome, "profiles", "web", "pnpm-lock.yaml");
  fs.writeFileSync(lockfile, "old: 1\n", "utf8");
  // Unreadable at both snapshots, so only the explicit unreadable check can
  // prove the add's side effects are unknown.
  fs.chmodSync(lockfile, 0o000);
  t.after(() => { try { fs.chmodSync(lockfile, 0o600); } catch {} });

  let attempted = null;
  const cli = failingAddCli((args) => { attempted = args[4]; return { code: 1, stderr: "add failed" }; });
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.ok(attempted);
  assert.strictEqual(fs.existsSync(attempted), true, "the candidate generation is kept");
  assert.strictEqual(fs.existsSync(dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" })), true);
});

// ---------------------------------------------------------------------------
// Uninstall conclusion: one final read after both flows
// ---------------------------------------------------------------------------

test("uninstall reports error when a formerly not-applicable side gains a registration", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  // At resolution time desktop has an empty manifest and no Clawd registration.
  writeProfileManifest(harness, "desktop");
  const desktopManifestPath = path.join(harness.dshHome, "profiles", "desktop", "package.json");
  const desktopLocal = packageDir(harness.dshHome, "desktop");
  let appeared = false;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), {
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        if (appeared) return;
        appeared = true;
        const manifest = readJson(desktopManifestPath);
        manifest.dependencies[BRIDGE_PACKAGE_NAME] = `link:${installed.generation}`;
        manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME];
        writeJson(desktopManifestPath, manifest);
        fs.mkdirSync(path.dirname(desktopLocal), { recursive: true });
        symlinkDir(installed.generation, desktopLocal);
      },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(result.reason, "uninstall-unconfirmed");
  assert.strictEqual(result.targets.desktop.registrationAfter, "present");
});

test("uninstall re-reads web after the desktop flow finishes", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { desktopDiscovery: desktopFound(harness) }));
  const webManifestPath = path.join(harness.dshHome, "profiles", "web", "package.json");
  const savedWeb = readJson(webManifestPath);
  const webLocal = packageDir(harness.dshHome, "web");
  let locks = 0;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), {
    desktopDiscovery: desktopFound(harness),
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        locks += 1;
        if (locks !== 2) return; // desktop's lock, after web already ran
        writeJson(webManifestPath, savedWeb);
        fs.mkdirSync(path.dirname(webLocal), { recursive: true });
        symlinkDir(installed.generation, webLocal);
      },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(result.targets.web.registrationAfter, "present");
});

test("a skipped side that reappears is reported as uninstall-unconfirmed", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const installed = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { desktopDiscovery: desktopFound(harness) }));
  // web unregisters as skipped (empty profile); desktop still runs.
  const webManifestPath = path.join(harness.dshHome, "profiles", "web", "package.json");
  const savedWeb = readJson(webManifestPath);
  const emptyWeb = readJson(webManifestPath);
  emptyWeb.dependencies = {};
  emptyWeb.dsh.profile.bundles = [];
  writeJson(webManifestPath, emptyWeb);
  fs.rmSync(packageDir(harness.dshHome, "web"), { recursive: true, force: true });

  let locks = 0;
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, makeCli(harness), {
    desktopDiscovery: desktopFound(harness),
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        locks += 1;
        if (locks !== 2) return; // desktop's lock, after web already ran
        writeJson(webManifestPath, savedWeb);
        fs.mkdirSync(path.dirname(packageDir(harness.dshHome, "web")), { recursive: true });
        symlinkDir(installed.generation, packageDir(harness.dshHome, "web"));
      },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.registrationRemoved, false);
  assert.strictEqual(result.reason, "uninstall-unconfirmed");
  assert.match(result.message, /web/);

  const state = await readDeepSeekHarnessNotices({ dshHome: harness.dshHome, managedRoot: harness.managedRoot });
  const failed = state.web.find((notice) => notice.kind === "failed-target");
  assert.ok(failed);
  assert.strictEqual(failed.payload.reason, "uninstall-unconfirmed");
});

// ---------------------------------------------------------------------------
// Inspect records read inside the lock
// ---------------------------------------------------------------------------

test("an invalid inspection record stops an explicit repair before any command", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const latch = dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" });
  writeJson(latch, { owner: "clawd-on-desk", schemaVersion: 1, reason: "previous-add-unknown" });
  const external = path.join(harness.root, "external-inspection-record");
  writeJson(external, { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });

  // The record is valid until the lock; the lock-time re-read must catch the
  // symlink and stop before any command, without touching the link target.
  let replaced = false;
  const repairCli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, repairCli, {
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
  assert.deepStrictEqual(repairCli.calls, []);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
  assert.deepStrictEqual(readJson(external), { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
});

test("an invalid inspection record stops an uninstall before remove", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  const latch = dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" });

  // The record appears only after the pre-lock read; the lock-time check must
  // catch it before remove.
  let injected = false;
  const removeCli = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, removeCli, {
    __testMutationLockHooks: {
      beforeOwnerWrite: async () => {
        if (injected) return;
        injected = true;
        fs.mkdirSync(path.dirname(latch), { recursive: true });
        fs.symlinkSync(path.join(harness.root, "missing-inspection-record"), latch);
      },
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.deepStrictEqual(removeCli.calls, []);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
  assert.strictEqual(dependencyPath(harness, "web") !== null, true);
});

test("an invalid inspection record stops an install that would add", async (t) => {
  const harness = makeHarness(t);
  // No dependency yet: this run would need to add the bridge, not skip it.
  writeProfileManifest(harness, "web");
  const latch = dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" });
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
  assert.strictEqual(dependencyPath(harness, "web"), null);
  assert.strictEqual(fs.lstatSync(latch).isSymbolicLink(), true);
  assert.deepStrictEqual(readJson(external), { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });
});

test("an invalid inspection record stops confirming a previous removal", async (t) => {
  const harness = makeHarness(t);
  // No dependency, but a valid record: uninstall takes the confirm-removal path.
  writeProfileManifest(harness, "web");
  const latch = dshInstallTest.inspectionLatchPath({ managedRoot: harness.managedRoot, profile: "web" });
  writeJson(latch, { owner: "clawd-on-desk", schemaVersion: 1, reason: "previous-remove-unknown" });
  const external = path.join(harness.root, "external-inspection-record");
  writeJson(external, { owner: "clawd-on-desk", schemaVersion: 1, reason: "still-valid" });

  let replaced = false;
  const cli = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, {
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
});

// ---------------------------------------------------------------------------
// Two profiles sharing a generation
// ---------------------------------------------------------------------------

test("two same-family profiles share one generation and verify their own versions", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    dshVersion: undefined,
    desktopDiscovery: desktopFound(harness),
    runCommand: async (command) => ({
      code: 0,
      stdout: command === "dsh" ? "0.2.0-rc.2" : "0.2.1",
    }),
  }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(dependencyPath(harness, "web"), dependencyPath(harness, "desktop"));
  assert.ok(cli.calls.some((args) => args[2] === "web"));
  assert.ok(cli.calls.some((args) => args[2] === "desktop"));
});

// ---------------------------------------------------------------------------
// Manual reference ownership
// ---------------------------------------------------------------------------

test("a desktop install never clears the web manual reference", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { commandInfo: null, dshCommand: false }));
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  const before = fs.readFileSync(referencePath);

  const unsupportedRoot = path.join(harness.root, "unsupported-dsh");
  writeJson(path.join(unsupportedRoot, "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.0" });
  writeProfileManifest(harness, "desktop");
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    dshInstallRoot: unsupportedRoot,
    desktopDiscovery: desktopFound(harness),
  }));
  // web is version-unsupported and not run, so only desktop changed.
  assert.strictEqual(result.targets.web.role, "diagnose");
  assert.deepStrictEqual(fs.readFileSync(referencePath), before);
});

// ---------------------------------------------------------------------------
// Desktop success metadata and isolation
// ---------------------------------------------------------------------------

test("a first desktop install carries firstInstall without restartRequired", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(result.firstInstall, true);
  assert.strictEqual(result.restartRequired, false);
  assert.match(result.message, /after a plugin update, restart the desktop app/);
});

test("a desktop generation change carries restartRequired without firstInstall", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" }, desktopDiscovery: desktopFound(harness) }));
  const alternateSource = path.join(harness.root, "alternate-source");
  fs.cpSync(SOURCE_DIR, alternateSource, { recursive: true });
  fs.appendFileSync(path.join(alternateSource, "lib", "index.js"), "\n// alternate\n", "utf8");
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    env: { PATH: "" },
    sourceDir: alternateSource,
    operation: "explicit-repair",
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(result.firstInstall, false);
  assert.strictEqual(result.restartRequired, true);
});

test("a repeated desktop install carries neither notice flag", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" }, desktopDiscovery: desktopFound(harness) }));
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" }, desktopDiscovery: desktopFound(harness) }));
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.firstInstall, undefined);
  assert.strictEqual(result.restartRequired, undefined);
});

test("a throwing target does not stop the other target", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  // Seed a web manual reference so the web flow reaches its clear step.
  await installDeepSeekHarnessBridge(orchOptions(harness, cli, { commandInfo: null, dshCommand: false }));
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    desktopDiscovery: desktopFound(harness),
    __testManualGenerationReferenceHooks: {
      beforeClearMove() {
        throw new Error("web exploded");
      },
    },
  }));
  assert.strictEqual(result.targets.web.result.status, "error");
  assert.strictEqual(result.targets.web.result.reason, "unexpected-error");
  assert.ok(result.warnings.some((line) => line.includes("web exploded")));
  assert.ok(cli.calls.some((args) => args[2] === "desktop"));
  assert.ok(dependencyPath(harness, "desktop"));
});

test("the result exposes a targets map with role, reason and result", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  assert.strictEqual(result.targets.web.role, "mutable");
  assert.strictEqual(result.targets.desktop.role, "not-applicable");
  assert.strictEqual(result.targets.desktop.reason, "desktop-not-installed");
  assert.strictEqual(result.targets.desktop.result, null);
});

// ---------------------------------------------------------------------------
// Web diagnose results stay identical to the old single-profile flow
// ---------------------------------------------------------------------------

test("a web removal residue keeps the old inspection result and names targetReason", async (t) => {
  const harness = makeHarness(t);
  const linkDir = path.join(harness.dshHome, "profiles", "web", "node_modules", "@dsh-external");
  fs.mkdirSync(path.join(linkDir, "dsh-clawd-bridge.clawd-removing-x"), { recursive: true });
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.healthReason, "profile-removal-residue");
  assert.ok(result.residuePath);
  assert.strictEqual(result.targetReason, "removal-residue");
});

test("a web inspection latch keeps the old result and names targetReason", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeJson(path.join(harness.managedRoot, "inspection-required.json"), {
    owner: "someone-else",
    schemaVersion: 1,
  });
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.targetReason, "latch-invalid");
});

test("an invalid web manual reference keeps the old result and names targetReason", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  writeJson(referencePath, { owner: "someone-else", schemaVersion: 1 });
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "manual-generation-reference-invalid");
  assert.strictEqual(result.referencePath, referencePath);
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.strictEqual(result.targetReason, "manual-reference-invalid");
});

test("a foreign web package keeps the old result and names targetReason", async (t) => {
  const harness = makeHarness(t);
  const profileDir = writeProfileManifest(harness, "web");
  const manifest = readJson(path.join(profileDir, "package.json"));
  manifest.dependencies[BRIDGE_PACKAGE_NAME] = "file:/foreign";
  manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
  writeJson(path.join(profileDir, "package.json"), manifest);
  const local = packageDir(harness.dshHome, "web");
  writeJson(path.join(local, "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "9.9.9" });
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "profile-entry-foreign-or-conflicting");
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.strictEqual(result.targetReason, "foreign-package");
});

test("tampered web bridge bytes keep the old result and name targetReason", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  await installDeepSeekHarnessBridge(orchOptions(harness, cli));
  fs.appendFileSync(path.join(packageDir(harness.dshHome, "web"), "lib", "index.js"), "\n// tampered\n", "utf8");
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "generation-integrity-failed");
  assert.strictEqual(result.targetReason, "integrity-failed");
});

test("startup sync on a missing web profile keeps repair-required and names targetReason", async (t) => {
  const harness = makeHarness(t);
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    operation: "startup-sync",
    env: { PATH: "" },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "repair-required");
  assert.strictEqual(result.targetReason, "web-profile-uninitialized");
});

test("uninstall reports skipped when nothing is registered on either side", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const result = await uninstallDeepSeekHarnessBridge(orchOptions(harness, cli, { env: { PATH: "" } }));
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "bridge-not-installed");
  assert.strictEqual(result.registrationRemoved, true);
});

// ---------------------------------------------------------------------------
// Operation mode re-resolves the web command
// ---------------------------------------------------------------------------

function makeLoginShellDsh(harness) {
  const binDir = path.join(harness.root, "login-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const dshPath = path.join(binDir, "dsh");
  fs.writeFileSync(dshPath, "#!/bin/sh\n");
  return dshPath;
}

function loginShellRunCommand(dshPath) {
  return async (_program, args) => (args && args[0] === "-lc" && args[1] === "command -v dsh"
    ? { code: 0, stdout: `${dshPath}\n` }
    : { code: 1, stderr: "unexpected command" });
}

function loginShellOptions(harness, cli, dshPath, overrides = {}) {
  return orchOptions(harness, cli, {
    commandInfo: undefined,
    dshCommand: undefined,
    dshVersion: FAMILY_VERSION,
    shellPath: "/bin/sh",
    nodeBin: "/usr/bin/node",
    access: async () => {},
    env: { PATH: "" },
    runCommand: loginShellRunCommand(dshPath),
    ...overrides,
  });
}

// Login-shell command discovery only exists on POSIX; win32 resolves dsh with
// where.exe, so this scenario has no Windows equivalent.
test("operation mode finds a login-shell dsh and initializes a missing web profile", {
  skip: process.platform === "win32",
}, async (t) => {
  const harness = makeHarness(t);
  const cli = makeCli(harness);
  const dshPath = makeLoginShellDsh(harness);
  const result = await installDeepSeekHarnessBridge(loginShellOptions(harness, cli, dshPath));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.targets.web.role, "mutable");
  assert.ok(cli.calls.some((args) => args[2] === "web"));
  assert.ok(dependencyPath(harness, "web"));
});

test("operation mode finds a login-shell dsh with an existing web manifest", {
  skip: process.platform === "win32",
}, async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  const cli = makeCli(harness);
  const dshPath = makeLoginShellDsh(harness);
  const result = await installDeepSeekHarnessBridge(loginShellOptions(harness, cli, dshPath));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.targets.web.role, "mutable");
  assert.ok(cli.calls.some((args) => args[2] === "web"));
});

test("cleanup options forward the injected desktop discovery to the DSH cleaner", () => {
  const marker = { status: "not-found", appRoot: null, launcherPath: null, staticVersion: null, checkedPaths: [], reason: "marker" };
  const plan = buildCleanupOptionsForHome("/tmp/clawd-cleanup-home", { dshDesktopDiscovery: marker });
  assert.strictEqual(plan.byAgent["deepseek-harness"].desktopDiscovery, marker);
});

test("a desktop success keeps web's manual command on the top-level ok result", async (t) => {
  const harness = makeHarness(t);
  writeProfileManifest(harness, "web");
  writeProfileManifest(harness, "desktop");
  const cli = makeCli(harness);
  const result = await installDeepSeekHarnessBridge(orchOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    env: { PATH: "" },
    desktopDiscovery: desktopFound(harness),
  }));
  assert.strictEqual(result.status, "ok");
  assert.ok(result.manualCommand);
  assert.match(result.manualCommand, /plugin --profile web add|'plugin' '--profile' 'web' 'add'/);
  assert.ok(result.warnings.some((line) => line.startsWith("web:")));
});
