const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("node:child_process");
const {
  registerTraeCodeHooks,
  unregisterTraeCodeHooks,
  TRAECODE_HOOK_EVENTS,
} = require("../hooks/traecode-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const MARKER = "traecode-hook.js";
const tempDirs = [];
const windowsOnly = { skip: process.platform !== "win32" ? "requires Windows PowerShell 5.1" : false };

function makeTempConfigFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-traecode-"));
  const configPath = path.join(tmpDir, "hooks.json");
  fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return configPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function commandText(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

function expectedWindowsPayload(nodeBin) {
  const hookScript = path.resolve(__dirname, "../hooks/traecode-hook.js").replace(/\\/g, "/");
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return `& ${quote(nodeBin)} ${quote(hookScript)}`;
}

function listCleanupBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.clawd-cleanup-`));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("TraeCode hook installer", () => {
  it("registers all 6 command events on fresh install", () => {
    const configPath = makeTempConfigFile({});
    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, 6);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(configPath);

    for (const event of TRAECODE_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(entry.matcher, "");
      assert.ok(Array.isArray(entry.hooks));
      assert.strictEqual(entry.hooks.length, 1);
      assert.strictEqual(entry.hooks[0].type, "command");
      assert.ok(commandText(entry.hooks[0].command).includes(MARKER));
      assert.ok(commandText(entry.hooks[0].command).includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const configPath = makeTempConfigFile({});
    registerTraeCodeHooks({ silent: true, hooksPath: configPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(configPath, "utf8");

    const result = registerTraeCodeHooks({ silent: true, hooksPath: configPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths in nested format", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/old/node" "/old/path/traecode-hook.js"' }],
        }],
      },
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(configPath);
    assert.ok(commandText(settings.hooks.Stop[0].hooks[0].command).includes("/usr/local/bin/node"));
    assert.ok(!commandText(settings.hooks.Stop[0].hooks[0].command).includes("/old/path/"));
    assert.strictEqual(settings.hooks.Stop.length, 1);
  });

  it("updates stale hook paths in flat format (migration)", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        PreToolUse: [{ command: '"/old/node" "/old/path/traecode-hook.js"' }],
      },
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(configPath);
    const entry = settings.hooks.PreToolUse[0];
    assert.ok(Array.isArray(entry.hooks), "flat entry must be converted to nested shape");
    assert.ok(commandText(entry.hooks[0].command).includes("/usr/local/bin/node"));
    assert.ok(!commandText(entry.hooks[0].command).includes("/old/path/"));
  });

  it("preserves existing node path from nested format when detection fails", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/traecode-hook.js"' }],
        }],
      },
    });

    registerTraeCodeHooks({ silent: true, hooksPath: configPath, nodeBin: null });

    const settings = readJson(configPath);
    assert.ok(commandText(settings.hooks.Stop[0].hooks[0].command).includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("encodes quoted Windows paths so Trae sandbox receives one command-line argument", () => {
    const configPath = makeTempConfigFile({});
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin,
      platform: "win32",
    });

    assert.strictEqual(result.added, 6);

    const settings = readJson(configPath);
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /^[^\s"']*powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/i);
    assert.ok(!command.includes('"'), "outer command must not contain double quotes");
    assert.ok(!command.includes("'"), "outer command must not contain single quotes");
    const decoded = decodeWindowsEncodedCommand(command);
    assert.strictEqual(decoded, expectedWindowsPayload(nodeBin));
  });

  it("emits a plain quoted command on POSIX (no & operator)", () => {
    const configPath = makeTempConfigFile({});
    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
      platform: "darwin",
    });

    assert.strictEqual(result.added, 6);
    const settings = readJson(configPath);
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.ok(command.startsWith('"/usr/local/bin/node"'), `expected quoted command without &, got: ${command}`);
    assert.ok(!command.startsWith("&"), "POSIX command must not carry the PowerShell & operator");
  });

  it("skips registration when ~/.trae-cn/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-traecode-home-"));
    tempDirs.push(fakeHome);
    const result = registerTraeCodeHooks({
      silent: true,
      homeDir: fakeHome,
      nodeBin: "/usr/local/bin/node",
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".trae-cn", "hooks.json")), false);
  });

  it("unregister removes only managed command hooks and preserves foreign hooks", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: '"/usr/local/bin/node" "/some/path/traecode-hook.js"' },
              { type: "command", command: "node /home/u/third-party.js" },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: '"/usr/local/bin/node" "/some/path/traecode-hook.js"' }],
          },
        ],
      },
    });

    const result = unregisterTraeCodeHooks({ silent: true, hooksPath: configPath });

    assert.ok(result.removed >= 2);
    const settings = readJson(configPath);
    assert.strictEqual(settings.hooks.Stop.length, 1);
    assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, "node /home/u/third-party.js");
    assert.strictEqual(settings.hooks.SessionStart, undefined);
  });

  it("unregister with no managed hooks leaves file unchanged", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /home/u/third-party.js" }] }],
      },
    });

    const result = unregisterTraeCodeHooks({ silent: true, hooksPath: configPath });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(listCleanupBackups(configPath), []);
  });

  it("unregister creates a backup file when changes are made", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"/usr/local/bin/node" "/some/path/traecode-hook.js"' }] }],
      },
    });

    const result = unregisterTraeCodeHooks({ silent: true, hooksPath: configPath, backup: true });

    assert.ok(result.removed >= 1);
    assert.strictEqual(result.changed, true);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));
    assert.strictEqual(listCleanupBackups(configPath).length, 1);
  });
});

describe("TraeCode hook installer (Windows)", () => {
  it("uses a quote-free EncodedCommand wrapper and no shell field on Windows", () => {
    const configPath = makeTempConfigFile({});
    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(result.added, 6);

    const settings = readJson(configPath);
    for (const event of TRAECODE_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.match(hook.command, /^[^\s"']*powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/i);
      assert.ok(!hook.command.includes('"'), `${event}: outer command must not contain double quotes`);
      assert.ok(!hook.command.includes("'"), `${event}: outer command must not contain single quotes`);
      const decoded = decodeWindowsEncodedCommand(hook.command);
      assert.strictEqual(decoded, expectedWindowsPayload("C:\\Program Files\\nodejs\\node.exe"));
      // The `shell` field is undocumented by Trae and must not be written.
      assert.strictEqual(hook.shell, undefined, `${event}: must not carry a shell field`);
    }
  });

  it("does not allow generic installer options to override the encoded wrapper", () => {
    const configPath = makeTempConfigFile({});
    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      powerShellBin: "C:\\evil dir\\ps.exe",
      env: { SystemRoot: "C:\\Weird Root" },
    });

    const command = readJson(configPath).hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /^[^\s"']*powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /i);
    assert.ok(!command.includes("evil dir"));
    assert.ok(!command.includes("Weird Root"));
  });

  it("is idempotent on Windows with EncodedCommand format", () => {
    const configPath = makeTempConfigFile({});
    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const contentBefore = fs.readFileSync(configPath, "utf8");

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), contentBefore);
  });

  it("preserves an existing encoded Windows node path when detection fails", () => {
    const configPath = makeTempConfigFile({});
    const nodeBin = "C:\\Custom Node\\node.exe";
    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin,
      platform: "win32",
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: null,
      platform: "win32",
    });

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, TRAECODE_HOOK_EVENTS.length);
    const command = readJson(configPath).hooks.Stop[0].hooks[0].command;
    assert.strictEqual(decodeWindowsEncodedCommand(command), expectedWindowsPayload(nodeBin));
  });

  it("removes all six encoded managed hooks on Windows", () => {
    const configPath = makeTempConfigFile({});
    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const result = unregisterTraeCodeHooks({ silent: true, hooksPath: configPath });

    assert.strictEqual(result.removed, TRAECODE_HOOK_EVENTS.length);
    assert.strictEqual(result.changed, true);
    const settings = readJson(configPath);
    for (const event of TRAECODE_HOOK_EVENTS) {
      assert.strictEqual(settings.hooks[event], undefined, `${event}: encoded hook must be removed`);
    }
  });

  it("survives the PowerShell 5.1 native argv forwarding used by Trae sandbox", windowsOnly, () => {
    const configPath = makeTempConfigFile({});
    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const command = readJson(configPath).hooks.SessionStart[0].hooks[0].command;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-traecode-argv-"));
    tempDirs.push(tmpDir);
    const probePath = path.join(tmpDir, "argv-probe.ps1");
    fs.writeFileSync(probePath, "param([string]$Value)\n[Console]::Out.Write($Value)\n", "utf8");

    const powerShell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;
    // Trae's hook runner builds this same shape before PowerShell calls the
    // native sandbox executable. The probe is another native process, so it
    // exercises PowerShell 5.1's argv serialization boundary without needing
    // Trae installed in CI.
    const outer = [
      "&",
      quotePowerShell(powerShell),
      "-NoProfile",
      "-NonInteractive",
      "-File",
      quotePowerShell(probePath),
      "-Value",
      quotePowerShell(command),
    ].join(" ");
    const outerEncoded = Buffer.from(outer, "utf16le").toString("base64");
    const probe = spawnSync(powerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      outerEncoded,
    ], { encoding: "utf8", timeout: 10000 });

    assert.strictEqual(probe.status, 0, `probe stderr=${probe.stderr}`);
    assert.strictEqual(probe.stdout, command);
  });

  it("migrates a legacy bare-quoted command to EncodedCommand on Windows", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        SessionStart: [{
          matcher: "",
          hooks: [{
            type: "command",
            // Legacy format: no & prefix, no shell field — fails in PowerShell
            command: '"C:\\Program Files\\nodejs\\node.exe" "D:/old/path/traecode-hook.js"',
          }],
        }],
      },
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(configPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.ok(decodeWindowsEncodedCommand(hook.command)?.includes(MARKER), "migrated command must be encoded");
    assert.strictEqual(hook.shell, undefined, "migrated command must not carry a shell field");
  });

  it("drops a legacy shell: powershell field on migration", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        SessionStart: [{
          matcher: "",
          hooks: [{
            type: "command",
            command: '& "C:\\Program Files\\nodejs\\node.exe" "D:/path/traecode-hook.js"',
            shell: "powershell",
          }],
        }],
      },
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(configPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].shell, undefined);
  });
});

describe("TraeCode hook installer (hardening)", () => {
  it("preserves the documented version 1", () => {
    const configPath = makeTempConfigFile({ version: 1 });

    registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(readJson(configPath).version, 1);
  });

  it("fails closed on every explicit non-v1 version without changing the file", () => {
    const invalidVersions = [2, 1.5, 0, -1, "1", null, true, {}, [1]];
    for (const version of invalidVersions) {
      const configPath = makeTempConfigFile({
        version,
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "node foreign-hook.js" }] }],
        },
      });
      const contentBefore = fs.readFileSync(configPath, "utf8");

      assert.throws(() => registerTraeCodeHooks({
        silent: true,
        hooksPath: configPath,
        nodeBin: "/usr/local/bin/node",
      }), /unsupported "version"/);
      assert.strictEqual(fs.readFileSync(configPath, "utf8"), contentBefore);
    }
  });

  it("converts an owned flat entry to the documented nested shape", () => {
    const configPath = makeTempConfigFile({
      hooks: {
        PreToolUse: [{ command: '"/usr/local/bin/node" "/old/path/traecode-hook.js"' }],
      },
    });

    const result = registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(configPath);
    const entry = settings.hooks.PreToolUse[0];
    assert.ok(Array.isArray(entry.hooks), "flat entry must be converted to nested shape");
    assert.strictEqual(entry.matcher, "");
    assert.strictEqual(entry.hooks[0].type, "command");
    assert.ok(commandText(entry.hooks[0].command).includes(MARKER));
  });

  it("fails closed when the root is not an object", () => {
    const configPath = makeTempConfigFile([]);
    assert.throws(() => registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    }), /not a JSON object/);
  });

  it("fails closed when hooks is not an object", () => {
    const configPath = makeTempConfigFile({ hooks: [] });
    assert.throws(() => registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    }), /"hooks" is not an object/);
  });

  it("fails closed when a hook event is not an array", () => {
    const configPath = makeTempConfigFile({ hooks: { SessionStart: {} } });
    assert.throws(() => registerTraeCodeHooks({
      silent: true,
      hooksPath: configPath,
      nodeBin: "/usr/local/bin/node",
    }), /"SessionStart" is not an array/);
  });
});
