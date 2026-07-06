const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  QODER_HOOK_EVENTS,
  registerQoderHooks,
  unregisterQoderHooks,
} = require("../hooks/qoder-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// On win32 the installer wraps commands in PowerShell -EncodedCommand; decode
// before asserting on substrings inside the command.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Qoder hook installer", () => {
  it("exports MARKER and the Phase 1 event list (incl. permission events)", () => {
    assert.strictEqual(MARKER, "qoder-hook.js");
    assert.deepStrictEqual(QODER_HOOK_EVENTS, [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "Notification",
      "PermissionRequest",
      "PermissionDenied",
      "SessionEnd",
    ]);
  });

  it("registers all events on fresh install (POSIX command form)", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerQoderHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, QODER_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);
    for (const event of QODER_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(entry.matcher, "*");
      assert.ok(Array.isArray(entry.hooks));
      assert.strictEqual(entry.hooks.length, 1);
      const hook = entry.hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.strictEqual(hook.name, "clawd");
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
      assert.ok(hook.command.endsWith(`"${event}"`));
    }
  });

  // Qoder CLI executes command hooks through Git Bash on Windows (#597), so
  // the command must be the bash/cmd-portable form, never -EncodedCommand
  // (bash eats the unquoted backslash powershell.exe path → exit 127).
  it("writes the portable bash/cmd form on Windows (space in node path → bare node)", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderHooks({
      silent: true,
      settingsPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const settings = readJson(settingsPath);
    const command = settings.hooks.Stop[0].hooks[0].command;
    assert.doesNotMatch(command, /-EncodedCommand/);
    assert.doesNotMatch(command, /\\/); // no backslashes anywhere — bash would eat them
    // "C:\Program Files\..." contains a space, so the interpreter token falls
    // back to a bare PATH lookup.
    assert.ok(command.startsWith('node "'), command);
    assert.ok(command.includes(MARKER), command);
    assert.ok(command.endsWith('"Stop"'), command);
  });

  it("keeps an unquoted forward-slash node token when the path needs no quoting", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderHooks({
      silent: true,
      settingsPath,
      nodeBin: "C:\\nodejs\\node.exe",
      platform: "win32",
    });

    const command = readJson(settingsPath).hooks.Stop[0].hooks[0].command;
    assert.ok(command.startsWith('C:/nodejs/node.exe "'), command);
    assert.ok(command.endsWith('"Stop"'), command);
  });

  it("migrates a legacy Windows -EncodedCommand entry to the portable form", () => {
    const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
    const legacy = buildWindowsEncodedNodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/app/hooks/qoder-hook.js",
      ["Stop"],
    );
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ matcher: "*", hooks: [{ name: "clawd", type: "command", command: legacy }] }] },
    });

    const result = registerQoderHooks({
      silent: true,
      settingsPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    assert.ok(result.updated >= 1, JSON.stringify(result));

    const stop = readJson(settingsPath).hooks.Stop;
    assert.strictEqual(stop.length, 1);
    const command = stop[0].hooks[0].command;
    assert.doesNotMatch(command, /-EncodedCommand/);
    assert.ok(command.startsWith('node "'), command);
    assert.ok(command.endsWith('"Stop"'), command);
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, QODER_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { matcher: "*", hooks: [{ type: "command", command: "other-tool --flag", name: "other" }] };
    const settingsPath = makeTempSettingsFile({ hooks: { SessionStart: [thirdParty] } });

    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes(MARKER));
  });

  it("normalizes a legacy flat clawd entry into the nested shape", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ matcher: "*", command: 'node "/old/path/qoder-hook.js" "Stop"' }] },
    });

    const result = registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });
    assert.ok(result.updated >= 1);

    const stop = readJson(settingsPath).hooks.Stop;
    assert.strictEqual(stop.length, 1);
    assert.ok(Array.isArray(stop[0].hooks));
    assert.strictEqual(stop[0].hooks[0].name, "clawd");
    assert.ok(stop[0].hooks[0].command.includes("/usr/local/bin/node"));
  });

  it("collapses a disabled clawd command reference into the 'clawd' id", () => {
    const settingsPath = makeTempSettingsFile({
      hooksConfig: { disabled: ['node "/x/qoder-hook.js" "Stop"', "user-hook"] },
    });

    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const disabled = readJson(settingsPath).hooksConfig.disabled;
    assert.ok(disabled.includes("clawd"));
    assert.ok(disabled.includes("user-hook"));
    assert.ok(!disabled.some((e) => typeof e === "string" && e.includes("qoder-hook.js")));
  });

  it("skips when ~/.qoder/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-home-"));
    tempDirs.push(fakeHome);
    const result = registerQoderHooks({ silent: true, nodeBin: "/usr/local/bin/node", homeDir: fakeHome });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".qoder", "settings.json")), false);
  });

  it("uninstall removes only clawd entries (incl. legacy Windows-encoded) and keeps third-party", () => {
    const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
    const settingsPath = makeTempSettingsFile({});
    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "win32" });

    let settings = readJson(settingsPath);
    // Seed one legacy encoded entry so uninstall must decode to detect the marker.
    settings.hooks.Stop.push({
      matcher: "*",
      hooks: [{
        name: "clawd",
        type: "command",
        command: buildWindowsEncodedNodeHookCommand("C:\\nodejs\\node.exe", "D:/app/hooks/qoder-hook.js", ["Stop"]),
      }],
    });
    settings.hooks.SessionStart.unshift({
      matcher: "*",
      hooks: [{ type: "command", command: "other-tool --flag", name: "other" }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = unregisterQoderHooks({ silent: true, settingsPath });
    assert.ok(result.removed >= QODER_HOOK_EVENTS.length, `removed ${result.removed}`);

    settings = readJson(settingsPath);
    assert.ok(settings.hooks.SessionStart, "SessionStart key should remain");
    assert.ok(
      settings.hooks.SessionStart.some((e) => e.hooks && e.hooks.some((h) => h.name === "other")),
      "third-party hook should survive"
    );
    for (const event of Object.keys(settings.hooks)) {
      for (const entry of settings.hooks[event]) {
        if (!entry || !entry.hooks) continue;
        for (const hook of entry.hooks) {
          const payload = commandPayload(hook.command || "");
          assert.ok(!payload.includes(MARKER), `clawd entry found in ${event}: ${payload}`);
        }
      }
    }
  });
});
