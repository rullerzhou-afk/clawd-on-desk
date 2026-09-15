const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("node:child_process");
const {
  registerCursorHooks,
  unregisterCursorHooks,
  CURSOR_HOOK_EVENTS,
  buildCursorHookCommand,
} = require("../hooks/cursor-install");
const { commandMatchesMarker, formatNodeHookCommand } = require("../hooks/json-utils");

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
    const directory = path.resolve(tempDirs.pop());
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
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

  it("calls Node directly through Cursor's Windows PowerShell launcher", () => {
    const hooksPath = makeTempHooksFile({});
    registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const settings = readJson(hooksPath);
    const expected = buildCursorHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      path.resolve(__dirname, "..", "hooks", "cursor-hook.js").replace(/\\/g, "/"),
      "win32"
    );
    assert.strictEqual(settings.hooks.stop[0].command, expected);
    assert.ok(settings.hooks.stop[0].command.startsWith('& "C:\\Program Files\\nodejs\\node.exe" '));
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
    assert.ok(settings.hooks.stop[0].command.includes("C:\\Program Files\\nodejs\\node.exe"));
    assert.ok(settings.hooks.stop[0].command.startsWith("& "));
  });

  it("does not append or rewrite Windows hooks on repeated registration", () => {
    const hooksPath = makeTempHooksFile({});
    const options = { silent: true, hooksPath, nodeBin: "C:\\Program Files\\nodejs\\node.exe", platform: "win32" };
    registerCursorHooks(options);
    const before = fs.readFileSync(hooksPath, "utf8");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepStrictEqual(registerCursorHooks(options), { added: 0, updated: 0, skipped: CURSOR_HOOK_EVENTS.length });
      assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
      for (const entries of Object.values(readJson(hooksPath).hooks)) assert.strictEqual(entries.length, 1);
    }
  });

  it("migrates encoded and cmd hooks, removes owned duplicates, and preserves third-party settings", () => {
    const encoded = formatNodeHookCommand("C:\\Old Node\\node.exe", "D:/old/cursor-hook.js", {
      platform: "win32", windowsWrapper: "encoded",
    });
    const foreign = { command: "other-tool", timeout: 9 };
    const hooksPath = makeTempHooksFile({
      version: 1,
      customSetting: true,
      hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map((event) => [event, [
        foreign,
        { command: encoded, timeout: 7, matcher: "Shell", enabled: false },
        { command: 'cmd /d /s /c ""node" "D:/old/cursor-hook.js""' },
        { command: encoded },
        { name: "clawd", command: "user-owned-hook" },
      ]])),
    });
    const options = { silent: true, hooksPath, nodeBin: null, platform: "win32" };
    assert.deepStrictEqual(registerCursorHooks(options), { added: 0, updated: CURSOR_HOOK_EVENTS.length, skipped: 0 });
    const settings = readJson(hooksPath);
    assert.strictEqual(settings.customSetting, true);
    for (const entries of Object.values(settings.hooks)) {
      assert.strictEqual(entries.length, 3);
      assert.deepStrictEqual(entries[0], foreign);
      assert.strictEqual(entries[1].timeout, 7);
      assert.strictEqual(entries[1].matcher, "Shell");
      assert.strictEqual(entries[1].enabled, false);
      assert.ok(entries[1].command.startsWith('& "C:\\Old Node\\node.exe" '));
      assert.ok(!entries[1].command.includes("D:/old/"));
      assert.strictEqual(entries.filter((entry) => commandMatchesMarker(entry.command, MARKER)).length, 1);
      assert.deepStrictEqual(entries[2], { name: "clawd", command: "user-owned-hook" });
    }
    const before = fs.readFileSync(hooksPath, "utf8");
    assert.deepStrictEqual(registerCursorHooks(options), { added: 0, updated: 0, skipped: CURSOR_HOOK_EVENTS.length });
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
  });

  it("uninstalls encoded/legacy/duplicate owned hooks without touching third-party hooks", () => {
    const encoded = formatNodeHookCommand("node", "D:/old/cursor-hook.js", { platform: "win32", windowsWrapper: "encoded" });
    const foreign = { command: "other-hook", name: "clawd" };
    const hooksPath = makeTempHooksFile({ version: 1, hooks: {
      stop: [{ command: encoded }, { command: encoded }, { command: '"node" "D:/old/cursor-hook.js"' }, foreign],
      customEvent: [{ command: "custom-hook" }],
    } });
    const result = unregisterCursorHooks({ silent: true, hooksPath });
    assert.strictEqual(result.removed, 3);
    assert.deepStrictEqual(readJson(hooksPath).hooks, { stop: [foreign], customEvent: [{ command: "custom-hook" }] });
    assert.strictEqual(unregisterCursorHooks({ silent: true, hooksPath }).changed, false);
  });

  it("executes spaced Windows paths through both observed Cursor stdin bridges", { skip: process.platform !== "win32" }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-launch-"));
    tempDirs.push(root);
    const appDir = path.join(root, "Clawd on Desk", "中文 hooks");
    fs.mkdirSync(appDir, { recursive: true });
    const script = path.join(appDir, "cursor-hook.js");
    const helper = path.resolve(__dirname, "..", "hooks", "shared-process.js");
    // Test command quoting and pipe integrity independently of the production
    // 400ms deadline: hosted Windows runners can deliver the first byte later.
    // shared-process.test.js separately checks the reader's timeout contract.
    fs.writeFileSync(script, `require(${JSON.stringify(helper)}).readStdinJsonDetailed({ timeoutMs: 5000 }).then(result => console.log(JSON.stringify(result)));`);
    const payload = { hook_event_name: "beforeSubmitPrompt", prompt: "check paths and stdin" };
    const input = path.join(root, "payload.json");
    fs.writeFileSync(input, JSON.stringify(payload));
    const command = buildCursorHookCommand(process.execPath, script.replace(/\\/g, "/"), "win32");
    const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    const launchers = [
      `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}')) | & { $input | ${command} }`,
      `$OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath '${input.replace(/'/g, "''")}' -Raw | & { $input | ${command} }`,
    ];
    const launcherFile = path.join(root, "launcher.ps1");
    for (const [index, launcher] of launchers.entries()) {
      fs.writeFileSync(launcherFile, "\ufeff" + launcher);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", launcherFile], {
        encoding: "utf8", windowsHide: true, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stderr, "");
      const received = JSON.parse(result.stdout.trim());
      t.diagnostic(`Cursor stdin bridge ${index + 1}: ${received.bytes} bytes in ${received.durationMs}ms (timedOut=${received.timedOut})`);
      assert.deepStrictEqual(received.payload, payload, `Cursor stdin bridge ${index + 1}: ${JSON.stringify(received)}`);
    }
  });
});
