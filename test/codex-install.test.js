const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const {
  CODEX_OFFICIAL_HOOK_EVENTS,
  CODEX_STATE_HOOK_EVENTS,
  buildCodexStateHookCommand,
  registerCodexHooks,
  unregisterCodexHooks,
} = require("../hooks/codex-install");
const {
  CODEX_WSL_INTEROP_ARG,
  CODEX_WINDOWS_STABLE_ARG,
  buildCodexHookCommand,
  buildStableCodexHookCommand,
  inspectStableCodexHookCommand,
  materializeAppImageHookScript,
  materializeStableCodexHookLauncher,
  readStableCodexHookManifest,
  removeStableCodexHookLauncher,
  stableCodexHookPaths,
  windowsPathToWslPath,
} = require("../hooks/codex-install-utils");
const { CODEX_DEBUG_HOOK_EVENTS, registerCodexDebugHooks } = require("../hooks/codex-debug-install");

const MARKER = "codex-hook.js";
const DEBUG_MARKER = "codex-debug-hook.js";
const tempDirs = [];

function makeTempCodexDir(initialHooks = null, configText = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-install-"));
  const codexDir = path.join(tmpDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  if (initialHooks !== null) {
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(initialHooks, null, 2), "utf8");
  }
  if (configText !== null) {
    fs.writeFileSync(path.join(codexDir, "config.toml"), configText, "utf8");
  }
  tempDirs.push(tmpDir);
  return codexDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Codex official hook installer", () => {
  it("keeps one stable artifact path while packaged/dev targets change", () => {
    const codexDir = makeTempCodexDir({});
    const sourceRoot = path.join(path.dirname(codexDir), "sources");
    const firstTarget = path.join(sourceRoot, "packaged", "codex-hook.js");
    const secondTarget = path.join(sourceRoot, "dev-branch", "codex-hook.js");
    fs.mkdirSync(path.dirname(firstTarget), { recursive: true });
    fs.mkdirSync(path.dirname(secondTarget), { recursive: true });
    fs.writeFileSync(firstTarget, 'process.stdout.write("packaged");\n', "utf8");
    fs.writeFileSync(secondTarget, 'process.stdout.write("dev-branch");\n', "utf8");

    const first = materializeStableCodexHookLauncher(firstTarget, {
      codexDir,
      nodeBin: process.execPath,
      platform: process.platform,
    });
    const artifactCommand = buildStableCodexHookCommand(first.launcherPath, process.platform);
    const launcherSource = fs.readFileSync(first.launcherPath, "utf8");
    const second = materializeStableCodexHookLauncher(secondTarget, {
      codexDir,
      nodeBin: process.execPath,
      platform: process.platform,
    });

    assert.strictEqual(second.launcherPath, first.launcherPath);
    assert.strictEqual(buildStableCodexHookCommand(second.launcherPath, process.platform), artifactCommand);
    assert.notStrictEqual(fs.readFileSync(second.launcherPath, "utf8"), launcherSource);
    assert.strictEqual(readStableCodexHookManifest(second.manifestPath).record.target, path.resolve(secondTarget));
    if (process.platform === "win32") {
      assert.strictEqual(
        readStableCodexHookManifest(second.manifestPath).record.target,
        path.resolve(secondTarget)
      );
    } else {
      const run = spawnSync("/bin/sh", [second.launcherPath], { encoding: "utf8" });
      assert.strictEqual(run.status, 0);
      assert.strictEqual(run.stdout, "dev-branch");
    }
  });

  it("cleans the stable launcher beside an explicit hooksPath", () => {
    const codexDir = makeTempCodexDir({});
    const target = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const stable = materializeStableCodexHookLauncher(target, {
      codexDir,
      nodeBin: process.execPath,
      platform: process.platform,
    });

    const result = removeStableCodexHookLauncher({
      hooksPath: path.join(codexDir, "hooks.json"),
      env: { CODEX_HOME: path.join(path.dirname(codexDir), "wrong-home") },
    });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(fs.existsSync(stable.stableDir), false);
  });

  it("cleans a BOM-prefixed v2 Windows launcher during migration/uninstall", () => {
    const codexDir = makeTempCodexDir({});
    const stable = stableCodexHookPaths(codexDir, { platform: "win32" });
    fs.mkdirSync(stable.stableDir, { recursive: true });
    fs.writeFileSync(
      stable.legacyWindowsLauncherPath,
      "\uFEFF# clawd-codex-stable-launcher-v2\n# clawd-generation:legacy\n",
      "utf8"
    );

    const result = removeStableCodexHookLauncher({ codexDir });

    assert.strictEqual(result.launcherRemoved, 1);
    assert.strictEqual(fs.existsSync(stable.legacyWindowsLauncherPath), false);
    assert.strictEqual(fs.existsSync(stable.stableDir), false);
  });

  it("materializes AppImage hook closure outside the transient FUSE mount", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-appimage-hook-"));
    tempDirs.push(tmpDir);
    const sourceDir = path.join(tmpDir, ".mount_Clawd", "hooks");
    const materializedRoot = path.join(tmpDir, "stable-hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "entry.js"), 'require("./dep");\n', "utf8");
    fs.writeFileSync(path.join(sourceDir, "dep.js"), 'require("node:path");\n', "utf8");
    fs.writeFileSync(path.join(sourceDir, "runtime-helper.js"), 'require("./runtime-dep");\n', "utf8");
    fs.writeFileSync(path.join(sourceDir, "runtime-dep.js"), 'module.exports = true;\n', "utf8");

    const target = materializeAppImageHookScript(path.join(sourceDir, "entry.js"), {
      appImagePath: "/opt/Clawd-on-Desk.AppImage",
      materializedRoot,
      extraEntryPaths: [path.join(sourceDir, "runtime-helper.js")],
    });

    assert.ok(target.startsWith(`${materializedRoot}${path.sep}`));
    assert.ok(!target.includes(".mount_Clawd"));
    assert.strictEqual(fs.readFileSync(target, "utf8"), 'require("./dep");\n');
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(target), "dep.js"), "utf8"), 'require("node:path");\n');
    assert.strictEqual(
      fs.readFileSync(path.join(path.dirname(target), "runtime-helper.js"), "utf8"),
      'require("./runtime-dep");\n'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(path.dirname(target), "runtime-dep.js"), "utf8"),
      "module.exports = true;\n"
    );
    assert.strictEqual(
      fs.readFileSync(path.join(path.dirname(target), ".clawd-appimage-path"), "utf8"),
      "/opt/Clawd-on-Desk.AppImage\n"
    );
    assert.strictEqual(materializeAppImageHookScript(path.join(sourceDir, "entry.js"), {
      appImagePath: "/opt/Clawd-on-Desk.AppImage",
      materializedRoot,
      extraEntryPaths: [path.join(sourceDir, "runtime-helper.js")],
    }), target);

    fs.rmSync(path.join(path.dirname(target), "runtime-helper.js"));
    assert.strictEqual(materializeAppImageHookScript(path.join(sourceDir, "entry.js"), {
      appImagePath: "/opt/Clawd-on-Desk.AppImage",
      materializedRoot,
      extraEntryPaths: [path.join(sourceDir, "runtime-helper.js")],
    }), target);
    assert.ok(fs.existsSync(path.join(path.dirname(target), "runtime-helper.js")));
  });

  it("registers an AppImage Codex hook from the materialized stable path", () => {
    const codexDir = makeTempCodexDir({});
    const materializedRoot = path.join(path.dirname(codexDir), "stable-hooks");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/bin/node",
      platform: "linux",
      processEnv: { APPIMAGE: "/opt/Clawd-on-Desk.AppImage" },
      materializedRoot,
    });

    const command = readJson(path.join(codexDir, "hooks.json"))
      .hooks.SessionStart[0].hooks[0].command;
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "linux" });
    assert.strictEqual(command, buildStableCodexHookCommand(stablePaths.launcherPath, "linux"));
    assert.ok(!command.includes("app.asar.unpacked"));
    assert.strictEqual(command.split("codex-hook.js.sh").length - 1, 1);
    const stableHook = result.stableLauncher.target;
    assert.ok(stableHook.includes(materializedRoot));
    assert.ok(fs.existsSync(result.stableLauncher.launcherPath));
    assert.ok(fs.existsSync(stableHook));
    const stableAutoStart = path.join(path.dirname(stableHook), "auto-start.js");
    assert.ok(fs.existsSync(stableAutoStart));
    assert.doesNotThrow(() => require(stableAutoStart));
    assert.strictEqual(
      fs.readFileSync(path.join(path.dirname(stableHook), ".clawd-appimage-path"), "utf8"),
      "/opt/Clawd-on-Desk.AppImage\n"
    );
  });

  it("registers official hook events on fresh install including PermissionRequest", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_STATE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(CODEX_STATE_HOOK_EVENTS, CODEX_OFFICIAL_HOOK_EVENTS);

    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "matcher"), false);
      const hook = entry.hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.strictEqual(hook.timeout, event === "PermissionRequest" ? 600 : 30);
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/bin/sh"));
      assert.ok(!hook.command.includes("/usr/local/bin/node"));
    }
    const manifest = readStableCodexHookManifest(
      stableCodexHookPaths(codexDir, { platform: "linux" }).manifestPath
    );
    assert.strictEqual(manifest.ok, true);
    assert.strictEqual(manifest.record.nodeBin, "/usr/local/bin/node");
  });

  it("does not rewrite trusted commands when the resolved Node executable changes", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/opt/node-v20/bin/node", platform: "linux" });
    const hooksPath = path.join(codexDir, "hooks.json");
    const before = fs.readFileSync(hooksPath, "utf8");

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/opt/node-v22/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    const manifest = readStableCodexHookManifest(
      stableCodexHookPaths(codexDir, { platform: "linux" }).manifestPath
    );
    assert.strictEqual(manifest.record.nodeBin, "/opt/node-v22/bin/node");
  });

  it("repairs a damaged stable execution artifact without rewriting trusted commands", () => {
    const codexDir = makeTempCodexDir({});
    const options = {
      silent: true,
      codexDir,
      nodeBin: process.execPath,
      platform: process.platform,
    };
    registerCodexHooks(options);
    const hooksPath = path.join(codexDir, "hooks.json");
    const before = fs.readFileSync(hooksPath, "utf8");
    const stable = stableCodexHookPaths(codexDir, { platform: process.platform });
    fs.appendFileSync(stable.launcherPath, "# damaged\n", "utf8");
    const installedHook = readJson(hooksPath).hooks.SessionStart[0].hooks[0];
    const command = process.platform === "win32" ? installedHook.commandWindows : installedHook.command;
    if (process.platform === "win32") {
      // The Windows stable entry is now a direct call-operator command
      // (Defender ML false positive fix, clawd-on-desk#986); its data sidecar
      // is validated through the managed artifacts, not by parsing the
      // command string, so a damaged sidecar no longer surfaces through
      // inspectStableCodexHookCommand.
      assert.strictEqual(
        inspectStableCodexHookCommand(command, { platform: "win32" }).matched,
        false
      );
      const damagedSource = fs.readFileSync(stable.launcherPath, "utf8");
      assert.ok(damagedSource.endsWith("# damaged\n"));
    } else {
      assert.strictEqual(
        inspectStableCodexHookCommand(command, { platform: process.platform }).issue,
        "stable-launcher-stale"
      );
    }

    const result = registerCodexHooks(options);

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
    if (process.platform === "win32") {
      // Re-registration repairs the managed sidecar without touching the
      // trusted command strings in hooks.json.
      const repairedSource = fs.readFileSync(stable.launcherPath, "utf8");
      assert.strictEqual(repairedSource.split("\n")[0], "clawd-codex-stable-windows-run-v1");
      assert.strictEqual(readStableCodexHookManifest(stable.windowsManifestPath).ok, true);
    } else {
      assert.strictEqual(
        inspectStableCodexHookCommand(command, { platform: process.platform }).ok,
        true
      );
    }
  });

  it("preserves the stable POSIX Node path when discovery temporarily fails", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/opt/clawd-node/bin/node",
      platform: "linux",
    });
    const hooksPath = path.join(codexDir, "hooks.json");
    const stable = stableCodexHookPaths(codexDir, { platform: "linux" });
    const hooksBefore = fs.readFileSync(hooksPath, "utf8");
    const wrapperBefore = fs.readFileSync(stable.launcherPath, "utf8");

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: null,
      platform: "linux",
    });

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), hooksBefore);
    assert.strictEqual(fs.readFileSync(stable.launcherPath, "utf8"), wrapperBefore);
    assert.strictEqual(
      readStableCodexHookManifest(stable.manifestPath).record.nodeBin,
      "/opt/clawd-node/bin/node"
    );
  });

  it("keeps Windows and WSL launcher ownership separate in a shared CODEX_HOME", () => {
    const codexDir = makeTempCodexDir({});
    const windowsTargetA = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const windowsTargetB = path.resolve(__dirname, "..", "hooks", "codex-debug-hook.js");
    const posixTarget = path.join(path.dirname(codexDir), "wsl-source", "codex-hook.js");
    fs.mkdirSync(path.dirname(posixTarget), { recursive: true });
    fs.writeFileSync(posixTarget, "process.stdout.write('{}');\n", "utf8");

    const firstWindows = materializeStableCodexHookLauncher(windowsTargetA, {
      codexDir,
      nodeBin: "C:\\node-v20\\node.exe",
      platform: "win32",
    });
    const windowsCommand = buildStableCodexHookCommand(firstWindows.windowsRunPath, "win32");
    const posixCommand = buildStableCodexHookCommand(
      windowsPathToWslPath(firstWindows.posixLauncherPath) || firstWindows.posixLauncherPath,
      "linux"
    );

    const wsl = materializeStableCodexHookLauncher(posixTarget, {
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });
    const posixSource = fs.readFileSync(wsl.posixLauncherPath, "utf8");
    const posixManifest = fs.readFileSync(wsl.posixManifestPath, "utf8");
    assert.strictEqual(readStableCodexHookManifest(wsl.posixManifestPath).record.mode, "native");

    const secondWindows = materializeStableCodexHookLauncher(windowsTargetB, {
      codexDir,
      nodeBin: "C:\\node-v22\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(secondWindows.posixPreserved, true);
    assert.strictEqual(fs.readFileSync(wsl.posixLauncherPath, "utf8"), posixSource);
    assert.strictEqual(fs.readFileSync(wsl.posixManifestPath, "utf8"), posixManifest);
    assert.strictEqual(buildStableCodexHookCommand(secondWindows.windowsRunPath, "win32"), windowsCommand);
    assert.strictEqual(
      buildStableCodexHookCommand(
        windowsPathToWslPath(secondWindows.posixLauncherPath) || secondWindows.posixLauncherPath,
        "linux"
      ),
      posixCommand
    );
    assert.strictEqual(
      readStableCodexHookManifest(secondWindows.windowsManifestPath).record.target,
      windowsTargetB
    );
  });

  it("preserves a WSL wrapper and reports invalid when its manifest metadata drifts", () => {
    const codexDir = makeTempCodexDir({});
    const windowsTarget = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const posixTarget = path.join(path.dirname(codexDir), "wsl-source", "codex-hook.js");
    fs.mkdirSync(path.dirname(posixTarget), { recursive: true });
    fs.writeFileSync(posixTarget, "process.stdout.write('{}');\n", "utf8");
    const wsl = materializeStableCodexHookLauncher(posixTarget, {
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });
    const posixSource = fs.readFileSync(wsl.posixLauncherPath, "utf8");
    const manifest = readJson(wsl.posixManifestPath);
    manifest.mode = "garbage";
    manifest.target = path.resolve(__dirname, "..", "hooks", "codex-debug-hook.js");
    fs.writeFileSync(wsl.posixManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const posixCommand = buildStableCodexHookCommand(wsl.posixLauncherPath, "linux");

    const inspection = inspectStableCodexHookCommand(posixCommand, { platform: "linux" });
    const windows = materializeStableCodexHookLauncher(windowsTarget, {
      codexDir,
      nodeBin: "C:\\node\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(inspection.ok, false);
    assert.strictEqual(inspection.issue, "stable-manifest-invalid");
    assert.strictEqual(windows.posixPreserved, true);
    assert.strictEqual(fs.readFileSync(wsl.posixLauncherPath, "utf8"), posixSource);
    assert.strictEqual(readJson(wsl.posixManifestPath).mode, "garbage");
  });

  it("is idempotent on second run", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    const before = fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8");

    const result = registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"), before);
  });

  it("coexists with debug hooks without updating them", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/opt/homebrew/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.ok(settings.hooks.PermissionRequest[0].hooks[0].command.includes(DEBUG_MARKER));
  });

  it("does not flip an explicit hooks=false", () => {
    const codexDir = makeTempCodexDir({}, "[features]\nhooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.configChanged, false);
    assert.match(result.warnings[0], /hooks = false/);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = false\n"
    );
  });

  it("migrates legacy codex_hooks=false without enabling it", () => {
    const codexDir = makeTempCodexDir({}, "[features]\ncodex_hooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.configChanged, true);
    assert.match(result.warnings[0], /hooks = false/);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = false\n"
    );
  });

  it("can force hooks=true during an explicit repair", () => {
    const codexDir = makeTempCodexDir({}, "[features]\nhooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      forceCodexHooksFeature: true,
    });

    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\nhooks = true\n"
    );
  });

  it("formats Windows commands for PowerShell execution", () => {
    const command = buildCodexStateHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/animation/hooks/codex-hook.js",
      "win32"
    );

    assert.strictEqual(command, '& "C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/codex-hook.js"');
  });

  it("registers remote hooks with CLAWD_REMOTE in the command environment", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      remote: true,
      sshRemote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.strictEqual(
      command,
      "CLAWD_REMOTE='1' CLAWD_SSH_REMOTE='1' \"/usr/local/bin/node\" \"" + path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/") + "\""
    );
  });

  it("keeps legacy WSL --remote on CLAWD_REMOTE without the SSH secure marker", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      remote: true,
      processEnv: {},
    });
    const command = readJson(path.join(codexDir, "hooks.json"))
      .hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /^CLAWD_REMOTE='1' /);
    assert.doesNotMatch(command, /CLAWD_SSH_REMOTE|CLAWD_REMOTE_IDENTITY_PATH/);
  });

  it("registers Windows remote hooks with a PowerShell env prefix on commandWindows only", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\node.exe",
      platform: "win32",
      remote: true,
      sshRemote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const hookScript = path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/");
    // PowerShell env prefix lives on commandWindows (what Windows codex runs).
    assert.strictEqual(
      hook.commandWindows,
      `$env:CLAWD_REMOTE='1'; $env:CLAWD_SSH_REMOTE='1'; & "C:\\node.exe" "${hookScript}"`
    );
    // The POSIX command must NOT carry an env prefix: env vars don't cross
    // the WSL interop boundary, so a prefix would only mislead readers.
    assert.strictEqual(hook.command, `"/mnt/c/node.exe" "${hookScript}" ${CODEX_WSL_INTEROP_ARG}`);
    assert.ok(result.warnings.some((w) => /interop/.test(w)));
  });

  it("unregisters only official state hooks", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(!commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.strictEqual(settings.hooks.PermissionRequest.length, 1);
    assert.strictEqual(CODEX_DEBUG_HOOK_EVENTS.includes("PermissionRequest"), true);
    assert.strictEqual(fs.existsSync(stableCodexHookPaths(codexDir).stableDir), false);
  });

  // Verifies the v0.7.x follow-up that points users at codex's `/hooks` review
  // step. Without this reminder, fresh installs leave hooks Active=0 and the
  // desktop pet stays silent until the user randomly discovers the review UI.
  it("emits a 'Next step: open codex CLI and run /hooks' reminder on non-silent install", () => {
    const codexDir = makeTempCodexDir({});
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: false,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    const joined = captured.join("\n");
    assert.match(joined, /Next step:.*codex.*\/hooks/i,
      "stdout must include the codex /hooks review reminder");
  });

  it("does NOT emit the reminder when silent: true (deploy / sync paths use silent)", () => {
    const codexDir = makeTempCodexDir({});
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: true,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(captured.length, 0, "silent install must not log reminder (or anything else)");
  });

  it("does NOT emit the reminder line on no-op re-install (summary lines still emit)", () => {
    // Semantics being asserted: "no-op re-install does not print the
    // /hooks-review reminder line". This is intentionally narrower than
    // "no-op re-install is fully silent on stdout" — `Clawd Codex hooks ->`
    // and `Added: 0, updated: 0, skipped: N` summary lines are useful for
    // CLI users who re-run the installer (they confirm the install is
    // already in place). Only the reminder is gated on actual changes,
    // so users don't get warning fatigue from re-running an idempotent
    // install.
    const codexDir = makeTempCodexDir({});
    // First install: changes happen, reminder fires.
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    // Second install: idempotent, nothing added/updated/configChanged.
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      registerCodexHooks({
        silent: false,
        codexDir,
        nodeBin: "/usr/local/bin/node",
        platform: "linux",
      });
    } finally {
      console.log = originalLog;
    }
    const joined = captured.join("\n");
    assert.equal(/Next step/i.test(joined), false,
      "no-op re-install must NOT print the reminder line");
    // Confirm summary lines DO still emit (this is the contract — keep
    // CLI feedback for users who want to verify the install state).
    assert.match(joined, /Clawd .* hooks/, "summary header should still print");
    assert.match(joined, /Added: 0/, "Added/updated/skipped count should still print");
  });
});

// #544: a hooks.json written by Windows Clawd may be shared with WSL codex
// through CODEX_HOME. Codex resolves commandWindows on Windows and command on
// POSIX, so Windows installs must write both fields: PowerShell syntax in
// commandWindows, a WSL-interop (Windows node.exe) form in command.
describe("Codex hooks on a Windows host write dual command fields (#544)", () => {
  const HOOK_SCRIPT = path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/");
  const {
    buildCodexHookPosixInteropCommand,
  } = require("../hooks/codex-install-utils");

  it("translates Windows absolute paths to WSL /mnt form", () => {
    assert.strictEqual(
      windowsPathToWslPath("C:\\Program Files\\nodejs\\node.exe"),
      "/mnt/c/Program Files/nodejs/node.exe"
    );
    assert.strictEqual(windowsPathToWslPath("D:/Tool/Clawd on Desk/x.js"), "/mnt/d/Tool/Clawd on Desk/x.js");
    assert.strictEqual(windowsPathToWslPath("node"), null);
    assert.strictEqual(windowsPathToWslPath("/usr/bin/node"), null);
  });

  it("builds the interop command from a bare node bin by appending .exe", () => {
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("node", "D:/x/codex-hook.js"),
      `"node.exe" "D:/x/codex-hook.js" ${CODEX_WSL_INTEROP_ARG}`
    );
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("node.exe", "D:/x/codex-hook.js"),
      `"node.exe" "D:/x/codex-hook.js" ${CODEX_WSL_INTEROP_ARG}`
    );
  });

  it("fresh Windows install writes a direct call-operator command and WSL wrapper command", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "win32" });
    const windowsManifest = readStableCodexHookManifest(stablePaths.windowsManifestPath).record;
    const windowsCommand = `${buildCodexHookCommand(
      windowsManifest.nodeBin,
      windowsManifest.target,
      "win32"
    )} ${CODEX_WINDOWS_STABLE_ARG}`;
    const posixCommand = buildStableCodexHookCommand(
      windowsPathToWslPath(stablePaths.posixLauncherPath) || stablePaths.posixLauncherPath,
      "linux"
    );
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(hook.commandWindows, windowsCommand);
      assert.strictEqual(hook.command, posixCommand);
    }
    assert.strictEqual(
      readStableCodexHookManifest(stablePaths.windowsManifestPath).record.nodeBin,
      "C:\\Program Files\\nodejs\\node.exe"
    );
    assert.strictEqual(
      readStableCodexHookManifest(stablePaths.posixManifestPath).record.mode,
      "windows-interop"
    );
    assert.ok(!windowsCommand.toLowerCase().includes("powershell.exe"));
    assert.ok(!windowsCommand.toLowerCase().includes("-file"));
    assert.ok(!fs.existsSync(stablePaths.legacyWindowsLauncherPath));
  });

  it("keeps stable Windows env in the sidecar instead of duplicating it in commandWindows", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      env: { CLAWD_TEST_ENV: "环境 ✓" },
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const stable = stableCodexHookPaths(codexDir, { platform: "win32" });
    const manifest = readStableCodexHookManifest(stable.windowsManifestPath).record;
    assert.strictEqual(
      hook.commandWindows,
      `${buildCodexHookCommand(manifest.nodeBin, manifest.target, "win32")} ${CODEX_WINDOWS_STABLE_ARG}`
    );
    assert.doesNotMatch(hook.commandWindows, /CLAWD_TEST_ENV|ReadAllLines|FromBase64String/);
    assert.deepStrictEqual(manifest.env, { CLAWD_TEST_ENV: "环境 ✓" });
  });

  it("updates stable Windows sidecar env without invalidating the trusted command", () => {
    const codexDir = makeTempCodexDir({});
    const options = {
      silent: true,
      codexDir,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    };
    registerCodexHooks({ ...options, env: { CLAWD_TEST_ENV: "first" } });
    const hooksPath = path.join(codexDir, "hooks.json");
    const commandBefore = readJson(hooksPath).hooks.SessionStart[0].hooks[0].commandWindows;

    const result = registerCodexHooks({ ...options, env: { CLAWD_TEST_ENV: "second" } });
    const commandAfter = readJson(hooksPath).hooks.SessionStart[0].hooks[0].commandWindows;
    const stable = stableCodexHookPaths(codexDir, { platform: "win32" });

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(commandAfter, commandBefore);
    assert.deepStrictEqual(
      readStableCodexHookManifest(stable.windowsManifestPath).record.env,
      { CLAWD_TEST_ENV: "second" }
    );
  });

  it("round-trips non-ASCII Windows sidecar data without executing the retired dispatcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-unicode-"));
    tempDirs.push(root);
    const unicodeRoot = path.join(root, "张三-ユーザー-café-O'Brien");
    const codexDir = path.join(unicodeRoot, ".codex");
    const target = path.join(unicodeRoot, "hook 源", "codex-hook.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      target,
      "let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { body += chunk; }); process.stdin.on('end', () => process.stdout.write(`${process.env.CLAWD_TEST_ENV}|${body}`));\n",
      "utf8"
    );

    const stable = materializeStableCodexHookLauncher(target, {
      codexDir,
      nodeBin: process.execPath,
      platform: "win32",
      env: { CLAWD_TEST_ENV: "环境 ✓" },
    });
    const command = buildStableCodexHookCommand(stable.windowsRunPath, "win32");
    assert.strictEqual(inspectStableCodexHookCommand(command, { platform: "win32" }).ok, true);
    const manifest = readStableCodexHookManifest(stable.windowsManifestPath).record;
    assert.strictEqual(manifest.target, path.resolve(target));
    assert.deepStrictEqual(manifest.env, { CLAWD_TEST_ENV: "环境 ✓" });
  });

  it("never registers the retired Windows data dispatcher as the active command", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "Z:\\clawd-missing-node\\node.exe",
      platform: "win32",
    });
    const hook = readJson(path.join(codexDir, "hooks.json")).hooks.SessionStart[0].hooks[0];
    assert.match(hook.commandWindows, /^& /);
    assert.match(hook.commandWindows, new RegExp(`${CODEX_WINDOWS_STABLE_ARG}$`));
    assert.doesNotMatch(hook.commandWindows, /ReadAllLines|FromBase64String|SetEnvironmentVariable|& \$n \$t/);
  });

  it("is idempotent on second Windows run", () => {
    const codexDir = makeTempCodexDir({});
    const opts = { silent: true, codexDir, nodeBin: "C:\\node.exe", platform: "win32" };
    registerCodexHooks(opts);
    const before = fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8");

    const result = registerCodexHooks(opts);

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"), before);
  });

  it("preserves the stable Windows Node path when discovery temporarily fails", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\clawd-node\\node.exe",
      platform: "win32",
    });
    const hooksPath = path.join(codexDir, "hooks.json");
    const stable = stableCodexHookPaths(codexDir, { platform: "win32" });
    const hooksBefore = fs.readFileSync(hooksPath, "utf8");
    const artifactBefore = fs.readFileSync(stable.launcherPath, "utf8");

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: null,
      platform: "win32",
    });

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), hooksBefore);
    assert.strictEqual(fs.readFileSync(stable.launcherPath, "utf8"), artifactBefore);
    assert.strictEqual(
      readStableCodexHookManifest(stable.manifestPath).record.nodeBin,
      "C:\\clawd-node\\node.exe"
    );
  });

  it("requires a fresh trusted command when the Windows Node path really changes", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({ silent: true, codexDir, nodeBin: "C:\\Node-A\\node.exe", platform: "win32" });
    const hooksPath = path.join(codexDir, "hooks.json");
    const before = readJson(hooksPath).hooks.SessionStart[0].hooks[0].commandWindows;

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\Node-B\\node.exe",
      platform: "win32",
    });
    const after = readJson(hooksPath).hooks.SessionStart[0].hooks[0].commandWindows;

    assert.strictEqual(result.updated, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.notStrictEqual(after, before);
    assert.match(after, /Node-B/);
  });

  it("upgrades a legacy Windows entry (PowerShell command, no commandWindows) in place", () => {
    const legacyCommand = `& "node" "${HOOK_SCRIPT}"`;
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: legacyCommand, timeout: 30 }] }],
      },
    });

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "node",
      platform: "win32",
    });

    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length - 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "win32" });
    // This one-time migration intentionally changes the trusted command. Once
    // reviewed, later packaged/dev/Node switches only update the wrapper.
    const windowsManifest = readStableCodexHookManifest(stablePaths.windowsManifestPath).record;
    assert.strictEqual(
      hook.commandWindows,
      `${buildCodexHookCommand(
        windowsManifest.nodeBin,
        windowsManifest.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
    );
    assert.strictEqual(
      hook.command,
      buildStableCodexHookCommand(
        windowsPathToWslPath(stablePaths.posixLauncherPath) || stablePaths.posixLauncherPath,
        "linux"
      )
    );
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
  });

  it("preserves a user-repaired node path found in commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: `"node.exe" "${HOOK_SCRIPT}"`,
            commandWindows: `& "E:\\custom\\node.exe" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: null, // force the extract-existing fallback
      platform: "win32",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "win32" });
    const windowsManifest = readStableCodexHookManifest(stablePaths.windowsManifestPath).record;
    assert.strictEqual(
      hook.commandWindows,
      `${buildCodexHookCommand(
        windowsManifest.nodeBin,
        windowsManifest.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
    );
    assert.strictEqual(
      readStableCodexHookManifest(stablePaths.windowsManifestPath).record.nodeBin,
      "E:\\custom\\node.exe"
    );
  });

  it("does not extract the derived /mnt interop path back as a node bin", () => {
    // command holds /mnt/c/... (derived); commandWindows holds the source of
    // truth. The fallback must not launder the POSIX form into commandWindows.
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: `"/mnt/c/tools/node.exe" "${HOOK_SCRIPT}"`,
            commandWindows: `& "C:\\tools\\node.exe" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({ silent: true, codexDir, nodeBin: null, platform: "win32" });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "win32" });
    const windowsManifest = readStableCodexHookManifest(stablePaths.windowsManifestPath).record;
    assert.strictEqual(
      hook.commandWindows,
      `${buildCodexHookCommand(
        windowsManifest.nodeBin,
        windowsManifest.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
    );
    assert.strictEqual(
      readStableCodexHookManifest(stablePaths.windowsManifestPath).record.nodeBin,
      "C:\\tools\\node.exe"
    );
  });

  it("POSIX installs never write commandWindows", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(hook, "commandWindows"), false);
    }
  });

  // codex review finding: a POSIX host must never claim an entry whose only
  // Clawd trace is a leftover commandWindows — its command may be a
  // third-party hook that reconciliation would silently overwrite.
  it("POSIX reconcile does not overwrite a third-party command with a leftover commandWindows", () => {
    const thirdParty = '"/usr/bin/some-other-tool" --flag';
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: thirdParty,
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const entries = settings.hooks.SessionStart;
    // The third-party hook survives untouched; Clawd appends its own entry.
    assert.strictEqual(entries[0].hooks[0].command, thirdParty);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries[1].hooks[0].command.includes(MARKER));
  });

  // codex review finding: uninstall must match commandWindows too, so a
  // hand-edited command cannot shield a still-live commandWindows.
  it("uninstall removes an entry whose marker only survives in commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: '"/usr/bin/edited-away" --by-hand',
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(settings.hooks, "SessionStart"), false);
  });

  // codex review finding: a UNC node path has no /mnt translation and a
  // POSIX shell cannot exec the raw backslash form — fall back to bare
  // node.exe via the interop PATH. Forward-slash UNC form included.
  it("falls back to bare node.exe for a UNC node path in the interop command", () => {
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("\\\\server\\share\\node.exe", "D:/x/codex-hook.js"),
      `"node.exe" "D:/x/codex-hook.js" ${CODEX_WSL_INTEROP_ARG}`
    );
    assert.strictEqual(
      buildCodexHookPosixInteropCommand("//server/share/node.exe", "D:/x/codex-hook.js"),
      `"node.exe" "D:/x/codex-hook.js" ${CODEX_WSL_INTEROP_ARG}`
    );
  });

  // Subagent review finding: an entry claimed through commandWindows whose
  // command was hand-edited (marker gone) must keep the user's command —
  // rewriting it would recreate the "reconcile wipes my manual fix" loop.
  it("preserves a hand-edited marker-less command while managing commandWindows", () => {
    const handEdit = '"/home/user/bin/my-codex-wrapper.sh"';
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command: handEdit,
            commandWindows: `& "node" "${HOOK_SCRIPT}"`,
            timeout: 30,
          }],
        }],
      },
    });

    registerCodexHooks({ silent: true, codexDir, nodeBin: "node", platform: "win32" });

    const settings = readJson(path.join(codexDir, "hooks.json"));
    const entries = settings.hooks.SessionStart;
    const stablePaths = stableCodexHookPaths(codexDir, { platform: "win32" });
    assert.strictEqual(entries.length, 1, "must not append a duplicate entry");
    assert.strictEqual(entries[0].hooks[0].command, handEdit);
    assert.strictEqual(
      entries[0].hooks[0].commandWindows,
      `${buildCodexHookCommand(
        readStableCodexHookManifest(stablePaths.windowsManifestPath).record.nodeBin,
        readStableCodexHookManifest(stablePaths.windowsManifestPath).record.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
    );
  });

  // Subagent review finding: uninstall must not drop an entry whose nested
  // hooks emptied out but whose top level still carries a third-party
  // commandWindows.
  it("uninstall keeps an entry with a third-party top-level commandWindows", () => {
    const codexDir = makeTempCodexDir({
      hooks: {
        SessionStart: [{
          commandWindows: '& "C:\\third\\party.exe"',
          hooks: [{ type: "command", command: `"node.exe" "${HOOK_SCRIPT}"`, timeout: 30 }],
        }],
      },
    });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, 1);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].commandWindows, '& "C:\\third\\party.exe"');
    assert.deepStrictEqual(settings.hooks.SessionStart[0].hooks, []);
  });

  // Subagent review finding: the interop warning must apply the same filter
  // withCommandEnv does — an env object contributing nothing (invalid keys,
  // nullish values) must not warn, since repair escalates warnings to error.
  it("does not emit the interop env warning for a no-op env object", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "node",
      platform: "win32",
      env: { FOO: undefined, "1BAD": "x" },
    });

    assert.ok(!result.warnings.some((w) => /interop/.test(w)), "no-op env must not warn");
  });
});
