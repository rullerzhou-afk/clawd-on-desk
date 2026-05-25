const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  QWEN_CODE_HOOK_EVENTS,
  buildQwenCodeHookCommand,
  matcherForQwenCodeEvent,
  registerQwenCodeHooks,
  timeoutForQwenCodeEvent,
} = require("../hooks/qwen-code-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qwen-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// On win32 the installer wraps commands in PowerShell -EncodedCommand
// (regression fix for qwen 0.16.1 cmd /s quote stripping). Tests that
// assert on substrings inside the command must decode first.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Qwen Code hook installer", () => {
  it("registers the Phase 1 events with event-specific matcher and timeout", () => {
    const settingsPath = makeTempSettingsFile({
      model: "qwen3-coder-plus",
      env: { KEEP: "me" },
    });
    const result = registerQwenCodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.model, "qwen3-coder-plus");
    assert.deepStrictEqual(settings.env, { KEEP: "me" });
    for (const event of QWEN_CODE_HOOK_EVENTS) {
      const entry = settings.hooks[event][0];
      const matcher = matcherForQwenCodeEvent(event);
      if (matcher === null) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "matcher"), false, event);
      } else {
        assert.strictEqual(entry.matcher, matcher, event);
      }
      assert.strictEqual(entry.hooks.length, 1);
      assert.strictEqual(entry.hooks[0].name, "clawd");
      assert.strictEqual(entry.hooks[0].type, "command");
      assert.strictEqual(entry.hooks[0].timeout, timeoutForQwenCodeEvent(event));
      const payload = commandPayload(entry.hooks[0].command);
      assert.ok(payload.includes(MARKER), `${event}: ${payload}`);
      assert.ok(payload.includes("/usr/local/bin/node"), `${event}: ${payload}`);
      // POSIX: `"... " "event"`. Windows encoded: `... 'event'`.
      assert.ok(
        payload.endsWith(`"${event}"`) || payload.endsWith(`'${event}'`),
        `${event}: ${payload}`
      );
    }
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQwenCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerQwenCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, QWEN_CODE_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("preserves disableAllHooks and returns a warning without changing the flag", () => {
    const settingsPath = makeTempSettingsFile({ disableAllHooks: true });

    const result = registerQwenCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.disableAllHooks, true);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /disableAllHooks=true/);
  });

  it("splits Clawd out of shared matcher entries", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [
            { type: "command", command: "other-tool", name: "other" },
            { type: "command", command: '"/old/node" "/old/path/qwen-code-hook.js" "PreToolUse"', name: "clawd" },
          ],
        }],
      },
    });

    const result = registerQwenCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.PreToolUse[0], {
      matcher: "Bash",
      hooks: [{ type: "command", command: "other-tool", name: "other" }],
    });
    assert.strictEqual(settings.hooks.PreToolUse[1].matcher, "*");
    assert.ok(commandPayload(settings.hooks.PreToolUse[1].hooks[0].command).includes("/usr/local/bin/node"));
  });

  it("preserves existing absolute node path when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: '"/home/user/.nvm/versions/node/v22/bin/node" "/old/path/qwen-code-hook.js" "Stop"',
            name: "clawd",
          }],
        }],
      },
    });

    registerQwenCodeHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(commandPayload(settings.hooks.Stop[0].hooks[0].command).includes("/home/user/.nvm/versions/node/v22/bin/node"));
  });

  it("skips startup auto-sync when ~/.qwen does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qwen-home-"));
    tempDirs.push(tmpDir);

    const result = registerQwenCodeHooks({ silent: true, homeDir: tmpDir, nodeBin: "/usr/local/bin/node" });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0, warnings: [] });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, ".qwen", "settings.json")), false);
  });

  it("wraps Windows commands in PowerShell -EncodedCommand to bypass cmd /s quote stripping", () => {
    // Regression: qwen 0.16.1 spawns hooks via `cmd.exe /d /s /c <command>`,
    // and cmd /s strips outer quotes — any "C:\Program Files\..." path with
    // a space dies as 'C:\Program' is not recognized. We must produce the
    // EncodedCommand form so cmd never sees the node path directly.
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const command = buildQwenCodeHookCommand(
      nodeBin,
      "D:/clawd/hooks/qwen-code-hook.js",
      "PermissionRequest",
      {
        platform: "win32",
        powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }
    );

    assert.ok(
      command.startsWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "),
      `unexpected command prefix: ${command}`
    );
    assert.strictEqual(
      decodeWindowsEncodedCommand(command),
      `& '${nodeBin}' 'D:/clawd/hooks/qwen-code-hook.js' 'PermissionRequest'`
    );
  });

  it("rewrites legacy bare-quoted Windows commands into EncodedCommand form on re-run", () => {
    // Pre-fix Codex install left bare quoted commands in settings.json that
    // Qwen could not execute. Auto-sync after the fix must rewrite them.
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "*",
          hooks: [{
            name: "clawd",
            type: "command",
            command: '"C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/qwen-code-hook.js" "PermissionRequest"',
            timeout: 600000,
          }],
        }],
      },
    });

    const result = registerQwenCodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.ok(result.updated >= 1, "legacy bare command must be replaced");
    const settings = readJson(settingsPath);
    const entry = settings.hooks.PermissionRequest[0].hooks[0];
    assert.match(entry.command, /-EncodedCommand /);
    const decoded = decodeWindowsEncodedCommand(entry.command);
    assert.ok(decoded.includes(MARKER));
    assert.ok(decoded.endsWith("'PermissionRequest'"));
  });

  it("preserves an existing Windows absolute node path through the encoded command", () => {
    // Mirror the antigravity "preserve absolute node path" coverage so we
    // do not lose a manually-repaired nvm/portable node path when the
    // installer cannot detect one on its own.
    const settingsPath = makeTempSettingsFile({});
    registerQwenCodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Tools\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const before = readJson(settingsPath);
    const stopBefore = before.hooks.Stop[0].hooks[0].command;
    assert.match(decodeWindowsEncodedCommand(stopBefore), /'C:\\Tools\\node\.exe'/);

    const result = registerQwenCodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: null,
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.strictEqual(result.skipped, QWEN_CODE_HOOK_EVENTS.length);
    const after = readJson(settingsPath);
    assert.match(decodeWindowsEncodedCommand(after.hooks.Stop[0].hooks[0].command), /'C:\\Tools\\node\.exe'/);
  });
});
