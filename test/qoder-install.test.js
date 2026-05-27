const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerQoderHooks, unregisterQoderHooks, QODER_HOOK_EVENTS, __test } = require("../hooks/qoder-install");

const MARKER = "qoder-hook.js";
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

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Qoder hook installer", () => {
  it("registers all 8 events on fresh install", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerQoderHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
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

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(settingsPath, "utf8");

    const result = registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, QODER_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { matcher: "*", hooks: [{ type: "command", command: "other-tool --flag", name: "other" }] };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        SessionStart: [thirdParty],
      },
    });

    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes(MARKER));
  });

  it("skips when ~/.qoder/ does not exist", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-home-"));
    tempDirs.push(fakeHome);
    const result = registerQoderHooks({
      silent: true,
      nodeBin: "/usr/local/bin/node",
      homeDir: fakeHome,
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
    assert.strictEqual(fs.existsSync(path.join(fakeHome, ".qoder", "settings.json")), false);
  });

  it("supports --uninstall to remove clawd entries only", () => {
    const settingsPath = makeTempSettingsFile({});

    // Install first
    registerQoderHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    // Add a third-party hook alongside clawd
    let settings = readJson(settingsPath);
    settings.hooks.SessionStart.unshift({
      matcher: "*",
      hooks: [{ type: "command", command: "other-tool --flag", name: "other" }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    // Uninstall
    const result = unregisterQoderHooks({ silent: true, settingsPath });

    assert.ok(result.removed >= QODER_HOOK_EVENTS.length, `removed ${result.removed}, expected at least ${QODER_HOOK_EVENTS.length}`);

    settings = readJson(settingsPath);
    // Event keys should still exist (not deleted)
    assert.ok(settings.hooks, "hooks key should remain");
    // Third-party hook should survive
    assert.ok(settings.hooks.SessionStart, "SessionStart key should remain");
    assert.ok(settings.hooks.SessionStart.some((e) => e.hooks && e.hooks.some((h) => h.name === "other")), "third-party hook should survive");
    // No clawd entries should remain
    for (const event of Object.keys(settings.hooks)) {
      for (const entry of settings.hooks[event]) {
        if (!entry || !entry.hooks) continue;
        for (const hook of entry.hooks) {
          assert.ok(!hook.command || !hook.command.includes(MARKER), `clawd entry found in ${event}: ${hook.command}`);
        }
      }
    }
  });
});
