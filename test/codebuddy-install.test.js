const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerCodeBuddyHooks,
  unregisterCodeBuddyHooks,
  CODEBUDDY_HOOK_EVENTS,
  CLAWD_PERMISSION_HOOK_NAME,
  __test,
} = require("../hooks/codebuddy-install");

const MARKER = "codebuddy-hook.js";
const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codebuddy-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
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

describe("CodeBuddy hook installer", () => {
  it("registers all command events + PermissionRequest HTTP hook on fresh install", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    // 8 command hooks + 1 HTTP hook = 9
    assert.strictEqual(result.added, 9);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);

    // Verify command hooks (nested Claude Code format)
    for (const event of CODEBUDDY_HOOK_EVENTS) {
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

    // Verify PermissionRequest HTTP hook
    const permEntries = settings.hooks.PermissionRequest;
    assert.ok(Array.isArray(permEntries));
    assert.strictEqual(permEntries.length, 1);
    const permHook = permEntries[0].hooks[0];
    assert.strictEqual(permHook.name, CLAWD_PERMISSION_HOOK_NAME);
    assert.strictEqual(permHook.type, "http");
    assert.ok(permHook.url.includes("127.0.0.1"));
    assert.ok(permHook.url.includes("/permission"));
    assert.strictEqual(permHook.timeout, 600);
  });

  it("registers a custom PermissionRequest HTTP hook URL", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" },
    });

    assert.strictEqual(result.added, 9);
    const settings = readJson(settingsPath);
    const permHook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(permHook.name, CLAWD_PERMISSION_HOOK_NAME);
    assert.strictEqual(permHook.type, "http");
    assert.strictEqual(permHook.url, "https://approval.example.test/permission");
    assert.strictEqual(permHook.timeout, 600);
  });

  it("rejects invalid custom PermissionRequest hook URLs", () => {
    const settingsPath = makeTempSettingsFile({});

    assert.throws(
      () => registerCodeBuddyHooks({
        silent: true,
        settingsPath,
        nodeBin: "/usr/local/bin/node",
        permissionTarget: { mode: "custom", url: "file:///tmp/permission" },
      }),
      /http\(s\) URL/
    );
    assert.throws(
      () => registerCodeBuddyHooks({
        silent: true,
        settingsPath,
        nodeBin: "/usr/local/bin/node",
        permissionTarget: { mode: "custom", url: "" },
      }),
      /requires an http\(s\) URL/
    );
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(settingsPath, "utf8");

    const result = registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths in nested format", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/old/node" "/old/path/codebuddy-hook.js"' }],
        }],
      },
    });

    const result = registerCodeBuddyHooks({
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
        PreToolUse: [{ command: '"/old/node" "/old/path/codebuddy-hook.js"' }],
      },
    });

    const result = registerCodeBuddyHooks({
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
          hooks: [{ type: "command", command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/codebuddy-hook.js"' }],
        }],
      },
    });

    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves existing node path from flat format when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PostToolUse: [{ command: '"/home/user/.volta/bin/node" "/some/path/codebuddy-hook.js"' }],
      },
    });

    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.PostToolUse[0].command.includes("/home/user/.volta/bin/node"));
  });

  it("updates a stale managed PermissionRequest HTTP URL in place", () => {
    // 23337 is inside SERVER_PORTS, so this is a URL an older install could
    // have written — eligible for the in-place refresh. Anything outside the
    // managed set is foreign (see the zero-destruction tests below).
    const stale = "http://127.0.0.1:23337/permission";
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [{ type: "http", url: stale, timeout: 600 }],
        }],
      },
    });

    const result = registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const settings = readJson(settingsPath);
    const permHook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.ok(__test.isManagedPermissionUrl(permHook.url));
    assert.strictEqual(permHook.name, CLAWD_PERMISSION_HOOK_NAME);
    assert.strictEqual(settings.hooks.PermissionRequest.length, 1);
    if (permHook.url !== stale) assert.ok(result.updated >= 1);
  });

  it("migrates a flat legacy-name local hook to the versioned marker", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          name: "clawd",
          type: "http",
          url: "http://127.0.0.1:23337/permission",
          timeout: 27,
        }],
      },
    });

    registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "local" },
    });

    const hook = readJson(settingsPath).hooks.PermissionRequest[0];
    assert.strictEqual(hook.name, CLAWD_PERMISSION_HOOK_NAME);
    assert.ok(__test.isManagedPermissionUrl(hook.url));
    assert.strictEqual(hook.timeout, 27);
  });

  it("leaves foreign PermissionRequest URLs untouched and appends the managed hook", () => {
    const foreign = { type: "http", url: "https://approval.corp.example/permission", timeout: 30 };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{ matcher: "", hooks: [{ ...foreign }] }],
      },
    });

    const result = registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    // 8 command hooks + appended managed HTTP hook
    assert.strictEqual(result.added, 9);
    const settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.PermissionRequest[0].hooks, [foreign]);
    const managed = settings.hooks.PermissionRequest
      .flatMap((entry) => entry.hooks || [])
      .filter((hook) => __test.isManagedPermissionUrl(hook.url));
    assert.strictEqual(managed.length, 1);

    // Second run must not churn: managed entry matched, foreign still intact.
    const contentBefore = fs.readFileSync(settingsPath, "utf8");
    const again = registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.updated, 0);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("leaves a foreign flat-format PermissionRequest URL untouched", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{ type: "http", url: "http://localhost:23333/permission", timeout: 600 }],
      },
    });

    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.PermissionRequest[0].url, "http://localhost:23333/permission");
    const nested = settings.hooks.PermissionRequest.filter((entry) => Array.isArray(entry.hooks));
    assert.strictEqual(nested.length, 1);
    assert.ok(__test.isManagedPermissionUrl(nested[0].hooks[0].url));
  });

  it("does not claim a foreign hook merely because its legacy name is clawd", () => {
    const foreignNested = {
      name: "clawd",
      type: "http",
      url: "https://approval.corp.example/permission",
      timeout: 30,
      headers: { authorization: "keep" },
    };
    const foreignFlat = {
      name: "clawd",
      type: "http",
      url: "https://flat.example/permission",
      timeout: 45,
    };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [
          { matcher: "foreign", hooks: [{ ...foreignNested }] },
          { ...foreignFlat },
        ],
      },
    });

    registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "local" },
    });
    let settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.PermissionRequest[0], {
      matcher: "foreign",
      hooks: [foreignNested],
    });
    assert.deepStrictEqual(settings.hooks.PermissionRequest[1], foreignFlat);

    unregisterCodeBuddyHooks({ silent: true, settingsPath });
    settings = readJson(settingsPath);
    assert.deepStrictEqual(settings.hooks.PermissionRequest, [
      { matcher: "foreign", hooks: [foreignNested] },
      foreignFlat,
    ]);
  });

  it("preserves a custom URL owned by the versioned marker on bare/default registration", () => {
    const customHook = {
      name: CLAWD_PERMISSION_HOOK_NAME,
      type: "http",
      url: "https://approval.example.test/permission",
      timeout: 30,
      headers: { "x-keep": "yes" },
    };
    const settingsPath = makeTempSettingsFile({
      hooks: { PermissionRequest: [{ matcher: "", hooks: [{ ...customHook }] }] },
    });

    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const hook = readJson(settingsPath).hooks.PermissionRequest[0].hooks[0];
    assert.deepStrictEqual(hook, customHook);
  });

  it("preserves a flat custom URL owned by the versioned marker", () => {
    const customHook = {
      name: CLAWD_PERMISSION_HOOK_NAME,
      type: "http",
      url: "https://flat-approval.example/permission",
      timeout: 22,
    };
    const settingsPath = makeTempSettingsFile({
      hooks: { PermissionRequest: [{ ...customHook }] },
    });

    registerCodeBuddyHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.deepStrictEqual(readJson(settingsPath).hooks.PermissionRequest[0], customHook);
  });

  it("repairs an invalid marker-owned URL in preserve mode without blocking command hooks", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [{
            name: CLAWD_PERMISSION_HOOK_NAME,
            type: "http",
            url: "ws://relay.internal/permission",
            timeout: 30,
          }],
        }],
      },
    });

    const result = registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "preserve" },
    });

    assert.strictEqual(result.added, CODEBUDDY_HOOK_EVENTS.length);
    const settings = readJson(settingsPath);
    for (const event of CODEBUDDY_HOOK_EVENTS) {
      assert.strictEqual(settings.hooks[event].length, 1, event);
    }
    const hook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(__test.isManagedPermissionUrl(hook.url), true);
    assert.strictEqual(hook.timeout, 30);
  });

  it("repairs a marker-owned hook with no URL instead of appending a duplicate", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [{
            name: CLAWD_PERMISSION_HOOK_NAME,
            type: "http",
            timeout: 30,
          }],
        }],
      },
    });

    registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    const entries = readJson(settingsPath).hooks.PermissionRequest;
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].hooks.length, 1);
    assert.strictEqual(__test.isManagedPermissionUrl(entries[0].hooks[0].url), true);
    assert.strictEqual(entries[0].hooks[0].timeout, 30);
  });

  it("uses explicit local/custom targets while preserving adjacent hook fields", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [{
            name: CLAWD_PERMISSION_HOOK_NAME,
            type: "http",
            url: "https://old.example/permission",
            timeout: 30,
            headers: { "x-keep": "yes" },
          }],
        }],
      },
    });

    registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "local" },
    });
    let hook = readJson(settingsPath).hooks.PermissionRequest[0].hooks[0];
    assert.ok(__test.isManagedPermissionUrl(hook.url));
    assert.strictEqual(hook.timeout, 30);
    assert.deepStrictEqual(hook.headers, { "x-keep": "yes" });

    registerCodeBuddyHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
      permissionTarget: { mode: "custom", url: "https://new.example/permission" },
    });
    hook = readJson(settingsPath).hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(hook.url, "https://new.example/permission");
    assert.strictEqual(hook.timeout, 30);
    assert.deepStrictEqual(hook.headers, { "x-keep": "yes" });
  });

  it("unregister removes versioned-marker custom URLs but keeps legacy-name foreign URLs", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        PermissionRequest: [{
          matcher: "",
          hooks: [
            {
              name: CLAWD_PERMISSION_HOOK_NAME,
              type: "http",
              url: "https://approval.example/permission",
              timeout: 600,
            },
            {
              name: "clawd",
              type: "http",
              url: "https://foreign.example/permission",
              timeout: 30,
            },
          ],
        }],
      },
    });

    const result = unregisterCodeBuddyHooks({ silent: true, settingsPath });

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(readJson(settingsPath).hooks.PermissionRequest[0].hooks, [{
      name: "clawd",
      type: "http",
      url: "https://foreign.example/permission",
      timeout: 30,
    }]);
  });

  it("parses explicit CLI permission targets and defaults to preserve", () => {
    assert.deepStrictEqual(__test.parsePermissionTargetArgv([]), { mode: "preserve" });
    assert.deepStrictEqual(__test.parsePermissionTargetArgv(["--permission-url", "local"]), { mode: "local" });
    assert.deepStrictEqual(__test.parsePermissionTargetArgv(["--permission-url", "preserve"]), { mode: "preserve" });
    assert.deepStrictEqual(
      __test.parsePermissionTargetArgv(["--permission-url", "https://approval.example/permission"]),
      { mode: "custom", url: "https://approval.example/permission" }
    );
    assert.throws(() => __test.parsePermissionTargetArgv(["--permission-url"]), /requires/);
    assert.throws(() => __test.parsePermissionTargetArgv(["--permission-url", "file:\/\/bad"]), /http\(s\)/);
  });

  it("unregister removes only managed command hooks and managed PermissionRequest URLs", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "command", command: '"/node" "/clawd/codebuddy-hook.js"' },
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

    const result = unregisterCodeBuddyHooks({ silent: true, settingsPath, backup: true });

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
