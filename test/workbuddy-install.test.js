const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerWorkBuddyHooks,
  unregisterWorkBuddyHooks,
  WORKBUDDY_HOOK_EVENTS,
  resolveWorkBuddySettingsPath,
  workBuddySettingsCandidates,
  __test,
} = require("../hooks/workbuddy-install");

const MARKER = "workbuddy-hook.js";
const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeSettings(settingsPath, value) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
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

describe("WorkBuddy hook installer", () => {
  it("prefers current ~/.workbuddy-ai even when a legacy settings file also exists", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    writeSettings(current.settingsPath, {});
    writeSettings(legacy.settingsPath, {});

    assert.strictEqual(resolveWorkBuddySettingsPath({ homeDir }), current.settingsPath);
  });

  it("treats an existing current config directory as authoritative over stale legacy settings", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    fs.mkdirSync(current.parentDir, { recursive: true });
    writeSettings(legacy.settingsPath, { legacy: true });

    assert.strictEqual(resolveWorkBuddySettingsPath({ homeDir }), current.settingsPath);
  });

  it("falls back to legacy ~/.workbuddy for older WorkBuddy builds", () => {
    const homeDir = makeTempHome();
    const [, legacy] = workBuddySettingsCandidates({ homeDir });
    writeSettings(legacy.settingsPath, {});

    assert.strictEqual(resolveWorkBuddySettingsPath({ homeDir }), legacy.settingsPath);
  });

  it("does not mistake a bare legacy toolchain directory for active WorkBuddy config", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    fs.mkdirSync(legacy.parentDir, { recursive: true });

    assert.strictEqual(resolveWorkBuddySettingsPath({ homeDir }), current.settingsPath);
    const result = registerWorkBuddyHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(fs.existsSync(legacy.settingsPath), false);
    assert.strictEqual(fs.existsSync(current.settingsPath), false);
  });

  it("installs into current settings and marker-scoped cleans stale legacy hooks", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    writeSettings(current.settingsPath, { theme: "dark" });
    writeSettings(legacy.settingsPath, {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "command", command: '"/old/node" "/tmp/checkout/hooks/workbuddy-hook.js"' },
            { type: "command", command: "echo keep" },
          ],
        }],
      },
    });

    const result = registerWorkBuddyHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.settingsPath, current.settingsPath);
    assert.strictEqual(result.added, WORKBUDDY_HOOK_EVENTS.length);
    assert.strictEqual(result.migratedRemoved, 1);
    assert.strictEqual(result.migrationBackupPaths.length, 1);
    const active = readJson(current.settingsPath);
    assert.strictEqual(active.theme, "dark");
    assert.ok(active.hooks.SessionStart[0].hooks[0].command.includes(MARKER));
    assert.deepStrictEqual(readJson(legacy.settingsPath).hooks.Stop, [{
      matcher: "",
      hooks: [{ type: "command", command: "echo keep" }],
    }]);
  });

  it("keeps a successful current install when the inactive legacy config is invalid JSON", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    writeSettings(current.settingsPath, { theme: "dark" });
    fs.mkdirSync(legacy.parentDir, { recursive: true });
    fs.writeFileSync(legacy.settingsPath, "{ invalid legacy json", "utf8");

    const result = registerWorkBuddyHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.settingsPath, current.settingsPath);
    assert.strictEqual(result.added, WORKBUDDY_HOOK_EVENTS.length);
    assert.deepStrictEqual(result.migrationSkippedPaths, [legacy.settingsPath]);
    assert.strictEqual(result.migratedRemoved, 0);
    assert.deepStrictEqual(result.migrationBackupPaths, []);
    const active = readJson(current.settingsPath);
    assert.strictEqual(active.theme, "dark");
    assert.ok(active.hooks.SessionStart[0].hooks[0].command.includes(MARKER));
    assert.strictEqual(fs.readFileSync(legacy.settingsPath, "utf8"), "{ invalid legacy json");
  });

  it("still rejects invalid JSON in the active config", () => {
    const homeDir = makeTempHome();
    const [current] = workBuddySettingsCandidates({ homeDir });
    fs.mkdirSync(current.parentDir, { recursive: true });
    fs.writeFileSync(current.settingsPath, "{ invalid active json", "utf8");

    assert.throws(
      () => registerWorkBuddyHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" }),
      /Failed to read settings\.json/
    );
    assert.strictEqual(fs.readFileSync(current.settingsPath, "utf8"), "{ invalid active json");
  });

  it("keeps the active install successful when inactive cleanup cannot read a stale config", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    writeSettings(current.settingsPath, {});
    writeSettings(legacy.settingsPath, {});
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = (filePath, ...args) => {
      if (filePath === legacy.settingsPath) {
        const err = new Error("permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realReadFileSync(filePath, ...args);
    };

    try {
      const result = registerWorkBuddyHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
      assert.strictEqual(result.added, WORKBUDDY_HOOK_EVENTS.length);
      assert.deepStrictEqual(result.migrationFailedPaths, [{
        settingsPath: legacy.settingsPath,
        code: "EACCES",
        message: "Failed to read settings.json: permission denied",
      }]);
      assert.strictEqual(result.warnings.length, 1);
      assert.match(result.warnings[0], /Could not clean inactive WorkBuddy config/);
      assert.ok(readJson(current.settingsPath).hooks.SessionStart[0].hooks[0].command.includes(MARKER));
    } finally {
      fs.readFileSync = realReadFileSync;
    }
  });

  it("default uninstall removes managed hooks from current and legacy configs only", () => {
    const homeDir = makeTempHome();
    const [current, legacy] = workBuddySettingsCandidates({ homeDir });
    const managedEntry = {
      matcher: "",
      hooks: [{ type: "command", command: '"/node" "/clawd/workbuddy-hook.js"' }],
    };
    writeSettings(current.settingsPath, {
      hooks: { Stop: [managedEntry, { matcher: "", hooks: [{ type: "command", command: "echo current" }] }] },
    });
    writeSettings(legacy.settingsPath, {
      hooks: { Stop: [managedEntry, { matcher: "", hooks: [{ type: "command", command: "echo legacy" }] }] },
    });

    const result = unregisterWorkBuddyHooks({ homeDir, silent: true });

    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(readJson(current.settingsPath).hooks.Stop[0].hooks[0].command, "echo current");
    assert.deepStrictEqual(readJson(legacy.settingsPath).hooks.Stop[0].hooks[0].command, "echo legacy");
  });

  it("registers command events only — no PermissionRequest HTTP hook (state + Notification only, #618)", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    // 8 command hooks, and NOTHING else — desktop WorkBuddy owns its permission
    // loop natively, so Clawd never registers a /permission HTTP hook.
    assert.strictEqual(result.added, 8);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);

    // Verify command hooks (nested Claude Code format)
    for (const event of WORKBUDDY_HOOK_EVENTS) {
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

    // No PermissionRequest hook is created on a fresh install.
    assert.strictEqual(settings.hooks.PermissionRequest, undefined);
    assert.ok(!WORKBUDDY_HOOK_EVENTS.includes("PermissionRequest"));
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(settingsPath, "utf8");

    const result = registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths in nested format", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/old/node" "/old/path/workbuddy-hook.js"' }],
        }],
      },
    });

    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.Stop[0].hooks[0].command.includes("/old/path/"));
    assert.strictEqual(settings.hooks.Stop.length, 1);
  });

  it("updates stale hook paths in flat format (migration)", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PreToolUse: [{ command: '"/old/node" "/old/path/workbuddy-hook.js"' }],
      },
    });

    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    // Flat entry gets its command updated in place
    assert.ok(settings.hooks.PreToolUse[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.PreToolUse[0].command.includes("/old/path/"));
  });

  it("preserves existing node path from nested format when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/workbuddy-hook.js"' }],
        }],
      },
    });

    registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves existing node path from flat format when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PostToolUse: [{ command: '"/home/user/.volta/bin/node" "/some/path/workbuddy-hook.js"' }],
      },
    });

    registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.PostToolUse[0].command.includes("/home/user/.volta/bin/node"));
  });

  it("prunes a stale managed PermissionRequest HTTP hook left by an old installer", () => {
    // 23337 is inside SERVER_PORTS, so this is a URL a pre-#618 install could
    // have written. Re-running the (now notification-only) installer must clean
    // it up rather than refresh it — the endpoint is dead.
    const stale = "http://127.0.0.1:23337/permission";
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [{ type: "http", url: stale, timeout: 600 }],
        }],
      },
    });

    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    // 8 command hooks added; the stale managed HTTP hook is removed (counted as
    // an update), leaving no PermissionRequest key behind.
    assert.strictEqual(result.added, 8);
    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.PermissionRequest, undefined);
  });

  it("leaves a foreign PermissionRequest URL untouched and never re-adds a managed one", () => {
    const foreign = { type: "http", url: "https://approval.corp.example/permission", timeout: 30 };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{ matcher: "", hooks: [{ ...foreign }] }],
      },
    });

    const result = registerWorkBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    // Only the 8 command hooks are added; the foreign endpoint is preserved and
    // no managed /permission hook is appended.
    assert.strictEqual(result.added, 8);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.PermissionRequest[0].hooks, [foreign]);
    const managed = settings.hooks.PermissionRequest
      .flatMap((entry) => entry.hooks || [])
      .filter((hook) => __test.isManagedPermissionUrl(hook.url));
    assert.strictEqual(managed.length, 0);

    // Second run must not churn: nothing to add, foreign still intact.
    const contentBefore = fs.readFileSync(settingsPath, "utf8");
    const again = registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.updated, 0);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("prunes a managed hook while preserving a co-located foreign one", () => {
    const foreign = { type: "http", url: "http://localhost:23333/permission", timeout: 600 };
    const managedStale = { type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{ matcher: "", hooks: [{ ...managedStale }, { ...foreign }] }],
      },
    });

    registerWorkBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    // The managed URL is gone; the foreign one survives.
    const urls = settings.hooks.PermissionRequest
      .flatMap((entry) => entry.hooks || [])
      .map((hook) => hook.url);
    assert.deepStrictEqual(urls, ["http://localhost:23333/permission"]);
  });

  it("unregister removes only managed command hooks and managed PermissionRequest URLs", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "command", command: '"/node" "/clawd/workbuddy-hook.js"' },
            { type: "command", command: "echo keep" },
          ],
        }],
        PermissionRequest: [{
          matcher: "",
          hooks: [
            { type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 },
            { type: "http", url: "http://127.0.0.1:9999/permission", timeout: 600 },
            { type: "http", url: "http://127.0.0.1:23333/permission?user=1", timeout: 600 },
            { type: "http", url: "http://localhost:23333/permission", timeout: 600 },
          ],
        }],
      },
    });

    const result = unregisterWorkBuddyHooks({ silent: true, settingsPath, backup: true });

    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.changed, true);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.Stop, [{
      matcher: "",
      hooks: [{ type: "command", command: "echo keep" }],
    }]);
    assert.deepStrictEqual(settings.hooks.PermissionRequest[0].hooks.map((hook) => hook.url), [
      "http://127.0.0.1:9999/permission",
      "http://127.0.0.1:23333/permission?user=1",
      "http://localhost:23333/permission",
    ]);
    assert.strictEqual(listCleanupBackups(settingsPath).length, 1);
  });

  it("isManagedPermissionUrl is intentionally strict", () => {
    assert.strictEqual(__test.isManagedPermissionUrl("http://127.0.0.1:23333/permission"), true);
    assert.strictEqual(__test.isManagedPermissionUrl("http://127.0.0.1:23337/permission"), true);
    assert.strictEqual(__test.isManagedPermissionUrl("http://127.0.0.1:23338/permission"), false);
    assert.strictEqual(__test.isManagedPermissionUrl("http://127.0.0.1:23333/permission?x=1"), false);
    assert.strictEqual(__test.isManagedPermissionUrl("http://localhost:23333/permission"), false);
  });
});
