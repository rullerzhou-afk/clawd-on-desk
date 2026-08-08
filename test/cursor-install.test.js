const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerCursorHooks,
  CURSOR_HOOK_EVENTS,
  buildCursorHookCommand,
} = require("../hooks/cursor-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const MARKER = "cursor-hook.js";
const tempDirs = [];

function makeTempHooksFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-"));
  const hooksPath = path.join(tmpDir, "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return hooksPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Cursor hook installer", () => {
  it("registers all events on fresh install", () => {
    const hooksPath = makeTempHooksFile({});
    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CURSOR_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.version, 1);
    for (const event of CURSOR_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.ok(typeof entry.command === "string");
      assert.ok(entry.command.includes(MARKER));
      assert.ok(entry.command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const hooksPath = makeTempHooksFile({});
    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });
    const contentBefore = fs.readFileSync(hooksPath, "utf8");

    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CURSOR_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{ command: '"/old/node" "/old/path/cursor-hook.js"' }],
        preToolUse: [{ command: '"/old/node" "/old/path/cursor-hook.js"' }],
      },
    });

    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.ok(result.updated >= 2);
    const settings = readJson(hooksPath);
    assert.ok(settings.hooks.stop[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.stop[0].command.includes("/old/path/"));
    assert.strictEqual(settings.hooks.stop.length, 1);
  });

  it("preserves existing node path when detection fails", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{ command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/cursor-hook.js"' }],
      },
    });

    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: null,
      platform: "linux",
    });

    const settings = readJson(hooksPath);
    assert.ok(settings.hooks.stop[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { command: "some-other-tool --flag" };
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        sessionStart: [thirdParty],
      },
    });

    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.sessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.sessionStart[0], thirdParty);
    assert.ok(settings.hooks.sessionStart[1].command.includes(MARKER));
  });

  it("skips when ~/.cursor/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-home-"));
    tempDirs.push(fakeHome);
    const result = registerCursorHooks({
      silent: true,
      nodeBin: "/usr/local/bin/node",
      homeDir: fakeHome,
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".cursor", "hooks.json")), false);
  });

  it("wraps Windows commands in PowerShell -EncodedCommand to survive paths with spaces", () => {
    // Regression: Cursor's Windows hook launcher + cmd /s quote stripping
    // breaks default install paths like "Clawd on Desk" (MODULE_NOT_FOUND on
    // 'E:\\ClawdDesk\\Clawd'). EncodedCommand matches Reasonix / Qwen.
    const hooksPath = makeTempHooksFile({});
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin,
      platform: "win32",
    });

    const settings = readJson(hooksPath);
    const hookScript = path.resolve(__dirname, "..", "hooks", "cursor-hook.js").replace(/\\/g, "/");
    const expected = buildCursorHookCommand(nodeBin, hookScript, "win32");
    assert.strictEqual(settings.hooks.stop[0].command, expected);
    assert.match(settings.hooks.stop[0].command, /-EncodedCommand /);
    assert.ok(!settings.hooks.stop[0].command.startsWith("cmd /d /s /c "));
    const decoded = decodeWindowsEncodedCommand(settings.hooks.stop[0].command);
    assert.ok(decoded.includes(nodeBin));
    assert.ok(decoded.includes(MARKER));
  });

  it("rewrites legacy cmd-wrapped Windows hooks into EncodedCommand form", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{
          command: 'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/old/cursor-hook.js""',
        }],
      },
    });

    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const settings = readJson(hooksPath);
    assert.match(settings.hooks.stop[0].command, /-EncodedCommand /);
    const decoded = decodeWindowsEncodedCommand(settings.hooks.stop[0].command);
    assert.ok(decoded.includes("C:\\Program Files\\nodejs\\node.exe"));
    assert.ok(decoded.includes(MARKER));
    assert.ok(!decoded.includes("D:/old/"));
  });

  it("preserves an existing Windows node path when detection fails", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{
          command: 'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "D:/old/cursor-hook.js""',
        }],
      },
    });

    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: null,
      platform: "win32",
    });

    const settings = readJson(hooksPath);
    const command = settings.hooks.stop[0].command;
    const decoded = decodeWindowsEncodedCommand(command) || command;
    assert.ok(decoded.includes("C:\\Program Files\\nodejs\\node.exe"));
  });
});
