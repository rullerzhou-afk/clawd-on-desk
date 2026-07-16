const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  QODERWORK_HOOK_EVENTS,
  registerQoderWorkHooks,
  unregisterQoderWorkHooks,
} = require("../hooks/qoderwork-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoderwork-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Current win32 installs write the portable bash/cmd form (#597, M6). Legacy
// entries were PowerShell -EncodedCommand; decode those before asserting on
// substrings. Portable commands pass through unchanged.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("QoderWork hook installer", () => {
  it("exports MARKER and the Phase 1 event list (incl. permission events)", () => {
    assert.strictEqual(MARKER, "qoderwork-hook.js");
    assert.deepStrictEqual(QODERWORK_HOOK_EVENTS, [
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
    const result = registerQoderWorkHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, QODERWORK_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);
    for (const event of QODERWORK_HOOK_EVENTS) {
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

  // QoderWork shares Qoder's qodercli Git Bash executor on Windows (#597, M6),
  // so the command must be the bash/cmd-portable form, never -EncodedCommand
  // (bash eats the unquoted backslash powershell.exe path → exit 127).
  it("writes the portable bash/cmd form on Windows (space in node path → bare node)", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderWorkHooks({
      silent: true,
      settingsPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const settings = readJson(settingsPath);
    const command = settings.hooks.Stop[0].hooks[0].command;
    assert.doesNotMatch(command, /-EncodedCommand/);
    assert.doesNotMatch(command, /\\/); // no backslashes — bash would eat them
    assert.ok(command.startsWith('node "'), command);
    assert.ok(command.includes(MARKER), command);
    assert.ok(command.endsWith('"Stop"'), command);
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, QODERWORK_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { matcher: "*", hooks: [{ type: "command", command: "other-tool --flag", name: "other" }] };
    const settingsPath = makeTempSettingsFile({ hooks: { SessionStart: [thirdParty] } });

    registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes(MARKER));
  });

  it("normalizes a legacy flat clawd entry into the nested shape", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ matcher: "*", command: 'node "/old/path/qoderwork-hook.js" "Stop"' }] },
    });

    const result = registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });
    assert.ok(result.updated >= 1);

    const stop = readJson(settingsPath).hooks.Stop;
    assert.strictEqual(stop.length, 1);
    assert.ok(Array.isArray(stop[0].hooks));
    assert.strictEqual(stop[0].hooks[0].name, "clawd");
    assert.ok(stop[0].hooks[0].command.includes("/usr/local/bin/node"));
  });

  it("collapses a disabled clawd command reference into the 'clawd' id", () => {
    const settingsPath = makeTempSettingsFile({
      hooksConfig: { disabled: ['node "/x/qoderwork-hook.js" "Stop"', "user-hook"] },
    });

    registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const disabled = readJson(settingsPath).hooksConfig.disabled;
    assert.ok(disabled.includes("clawd"));
    assert.ok(disabled.includes("user-hook"));
    assert.ok(!disabled.some((e) => typeof e === "string" && e.includes("qoderwork-hook.js")));
  });

  it("skips when ~/.qoderwork/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoderwork-home-"));
    tempDirs.push(fakeHome);
    const result = registerQoderWorkHooks({ silent: true, nodeBin: "/usr/local/bin/node", homeDir: fakeHome });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".qoderwork", "settings.json")), false);
  });

  it("uninstall removes only clawd entries and keeps third-party", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderWorkHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "win32" });

    let settings = readJson(settingsPath);
    settings.hooks.SessionStart.unshift({
      matcher: "*",
      hooks: [{ type: "command", command: "other-tool --flag", name: "other" }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = unregisterQoderWorkHooks({ silent: true, settingsPath });
    assert.ok(result.removed >= QODERWORK_HOOK_EVENTS.length, `removed ${result.removed}`);

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

  // Back-compat: a user upgrading from a build that wrote the -EncodedCommand
  // form must have that entry migrated in place to the portable form (#597, M6),
  // not left broken. register decodes the marker to detect its own stale entry.
  it("migrates a legacy Windows -EncodedCommand entry to the portable form", () => {
    const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
    const legacy = buildWindowsEncodedNodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/app/hooks/qoderwork-hook.js",
      ["Stop"],
    );
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ matcher: "*", hooks: [{ name: "clawd", type: "command", command: legacy }] }] },
    });

    const result = registerQoderWorkHooks({
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
});
