const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerWorkBuddyHooks,
  unregisterWorkBuddyHooks,
  WORKBUDDY_HOOK_EVENTS,
  __test,
} = require("../hooks/workbuddy-install");

const MARKER = "workbuddy-hook.js";
const tempDirs = [];

function makeTempSettingsPath(initial = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-"));
  const settingsPath = path.join(tmpDir, ".workbuddy", "settings.json");
  if (initial !== null) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  }
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

describe("WorkBuddy hook installer", () => {
  it("creates ~/.workbuddy settings and registers command + permission hooks", () => {
    const settingsPath = makeTempSettingsPath();
    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, 9);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const settings = readJson(settingsPath);
    for (const event of WORKBUDDY_HOOK_EVENTS) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
    }

    const permHook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(permHook.type, "http");
    assert.strictEqual(permHook.timeout, 600);
    assert.ok(__test.isManagedPermissionUrl(permHook.url));
  });

  it("can register a custom permission hook URL", () => {
    const settingsPath = makeTempSettingsPath();
    const customPermissionUrl = "https://hooks.example.test/workbuddy/permission";
    registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      customPermissionUrl,
    });

    const settings = readJson(settingsPath);
    const permHook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(permHook.type, "http");
    assert.strictEqual(permHook.url, customPermissionUrl);
  });

  it("is idempotent and can unregister managed hooks", () => {
    const settingsPath = makeTempSettingsPath();
    registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const second = registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, WORKBUDDY_HOOK_EVENTS.length);

    const removed = unregisterWorkBuddyHooks({ silent: true, settingsPath, backup: true });
    assert.strictEqual(removed.removed, 9);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(Object.keys(settings.hooks), []);
  });
});
