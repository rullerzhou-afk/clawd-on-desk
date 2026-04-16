const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerHooks, __test } = require("../hooks/install");

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

function getClawdCommands(settings, event) {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const commands = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes("clawd-hook.js")) {
      commands.push(entry.command);
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === "string" && hook.command.includes("clawd-hook.js")) {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Hook installer version compatibility", () => {
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
});
