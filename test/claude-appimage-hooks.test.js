"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const install = require("../hooks/install");
const {
  resolveClaudeHookPaths,
  registerHooks,
  registerHooksAsync,
  registerClaudeStatusline,
  unregisterClaudeStatusline,
  getClaudeHookScriptPath,
  getClaudeAutoStartScriptPath,
  getClaudeStatuslineScriptPath,
} = install;
const {
  inspectClaudeHookHealth,
  hasNoAutomaticRepairWork,
  buildClaudeRepairSignature,
} = require("../src/claude-hook-health");
const { createClaudeSettingsWatcher } = require("../src/claude-settings-watcher");
const { EventEmitter } = require("node:events");
const { resolveAppImageExecutable, launchApp, isMaterializedAppImageHooksDir } = require("../hooks/auto-start");

const APPIMAGE = "/opt/Clawd-on-Desk.AppImage";
// Emulated AppImage mount for positive cases: APPDIR must own the Claude source
// scripts. The repo root contains hooks/, so it is a valid stand-in for tests.
const APPDIR = path.resolve(__dirname, "..");
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-appimage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeOptions(overrides = {}) {
  const root = tempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    settingsPath: path.join(root, "settings.json"),
    options: {
      platform: "linux",
      processEnv: { APPIMAGE, APPDIR },
      homeDir: home,
      materializedRoot: path.join(root, "appimage-hooks"),
      settingsPath: path.join(root, "settings.json"),
      nodeBin: process.execPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      silent: true,
      ...overrides,
    },
  };
}

function managedCommands(settings) {
  const commands = [];
  for (const entries of Object.values(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.command === "string") commands.push(entry.command);
      if (Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (hook && typeof hook.command === "string") commands.push(hook.command);
        }
      }
    }
  }
  return commands;
}

describe("Claude AppImage hook resolver", () => {
  it("keeps source === target in direct mode and materializes all three entries into one generation", () => {
    const direct = resolveClaudeHookPaths({ platform: "darwin" }, { materialize: false });
    assert.strictEqual(direct.ok, true);
    assert.strictEqual(direct.mode, "direct");
    assert.deepStrictEqual(direct.source, direct.target);

    const { options } = makeOptions();
    const resolved = resolveClaudeHookPaths(options, { materialize: true });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.mode, "appimage-materialized");
    assert.notStrictEqual(resolved.target.state, resolved.source.state);
    for (const target of [resolved.target.state, resolved.target.autoStart, resolved.target.statusline]) {
      assert.ok(target.startsWith(resolved.generationDir + path.sep), target);
      assert.ok(fs.existsSync(target), target);
    }
    assert.ok(!resolved.target.state.includes(".mount_"));
    assert.ok(!resolved.target.state.includes("app.asar.unpacked"));
    assert.strictEqual(
      fs.readFileSync(path.join(resolved.generationDir, ".clawd-appimage-path"), "utf8"),
      `${APPIMAGE}\n`
    );
  });

  it("keeps one generation across auto-start and statusline feature toggles", () => {
    const root = tempDir();
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const materializedRoot = path.join(root, "appimage-hooks");
    const generationOf = (settings, marker) => {
      const commands = managedCommands(settings);
      const command = commands.find((c) => c.includes(marker));
      assert.ok(command, marker);
      const match = command.match(/appimage-hooks[\\/]([a-f0-9]{20})[\\/]/);
      assert.ok(match, command);
      return match[1];
    };
    const base = {
      platform: "linux",
      processEnv: { APPIMAGE, APPDIR },
      homeDir: home,
      materializedRoot,
      nodeBin: process.execPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      silent: true,
    };

    const autoStartOff = path.join(root, "auto-start-off.json");
    const autoStartOn = path.join(root, "auto-start-on.json");
    const statuslineOn = path.join(root, "statusline-on.json");
    registerHooks({ ...base, settingsPath: autoStartOff, autoStart: false });
    registerHooks({ ...base, settingsPath: autoStartOn, autoStart: true });
    registerClaudeStatusline({ ...base, settingsPath: statuslineOn });

    const off = JSON.parse(fs.readFileSync(autoStartOff, "utf8"));
    const on = JSON.parse(fs.readFileSync(autoStartOn, "utf8"));
    const statusline = JSON.parse(fs.readFileSync(statuslineOn, "utf8"));

    const offGeneration = generationOf(off, "clawd-hook.js");
    assert.strictEqual(generationOf(on, "clawd-hook.js"), offGeneration);
    const statuslineMatch = statusline.statusLine.command.match(/appimage-hooks[\\/]([a-f0-9]{20})[\\/]/);
    assert.ok(statuslineMatch, statusline.statusLine.command);
    assert.strictEqual(statuslineMatch[1], offGeneration);
    // The toggle actually registered the corresponding command.
    assert.ok(managedCommands(on).some((c) => c.includes("auto-start.js")));
    assert.ok(statusline.statusLine.command.includes("claude-statusline.js"));
  });

  it("does not materialize when a foreign AppImage's APPIMAGE/APPDIR is inherited", () => {
    const { options } = makeOptions();
    const foreign = resolveClaudeHookPaths({
      ...options,
      processEnv: { APPIMAGE: "/opt/VSCodium.AppImage", APPDIR: "/tmp/.mount_vscodium" },
    }, { materialize: true });
    assert.strictEqual(foreign.ok, true);
    assert.strictEqual(foreign.mode, "direct");
    assert.strictEqual(foreign.target.state, foreign.source.state);
  });

  it("materializes when APPDIR owns the Claude source scripts", () => {
    const mount = path.join(tempDir(), ".mount_Clawd");
    const hooksDir = path.join(mount, "resources", "app.asar.unpacked", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const sourcePaths = {};
    for (const [key, name] of [["state", "clawd-hook.js"], ["autoStart", "auto-start.js"], ["statusline", "claude-statusline.js"]]) {
      const file = path.join(hooksDir, name);
      fs.writeFileSync(file, "module.exports = true;\n");
      sourcePaths[key] = file;
    }
    const materializedRoot = path.join(tempDir(), "appimage-hooks");
    const resolved = resolveClaudeHookPaths({
      platform: "linux",
      processEnv: { APPIMAGE, APPDIR: mount },
      homeDir: tempDir(),
      materializedRoot,
      sourcePaths,
    }, { materialize: true });
    assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
    assert.strictEqual(resolved.mode, "appimage-materialized");
    assert.ok(resolved.target.state.startsWith(resolved.generationDir + path.sep));
    assert.strictEqual(
      fs.readFileSync(path.join(resolved.generationDir, ".clawd-appimage-path"), "utf8"),
      `${APPIMAGE}\n`
    );
  });

  it("fails closed for non-string, empty, whitespace and relative APPIMAGE values", () => {
    for (const value of [42, null, undefined, "", "   ", {}, "relative/Clawd.AppImage"]) {
      const resolved = resolveClaudeHookPaths(
        { platform: "linux", processEnv: { APPIMAGE: value }, homeDir: tempDir() },
        { materialize: false }
      );
      assert.strictEqual(resolved.ok, false, JSON.stringify(value));
      assert.strictEqual(resolved.reason, "invalid-appimage-path", JSON.stringify(value));
    }
  });

  it("falls back to direct mode for an absolute APPIMAGE whose APPDIR does not own our sources", () => {
    const resolved = resolveClaudeHookPaths(
      { platform: "linux", processEnv: { APPIMAGE, APPDIR: "/tmp/.mount_vscodium" }, homeDir: tempDir() },
      { materialize: false }
    );
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.mode, "direct");
  });

  it("accepts Windows absolute APPDIR and Windows source paths in synthetic platform tests", () => {
    const appDir = "D:\\Clawd\\mount";
    const sources = {
      state: "D:\\Clawd\\mount\\resources\\app.asar.unpacked\\hooks\\clawd-hook.js",
      autoStart: "D:\\Clawd\\mount\\resources\\app.asar.unpacked\\hooks\\auto-start.js",
      statusline: "D:\\Clawd\\mount\\resources\\app.asar.unpacked\\hooks\\claude-statusline.js",
    };
    // APPIMAGE stays a POSIX path (the emulated Linux runtime field); only the
    // host-resolved APPDIR/source paths may be Windows-style.
    const decision = install.evaluateClaudeAppImage(
      { platform: "linux", processEnv: { APPIMAGE, APPDIR: appDir } },
      sources
    );
    assert.strictEqual(decision.materialize, true, JSON.stringify(decision));
    assert.strictEqual(decision.appImagePath, APPIMAGE);

    // Relative / garbage APPDIR values are still rejected, but as a safe
    // direct fallback (a well-formed APPIMAGE must not error just because the
    // inherited APPDIR is not ours).
    for (const bad of ["relative\\mount", "D:relative", "", "   ", "\\\\server\\share"]) {
      const value = install.evaluateClaudeAppImage(
        { platform: "linux", processEnv: { APPIMAGE, APPDIR: bad } },
        sources
      );
      assert.strictEqual(value.materialize, false, JSON.stringify(bad));
      assert.strictEqual(value.error, undefined, JSON.stringify(bad));
    }
  });

  it("keeps APPIMAGE POSIX-only under platform linux", () => {
    const appDir = path.resolve(__dirname, "..");
    for (const appImage of ["D:\\Foreign.AppImage", "\\\\server\\share\\Foreign.AppImage"]) {
      const value = install.evaluateClaudeAppImage(
        { platform: "linux", processEnv: { APPIMAGE: appImage, APPDIR: appDir } },
        install.claudeSourceHookPaths()
      );
      assert.strictEqual(value.materialize, false, appImage);
      assert.strictEqual(value.error && value.error.reason, "invalid-appimage-path", appImage);

      const resolved = resolveClaudeHookPaths(
        { platform: "linux", processEnv: { APPIMAGE: appImage, APPDIR: appDir }, homeDir: tempDir() },
        { materialize: false }
      );
      assert.strictEqual(resolved.ok, false, appImage);
      assert.strictEqual(resolved.reason, "invalid-appimage-path", appImage);
    }
  });

  it("merges a partial explicit sourcePaths argument instead of bypassing the merge", () => {
    const partial = { statusline: getClaudeStatuslineScriptPath() };
    const decision = install.evaluateClaudeAppImage(
      { platform: "linux", processEnv: { APPIMAGE, APPDIR } },
      partial
    );
    // state/autoStart fall back to the repo default, so all three are inside
    // APPDIR and ownership must hold (a verbatim partial would have faked direct).
    assert.strictEqual(decision.materialize, true, JSON.stringify(decision));

    const outside = path.join(tempDir(), "elsewhere", "claude-statusline.js");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "module.exports = true;\n");
    const notOwned = install.evaluateClaudeAppImage(
      { platform: "linux", processEnv: { APPIMAGE, APPDIR } },
      { statusline: outside }
    );
    assert.strictEqual(notOwned.materialize, false, JSON.stringify(notOwned));
  });

  it("merges partial sourcePaths identically for the fs guard and the resolver", () => {
    const fakeFs = { ...fs };
    const partial = { statusline: getClaudeStatuslineScriptPath() };
    const options = { platform: "linux", processEnv: { APPIMAGE, APPDIR }, sourcePaths: partial };

    // The merged sources are all inside APPDIR, so the guard must fail closed…
    const guard = install.checkClaudeMaterializationFs({ ...options, fs: fakeFs });
    assert.strictEqual(guard.ok, false, JSON.stringify(guard));
    assert.strictEqual(guard.reason, "resolver-fs-inconsistent");

    // …and the resolver must agree that it would materialize, not fall direct.
    const resolved = resolveClaudeHookPaths(
      { ...options, homeDir: tempDir(), materializedRoot: tempDir() },
      { materialize: false }
    );
    assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
    assert.strictEqual(resolved.mode, "appimage-materialized");
  });

  it("never materializes for a non-linux injected platform", () => {
    const resolved = resolveClaudeHookPaths(
      { platform: "darwin", processEnv: { APPIMAGE, APPDIR } },
      { materialize: true }
    );
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.mode, "direct");
  });

  it("fails closed on an invalid APPIMAGE path and refuses an uncontrolled synthesized root", () => {
    const invalid = resolveClaudeHookPaths(
      { platform: "linux", processEnv: { APPIMAGE: "relative/Clawd.AppImage" }, homeDir: tempDir() },
      { materialize: true }
    );
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.reason, "invalid-appimage-path");

    // A synthesized platform:"linux" on a non-Linux host must not fall through
    // to the real ~/.clawd (host-independent coverage lives in the materializer
    // suite via planAppImageHookBundle's UNCONTROLLED_ROOT guard).
    if (process.platform !== "linux") {
      const uncontrolled = resolveClaudeHookPaths(
        { platform: "linux", processEnv: { APPIMAGE, APPDIR } },
        { materialize: true }
      );
      assert.strictEqual(uncontrolled.ok, false);
      assert.strictEqual(uncontrolled.reason, "UNCONTROLLED_ROOT");
    }
  });

  it("returns a structured failure when realpath cannot verify the source", () => {
    const { options } = makeOptions();
    const resolved = resolveClaudeHookPaths({
      ...options,
      realpathSync() { const err = new Error("denied"); err.code = "EACCES"; throw err; },
    }, { materialize: false });
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.reason, "REALPATH_FAILED");
  });

  it("returns source-script-missing when the bundled source closure is gone", () => {
    const resolved = resolveClaudeHookPaths(
      {
        platform: "linux",
        processEnv: { APPIMAGE, APPDIR },
        homeDir: tempDir(),
        materializedRoot: tempDir(),
        fs: {
          readFileSync() { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; },
          existsSync() { return false; },
          mkdirSync() {},
          writeFileSync() {},
          renameSync() {},
          rmSync() {},
        },
      },
      { materialize: false }
    );
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.reason, "source-script-missing");
  });
});

describe("Claude AppImage hook registration", () => {
  it("writes every managed command to the persistent generation, not the mount", () => {
    const { options, settingsPath } = makeOptions({ autoStart: true });
    registerHooks(options);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const commands = managedCommands(settings);
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.ok(!command.includes(".mount_"), command);
      assert.ok(!command.includes("app.asar.unpacked"), command);
      assert.ok(command.includes("appimage-hooks"), command);
    }
    const generation = commandGeneration(commands.find((c) => c.includes("clawd-hook.js")));
    const autoStartCommand = commands.find((c) => c.includes("auto-start.js"));
    assert.ok(autoStartCommand);
    assert.strictEqual(commandGeneration(autoStartCommand), generation);

    function commandGeneration(command) {
      const match = command.match(/appimage-hooks[\\/]([a-f0-9]{20})[\\/]/);
      assert.ok(match, command);
      return match[1];
    }
  });

  it("migrates existing mount-scoped managed commands onto the persistent generation", () => {
    const { options, settingsPath } = makeOptions();
    const mountScript = "/tmp/.mount_ClawdXYZ/resources/app.asar.unpacked/hooks/clawd-hook.js";
    const mountHook = install.__test.buildCommandHookSpec(process.execPath, mountScript, "Stop", {
      platform: "linux",
      async: true,
      timeout: 5,
    });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [mountHook] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
      },
    }));

    registerHooks(options);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const stop = settings.hooks.Stop.flatMap((e) => e.hooks).find((h) => h.command.includes("clawd-hook.js"));
    assert.ok(!stop.command.includes(".mount_"), stop.command);
    assert.ok(stop.command.includes("appimage-hooks"), stop.command);

    // An old mount-scoped command (file now gone) is a repairable health issue.
    const resolved = resolveClaudeHookPaths(options, { materialize: false });
    const staleReport = inspectClaudeHookHealth(JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [mountHook] }] },
    }), {
      expectedHookScriptPath: resolved.target.state,
      sourceHookScriptPath: resolved.source.state,
      targetGeneration: resolved.targetGeneration,
      coreEvents: ["Stop"],
      platform: "linux",
      fs,
    });
    assert.strictEqual(staleReport.repairable, true);
    assert.strictEqual(hasNoAutomaticRepairWork(staleReport), false);
  });

  it("second registration writes nothing and generation repair leaves settings bytes untouched", () => {
    const { options, settingsPath } = makeOptions();
    registerHooks(options);
    const first = fs.readFileSync(settingsPath, "utf8");

    const second = registerHooks(options);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), first);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.removed, 0);
    assert.strictEqual(second.backupPath, null);

    const resolved = resolveClaudeHookPaths(options, { materialize: false });
    fs.rmSync(resolved.generationDir, { recursive: true, force: true });
    assert.strictEqual(resolveClaudeHookPaths(options, { materialize: false }).targetGeneration.ok, false);

    registerHooks(options);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), first);
    assert.ok(fs.existsSync(resolved.target.state));
    assert.strictEqual(resolveClaudeHookPaths(options, { materialize: false }).targetGeneration.ok, true);
  });

  it("keeps async registration byte-compatible with the sync path", async () => {
    const harness = makeOptions();
    registerHooks(harness.options);
    const syncText = fs.readFileSync(harness.settingsPath, "utf8");

    fs.rmSync(harness.settingsPath);
    await registerHooksAsync(harness.options);
    assert.strictEqual(fs.readFileSync(harness.settingsPath, "utf8"), syncText);
  });

  it("materialized auto-start fails closed when the AppImage marker is missing or corrupt", () => {
    const generation = path.join(tempDir(), ".clawd", "appimage-hooks", "a".repeat(20));
    fs.mkdirSync(generation, { recursive: true });
    assert.strictEqual(isMaterializedAppImageHooksDir(generation), true);

    const calls = [];
    const originalStderr = process.stderr.write;
    let stderr = "";
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    try {
      launchApp({
        platform: "linux",
        hooksDir: generation,
        appImageMissing: true,
        env: {},
        fs: {
          readFileSync() { throw new Error("ENOENT"); },
          existsSync() { return false; },
        },
        spawn(command, args, opts) {
          calls.push({ command, args, opts });
          return { unref() {} };
        },
      });
    } finally {
      process.stderr.write = originalStderr;
    }
    assert.deepStrictEqual(calls, [], "must never fall through to the dev require('electron') branch");
    assert.match(stderr, /marker is missing or invalid/);

    // A valid marker still launches the persistent on-disk AppImage.
    const validCalls = [];
    launchApp({
      platform: "linux",
      hooksDir: generation,
      env: {},
      fs: {
        readFileSync() { return `${APPIMAGE}\n`; },
        existsSync() { return true; },
      },
      spawn(command, args, opts) {
        validCalls.push({ command, args, opts });
        return { unref() {} };
      },
    });
    assert.strictEqual(validCalls[0].command, APPIMAGE);
  });

  it("never spawns a foreign inherited APPIMAGE from a deb-like asar tree", () => {
    const mountHooksDir = "/tmp/.mount_ClawdX/resources/app.asar.unpacked/hooks";
    const foreignCalls = [];
    launchApp({
      platform: "linux",
      hooksDir: "/opt/Clawd/resources/app.asar.unpacked/hooks",
      env: { APPIMAGE: "/opt/VSCodium.AppImage", APPDIR: "/tmp/.mount_vscodium" },
      fs: {
        readFileSync() { throw new Error("ENOENT"); },
        existsSync() { return false; },
      },
      spawn(command, args, opts) { foreignCalls.push({ command, args, opts }); return { unref() {} }; },
    });
    assert.ok(
      !foreignCalls.some((call) => call.command === "/opt/VSCodium.AppImage"),
      JSON.stringify(foreignCalls)
    );
    assert.strictEqual(foreignCalls[0].command, "/opt/Clawd/clawd-on-desk");

    // The same inherited env is trusted only when APPDIR owns this process's
    // own asar tree (a real, not-yet-materialized Clawd AppImage).
    const ownedCalls = [];
    launchApp({
      platform: "linux",
      hooksDir: mountHooksDir,
      env: { APPIMAGE, APPDIR: "/tmp/.mount_ClawdX" },
      fs: {
        readFileSync() { throw new Error("ENOENT"); },
        existsSync() { return false; },
      },
      spawn(command, args, opts) { ownedCalls.push({ command, args, opts }); return { unref() {} }; },
    });
    assert.strictEqual(ownedCalls[0].command, APPIMAGE);
  });
});

describe("Claude AppImage health/spatial contract", () => {
  it("classifies a complete generation healthy, a missing generation repairable, and a missing source unrepairable", {
    skip: process.platform === "win32" ? "requires POSIX AppImage executable semantics" : false,
  }, () => {
    const { options, settingsPath } = makeOptions();
    registerHooks(options);
    const raw = fs.readFileSync(settingsPath, "utf8");
    const resolved = resolveClaudeHookPaths(options, { materialize: false });
    const base = {
      expectedHookScriptPath: resolved.target.state,
      expectedAutoStartScriptPath: resolved.target.autoStart,
      sourceHookScriptPath: resolved.source.state,
      sourceAutoStartScriptPath: resolved.source.autoStart,
      targetGeneration: resolved.targetGeneration,
      coreEvents: install.CLAUDE_CORE_HOOK_EVENTS,
      platform: "linux",
      fs,
    };

    const healthy = inspectClaudeHookHealth(raw, base);
    assert.strictEqual(healthy.status, "healthy");

    fs.rmSync(resolved.generationDir, { recursive: true, force: true });
    const missingGeneration = resolveClaudeHookPaths(options, { materialize: false });
    const report = inspectClaudeHookHealth(raw, {
      ...base,
      targetGeneration: missingGeneration.targetGeneration,
    });
    assert.ok(report.issues.some((issue) => issue.code === "target-generation-missing" && issue.automaticRepairable));
    assert.strictEqual(hasNoAutomaticRepairWork(report), false);

    const sourceMissing = inspectClaudeHookHealth(raw, {
      ...base,
      sourceHookScriptPath: path.join(tempDir(), "gone", "clawd-hook.js"),
    });
    assert.strictEqual(sourceMissing.status, "source-script-missing");
    assert.strictEqual(sourceMissing.repairable, false);
    assert.strictEqual(hasNoAutomaticRepairWork(sourceMissing), false);
  });

  it("keeps one stable target-generation repair class whether the generation is deleted or corrupt", {
    skip: process.platform === "win32" ? "requires POSIX AppImage executable semantics" : false,
  }, () => {
    const { options, settingsPath } = makeOptions();
    registerHooks(options);
    const raw = fs.readFileSync(settingsPath, "utf8");

    const corruptResolved = resolveClaudeHookPaths(options, { materialize: false });
    // Corruption with entry files still present: only the byte check can see it.
    fs.writeFileSync(corruptResolved.target.state, "module.ex");
    const corrupt = resolveClaudeHookPaths(options, { materialize: false });
    const corruptReport = inspectClaudeHookHealth(raw, {
      expectedHookScriptPath: corrupt.target.state,
      sourceHookScriptPath: corrupt.source.state,
      targetGeneration: corrupt.targetGeneration,
      coreEvents: install.CLAUDE_CORE_HOOK_EVENTS,
      platform: "linux",
      fs,
    });
    assert.strictEqual(corrupt.targetGeneration.ok, false);

    // Full deletion: the same commands now point at missing files.
    fs.rmSync(corruptResolved.generationDir, { recursive: true, force: true });
    const deleted = resolveClaudeHookPaths(options, { materialize: false });
    const deletedReport = inspectClaudeHookHealth(raw, {
      expectedHookScriptPath: deleted.target.state,
      sourceHookScriptPath: deleted.source.state,
      targetGeneration: deleted.targetGeneration,
      coreEvents: install.CLAUDE_CORE_HOOK_EVENTS,
      platform: "linux",
      fs,
    });

    const corruptSignature = buildClaudeRepairSignature(corruptReport.issues);
    const deletedSignature = buildClaudeRepairSignature(deletedReport.issues);
    assert.strictEqual(corruptSignature, "v1:target-generation");
    assert.strictEqual(deletedSignature, corruptSignature);
  });
});

describe("Claude AppImage statusline", () => {
  it("registers the persistent target into an empty slot", () => {
    const { options, settingsPath } = makeOptions();
    fs.writeFileSync(settingsPath, JSON.stringify({}));
    const result = registerClaudeStatusline({ ...options, settingsPath });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.installed, true);
    const command = JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command;
    assert.ok(command.includes("appimage-hooks"), command);
    assert.ok(command.includes("claude-statusline.js"), command);
    assert.ok(!command.includes(".mount_"), command);
  });

  it("migrates the exact released mount-scoped statusline into the persistent generation", () => {
    const { options, settingsPath } = makeOptions();
    const legacyScript = "/tmp/.mount_Clawd-ABC123/resources/app.asar.unpacked/hooks/claude-statusline.js";
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: "command", command: `"${process.execPath}" "${legacyScript}"`, padding: 0 },
    }));

    const result = registerClaudeStatusline({ ...options, settingsPath });

    assert.strictEqual(result.changed, true);
    const command = JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command;
    assert.ok(command.includes("appimage-hooks"), command);
    assert.ok(!command.includes(".mount_Clawd-ABC123"), command);
  });

  it("can explicitly uninstall the exact released mount-scoped statusline without an owner record", () => {
    const { options, settingsPath } = makeOptions();
    const legacyScript = "/tmp/.mount_Clawd-ABC123/resources/app.asar.unpacked/hooks/claude-statusline.js";
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: "command", command: `"${process.execPath}" "${legacyScript}"`, padding: 0 },
      model: "opus",
    }));

    const result = unregisterClaudeStatusline({ ...options, settingsPath });

    assert.strictEqual(result.removed, 1);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(settings.statusLine, undefined);
    assert.strictEqual(settings.model, "opus");
  });

  it("does not claim another AppImage's same-basename Claude statusline", () => {
    const { root } = makeOptions();
    const ownershipPaths = {
      localSidecar: path.join(root, "missing-local-chain.json"),
      remoteSidecarPath: path.join(root, "missing-remote-chain.json"),
      plainOwnerPath: path.join(root, "missing-plain-owner.json"),
    };
    for (const mount of ["VendorABC", "ClawdSABC123"]) {
      const existing = {
        type: "command",
        command: `"${process.execPath}" "/tmp/.mount_${mount}/resources/app.asar.unpacked/hooks/claude-statusline.js"`,
        padding: 0,
      };
      const ownership = install.__test.classifyManagedClaudeStatusline(existing, {
        expectedScript: "/expected/claude-statusline.js",
        platform: "linux",
        ...ownershipPaths,
      });
      assert.strictEqual(ownership.classification, "ambiguous", mount);
      assert.notStrictEqual(ownership.classification, "owned", mount);
    }
  });

  it("keeps both released Clawd AppImage mount prefixes eligible for statusline migration", () => {
    const { root } = makeOptions();
    const ownershipPaths = {
      localSidecar: path.join(root, "missing-local-chain.json"),
      remoteSidecarPath: path.join(root, "missing-remote-chain.json"),
      plainOwnerPath: path.join(root, "missing-plain-owner.json"),
    };
    for (const mount of ["Clawd-ABC123", "Clawd ABC123"]) {
      const existing = {
        type: "command",
        command: `"${process.execPath}" "/tmp/.mount_${mount}/resources/app.asar.unpacked/hooks/claude-statusline.js"`,
        padding: 0,
      };
      const ownership = install.__test.classifyManagedClaudeStatusline(existing, {
        expectedScript: "/expected/claude-statusline.js",
        platform: "linux",
        ...ownershipPaths,
      });
      assert.strictEqual(ownership.classification, "owned", mount);
    }
  });

  it("fails closed before any settings/sidecar mutation when materialization fails", () => {
    const { options, settingsPath, home } = makeOptions();
    const original = JSON.stringify({
      statusLine: { type: "command", command: "~/my-statusline.sh" },
      hooks: {},
    }, null, 2);
    fs.writeFileSync(settingsPath, original);
    // registerClaudeStatusline with an explicit settingsPath resolves the local
    // recovery record beside that settings file; the remote chain sidecar lives
    // under the Claude home. Both must stay byte-for-byte unchanged.
    const localSidecar = path.join(path.dirname(settingsPath), "hooks", "clawd-statusline-local-chain.json");
    fs.mkdirSync(path.dirname(localSidecar), { recursive: true });
    fs.writeFileSync(localSidecar, '{"sentinel":"local"}\n');
    const remoteSidecar = path.join(home, ".claude", "hooks", "clawd-statusline-chain.json");
    fs.mkdirSync(path.dirname(remoteSidecar), { recursive: true });
    fs.writeFileSync(remoteSidecar, '{"sentinel":"remote"}\n');

    const result = registerClaudeStatusline({
      ...options,
      settingsPath,
      chainExisting: true,
      processEnv: { APPIMAGE: "relative/Clawd.AppImage" },
    });
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.error.reason, "invalid-appimage-path");
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), original);
    assert.strictEqual(fs.readFileSync(localSidecar, "utf8"), '{"sentinel":"local"}\n');
    assert.strictEqual(fs.readFileSync(remoteSidecar, "utf8"), '{"sentinel":"remote"}\n');
  });

  it("keeps local coexistence round-trips while using the persistent target", () => {
    const { options, settingsPath, home } = makeOptions();
    const thirdParty = { type: "command", command: "~/my-statusline.sh", padding: 2 };
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: thirdParty }));

    const result = registerClaudeStatusline({
      ...options,
      settingsPath,
      chainExisting: true,
      shellExists: () => true,
    });
    assert.strictEqual(result.localChained, true);
    const managed = JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine;
    assert.ok(managed.command.includes("appimage-hooks"), managed.command);
    assert.ok(managed.command.includes("--local-chain"), managed.command);

    const sidecar = path.join(path.dirname(settingsPath), "hooks", "clawd-statusline-local-chain.json");
    const record = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    assert.strictEqual(record.statusLine.command, thirdParty.command);

    unregisterClaudeStatusline({ ...options, settingsPath });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine, thirdParty);
  });

  it("direct mode validates the statusline source closure before any settings/sidecar mutation", () => {
    const root = tempDir();
    const sourceDir = path.join(root, "source-hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    const statusline = path.join(sourceDir, "claude-statusline.js");
    fs.writeFileSync(statusline, 'require("./missing-dep");\n');
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const settingsPath = path.join(root, "settings.json");
    const original = JSON.stringify({ statusLine: { type: "command", command: "~/third-party.sh" } });
    fs.writeFileSync(settingsPath, original);
    const localSidecar = path.join(root, "local-chain.json");
    fs.writeFileSync(localSidecar, '{"sentinel":"local"}\n');
    const remoteSidecar = path.join(home, ".claude", "hooks", "clawd-statusline-chain.json");
    fs.mkdirSync(path.dirname(remoteSidecar), { recursive: true });
    fs.writeFileSync(remoteSidecar, '{"sentinel":"remote"}\n');

    const result = registerClaudeStatusline({
      platform: "darwin",
      homeDir: home,
      settingsPath,
      sourcePaths: { statusline },
      localChainSidecarPath: localSidecar,
      chainExisting: true,
      shellExists: () => true,
    });
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.error.reason, "source-script-missing");
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), original);
    assert.strictEqual(fs.readFileSync(localSidecar, "utf8"), '{"sentinel":"local"}\n');
    assert.strictEqual(fs.readFileSync(remoteSidecar, "utf8"), '{"sentinel":"remote"}\n');
  });

  it("preflightClaudeRuntime rejects a missing direct statusline dependency without writing anything", () => {
    const root = tempDir();
    const sourceDir = path.join(root, "hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    const statusline = path.join(sourceDir, "claude-statusline.js");
    fs.writeFileSync(statusline, 'require("./missing-dep");\n');
    const settingsPath = path.join(root, "settings.json");
    const original = '{"hooks":{}}\n';
    fs.writeFileSync(settingsPath, original);
    const localSidecar = path.join(sourceDir, "clawd-statusline-local-chain.json");
    fs.writeFileSync(localSidecar, '{"sentinel":"local"}\n');

    const result = install.preflightClaudeRuntime({
      platform: "darwin",
      homeDir: root,
      sourcePaths: { statusline },
      requireStatusline: true,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "source-script-missing");
    assert.match(result.message, /missing-dep/);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), original, "helper must not write settings");
    assert.strictEqual(fs.readFileSync(localSidecar, "utf8"), '{"sentinel":"local"}\n');
    assert.deepStrictEqual(
      fs.readdirSync(sourceDir).sort(),
      ["claude-statusline.js", "clawd-statusline-local-chain.json"]
    );
  });
});

function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, dueAt: now + (Number.isFinite(delay) ? delay : 0) });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    async advance(ms) {
      const target = now + (Number.isFinite(ms) ? ms : 0);
      for (;;) {
        let dueId = null;
        let dueAt = null;
        for (const [id, entry] of pending) {
          if (entry.dueAt > target) continue;
          if (dueAt === null || entry.dueAt < dueAt) { dueAt = entry.dueAt; dueId = id; }
        }
        if (dueId === null) break;
        const entry = pending.get(dueId);
        pending.delete(dueId);
        now = entry.dueAt;
        entry.fn();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
  };
}

describe("Claude settings watcher with a lazy resolver", () => {
  function makeWatcher(resolveCurrent) {
    const clock = makeFakeClock();
    const syncCalls = [];
    const hookPath = getClaudeHookScriptPath();
    const autoStartPath = getClaudeAutoStartScriptPath();
    const nodeBin = process.execPath;
    const desired = install.__test.buildCommandHookSpec(nodeBin, hookPath, "Stop", {
      platform: process.platform,
      async: true,
      timeout: 5,
    });
    let settingsRaw = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [desired] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
      },
    });
    const events = [];
    const watcher = createClaudeSettingsWatcher({
      fs: {
        watch() { const w = new EventEmitter(); w.close = () => {}; return w; },
        readFileSync() { return settingsRaw; },
        existsSync() { return true; },
        accessSync() {},
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      getHookServerPort: () => 23333,
      shouldManageClaudeHooks: () => true,
      isAgentEnabled: () => true,
      shouldSyncAgentIntegration: () => true,
      coreEvents: ["Stop"],
      autoStartWithClaude: false,
      syncClawdHooks: async (opts) => { syncCalls.push(opts); },
      resolveClaudeHookPaths: () => resolveCurrent(),
    });
    return { watcher, clock, syncCalls, hookPath, autoStartPath, nodeBin, events, setRaw: (raw) => { settingsRaw = raw; } };
  }

  it("degrades on a resolver I/O failure and keeps patrolling instead of faking healthy", async () => {
    let current = { ok: false, reason: "resolver-io-error", message: "boom" };
    const { watcher, clock, syncCalls } = makeWatcher(() => current);
    watcher.start();
    await watcher.checkNow("test");
    let status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "degraded");
    assert.strictEqual(status.degradedReason, "resolver-io-error");
    assert.ok(status.nextCheckAt !== null, "must schedule the next patrol");
    assert.deepStrictEqual(syncCalls, []);

    // Recover on the next cycle: the resolver is read-only and total.
    current = {
      ok: true,
      source: { state: getClaudeHookScriptPath(), autoStart: getClaudeAutoStartScriptPath() },
      target: { state: getClaudeHookScriptPath(), autoStart: getClaudeAutoStartScriptPath() },
      targetGeneration: { ok: true },
    };
    await watcher.checkNow("test");
    status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "healthy");
    assert.deepStrictEqual(syncCalls, []);
    watcher.stop();
  });

  it("treats an incomplete target generation as a repairable repair", async () => {
    const hookPath = getClaudeHookScriptPath();
    const resolved = () => ({
      ok: true,
      source: { state: hookPath, autoStart: getClaudeAutoStartScriptPath() },
      target: { state: hookPath, autoStart: getClaudeAutoStartScriptPath() },
      targetGeneration: { ok: false, dir: "/tmp/generation" },
    });
    const { watcher, syncCalls } = makeWatcher(resolved);
    watcher.start();
    await watcher.checkNow("test");
    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(syncCalls[0].automatic, true);
    watcher.stop();
  });

  it("fails closed on a full-capability injected fs that could diverge from the real installer", async () => {
    const root = tempDir();
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const materializedRoot = path.join(root, "appimage-hooks");
    const settingsPath = path.join(root, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

    // Every fs method exists and delegates to the real fs, but the source read
    // returns divergent bytes. A capability check would wrongly trust it; the
    // strict "mutation always uses node:fs" contract must reject it.
    const divergentFs = {
      ...fs,
      accessSync: fs.accessSync.bind(fs),
      readFileSync(target, ...rest) {
        const value = String(target).replace(/\\/g, "/");
        if (value.endsWith("/clawd-hook.js")) return Buffer.from("module.exports = 'divergent';\n");
        return fs.readFileSync(target, ...rest);
      },
      watch() { const w = new EventEmitter(); w.close = () => {}; return w; },
    };
    const clock = makeFakeClock();
    const watcher = createClaudeSettingsWatcher({
      fs: divergentFs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      getHookServerPort: () => 23333,
      shouldManageClaudeHooks: () => true,
      isAgentEnabled: () => true,
      shouldSyncAgentIntegration: () => true,
      coreEvents: ["Stop"],
      autoStartWithClaude: false,
      syncClawdHooks: async () => {},
      platform: "linux",
      processEnv: { APPIMAGE, APPDIR },
      homeDir: home,
      materializedRoot,
      claudeSettingsPath: settingsPath,
    });
    watcher.start();
    await watcher.checkNow("test");
    const status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "degraded");
    assert.strictEqual(status.degradedReason, "resolver-fs-inconsistent");
    watcher.stop();
  });

  it("falls back to the real getter for a one-sided explicit path instead of reporting false healthy", async () => {
    const hookPath = getClaudeHookScriptPath();
    const bogusAutoStart = "/nonexistent/auto-start.js";
    const settingsRaw = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{
          type: "command",
          command: `"${process.execPath}" "${hookPath}" Stop`,
          async: true,
          timeout: 5,
        }] }],
        SessionStart: [{ matcher: "", hooks: [{
          type: "command",
          command: `"${process.execPath}" "${bogusAutoStart}"`,
          async: true,
          timeout: 15,
        }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
      },
    });
    const existing = new Set([hookPath, getClaudeAutoStartScriptPath(), process.execPath]);
    const clock = makeFakeClock();
    const watcher = createClaudeSettingsWatcher({
      fs: {
        watch() { const w = new EventEmitter(); w.close = () => {}; return w; },
        readFileSync() { return settingsRaw; },
        existsSync: (candidate) => existing.has(candidate),
        accessSync() {},
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      getHookServerPort: () => 23333,
      shouldManageClaudeHooks: () => true,
      isAgentEnabled: () => true,
      shouldSyncAgentIntegration: () => true,
      coreEvents: ["Stop"],
      autoStartWithClaude: true,
      syncClawdHooks: async () => {},
      // Only the state path is injected; auto-start must fall back to the real
      // getter so the bogus command is not silently accepted as healthy.
      expectedHookScriptPath: hookPath,
    });
    watcher.start();
    await watcher.checkNow("test");
    const status = watcher.getHealthStatus();
    assert.notStrictEqual(status.status, "healthy", JSON.stringify(status));
    assert.ok(
      status.issues.some((issue) => issue.code === "auto-start-path-missing"),
      JSON.stringify(status.issues)
    );
    watcher.stop();
  });

  it("fails closed on an injected non-writable fs for AppImage materialization", async () => {
    const settingsRaw = JSON.stringify({ hooks: {} });
    const clock = makeFakeClock();
    const watcher = createClaudeSettingsWatcher({
      fs: {
        watch() { const w = new EventEmitter(); w.close = () => {}; return w; },
        readFileSync() { return settingsRaw; },
        existsSync() { return true; },
        accessSync() {},
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      getHookServerPort: () => 23333,
      shouldManageClaudeHooks: () => true,
      isAgentEnabled: () => true,
      shouldSyncAgentIntegration: () => true,
      coreEvents: ["Stop"],
      autoStartWithClaude: false,
      syncClawdHooks: async () => {},
      platform: "linux",
      processEnv: { APPIMAGE, APPDIR },
      homeDir: tempDir(),
      materializedRoot: path.join(tempDir(), "appimage-hooks"),
      claudeSettingsPath: path.join(tempDir(), "settings.json"),
    });
    watcher.start();
    await watcher.checkNow("test");
    const status = watcher.getHealthStatus();
    assert.strictEqual(status.status, "degraded");
    assert.strictEqual(status.degradedReason, "resolver-fs-inconsistent");
    watcher.stop();
  });
});
