const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerHooks, unregisterHooks, __test } = require("../hooks/install");
const {
  parseClaudeVersion,
  getWindowsClaudePathSuffixes,
  getClaudePathCandidates,
  getClaudePackageJsonCandidates,
  getClaudeVersionFromPackageJson,
  readClaudeVersionFallback,
} = __test;

const tempDirs = [];

function makeTempSettings(initialSettings = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-install-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function getCommandHookEntries(settings, event, marker) {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const hooks = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes(marker)) {
      hooks.push(entry);
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === "string" && hook.command.includes(marker)) {
        hooks.push(hook);
      }
    }
  }
  return hooks;
}

function getClawdCommands(settings, event) {
  return getCommandHookEntries(settings, event, "clawd-hook.js").map((hook) => hook.command);
}

function getHttpUrls(settings, event) {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const urls = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && typeof entry.url === "string") {
      urls.push(entry.url);
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook === "object" && hook.type === "http" && typeof hook.url === "string") {
        urls.push(hook.url);
      }
    }
  }
  return urls;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Claude version detection helpers", () => {
  it("extracts semver from Claude version output", () => {
    assert.strictEqual(parseClaudeVersion("2.1.109 (Claude Code)"), "2.1.109");
    assert.strictEqual(parseClaudeVersion("Claude Code vnext"), null);
    assert.strictEqual(parseClaudeVersion(null), null);
  });

  it("normalizes Windows PATHEXT suffixes with stable order", () => {
    assert.deepStrictEqual(
      getWindowsClaudePathSuffixes(".EXE;.Cmd;;BAT;.ps1"),
      ["", ".cmd", ".ps1", ".exe", ".bat"]
    );
  });

  it("finds existing Windows Claude shims from PATH and de-dupes case-insensitively", () => {
    const npmDir = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
    const npmDirUpper = "C:\\USERS\\Tester\\AppData\\Roaming\\NPM";
    const toolsDir = "C:\\Tools";
    const existing = new Set([
      path.join(npmDir, "claude.cmd").toLowerCase(),
      path.join(toolsDir, "claude.ps1").toLowerCase(),
    ]);

    const candidates = getClaudePathCandidates({
      platform: "win32",
      pathEnv: `"${npmDir}";${npmDirUpper};${toolsDir}`,
      pathExt: ".CMD;.Ps1",
      existsSync(candidatePath) {
        return existing.has(candidatePath.toLowerCase());
      },
    });

    assert.deepStrictEqual(candidates, [
      path.join(npmDir, "claude.cmd"),
      path.join(toolsDir, "claude.ps1"),
    ]);
  });

  it("finds existing POSIX Claude binaries from PATH", () => {
    const localDir = "/usr/local/bin";
    const optDir = "/opt/claude/bin";

    const candidates = getClaudePathCandidates({
      platform: "linux",
      pathEnv: `${localDir}:${optDir}`,
      existsSync(candidatePath) {
        return candidatePath === path.join(optDir, "claude");
      },
    });

    assert.deepStrictEqual(candidates, [path.join(optDir, "claude")]);
  });

  it("collects Claude package.json candidates from sibling node_modules and realpath targets", () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.dirname(candidatePath);
    const siblingPackageJson = path.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.join(path.dirname(realpathCli), "package.json");

    const candidates = getClaudePackageJsonCandidates(candidatePath, {
      platform: "win32",
      existsSync(packageJsonPath) {
        return packageJsonPath === siblingPackageJson || packageJsonPath === realpathPackageJson;
      },
      realpathSync(targetPath) {
        assert.strictEqual(targetPath, candidatePath);
        return realpathCli;
      },
      statSync() {
        return { size: 512, isFile: () => true };
      },
      readFileSync(targetPath) {
        assert.strictEqual(targetPath, candidatePath);
        return '@ECHO off\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n';
      },
    });

    assert.deepStrictEqual(candidates, [
      siblingPackageJson,
      realpathPackageJson,
    ]);
  });

  it("skips reading unusually large shim files", () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.dirname(candidatePath);
    const siblingPackageJson = path.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    let readCount = 0;

    const candidates = getClaudePackageJsonCandidates(candidatePath, {
      platform: "win32",
      existsSync(packageJsonPath) {
        return packageJsonPath === siblingPackageJson;
      },
      realpathSync() {
        throw new Error("no symlink");
      },
      statSync() {
        return { size: 1024 * 1024, isFile: () => true };
      },
      readFileSync() {
        readCount++;
        throw new Error("should not read large shims");
      },
    });

    assert.strictEqual(readCount, 0);
    assert.deepStrictEqual(candidates, [siblingPackageJson]);
  });

  it("reads Claude version from package.json when it contains a semver", () => {
    const packageJsonPath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json";

    assert.deepStrictEqual(
      getClaudeVersionFromPackageJson(packageJsonPath, {
        readFileSync(targetPath) {
          assert.strictEqual(targetPath, packageJsonPath);
          return JSON.stringify({ version: "2.1.109" });
        },
      }),
      {
        version: "2.1.109",
        source: packageJsonPath,
        status: "known",
      }
    );

    assert.strictEqual(
      getClaudeVersionFromPackageJson(packageJsonPath, {
        readFileSync() {
          return JSON.stringify({ version: "latest" });
        },
      }),
      null
    );
  });

  it("returns the first valid fallback version info from candidate package.json files", () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.dirname(candidatePath);
    const siblingPackageJson = path.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.join(path.dirname(realpathCli), "package.json");

    const result = readClaudeVersionFallback(candidatePath, {
      platform: "win32",
      existsSync(packageJsonPath) {
        return packageJsonPath === siblingPackageJson || packageJsonPath === realpathPackageJson;
      },
      realpathSync() {
        return realpathCli;
      },
      statSync() {
        return { size: 256, isFile: () => true };
      },
      readFileSync(targetPath) {
        if (targetPath === candidatePath) {
          return '@ECHO off\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n';
        }
        if (targetPath === siblingPackageJson) {
          return JSON.stringify({ version: "latest" });
        }
        if (targetPath === realpathPackageJson) {
          return JSON.stringify({ version: "2.1.109" });
        }
        throw new Error(`unexpected read: ${targetPath}`);
      },
    });

    assert.deepStrictEqual(result, {
      version: "2.1.109",
      source: realpathPackageJson,
      status: "known",
    });
  });
});

describe("Hook installer version compatibility", () => {
  it("uses PowerShell-safe command hooks on Windows", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(stopHooks.length, 1);
    assert.strictEqual(stopHooks[0].shell, "powershell");
    assert.ok(stopHooks[0].command.startsWith('& "node" "'), stopHooks[0].command);
    assert.ok(stopHooks[0].command.endsWith('" Stop'), stopHooks[0].command);
  });

  it("keeps remote hooks on the legacy bash-compatible format", () => {
    const hook = __test.buildCommandHookSpec("node", "/tmp/clawd-hook.js", "Stop", {
      platform: "win32",
      remote: true,
    });

    assert.deepStrictEqual(hook, {
      type: "command",
      command: 'CLAWD_REMOTE=1 "node" "/tmp/clawd-hook.js" Stop',
    });
  });

  it("does not add a shell field for non-Windows hook registration", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      platform: "linux",
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(stopHooks.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(stopHooks[0], "shell"));
    assert.ok(stopHooks[0].command.startsWith('"/usr/bin/node" "'), stopHooks[0].command);
  });

  it("registers StopFailure when Claude Code is >= 2.1.78", () => {
    const settingsPath = makeTempSettings({});
    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(Array.isArray(settings.hooks.StopFailure));
    assert.deepStrictEqual(getClawdCommands(settings, "StopFailure").length, 1);
    assert.strictEqual(result.versionStatus, "known");
    assert.strictEqual(result.version, "2.1.78");
  });

  it("keeps PreCompact/PostCompact but skips StopFailure below 2.1.78", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.76", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(Array.isArray(settings.hooks.PreCompact));
    assert.ok(Array.isArray(settings.hooks.PostCompact));
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "StopFailure"));
  });

  it("fails closed when Claude Code version is unknown", () => {
    const settingsPath = makeTempSettings({});
    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: null, source: null, status: "unknown" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "PreCompact"));
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "PostCompact"));
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "StopFailure"));
    assert.strictEqual(result.versionStatus, "unknown");
  });

  it("removes stale Clawd StopFailure hooks while preserving third-party entries when version is known too old", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        StopFailure: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" StopFailure' }],
          },
        ],
        PostCompact: [],
        PreCompact: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/third-party-hook.js" PreCompact' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.75", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "StopFailure"));
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "PostCompact"));
    assert.ok(Array.isArray(settings.hooks.PreCompact));
    assert.strictEqual(settings.hooks.PreCompact[0].hooks[0].command.includes("third-party-hook.js"), true);
    assert.strictEqual(result.removed, 1);
  });

  it("keeps existing versioned hooks when Claude Code version is unknown", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        StopFailure: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" StopFailure' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: null, source: null, status: "unknown" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(Array.isArray(settings.hooks.StopFailure));
    assert.strictEqual(getClawdCommands(settings, "StopFailure").length, 1);
    assert.strictEqual(result.removed, 0);
  });

  it("updates stale hook paths when command marker already exists", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/old/path/clawd-hook.js" Stop' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const commands = getClawdCommands(settings, "Stop");
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(commands.length, 1);
    assert.ok(commands[0].includes('hooks/clawd-hook.js'));
    assert.ok(!commands[0].includes('/old/path/'));
  });

  it("updates stale Windows hook commands to PowerShell format", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '"node" "/old/path/clawd-hook.js" Stop' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(stopHooks.length, 1);
    assert.strictEqual(stopHooks[0].shell, "powershell");
    assert.ok(stopHooks[0].command.startsWith("& "), stopHooks[0].command);
    assert.ok(!stopHooks[0].command.includes("/old/path/"));
  });

  it("removes stale powershell shell metadata on non-Windows", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{
              type: "command",
              shell: "powershell",
              command: '& "node" "/old/path/clawd-hook.js" Stop',
            }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      platform: "linux",
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(stopHooks.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(stopHooks[0], "shell"));
    assert.ok(stopHooks[0].command.startsWith('"/usr/bin/node" "'), stopHooks[0].command);
  });

  it("is idempotent on repeated registration", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
  });

  it("is idempotent on repeated Windows registration", () => {
    const settingsPath = makeTempSettings({});
    const first = registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.ok(first.added > 0, "first run should add hooks");

    const second = registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(stopHooks.length, 1);
    assert.strictEqual(stopHooks[0].shell, "powershell");
    assert.ok(stopHooks[0].command.startsWith("& "), stopHooks[0].command);
  });

  it("preserves existing absolute node path when detection fails", () => {
    const existingAbsPath = "/Users/tester/.nvm/versions/node/v20.11.0/bin/node";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `"${existingAbsPath}" "/app/hooks/clawd-hook.js" Stop` }],
          },
        ],
      },
    });

    // nodeBin: null simulates resolveNodeBin() failing in Electron
    const result = registerHooks({
      silent: true,
      settingsPath,
      nodeBin: null,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const commands = getClawdCommands(settings, "Stop");
    assert.strictEqual(commands.length, 1);
    // Must still contain the original absolute nvm path, NOT bare "node"
    assert.ok(commands[0].includes(existingAbsPath), `expected ${existingAbsPath} in: ${commands[0]}`);
    assert.ok(!commands[0].startsWith('"node"'), "should not downgrade to bare node");
  });

  it("uses PowerShell-safe auto-start hooks on Windows", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      autoStart: true,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const autoStartHooks = getCommandHookEntries(settings, "SessionStart", "auto-start.js");
    assert.strictEqual(autoStartHooks.length, 1);
    assert.strictEqual(autoStartHooks[0].shell, "powershell");
    assert.ok(autoStartHooks[0].command.startsWith('& "node" "'), autoStartHooks[0].command);
  });

  it("updates stale Windows auto-start hooks to PowerShell format", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '"node" "/old/path/auto-start.js"' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      autoStart: true,
      platform: "win32",
      nodeBin: "node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const autoStartHooks = getCommandHookEntries(settings, "SessionStart", "auto-start.js");
    assert.ok(result.updated >= 1);
    assert.strictEqual(autoStartHooks.length, 1);
    assert.strictEqual(autoStartHooks[0].shell, "powershell");
    assert.ok(autoStartHooks[0].command.startsWith("& "), autoStartHooks[0].command);
    assert.ok(!autoStartHooks[0].command.includes("/old/path/"));
  });

  it("checks macOS absolute Claude paths before PATH fallback", () => {
    const attempted = [];
    const expectedPath = path.join("/Users/tester", ".claude", "local", "claude");
    const info = __test.getClaudeVersion({
      platform: "darwin",
      homeDir: "/Users/tester",
      execFileSync(command) {
        attempted.push(command);
        if (command === expectedPath) return "Claude Code 2.1.78\n";
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      },
    });

    assert.deepStrictEqual(attempted, [
      path.join("/Users/tester", ".local", "bin", "claude"),
      expectedPath,
    ]);
    assert.deepStrictEqual(info, {
      version: "2.1.78",
      source: expectedPath,
      status: "known",
    });
  });

  it("falls back to npm shim sibling package.json on Windows when exec fails", () => {
    const shimDir = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
    const shimPath = path.join(shimDir, "claude.cmd");
    const packageJsonPath = path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const attempted = [];

    const info = __test.getClaudeVersion({
      platform: "win32",
      pathEnv: shimDir,
      pathExt: ".CMD",
      existsSync(candidatePath) {
        return candidatePath === shimPath || candidatePath === packageJsonPath;
      },
      execFileSync(command) {
        attempted.push(command);
        const err = new Error("spawnSync failed");
        err.code = "EPERM";
        throw err;
      },
      statSync(targetPath) {
        assert.strictEqual(targetPath, shimPath);
        return { size: 512, isFile: () => true };
      },
      readFileSync(targetPath) {
        if (targetPath === shimPath) {
          return '@ECHO off\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n';
        }
        if (targetPath === packageJsonPath) {
          return JSON.stringify({ version: "2.1.109" });
        }
        throw new Error(`unexpected read: ${targetPath}`);
      },
      realpathSync() {
        throw new Error("not a symlink");
      },
    });

    assert.deepStrictEqual(attempted, [shimPath, "claude"]);
    assert.deepStrictEqual(info, {
      version: "2.1.109",
      source: packageJsonPath,
      status: "known",
    });
  });

  it("prefers a later exec-based version over an earlier metadata fallback", () => {
    const oldShimDir = "C:\\OldClaude";
    const newShimDir = "C:\\NewClaude";
    const oldShimPath = path.join(oldShimDir, "claude.cmd");
    const newShimPath = path.join(newShimDir, "claude.cmd");
    const oldPackageJsonPath = path.join(oldShimDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");

    const info = __test.getClaudeVersion({
      platform: "win32",
      pathEnv: `${oldShimDir};${newShimDir}`,
      pathExt: ".CMD",
      existsSync(candidatePath) {
        return candidatePath === oldShimPath
          || candidatePath === newShimPath
          || candidatePath === oldPackageJsonPath;
      },
      execFileSync(command) {
        if (command === oldShimPath || command === "claude") {
          const err = new Error("spawnSync failed");
          err.code = "EPERM";
          throw err;
        }
        if (command === newShimPath) return "2.1.109 (Claude Code)\n";
        throw new Error(`unexpected exec: ${command}`);
      },
      statSync(targetPath) {
        if (targetPath === oldShimPath) return { size: 512, isFile: () => true };
        throw new Error(`unexpected stat: ${targetPath}`);
      },
      readFileSync(targetPath) {
        if (targetPath === oldShimPath) {
          return '@ECHO off\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n';
        }
        if (targetPath === oldPackageJsonPath) {
          return JSON.stringify({ version: "2.1.5" });
        }
        throw new Error(`unexpected read: ${targetPath}`);
      },
      realpathSync() {
        throw new Error("not a symlink");
      },
    });

    assert.deepStrictEqual(info, {
      version: "2.1.109",
      source: newShimPath,
      status: "known",
    });
  });
});

describe("Hook installer deprecated hook cleanup", () => {
  it("does not register WorktreeCreate on fresh install (issue #127)", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.112", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(settings.hooks, "WorktreeCreate"),
      "WorktreeCreate should not be registered"
    );
  });

  it("removes stale Clawd WorktreeCreate hook while preserving user-authored entries", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        WorktreeCreate: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" WorktreeCreate' }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/user-worktree.js" WorktreeCreate' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.112", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(Array.isArray(settings.hooks.WorktreeCreate), "user entry should be preserved");
    assert.strictEqual(settings.hooks.WorktreeCreate.length, 1);
    assert.strictEqual(
      settings.hooks.WorktreeCreate[0].hooks[0].command,
      'node "/tmp/user-worktree.js" WorktreeCreate'
    );
    assert.strictEqual(getClawdCommands(settings, "WorktreeCreate").length, 0);
    assert.ok(result.removed >= 1);
  });

  it("deletes WorktreeCreate key when the only entry was the Clawd hook", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        WorktreeCreate: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" WorktreeCreate' }],
          },
        ],
      },
    });

    registerHooks({
      silent: true,
      settingsPath,
      claudeVersionInfo: { version: "2.1.112", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "WorktreeCreate"));
  });
});

describe("Hook installer unregisterHooks", () => {
  it("removes Clawd command hooks, HTTP hook, and auto-start while preserving third-party hooks", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", shell: "powershell", command: '& "node" "/tmp/auto-start.js"' }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", shell: "powershell", command: '& "node" "/tmp/clawd-hook.js" SessionStart' }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/third-party.js" SessionStart' }],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", shell: "powershell", command: '& "node" "/tmp/clawd-hook.js" Stop' }],
          },
        ],
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:23335/permission", timeout: 600 }],
          },
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://localhost:8080/permission", timeout: 100 }],
          },
        ],
      },
    });

    const result = unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.deepStrictEqual(result, { removed: 4, changed: true });
    assert.deepStrictEqual(getClawdCommands(settings, "SessionStart"), []);
    assert.deepStrictEqual(getClawdCommands(settings, "Stop"), []);
    assert.deepStrictEqual(
      settings.hooks.SessionStart[0].hooks[0].command,
      'node "/tmp/third-party.js" SessionStart'
    );
    assert.deepStrictEqual(getHttpUrls(settings, "PermissionRequest"), ["http://localhost:8080/permission"]);
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "Stop"));
  });

  it("keeps third-party PermissionRequest hooks when no Clawd HTTP hook is present", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://localhost:8080/permission", timeout: 600 }],
          },
        ],
      },
    });

    const result = unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.deepStrictEqual(result, { removed: 0, changed: false });
    assert.deepStrictEqual(getHttpUrls(settings, "PermissionRequest"), ["http://localhost:8080/permission"]);
  });

  it("recognizes stale Clawd PermissionRequest URLs on any managed port", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:23337/permission", timeout: 600 }],
          },
        ],
      },
    });

    const result = unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.deepStrictEqual(result, { removed: 1, changed: true });
    assert.deepStrictEqual(settings.hooks, {});
  });

  it("is idempotent when run repeatedly", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
          },
        ],
      },
    });

    const first = unregisterHooks({ settingsPath });
    const second = unregisterHooks({ settingsPath });

    assert.deepStrictEqual(first, { removed: 1, changed: true });
    assert.deepStrictEqual(second, { removed: 0, changed: false });
  });

  it("keeps empty hooks object when every Clawd entry is removed", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
          },
        ],
      },
    });

    unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.deepStrictEqual(settings.hooks, {});
  });
});
