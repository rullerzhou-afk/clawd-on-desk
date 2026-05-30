const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerGeminiHooks, GEMINI_HOOK_EVENTS, __test } = require("../hooks/gemini-install");

const MARKER = "gemini-hook.js";
const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gemini-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Gemini hook installer", () => {
  it("registers all events on fresh install", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, GEMINI_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);
    for (const event of GEMINI_HOOK_EVENTS) {
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

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(settingsPath, "utf8");

    const result = registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, GEMINI_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        AfterTool: [{ type: "command", command: '"/old/node" "/old/path/gemini-hook.js"', name: "clawd" }],
      },
    });

    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.AfterTool.length, 1);
    assert.ok(settings.hooks.AfterTool[0].hooks[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.AfterTool[0].hooks[0].command.includes("/old/path/"));
    assert.ok(settings.hooks.AfterTool[0].hooks[0].command.endsWith('"AfterTool"'));
  });

  it("migrates stale flat Clawd entries into nested Gemini hook shape", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        BeforeTool: [
          { type: "command", command: '"/old/node" "/old/path/gemini-hook.js"', name: "clawd" },
        ],
      },
    });

    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.BeforeTool.length, 1);
    assert.deepStrictEqual(Object.keys(settings.hooks.BeforeTool[0]).sort(), ["hooks", "matcher"]);
    assert.strictEqual(settings.hooks.BeforeTool[0].matcher, "*");
    assert.strictEqual(settings.hooks.BeforeTool[0].hooks[0].name, "clawd");
    assert.ok(settings.hooks.BeforeTool[0].hooks[0].command.includes(MARKER));
    assert.ok(settings.hooks.BeforeTool[0].hooks[0].command.endsWith('"BeforeTool"'));
  });

  it("preserves existing node path when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        BeforeTool: [{ type: "command", command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/gemini-hook.js"', name: "clawd" }],
      },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.BeforeTool[0].hooks[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { matcher: "*", hooks: [{ type: "command", command: "other-tool --flag", name: "other" }] };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        SessionStart: [thirdParty],
      },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes(MARKER));
  });

  it("splits Clawd out of shared matcher entries instead of widening third-party hooks", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        BeforeTool: [{
          matcher: "Edit",
          hooks: [
            { type: "command", command: "other-tool --flag", name: "other" },
            { type: "command", command: '"/old/node" "/old/path/gemini-hook.js"', name: "clawd" },
          ],
        }],
      },
    });

    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.BeforeTool.length, 2);
    assert.deepStrictEqual(settings.hooks.BeforeTool[0], {
      matcher: "Edit",
      hooks: [{ type: "command", command: "other-tool --flag", name: "other" }],
    });
    assert.deepStrictEqual(settings.hooks.BeforeTool[1], {
      matcher: "*",
      hooks: [{
        type: "command",
        command: settings.hooks.BeforeTool[1].hooks[0].command,
        name: "clawd",
      }],
    });
    assert.ok(settings.hooks.BeforeTool[1].hooks[0].command.includes(MARKER));
    assert.ok(settings.hooks.BeforeTool[1].hooks[0].command.endsWith('"BeforeTool"'));
  });

  it("removes Clawd from shared matcher entries when a dedicated Clawd entry already exists", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        BeforeTool: [
          {
            matcher: "Edit",
            hooks: [
              { type: "command", command: "other-tool --flag", name: "other" },
              { type: "command", command: '"/old/node" "/old/path/gemini-hook.js"', name: "clawd" },
            ],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: '"/stale/node" "/stale/path/gemini-hook.js"', name: "clawd" }],
          },
        ],
      },
    });

    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.BeforeTool.length, 2);
    assert.deepStrictEqual(settings.hooks.BeforeTool[0], {
      matcher: "Edit",
      hooks: [{ type: "command", command: "other-tool --flag", name: "other" }],
    });
    assert.deepStrictEqual(settings.hooks.BeforeTool[1], {
      matcher: "*",
      hooks: [{
        type: "command",
        command: settings.hooks.BeforeTool[1].hooks[0].command,
        name: "clawd",
      }],
    });
    assert.ok(settings.hooks.BeforeTool[1].hooks[0].command.includes("/usr/local/bin/node"));
    assert.ok(settings.hooks.BeforeTool[1].hooks[0].command.endsWith('"BeforeTool"'));
  });

  it("does not force hooksConfig.enabled when the user disabled hooks", () => {
    const settingsPath = makeTempSettingsFile({
      hooksConfig: { enabled: false },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooksConfig.enabled, false);
  });

  it("migrates legacy disabled Gemini hook command entries to clawd", () => {
    const legacyDisabled = '"/old/node" "/old/path/gemini-hook.js" BeforeTool';
    const settingsPath = makeTempSettingsFile({
      hooksConfig: {
        disabled: ["other-hook", legacyDisabled],
      },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooksConfig.disabled, ["other-hook", "clawd"]);
  });

  it("builds bash-compatible bare commands with the Gemini event argv on Windows", () => {
    const command = __test.buildGeminiHookCommand(
      "node",
      "D:/clawd/hooks/gemini-hook.js",
      "BeforeTool",
      { platform: "win32" }
    );

    assert.strictEqual(command, '"node" "D:/clawd/hooks/gemini-hook.js" "BeforeTool"');
  });

  it("builds Windows cmd-wrapped commands with the Gemini event argv", () => {
    const command = __test.buildGeminiHookCommand(
      "node",
      "D:/clawd/hooks/gemini-hook.js",
      "BeforeTool",
      { platform: "win32", windowsWrapper: "cmd" }
    );

    assert.strictEqual(command, 'cmd /d /s /c ""node" "D:/clawd/hooks/gemini-hook.js" "BeforeTool""');
  });

  it("skips when ~/.gemini/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gemini-home-"));
    tempDirs.push(fakeHome);
    const result = registerGeminiHooks({
      silent: true,
      nodeBin: "/usr/local/bin/node",
      homeDir: fakeHome,
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".gemini", "settings.json")), false);
  });
});
