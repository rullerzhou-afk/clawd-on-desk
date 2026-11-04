const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  HOOK_TIMEOUT_SECONDS,
  COMMAND_CODE_HOOK_EVENTS,
  registerCommandCodeHooks,
  unregisterCommandCodeHooks,
} = require("../hooks/command-code-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-command-code-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Legacy entries may still be PowerShell -EncodedCommand; decode those before
// asserting on substrings. Portable commands pass through unchanged.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Command Code hook installer", () => {
  it("exports MARKER and the four documented hook events", () => {
    assert.strictEqual(MARKER, "command-code-hook.js");
    assert.deepStrictEqual(COMMAND_CODE_HOOK_EVENTS, [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    assert.strictEqual(HOOK_TIMEOUT_SECONDS, 5);
  });

  it("registers all events on fresh install (POSIX command form, no matcher)", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerCommandCodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      platform: "darwin",
    });

    assert.strictEqual(result.added, COMMAND_CODE_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);
    for (const event of COMMAND_CODE_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      // A matcher on Stop / SessionStart would prevent the hook from firing
      // at all, and Command Code treats an absent matcher as "every tool".
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "matcher"), false);
      assert.deepStrictEqual(Object.keys(entry), ["hooks"]);
      assert.ok(Array.isArray(entry.hooks));
      assert.strictEqual(entry.hooks.length, 1);
      const hook = entry.hooks[0];
      assert.deepStrictEqual(hook, {
        type: "command",
        command: `"/usr/local/bin/node" "${path.resolve(__dirname, "..", "hooks", MARKER).replace(/\\/g, "/")}"`,
        timeout: HOOK_TIMEOUT_SECONDS,
      });
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
    }
  });

  it("rejects an array-valued hooks root without reporting a false-success install", () => {
    const settingsPath = makeTempSettingsFile({ hooks: [] });
    const before = fs.readFileSync(settingsPath, "utf8");

    assert.throws(
      () => registerCommandCodeHooks({
        silent: true,
        settingsPath,
        nodeBin: "/usr/local/bin/node",
        platform: "darwin",
      }),
      /hooks must be an object keyed by event name/
    );
    assert.strictEqual(
      fs.readFileSync(settingsPath, "utf8"),
      before,
      "invalid but parseable user config must be preserved byte-for-byte"
    );
  });

  it("rejects non-object top-level JSON without mutating it or reporting added hooks", () => {
    const cases = [
      { label: "empty array", initial: [] },
      { label: "non-empty array", initial: [{ user: "data" }] },
      { label: "string", initial: "hello" },
      { label: "number", initial: 42 },
      { label: "boolean", initial: false },
      { label: "null", initial: null },
    ];

    for (const testCase of cases) {
      const settingsPath = makeTempSettingsFile(testCase.initial);
      const before = fs.readFileSync(settingsPath, "utf8");
      assert.throws(
        () => registerCommandCodeHooks({
          silent: true,
          settingsPath,
          nodeBin: "/usr/local/bin/node",
          platform: "darwin",
        }),
        /top level must be an object/,
        testCase.label
      );
      assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before, testCase.label);
    }
  });

  // Command Code runs hook commands through `cmd.exe /c` on Windows and
  // `/bin/bash -c` on POSIX, so the command must be the portable bash/cmd
  // form (unquoted forward-slash node token), never -EncodedCommand.
  it("writes the portable bash/cmd form on Windows (space in node path → bare node)", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCommandCodeHooks({
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
    assert.doesNotMatch(command, /"Stop"/, "Command Code reads the event from stdin, not argv");
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, COMMAND_CODE_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { matcher: "shell", hooks: [{ type: "command", command: "other-tool --flag" }] };
    const settingsPath = makeTempSettingsFile({ hooks: { SessionStart: [thirdParty] } });

    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes(MARKER));
  });

  it("normalizes a legacy flat clawd entry into the nested shape", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ command: 'node "/old/path/command-code-hook.js"' }] },
    });

    const result = registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });
    assert.ok(result.updated >= 1);

    const stop = readJson(settingsPath).hooks.Stop;
    assert.strictEqual(stop.length, 1);
    assert.ok(Array.isArray(stop[0].hooks));
    assert.ok(stop[0].hooks[0].command.includes("/usr/local/bin/node"));
    assert.strictEqual(stop[0].hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  it("strips a clawd handler out of a mixed entry and keeps the foreign handler and matcher", () => {
    const foreign = { type: "command", command: "other-tool --flag" };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PreToolUse: [
          { matcher: "shell", hooks: [{ type: "command", command: 'node "/x/command-code-hook.js"' }, foreign] },
        ],
      },
    });

    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const entries = readJson(settingsPath).hooks.PreToolUse;
    assert.strictEqual(entries.length, 2, JSON.stringify(entries));
    assert.deepStrictEqual(entries[0], { matcher: "shell", hooks: [foreign] });
    assert.strictEqual(entries[1].hooks[0].command.includes("/usr/local/bin/node"), true);
    assert.strictEqual(entries[1].hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  });

  it("drops a matcher on a clawd-only entry (a matcher on Stop/SessionStart would silence it)", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{ matcher: "shell", hooks: [{ type: "command", command: 'node "/x/command-code-hook.js"', timeout: 5 }] }],
      },
    });

    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const stop = readJson(settingsPath).hooks.Stop;
    assert.strictEqual(stop.length, 1);
    assert.deepStrictEqual(Object.keys(stop[0]), ["hooks"]);
  });

  it("collapses duplicate clawd entries into one canonical entry", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: 'node "/a/command-code-hook.js"', timeout: 5 }] },
          { hooks: [{ type: "command", command: 'node "/b/command-code-hook.js"', timeout: 5 }] },
        ],
      },
    });

    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const entries = readJson(settingsPath).hooks.PostToolUse;
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].hooks[0].command.includes("/usr/local/bin/node"));
  });

  it("skips when ~/.commandcode/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-command-code-home-"));
    tempDirs.push(fakeHome);
    const result = registerCommandCodeHooks({ silent: true, nodeBin: "/usr/local/bin/node", homeDir: fakeHome });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".commandcode", "settings.json")), false);
  });

  it("uninstall removes only clawd entries and keeps third-party", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "win32" });

    let settings = readJson(settingsPath);
    settings.hooks.SessionStart.unshift({
      matcher: "shell",
      hooks: [{ type: "command", command: "other-tool --flag" }],
    });
    settings.permissions = { allow: ["Bash(npm test)"] };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = unregisterCommandCodeHooks({ silent: true, settingsPath });
    assert.ok(result.removed >= COMMAND_CODE_HOOK_EVENTS.length, `removed ${result.removed}`);

    settings = readJson(settingsPath);
    assert.ok(settings.hooks.SessionStart, "SessionStart key should remain");
    assert.ok(
      settings.hooks.SessionStart.some((e) => e.hooks && e.hooks.some((h) => h.command === "other-tool --flag")),
      "third-party hook should survive"
    );
    assert.deepStrictEqual(settings.permissions, { allow: ["Bash(npm test)"] }, "user settings must survive");
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

  it("uninstall leaves no empty event arrays or an emptied hooks container behind", () => {
    const settingsPath = makeTempSettingsFile({ permissions: { defaultMode: "default" } });
    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });
    assert.ok(readJson(settingsPath).hooks.SessionStart, "precondition: install wrote the four events");

    const result = unregisterCommandCodeHooks({ silent: true, settingsPath });
    assert.strictEqual(result.removed, COMMAND_CODE_HOOK_EVENTS.length);
    assert.strictEqual(result.changed, true);

    const settings = readJson(settingsPath);
    // Cosmetic residue reported on #1185: `"SessionStart": []` and friends must
    // not survive the uninstall of a Clawd-only install.
    assert.deepStrictEqual(Object.keys(settings), ["permissions"], JSON.stringify(settings));
    assert.deepStrictEqual(settings.permissions, { defaultMode: "default" });
  });

  it("backs up the complete pre-uninstall config once and exposes the backup path", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const settings = readJson(settingsPath);
    settings.theme = "dark";
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    const before = readJson(settingsPath);

    const first = unregisterCommandCodeHooks({
      silent: true,
      settingsPath,
      backup: true,
      now: () => new Date("2026-08-10T01:02:03.004Z"),
    });
    assert.strictEqual(first.changed, true);
    assert.ok(first.backupPath, JSON.stringify(first));
    assert.strictEqual(first.settingsPath, settingsPath);
    assert.deepStrictEqual(readJson(first.backupPath), before);
    assert.strictEqual(readJson(settingsPath).theme, "dark");

    const backupNamesAfterFirst = fs.readdirSync(path.dirname(settingsPath))
      .filter((name) => name.includes(".clawd-cleanup-") && name.endsWith(".bak"));
    assert.strictEqual(backupNamesAfterFirst.length, 1);

    const second = unregisterCommandCodeHooks({
      silent: true,
      settingsPath,
      backup: true,
      now: () => new Date("2026-08-10T01:02:04.005Z"),
    });
    assert.deepStrictEqual(second, {
      removed: 0,
      changed: false,
      settingsPath,
      backupPath: null,
    });
    const backupNamesAfterSecond = fs.readdirSync(path.dirname(settingsPath))
      .filter((name) => name.includes(".clawd-cleanup-") && name.endsWith(".bak"));
    assert.deepStrictEqual(backupNamesAfterSecond, backupNamesAfterFirst);
  });

  it("does not create a backup when backup is not requested", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCommandCodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node", platform: "darwin" });

    const result = unregisterCommandCodeHooks({ silent: true, settingsPath, backup: false });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "backupPath"), false);
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith(".bak")),
      []
    );
  });

  it("migrates a legacy Windows -EncodedCommand entry to the portable form", () => {
    const { buildWindowsEncodedNodeHookCommand } = require("../hooks/json-utils");
    const legacy = buildWindowsEncodedNodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/app/hooks/command-code-hook.js",
      [],
    );
    const settingsPath = makeTempSettingsFile({
      hooks: { Stop: [{ hooks: [{ type: "command", command: legacy, timeout: 5 }] }] },
    });

    const result = registerCommandCodeHooks({
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
  });
});
