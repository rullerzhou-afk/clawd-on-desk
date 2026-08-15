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
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  installDeepSeekHarnessBridge,
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
    silent: true,
    ...overrides,
  };
}

test("DSH detection is async and distinguishes the host from the managed plugin", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  assert.strictEqual(await isDshInstalled({ dshHome: harness.dshHome }), true);
  assert.strictEqual(await isBridgeInstalled({ dshHome: harness.dshHome, resolveCommandForInspection: false }), false);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ dshHome: harness.dshHome }).status, "absent");
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

test("Windows CLI discovery follows a pnpm-style shim instead of assuming one global npm layout", async (t) => {
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
    dshVersion: "0.1.0-rc.7",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.1.0-rc.7");
  assert.deepStrictEqual(cli.calls, []);
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ dshHome: harness.dshHome }).status, "absent");
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
    assert.strictEqual(uninstallResult.status, "error", scenario);
    assert.strictEqual(uninstallResult.reason, "manual-generation-reference-invalid", scenario);
    assert.strictEqual(uninstallResult.referencePath, referencePath, scenario);
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
    assert.strictEqual(result.status, "error", scenario);
    assert.strictEqual(result.reason, "manual-generation-reference-invalid", scenario);
    assert.strictEqual(result.referencePath, referencePath, scenario);
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
    assert.strictEqual(first.status, "error", scenario);
    assert.strictEqual(first.reason, "manual-generation-reference-invalid", scenario);
    assert.strictEqual(fs.existsSync(generationDir), true, scenario);
    const residue = fs.readdirSync(path.dirname(referencePath))
      .find((name) => name.startsWith(`${path.basename(referencePath)}.clearing-`));
    assert.ok(residue, scenario);
    if (scenario === "restore-link-failure") fs.unlinkSync(referencePath);

    const second = await uninstallDeepSeekHarnessBridge(options);
    assert.strictEqual(second.status, "error", scenario);
    assert.strictEqual(second.reason, "manual-generation-reference-invalid", scenario);
    assert.match(second.referencePath, /\.clearing-/, scenario);
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
    assert.strictEqual(result.status, "error", code);
    assert.strictEqual(result.reason, "manual-generation-reference-invalid", code);
    assert.strictEqual(result.referencePath, harness.managedRoot, code);
    assert.strictEqual(result.manualInspectionRequired, true, code);
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
  const canonicalA = fs.realpathSync.native ? fs.realpathSync.native(targetA) : fs.realpathSync(targetA);
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
  assert.strictEqual(observedDshHome, fs.realpathSync(harness.dshHome));
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

test("sync disk inspection discovers installation-first shadowing from the real PATH shim", async (t) => {
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

test("sync disk inspection compares the installed DSH package version", async (t) => {
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
    version: "0.1.0-rc.7",
  });

  const health = inspectDeepSeekHarnessDiskSync({
    dshHome: harness.dshHome,
    managedRoot: harness.managedRoot,
    env: { PATH: binDir },
    platform: "win32",
  });
  assert.strictEqual(health.status, "host-version-unsupported");
  assert.strictEqual(health.detectedDshVersion, "0.1.0-rc.7");
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
  assert.strictEqual(inspectDeepSeekHarnessDiskSync({ dshHome: harness.dshHome }).status, "absent");
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
  const first = await uninstallDeepSeekHarnessBridge(installOptions(harness, cli, {
    unlinkManagedProfileLink: async () => {
      const err = new Error("busy junction");
      err.code = "EPERM";
      throw err;
    },
  }));
  assert.strictEqual(first.status, "error");
  assert.strictEqual(first.cleanupReason, "residue-unlink-failed");
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
    dshVersion: "0.1.0-rc.7",
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.1.0-rc.7");
  assert.strictEqual(result.supportedRange, SUPPORTED_DSH_RANGE);
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
    dshVersion: "0.1.0-rc.7",
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
  await assert.rejects(
    installDeepSeekHarnessBridge(installOptions(healthy, healthyCli, { operation: "explicit-repair" })),
    /already locked/,
  );
  assert.strictEqual(healthyCli.calls.length, healthyCalls);
  assert.strictEqual(fs.existsSync(path.join(healthy.managedRoot, "inspection-required.json")), true);

  await assert.rejects(
    uninstallDeepSeekHarnessBridge(installOptions(absent, absentCli)),
    /already locked/,
  );
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
      return { code: 0, stdout: probes === 1 ? SUPPORTED_DSH_VERSION : "0.1.0-rc.7" };
    },
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, "version-unsupported");
  assert.strictEqual(result.detectedVersion, "0.1.0-rc.7");
  assert.strictEqual(probes, 2);
  assert.strictEqual(cli.calls.length, 1);
  assert.strictEqual(fs.existsSync(path.join(harness.managedRoot, "inspection-required.json")), true);
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
