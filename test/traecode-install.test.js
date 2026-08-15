const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerTraeCodeHooks,
  unregisterTraeCodeHooks,
  TRAECODE_HOOK_EVENTS,
} = require("../hooks/traecode-install");

const MARKER = "traecode-hook.js";
const tempDirs = [];

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
      assert.ok(entry.hooks[0].command.includes(MARKER));
      assert.ok(entry.hooks[0].command.includes("/usr/local/bin/node"));
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
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.Stop[0].hooks[0].command.includes("/old/path/"));
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
    assert.ok(settings.hooks.PreToolUse[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.PreToolUse[0].command.includes("/old/path/"));
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
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
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
