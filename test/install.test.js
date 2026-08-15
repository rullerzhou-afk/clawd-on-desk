const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerHooks,
  unregisterHooks,
  registerHooksAsync,
  unregisterHooksAsync,
  registerClaudeStatusline,
  unregisterClaudeStatusline,
  STATUSLINE_MARKER,
  CLAUDE_CORE_HOOK_EVENTS,
  getClaudeHookScriptPath,
  getClaudeAutoStartScriptPath,
  __test,
} = require("../hooks/install");
const { buildPermissionUrl, SERVER_PORTS } = require("../hooks/server-config");
const { classifyManagedClaudeStateHookCommand } = require("../hooks/json-utils");
const {
  inspectClaudeHookHealth,
  buildClaudeRepairSignature,
} = require("../src/claude-hook-health");
const {
  parseClaudeVersion,
  getWindowsClaudePathSuffixes,
  getClaudePathCandidates,
  getClaudePathCandidatesAsync,
  getClaudePackageJsonCandidates,
  getClaudePackageJsonCandidatesAsync,
  getClaudeVersionFromPackageJson,
  getClaudeVersionFromPackageJsonAsync,
  readClaudeVersionFallback,
  readClaudeVersionFallbackAsync,
  getClaudeVersionAsync,
  isClawdPermissionUrl,
  parseClaudeInstallCliOptions,
} = __test;

// registerHooks derives the hook command format from real-environment WSL
// signals; clear them so command-format assertions stay deterministic when
// the suite itself runs inside WSL.
delete process.env.CLAWD_WSL_DISTRO;
delete process.env.WSL_DISTRO_NAME;

const tempDirs = [];

function secureRemoteIdentity(overrides = {}) {
  return {
    ok: true,
    version: 2,
    layoutVersion: 1,
    runtimeKey: "profile-a",
    profileId: "profile-a",
    installId: "a".repeat(64),
    remotePort: 23334,
    routingNonce: "b".repeat(64),
    deployedAt: 1,
    filePath: "/home/test/.claude/hooks/clawd-remote.json",
    ...overrides,
  };
}

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
    if (typeof entry.command === "string" && (!marker || entry.command.includes(marker))) {
      hooks.push(entry);
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === "string" && (!marker || hook.command.includes(marker))) {
        hooks.push(hook);
      }
    }
  }
  return hooks;
}

function getManagedStateHookEntries(settings, event) {
  return getCommandHookEntries(settings, event).filter((hook) => (
    classifyManagedClaudeStateHookCommand(hook.command, settings, event) !== null
  ));
}

function getClawdCommands(settings, event) {
  return getCommandHookEntries(settings, event, "clawd-hook.js").map((hook) => hook.command);
}

function getHttpUrls(settings, event) {
  return getHttpHookEntries(settings, event).map((hook) => hook.url);
}

function getHttpHookEntries(settings, event) {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const hooks = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && typeof entry.url === "string") {
      hooks.push(entry);
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook === "object" && hook.type === "http" && typeof hook.url === "string") {
        hooks.push(hook);
      }
    }
  }
  return hooks;
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

  it("reuses the in-flight async Claude version probe", async () => {
    let execCalls = 0;
    const execFile = async () => {
      execCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stdout: "Claude Code 2.1.109\n" };
    };

    const [a, b] = await Promise.all([
      getClaudeVersionAsync({
        platform: "linux",
        pathEnv: "",
        candidates: ["/usr/bin/claude"],
        execFile,
        resetCache: true,
      }),
      getClaudeVersionAsync({
        platform: "linux",
        pathEnv: "",
        candidates: ["/usr/bin/claude"],
        execFile,
      }),
    ]);

    assert.deepStrictEqual(a, b);
    assert.strictEqual(execCalls, 1);
  });

  it("reuses a cached async Claude version result after success", async () => {
    let execCalls = 0;
    const execFile = async () => {
      execCalls++;
      return { stdout: "Claude Code 2.1.109\n" };
    };

    const first = await getClaudeVersionAsync({
      platform: "linux",
      pathEnv: "",
      candidates: ["/usr/bin/claude"],
      execFile,
      resetCache: true,
    });
    const second = await getClaudeVersionAsync({
      platform: "linux",
      pathEnv: "",
      candidates: ["/usr/bin/claude"],
      execFile,
    });

    assert.strictEqual(first.version, "2.1.109");
    assert.deepStrictEqual(second, first);
    assert.strictEqual(execCalls, 1);
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
      path.win32.join(npmDir, "claude.cmd").toLowerCase(),
      path.win32.join(toolsDir, "claude.ps1").toLowerCase(),
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
      path.win32.join(npmDir, "claude.cmd"),
      path.win32.join(toolsDir, "claude.ps1"),
    ]);
  });

  it("finds existing Windows Claude shims asynchronously from PATH", async () => {
    const npmDir = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
    const npmDirUpper = "C:\\USERS\\Tester\\AppData\\Roaming\\NPM";
    const toolsDir = "C:\\Tools";
    const existing = new Set([
      path.win32.join(npmDir, "claude.cmd").toLowerCase(),
      path.win32.join(toolsDir, "claude.ps1").toLowerCase(),
    ]);

    const candidates = await getClaudePathCandidatesAsync({
      platform: "win32",
      pathEnv: `"${npmDir}";${npmDirUpper};${toolsDir}`,
      pathExt: ".CMD;.Ps1",
      async access(candidatePath) {
        if (!existing.has(candidatePath.toLowerCase())) {
          throw new Error(`missing: ${candidatePath}`);
        }
      },
    });

    assert.deepStrictEqual(candidates, [
      path.win32.join(npmDir, "claude.cmd"),
      path.win32.join(toolsDir, "claude.ps1"),
    ]);
  });

  it("finds existing POSIX Claude binaries from PATH", () => {
    const localDir = "/usr/local/bin";
    const optDir = "/opt/claude/bin";

    const candidates = getClaudePathCandidates({
      platform: "linux",
      pathEnv: `${localDir}:${optDir}`,
      existsSync(candidatePath) {
        return candidatePath === path.posix.join(optDir, "claude");
      },
    });

    assert.deepStrictEqual(candidates, [path.posix.join(optDir, "claude")]);
  });

  it("collects Claude package.json candidates from sibling node_modules and realpath targets", () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.win32.dirname(candidatePath);
    const siblingPackageJson = path.win32.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.win32.join(path.win32.dirname(realpathCli), "package.json");

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

  it("collects Claude package.json candidates asynchronously", async () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.win32.dirname(candidatePath);
    const siblingPackageJson = path.win32.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.win32.join(path.win32.dirname(realpathCli), "package.json");
    const existing = new Set([siblingPackageJson.toLowerCase(), realpathPackageJson.toLowerCase()]);

    const candidates = await getClaudePackageJsonCandidatesAsync(candidatePath, {
      platform: "win32",
      async access(packageJsonPath) {
        if (!existing.has(packageJsonPath.toLowerCase())) {
          throw new Error(`missing: ${packageJsonPath}`);
        }
      },
      async realpath(targetPath) {
        assert.strictEqual(targetPath, candidatePath);
        return realpathCli;
      },
      async stat() {
        return { size: 512, isFile: () => true };
      },
      async readFile(targetPath) {
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
    const candidateDir = path.win32.dirname(candidatePath);
    const siblingPackageJson = path.win32.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
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

  it("treats drive-less rooted Windows paths as absolute when collecting candidates", () => {
    const candidatePath = "\\npm\\claude.cmd";
    const siblingPackageJson = path.win32.join("\\npm", "node_modules", "@anthropic-ai", "claude-code", "package.json");

    const candidates = getClaudePackageJsonCandidates(candidatePath, {
      platform: "win32",
      existsSync(packageJsonPath) {
        return packageJsonPath === siblingPackageJson;
      },
      realpathSync() {
        throw new Error("not a symlink");
      },
      // Large size keeps the shim-read branch off: win32 resolve of drive-less rooted
      // bases prepends the cwd drive on real Windows, which would be host-dependent here.
      statSync() {
        return { size: 1024 * 1024, isFile: () => true };
      },
      readFileSync() {
        throw new Error("should not read large shims");
      },
    });

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

  it("reads Claude version from package.json asynchronously", async () => {
    const packageJsonPath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json";

    assert.deepStrictEqual(
      await getClaudeVersionFromPackageJsonAsync(packageJsonPath, {
        async readFile(targetPath) {
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
      await getClaudeVersionFromPackageJsonAsync(packageJsonPath, {
        async readFile() {
          return JSON.stringify({ version: "latest" });
        },
      }),
      null
    );
  });

  it("returns the first valid fallback version info from candidate package.json files", () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.win32.dirname(candidatePath);
    const siblingPackageJson = path.win32.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.win32.join(path.win32.dirname(realpathCli), "package.json");

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

  it("returns the first valid async fallback version info from candidate package.json files", async () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const candidateDir = path.win32.dirname(candidatePath);
    const siblingPackageJson = path.win32.join(candidateDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const realpathCli = "D:\\shim-store\\claude\\cli.js";
    const realpathPackageJson = path.win32.join(path.win32.dirname(realpathCli), "package.json");
    const existing = new Set([siblingPackageJson.toLowerCase(), realpathPackageJson.toLowerCase()]);

    const result = await readClaudeVersionFallbackAsync(candidatePath, {
      platform: "win32",
      async access(packageJsonPath) {
        if (!existing.has(packageJsonPath.toLowerCase())) {
          throw new Error(`missing: ${packageJsonPath}`);
        }
      },
      async realpath() {
        return realpathCli;
      },
      async stat() {
        return { size: 256, isFile: () => true };
      },
      async readFile(targetPath) {
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

  it("getClaudeVersionAsync uses async metadata fallback when exec probes fail", async () => {
    const candidatePath = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd";
    const packageJsonPath = path.win32.join(path.win32.dirname(candidatePath), "node_modules", "@anthropic-ai", "claude-code", "package.json");

    const result = await getClaudeVersionAsync({
      platform: "win32",
      candidates: [candidatePath],
      resetCache: true,
      async execFile() {
        throw new Error("spawn failed");
      },
      async access(targetPath) {
        if (targetPath !== packageJsonPath) throw new Error(`missing: ${targetPath}`);
      },
      async realpath() {
        throw new Error("no realpath");
      },
      async stat() {
        return { size: 0, isFile: () => true };
      },
      async readFile(targetPath) {
        if (targetPath === packageJsonPath) return JSON.stringify({ version: "2.1.109" });
        return "";
      },
    });

    assert.deepStrictEqual(result, {
      version: "2.1.109",
      source: packageJsonPath,
      status: "known",
    });
  });

  it("getClaudeVersionAsync does not call sync filesystem probes", async () => {
    const npmDir = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
    const candidatePath = path.win32.join(npmDir, "claude.cmd");
    const packageJsonPath = path.win32.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");

    const throwSync = () => {
      throw new Error("sync filesystem probe should not run");
    };

    const result = await getClaudeVersionAsync({
      platform: "win32",
      pathEnv: npmDir,
      pathExt: ".CMD",
      resetCache: true,
      existsSync: throwSync,
      statSync: throwSync,
      readFileSync: throwSync,
      realpathSync: throwSync,
      async execFile() {
        throw new Error("spawn failed");
      },
      async access(targetPath) {
        if (targetPath !== candidatePath && targetPath !== packageJsonPath) {
          throw new Error(`missing: ${targetPath}`);
        }
      },
      async realpath() {
        throw new Error("no realpath");
      },
      async stat() {
        return { size: 0, isFile: () => true };
      },
      async readFile(targetPath) {
        if (targetPath === packageJsonPath) return JSON.stringify({ version: "2.1.109" });
        return "";
      },
    });

    assert.deepStrictEqual(result, {
      version: "2.1.109",
      source: packageJsonPath,
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
    assert.strictEqual(stopHooks[0].async, true);
    assert.strictEqual(stopHooks[0].timeout, 5);
    assert.ok(stopHooks[0].command.startsWith('& "node" "'), stopHooks[0].command);
    assert.ok(stopHooks[0].command.endsWith('" Stop'), stopHooks[0].command);
  });

  it("keeps remote hooks bash-compatible while pinning secure identity", () => {
    const hook = __test.buildCommandHookSpec("node", "/tmp/clawd-hook.js", "Stop", {
      platform: "win32",
      remote: true,
      sshRemote: true,
    });

    assert.strictEqual(hook.type, "command");
    assert.match(hook.command, /^CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 /);
    assert.match(hook.command, /CLAWD_REMOTE_IDENTITY_PATH=/);
    assert.match(hook.command, /"node" "\/tmp\/clawd-hook\.js" Stop$/);
  });

  it("keeps legacy WSL --remote on CLAWD_REMOTE without opting into SSH secure transport", () => {
    const hook = __test.buildCommandHookSpec(
      "/usr/bin/node",
      "/home/u/.claude/hooks/clawd-hook.js",
      "Stop",
      {
        platform: "linux",
        remote: true,
        wslDistro: "Ubuntu",
        env: {},
      },
    );
    assert.match(hook.command, /^CLAWD_REMOTE=1 /);
    assert.doesNotMatch(hook.command, /CLAWD_SSH_REMOTE|CLAWD_REMOTE_IDENTITY_PATH/);
  });

  it("uses the plain (unquoted) command format for WSL installs", () => {
    // Quoted-without-shell breaks Claude Code's hook runner on WSL — quotes
    // become part of the executable name (silent hook failure, the root
    // cause this PR fixes). Native POSIX keeps the quoted form.
    const hook = __test.buildCommandHookSpec("/usr/bin/node", "/home/u/.claude/hooks/clawd-hook.js", "Stop", {
      platform: "linux",
      wslDistro: "Ubuntu",
    });

    assert.strictEqual(hook.type, "command");
    assert.strictEqual(hook.command, "/usr/bin/node /home/u/.claude/hooks/clawd-hook.js Stop");
    assert.ok(!("shell" in hook), "WSL hooks must not carry a shell field");
  });

  it("keeps the quoted command format for native POSIX (no wslDistro)", () => {
    const hook = __test.buildCommandHookSpec("/usr/bin/node", "/opt/app dir/clawd-hook.js", "Stop", {
      platform: "linux",
    });

    assert.strictEqual(hook.command, '"/usr/bin/node" "/opt/app dir/clawd-hook.js" Stop');
  });

  it("registers remote hooks as async with reverse-tunnel headroom", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.strictEqual(stopHooks.length, 1);
    assert.ok(stopHooks[0].command.startsWith("CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 "), stopHooks[0].command);
    assert.ok(stopHooks[0].command.includes("CLAWD_REMOTE_IDENTITY_PATH='/home/test/.claude/hooks/clawd-remote.json'"), stopHooks[0].command);
    assert.strictEqual(stopHooks[0].async, true);
    assert.strictEqual(stopHooks[0].timeout, 10);
    assert.ok(!Object.prototype.hasOwnProperty.call(stopHooks[0], "shell"));
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
    assert.strictEqual(stopHooks[0].async, true);
    assert.strictEqual(stopHooks[0].timeout, 5);
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

  it("preserves an existing absolute Windows node path when detection fails", () => {
    // Issue #317: startup auto-sync must not overwrite the user's manual
    // `C:\Program Files\nodejs\node.exe` repair with bare `"node"`. install.js
    // previously gated preservation on POSIX `/` prefixes, so Windows paths
    // slipped through and got clobbered.
    const existingWinPath = "C:\\Program Files\\nodejs\\node.exe";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{
              type: "command",
              shell: "powershell",
              command: `& "${existingWinPath}" "C:/app/hooks/clawd-hook.js" Stop`,
            }],
          },
        ],
      },
    });

    registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: null,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const commands = getClawdCommands(settings, "Stop");
    assert.strictEqual(commands.length, 1);
    assert.ok(commands[0].includes(existingWinPath), `expected ${existingWinPath} in: ${commands[0]}`);
    assert.ok(!commands[0].includes('& "node"'), "should not downgrade to bare node");
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
    assert.strictEqual(autoStartHooks[0].async, true);
    assert.strictEqual(autoStartHooks[0].timeout, 15);
    assert.ok(autoStartHooks[0].command.startsWith('& "node" "'), autoStartHooks[0].command);
  });

  it("uses async auto-start hooks on non-Windows", () => {
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      autoStart: true,
      platform: "darwin",
      nodeBin: "/usr/local/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const autoStartHooks = getCommandHookEntries(settings, "SessionStart", "auto-start.js");
    assert.strictEqual(autoStartHooks.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(autoStartHooks[0], "shell"));
    assert.strictEqual(autoStartHooks[0].async, true);
    assert.strictEqual(autoStartHooks[0].timeout, 15);
    assert.ok(autoStartHooks[0].command.startsWith('"/usr/local/bin/node" "'), autoStartHooks[0].command);
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
    assert.strictEqual(autoStartHooks[0].async, true);
    assert.strictEqual(autoStartHooks[0].timeout, 15);
    assert.ok(autoStartHooks[0].command.startsWith("& "), autoStartHooks[0].command);
    assert.ok(!autoStartHooks[0].command.includes("/old/path/"));
  });

  it("upgrades existing command hooks with async metadata without losing the Node path", () => {
    const existingAbsPath = "/Users/tester/.nvm/versions/node/v20.11.0/bin/node";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ command: `"${existingAbsPath}" "/app/hooks/clawd-hook.js" Stop` }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      nodeBin: null,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    const stopHooks = getCommandHookEntries(settings, "Stop", "clawd-hook.js");
    assert.ok(result.updated >= 1);
    assert.strictEqual(stopHooks.length, 1);
    assert.strictEqual(stopHooks[0].type, "command");
    assert.ok(stopHooks[0].command.includes(existingAbsPath), stopHooks[0].command);
    assert.strictEqual(stopHooks[0].async, true);
    assert.strictEqual(stopHooks[0].timeout, 5);
  });

  it("checks macOS absolute Claude paths before PATH fallback", () => {
    const attempted = [];
    const expectedPath = path.posix.join("/Users/tester", ".claude", "local", "claude");
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
      path.posix.join("/Users/tester", ".local", "bin", "claude"),
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
    const shimPath = path.win32.join(shimDir, "claude.cmd");
    const packageJsonPath = path.win32.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
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
    const oldShimPath = path.win32.join(oldShimDir, "claude.cmd");
    const newShimPath = path.win32.join(newShimDir, "claude.cmd");
    const oldPackageJsonPath = path.win32.join(oldShimDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");

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

describe("Claude permission hook ownership", () => {
  it("recognizes only exact Clawd PermissionRequest URLs on managed ports", () => {
    for (const port of SERVER_PORTS) {
      assert.strictEqual(
        isClawdPermissionUrl(`http://127.0.0.1:${port}/permission`),
        true,
        `expected managed port ${port} to be Clawd-owned`
      );
      assert.strictEqual(
        isClawdPermissionUrl(`http://127.0.0.1:${port}/permission?nonce=${"a".repeat(32)}`),
        true,
      );
    }

    assert.strictEqual(isClawdPermissionUrl("http://127.0.0.1:8080/permission"), false);
    assert.strictEqual(isClawdPermissionUrl("http://localhost:23333/permission"), false);
    assert.strictEqual(isClawdPermissionUrl("https://127.0.0.1:23333/permission"), false);
    assert.strictEqual(isClawdPermissionUrl("http://127.0.0.1:23333/permission?x=1"), false);
    assert.strictEqual(isClawdPermissionUrl("http://127.0.0.1:23333/permission#frag"), false);
    assert.strictEqual(isClawdPermissionUrl("http://user@127.0.0.1:23333/permission"), false);
    assert.strictEqual(isClawdPermissionUrl("http://127.0.0.1/permission"), false);
  });

  it("remote query transport pins the nonce and native fallback removes managed permission hooks", () => {
    const identity = secureRemoteIdentity();
    const settingsPath = makeTempSettings({});
    registerHooks({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: identity,
      remotePermissionTransport: "query",
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.deepStrictEqual(getHttpUrls(readSettings(settingsPath), "PermissionRequest"), [
      buildPermissionUrl(identity.remotePort, identity.routingNonce, "query"),
    ]);

    registerHooks({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: identity,
      remotePermissionTransport: "native",
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.deepStrictEqual(getHttpUrls(readSettings(settingsPath), "PermissionRequest"), []);
  });

  it("preserves third-party local PermissionRequest URLs while adding Clawd HTTP hook", () => {
    const clawdUrl = buildPermissionUrl(SERVER_PORTS[0]);
    const settingsPath = makeTempSettings({
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:8080/permission", timeout: 100 }],
          },
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://localhost:8080/permission", timeout: 100 }],
          },
        ],
      },
    });

    registerHooks({
      silent: true,
      settingsPath,
      port: SERVER_PORTS[0],
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.deepStrictEqual(getHttpUrls(settings, "PermissionRequest"), [
      "http://127.0.0.1:8080/permission",
      "http://localhost:8080/permission",
      clawdUrl,
    ]);
  });

  it("updates stale Clawd PermissionRequest URLs on managed fallback ports", () => {
    const expectedUrl = buildPermissionUrl(SERVER_PORTS[0]);
    const staleUrl = buildPermissionUrl(SERVER_PORTS[SERVER_PORTS.length - 1]);
    const settingsPath = makeTempSettings({
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: staleUrl, timeout: 600 }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      port: SERVER_PORTS[0],
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(result.updated >= 1);
    const permissionHooks = getHttpHookEntries(settings, "PermissionRequest");
    assert.deepStrictEqual(permissionHooks.map((hook) => hook.url), [expectedUrl]);
    assert.strictEqual(permissionHooks[0].timeout, 600);
    assert.ok(!Object.prototype.hasOwnProperty.call(permissionHooks[0], "async"));
  });
});

describe("Hook installer deprecated hook cleanup", () => {
  it("recognizes only the strict env-indirected command grammar (#852)", () => {
    const settings = {
      env: {
        CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
    };
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        "$CLAWD_NODE_BIN $CLAWD_HOOK_PATH WorktreeCreate",
        settings,
        "WorktreeCreate"
      ),
      "env"
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        'node "${CLAWD_HOOK_PATH}" WorktreeCreate',
        settings,
        "WorktreeCreate"
      ),
      "env"
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        '"/opt/homebrew/bin/node" "${CLAWD_HOOK_PATH}" WorktreeCreate',
        settings,
        "WorktreeCreate"
      ),
      "env"
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop',
        settings,
        "WorktreeCreate"
      ),
      null,
      "the trailing event must match the enclosing event"
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH_SUFFIX}" WorktreeCreate',
        settings,
        "WorktreeCreate"
      ),
      null
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        '"/usr/local/bin/node-wrapper" "${CLAWD_HOOK_PATH}" WorktreeCreate',
        settings,
        "WorktreeCreate"
      ),
      null,
      "an arbitrary absolute wrapper is not a direct Node executable"
    );
    assert.strictEqual(
      classifyManagedClaudeStateHookCommand(
        '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate',
        { env: { CLAWD_HOOK_PATH: "/tmp/user-worktree.js" } },
        "WorktreeCreate"
      ),
      null,
      "settings.env must independently prove the clawd-hook.js basename"
    );
  });

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

  it("removes every env-owned WorktreeCreate form, preserves settings.env, and backs up cleanup-only writes (#852)", () => {
    const env = {
      CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
      CLAWD_HOOK_PATH: "/Applications/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks/clawd-hook.js",
      USER_SETTING: "preserve-me",
    };
    const settingsPath = makeTempSettings({
      env,
      hooks: {
        WorktreeCreate: [
          {
            matcher: "",
            hooks: [{
              type: "command",
              command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate',
              timeout: 5,
            }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "${CLAWD_HOOK_PATH}" WorktreeCreate' }],
          },
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "${CLAWD_HOOK_PATH}" WorktreeCreate' }],
          },
        ],
      },
    });

    const result = registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.ok(!Object.prototype.hasOwnProperty.call(settings.hooks, "WorktreeCreate"));
    assert.deepStrictEqual(settings.env, env);
    assert.ok(result.removed >= 3);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath), "cleanup-only mutation should create a backup");
  });

  it("folds env and canonical active hooks by position while preserving auto-start, matcher, and third-party fields (#852)", () => {
    const env = {
      CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
      CLAWD_HOOK_PATH: "/Applications/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks/clawd-hook.js",
    };
    const currentHookPath = getClaudeHookScriptPath().replace(/\\/g, "/");
    const thirdParty = {
      type: "command",
      command: 'node "/tmp/third-party.js" SessionStart',
      timeout: 91,
      async: false,
      custom: "unchanged",
    };
    const settingsPath = makeTempSettings({
      env,
      hooks: {
        SessionStart: [{
          matcher: "project-*",
          wrapperCustom: "keep-wrapper",
          hooks: [
            { type: "command", command: '"node" "/old/auto-start.js"' },
            { type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" SessionStart', timeout: 5 },
            {
              type: "command",
              command: `"/opt/homebrew/bin/node" "${currentHookPath}" SessionStart`,
              async: true,
              timeout: 5,
            },
            thirdParty,
          ],
        }],
      },
    });

    const first = registerHooks({
      silent: true,
      settingsPath,
      autoStart: true,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    const afterFirstText = fs.readFileSync(settingsPath, "utf8");
    const afterFirst = JSON.parse(afterFirstText);
    const wrapper = afterFirst.hooks.SessionStart[0];
    assert.strictEqual(wrapper.matcher, "project-*");
    assert.strictEqual(wrapper.wrapperCustom, "keep-wrapper");
    assert.strictEqual(getManagedStateHookEntries(afterFirst, "SessionStart").length, 1);
    assert.strictEqual(getCommandHookEntries(afterFirst, "SessionStart", "auto-start.js").length, 1);
    assert.deepStrictEqual(
      getCommandHookEntries(afterFirst, "SessionStart").find((hook) => hook.custom === "unchanged"),
      thirdParty
    );
    assert.deepStrictEqual(afterFirst.env, env);
    assert.ok(first.removed >= 1);

    const second = registerHooks({
      silent: true,
      settingsPath,
      autoStart: true,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), afterFirstText);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.removed, 0);
    assert.strictEqual(second.backupPath, null);
  });

  it("folds a flat env state entry into one nested canonical survivor (#852)", () => {
    const nodeBin = "/opt/homebrew/bin/node";
    const hookScript = getClaudeHookScriptPath();
    const canonical = __test.buildCommandHookSpec(nodeBin, hookScript, "Stop", {
      platform: "darwin",
      async: true,
      timeout: 5,
    });
    const thirdParty = { type: "command", command: 'node "/tmp/user-stop.js" Stop', timeout: 17 };
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: nodeBin,
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [
          {
            type: "command",
            command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop',
            timeout: 5,
            flatCustom: "owned-flat",
          },
          { matcher: "keep-wrapper", wrapperCustom: "keep-me", hooks: [canonical, thirdParty] },
        ],
      },
    });

    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const settings = readSettings(settingsPath);
    assert.strictEqual(getManagedStateHookEntries(settings, "Stop").length, 1);
    assert.strictEqual(getManagedStateHookEntries(settings, "Stop")[0].command, canonical.command);
    assert.ok(!getCommandHookEntries(settings, "Stop").some((hook) => hook.flatCustom === "owned-flat"));
    assert.strictEqual(settings.hooks.Stop[0].matcher, "keep-wrapper");
    assert.strictEqual(settings.hooks.Stop[0].wrapperCustom, "keep-me");
    assert.deepStrictEqual(getCommandHookEntries(settings, "Stop").find((hook) => hook.timeout === 17), thirdParty);
  });

  it("folds byte-identical literal duplicates to one active state hook (#852)", () => {
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          { matcher: "a", hooks: [{ type: "command", command: '"/usr/bin/node" "/old-a/clawd-hook.js" Stop' }] },
          { matcher: "b", hooks: [{ type: "command", command: '"/usr/bin/node" "/old-b/clawd-hook.js" Stop' }] },
        ],
      },
    });
    registerHooks({
      silent: true,
      settingsPath,
      platform: "linux",
      nodeBin: "/usr/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.strictEqual(getManagedStateHookEntries(readSettings(settingsPath), "Stop").length, 1);
  });

  it("preserves a literal hook when the resolved Node path falls outside external env grammar (#852)", () => {
    const envCommand = '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" SessionStart';
    const hookScript = getClaudeHookScriptPath();
    const cases = [
      { platform: "win32", nodeBin: "C:\\Program Files (x86)\\nodejs\\node.exe" },
      { platform: "linux", nodeBin: "/usr/bin/nodejs" },
    ];

    for (const { platform, nodeBin } of cases) {
      const literalHook = __test.buildCommandHookSpec(nodeBin, hookScript, "SessionStart", {
        platform,
        async: true,
        timeout: 5,
      });
      const settingsPath = makeTempSettings({
        env: {
          CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
          CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
        },
        hooks: {
          SessionStart: [{ matcher: "", hooks: [
            { type: "command", command: envCommand, timeout: 5 },
            literalHook,
          ] }],
        },
      });

      registerHooks({
        silent: true,
        settingsPath,
        platform,
        nodeBin,
        claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      });

      const hooks = getCommandHookEntries(readSettings(settingsPath), "SessionStart");
      assert.strictEqual(hooks.length, 1, `${platform} should converge to one state hook`);
      assert.strictEqual(hooks[0].command, literalHook.command);
      assert.ok(!hooks[0].command.includes("CLAWD_HOOK_PATH"));
    }
  });

  it("converges a health env migration signature when the resolved Node path needs normal quoting (#852)", () => {
    const resolvedNode = "C:\\Program Files (x86)\\nodejs\\node.exe";
    const envNode = "C:\\Program Files\\nodejs\\node.exe";
    const hookScript = getClaudeHookScriptPath();
    const autoStartScript = getClaudeAutoStartScriptPath();
    const permissionUrl = buildPermissionUrl(SERVER_PORTS[0]);
    const hooks = {};
    for (const event of CLAUDE_CORE_HOOK_EVENTS) {
      hooks[event] = [{ matcher: "", hooks: [{
        type: "command",
        command: `"${"${CLAWD_NODE_BIN}"}" "${"${CLAWD_HOOK_PATH}"}" ${event}`,
        timeout: 5,
      }] }];
    }
    hooks.PermissionRequest = [{ matcher: "", hooks: [{ type: "http", url: permissionUrl, timeout: 600 }] }];
    const settingsPath = makeTempSettings({
      env: { CLAWD_NODE_BIN: envNode, CLAWD_HOOK_PATH: hookScript },
      hooks,
    });
    const existing = new Set([resolvedNode, envNode, hookScript, autoStartScript]);
    const healthOptions = {
      platform: "win32",
      fs: {
        existsSync: (candidate) => existing.has(candidate),
        accessSync: (candidate) => {
          if (!existing.has(candidate)) throw new Error("ENOENT");
        },
      },
      expectedPermissionUrl: permissionUrl,
      expectedHookScriptPath: hookScript,
      expectedAutoStartScriptPath: autoStartScript,
      coreEvents: CLAUDE_CORE_HOOK_EVENTS,
      requireAutoStart: false,
    };

    const before = inspectClaudeHookHealth(fs.readFileSync(settingsPath, "utf8"), healthOptions);
    assert.strictEqual(buildClaudeRepairSignature(before.issues), "v1:env-state-hook");

    registerHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: resolvedNode,
      port: SERVER_PORTS[0],
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const after = inspectClaudeHookHealth(fs.readFileSync(settingsPath, "utf8"), healthOptions);
    assert.strictEqual(after.status, "healthy");
    assert.strictEqual(buildClaudeRepairSignature(after.issues), null);
  });

  it("preserves an env-owned active hook instead of rewriting it to bare node when no absolute Node is usable (#852)", () => {
    const command = '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" SessionStart';
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: "node",
        CLAWD_HOOK_PATH: "/Applications/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks/clawd-hook.js",
      },
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 5 }] }],
      },
    });
    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: null,
      accessSync() { throw new Error("ENOENT"); },
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    const settings = readSettings(settingsPath);
    assert.strictEqual(getManagedStateHookEntries(settings, "SessionStart").length, 1);
    assert.strictEqual(getManagedStateHookEntries(settings, "SessionStart")[0].command, command);
    assert.ok(!getCommandHookEntries(settings, "SessionStart").some((hook) => hook.command.startsWith('"node"')));
  });

  it("skips a stale direct Node candidate and uses the verified settings.env fallback (#852)", () => {
    const staleNode = "/missing/bin/node";
    const envNode = "/opt/homebrew/bin/node";
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: envNode,
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [{ matcher: "", hooks: [{
          type: "command",
          command: `"${staleNode}" "${"${CLAWD_HOOK_PATH}"}" Stop`,
        }] }],
      },
    });
    const checked = [];

    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: null,
      accessSync(candidate) {
        checked.push(candidate);
        if (candidate === envNode) return;
        throw new Error("ENOENT");
      },
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const stop = getManagedStateHookEntries(readSettings(settingsPath), "Stop");
    assert.deepStrictEqual(checked, [staleNode, envNode]);
    assert.strictEqual(stop.length, 1);
    assert.ok(stop[0].command.startsWith(`"${envNode}" `), stop[0].command);
  });

  it("never canonicalizes a shell-breaking settings.env Node value even when access succeeds (#852)", () => {
    const unsafeNode = '/tmp/a";noop;"/node';
    const command = '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop';
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: unsafeNode,
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command }] }],
      },
    });
    let accessCalls = 0;

    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: null,
      accessSync() { accessCalls++; },
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const stop = getManagedStateHookEntries(readSettings(settingsPath), "Stop");
    assert.strictEqual(accessCalls, 0, "unsafe data must be rejected before filesystem access");
    assert.strictEqual(stop.length, 1);
    assert.strictEqual(stop[0].command, command);
    assert.ok(!stop[0].command.includes("noop"));
  });

  it("fails closed on compound and single-quoted env-indirected worktree commands (#852)", () => {
    const compound = '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate && create-real-worktree';
    const singleQuoted = "'${CLAWD_NODE_BIN}' '${CLAWD_HOOK_PATH}' WorktreeCreate";
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        WorktreeCreate: [{ matcher: "", hooks: [
          { type: "command", command: compound },
          { type: "command", command: singleQuoted },
        ] }],
      },
    });
    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    assert.deepStrictEqual(
      getCommandHookEntries(readSettings(settingsPath), "WorktreeCreate").map((hook) => hook.command),
      [compound, singleQuoted]
    );
  });

  it("applies env ownership to versioned and HTTP-only all-delete reconciliation (#852)", () => {
    const env = {
      CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
      CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
    };
    const userPermission = { type: "command", command: 'node "/tmp/user-permission.js" PermissionRequest', timeout: 19, async: false };
    const settingsPath = makeTempSettings({
      env,
      hooks: {
        StopFailure: [{ matcher: "", hooks: [
          { type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" StopFailure' },
          { type: "command", command: 'node "/tmp/user-stop-failure.js" StopFailure' },
        ] }],
        PermissionRequest: [{ matcher: "", hooks: [
          { type: "command", command: 'node "${CLAWD_HOOK_PATH}" PermissionRequest' },
          userPermission,
        ] }],
      },
    });
    registerHooks({
      silent: true,
      settingsPath,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.77", source: "test", status: "known" },
    });
    const settings = readSettings(settingsPath);
    assert.deepStrictEqual(
      getCommandHookEntries(settings, "StopFailure").map((hook) => hook.command),
      ['node "/tmp/user-stop-failure.js" StopFailure']
    );
    assert.deepStrictEqual(
      getCommandHookEntries(settings, "PermissionRequest"),
      [userPermission]
    );
    assert.strictEqual(getHttpHookEntries(settings, "PermissionRequest").length, 1);
  });
});

describe("Hook installer unregisterHooks", () => {
  it("removes env-owned state hooks while preserving settings.env and mixed third-party siblings (#852)", () => {
    const env = {
      CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
      CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      SHARED_BY_USER: "yes",
    };
    const userHook = { type: "command", command: 'node "/tmp/user.js" Stop', timeout: 23 };
    const settingsPath = makeTempSettings({
      env,
      hooks: {
        Stop: [{ matcher: "keep-me", hooks: [
          { type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop' },
          userHook,
        ] }],
      },
    });

    const result = unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);
    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(settings.env, env);
    assert.strictEqual(settings.hooks.Stop[0].matcher, "keep-me");
    assert.deepStrictEqual(settings.hooks.Stop[0].hooks, [userHook]);
  });

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
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:8080/permission", timeout: 100 }],
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
    assert.deepStrictEqual(getHttpUrls(settings, "PermissionRequest"), [
      "http://localhost:8080/permission",
      "http://127.0.0.1:8080/permission",
    ]);
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
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:8080/permission", timeout: 600 }],
          },
        ],
      },
    });

    const result = unregisterHooks({ settingsPath });
    const settings = readSettings(settingsPath);

    assert.deepStrictEqual(result, { removed: 0, changed: false });
    assert.deepStrictEqual(getHttpUrls(settings, "PermissionRequest"), [
      "http://localhost:8080/permission",
      "http://127.0.0.1:8080/permission",
    ]);
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

describe("async hook installer parity", () => {
  it("registerHooksAsync preserves an existing Node path after a single lightweight access check (#317)", async () => {
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

    let accessCalls = 0;
    let execFileCalls = 0;
    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async access(candidate, mode) {
        accessCalls++;
        assert.strictEqual(candidate, existingAbsPath, "should only validate the extracted existing path");
        // POSIX must check the execute bit, matching the doctor validator and
        // resolver — F_OK alone would preserve a non-executable file that
        // the health inspector would then judge broken on the next check.
        assert.strictEqual(mode, fs.constants.X_OK, "POSIX existing-Node validation must check X_OK, not just F_OK");
        // A valid existing path resolves — no resolver probe should follow.
      },
      async execFile() {
        execFileCalls++;
        throw new Error("resolver shell probing should not run when the existing path checks out");
      },
      accessSync() {
        throw new Error("sync node probing should not run from the async installer");
      },
      execFileSync() {
        throw new Error("sync shell probing should not run from the async installer");
      },
    });

    assert.strictEqual(accessCalls, 1, "existing Node path should be validated exactly once");
    assert.strictEqual(execFileCalls, 0, "resolver should not run once the existing path is confirmed valid");

    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    assert.ok(commands.some((command) => command.includes(existingAbsPath)), commands.join("\n"));
  });

  it("registerHooksAsync validates an existing Windows Node path with F_OK, not X_OK (#317)", async () => {
    const existingAbsPath = "C:/Program Files/nodejs/node.exe";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `& "${existingAbsPath}" "C:/app/hooks/clawd-hook.js" Stop` }],
          },
        ],
      },
    });

    let accessMode = null;
    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "win32",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async access(candidate, mode) {
        accessMode = mode;
        assert.strictEqual(candidate, existingAbsPath);
      },
      async execFile() {
        throw new Error("resolver should not run when the existing path checks out");
      },
    });

    assert.strictEqual(accessMode, fs.constants.F_OK, "Windows has no executable-bit semantics; existence check must use F_OK");
    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    assert.ok(commands.some((command) => command.includes(existingAbsPath)), commands.join("\n"));
  });

  it("registerHooksAsync falls back to the resolver when the existing Node path is no longer valid (#317)", async () => {
    const staleAbsPath = "/Users/tester/.nvm/versions/node/v18.0.0/bin/node";
    const resolvedAbsPath = "/opt/homebrew/bin/node";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `"${staleAbsPath}" "/app/hooks/clawd-hook.js" Stop` }],
          },
        ],
      },
    });

    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async access(candidate) {
        if (candidate === staleAbsPath) throw new Error("ENOENT");
        if (candidate === resolvedAbsPath) return;
        throw new Error("ENOENT");
      },
      async execFile() {
        throw new Error("shell probing should not be needed once a well-known candidate resolves");
      },
    });

    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    assert.ok(commands.some((command) => command.includes(resolvedAbsPath)), commands.join("\n"));
    assert.ok(!commands.some((command) => command.includes(staleAbsPath)), commands.join("\n"));
  });

  it("registerHooksAsync never validates an explicit options.nodeBin against the local filesystem (#317)", async () => {
    const explicitNodeBin = "/remote/inaccessible/node";
    const settingsPath = makeTempSettings({});

    await registerHooksAsync({
      silent: true,
      settingsPath,
      nodeBin: explicitNodeBin,
      platform: "linux",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async access() {
        throw new Error("explicit options.nodeBin must not be validated with access()");
      },
      async execFile() {
        throw new Error("explicit options.nodeBin must never trigger the resolver");
      },
    });

    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    assert.ok(commands.some((command) => command.includes(explicitNodeBin)), commands.join("\n"));
  });

  it("registerHooksAsync migrates a stale hook path to the current authoritative script path", async () => {
    const oldTempPath = "/tmp/clawd-on-desk/hooks/clawd-hook.js";
    const settingsPath = makeTempSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `"/usr/bin/node" "${oldTempPath}" Stop` }],
          },
        ],
      },
    });

    await registerHooksAsync({
      silent: true,
      settingsPath,
      nodeBin: "/usr/bin/node",
      platform: "linux",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    const currentScriptPath = getClaudeHookScriptPath();
    assert.ok(commands.some((command) => command.includes(currentScriptPath)), commands.join("\n"));
    assert.ok(!commands.some((command) => command.includes(oldTempPath)), commands.join("\n"));
    assert.ok(!commands.some((command) => command.includes("app.asar.unpacked")), "source-tree installs should not force an asar.unpacked path literal");
  });

  it("registerHooksAsync resolves Node with async probes without calling sync probes", async () => {
    const settingsPath = makeTempSettings({});
    const nodeBin = "/opt/homebrew/bin/node";

    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async access(candidate) {
        if (candidate === nodeBin) return;
        throw new Error("ENOENT");
      },
      async execFile() {
        throw new Error("shell probing should not run after a well-known path succeeds");
      },
      accessSync() {
        throw new Error("sync access should not run");
      },
      execFileSync() {
        throw new Error("sync exec should not run");
      },
    });

    const commands = getClawdCommands(readSettings(settingsPath), "Stop");
    assert.ok(commands.some((command) => command.startsWith(`"${nodeBin}" "`)), commands.join("\n"));
  });

  it("registerHooksAsync uses a verified settings.env Node candidate only after env hook ownership is proven (#852)", async () => {
    const envNode = "/custom/node/bin/node";
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: envNode,
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [{ matcher: "", hooks: [{
          type: "command",
          command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop',
        }] }],
      },
    });

    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async readdir() { return []; },
      async access(candidate) {
        if (candidate === envNode) return;
        throw new Error("ENOENT");
      },
      async execFile() { throw new Error("no shell candidate"); },
    });

    const stop = getManagedStateHookEntries(readSettings(settingsPath), "Stop");
    assert.strictEqual(stop.length, 1);
    assert.ok(stop[0].command.startsWith(`"${envNode}" `), stop[0].command);
  });

  it("registerHooksAsync continues past a stale first candidate to a later usable direct Node path (#852)", async () => {
    const staleNode = "/opt/custom/bin/node";
    const validNode = "/Opt/custom/bin/node";
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: "node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: `"${staleNode}" "${"${CLAWD_HOOK_PATH}"}" Stop` }] },
          { matcher: "", hooks: [{ type: "command", command: `"${validNode}" "${"${CLAWD_HOOK_PATH}"}" Stop` }] },
        ],
      },
    });
    const checked = [];

    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async readdir() { return []; },
      async access(candidate) {
        checked.push(candidate);
        if (candidate === validNode) return;
        throw new Error("ENOENT");
      },
      async execFile() { throw new Error("no shell candidate"); },
    });

    const stop = getManagedStateHookEntries(readSettings(settingsPath), "Stop");
    assert.ok(checked.includes(staleNode), checked.join(","));
    assert.ok(checked.includes(validNode), checked.join(","));
    assert.strictEqual(stop.length, 1);
    assert.ok(stop[0].command.startsWith(`"${validNode}" `), stop[0].command);
  });

  it("registerHooksAsync preserves an env hook when neither resolver nor env supplies a safe Node path (#852)", async () => {
    const command = '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop';
    const settingsPath = makeTempSettings({
      env: {
        CLAWD_NODE_BIN: "node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command }] }],
      },
    });

    await registerHooksAsync({
      silent: true,
      settingsPath,
      platform: "darwin",
      isElectron: true,
      homeDir: "/Users/tester",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
      async readdir() { return []; },
      async access() { throw new Error("ENOENT"); },
      async execFile() { throw new Error("no shell candidate"); },
    });

    const stop = getManagedStateHookEntries(readSettings(settingsPath), "Stop");
    assert.strictEqual(stop.length, 1);
    assert.strictEqual(stop[0].command, command);
  });

  it("registerHooksAsync writes the same hook set as registerHooks", async () => {
    const syncSettingsPath = makeTempSettings({});
    const asyncSettingsPath = makeTempSettings({});

    const syncResult = registerHooks({
      silent: true,
      settingsPath: syncSettingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });
    const asyncResult = await registerHooksAsync({
      silent: true,
      settingsPath: asyncSettingsPath,
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    });

    assert.deepStrictEqual(readSettings(asyncSettingsPath), readSettings(syncSettingsPath));

    // backupPath is path-specific (each call uses its own temp settingsPath), so
    // compare the rest of the result for parity and assert both paths backed up.
    const { backupPath: syncBackup, ...syncRest } = syncResult;
    const { backupPath: asyncBackup, ...asyncRest } = asyncResult;
    assert.deepStrictEqual(asyncRest, syncRest);
    assert.ok(syncBackup && syncBackup.endsWith(".bak"), "registerHooks should back up the prior settings");
    assert.ok(asyncBackup && asyncBackup.endsWith(".bak"), "registerHooksAsync should back up the prior settings");
  });

  it("sync and async registration produce the same env migration and async is a no-op after sync (#852)", async () => {
    const initial = {
      env: {
        CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
      },
      hooks: {
        SessionStart: [{ matcher: "", hooks: [
          { type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" SessionStart' },
          { type: "command", command: '"/opt/homebrew/bin/node" "/old/clawd-hook.js" SessionStart' },
        ] }],
        WorktreeCreate: [{ matcher: "", hooks: [
          { type: "command", command: 'node "${CLAWD_HOOK_PATH}" WorktreeCreate', timeout: 5 },
        ] }],
      },
    };
    const syncSettingsPath = makeTempSettings(initial);
    const asyncSettingsPath = makeTempSettings(initial);
    const options = {
      silent: true,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      claudeVersionInfo: { version: "2.1.78", source: "test", status: "known" },
    };

    const syncResult = registerHooks({ ...options, settingsPath: syncSettingsPath });
    const asyncResult = await registerHooksAsync({ ...options, settingsPath: asyncSettingsPath });
    assert.deepStrictEqual(readSettings(asyncSettingsPath), readSettings(syncSettingsPath));
    const { backupPath: syncBackup, ...syncRest } = syncResult;
    const { backupPath: asyncBackup, ...asyncRest } = asyncResult;
    assert.deepStrictEqual(asyncRest, syncRest);
    assert.ok(syncBackup && asyncBackup);

    const beforeSecond = fs.readFileSync(syncSettingsPath, "utf8");
    const second = await registerHooksAsync({ ...options, settingsPath: syncSettingsPath });
    assert.strictEqual(fs.readFileSync(syncSettingsPath, "utf8"), beforeSecond);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.removed, 0);
    assert.strictEqual(second.backupPath, null);
  });

  it("unregisterHooksAsync removes env and literal entries exactly like unregisterHooks (#852)", async () => {
    const initial = {
      env: {
        CLAWD_NODE_BIN: "/opt/homebrew/bin/node",
        CLAWD_HOOK_PATH: "/Applications/Clawd/hooks/clawd-hook.js",
        USER_SETTING: "preserve-me",
      },
      hooks: {
        Stop: [{ matcher: "", custom: "keep-wrapper", hooks: [
          { type: "command", command: '"/usr/bin/node" "/tmp/clawd-hook.js" Stop' },
          { type: "command", command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" Stop', timeout: 5 },
          { type: "command", command: 'node "/tmp/user-stop.js" Stop', timeout: 33 },
        ] }],
        WorktreeCreate: [{ matcher: "", hooks: [{
          type: "command",
          command: '"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate',
          timeout: 5,
        }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission" }] }],
      },
    };
    const syncSettingsPath = makeTempSettings(initial);
    const asyncSettingsPath = makeTempSettings(initial);

    const syncResult = unregisterHooks({ settingsPath: syncSettingsPath });
    const asyncResult = await unregisterHooksAsync({ settingsPath: asyncSettingsPath });

    assert.deepStrictEqual(readSettings(asyncSettingsPath), readSettings(syncSettingsPath));
    assert.deepStrictEqual(asyncResult, syncResult);
    const after = readSettings(asyncSettingsPath);
    assert.deepStrictEqual(after.env, initial.env);
    assert.deepStrictEqual(getCommandHookEntries(after, "Stop"), [
      { type: "command", command: 'node "/tmp/user-stop.js" Stop', timeout: 33 },
    ]);
    assert.ok(!Object.prototype.hasOwnProperty.call(after.hooks, "WorktreeCreate"));
  });
});

describe("Hook installer settings backup", () => {
  const versionInfo = { version: "2.1.78", source: "test", status: "known" };

  function bakFiles(settingsPath) {
    const dir = path.dirname(settingsPath);
    return fs.readdirSync(dir).filter((name) => name.endsWith(".bak"));
  }

  it("backs up an existing settings.json before injecting hooks", () => {
    const original = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-own-hook" }] }] } };
    const settingsPath = makeTempSettings(original);

    const result = registerHooks({ silent: true, settingsPath, claudeVersionInfo: versionInfo });

    assert.ok(result.backupPath, "should return a backupPath");
    assert.ok(fs.existsSync(result.backupPath), "backup file should exist on disk");
    // Backup holds the ORIGINAL pre-install content (the user's own hook, no Clawd hooks).
    assert.deepStrictEqual(readSettings(result.backupPath), original);
    // Live file was mutated (Clawd hooks added) and the user's hook is preserved.
    assert.ok(getClawdCommands(readSettings(settingsPath), "Stop").length > 0, "Clawd hooks should be installed");
  });

  it("does not back up when settings.json does not pre-exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-install-"));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, "settings.json"); // intentionally absent

    const result = registerHooks({ silent: true, settingsPath, claudeVersionInfo: versionInfo });

    assert.strictEqual(result.backupPath, null, "no backup for a freshly created file");
    assert.deepStrictEqual(bakFiles(settingsPath), [], "no .bak files written");
    assert.ok(fs.existsSync(settingsPath), "settings.json should still be created");
  });

  it("respects backup: false (opt out)", () => {
    const settingsPath = makeTempSettings({ hooks: {} });

    const result = registerHooks({ silent: true, settingsPath, backup: false, claudeVersionInfo: versionInfo });

    assert.strictEqual(result.backupPath, null);
    assert.deepStrictEqual(bakFiles(settingsPath), []);
  });

  it("backs up on the async path too", async () => {
    const settingsPath = makeTempSettings({ hooks: {} });

    const result = await registerHooksAsync({ silent: true, settingsPath, claudeVersionInfo: versionInfo });

    assert.ok(result.backupPath && fs.existsSync(result.backupPath), "async install should back up");
  });

  it("caps backups under repeated re-register instead of piling up unbounded", () => {
    // Simulates a CC-Switch style write war: an external tool keeps stripping
    // Clawd's hooks from settings.json, the watcher keeps re-registering them.
    // Each real write snapshots the prior file, but the total must stay bounded.
    const thirdParty = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-own-hook" }] }] } };
    const settingsPath = makeTempSettings(thirdParty);
    const dir = path.dirname(settingsPath);
    const countBaks = () => fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).length;

    for (let i = 0; i < 8; i++) {
      // External tool overwrites settings.json back to third-party-only (drops Clawd hooks).
      fs.writeFileSync(settingsPath, JSON.stringify(thirdParty, null, 2), "utf-8");
      const result = registerHooks({ silent: true, settingsPath, claudeVersionInfo: versionInfo, backupKeep: 3 });
      assert.ok(result.backupPath, "each re-register over an existing file should back up");
      // The returned path must actually exist — i.e. the fresh backup is never
      // the one pruned away (regression: copyFileSync inherits the source mtime).
      assert.ok(fs.existsSync(result.backupPath), "returned backup path must exist on disk");
    }

    assert.strictEqual(countBaks(), 3, `backups must stay capped at backupKeep, found ${countBaks()}`);
    // The live file still has Clawd's hooks plus the user's own hook preserved.
    assert.ok(getClawdCommands(readSettings(settingsPath), "Stop").length > 0, "Clawd hooks still installed");
  });
});

describe("Claude Code statusline installer", () => {
  it("keeps local CLI hook reinstalls opted out unless --statusline is explicit", () => {
    assert.deepStrictEqual(parseClaudeInstallCliOptions([]), {
      remote: false,
      chainExisting: false,
      installStatusline: false,
    });
    assert.strictEqual(parseClaudeInstallCliOptions(["--statusline"]).installStatusline, true);
  });

  it("keeps remote deploy statusline collection enabled without an extra flag", () => {
    assert.deepStrictEqual(parseClaudeInstallCliOptions(["--remote", "--chain-existing"]), {
      remote: true,
      chainExisting: true,
      installStatusline: true,
    });
  });

  it("registers the statusline command when settings.json has none", () => {
    const settingsPath = makeTempSettings({});

    const result = registerClaudeStatusline({ silent: true, settingsPath, platform: "darwin", nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.skippedExisting, false);
    const settings = readSettings(settingsPath);
    assert.strictEqual(settings.statusLine.type, "command");
    assert.ok(settings.statusLine.command.includes(STATUSLINE_MARKER));
    assert.ok(settings.statusLine.command.includes("/usr/local/bin/node"));
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettings({});
    registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const result = registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.changed, false);
  });

  // Remote deploys run install.js --remote ON the remote (POSIX shells only —
  // deploy aborts on cmd.exe), and CLAWD_REMOTE=1 is what makes the
  // statusline stamp body.host so quota rides the reverse tunnel. The adapter
  // itself keeps a short best-effort transport timeout to protect visible UI.
  it("remote: prefixes the command with CLAWD_REMOTE=1 and stays marker-detectable", () => {
    const settingsPath = makeTempSettings({});

    const result = registerClaudeStatusline({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.changed, true);
    const command = readSettings(settingsPath).statusLine.command;
    assert.ok(command.startsWith("CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 "), command);
    assert.ok(command.includes(STATUSLINE_MARKER));

    // Re-register (deploy repair) must be idempotent on the remote form too.
    const again = registerClaudeStatusline({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });
    assert.strictEqual(again.changed, false);
  });

  it("remote: still never overwrites a pre-existing third-party statusline", () => {
    const settingsPath = makeTempSettings({
      statusLine: { type: "command", command: "~/.claude/my-custom-statusline.sh" },
    });

    const result = registerClaudeStatusline({
      silent: true,
      settingsPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });

    assert.strictEqual(result.skippedExisting, true);
    assert.strictEqual(
      readSettings(settingsPath).statusLine.command,
      "~/.claude/my-custom-statusline.sh"
    );
  });

  // A realistic third-party statusline command: a bash -c one-liner full of
  // nested quoting (claude-hud shape). The sidecar must preserve the object
  // verbatim - both for the chained exec and for the unregister restore.
  const NASTY_STATUSLINE = {
    type: "command",
    command: `bash -c 'cols=$(stty size </dev/tty 2>/dev/null | awk '"'"'{print $2}'"'"'); exec "/home/user/.bun/bin/bun" "$HOME/hud/src/index.ts"'`,
    padding: 1,
  };

  function makeChainSidecarPath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-chain-sidecar-")), "clawd-statusline-chain.json");
  }

  it("remote --chain-existing: wraps a third-party statusline via the sidecar", () => {
    const settingsPath = makeTempSettings({ statusLine: NASTY_STATUSLINE });
    const chainSidecarPath = makeChainSidecarPath();

    const result = registerClaudeStatusline({
      silent: true,
      settingsPath,
      chainSidecarPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      chainExisting: true,
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });

    assert.strictEqual(result.skippedExisting, false);
    assert.strictEqual(result.chained, true);
    const command = readSettings(settingsPath).statusLine.command;
    assert.ok(command.startsWith("CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 "), command);
    assert.ok(command.includes(STATUSLINE_MARKER));
    assert.ok(command.endsWith(" --chain"), command);
    // The user's original survives byte-for-byte in the sidecar.
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(chainSidecarPath, "utf8")).statusLine,
      NASTY_STATUSLINE
    );
  });

  it("remote --chain-existing: an omitted repair preference keeps the chain and sidecar", () => {
    const settingsPath = makeTempSettings({ statusLine: NASTY_STATUSLINE });
    const chainSidecarPath = makeChainSidecarPath();
    const opts = {
      silent: true,
      settingsPath,
      chainSidecarPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      chainExisting: true,
      platform: "linux",
      nodeBin: "/usr/bin/node",
    };
    registerClaudeStatusline(opts);

    const { chainExisting: _omitted, ...repairOpts } = opts;
    const again = registerClaudeStatusline(repairOpts);

    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.chained, true);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(chainSidecarPath, "utf8")).statusLine,
      NASTY_STATUSLINE
    );
  });

  it("remote --chain-existing: explicit false restores the original statusline", () => {
    const settingsPath = makeTempSettings({ statusLine: NASTY_STATUSLINE });
    const chainSidecarPath = makeChainSidecarPath();
    const opts = {
      silent: true,
      settingsPath,
      chainSidecarPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      platform: "linux",
      nodeBin: "/usr/bin/node",
    };
    registerClaudeStatusline({ ...opts, chainExisting: true });

    const result = registerClaudeStatusline({ ...opts, chainExisting: false });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.chained, false);
    assert.strictEqual(result.restoredChained, true);
    assert.strictEqual(result.skippedExisting, true);
    assert.deepStrictEqual(readSettings(settingsPath).statusLine, NASTY_STATUSLINE);
    assert.strictEqual(fs.existsSync(chainSidecarPath), false);
  });

  it("remote --chain-existing: unregister restores the original statusLine object and consumes the sidecar", () => {
    const settingsPath = makeTempSettings({ statusLine: NASTY_STATUSLINE });
    const chainSidecarPath = makeChainSidecarPath();
    registerClaudeStatusline({
      silent: true,
      settingsPath,
      chainSidecarPath,
      remote: true,
      sshRemote: true,
      remoteIdentity: secureRemoteIdentity(),
      chainExisting: true,
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });

    const result = unregisterClaudeStatusline({ silent: true, settingsPath, chainSidecarPath });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.restoredChained, true);
    assert.deepStrictEqual(readSettings(settingsPath).statusLine, NASTY_STATUSLINE);
    assert.strictEqual(fs.existsSync(chainSidecarPath), false);
  });

  it("local chainExisting is ignored (chain is remote-only in v1)", () => {
    const settingsPath = makeTempSettings({ statusLine: NASTY_STATUSLINE });
    const chainSidecarPath = makeChainSidecarPath();

    const result = registerClaudeStatusline({
      silent: true,
      settingsPath,
      chainSidecarPath,
      chainExisting: true,
      platform: "linux",
      nodeBin: "/usr/bin/node",
    });

    assert.strictEqual(result.skippedExisting, true);
    assert.strictEqual(fs.existsSync(chainSidecarPath), false);
    assert.deepStrictEqual(readSettings(settingsPath).statusLine, NASTY_STATUSLINE);
  });

  // On Windows Claude Code runs statusLine.command through Git Bash whenever
  // Git is installed (a Claude Code install prerequisite), so the PowerShell
  // call-operator form (`& "..."`) is a bash syntax error and the statusline
  // dies silently. statusLine has no `shell` field to pin PowerShell.
  it("win32: writes a bash-safe command (bare node) when the node path has spaces", () => {
    const settingsPath = makeTempSettings({});

    registerClaudeStatusline({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    });

    const command = readSettings(settingsPath).statusLine.command;
    assert.ok(!command.startsWith("& "), command);
    assert.ok(command.startsWith('node "'), command);
    assert.ok(command.includes(STATUSLINE_MARKER));
  });

  it("win32: keeps a space-free absolute node path, unquoted with forward slashes", () => {
    const settingsPath = makeTempSettings({});

    registerClaudeStatusline({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\nvm\\v20.11.0\\node.exe",
    });

    const command = readSettings(settingsPath).statusLine.command;
    assert.ok(command.startsWith('C:/nvm/v20.11.0/node.exe "'), command);
  });

  it("win32: rewrites our own legacy PowerShell-only command on re-register (startup sync migration)", () => {
    const settingsPath = makeTempSettings({
      statusLine: {
        type: "command",
        command: '& "C:\\Program Files\\nodejs\\node.exe" "C:/app/hooks/claude-statusline.js"',
        padding: 0,
      },
    });

    const result = registerClaudeStatusline({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.skippedExisting, false);
    const command = readSettings(settingsPath).statusLine.command;
    assert.ok(!command.startsWith("& "), command);
    assert.ok(command.includes(STATUSLINE_MARKER));
  });

  it("never overwrites a pre-existing third-party statusline", () => {
    const settingsPath = makeTempSettings({
      statusLine: { type: "command", command: "~/.claude/my-custom-statusline.sh" },
    });

    const result = registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.skippedExisting, true);
    assert.strictEqual(readSettings(settingsPath).statusLine.command, "~/.claude/my-custom-statusline.sh");
  });

  it("preserves other settings.json keys", () => {
    const settingsPath = makeTempSettings({ model: "opus" });

    registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readSettings(settingsPath);
    assert.strictEqual(settings.model, "opus");
    assert.ok(settings.statusLine.command.includes(STATUSLINE_MARKER));
  });

  it("registers into a UTF-8-BOM'd settings.json instead of throwing (Notepad's default save format)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-install-"));
    const settingsPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(settingsPath, "﻿" + JSON.stringify({ model: "opus" }), "utf8");
    tempDirs.push(tmpDir);

    const result = registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.changed, true);
    const settings = readSettings(settingsPath);
    assert.strictEqual(settings.model, "opus");
    assert.ok(settings.statusLine.command.includes(STATUSLINE_MARKER));
  });

  it("unregisters from a UTF-8-BOM'd settings.json instead of throwing", () => {
    const settingsPath = makeTempSettings({});
    registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const withBom = "﻿" + fs.readFileSync(settingsPath, "utf8");
    fs.writeFileSync(settingsPath, withBom, "utf8");

    const result = unregisterClaudeStatusline({ silent: true, settingsPath });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(readSettings(settingsPath).statusLine, undefined);
  });

  it("unregister removes only a Clawd-owned statusline", () => {
    const settingsPath = makeTempSettings({});
    registerClaudeStatusline({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const result = unregisterClaudeStatusline({ silent: true, settingsPath, backup: true });

    assert.deepStrictEqual(result, {
      installed: true,
      removed: 1,
      changed: true,
      settingsPath,
      backupPath: result.backupPath,
    });
    assert.strictEqual(readSettings(settingsPath).statusLine, undefined);
  });

  it("unregister leaves a third-party statusline untouched", () => {
    const settingsPath = makeTempSettings({
      statusLine: { type: "command", command: "~/.claude/my-custom-statusline.sh" },
    });

    const result = unregisterClaudeStatusline({ silent: true, settingsPath });

    assert.deepStrictEqual(result, { installed: true, removed: 0, changed: false, settingsPath });
    assert.strictEqual(readSettings(settingsPath).statusLine.command, "~/.claude/my-custom-statusline.sh");
  });
});
