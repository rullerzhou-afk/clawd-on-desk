"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PACKAGE_NAME,
  DSH_RESTART_HINT,
  DSH_VERSION_FAMILIES,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  VERIFIED_DSH_ARTIFACTS,
  dshContractForMarker,
  dshContractForVersion,
  installDeepSeekHarnessBridge,
  isSupportedDshVersion,
  supportedDshRangeLabel,
  inspectDeepSeekHarnessDiskSync,
  inspectDeepSeekHarnessIntegration,
  isBridgeInstalled,
  isDshInstalled,
  registerDeepSeekHarness,
  resolveBridgeSourceDir,
  resolveDshCommand,
  resolveManagedRoot,
  unregisterDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
} = require("../hooks/dsh-install");
const { __test: dshInstallTest } = require("../hooks/dsh-install");

const SOURCE_DIR = path.join(__dirname, "..", "hooks", "dsh-clawd-bridge");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function canonicalRealpath(filePath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
}

function makeHarness({ profile = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-managed-"));
  const dshHome = path.join(root, ".dsh");
  const profileDir = path.join(dshHome, "profiles", "web");
  const managedRoot = path.join(root, ".clawd", "integrations", "deepseek-harness");
  if (profile) {
    writeJson(path.join(profileDir, "package.json"), {
      name: "dsh-profile-web",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    });
  }
  return { root, dshHome, profileDir, managedRoot };
}

function packageDir(profileDir) {
  return path.join(profileDir, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
}

function makeOfficialCli(harness, options = {}) {
  const calls = [];
  let installedGenerationDir = null;
  const runDshCommand = async (args) => {
    calls.push([...args]);
    if (options.throwError) throw new Error(options.throwError);
    if (options.fail) return { code: 1, stderr: options.fail };
    const action = args[3];
    const manifestPath = path.join(harness.profileDir, "package.json");
    if (action === "add") {
      if (options.noMutation) return { code: 0 };
      const generationDir = args[4];
      installedGenerationDir = generationDir;
      const manifest = fs.existsSync(manifestPath)
        ? readJson(manifestPath)
        : { name: "dsh-profile-web", private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
      manifest.dependencies ||= {};
      manifest.dsh ||= { profile: { bundles: [] } };
      manifest.dsh.profile ||= { bundles: [] };
      manifest.dsh.profile.bundles ||= [];
      manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${generationDir}`;
      if (!manifest.dsh.profile.bundles.includes(BRIDGE_PACKAGE_NAME)) {
        manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
      }
      writeJson(manifestPath, manifest);
      const target = packageDir(harness.profileDir);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (options.materializeAsLink) {
        fs.symlinkSync(generationDir, target, process.platform === "win32" ? "junction" : "dir");
      } else {
        fs.cpSync(generationDir, target, { recursive: true });
      }
      return { code: 0 };
    }
    if (action === "remove") {
      const manifest = readJson(manifestPath);
      delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== BRIDGE_PACKAGE_NAME);
      writeJson(manifestPath, manifest);
      if (options.retargetResidueTo) {
        fs.rmSync(packageDir(harness.profileDir), { recursive: true, force: true });
        fs.symlinkSync(options.retargetResidueTo, packageDir(harness.profileDir), process.platform === "win32" ? "junction" : "dir");
      } else if (!options.leaveResolvedResidue) {
        fs.rmSync(packageDir(harness.profileDir), { recursive: true, force: true });
      }
      return { code: 0 };
    }
    return { code: 1, stderr: `unexpected dsh args: ${args.join(" ")}` };
  };
  return { calls, runDshCommand, get installedGenerationDir() { return installedGenerationDir; } };
}

function installOptions(harness, cli, overrides = {}) {
  return {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    sourceDir: SOURCE_DIR,
    dshInstalled: true,
    pnpmAvailable: true,
    commandInfo: { command: "dsh", prefixArgs: [], installRoot: null },
    runDshCommand: cli.runDshCommand,
    clawdVersion: "1.2.3",
    dshVersion: SUPPORTED_DSH_VERSION,
    dshInstallRoot: null,
    silent: true,
    desktopDiscovery: { status: "not-found", appRoot: null, launcherPath: null, staticVersion: null, checkedPaths: [], reason: null },
    ...overrides,
  };
}

const FAMILY_02_RANGE = DSH_VERSION_FAMILIES[0].range;
const FAMILY_01_RANGE = DSH_VERSION_FAMILIES[1].range;

function installProfileLink(harness, generationDir) {
  const manifestPath = path.join(harness.profileDir, "package.json");
  const manifest = readJson(manifestPath);
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

// Materialize a managed generation exactly as a pre-family Clawd did: source
// copied in, an exact "=<version>" marker, and a profile link to it.
function writeHistoricalGeneration(harness, version, sourceClawdVersion = "1.2.3") {
  const contract = dshContractForVersion(version);
  const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, contract);
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  for (const target of [generationDir, packageDir(harness.profileDir)]) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(SOURCE_DIR, target, { recursive: true });
    writeJson(path.join(target, "clawd-manifest.json"), {
      owner: "clawd-on-desk",
      schemaVersion: 1,
      protocolVersion: 1,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash,
      sourceClawdVersion,
      supportedDshRange: contract.supportedDshRange,
      installedDshVersion: version,
      installedDshVersionAssumedAtStaging: false,
      verifiedDshArtifact: contract.verifiedDshArtifact,
      verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
      sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  installProfileLink(harness, generationDir);
  return { contract, bundleHash, generationDir };
}

// Materialize a family generation with a chosen installed version, so tests
// can exercise a version that is admitted but not on the verified list.
function writeFamilyGeneration(harness, family, installedVersion) {
  const bundleHash = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, {
    supportedDshRange: family.range,
  });
  const generationDir = path.join(harness.managedRoot, "generations", bundleHash);
  for (const target of [generationDir, packageDir(harness.profileDir)]) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(SOURCE_DIR, target, { recursive: true });
    writeJson(path.join(target, "clawd-manifest.json"), {
      owner: "clawd-on-desk",
      schemaVersion: 1,
      protocolVersion: 1,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash,
      sourceClawdVersion: "1.2.3",
      supportedDshRange: family.range,
      installedDshVersion: installedVersion,
      installedDshVersionAssumedAtStaging: false,
      sourceAuditBaselineCommit: "47f943859bef60e4160492346772ded9b24f765a",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  installProfileLink(harness, generationDir);
  return { bundleHash, generationDir };
}

test("DSH detection is async and distinguishes the host from the managed plugin", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  assert.strictEqual(await isDshInstalled({ dshHome: harness.dshHome }), true);
  assert.strictEqual(await isBridgeInstalled({ dshHome: harness.dshHome, resolveCommandForInspection: false }), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("an empty home without a CLI is not a DSH installation", async (t) => {
  const harness = makeHarness({ profile: false });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  assert.strictEqual(await isDshInstalled({ dshHome: harness.dshHome, dshCommandAvailable: false }), false);
});

test("packaged bridge source resolves outside app.asar on Windows paths", () => {
  const resolved = resolveBridgeSourceDir("C:\\Program Files\\Clawd\\resources\\app.asar\\hooks");
  assert.match(resolved, /app\.asar\.unpacked[\\/]hooks[\\/]dsh-clawd-bridge$/);
});

test("Windows CLI discovery follows a pnpm-style shim instead of assuming one global npm layout", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-shim-"));
  const shim = path.join(root, "dsh.cmd");
  const binJs = path.join(root, "pnpm-global", "5", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.writeFileSync(binJs, "export {};\n", "utf8");
  fs.writeFileSync(shim, '@echo off\r\n"node" "%~dp0pnpm-global\\5\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n', "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = await resolveDshCommand({
    platform: "win32",
    resolveNodeBinAsyncImpl: async () => "C:\\Program Files\\nodejs\\node.exe",
    runCommand: async (program, args) => {
      assert.strictEqual(program, "where.exe");
      assert.deepStrictEqual(args, ["dsh"]);
      return { code: 0, stdout: `${shim}\r\n` };
    },
  });
  assert.strictEqual(command.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepStrictEqual(command.prefixArgs, [binJs]);
  assert.strictEqual(command.installRoot, path.dirname(path.dirname(binJs)));
});

test("POSIX CLI discovery resolves the DSH entrypoint through an absolute Node binary", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-posix-cli-"));
  const dshPath = path.join(root, "homebrew", "bin", "dsh");
  const binJs = path.join(root, "homebrew", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const nodePath = path.join(root, "homebrew", "opt", "node@22", "bin", "node");
  fs.mkdirSync(path.dirname(dshPath), { recursive: true });
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(binJs, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(nodePath, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(binJs, dshPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const command = await resolveDshCommand({
    platform: "darwin",
    shellPath: "/bin/zsh",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh",
      DSH_HOME: path.join(root, ".dsh"),
    },
    resolveNodeBinAsyncImpl: async () => nodePath,
    runCommand: async (program, args) => {
      assert.strictEqual(program, "/bin/zsh");
      assert.deepStrictEqual(args, ["-lc", "command -v dsh"]);
      return { code: 0, stdout: `${dshPath}\n` };
    },
  });

  assert.strictEqual(command.command, nodePath);
  assert.deepStrictEqual(command.prefixArgs, [canonicalRealpath(binJs)]);
  assert.strictEqual(command.installRoot, path.dirname(path.dirname(canonicalRealpath(binJs))));
  assert.strictEqual(command.env.DSH_HOME, path.join(root, ".dsh"));
  assert.deepStrictEqual(command.env.PATH.split(path.delimiter).slice(0, 2), [
    path.dirname(nodePath),
    path.dirname(dshPath),
  ]);
});

test("POSIX CLI discovery uses interactive shell startup only as a fallback", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-posix-cli-fallback-"));
  const dshPath = path.join(root, "interactive", "bin", "dsh");
  const binJs = path.join(root, "interactive", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const nodePath = path.join(root, "node", "bin", "node");
  fs.mkdirSync(path.dirname(dshPath), { recursive: true });
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(binJs, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(nodePath, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(binJs, dshPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const discoveryCalls = [];
  const command = await resolveDshCommand({
    platform: "darwin",
    shellPath: "/bin/zsh",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" },
    resolveNodeBinAsyncImpl: async () => nodePath,
    runCommand: async (program, args) => {
      assert.strictEqual(program, "/bin/zsh");
      discoveryCalls.push(args);
      if (args[0] === "-lc") return { code: 1, stderr: "dsh not found" };
      return { code: 0, stdout: `[interactive startup]\n${dshPath}\n` };
    },
  });

  assert.deepStrictEqual(discoveryCalls, [
    ["-lc", "command -v dsh"],
    ["-lic", "command -v dsh"],
  ]);
  assert.strictEqual(command.command, nodePath);
  assert.deepStrictEqual(command.prefixArgs, [canonicalRealpath(binJs)]);
});

test("POSIX DSH install and uninstall reuse a GUI-safe PATH for pnpm mutations", {
  skip: process.platform === "win32",
}, async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const toolRoot = path.join(harness.root, "toolchain");
  const dshPath = path.join(toolRoot, "homebrew", "bin", "dsh");
  const binJs = path.join(toolRoot, "homebrew", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const nodePath = path.join(toolRoot, "node", "bin", "node");
  const pnpmPath = path.join(toolRoot, "pnpm", "bin", "pnpm");
  for (const filePath of [binJs, nodePath, pnpmPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
  }
  fs.mkdirSync(path.dirname(dshPath), { recursive: true });
  fs.symlinkSync(binJs, dshPath);
  const canonicalBinJs = canonicalRealpath(binJs);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const guiPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const mutationEnvs = [];
  const runCommand = async (program, args, options) => {
    if (program === "/bin/zsh" && args[1] === "command -v dsh") {
      assert.deepStrictEqual(args, ["-lc", "command -v dsh"]);
      return { code: 0, stdout: `${dshPath}\n` };
    }
    if (program === "/bin/zsh" && args[1] === "command -v pnpm") {
      assert.deepStrictEqual(args, ["-lc", "command -v pnpm"]);
      return { code: 0, stdout: `${pnpmPath}\n` };
    }
    if (program === pnpmPath && args[0] === "--version") {
      assert.ok(options.env.PATH.split(path.delimiter).includes(path.dirname(nodePath)));
      return { code: 0, stdout: "10.30.3\n" };
    }
    if (program === nodePath && args[0] === canonicalBinJs && args[1] === "--version") {
      assert.ok(options.env.PATH.split(path.delimiter).includes(path.dirname(nodePath)));
      return { code: 0, stdout: `${SUPPORTED_DSH_VERSION}\n` };
    }
    if (program === nodePath && args[0] === canonicalBinJs && args[1] === "plugin") {
      mutationEnvs.push(options.env);
      return cli.runDshCommand(args.slice(1));
    }
    return { code: 1, stderr: `unexpected command: ${program} ${args.join(" ")}` };
  };
  const options = installOptions(harness, cli, {
    platform: "darwin",
    env: { PATH: guiPath, SHELL: "/bin/zsh" },
    shellPath: "/bin/zsh",
    commandInfo: undefined,
    dshVersion: undefined,
    pnpmAvailable: undefined,
    runDshCommand: undefined,
    resolveNodeBinAsyncImpl: async () => nodePath,
    runCommand,
  });

  const installed = await installDeepSeekHarnessBridge(options);
  assert.strictEqual(installed.status, "ok", JSON.stringify(installed));
  const uninstalled = await uninstallDeepSeekHarnessBridge(options);
  assert.strictEqual(uninstalled.status, "ok", JSON.stringify(uninstalled));
  assert.strictEqual(mutationEnvs.length, 2);
  for (const env of mutationEnvs) {
    const entries = env.PATH.split(path.delimiter);
    assert.deepStrictEqual(entries.slice(0, 3), [
      path.dirname(pnpmPath),
      path.dirname(nodePath),
      path.dirname(dshPath),
    ]);
    assert.strictEqual(env.DSH_HOME, canonicalRealpath(harness.dshHome));
  }
});

test("the cross-process DSH mutation lock rejects a concurrent owner and releases by token", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const first = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot });
  await assert.rejects(
    dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot }),
    /already locked/
  );
  await first.release();
  const second = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot });
  await second.release();
});

test("a stale DSH mutation lock is recovered only after ESRCH proves its owner is dead", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const stranded = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot, timeoutMs: 1000 });
  const ownerPath = path.join(stranded.lockPath, "owner.json");
  const owner = readJson(ownerPath);
  owner.pid = 424242;
  owner.createdAt = "2026-08-14T00:00:00.000Z";
  writeJson(ownerPath, owner);
  const recovered = await dshInstallTest.acquireMutationLock({
    managedRoot: harness.managedRoot,
    timeoutMs: 1000,
    nowMs: () => Date.parse("2026-08-14T00:00:03.000Z"),
    processKill(pid, signal) {
      assert.strictEqual(pid, 424242);
      assert.strictEqual(signal, 0);
      const err = new Error("missing process");
      err.code = "ESRCH";
      throw err;
    },
  });
  assert.strictEqual(recovered.lockPath, stranded.lockPath);
  assert.strictEqual(
    fs.readdirSync(harness.managedRoot).some((name) => name.startsWith("mutation.lock.stale-")),
    false,
  );
  await recovered.release();
});

test("a live, fresh, unknown, or corrupt DSH mutation lock remains fail-closed with its path", async (t) => {
  for (const scenario of ["live", "fresh", "unknown", "corrupt"]) {
    const harness = makeHarness();
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const stranded = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot, timeoutMs: 1000 });
    const ownerPath = path.join(stranded.lockPath, "owner.json");
    const owner = readJson(ownerPath);
    owner.pid = 434343;
    owner.createdAt = scenario === "fresh"
      ? "2026-08-14T00:00:02.500Z"
      : "2026-08-14T00:00:00.000Z";
    if (scenario === "corrupt") delete owner.schemaVersion;
    writeJson(ownerPath, owner);
    const processKill = () => {
      if (scenario === "unknown") {
        const err = new Error("access denied");
        err.code = "EPERM";
        throw err;
      }
      return undefined;
    };
    await assert.rejects(
      dshInstallTest.acquireMutationLock({
        managedRoot: harness.managedRoot,
        timeoutMs: 1000,
        nowMs: () => Date.parse("2026-08-14T00:00:03.000Z"),
        processKill,
      }),
      (err) => {
        assert.strictEqual(err.code, "DSH_MUTATION_LOCKED");
        assert.strictEqual(err.lockPath, stranded.lockPath);
        assert.match(err.message, /lock path:/);
        if (scenario === "unknown") assert.match(err.message, /liveness is unknown/);
        if (scenario === "corrupt") assert.match(err.message, /owner metadata is invalid/);
        return true;
      },
      scenario,
    );
  }
});

test("two stale-lock contenders cannot both acquire the canonical DSH mutation lock", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const stranded = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot, timeoutMs: 1000 });
  const ownerPath = path.join(stranded.lockPath, "owner.json");
  const owner = readJson(ownerPath);
  owner.pid = 444444;
  owner.createdAt = "2026-08-14T00:00:00.000Z";
  writeJson(ownerPath, owner);
  const options = {
    managedRoot: harness.managedRoot,
    timeoutMs: 1000,
    nowMs: () => Date.parse("2026-08-14T00:00:03.000Z"),
    processKill() {
      const err = new Error("missing process");
      err.code = "ESRCH";
      throw err;
    },
  };
  const results = await Promise.allSettled([
    dshInstallTest.acquireMutationLock(options),
    dshInstallTest.acquireMutationLock(options),
  ]);
  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  const rejected = results.filter((entry) => entry.status === "rejected");
  assert.strictEqual(fulfilled.length, 1);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].reason.code, "DSH_MUTATION_LOCKED");
  await fulfilled[0].value.release();
});

test("stale-lock recovery uses the owner's recorded operation timeout, not the contender's", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const stranded = await dshInstallTest.acquireMutationLock({
    managedRoot: harness.managedRoot,
    timeoutMs: 10 * 60 * 1000,
  });
  const ownerPath = path.join(stranded.lockPath, "owner.json");
  const owner = readJson(ownerPath);
  owner.pid = 454545;
  owner.createdAt = "2026-08-14T00:00:00.000Z";
  writeJson(ownerPath, owner);
  let livenessProbes = 0;
  const contender = {
    managedRoot: harness.managedRoot,
    timeoutMs: 1000,
    processKill() {
      livenessProbes += 1;
      const err = new Error("missing process");
      err.code = "ESRCH";
      throw err;
    },
  };
  await assert.rejects(
    dshInstallTest.acquireMutationLock({
      ...contender,
      nowMs: () => Date.parse("2026-08-14T00:04:00.000Z"),
    }),
    /has not exceeded its stale threshold/
  );
  assert.strictEqual(livenessProbes, 0);
  const recovered = await dshInstallTest.acquireMutationLock({
    ...contender,
    nowMs: () => Date.parse("2026-08-14T00:20:00.001Z"),
  });
  assert.strictEqual(livenessProbes, 1);
  await recovered.release();
});

test("mutation-lock cleanup never recursively removes unexpected contents", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  let ownerWriteLockPath;
  await assert.rejects(
    dshInstallTest.acquireMutationLock({
      managedRoot: harness.managedRoot,
      __testMutationLockHooks: {
        beforeOwnerWrite({ lockDir }) {
          ownerWriteLockPath = lockDir;
          fs.writeFileSync(path.join(lockDir, "unexpected.txt"), "preserve", "utf8");
          const err = new Error("simulated owner write failure");
          err.code = "EIO";
          throw err;
        },
      },
    }),
    (err) => {
      assert.strictEqual(err.code, "DSH_MUTATION_LOCKED");
      assert.strictEqual(err.lockPath, ownerWriteLockPath);
      assert.match(err.message, /manual inspection required/);
      return true;
    }
  );
  assert.strictEqual(fs.readFileSync(path.join(ownerWriteLockPath, "unexpected.txt"), "utf8"), "preserve");

  fs.rmSync(ownerWriteLockPath, { recursive: true, force: true });
  const releaseLock = await dshInstallTest.acquireMutationLock({ managedRoot: harness.managedRoot });
  fs.writeFileSync(path.join(releaseLock.lockPath, "unexpected.txt"), "preserve", "utf8");
  await assert.rejects(releaseLock.release(), (err) => {
    assert.strictEqual(err.code, "DSH_MUTATION_LOCKED");
    assert.strictEqual(err.lockPath, releaseLock.lockPath);
    assert.match(err.message, /unexpected lock contents/);
    return true;
  });
  assert.strictEqual(fs.readFileSync(path.join(releaseLock.lockPath, "unexpected.txt"), "utf8"), "preserve");
});

test("mutation-lock release detects an owner swap at the cleanup seam", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const lock = await dshInstallTest.acquireMutationLock({
    managedRoot: harness.managedRoot,
    __testMutationLockHooks: {
      beforeReleaseOwnerMove({ lockDir }) {
        const ownerPath = path.join(lockDir, "owner.json");
        const owner = readJson(ownerPath);
        owner.token = "foreign-owner-token";
        writeJson(ownerPath, owner);
      },
    },
  });
  await assert.rejects(lock.release(), (err) => {
    assert.strictEqual(err.code, "DSH_MUTATION_LOCKED");
    assert.strictEqual(err.lockPath, lock.lockPath);
    assert.match(err.message, /changed during release/);
    return true;
  });
  const retained = fs.readdirSync(lock.lockPath);
  assert.strictEqual(retained.some((name) => name.startsWith("owner.release-")), true);
});

test("explicit install promotes an immutable generation and verifies both profile rows and marker", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.message, DSH_RESTART_HINT);
  assert.match(result.generation, /generations[\\/][a-f0-9]{64}$/);
  assert.deepStrictEqual(cli.calls[0].slice(0, 4), ["plugin", "--profile", "web", "add"]);
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.owner, "clawd-on-desk");
  assert.strictEqual(health.marker.bundleHash, path.basename(result.generation));
  assert.strictEqual(health.marker.installedDshVersionAssumedAtStaging, false);
  assert.strictEqual(await isBridgeInstalled({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  }), true);
});

test("register is an installing operation and a repeated install is idempotent", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const first = await registerDeepSeekHarness(installOptions(harness, cli));
  const second = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(first.status, "ok");
  assert.strictEqual(first.updated, true);
  assert.strictEqual(second.status, "ok");
  assert.strictEqual(second.updated, false);
  assert.strictEqual(cli.calls.length, 1);
});

test("startup sync does not initialize a missing web profile; explicit repair may", async (t) => {
  const harness = makeHarness({ profile: false });
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const startup = await installDeepSeekHarnessBridge(installOptions(harness, cli, { operation: "startup-sync" }));
  assert.strictEqual(startup.status, "error");
  assert.strictEqual(startup.reason, "repair-required");
  assert.strictEqual(cli.calls.length, 0);
  const repaired = await installDeepSeekHarnessBridge(installOptions(harness, cli, { operation: "explicit-repair" }));
  assert.strictEqual(repaired.status, "ok");
  assert.strictEqual(repaired.updated, true);
});

test("unsupported DSH versions fail before pnpm or profile mutation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.3.0-alpha.1",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.3.0-alpha.1");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("npx-only hosts get an exact manual command and can later pass read-only verification", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const unavailable = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
  }));
  assert.strictEqual(unavailable.status, "error");
  assert.strictEqual(unavailable.reason, "cli-unavailable");
  assert.strictEqual(unavailable.manualGenerationReferenced, true);
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  const reference = readJson(referencePath);
  const generationDir = path.join(harness.managedRoot, "generations", reference.bundleHash);
  assert.match(unavailable.manualCommand, new RegExp(`@deepseek-ai/dsh@${SUPPORTED_DSH_VERSION.replace(/\./g, "\\.")}`));
  assert.match(unavailable.manualCommand, /DSH_HOME=/);
  assert.match(unavailable.manualCommand, /'add'/);
  assert.strictEqual(reference.bundleHash, path.basename(generationDir));
  assert.strictEqual(readJson(path.join(generationDir, "clawd-manifest.json")).installedDshVersionAssumedAtStaging, true);
  await dshInstallTest.cleanUnreferencedGenerations(null, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(fs.existsSync(generationDir), true);
  await cli.runDshCommand(["plugin", "--profile", "web", "add", generationDir]);

  const verified = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
  }));
  assert.strictEqual(verified.status, "ok");
  assert.strictEqual(verified.updated, false);
  assert.strictEqual(fs.existsSync(referencePath), false);
});

test("npx-only uninstall selects the exact contract recorded by each supported marker", async (t) => {
  for (const version of ["0.2.0-rc.2", "0.1.5-rc.3", "0.1.5-rc.1", "0.1.1-rc.2", "0.1.0-rc.6"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: version }));

    const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
      commandInfo: null,
      dshCommand: false,
      dshVersion: undefined,
    }));

    assert.strictEqual(result.status, "error", version);
    assert.strictEqual(result.reason, "cli-unavailable", version);
    assert.match(result.manualCommand, new RegExp(`@deepseek-ai/dsh@${version.replace(/\./g, "\\.")}`), version);
    assert.match(result.manualCommand, /'remove'/, version);
    assert.strictEqual(
      (await inspectDeepSeekHarnessIntegration({
        dshHome: harness.dshHome,
        managedRoot: harness.managedRoot,
        resolveCommandForInspection: false,
      })).status,
      "healthy",
      version,
    );
  }
});

test("an rc.6 marker stays in the 0.1 family and keeps pinning 0.1.0-rc.6 when npx-only Repair stages newer bridge bytes", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const updatedSource = path.join(harness.root, "updated-rc6-source");
  fs.cpSync(SOURCE_DIR, updatedSource, { recursive: true });
  fs.appendFileSync(path.join(updatedSource, "lib", "index.js"), "\n// updated rc.6 bridge source\n", "utf8");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.0-rc.6" }));

  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
    operation: "explicit-repair",
    sourceDir: updatedSource,
  }));

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "cli-unavailable");
  assert.strictEqual(result.manualGenerationReferenced, true);
  assert.match(result.manualCommand, /@deepseek-ai\/dsh@0\.1\.0-rc\.6/);
  const reference = readJson(dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot }));
  const marker = readJson(path.join(harness.managedRoot, "generations", reference.bundleHash, "clawd-manifest.json"));
  assert.strictEqual(marker.installedDshVersion, "0.1.0-rc.6");
  assert.strictEqual(marker.supportedDshRange, FAMILY_01_RANGE);
});

test("explicit uninstall removes an unclaimed manual npx generation reference", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const options = installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
  });
  const unavailable = await installDeepSeekHarnessBridge(options);
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  const generationDir = path.join(harness.managedRoot, "generations", readJson(referencePath).bundleHash);
  assert.strictEqual(fs.existsSync(referencePath), true);
  assert.strictEqual(fs.existsSync(generationDir), true);

  const removed = await uninstallDeepSeekHarnessBridge(options);

  assert.strictEqual(removed.status, "skipped");
  assert.strictEqual(fs.existsSync(referencePath), false);
  assert.strictEqual(fs.existsSync(generationDir), false);
});

test("malformed or foreign manual generation anchors fail closed and retain every generation", async (t) => {
  for (const scenario of ["truncated", "foreign"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const options = installOptions(harness, cli, {
      commandInfo: null,
      dshCommand: false,
    });
    const unavailable = await installDeepSeekHarnessBridge(options);
    const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
    const generationDir = path.join(harness.managedRoot, "generations", readJson(referencePath).bundleHash);
    if (scenario === "truncated") {
      fs.writeFileSync(referencePath, "{", "utf8");
    } else {
      const foreign = readJson(referencePath);
      foreign.owner = "foreign-owner";
      foreign.schemaVersion = 999;
      writeJson(referencePath, foreign);
    }

    await dshInstallTest.cleanUnreferencedGenerations(null, {
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
    });
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
    assert.strictEqual(fs.existsSync(referencePath), true, scenario);

    const installResult = await installDeepSeekHarnessBridge(options);
    assert.strictEqual(installResult.status, "error", scenario);
    assert.strictEqual(installResult.reason, "manual-generation-reference-invalid", scenario);
    assert.strictEqual(installResult.referencePath, referencePath, scenario);
    assert.strictEqual(installResult.manualInspectionRequired, true, scenario);

    const uninstallResult = await uninstallDeepSeekHarnessBridge(options);
    assert.strictEqual(uninstallResult.status, "ok", scenario);
    assert.strictEqual(uninstallResult.registrationRemoved, true, scenario);
    assert.ok(uninstallResult.warnings.some((line) => line.includes(referencePath)), scenario);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
    assert.strictEqual(fs.existsSync(referencePath), true, scenario);
  }
});

test("manual generation cleanup preserves an anchor swapped before or during its atomic move", async (t) => {
  for (const scenario of ["before-move", "after-move"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const options = installOptions(harness, cli, { commandInfo: null, dshCommand: false });
    await installDeepSeekHarnessBridge(options);
    const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
    const original = readJson(referencePath);
    const generationDir = path.join(harness.managedRoot, "generations", original.bundleHash);
    const replacement = {
      ...original,
      bundleHash: "f".repeat(64),
      createdAt: "2026-08-14T12:34:56.000Z",
    };
    const hooks = scenario === "before-move"
      ? {
          beforeClearMove() {
            writeJson(referencePath, replacement);
          },
        }
      : {
          afterClearMove() {
            writeJson(referencePath, replacement);
          },
        };
    const result = await uninstallDeepSeekHarnessBridge({
      ...options,
      __testManualGenerationReferenceHooks: hooks,
    });
    assert.strictEqual(result.status, "ok", scenario);
    assert.strictEqual(result.registrationRemoved, true, scenario);
    assert.ok(result.warnings.some((line) => line.includes(referencePath)), scenario);
    assert.strictEqual(readJson(referencePath).bundleHash, replacement.bundleHash, scenario);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
  }
});

test("manual reference clearing residues remain a persistent inspection fence", async (t) => {
  for (const scenario of ["restore-link-failure", "isolated-unlink-failure"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const options = installOptions(harness, cli, { commandInfo: null, dshCommand: false });
    await installDeepSeekHarnessBridge(options);
    const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
    const original = readJson(referencePath);
    const generationDir = path.join(harness.managedRoot, "generations", original.bundleHash);
    const hooks = scenario === "restore-link-failure"
      ? {
          beforeClearMove() {
            writeJson(referencePath, {
              ...original,
              bundleHash: "e".repeat(64),
              createdAt: "2026-08-14T12:34:56.000Z",
            });
          },
          beforeRestore() {
            fs.writeFileSync(referencePath, "blocking concurrent anchor", "utf8");
          },
        }
      : {
          beforeIsolatedUnlink() {
            const err = new Error("simulated unlink denial");
            err.code = "EPERM";
            throw err;
          },
        };
    const first = await uninstallDeepSeekHarnessBridge({
      ...options,
      __testManualGenerationReferenceHooks: hooks,
    });
    assert.strictEqual(first.status, "ok", scenario);
    assert.strictEqual(first.registrationRemoved, true, scenario);
    assert.ok(first.warnings.some((line) => line.includes("manual generation reference is invalid")), scenario);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
    const residue = fs.readdirSync(path.dirname(referencePath))
      .find((name) => name.startsWith(`${path.basename(referencePath)}.clearing-`));
    assert.ok(residue, scenario);
    if (scenario === "restore-link-failure") fs.unlinkSync(referencePath);

    const second = await uninstallDeepSeekHarnessBridge(options);
    assert.strictEqual(second.status, "ok", scenario);
    assert.strictEqual(second.registrationRemoved, true, scenario);
    assert.ok(second.warnings.some((line) => line.includes(".clearing-")), scenario);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
  }
});

test("an unreadable manual-reference directory is never treated as an empty residue scan", async (t) => {
  for (const code of ["EACCES", "EIO"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const options = installOptions(harness, cli, { commandInfo: null, dshCommand: false });
    await installDeepSeekHarnessBridge(options);
    const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
    const reference = readJson(referencePath);
    const generationDir = path.join(harness.managedRoot, "generations", reference.bundleHash);
    fs.renameSync(referencePath, `${referencePath}.clearing-stranded`);
    const result = await uninstallDeepSeekHarnessBridge({
      ...options,
      __testManualGenerationReferenceHooks: {
        readdirResidues() {
          const err = new Error("simulated residue scan failure");
          err.code = code;
          throw err;
        },
      },
    });
    assert.strictEqual(result.status, "ok", code);
    assert.strictEqual(result.registrationRemoved, true, code);
    assert.ok(result.warnings.some((line) => line.includes(resolveManagedRoot({ managedRoot: harness.managedRoot }))), code);
    assert.strictEqual(fs.existsSync(generationDir), true, code);
  }
});

test("manual add and remove commands pin and shell-quote the canonical target DSH_HOME", () => {
  const windowsHome = "D:\\alternate O'Brien\\.dsh";
  const windowsAdd = dshInstallTest.buildManualDshCommand([
    "npx", `@deepseek-ai/dsh@${SUPPORTED_DSH_VERSION}`, "plugin", "--profile", "web", "add", "D:\\managed O'Brien\\generation",
  ], { platform: "win32", dshHome: windowsHome });
  assert.match(windowsAdd, /^\$env:DSH_HOME='D:\\alternate O''Brien\\\.dsh'; & 'npx' /);
  assert.match(windowsAdd, /'add' 'D:\\managed O''Brien\\generation'$/);

  const posixHome = "/srv/alternate O'Brien/.dsh";
  const posixRemove = dshInstallTest.buildManualDshCommand([
    "npx", `@deepseek-ai/dsh@${SUPPORTED_DSH_VERSION}`, "plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME,
  ], { platform: "linux", dshHome: posixHome });
  assert.match(posixRemove, /^DSH_HOME='\/srv\/alternate O'\\''Brien\/\.dsh' 'npx' /);
  assert.match(posixRemove, /'remove' '@dsh-external\/dsh-clawd-bridge'$/);
});

test("a DSH_HOME alias is frozen to one real target for namespace, CLI env, and manual commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-home-alias-"));
  const targetA = path.join(root, "target-a");
  const targetB = path.join(root, "target-b");
  const alias = path.join(root, "current-dsh");
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.symlinkSync(targetA, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalA = canonicalRealpath(targetA);
  const frozen = dshInstallTest.resolveCanonicalDshHome({ dshHome: alias });
  assert.strictEqual(frozen, canonicalA);
  const managedRoot = resolveManagedRoot({ dshHome: alias, homeDir: root });
  const hashInput = (process.platform === "win32" ? canonicalA.toLowerCase() : canonicalA).replace(/\\/g, "/");
  const expectedNamespace = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex");
  assert.strictEqual(path.basename(managedRoot), expectedNamespace);
  const manual = dshInstallTest.buildManualDshCommand(["npx", "pkg"], {
    dshHome: alias,
    canonicalDshHome: frozen,
  });

  fs.unlinkSync(alias);
  fs.symlinkSync(targetB, alias, process.platform === "win32" ? "junction" : "dir");
  assert.match(manual, new RegExp(canonicalA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(manual, new RegExp(targetB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  let observedDshHome;
  const cli = makeOfficialCli(harness);
  await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshHome: harness.dshHome,
    runDshCommand: async (args, operationOptions) => {
      observedDshHome = operationOptions.env.DSH_HOME;
      return cli.runDshCommand(args);
    },
  }));
  assert.strictEqual(observedDshHome, canonicalRealpath(harness.dshHome));
});

test("an absent DSH_HOME beneath a symlink keeps one canonical namespace through first install", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-absent-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realParent = path.join(root, "real-parent");
  const alias = path.join(root, "alias");
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, alias, process.platform === "win32" ? "junction" : "dir");
  const dshHome = path.join(alias, "new-dsh-home");
  const canonicalDshHome = path.join(canonicalRealpath(realParent), "new-dsh-home");
  const harness = {
    root,
    dshHome,
    profileDir: path.join(dshHome, "profiles", "web"),
    managedRoot: undefined,
  };
  const cli = makeOfficialCli(harness);
  const options = installOptions(harness, cli, {
    homeDir: root,
    runDshCommand: async (args, operationOptions) => {
      assert.strictEqual(operationOptions.env.DSH_HOME, canonicalDshHome);
      return cli.runDshCommand(args);
    },
  });

  assert.strictEqual(fs.existsSync(dshHome), false);
  assert.strictEqual(dshInstallTest.resolveCanonicalDshHome(options), canonicalDshHome);
  const managedRootBefore = resolveManagedRoot(options);
  const hashInput = (process.platform === "win32" ? canonicalDshHome.toLowerCase() : canonicalDshHome)
    .replace(/\\/g, "/");
  const expectedNamespace = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex");
  assert.strictEqual(path.basename(managedRootBefore), expectedNamespace);

  const result = await installDeepSeekHarnessBridge(options);
  assert.strictEqual(result.status, "ok", JSON.stringify(result));
  assert.strictEqual(result.health.status, "healthy");
  assert.strictEqual(result.health.managedRoot, managedRootBefore);
  assert.strictEqual(resolveManagedRoot(options), managedRootBefore);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync(options).status, "healthy");

  const removed = await uninstallDeepSeekHarnessBridge(options);
  assert.strictEqual(removed.status, "ok", JSON.stringify(removed));
  assert.strictEqual(inspectDeepSeekHarnessDiskSync(options).status, "absent");
});

test("a managed-root alias remains owned after package inspection resolves its real path", async (t) => {
  const harness = makeHarness();
  const managedTarget = path.join(harness.root, "managed-target");
  const managedAlias = path.join(harness.root, "managed-alias");
  fs.mkdirSync(managedTarget, { recursive: true });
  fs.symlinkSync(managedTarget, managedAlias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const cli = makeOfficialCli(harness, { materializeAsLink: true });
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    managedRoot: path.join(managedAlias, "deepseek-harness"),
  }));

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.health.status, "healthy");
  assert.strictEqual(result.health.owned, true);
  assert.strictEqual(
    result.health.managedRoot,
    path.join(canonicalRealpath(managedTarget), "deepseek-harness"),
  );
});

test("a generation symlink that escapes the canonical managed root is never claimed as owned", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(installed.status, "ok");
  const generationDir = cli.installedGenerationDir;
  const escapedDir = path.join(harness.root, "escaped-generation");
  fs.renameSync(generationDir, escapedDir);
  fs.symlinkSync(escapedDir, generationDir, process.platform === "win32" ? "junction" : "dir");

  const health = inspectDeepSeekHarnessDiskSync(installOptions(harness, cli));
  assert.strictEqual(health.owned, false);
  assert.strictEqual(health.status, "profile-entry-foreign-or-conflicting");
});

test("failed add returns an error and removes an unreferenced staged generation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { throwError: "dsh not on PATH" });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /dsh not on PATH/);
  const generations = path.join(harness.managedRoot, "generations");
  assert.deepStrictEqual(fs.existsSync(generations) ? fs.readdirSync(generations) : [], []);
});

test("failed upgrade discards only the new unreferenced generation, not the old active one", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const alternateSource = path.join(harness.root, "alternate-source-for-discard");
  fs.cpSync(SOURCE_DIR, alternateSource, { recursive: true });
  fs.appendFileSync(path.join(alternateSource, "lib", "index.js"), "\n// discard candidate\n", "utf8");
  const bundle = await dshInstallTest.readSourceBundle({ sourceDir: alternateSource });
  const candidate = await dshInstallTest.promoteGeneration(bundle, {
    managedRoot: harness.managedRoot,
    dshVersion: SUPPORTED_DSH_VERSION,
    clawdVersion: "1.2.4",
  });
  const oldHealth = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(oldHealth.dependencyPresent, true);

  await dshInstallTest.discardCreatedGenerationIfUnreferenced(candidate, oldHealth, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });

  assert.strictEqual(fs.existsSync(candidate.generationDir), false);
  assert.strictEqual(fs.existsSync(installed.generation), true);
});

test("a successful CLI exit without a resolvable owned package fails verification", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { noMutation: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.healthReason, "absent");
});

test("a foreign same-name package is never overwritten or removed", async (t) => {
  const harness = makeHarness();
  const manifestPath = path.join(harness.profileDir, "package.json");
  const manifest = readJson(manifestPath);
  manifest.dependencies[BRIDGE_PACKAGE_NAME] = "file:C:/user/fork";
  manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
  writeJson(manifestPath, manifest);
  writeJson(path.join(packageDir(harness.profileDir), "package.json"), { name: BRIDGE_PACKAGE_NAME, version: "99.0.0-user" });
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const install = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const remove = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(install.reason, "profile-entry-foreign-or-conflicting");
  assert.strictEqual(remove.reason, "ownership-not-proven");
  assert.strictEqual(cli.calls.length, 0);
  assert.strictEqual(readJson(path.join(packageDir(harness.profileDir), "package.json")).version, "99.0.0-user");
});

test("installation-anchor shadowing wins over a healthy profile package and fails closed", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const installRoot = path.join(harness.root, "dsh-install");
  writeJson(path.join(installRoot, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"), "package.json"), {
    name: BRIDGE_PACKAGE_NAME,
    version: "foreign-shadow",
  });
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    commandInfo: { installRoot },
  });
  assert.strictEqual(health.status, "profile-entry-foreign-or-conflicting");
  assert.strictEqual(health.resolved.anchor, "installation");
});

test("sync disk inspection discovers installation-first shadowing from the real PATH shim", {
  skip: process.platform !== "win32",
}, async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));

  const binDir = path.join(harness.root, "global-bin");
  const dshRoot = path.join(binDir, "node_modules", "@deepseek-ai", "dsh");
  const binJs = path.join(dshRoot, "lib", "bin.js");
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.writeFileSync(binJs, "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(binDir, "dsh.cmd"),
    '@echo off\r\n"node" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
    "utf8",
  );
  writeJson(path.join(dshRoot, "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"), "package.json"), {
    name: BRIDGE_PACKAGE_NAME,
    version: "foreign-shadow",
  });

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    env: { PATH: binDir },
    platform: "win32",
  });
  assert.strictEqual(health.status, "profile-entry-foreign-or-conflicting");
  assert.strictEqual(health.resolved.anchor, "installation");
});

test("sync disk inspection compares the installed DSH package version", {
  skip: process.platform !== "win32",
}, async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));

  const binDir = path.join(harness.root, "versioned-bin");
  const dshRoot = path.join(binDir, "node_modules", "@deepseek-ai", "dsh");
  const binJs = path.join(dshRoot, "lib", "bin.js");
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.writeFileSync(binJs, "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(binDir, "dsh.cmd"),
    '@echo off\r\n"node" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
    "utf8",
  );
  writeJson(path.join(dshRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.3.0-alpha.1",
  });

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    env: { PATH: binDir },
    platform: "win32",
  });
  assert.strictEqual(health.status, "host-version-unsupported");
  assert.strictEqual(health.detectedDshVersion, "0.3.0-alpha.1");
});

test("the official profiles/node_modules fallback participates in health resolution", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const profilePlugin = packageDir(harness.profileDir);
  const fallbackPlugin = path.join(harness.dshHome, "profiles", "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  fs.mkdirSync(path.dirname(fallbackPlugin), { recursive: true });
  fs.cpSync(profilePlugin, fallbackPlugin, { recursive: true });
  fs.rmSync(profilePlugin, { recursive: true, force: true });

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.resolved.anchor, "profiles-fallback");
});

test("a healthy profile-local winner ignores a foreign lower-priority profiles fallback", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const fallbackPlugin = path.join(harness.dshHome, "profiles", "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  writeJson(path.join(fallbackPlugin, "package.json"), {
    name: BRIDGE_PACKAGE_NAME,
    version: "99.0.0-foreign",
  });

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.resolved.anchor, "profile");
});

test("a managed-looking flat fallback cannot claim ownership or trigger Repair", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const fallbackPlugin = path.join(harness.dshHome, "profiles", "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  fs.mkdirSync(path.dirname(fallbackPlugin), { recursive: true });
  fs.cpSync(packageDir(harness.profileDir), fallbackPlugin, { recursive: true });
  const manifestPath = path.join(harness.profileDir, "package.json");
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
  writeJson(manifestPath, manifest);
  fs.rmSync(packageDir(harness.profileDir), { recursive: true, force: true });
  const beforeCalls = cli.calls.length;

  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    operation: "explicit-repair",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "profile-entry-foreign-or-conflicting");
  assert.strictEqual(cli.calls.length, beforeCalls);
});

test("generation cleanup ignores flat fallback copies and links", async (t) => {
  for (const materialization of ["copy", "link"]) {
    const harness = makeHarness();
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const bundle = await dshInstallTest.readSourceBundle({ sourceDir: SOURCE_DIR });
    const generation = await dshInstallTest.promoteGeneration(bundle, {
      managedRoot: harness.managedRoot,
      dshVersion: SUPPORTED_DSH_VERSION,
      clawdVersion: "1.2.3",
    });
    const fallbackPlugin = path.join(harness.dshHome, "profiles", "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
    fs.mkdirSync(path.dirname(fallbackPlugin), { recursive: true });
    if (materialization === "copy") {
      fs.cpSync(generation.generationDir, fallbackPlugin, { recursive: true });
    } else {
      fs.symlinkSync(generation.generationDir, fallbackPlugin, process.platform === "win32" ? "junction" : "dir");
    }
    await dshInstallTest.cleanUnreferencedGenerations(null, {
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
    });
    assert.strictEqual(fs.existsSync(generation.generationDir), false, materialization);
  }
});

test("uninstall uses the official remove command and verifies the resolved package is gone", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const result = await unregisterDeepSeekHarness(installOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.skipped, false);
  assert.deepStrictEqual(cli.calls[1], ["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("uninstall models and unlinks the exact managed profile junction observed after real rc.6 pnpm remove", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(fs.lstatSync(packageDir(harness.profileDir)).isSymbolicLink(), true);

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.removed, true);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
  assert.strictEqual(fs.existsSync(installed.generation), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "absent");
});

test("explicit uninstall cleans an unreferenced generation after a complete manual official remove", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  await cli.runDshCommand(["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  const callsBeforeUninstall = cli.calls.length;
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "absent");
  assert.strictEqual(fs.existsSync(installed.generation), true);

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(cli.calls.length, callsBeforeUninstall);
  assert.strictEqual(fs.existsSync(installed.generation), false);
});

test("explicit uninstall recovers an exact managed junction left by a manual official remove", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  await cli.runDshCommand(["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  const callsBeforeUninstall = cli.calls.length;
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), false);

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(cli.calls.length, callsBeforeUninstall);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
});

test("npx-only uninstall cleans the exact managed junction left by a manual official remove", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.1.0-rc.6",
  }));
  await cli.runDshCommand(["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "managed-residue");

  let lockObservedDuringUnlink = false;
  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
    unlinkManagedProfileLink: async (isolatedPath) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "mutation.lock")), true);
      lockObservedDuringUnlink = true;
      await fs.promises.unlink(isolatedPath);
    },
  }));

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.removed, true);
  assert.strictEqual(lockObservedDuringUnlink, true);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "mutation.lock")), false);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
  assert.strictEqual(fs.existsSync(installed.generation), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "absent");
});

test("managed residue isolation preserves a foreign link swapped before unlink", async (t) => {
  const harness = makeHarness();
  const foreign = path.join(harness.root, "foreign-package");
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  await cli.runDshCommand(["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "sentinel.txt"), "foreign\n");

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    __testManagedProfileResidueHooks: {
      beforeIsolateMove: async ({ linkDir }) => {
        await fs.promises.unlink(linkDir);
        await fs.promises.symlink(foreign, linkDir, "dir");
      },
    },
  }));

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.cleanupReason, "residue-target-changed");
  assert.strictEqual(fs.realpathSync(packageDir(harness.profileDir)), fs.realpathSync(foreign));
  assert.strictEqual(fs.readFileSync(path.join(foreign, "sentinel.txt"), "utf8"), "foreign\n");
  assert.strictEqual(fs.existsSync(installed.generation), true);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
});

test("an interrupted managed residue isolation fences retries and preserves every generation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  await cli.runDshCommand(["plugin", "--profile", "web", "remove", BRIDGE_PACKAGE_NAME]);
  const canonicalLink = packageDir(harness.profileDir);
  const isolatedLink = `${canonicalLink}.clawd-removing-simulated-crash`;
  fs.renameSync(canonicalLink, isolatedLink);

  const asyncHealth = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(asyncHealth.status, "inspection-required");
  assert.strictEqual(asyncHealth.healthReason, "profile-removal-residue");
  assert.strictEqual(path.basename(asyncHealth.residuePath), path.basename(isolatedLink));
  assert.strictEqual(
    canonicalRealpath(path.dirname(asyncHealth.residuePath)),
    canonicalRealpath(path.dirname(isolatedLink)),
  );
  const syncHealth = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  });
  assert.strictEqual(syncHealth.status, "inspection-required");
  assert.strictEqual(syncHealth.healthReason, "profile-removal-residue");

  await dshInstallTest.cleanUnreferencedGenerations(null, {
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
  });
  assert.strictEqual(fs.existsSync(installed.generation), true);
  assert.strictEqual(fs.existsSync(isolatedLink), true);

  const noCliOptions = installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
  });
  const repair = await installDeepSeekHarnessBridge({
    ...noCliOptions,
    operation: "explicit-repair",
  });
  assert.strictEqual(repair.status, "error");
  assert.strictEqual(repair.reason, "inspection-required");
  assert.strictEqual(repair.healthReason, "profile-removal-residue");
  assert.strictEqual(fs.existsSync(installed.generation), true);

  const result = await uninstallDeepSeekHarnessBridge(noCliOptions);
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.healthReason, "profile-removal-residue");
  assert.strictEqual(path.basename(result.residuePath), path.basename(isolatedLink));
  assert.strictEqual(
    canonicalRealpath(path.dirname(result.residuePath)),
    canonicalRealpath(path.dirname(isolatedLink)),
  );
  assert.strictEqual(fs.existsSync(installed.generation), true);
  assert.strictEqual(fs.existsSync(isolatedLink), true);
});

test("explicit uninstall recovers exact residue after an unknown remove result", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const unknown = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    runDshCommand: async (args) => {
      await cli.runDshCommand(args);
      return { code: 1, timedOut: true, stderr: "remove outcome unknown" };
    },
  }));
  assert.strictEqual(unknown.status, "error");
  assert.strictEqual(unknown.reason, "inspection-required");
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
  const callsAfterUnknown = cli.calls.length;

  const recovered = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(recovered.status, "ok");
  assert.strictEqual(cli.calls.length, callsAfterUnknown);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), false);
});

test("uninstall never unlinks a managed-looking residue outside its DSH_HOME namespace", async (t) => {
  const harness = makeHarness();
  const foreign = path.join(harness.root, "foreign-generation");
  const cli = makeOfficialCli(harness, { materializeAsLink: true, retargetResidueTo: foreign });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  fs.cpSync(installed.generation, foreign, { recursive: true });

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "inspection-required");
  assert.strictEqual(result.cleanupReason, "residue-target-mismatch");
  assert.strictEqual(fs.lstatSync(packageDir(harness.profileDir)).isSymbolicLink(), true);
  assert.strictEqual(fs.existsSync(foreign), true);
});

test("a profile junction unlink failure latches inspection and a later explicit uninstall recovers", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness, { materializeAsLink: true, leaveResolvedResidue: true });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  let lockObservedDuringFailure = false;
  const first = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    unlinkManagedProfileLink: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "mutation.lock")), true);
      lockObservedDuringFailure = true;
      const err = new Error("busy junction");
      err.code = "EPERM";
      throw err;
    },
  }));
  assert.strictEqual(first.status, "error");
  assert.strictEqual(first.cleanupReason, "residue-unlink-failed");
  assert.strictEqual(lockObservedDuringFailure, true);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "mutation.lock")), false);
  assert.strictEqual(fs.lstatSync(packageDir(harness.profileDir)).isSymbolicLink(), true);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
  const callsAfterFirst = cli.calls.length;

  const recovered = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));

  assert.strictEqual(recovered.status, "ok");
  assert.strictEqual(cli.calls.length, callsAfterFirst);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), false);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), false);
});

test("uninstall refuses an unsupported live DSH version before any remove mutation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const beforeRemoveCalls = cli.calls.length;
  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.3.0-alpha.1",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.3.0-alpha.1");
  assert.strictEqual(result.supportedRange, supportedDshRangeLabel());
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.strictEqual(cli.calls.length, beforeRemoveCalls);
  assert.strictEqual(fs.existsSync(packageDir(harness.profileDir)), true);
});

test("uninstall succeeds when DSH leaves a lower-priority flat fallback behind", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const install = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const fallbackPlugin = path.join(harness.dshHome, "profiles", "node_modules", ...BRIDGE_PACKAGE_NAME.split("/"));
  fs.mkdirSync(path.dirname(fallbackPlugin), { recursive: true });
  fs.cpSync(packageDir(harness.profileDir), fallbackPlugin, { recursive: true });

  const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(fs.existsSync(fallbackPlugin), true);
  assert.strictEqual(fs.existsSync(install.generation), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "absent");
});

test("separate DSH_HOME values never share a deletable managed generation", async (t) => {
  const first = makeHarness();
  const second = makeHarness();
  const clawdHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-multi-home-owner-"));
  const firstCli = makeOfficialCli(first);
  const secondCli = makeOfficialCli(second);
  t.after(() => {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
    fs.rmSync(clawdHome, { recursive: true, force: true });
  });
  const firstOptions = installOptions(first, firstCli, {
    managedRoot: undefined,
    homeDir: clawdHome,
  });
  const secondOptions = installOptions(second, secondCli, {
    managedRoot: undefined,
    homeDir: clawdHome,
  });
  const firstInstall = await installDeepSeekHarnessBridge(firstOptions);
  const secondInstall = await installDeepSeekHarnessBridge(secondOptions);
  assert.strictEqual(firstInstall.status, "ok");
  assert.strictEqual(secondInstall.status, "ok");
  assert.notStrictEqual(path.dirname(path.dirname(firstInstall.generation)), path.dirname(path.dirname(secondInstall.generation)));
  assert.notStrictEqual(
    resolveManagedRoot({ homeDir: clawdHome, dshHome: first.dshHome }),
    resolveManagedRoot({ homeDir: clawdHome, dshHome: second.dshHome }),
  );

  const removed = await uninstallDeepSeekHarnessBridge(firstOptions);
  assert.strictEqual(removed.status, "ok");
  assert.strictEqual(fs.existsSync(firstInstall.generation), false);
  assert.strictEqual(fs.existsSync(secondInstall.generation), true);
  const secondHealth = await inspectDeepSeekHarnessIntegration({
    dshHome: second.dshHome,
    homeDir: clawdHome,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(secondHealth.status, "healthy");
  assert.strictEqual(secondHealth.marker.bundleHash, path.basename(secondInstall.generation));
});

test("uninstall failure and resolved-package residue are reported as errors", async (t) => {
  const first = makeHarness();
  const firstCli = makeOfficialCli(first);
  const second = makeHarness();
  const secondCli = makeOfficialCli(second);
  t.after(() => {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  });
  await installDeepSeekHarnessBridge(installOptions(first, firstCli));
  firstCli.runDshCommand = async () => ({ code: 1, stderr: "remove denied" });
  const failed = await uninstallDeepSeekHarnessBridge(installOptions(first, firstCli));
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(failed.reason, "plugin-remove-failed");
  assert.strictEqual(await isBridgeInstalled({
    dshHome: first.dshHome,
    managedRoot: first.managedRoot,
    resolveCommandForInspection: false,
  }), true);

  await installDeepSeekHarnessBridge(installOptions(second, secondCli));
  const residueCli = makeOfficialCli(second, { leaveResolvedResidue: true });
  const residue = await uninstallDeepSeekHarnessBridge(installOptions(second, residueCli));
  assert.strictEqual(residue.status, "error");
  assert.strictEqual(residue.reason, "inspection-required");
  assert.strictEqual(residue.healthReason, "managed-residue");
  assert.strictEqual(residue.cleanupReason, "residue-target-mismatch");
  assert.strictEqual(fs.existsSync(packageDir(second.profileDir)), true);
});

test("an already healthy bridge still gates the live DSH version before returning success", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.3.0-alpha.1",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(cli.calls.length, 1);
});

test("a partial foreign profile row is never treated as a repairable managed install", async (t) => {
  const harness = makeHarness();
  const manifestPath = path.join(harness.profileDir, "package.json");
  const manifest = readJson(manifestPath);
  manifest.dependencies[BRIDGE_PACKAGE_NAME] = "file:C:/user/partial-fork";
  writeJson(manifestPath, manifest);
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "profile-entry-foreign-or-conflicting");
  assert.deepStrictEqual(cli.calls, []);
});

test("a corrupt web profile is never rewritten by install or startup repair", async (t) => {
  const harness = makeHarness();
  const manifestPath = path.join(harness.profileDir, "package.json");
  fs.writeFileSync(manifestPath, "{ not-json", "utf8");
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    operation: "explicit-repair",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "profile-corrupt");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "profile-corrupt");
  assert.strictEqual(fs.readFileSync(manifestPath, "utf8"), "{ not-json");
});

test("tampered managed bytes fail closed before add or remove", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  fs.appendFileSync(path.join(packageDir(harness.profileDir), "lib", "index.js"), "\n// tampered\n", "utf8");
  const install = await installDeepSeekHarnessBridge(installOptions(harness, cli, { operation: "explicit-repair" }));
  const remove = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli));
  assert.strictEqual(install.reason, "generation-integrity-failed");
  assert.strictEqual(remove.reason, "ownership-not-proven");
  assert.strictEqual(cli.calls.length, 1);
});

test("unknown add results persist an inspection latch and startup never replays them", async (t) => {
  const harness = makeHarness();
  const unknownCalls = [];
  const unknown = {
    runDshCommand: async (args) => {
      unknownCalls.push(args);
      return { code: 1, timedOut: true, stderr: "timed out" };
    },
  };
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const first = await installDeepSeekHarnessBridge(installOptions(harness, unknown));
  assert.strictEqual(first.reason, "inspection-required");
  assert.strictEqual(unknownCalls.length, 1);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  }).status, "inspection-required");

  const good = makeOfficialCli(harness);
  const startup = await installDeepSeekHarnessBridge(installOptions(harness, good, { operation: "startup-sync" }));
  assert.strictEqual(startup.reason, "inspection-required");
  assert.deepStrictEqual(good.calls, []);

  const repaired = await installDeepSeekHarnessBridge(installOptions(harness, good, { operation: "explicit-repair" }));
  assert.strictEqual(repaired.status, "ok");
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), false);
});

test("a healthy or absent fast path cannot clear an inspection latch outside the mutation lock", async (t) => {
  const healthy = makeHarness();
  const healthyCli = makeOfficialCli(healthy);
  const absent = makeHarness();
  const absentCli = makeOfficialCli(absent);
  t.after(() => {
    fs.rmSync(healthy.root, { recursive: true, force: true });
    fs.rmSync(absent.root, { recursive: true, force: true });
  });
  await installDeepSeekHarnessBridge(installOptions(healthy, healthyCli));

  for (const harness of [healthy, absent]) {
    writeJson(path.join(harness.managedRoot, "inspection-required.json"), {
      owner: "clawd-on-desk",
      schemaVersion: 1,
      reason: "test-unknown-result",
      detail: "held for cross-process verification",
    });
    const lockDir = path.join(harness.managedRoot, "mutation.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    writeJson(path.join(lockDir, "owner.json"), {
      owner: "clawd-on-desk",
      token: `external-${path.basename(harness.root)}`,
      pid: 424242,
    });
  }

  const healthyCalls = healthyCli.calls.length;
  const healthyResult = await installDeepSeekHarnessBridge(installOptions(healthy, healthyCli, { operation: "explicit-repair" }));
  assert.strictEqual(healthyResult.status, "error");
  assert.strictEqual(healthyResult.reason, "unexpected-error");
  assert.match(healthyResult.message, /already locked/);
  assert.match(healthyResult.lockPath, /mutation\.lock/);
  assert.strictEqual(healthyCli.calls.length, healthyCalls);
  assert.strictEqual(fs.existsSync(path.join(healthy.managedRoot, "inspection-required.json")), true);

  const absentResult = await uninstallDeepSeekHarnessBridge(installOptions(absent, absentCli));
  assert.strictEqual(absentResult.status, "error");
  assert.ok(absentResult.warnings.some((line) => line.includes("already locked")));
  assert.deepStrictEqual(absentCli.calls, []);
  assert.strictEqual(fs.existsSync(path.join(absent.managedRoot, "inspection-required.json")), true);
});

test("the locked version probe runs before a healthy fast return or latch clear", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const alternateSource = path.join(harness.root, "locked-current-source");
  fs.cpSync(SOURCE_DIR, alternateSource, { recursive: true });
  fs.appendFileSync(path.join(alternateSource, "lib", "index.js"), "\n// locked current generation\n", "utf8");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));

  const alternateBundle = await dshInstallTest.readSourceBundle({ sourceDir: alternateSource });
  const alternateGeneration = await dshInstallTest.promoteGeneration(alternateBundle, {
    managedRoot: harness.managedRoot,
    dshVersion: SUPPORTED_DSH_VERSION,
    clawdVersion: "1.2.3",
  });
  writeJson(path.join(harness.managedRoot, "inspection-required.json"), {
    owner: "clawd-on-desk",
    schemaVersion: 1,
    reason: "test-version-race",
  });
  let probes = 0;
  const activateAlternateGeneration = () => {
    const manifestPath = path.join(harness.profileDir, "package.json");
    const manifest = readJson(manifestPath);
    manifest.dependencies[BRIDGE_PACKAGE_NAME] = `file:${alternateGeneration.generationDir}`;
    writeJson(manifestPath, manifest);
    const target = packageDir(harness.profileDir);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(alternateGeneration.generationDir, target, { recursive: true });
  };
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    sourceDir: alternateSource,
    operation: "explicit-repair",
    dshVersion: undefined,
    runCommand: async (_command, args) => {
      assert.deepStrictEqual(args, ["--version"]);
      probes += 1;
      if (probes === 1) activateAlternateGeneration();
      return { code: 0, stdout: probes === 1 ? SUPPORTED_DSH_VERSION : "0.3.0-alpha.1" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.3.0-alpha.1");
  assert.strictEqual(probes, 2);
  assert.strictEqual(cli.calls.length, 1);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
});

test("a supported host version change under the lock aborts before plugin mutation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  let probes = 0;

  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async (_command, args) => {
      assert.deepStrictEqual(args, ["--version"]);
      probes += 1;
      return { code: 0, stdout: probes === 1 ? "0.1.0-rc.6" : "0.1.1-rc.2" };
    },
  }));

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-changed");
  assert.strictEqual(result.expectedVersion, "0.1.0-rc.6");
  assert.strictEqual(result.detectedVersion, "0.1.1-rc.2");
  assert.strictEqual(probes, 2);
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("newer managed generations win and same-version hash conflicts require explicit repair", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const alternateSource = path.join(harness.root, "alternate-source");
  fs.cpSync(SOURCE_DIR, alternateSource, { recursive: true });
  fs.appendFileSync(path.join(alternateSource, "lib", "index.js"), "\n// alternate generation\n", "utf8");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { clawdVersion: "9.0.0" }));
  const older = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "8.0.0",
    sourceDir: alternateSource,
    operation: "explicit-repair",
  }));
  assert.strictEqual(older.status, "skipped");
  assert.strictEqual(older.reason, "newer-managed-generation");
  const sameVersion = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "9.0.0",
    sourceDir: alternateSource,
    operation: "startup-sync",
  }));
  assert.strictEqual(sameVersion.status, "error");
  assert.strictEqual(sameVersion.reason, "generation-conflict");
  assert.strictEqual(cli.calls.length, 1);
});

test("the version-family table admits every host in a verified minor", () => {
  assert.deepStrictEqual(
    VERIFIED_DSH_ARTIFACTS.map((entry) => entry.version),
    ["0.2.0-rc.2", "0.1.5-rc.3", "0.1.5-rc.1", "0.1.1-rc.2", "0.1.0-rc.6"],
  );
  assert.deepStrictEqual(
    DSH_VERSION_FAMILIES.map((family) => family.family),
    ["0.2", "0.1"],
  );
  assert.strictEqual(supportedDshRangeLabel(), ">=0.2.0-rc.2 <0.3.0-0 or >=0.1.0-rc.6 <0.2.0-0");
  for (let index = 0; index < VERIFIED_DSH_ARTIFACTS.length - 1; index += 1) {
    assert.strictEqual(
      dshInstallTest.compareDshVersions(
        VERIFIED_DSH_ARTIFACTS[index].version,
        VERIFIED_DSH_ARTIFACTS[index + 1].version,
      ),
      1,
      `${VERIFIED_DSH_ARTIFACTS[index].version} must be newer than ${VERIFIED_DSH_ARTIFACTS[index + 1].version}`,
    );
  }
  for (const entry of VERIFIED_DSH_ARTIFACTS) {
    assert.ok(
      dshInstallTest.dshFamilyForVersion(entry.version),
      `${entry.version} must belong to a family at or above its floor`,
    );
  }
  for (const family of DSH_VERSION_FAMILIES) {
    assert.ok(
      VERIFIED_DSH_ARTIFACTS.some((entry) => entry.version === family.minVersion),
      `${family.family} minVersion must be a verified artifact`,
    );
    const [major, minor] = family.family.split(".").map(Number);
    assert.strictEqual(
      family.range,
      `>=${family.minVersion} <${major}.${minor + 1}.0-0`,
      `${family.family} range must name its floor and the next minor exactly`,
    );
    assert.ok(
      dshInstallTest.dshFamilyForVersion(family.minVersion).family === family.family,
      `${family.family} minVersion must resolve to its own family`,
    );
  }
  const metadata = readJson(path.join(SOURCE_DIR, "package.json")).clawd;
  assert.deepStrictEqual(metadata.versionFamilies, DSH_VERSION_FAMILIES.map((family) => ({
    family: family.family,
    minVersion: family.minVersion,
    range: family.range,
  })));
  assert.deepStrictEqual(metadata.verifiedArtifacts, VERIFIED_DSH_ARTIFACTS.map((entry) => ({
    version: entry.version,
    artifact: entry.artifact,
    integrity: entry.integrity,
  })));
  assert.strictEqual(metadata.preferredFamilyRange, DSH_VERSION_FAMILIES[0].range);
  assert.strictEqual(metadata.latestVerifiedArtifact, VERIFIED_DSH_ARTIFACTS[0].artifact);
  assert.strictEqual(metadata.latestVerifiedArtifactIntegrity, VERIFIED_DSH_ARTIFACTS[0].integrity);
  assert.strictEqual(metadata.sourceAuditBaselineCommit, "47f943859bef60e4160492346772ded9b24f765a");
});

test("marker contracts accept both listed versions and reject unlisted or mismatched markers", () => {
  assert.strictEqual(dshContractForVersion("0.1.1-rc.2").supportedDshRange, "=0.1.1-rc.2");
  assert.strictEqual(dshContractForVersion("0.1.0-rc.6").verifiedDshArtifact, "@deepseek-ai/dsh@0.1.0-rc.6");
  assert.strictEqual(dshContractForVersion("0.1.0-rc.7"), null);
  assert.strictEqual(
    dshContractForMarker({ installedDshVersion: "0.1.0-rc.6", supportedDshRange: "=0.1.0-rc.6" }).version,
    "0.1.0-rc.6",
  );
  assert.strictEqual(
    dshContractForMarker({ installedDshVersion: "0.1.1-rc.2", supportedDshRange: "=0.1.0-rc.6" }),
    null,
  );
  assert.strictEqual(dshContractForMarker({ installedDshVersion: "0.1.0-rc.7", supportedDshRange: "=0.1.0-rc.7" }), null);
  assert.strictEqual(
    dshContractForMarker({ installedDshVersion: "0.2.1", supportedDshRange: FAMILY_02_RANGE }).supportedDshRange,
    FAMILY_02_RANGE,
  );
  assert.strictEqual(dshContractForMarker({ installedDshVersion: "0.3.0", supportedDshRange: FAMILY_02_RANGE }), null);
  assert.strictEqual(dshContractForMarker({ installedDshVersion: "0.2.0-rc.1", supportedDshRange: FAMILY_02_RANGE }), null);
  assert.strictEqual(dshContractForMarker(null), null);
});

test("rc.6 hosts install, repair, and uninstall under their own contract", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.0-rc.6" }));
  assert.strictEqual(installed.status, "ok");
  assert.strictEqual(installed.updated, true);
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.installedDshVersion, "0.1.0-rc.6");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_01_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.1.0-rc.6");
  assert.strictEqual(
    health.marker.verifiedDshArtifactIntegrity,
    "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==",
  );
  const repaired = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.1.0-rc.6",
    operation: "explicit-repair",
  }));
  assert.strictEqual(repaired.status, "ok");
  assert.strictEqual(repaired.updated, false);
  assert.strictEqual(cli.calls.length, 1);
  const removed = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.0-rc.6" }));
  assert.strictEqual(removed.status, "ok");
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("a default install records the preferred family and its newest artifact", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  // Assert the preference invariant, not a literal release: the default
  // install path must record the first family and its newest verified artifact.
  const preferredFamily = DSH_VERSION_FAMILIES[0];
  const newestArtifact = VERIFIED_DSH_ARTIFACTS[0];
  assert.strictEqual(health.marker.installedDshVersion, newestArtifact.version);
  assert.strictEqual(health.marker.supportedDshRange, preferredFamily.range);
  assert.strictEqual(health.marker.verifiedDshArtifact, newestArtifact.artifact);
});

test("an rc.1 host installs under its own contract and records it", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.5-rc.1" }));
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.installedDshVersion, "0.1.5-rc.1");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_01_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.1.5-rc.1");
  assert.strictEqual(
    health.marker.verifiedDshArtifactIntegrity,
    dshContractForVersion("0.1.5-rc.1").verifiedDshArtifactIntegrity,
  );
});

test("an rc.3 host installs under its own contract and records it", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.5-rc.3" }));
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.installedDshVersion, "0.1.5-rc.3");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_01_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.1.5-rc.3");
  assert.strictEqual(
    health.marker.verifiedDshArtifactIntegrity,
    "sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==",
  );
});

test("a 0.2.0-rc.2 host installs under its own contract and records it", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.0-rc.2" }));
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.installedDshVersion, "0.2.0-rc.2");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_02_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.2.0-rc.2");
  assert.strictEqual(
    health.marker.verifiedDshArtifactIntegrity,
    "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==",
  );
});

test("an rc.3 generation migrates to 0.2.0-rc.2 when the host is upgraded", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.5-rc.3" }));
  const rc3Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const rc3Hash = rc3Health.marker.bundleHash;
  const rc3GenerationDir = path.join(harness.managedRoot, "generations", rc3Hash);
  assert.strictEqual(fs.existsSync(rc3GenerationDir), true);
  const migrated = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.2.0-rc.2",
    operation: "explicit-repair",
  }));
  assert.strictEqual(migrated.status, "ok");
  assert.strictEqual(migrated.updated, true);
  assert.strictEqual(cli.calls.length, 2);
  const rc2Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(rc2Health.status, "healthy");
  assert.strictEqual(rc2Health.marker.installedDshVersion, "0.2.0-rc.2");
  assert.strictEqual(rc2Health.marker.supportedDshRange, FAMILY_02_RANGE);
  assert.notStrictEqual(rc2Health.marker.bundleHash, rc3Hash);
  assert.strictEqual(fs.existsSync(rc3GenerationDir), false);
  assert.strictEqual(
    fs.existsSync(path.join(harness.managedRoot, "generations", rc2Health.marker.bundleHash)),
    true,
  );
});

test("startup sync replaces an rc.3 generation staged by an older Clawd", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.3",
    dshVersion: "0.1.5-rc.3",
  }));
  const rc3Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const rc3Hash = rc3Health.marker.bundleHash;
  const rc3GenerationDir = path.join(harness.managedRoot, "generations", rc3Hash);
  assert.strictEqual(fs.existsSync(rc3GenerationDir), true);
  const migrated = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.4",
    dshVersion: "0.2.0-rc.2",
    operation: "startup-sync",
  }));
  assert.strictEqual(migrated.status, "ok");
  assert.strictEqual(migrated.updated, true);
  const rc2Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(rc2Health.status, "healthy");
  assert.strictEqual(rc2Health.marker.installedDshVersion, "0.2.0-rc.2");
  assert.strictEqual(rc2Health.marker.supportedDshRange, FAMILY_02_RANGE);
  assert.strictEqual(rc2Health.marker.sourceClawdVersion, "1.2.4");
  assert.notStrictEqual(rc2Health.marker.bundleHash, rc3Hash);
  assert.strictEqual(fs.existsSync(rc3GenerationDir), false);
  assert.strictEqual(
    fs.existsSync(path.join(harness.managedRoot, "generations", rc2Health.marker.bundleHash)),
    true,
  );
});

test("startup sync keeps the rc.3 generation when only DSH is upgraded", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.3",
    dshVersion: "0.1.5-rc.3",
  }));
  const rc3Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const rc3Hash = rc3Health.marker.bundleHash;
  const rc3GenerationDir = path.join(harness.managedRoot, "generations", rc3Hash);
  const profileManifestPath = path.join(harness.profileDir, "package.json");
  const profileManifestBefore = fs.readFileSync(profileManifestPath);
  const conflict = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.3",
    dshVersion: "0.2.0-rc.2",
    operation: "startup-sync",
  }));
  assert.strictEqual(conflict.status, "error");
  assert.strictEqual(conflict.reason, "generation-conflict");
  const unchanged = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(unchanged.marker.installedDshVersion, "0.1.5-rc.3");
  assert.strictEqual(unchanged.marker.bundleHash, rc3Hash);
  assert.strictEqual(fs.existsSync(rc3GenerationDir), true);
  assert.strictEqual(cli.calls.length, 1);
  assert.deepStrictEqual(fs.readFileSync(profileManifestPath), profileManifestBefore);
});

test("an rc.6 generation is reused when the host moves within the 0.1 family", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.0-rc.6" }));
  const rc6Health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const rc6Hash = rc6Health.marker.bundleHash;
  const profileManifestPath = path.join(harness.profileDir, "package.json");
  const profileManifestBefore = fs.readFileSync(profileManifestPath);
  const reused = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: "0.1.1-rc.2",
    operation: "explicit-repair",
  }));
  assert.strictEqual(reused.status, "ok");
  assert.strictEqual(reused.updated, false);
  assert.strictEqual(cli.calls.length, 1);
  const after = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(after.status, "healthy");
  assert.strictEqual(after.marker.installedDshVersion, "0.1.0-rc.6");
  assert.strictEqual(after.marker.bundleHash, rc6Hash);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "generations", rc6Hash)), true);
  assert.deepStrictEqual(fs.readFileSync(profileManifestPath), profileManifestBefore);
});

test("a marker staged for an unlisted DSH version reports version-unsupported", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli));
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const manifestPath = path.join(harness.managedRoot, "generations", health.marker.bundleHash, "clawd-manifest.json");
  const profileManifestPath = path.join(packageDir(harness.profileDir), "clawd-manifest.json");
  for (const target of [manifestPath, profileManifestPath]) {
    const manifest = readJson(target);
    manifest.installedDshVersion = "0.1.0-rc.7";
    manifest.supportedDshRange = "=0.1.0-rc.7";
    writeJson(target, manifest);
  }
  const tampered = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(tampered.status, "version-unsupported");

  const noCliOptions = installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
  });
  const repair = await installDeepSeekHarnessBridge({ ...noCliOptions, operation: "explicit-repair" });
  assert.strictEqual(repair.status, "error");
  assert.strictEqual(repair.reason, "version-unsupported");
  assert.strictEqual(repair.detectedVersion, "0.1.0-rc.7");
  assert.strictEqual(repair.manualCommand, undefined);
  const removed = await uninstallDeepSeekHarnessBridge(noCliOptions);
  assert.strictEqual(removed.status, "error");
  assert.strictEqual(removed.reason, "version-unsupported");
  assert.strictEqual(removed.detectedVersion, "0.1.0-rc.7");
  assert.strictEqual(removed.manualCommand, undefined);
  assert.strictEqual(
    fs.existsSync(dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot })),
    false,
  );
});

test("install rejects a malformed host token or a version below its family floor", async (t) => {
  const invalidTokens = [
    "0.2.0-", "0.2.0+", "0.2.0+build", "0.2.0-rc.2.", "00.2.0", "0.2.0-rc..1", "0.2.0-01",
    "0.2.01", "0.2.0-rc.02",
  ];
  for (const raw of [...invalidTokens, "0.2.0-beta.9"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
      dshVersion: raw,
    }));
    assert.strictEqual(result.status, "error", raw);
    assert.strictEqual(result.reason, invalidTokens.includes(raw) ? "version-invalid" : "version-unsupported", raw);
    assert.deepStrictEqual(cli.calls, [], raw);
    assert.strictEqual(inspectDeepSeekHarnessDiskSync({
      dshHome: harness.dshHome,
      dshInstallRoot: null,
    }).status, "absent", raw);
  }
});

test("install accepts a strict host version surrounded by allowed output noise", async (t) => {
  for (const raw of ["0.2.0-rc.2\n", "  0.2.0-rc.2  ", "dsh 0.2.0-rc.2"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
      dshVersion: raw,
    }));
    assert.strictEqual(result.status, "ok", raw);
    assert.strictEqual(result.updated, true, raw);
  }
});

test("install reads a strict host version even when stderr carries a Node warning", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async (_command, args) => {
      assert.deepStrictEqual(args, ["--version"]);
      return { code: 0, stdout: "0.2.0-rc.2\n", stderr: "(node:1) Warning: experimental loader\n" };
    },
  }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
});

test("install ignores a single-word noise line that does not start with a digit", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async () => ({ code: 0, stdout: "0.2.0-rc.2\n", stderr: "Warning\n" }),
  }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
});

test("install treats several candidate version lines as an unknown host version", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async () => ({ code: 0, stdout: "0.2.0-rc.2\n0.2.1\n" }),
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-invalid");
  assert.deepStrictEqual(cli.calls, []);
});

test("DSH versions compare by SemVer precedence without losing integer precision", () => {
  const ordered = [
    "0.2.0-rc.2",
    "0.2.0-rc.10",
    "0.2.0",
    "0.2.1-alpha.1",
    "0.2.1",
  ];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    assert.strictEqual(
      dshInstallTest.compareDshVersions(ordered[index], ordered[index + 1]),
      -1,
      `${ordered[index]} < ${ordered[index + 1]}`,
    );
    assert.strictEqual(
      dshInstallTest.compareDshVersions(ordered[index + 1], ordered[index]),
      1,
      `${ordered[index + 1]} > ${ordered[index]}`,
    );
  }
  assert.strictEqual(
    dshInstallTest.compareDshVersions("0.2.0-rc.9007199254740993", "0.2.0-rc.9007199254740992"),
    1,
  );
  assert.strictEqual(dshInstallTest.compareDshVersions("0.2.0-1", "0.2.0-alpha"), -1);
  assert.strictEqual(dshInstallTest.compareDshVersions("0.2.0-rc", "0.2.0-rc.1"), -1);
  assert.strictEqual(dshInstallTest.compareDshVersions("0.2.0-alpha.1", "0.2.0-beta.1"), -1);
  assert.strictEqual(dshInstallTest.compareDshVersions("0.2.0-beta.1", "0.2.0-rc.1"), -1);
});

test("strict DSH parsing rejects leading zeros, empty identifiers, and build metadata", () => {
  for (const token of [
    "00.2.0", "0.02.0", "0.2.00", "0.2.0-01", "0.2.0-rc.01",
    "0.2.0-", "0.2.0-rc..1", "0.2.0-rc.2.", "0.2.0+", "0.2.0+build",
  ]) {
    assert.strictEqual(dshInstallTest.parseStrictDshVersion(token), null, token);
  }
  assert.deepStrictEqual(
    dshInstallTest.parseStrictDshVersion("0.2.0-rc.2"),
    { major: "0", minor: "2", patch: "0", prerelease: ["rc", "2"] },
  );
});

test("DSH family admission follows the verified minor and its floor", () => {
  assert.strictEqual(isSupportedDshVersion("0.2.0-rc.2"), true);
  assert.strictEqual(isSupportedDshVersion("0.2.0-rc.10"), true);
  assert.strictEqual(isSupportedDshVersion("0.2.1"), true);
  assert.strictEqual(isSupportedDshVersion("0.1.0-rc.7"), true);
  assert.strictEqual(isSupportedDshVersion("0.2.0-rc.1"), false);
  assert.strictEqual(isSupportedDshVersion("0.2.0-beta.9"), false);
  assert.strictEqual(isSupportedDshVersion("0.1.0-rc.5"), false);
  assert.strictEqual(isSupportedDshVersion("0.3.0-alpha.1"), false);
  assert.strictEqual(isSupportedDshVersion("0.0.5"), false);
  assert.strictEqual(dshInstallTest.dshFamilyForVersion("0.2.1").range, FAMILY_02_RANGE);
  assert.strictEqual(dshInstallTest.dshFamilyForVersion("0.3.0-alpha.1"), null);
});

test("each historical exact marker is verified against its original range", async (t) => {
  for (const version of ["0.2.0-rc.2", "0.1.5-rc.3", "0.1.5-rc.1", "0.1.1-rc.2", "0.1.0-rc.6"]) {
    const harness = makeHarness();
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const { contract } = writeHistoricalGeneration(harness, version);
    assert.strictEqual(contract.supportedDshRange, `=${version}`);
    const syncHealth = inspectDeepSeekHarnessDiskSync({
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
      dshInstallRoot: null,
    });
    assert.strictEqual(syncHealth.status, "healthy", version);
    const asyncHealth = await inspectDeepSeekHarnessIntegration({
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
      resolveCommandForInspection: false,
    });
    assert.strictEqual(asyncHealth.status, "healthy", version);
    assert.strictEqual(asyncHealth.marker.supportedDshRange, `=${version}`, version);
  }
});

test("a higher Clawd version migrates a historical exact generation to its family", async (t) => {
  for (const version of ["0.2.0-rc.2", "0.1.5-rc.3", "0.1.5-rc.1", "0.1.1-rc.2", "0.1.0-rc.6"]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const { generationDir } = writeHistoricalGeneration(harness, version);
    const migrated = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
      clawdVersion: "1.2.4",
      dshVersion: version,
      operation: "startup-sync",
    }));
    assert.strictEqual(migrated.status, "ok", version);
    assert.strictEqual(migrated.updated, true, version);
    const health = await inspectDeepSeekHarnessIntegration({
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
      resolveCommandForInspection: false,
    });
    const family = dshInstallTest.dshFamilyForVersion(version);
    assert.strictEqual(health.marker.supportedDshRange, family.range, version);
    assert.strictEqual(health.marker.installedDshVersion, version, version);
    assert.strictEqual(health.marker.verifiedDshArtifact, `@deepseek-ai/dsh@${version}`, version);
    assert.strictEqual(fs.existsSync(generationDir), false, version);
  }
});

test("historical markers follow the Clawd version rules when the host stays in the family", async (t) => {
  const scenarios = [
    { markerClawd: "1.2.3", runClawd: "1.2.3", outcome: "generation-conflict" },
    { markerClawd: "1.2.4", runClawd: "1.2.3", outcome: "newer-managed-generation" },
  ];
  for (const scenario of scenarios) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const { bundleHash, generationDir } = writeHistoricalGeneration(harness, "0.2.0-rc.2", scenario.markerClawd);
    const profileManifestPath = path.join(harness.profileDir, "package.json");
    const profileManifestBefore = fs.readFileSync(profileManifestPath);
    const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
      clawdVersion: scenario.runClawd,
      dshVersion: "0.2.1",
      operation: "startup-sync",
    }));
    assert.strictEqual(result.reason, scenario.outcome, scenario.runClawd);
    assert.deepStrictEqual(cli.calls, [], scenario.runClawd);
    const health = await inspectDeepSeekHarnessIntegration({
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
      resolveCommandForInspection: false,
    });
    assert.strictEqual(health.marker.supportedDshRange, "=0.2.0-rc.2", scenario.runClawd);
    assert.strictEqual(health.marker.bundleHash, bundleHash, scenario.runClawd);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario.runClawd);
    assert.deepStrictEqual(fs.readFileSync(profileManifestPath), profileManifestBefore, scenario.runClawd);
  }
});

test("a higher Clawd version replaces a historical marker through startup sync", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const { generationDir } = writeHistoricalGeneration(harness, "0.2.0-rc.2", "1.2.3");
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.4",
    dshVersion: "0.2.1",
    operation: "startup-sync",
  }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_02_RANGE);
  assert.strictEqual(health.marker.installedDshVersion, "0.2.1");
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.2.0-rc.2");
  assert.strictEqual(fs.existsSync(generationDir), false);
});

test("tampered historical bridge bytes fail integrity before migration", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeHistoricalGeneration(harness, "0.2.0-rc.2");
  fs.appendFileSync(path.join(packageDir(harness.profileDir), "lib", "index.js"), "\n// tampered\n", "utf8");
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    clawdVersion: "1.2.4",
    dshVersion: "0.2.1",
    operation: "explicit-repair",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "generation-integrity-failed");
  assert.deepStrictEqual(cli.calls, []);
});

test("family markers whose installed version left the family are unlisted", async (t) => {
  for (const installedVersion of ["0.3.0", "0.2.0-rc.1"]) {
    const harness = makeHarness();
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    writeFamilyGeneration(harness, DSH_VERSION_FAMILIES[0], installedVersion);
    const health = await inspectDeepSeekHarnessIntegration({
      dshHome: harness.dshHome,
      managedRoot: harness.managedRoot,
      resolveCommandForInspection: false,
    });
    assert.strictEqual(health.status, "version-unsupported", installedVersion);
  }
});

test("a family marker for an admitted but unlisted version verifies by range identity", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeFamilyGeneration(harness, DSH_VERSION_FAMILIES[0], "0.2.1");
  const syncHealth = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    dshInstallRoot: null,
  });
  assert.strictEqual(syncHealth.status, "healthy");
  const asyncHealth = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(asyncHealth.status, "healthy");
  assert.strictEqual(asyncHealth.marker.installedDshVersion, "0.2.1");
});

test("different DSH families never share a generation hash", () => {
  const hash02 = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, { supportedDshRange: FAMILY_02_RANGE });
  const hash01 = dshInstallTest.hashBridgeDirectorySync(fs, SOURCE_DIR, { supportedDshRange: FAMILY_01_RANGE });
  assert.notStrictEqual(hash02, hash01);
});

test("a same-family host upgrade reuses the staged generation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const first = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.0-rc.2" }));
  assert.strictEqual(first.status, "ok");
  assert.strictEqual(first.updated, true);
  const before = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  const profileManifestPath = path.join(harness.profileDir, "package.json");
  const profileManifestBefore = fs.readFileSync(profileManifestPath);
  const second = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.1" }));
  assert.strictEqual(second.status, "ok");
  assert.strictEqual(second.updated, false);
  assert.strictEqual(cli.calls.length, 1);
  const after = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(after.marker.installedDshVersion, "0.2.0-rc.2");
  assert.strictEqual(after.marker.bundleHash, before.marker.bundleHash);
  assert.deepStrictEqual(fs.readFileSync(profileManifestPath), profileManifestBefore);
});

test("an admitted but unlisted host installs and records its own version", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.1" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.status, "healthy");
  assert.strictEqual(health.marker.installedDshVersion, "0.2.1");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_02_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.2.0-rc.2");
});

test("a same-family version change under the lock aborts before plugin mutation", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  let probes = 0;
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async (_command, args) => {
      assert.deepStrictEqual(args, ["--version"]);
      probes += 1;
      return { code: 0, stdout: probes === 1 ? "0.2.0-rc.2" : "0.2.1" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-changed");
  assert.strictEqual(result.expectedVersion, "0.2.0-rc.2");
  assert.strictEqual(result.detectedVersion, "0.2.1");
  assert.strictEqual(probes, 2);
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    dshInstallRoot: null,
  }).status, "absent");
});

test("npx-only Repair pins the family's newest verified artifact for an unlisted marker version", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const updatedSource = path.join(harness.root, "updated-0.2-source");
  fs.cpSync(SOURCE_DIR, updatedSource, { recursive: true });
  fs.appendFileSync(path.join(updatedSource, "lib", "index.js"), "\n// updated 0.2 bridge source\n", "utf8");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.1" }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
    operation: "explicit-repair",
    sourceDir: updatedSource,
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "cli-unavailable");
  assert.match(result.manualCommand, /@deepseek-ai\/dsh@0\.2\.0-rc\.2/);
  const reference = readJson(dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot }));
  const marker = readJson(path.join(harness.managedRoot, "generations", reference.bundleHash, "clawd-manifest.json"));
  assert.strictEqual(marker.installedDshVersion, "0.2.1");
  assert.strictEqual(marker.supportedDshRange, FAMILY_02_RANGE);
});

test("npx-only uninstall pins the marker's artifact when listed and the family's newest otherwise", async (t) => {
  for (const [version, artifact] of [["0.1.5-rc.1", "0.1.5-rc.1"], ["0.2.1", "0.2.0-rc.2"]]) {
    const harness = makeHarness();
    const cli = makeOfficialCli(harness);
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: version }));
    const result = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
      commandInfo: null,
      dshCommand: false,
      dshVersion: undefined,
    }));
    assert.strictEqual(result.status, "error", version);
    assert.strictEqual(result.reason, "cli-unavailable", version);
    assert.match(result.manualCommand, new RegExp(`@deepseek-ai/dsh@${artifact.replace(/\./g, "\\.")}`), version);
  }
});

test("dshMarkerIdentity never conflates the hash contract with the staged version", () => {
  const marker = { installedDshVersion: "0.2.1", supportedDshRange: FAMILY_02_RANGE };
  assert.strictEqual(
    dshInstallTest.dshMarkerIdentity(marker),
    `${FAMILY_02_RANGE}\0${"0.2.1"}`,
  );
  assert.notStrictEqual(
    dshInstallTest.dshMarkerIdentity({ installedDshVersion: "0.2.2", supportedDshRange: FAMILY_02_RANGE }),
    dshInstallTest.dshMarkerIdentity(marker),
  );
  assert.notStrictEqual(
    dshInstallTest.dshMarkerIdentity({ installedDshVersion: "0.2.0-rc.2", supportedDshRange: "=0.2.0-rc.2" }),
    dshInstallTest.dshMarkerIdentity(marker),
  );
  assert.strictEqual(
    dshInstallTest.dshMarkerIdentity({ installedDshVersion: "0.1.0-rc.7", supportedDshRange: "=0.1.0-rc.7" }),
    null,
  );
  assert.strictEqual(dshInstallTest.dshMarkerIdentity(marker), dshInstallTest.dshMarkerIdentity({ ...marker }));
});

test("an admitted host in a family with several verified artifacts pins the newest", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.1.6" }));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.updated, true);
  const health = await inspectDeepSeekHarnessIntegration({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    resolveCommandForInspection: false,
  });
  assert.strictEqual(health.marker.installedDshVersion, "0.1.6");
  assert.strictEqual(health.marker.supportedDshRange, FAMILY_01_RANGE);
  assert.strictEqual(health.marker.verifiedDshArtifact, "@deepseek-ai/dsh@0.1.5-rc.3");
});

test("npx-only Repair and uninstall of a 0.1-family marker pin the family's newest verified artifact", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  const updatedSource = path.join(harness.root, "updated-0.1-source");
  fs.cpSync(SOURCE_DIR, updatedSource, { recursive: true });
  fs.appendFileSync(path.join(updatedSource, "lib", "index.js"), "\n// updated 0.1 bridge source\n", "utf8");
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeFamilyGeneration(harness, DSH_VERSION_FAMILIES[1], "0.1.0-rc.7");

  const repair = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
    operation: "explicit-repair",
    sourceDir: updatedSource,
  }));
  assert.strictEqual(repair.status, "error");
  assert.strictEqual(repair.reason, "cli-unavailable");
  assert.match(repair.manualCommand, /@deepseek-ai\/dsh@0\.1\.5-rc\.3/);

  const removed = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
    dshVersion: undefined,
  }));
  assert.strictEqual(removed.status, "error");
  assert.strictEqual(removed.reason, "cli-unavailable");
  assert.match(removed.manualCommand, /@deepseek-ai\/dsh@0\.1\.5-rc\.3/);
});

test("promoteGeneration records the target contract's artifact version when no host version is given", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const contract = dshInstallTest.dshTargetContract(DSH_VERSION_FAMILIES[1], null);
  const bundle = await dshInstallTest.readSourceBundle({ sourceDir: SOURCE_DIR, contract });
  const generation = await dshInstallTest.promoteGeneration(bundle, {
    managedRoot: harness.managedRoot,
    clawdVersion: "1.2.3",
  });
  const marker = readJson(path.join(generation.generationDir, "clawd-manifest.json"));
  assert.strictEqual(marker.supportedDshRange, FAMILY_01_RANGE);
  assert.strictEqual(dshInstallTest.dshFamilyForVersion(marker.installedDshVersion).family, "0.1");
});

test("install treats a version line on stdout and another on stderr as an unknown version", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const result = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    dshVersion: undefined,
    runCommand: async () => ({ code: 0, stdout: "0.2.1\n", stderr: "0.2.2\n" }),
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-invalid");
  assert.deepStrictEqual(cli.calls, []);
});

test("a CLI install reuses the generation staged earlier without a CLI in the same family", async (t) => {
  const harness = makeHarness();
  const cli = makeOfficialCli(harness);
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const staged = await installDeepSeekHarnessBridge(installOptions(harness, cli, {
    commandInfo: null,
    dshCommand: false,
  }));
  assert.strictEqual(staged.reason, "cli-unavailable");
  assert.strictEqual(staged.manualGenerationReferenced, true);
  const referencePath = dshInstallTest.manualGenerationReferencePath({ managedRoot: harness.managedRoot });
  const reference = readJson(referencePath);
  const generationDir = path.join(harness.managedRoot, "generations", reference.bundleHash);
  const markerPath = path.join(generationDir, "clawd-manifest.json");
  const markerBefore = fs.readFileSync(markerPath);

  const installed = await installDeepSeekHarnessBridge(installOptions(harness, cli, { dshVersion: "0.2.1" }));

  assert.strictEqual(installed.status, "ok");
  assert.strictEqual(installed.updated, true);
  assert.strictEqual(cli.calls.length, 1);
  assert.deepStrictEqual(cli.calls[0].slice(0, 4), ["plugin", "--profile", "web", "add"]);
  assert.strictEqual(cli.calls[0][4], canonicalRealpath(generationDir));
  assert.deepStrictEqual(fs.readFileSync(markerPath), markerBefore);
  const marker = readJson(markerPath);
  assert.strictEqual(marker.installedDshVersion, "0.2.0-rc.2");
  assert.strictEqual(marker.installedDshVersionAssumedAtStaging, true);
  assert.deepStrictEqual(
    fs.readdirSync(path.join(harness.managedRoot, "generations")),
    [reference.bundleHash],
  );
  assert.strictEqual(fs.existsSync(referencePath), false);
});
