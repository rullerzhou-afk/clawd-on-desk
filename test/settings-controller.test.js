"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
const { createFeishuApprovalLookupCoordinator } = require("../src/feishu-approval-lookup");
const { commandRegistry } = require("../src/settings-actions");

const tempDirs = [];
function makeTempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-controller-"));
  tempDirs.push(dir);
  return path.join(dir, "clawd-prefs.json");
}

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

function createConcurrentCommitProxy(commitReads, getCommit) {
  return new Proxy(
    { status: "ok" },
    {
      has(target, key) {
        return key === "commit" ? false : Reflect.has(target, key);
      },
      get(target, key, receiver) {
        if (key === "commit") {
          commitReads.count += 1;
          return getCommit();
        }
        return Reflect.get(target, key, receiver);
      },
    },
  );
}

function createConcurrentCommitFixture(createResult) {
  const prefsPath = makeTempPath();
  prefs.save(prefsPath, prefs.getDefaults());
  const saves = [];
  const recordingPrefs = {
    load: (target) => prefs.load(target),
    save: (target, snapshot) => {
      saves.push(snapshot);
      return prefs.save(target, snapshot);
    },
  };
  let invoked = 0;
  let subscriberCalls = 0;
  const commitReads = { count: 0 };
  const concurrentCommand = () => {
    invoked += 1;
    return createResult({ commitReads });
  };
  concurrentCommand.concurrent = true;
  const ctrl = createSettingsController({
    prefsPath,
    prefs: recordingPrefs,
    commands: { concurrentCommand },
  });
  ctrl.subscribe(() => { subscriberCalls += 1; });
  const beforeDisk = fs.readFileSync(prefsPath, "utf8");

  return {
    async run() {
      const result = await ctrl.applyCommand("concurrentCommand", {});
      assert.deepStrictEqual(result, {
        status: "error",
        code: "concurrent-command-commit-forbidden",
      });
      assert.equal(invoked, 1);
      assert.equal(ctrl.get("lang"), "en");
      assert.equal(saves.length, 0);
      assert.equal(fs.readFileSync(prefsPath, "utf8"), beforeDisk);
      assert.equal(subscriberCalls, 0);
      assert.doesNotMatch(JSON.stringify(result), /raw commit getter failure/);
      return { commitReads: commitReads.count };
    },
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("createSettingsController construction", () => {
  it("requires prefsPath or loadResult", () => {
    assert.throws(() => createSettingsController({}), /prefsPath or loadResult/);
  });

  it("loads defaults from missing file", () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    assert.strictEqual(ctrl.get("lang"), "en");
    assert.strictEqual(ctrl.get("soundMuted"), false);
    assert.strictEqual(ctrl.isLocked(), false);
  });

  it("respects locked state from future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: 999 }));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const ctrl = createSettingsController({ prefsPath: p });
      assert.strictEqual(ctrl.isLocked(), true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("quota ring display mode persistence", () => {
  it("accepts remaining through the controller and restores it after relaunch", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });

    const result = await ctrl.applyUpdate("quotaRingDisplayMode", "remaining");

    assert.deepStrictEqual(result, { status: "ok" });
    assert.strictEqual(ctrl.get("quotaRingDisplayMode"), "remaining");
    assert.strictEqual(prefs.load(p).snapshot.quotaRingDisplayMode, "remaining");

    const relaunched = createSettingsController({ prefsPath: p });
    assert.strictEqual(relaunched.get("quotaRingDisplayMode"), "remaining");
  });
});

describe("permission automation safe startup persistence", () => {
  it("keeps off across a relaunch", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const result = await ctrl.applyCommand("setPermissionAutomationMode", { mode: "off" });
    assert.strictEqual(result.status, "ok");
    ctrl.persist();
    assert.strictEqual(prefs.load(p).snapshot.permissionAutomationMode, "off");
  });

  it("keeps auto-tools across a relaunch", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const result = await ctrl.applyCommand("setPermissionAutomationMode", {
      mode: "auto-tools",
      confirmed: true,
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("permissionAutomationMode"), "auto-tools");
    assert.strictEqual(prefs.load(p).snapshot.permissionAutomationMode, "auto-tools");
  });

  it("keeps unattended for this process but relaunches in auto-tools", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const result = await ctrl.applyCommand("setPermissionAutomationMode", {
      mode: "unattended",
      confirmed: true,
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(
      ctrl.get("permissionAutomationMode"),
      "unattended",
      "the current process must stay fully automatic"
    );
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(onDisk.permissionAutomationMode, "auto-tools");
    const relaunched = createSettingsController({ prefsPath: p });
    assert.strictEqual(relaunched.get("permissionAutomationMode"), "auto-tools");
  });

  it("does not publish or commit a mode change when persistence fails", async () => {
    const snapshot = { ...prefs.getDefaults() };
    const failingPrefs = {
      load: () => ({ snapshot, locked: false }),
      save: () => {
        throw new Error("disk full");
      },
    };
    const ctrl = createSettingsController({
      prefsPath: "unused-in-memory-path",
      prefs: failingPrefs,
    });
    let broadcasts = 0;
    ctrl.subscribe(() => {
      broadcasts += 1;
    });

    const result = await ctrl.applyCommand("setPermissionAutomationMode", {
      mode: "unattended",
      confirmed: true,
    });

    assert.strictEqual(result.status, "error");
    assert.match(result.message, /disk full/);
    assert.strictEqual(ctrl.get("permissionAutomationMode"), "off");
    assert.strictEqual(broadcasts, 0);
  });

  it("keeps the previous automatic mode when switching off cannot persist", async () => {
    const snapshot = {
      ...prefs.getDefaults(),
      permissionAutomationMode: "auto-tools",
      permissionAutomationAutoToolsWarningDismissed: true,
    };
    const failingPrefs = {
      load: () => ({ snapshot, locked: false }),
      save: () => {
        throw new Error("read only");
      },
    };
    const ctrl = createSettingsController({
      prefsPath: "unused-in-memory-path",
      prefs: failingPrefs,
    });

    const result = await ctrl.applyCommand("setPermissionAutomationMode", {
      mode: "off",
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(ctrl.get("permissionAutomationMode"), "auto-tools");
  });

  it("rejects generic writers for mode and warning-gate fields", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const cases = [
      ctrl.applyUpdate("permissionAutomationMode", "unattended"),
      ctrl.applyBulk({ permissionAutomationAutoToolsWarningDismissed: true }),
      ctrl.hydrate({ permissionAutomationUnattendedWarningDismissed: true }),
      ctrl.applyUpdate("autoApproveAllPermissions", true),
    ];
    for (const result of cases) {
      assert.strictEqual((await result).status, "error");
      assert.match((await result).message, /command-only/);
    }
    assert.strictEqual(ctrl.get("permissionAutomationMode"), "off");
    assert.strictEqual(
      ctrl.get("permissionAutomationAutoToolsWarningDismissed"),
      false
    );
    assert.strictEqual(
      ctrl.get("permissionAutomationUnattendedWarningDismissed"),
      false
    );
    assert.strictEqual(ctrl.get("autoApproveAllPermissions"), false);
  });
});

describe("Codex auto-start gate commit ordering", () => {
  function createFailingController(snapshot, gateWrites) {
    const writeCodexAutoStartGate = (enabled) => {
      gateWrites.push(enabled);
      return true;
    };
    const ctrl = createSettingsController({
      prefsPath: "unused-in-memory-path",
      prefs: {
        load: () => ({ snapshot, locked: false }),
        save: () => {
          throw new Error("prefs read only");
        },
      },
      injectedDeps: {
        syncIntegrationForAgent: async () => ({ status: "ok" }),
        startMonitorForAgent() {},
        writeCodexAutoStartGate,
      },
    });
    // Mirrors main.js: an enabled gate is published only from the agents
    // subscriber, after the controller has persisted and committed the store.
    ctrl.subscribeKey("agents", (_agents, nextSnapshot) => {
      writeCodexAutoStartGate(nextSnapshot.agents.codex.enabled === true);
    });
    return ctrl;
  }

  it("does not enable the external gate when enabling Codex cannot persist", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.agents.codex = {
      ...snapshot.agents.codex,
      integrationInstalled: true,
      enabled: false,
    };
    const gateWrites = [];
    const ctrl = createFailingController(snapshot, gateWrites);

    const result = await ctrl.applyCommand("setAgentFlag", {
      agentId: "codex",
      flag: "enabled",
      value: true,
    });

    assert.strictEqual(result.status, "error");
    assert.match(result.message, /prefs read only/);
    assert.strictEqual(ctrl.get("agents").codex.enabled, false);
    assert.deepStrictEqual(gateWrites, []);
  });

  it("does not enable the external gate when installing Codex cannot persist", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.agents.codex = {
      ...snapshot.agents.codex,
      integrationInstalled: false,
      enabled: false,
    };
    const gateWrites = [];
    const ctrl = createFailingController(snapshot, gateWrites);

    const result = await ctrl.applyCommand("installAgentIntegration", {
      agentId: "codex",
    });

    assert.strictEqual(result.status, "error");
    assert.match(result.message, /prefs read only/);
    assert.strictEqual(ctrl.get("agents").codex.integrationInstalled, false);
    assert.strictEqual(ctrl.get("agents").codex.enabled, false);
    assert.deepStrictEqual(gateWrites, []);
  });

  it("does not publish an enabled gate from future-version locked prefs", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.agents.codex = {
      ...snapshot.agents.codex,
      integrationInstalled: true,
      enabled: false,
    };
    const gateWrites = [];
    const ctrl = createSettingsController({
      prefsPath: "unused-locked-path",
      prefs: {
        load: () => ({ snapshot, locked: true }),
        save: () => {
          throw new Error("locked prefs must not be persisted");
        },
      },
      injectedDeps: {
        syncIntegrationForAgent: async () => ({ status: "ok" }),
        startMonitorForAgent() {},
        writeCodexAutoStartGate(enabled) {
          gateWrites.push(enabled);
          return true;
        },
      },
    });
    ctrl.subscribeKey("agents", (_agents, nextSnapshot) => {
      if (ctrl.isLocked()) return;
      gateWrites.push(nextSnapshot.agents.codex.enabled === true);
    });

    const result = await ctrl.applyCommand("setAgentFlag", {
      agentId: "codex",
      flag: "enabled",
      value: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("agents").codex.enabled, true);
    assert.deepStrictEqual(gateWrites, []);
  });

  it("does not publish an enabled gate when installing under future-version locked prefs", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.agents.codex = {
      ...snapshot.agents.codex,
      integrationInstalled: false,
      enabled: false,
    };
    const gateWrites = [];
    const ctrl = createSettingsController({
      prefsPath: "unused-locked-path",
      prefs: {
        load: () => ({ snapshot, locked: true }),
        save: () => {
          throw new Error("locked prefs must not be persisted");
        },
      },
      injectedDeps: {
        syncIntegrationForAgent: async () => ({ status: "ok" }),
        startMonitorForAgent() {},
        writeCodexAutoStartGate(enabled) {
          gateWrites.push(enabled);
          return true;
        },
      },
    });
    ctrl.subscribeKey("agents", (_agents, nextSnapshot) => {
      if (ctrl.isLocked()) return;
      gateWrites.push(nextSnapshot.agents.codex.enabled === true);
    });

    const result = await ctrl.applyCommand("installAgentIntegration", {
      agentId: "codex",
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("agents").codex.integrationInstalled, true);
    assert.strictEqual(ctrl.get("agents").codex.enabled, true);
    assert.deepStrictEqual(gateWrites, []);
  });
});

describe("setTextScaleForDisplay end-to-end commit", () => {
  it("commits the per-display map through the controller and persists it", async () => {
    // Regression: the command's commit key must pass the controller's
    // registry validation ("unknown settings key textScaleByDisplay").
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      injectedDeps: { resolveTextScaleDisplayKey: () => "69992868" },
    });
    const r = await ctrl.applyCommand("setTextScaleForDisplay", { value: 1.35 });
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("textScaleByDisplay"), { "69992868": 1.35 });

    const again = await ctrl.applyCommand("setTextScaleForDisplay", { value: 1 });
    assert.strictEqual(again.status, "ok");
    assert.deepStrictEqual(ctrl.get("textScaleByDisplay"), { "69992868": 1 });
  });

  it("falls back to the legacy global key without display context", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyCommand("setTextScaleForDisplay", { value: 1.25 });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("textScale"), 1.25);
  });
});

describe("custom application command commits", () => {
  const application = {
    id: "custom-nova-ai-0123456789ab",
    name: "Nova AI",
    sourcePath: "C:\\Tools\\Nova AI",
    executablePath: "C:\\Tools\\Nova AI\\Nova AI.exe",
    processName: "Nova AI.exe",
    category: "code",
  };

  it("persists custom discovery paths through the controller registry", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyCommand("setAgentCustomDiscoveryPaths", {
      agentId: "custom",
      value: [application.sourcePath],
    });

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("customToolDiscoveryPaths"), [application.sourcePath]);
    assert.deepStrictEqual(prefs.load(p).snapshot.customToolDiscoveryPaths, [application.sourcePath]);
  });

  it("persists add and remove custom application commits through the controller registry", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({
      prefsPath: p,
      injectedDeps: { identifyCustomApplication: () => ({ ...application }) },
    });

    const added = await ctrl.applyCommand("addCustomApplication", { path: application.sourcePath });
    assert.strictEqual(added.status, "ok");
    assert.deepStrictEqual(ctrl.get("customApplications"), [application]);
    assert.strictEqual(ctrl.get("agents")[application.id].integrationInstalled, false);
    assert.deepStrictEqual(prefs.load(p).snapshot.customApplications, [application]);

    const removed = await ctrl.applyCommand("removeCustomApplication", { id: application.id });
    assert.strictEqual(removed.status, "ok");
    assert.deepStrictEqual(ctrl.get("customApplications"), []);
    assert.strictEqual(ctrl.get("agents")[application.id], undefined);
  });
});

describe("applyUpdate sync invariant", () => {
  it("sync action: returns a plain object, NOT a Promise, and the next sync read sees the new value", () => {
    // This is the contract that lets `ctx.lang = "zh"` work in sync menu setters
    // without microtask deferral. If applyUpdate were `async`, the commit
    // would slip past the next read on the same tick.
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(typeof r.then, "undefined", "sync action must return plain object");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh", "sync read after sync update sees new value");
  });

  it("async action: returns a Promise resolving to the same shape", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lazy: async (v) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return typeof v === "string" ? { status: "ok" } : { status: "error", message: "bad" };
        },
      },
    });
    const ret = ctrl.applyUpdate("lazy", "hello");
    assert.strictEqual(typeof ret.then, "function", "async action must return a Promise");
    const r = await ret;
    assert.strictEqual(r.status, "ok");
  });

  it("serializes concurrent async updates on the same key (no race)", async () => {
    // Two rapid toggles on an async-effect key must run in order — otherwise
    // the slow one resolves last and stomps the quick one's commit.
    const order = [];
    let tick = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lang: requireEnumSync(),
        size: {
          validate: () => ({ status: "ok" }),
          effect: async (v) => {
            const mine = ++tick;
            order.push(`start:${mine}:${v}`);
            // First call takes longer, so without the lock it'd finish
            // after the second and overwrite the store.
            await new Promise((r) => setTimeout(r, mine === 1 ? 25 : 1));
            order.push(`end:${mine}:${v}`);
            return { status: "ok" };
          },
        },
      },
    });
    const first = ctrl.applyUpdate("size", "S");
    const second = ctrl.applyUpdate("size", "M");
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ["start:1:S", "end:1:S", "start:2:M", "end:2:M"]);
    assert.strictEqual(ctrl.get("size"), "M");
  });

  it("manageClaudeHooksAutomatically uses the async effect path without changing controller semantics", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
        locked: false,
      },
      injectedDeps: {
        syncClaudeHooksNow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        startClaudeSettingsWatcher: () => {},
        stopClaudeSettingsWatcher: () => {},
      },
    });
    const ret = ctrl.applyUpdate("manageClaudeHooksAutomatically", true);
    assert.strictEqual(typeof ret.then, "function");
    const result = await ret;
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("manageClaudeHooksAutomatically"), true);
  });

  it("serializes Claude hook update and command work on one shared lock", async () => {
    const calls = [];
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
        locked: false,
      },
      injectedDeps: {
        syncClaudeHooksNow: async () => {
          calls.push("sync:start");
          await new Promise((resolve) => setTimeout(resolve, 10));
          calls.push("sync:end");
        },
        startClaudeSettingsWatcher: () => calls.push("watcher:start"),
        stopClaudeSettingsWatcher: () => calls.push("watcher:stop"),
        uninstallClaudeHooksNow: async () => {
          calls.push("uninstall:start");
          await new Promise((resolve) => setTimeout(resolve, 1));
          calls.push("uninstall:end");
        },
      },
    });

    const enable = ctrl.applyUpdate("manageClaudeHooksAutomatically", true);
    const disconnect = ctrl.applyCommand("uninstallHooks");
    const results = await Promise.all([enable, disconnect]);

    assert.strictEqual(results[0].status, "ok");
    assert.strictEqual(results[1].status, "ok");
    assert.deepStrictEqual(calls, [
      "sync:start",
      "sync:end",
      "watcher:start",
      "watcher:stop",
      "uninstall:start",
      "uninstall:end",
    ]);
    assert.strictEqual(ctrl.get("manageClaudeHooksAutomatically"), false);
  });
});

// Tiny helper — must be sync because controller's applyUpdate stays sync
// when the entry is a plain function.
function requireEnumSync() {
  return (v) => (typeof v === "string" ? { status: "ok" } : { status: "error" });
}

describe("applyUpdate", () => {
  it("commits valid pure-data updates and persists to disk", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(onDisk.lang, "zh");
  });

  it("rejects invalid values without touching the store", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyUpdate("lang", "klingon");
    assert.strictEqual(r.status, "error");
    assert.strictEqual(ctrl.get("lang"), "en");
    // File should not exist (no commit, no persist)
    assert.strictEqual(fs.existsSync(p), false);
  });

  it("returns noop:true when value is unchanged (no broadcast, no fsync)", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    let broadcasts = 0;
    ctrl.subscribe(() => broadcasts++);
    await ctrl.applyUpdate("lang", "zh"); // changes
    assert.strictEqual(broadcasts, 1);
    const r = await ctrl.applyUpdate("lang", "zh"); // same value
    assert.strictEqual(r.noop, true);
    assert.strictEqual(broadcasts, 1, "no second broadcast");
  });

  it("rejects unknown keys", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyUpdate("nonsense", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /unknown settings key/);
  });

  it("persists tutorialSeen through the normal update path", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r = await ctrl.applyUpdate("tutorialSeen", true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("tutorialSeen"), true);
    assert.strictEqual(prefs.load(p).snapshot.tutorialSeen, true);
  });

  it("persists Settings window bounds through the controller-only write path", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const bounds = { x: -1180, y: 90, width: 920, height: 680 };
    const r = await ctrl.applyUpdate("settingsWindowBounds", bounds);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("settingsWindowBounds"), bounds);
    assert.deepStrictEqual(prefs.load(p).snapshot.settingsWindowBounds, bounds);
  });


  it("persists Dashboard window bounds through the controller-only write path", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const bounds = { x: 240, y: 130, width: 640, height: 720 };
    const r = await ctrl.applyUpdate("dashboardWindowBounds", bounds);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("dashboardWindowBounds"), bounds);
    assert.deepStrictEqual(prefs.load(p).snapshot.dashboardWindowBounds, bounds);
  });

  it("persists Codex hook health notification prefs through applyUpdate", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const r1 = await ctrl.applyUpdate("codexHookHealthLastNotified", "feature-disabled");
    assert.strictEqual(r1.status, "ok");
    assert.strictEqual(ctrl.get("codexHookHealthLastNotified"), "feature-disabled");
    const r2 = await ctrl.applyUpdate("codexHookHealthNotifyEnabled", false);
    assert.strictEqual(r2.status, "ok");
    assert.strictEqual(ctrl.get("codexHookHealthNotifyEnabled"), false);
    const loaded = prefs.load(p).snapshot;
    assert.strictEqual(loaded.codexHookHealthLastNotified, "feature-disabled");
    assert.strictEqual(loaded.codexHookHealthNotifyEnabled, false);
  });

  it("persists the Telegram migration nudge signature through applyUpdate", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({ prefsPath: p });
    const result = await ctrl.applyUpdate("telegramMigrationLastNotified", "legacy-migration");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("telegramMigrationLastNotified"), "legacy-migration");
    assert.strictEqual(prefs.load(p).snapshot.telegramMigrationLastNotified, "legacy-migration");
  });
  it("enforces cross-field constraints (showTray/showDock)", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      // Seed both on explicitly — this guards the cross-field constraint, not
      // the showDock default (which is off for fresh installs).
      loadResult: { snapshot: { ...prefs.getDefaults(), showTray: true, showDock: true }, locked: false },
    });
    // Both seeded on; turning one off is allowed
    const r1 = await ctrl.applyUpdate("showTray", false);
    assert.strictEqual(r1.status, "ok");
    // Now showTray=false, showDock=true. Turning showDock off should fail.
    const r2 = await ctrl.applyUpdate("showDock", false);
    assert.strictEqual(r2.status, "error");
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("propagates async action errors as { status: error }", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        boom: async () => { throw new Error("kaboom"); },
      },
    });
    const r = await ctrl.applyUpdate("boom", "anything");
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /kaboom/);
  });

  it("does not commit autoStartWithClaude when management-disabled effect returns noop", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false, autoStartWithClaude: false },
        locked: false,
      },
      injectedDeps: {
        installAutoStart: () => { throw new Error("should not run"); },
        uninstallAutoStart: () => { throw new Error("should not run"); },
      },
    });
    const r = await ctrl.applyUpdate("autoStartWithClaude", true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.strictEqual(ctrl.get("autoStartWithClaude"), false);
  });
});

describe("applyBulk", () => {
  it("commits multiple fields atomically and broadcasts once", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let broadcasts = 0;
    let lastChanges = null;
    ctrl.subscribe(({ changes }) => { broadcasts++; lastChanges = changes; });
    const r = await ctrl.applyBulk({ x: 100, y: 200, lang: "zh" });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(broadcasts, 1);
    assert.deepStrictEqual(lastChanges, { x: 100, y: 200, lang: "zh" });
    assert.strictEqual(ctrl.get("x"), 100);
    assert.strictEqual(ctrl.get("y"), 200);
    assert.strictEqual(ctrl.get("lang"), "zh");
  });

  it("rejects the entire bulk if any field fails validation", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyBulk({ x: 100, lang: "klingon" });
    assert.strictEqual(r.status, "error");
    // Neither field committed
    assert.strictEqual(ctrl.get("x"), 0);
    assert.strictEqual(ctrl.get("lang"), "en");
  });

  it("returns noop:true when nothing changed", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyBulk({ lang: "en", soundMuted: false });
    assert.strictEqual(r.noop, true);
  });

  it("rejects bulk that would violate cross-field constraints (showTray + showDock)", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      // Seed both on explicitly (showDock now defaults off for fresh installs).
      loadResult: { snapshot: { ...prefs.getDefaults(), showTray: true, showDock: true }, locked: false },
    });
    // Both seeded on. Trying to set both false in a single bulk should be
    // caught by post-validation even though each individual validator only
    // sees the pre-bulk snapshot.
    const r = await ctrl.applyBulk({ showTray: false, showDock: false });
    assert.strictEqual(r.status, "error");
    // Neither field committed — store still has both true
    assert.strictEqual(ctrl.get("showTray"), true);
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("allows bulk with only one of showTray/showDock set to false", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      // Seed both on explicitly (showDock now defaults off for fresh installs).
      loadResult: { snapshot: { ...prefs.getDefaults(), showTray: true, showDock: true }, locked: false },
    });
    const r = await ctrl.applyBulk({ showTray: false });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("showTray"), false);
    assert.strictEqual(ctrl.get("showDock"), true);
  });

  it("rejects effect-bearing keys to protect the no-rollback commit path", async () => {
    // applyBulk interleaves validators with effects; if a later key fails,
    // earlier effects have already executed. Callers should reach for
    // applyUpdate for system-backed keys. Enforced at the boundary so a
    // future bulk-window-bounds flush can't quietly sneak in a login item.
    let effectRan = false;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        x: (v) => (typeof v === "number" ? { status: "ok" } : { status: "error" }),
        dangerous: {
          validate: (v) => (typeof v === "boolean" ? { status: "ok" } : { status: "error" }),
          effect: () => {
            effectRan = true;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyBulk({ x: 100, dangerous: true });
    assert.strictEqual(r.status, "error");
    assert.ok(/applyBulk|applyUpdate/.test(r.message));
    assert.strictEqual(effectRan, false, "effect must not run on rejected bulk");
  });
});

describe("applyCommand", () => {
  it("rejects unknown commands", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.applyCommand("nope", {});
    assert.strictEqual(r.status, "error");
  });

  it("commits side-effect commands that return a `commit` field", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        myCmd: async (payload) => ({
          status: "ok",
          commit: { lang: payload.lang },
        }),
      },
    });
    const r = await ctrl.applyCommand("myCmd", { lang: "zh" });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
  });

  it("propagates command errors", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        boom: () => ({ status: "error", message: "denied" }),
      },
    });
    const r = await ctrl.applyCommand("boom", {});
    assert.strictEqual(r.status, "error");
    assert.strictEqual(r.message, "denied");
  });

  it("defensive-validates commit payloads against the updateRegistry", async () => {
    // A buggy command could return an invalid commit; without the guard,
    // that shape would land in the store and persist to disk.
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        naughty: () => ({ status: "ok", commit: { lang: "klingon" } }),
      },
    });
    const r = await ctrl.applyCommand("naughty", {});
    assert.strictEqual(r.status, "error");
    assert.ok(/klingon|lang/.test(r.message));
    // Store must remain at the default (unchanged)
    assert.strictEqual(ctrl.get("lang"), "en");
  });

  it("rejects commit keys unknown to the updateRegistry", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        writeJunk: () => ({ status: "ok", commit: { notARealKey: 42 } }),
      },
    });
    const r = await ctrl.applyCommand("writeJunk", {});
    assert.strictEqual(r.status, "error");
    assert.ok(/notARealKey/.test(r.message));
  });

  it("serializes same-name commands so later calls see earlier effects", async () => {
    // Without per-key locking, two async calls could race and the
    // later-resolving effect would commit over the earlier one.
    const order = [];
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        slow: async (payload) => {
          order.push(`start:${payload.tag}`);
          await new Promise((r) => setTimeout(r, payload.tag === "a" ? 20 : 1));
          order.push(`end:${payload.tag}`);
          return { status: "ok" };
        },
      },
    });
    const a = ctrl.applyCommand("slow", { tag: "a" });
    const b = ctrl.applyCommand("slow", { tag: "b" });
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
  });

  it("serializes commands sharing a domain lockKey (cross-command race fix)", async () => {
    // Codex review #9 high finding: remoteSsh.update / .markDeployed /
    // .delete all write the same prefs field. Without a shared lockKey
    // they execute concurrently — markDeployed can compute its commit
    // from a stale snapshot taken before update committed, and stomp
    // the user's edit. Domain lockKey forces serialization.
    const order = [];
    const slowFast = async (payload) => {
      order.push(`start:${payload.tag}`);
      await new Promise((r) => setTimeout(r, payload.tag === "a" ? 20 : 1));
      order.push(`end:${payload.tag}`);
      return { status: "ok" };
    };
    const cmdA = (payload) => slowFast(payload);
    const cmdB = (payload) => slowFast(payload);
    cmdA.lockKey = "shared";
    cmdB.lockKey = "shared";
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { cmdA, cmdB },
    });
    const a = ctrl.applyCommand("cmdA", { tag: "a" });
    const b = ctrl.applyCommand("cmdB", { tag: "b" });
    await Promise.all([a, b]);
    // Without shared lock they'd interleave start:a, start:b, end:b, end:a.
    assert.deepStrictEqual(order, ["start:a", "end:a", "start:b", "end:b"],
      "commands sharing a domain lockKey must serialize even across different names");
  });

  it("runs concurrent non-writing commands immediately so two calls overlap", async () => {
    const started = [];
    const release = {
      a: createDeferred(),
      b: createDeferred(),
    };
    const lookupLike = async ({ tag }) => {
      started.push(tag);
      await release[tag].promise;
      return { status: "ok" };
    };
    lookupLike.concurrent = true;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { lookupLike },
    });

    const first = ctrl.applyCommand("lookupLike", { tag: "a" });
    const second = ctrl.applyCommand("lookupLike", { tag: "b" });
    const startedBeforeRelease = started.slice();
    release.a.resolve();
    release.b.resolve();
    await Promise.all([first, second]);

    assert.deepStrictEqual(startedBeforeRelease, ["a", "b"]);
  });

  it("forbids settings commits returned by concurrent commands without changing state", async () => {
    await createConcurrentCommitFixture(() => ({
      status: "ok",
      commit: { lang: "zh" },
      operation: "synthetic",
    })).run();
  });

  it("forbids inherited settings commits returned by concurrent commands", async () => {
    await createConcurrentCommitFixture(() => (
      Object.assign(Object.create({ commit: { lang: "zh" } }), { status: "ok" })
    )).run();
  });

  it("rejects a deceptive Proxy commit from a concurrent command without writing", async () => {
    const { commitReads } = await createConcurrentCommitFixture(
      ({ commitReads }) => createConcurrentCommitProxy(commitReads, () => ({ lang: "zh" })),
    ).run();
    assert.equal(commitReads, 1);
  });

  it("fails closed when a concurrent commit property cannot be inspected", async () => {
    const { commitReads } = await createConcurrentCommitFixture(
      ({ commitReads }) => createConcurrentCommitProxy(commitReads, () => {
        throw new Error("raw commit getter failure");
      }),
    ).run();
    assert.equal(commitReads, 1);
  });

  it("gives concurrent commands only explicit dependencies while ordinary commands keep the full set", async () => {
    const normalWriter = () => ({ status: "ok" });
    const allowedLookup = () => ({ status: "ok" });
    let concurrentSeen;
    let ordinarySeen;
    const concurrentProbe = (_payload, deps) => {
      concurrentSeen = deps;
      return { status: "ok" };
    };
    concurrentProbe.concurrent = true;
    const ordinaryProbe = (_payload, deps) => {
      ordinarySeen = deps;
      return { status: "ok" };
    };
    const ctrl = createSettingsController({
      loadResult: { snapshot: prefs.getDefaults(), locked: false },
      commands: { concurrentProbe, ordinaryProbe },
      injectedDeps: {
        writeFeishuApprovalSecrets: normalWriter,
        ordinaryOnlyDependency: normalWriter,
      },
      concurrentDeps: {
        lookupFeishuApproverByEmail: allowedLookup,
      },
    });

    assert.equal((await ctrl.applyCommand("concurrentProbe", {})).status, "ok");
    assert.equal((await ctrl.applyCommand("ordinaryProbe", {})).status, "ok");

    assert.equal("writeFeishuApprovalSecrets" in concurrentSeen, false);
    assert.equal(concurrentSeen.lookupFeishuApproverByEmail, allowedLookup);
    assert.deepEqual(concurrentSeen.snapshot, ctrl.getSnapshot());
    assert.equal(ordinarySeen.writeFeishuApprovalSecrets, normalWriter);
    assert.equal(ordinarySeen.ordinaryOnlyDependency, normalWriter);
    assert.deepEqual(ordinarySeen.snapshot, ctrl.getSnapshot());
  });

  it("rejects concurrent commands that also declare a lockKey before invocation", async () => {
    let invoked = 0;
    const invalidConcurrent = () => {
      invoked += 1;
      return { status: "ok" };
    };
    invalidConcurrent.concurrent = true;
    invalidConcurrent.lockKey = "feishuApproval";
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { invalidConcurrent },
    });

    const result = await ctrl.applyCommand("invalidConcurrent", {});

    assert.deepStrictEqual(result, {
      status: "error",
      code: "concurrent-command-lock-forbidden",
    });
    assert.equal(invoked, 0);
  });

  it("preserves non-concurrent same-name and shared-domain serialization", async () => {
    const sameNameStarted = [];
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const serialized = async ({ tag }) => {
      sameNameStarted.push(tag);
      if (tag === "a") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { status: "ok" };
    };
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { serialized },
    });
    const first = ctrl.applyCommand("serialized", { tag: "a" });
    await firstStarted.promise;
    const second = ctrl.applyCommand("serialized", { tag: "b" });
    assert.deepStrictEqual(sameNameStarted, ["a"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepStrictEqual(sameNameStarted, ["a", "b"]);

    const domainStarted = [];
    const domainFirstStarted = createDeferred();
    const domainRelease = createDeferred();
    const domainCommand = async ({ tag }) => {
      domainStarted.push(tag);
      if (tag === "a") {
        domainFirstStarted.resolve();
        await domainRelease.promise;
      }
      return { status: "ok" };
    };
    const domainOtherCommand = async ({ tag }) => {
      domainStarted.push(tag);
      return { status: "ok" };
    };
    domainCommand.lockKey = "shared-domain";
    domainOtherCommand.lockKey = "shared-domain";
    const domainCtrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { domainCommand, domainOtherCommand },
    });
    const domainFirst = domainCtrl.applyCommand("domainCommand", { tag: "a" });
    await domainFirstStarted.promise;
    const domainSecond = domainCtrl.applyCommand("domainOtherCommand", { tag: "b" });
    assert.deepStrictEqual(domainStarted, ["a"]);
    domainRelease.resolve();
    await Promise.all([domainFirst, domainSecond]);
    assert.deepStrictEqual(domainStarted, ["a", "b"]);
  });

  it("keeps ordinary command metadata while stripping its internal commit", async () => {
    const ordinary = () => ({
      status: "ok",
      commit: { lang: "zh" },
      reason: "synthetic-metadata",
    });
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { ordinary },
    });

    const result = await ctrl.applyCommand("ordinary", {});

    assert.equal(result.status, "ok");
    assert.equal(result.reason, "synthetic-metadata");
    assert.equal(Object.prototype.hasOwnProperty.call(result, "commit"), false);
    assert.equal(ctrl.get("lang"), "zh");
  });

  it("commands without shared lockKey can interleave (control: distinct lockKeys are independent)", async () => {
    const order = [];
    const slowFast = async (payload) => {
      order.push(`start:${payload.tag}`);
      await new Promise((r) => setTimeout(r, payload.tag === "a" ? 20 : 1));
      order.push(`end:${payload.tag}`);
      return { status: "ok" };
    };
    const cmdA = (payload) => slowFast(payload);
    const cmdB = (payload) => slowFast(payload);
    // No lockKey on either — controller defaults to per-name lock; different
    // names → no cross-command serialization.
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: { cmdA, cmdB },
    });
    const a = ctrl.applyCommand("cmdA", { tag: "a" });
    const b = ctrl.applyCommand("cmdB", { tag: "b" });
    await Promise.all([a, b]);
    // b finishes first (1ms vs 20ms) without serialization.
    assert.deepStrictEqual(order, ["start:a", "start:b", "end:b", "end:a"]);
  });

  it("applies uninstallHooks commit without clearing latent autoStartWithClaude preference", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true, autoStartWithClaude: true },
        locked: false,
      },
      commands: {
        uninstallHooks: () => ({ status: "ok", commit: { manageClaudeHooksAutomatically: false } }),
      },
    });
    const r = await ctrl.applyCommand("uninstallHooks", null);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("manageClaudeHooksAutomatically"), false);
    assert.strictEqual(ctrl.get("autoStartWithClaude"), true);
  });

  it("applies setSessionAlias through the default command registry and persists it", async () => {
    const p = makeTempPath();
    const ctrl = createSettingsController({
      prefsPath: p,
      injectedDeps: {
        now: () => 1000,
        getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]),
      },
    });

    const r = await ctrl.applyCommand("setSessionAlias", {
      host: null,
      agentId: "codex",
      sessionId: "s1",
      alias: "Codex main",
    });

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(ctrl.get("sessionAliases"), {
      "local|codex|s1": { title: "Codex main", updatedAt: 1000 },
    });
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.deepStrictEqual(onDisk.sessionAliases, {
      "local|codex|s1": { title: "Codex main", updatedAt: 1000 },
    });
  });
});

describe("Feishu approval settings domain", () => {
  function createCountingFeishuController() {
    const snapshot = prefs.getDefaults();
    const metrics = { persistCalls: 0, subscriberCalls: 0 };
    const ctrl = createSettingsController({
      prefsPath: "in-memory-path",
      prefs: {
        save: () => {
          metrics.persistCalls += 1;
        },
      },
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
    });
    ctrl.subscribe(() => {
      metrics.subscriberCalls += 1;
    });
    return { ctrl, metrics };
  }

  function createLookupOverlapFixture() {
    const transport = {
      a: createDeferred(),
      b: createDeferred(),
    };
    const transportCalls = [];
    let nextLookupId = 0;
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => `lookup-${++nextLookupId}`,
    });
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      platform: "feishu",
      approverId: "",
      approverSource: "none",
      approverBoundPlatform: "",
      approverBoundAppId: "",
    };
    const lookupDeps = {
      getFeishuApprovalPrefs: () => snapshot.feishuApproval,
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 1,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail: ({ email }) => {
        transportCalls.push(email);
        const key = email.startsWith("a-") ? "a" : "b";
        return transport[key].promise;
      },
    };
    const ctrl = createSettingsController({
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: lookupDeps,
      concurrentDeps: lookupDeps,
    });
    return { ctrl, coordinator, transport, transportCalls };
  }

  function createQueuedFeishuMutationFixture() {
    const prefsPath = makeTempPath();
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      enabled: false,
      connectionTimeoutSeconds: 15,
      platform: "feishu",
      approverId: "",
      approverSource: "none",
      approverBoundPlatform: "",
      approverBoundAppId: "",
    };
    prefs.save(prefsPath, snapshot);
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-queued",
    });
    const started = coordinator.begin({
      requestId: "request-queued",
      identity: { platform: "feishu", appId: "cli_saved" },
      secretsRevision: 1,
    });
    coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_new" });
    const gateStarted = createDeferred();
    const gateRelease = createDeferred();
    const gate = async () => {
      gateStarted.resolve();
      await gateRelease.promise;
      return { status: "ok" };
    };
    gate.lockKey = "feishuApproval";
    const ctrl = createSettingsController({
      prefsPath,
      loadResult: { snapshot, locked: false },
      commands: { ...commandRegistry, gate },
      injectedDeps: {
        getFeishuApprovalPrefs: () => ctrl.get("feishuApproval"),
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: "feishu",
          appId: "cli_saved",
          appSecret: "saved-secret",
        }),
        getFeishuApprovalSecretsRevision: () => 1,
        feishuApprovalLookupCoordinator: coordinator,
      },
    });
    return { ctrl, gateStarted, gateRelease };
  }

  async function queueFeishuOperationsInOrder({ first, second }) {
    const gate = first.fixture.ctrl.applyCommand("gate", {});
    await first.fixture.gateStarted.promise;
    const firstOperation = first.start();
    const secondOperation = second.start();
    first.fixture.gateRelease.resolve();
    await gate;
    return {
      firstResult: await firstOperation,
      secondResult: await secondOperation,
      finalSnapshot: first.fixture.ctrl.get("feishuApproval"),
    };
  }

  it("wires real Feishu resolve and cancel through only the concurrent lookup dependencies", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      platform: "feishu",
      approverId: "",
      approverSource: "none",
      approverBoundPlatform: "",
      approverBoundAppId: "",
    };
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-allowlisted",
    });
    const transportStarted = createDeferred();
    const transportRelease = createDeferred();
    let controller;
    let resolveDeps;
    const lookupFeishuApproverByEmail = function (payload) {
      resolveDeps = this;
      transportStarted.resolve(payload);
      return transportRelease.promise;
    };
    const concurrentDeps = {
      getFeishuApprovalPrefs: () => controller.get("feishuApproval"),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "stored-value",
      }),
      getFeishuApprovalSecretsRevision: () => 1,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail,
    };
    controller = createSettingsController({
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: {
        writeFeishuApprovalSecrets: () => ({ status: "ok" }),
      },
      concurrentDeps,
    });

    const lookup = controller.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-allowlisted",
      email: "person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    await transportStarted.promise;

    assert.equal(resolveDeps.getFeishuApprovalPrefs, concurrentDeps.getFeishuApprovalPrefs);
    assert.equal(resolveDeps.getFeishuApprovalSecrets, concurrentDeps.getFeishuApprovalSecrets);
    assert.equal(
      resolveDeps.getFeishuApprovalSecretsRevision,
      concurrentDeps.getFeishuApprovalSecretsRevision,
    );
    assert.equal(resolveDeps.feishuApprovalLookupCoordinator, coordinator);
    assert.equal(resolveDeps.lookupFeishuApproverByEmail, lookupFeishuApproverByEmail);
    assert.equal("writeFeishuApprovalSecrets" in resolveDeps, false);
    assert.deepEqual(resolveDeps.snapshot, controller.getSnapshot());

    assert.deepEqual(
      await controller.applyCommand("feishuApproval.cancelApproverLookup", {
        requestId: "request-allowlisted",
      }),
      { status: "ok", code: "lookup-cancelled", message: undefined },
    );
    transportRelease.resolve({ status: "ok", approverId: "ou_late" });
    assert.deepEqual(await lookup, { status: "error", code: "lookup-cancelled" });
  });

  it("preserves enabled and new approver when the field-level save queues before commit", async () => {
    const fixture = createQueuedFeishuMutationFixture();
    const result = await queueFeishuOperationsInOrder({
      first: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.updateConfig", { enabled: true }),
      },
      second: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-queued" }),
      },
    });

    assert.equal(result.firstResult.status, "ok");
    assert.equal(result.secondResult.status, "ok");
    assert.equal(result.finalSnapshot.enabled, true);
    assert.equal(result.finalSnapshot.approverId, "ou_new");
    assert.equal(result.finalSnapshot.approverSource, "lookup");
    assert.equal(result.finalSnapshot.approverBoundPlatform, "feishu");
    assert.equal(result.finalSnapshot.approverBoundAppId, "cli_saved");
  });

  it("preserves enabled and new approver when commit queues before an already-created field-level save", async () => {
    const fixture = createQueuedFeishuMutationFixture();
    const result = await queueFeishuOperationsInOrder({
      first: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-queued" }),
      },
      second: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.updateConfig", { enabled: true }),
      },
    });

    assert.equal(result.firstResult.status, "ok");
    assert.equal(result.secondResult.status, "ok");
    assert.equal(result.finalSnapshot.enabled, true);
    assert.equal(result.finalSnapshot.approverId, "ou_new");
    assert.equal(result.finalSnapshot.approverSource, "lookup");
  });

  it("preserves timeout and new approver when the field-level save queues before commit", async () => {
    const fixture = createQueuedFeishuMutationFixture();
    const result = await queueFeishuOperationsInOrder({
      first: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.updateConfig", { connectionTimeoutSeconds: 30 }),
      },
      second: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-queued" }),
      },
    });

    assert.equal(result.firstResult.status, "ok");
    assert.equal(result.secondResult.status, "ok");
    assert.equal(result.finalSnapshot.connectionTimeoutSeconds, 30);
    assert.equal(result.finalSnapshot.approverId, "ou_new");
    assert.equal(result.finalSnapshot.approverSource, "lookup");
  });

  it("preserves timeout and new approver when commit queues before an already-created field-level save", async () => {
    const fixture = createQueuedFeishuMutationFixture();
    const result = await queueFeishuOperationsInOrder({
      first: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-queued" }),
      },
      second: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.updateConfig", { connectionTimeoutSeconds: 30 }),
      },
    });

    assert.equal(result.firstResult.status, "ok");
    assert.equal(result.secondResult.status, "ok");
    assert.equal(result.finalSnapshot.connectionTimeoutSeconds, 30);
    assert.equal(result.finalSnapshot.approverId, "ou_new");
    assert.equal(result.finalSnapshot.approverSource, "lookup");
  });

  it("fails closed for a stale generic full-object update after an approver commit", async () => {
    const fixture = createQueuedFeishuMutationFixture();
    const staleFullObject = { ...fixture.ctrl.get("feishuApproval"), enabled: true };
    const result = await queueFeishuOperationsInOrder({
      first: {
        fixture,
        start: () => fixture.ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-queued" }),
      },
      second: {
        fixture,
        start: () => fixture.ctrl.applyUpdate("feishuApproval", staleFullObject),
      },
    });

    assert.equal(result.firstResult.status, "ok");
    assert.deepEqual(result.secondResult, {
      status: "error",
      message: "feishuApproval: command-only setting cannot be changed via applyUpdate",
    });
    assert.equal(result.finalSnapshot.enabled, false);
    assert.equal(result.finalSnapshot.approverId, "ou_new");
    assert.equal(result.finalSnapshot.approverSource, "lookup");
  });

  it("rejects a matching-tuple stale timeout update after the authoritative patch", async () => {
    const { ctrl, metrics } = createCountingFeishuController();
    const staleObject = { ...ctrl.get("feishuApproval") };
    const tupleKeys = [
      "idType",
      "approverId",
      "approverSource",
      "approverBoundPlatform",
      "approverBoundAppId",
    ];

    const patchResult = await ctrl.applyCommand(
      "feishuApproval.updateConfig",
      { connectionTimeoutSeconds: 30 },
    );
    assert.equal(patchResult.status, "ok");
    assert.equal(ctrl.get("feishuApproval").connectionTimeoutSeconds, 30);
    assert.equal(metrics.persistCalls, 1);
    assert.equal(metrics.subscriberCalls, 1);

    const genericResult = ctrl.applyUpdate("feishuApproval", staleObject);

    assert.equal(genericResult.status, "error");
    assert.match(genericResult.message, /command-only/);
    assert.equal(ctrl.get("feishuApproval").connectionTimeoutSeconds, 30);
    for (const key of tupleKeys) {
      assert.equal(ctrl.get("feishuApproval")[key], staleObject[key], key);
    }
    assert.equal(metrics.persistCalls, 1);
    assert.equal(metrics.subscriberCalls, 1);
  });

  it("rejects a matching-tuple stale enabled update after the authoritative patch", async () => {
    const { ctrl, metrics } = createCountingFeishuController();
    const staleObject = { ...ctrl.get("feishuApproval") };
    assert.equal(staleObject.enabled, false);

    const patchResult = await ctrl.applyCommand(
      "feishuApproval.updateConfig",
      { enabled: true },
    );
    assert.equal(patchResult.status, "ok");
    assert.equal(ctrl.get("feishuApproval").enabled, true);

    const genericResult = ctrl.applyUpdate("feishuApproval", staleObject);

    assert.equal(genericResult.status, "error");
    assert.equal(ctrl.get("feishuApproval").enabled, true);
    assert.equal(metrics.persistCalls, 1);
    assert.equal(metrics.subscriberCalls, 1);
  });

  it("rejects a generic Feishu bulk update atomically with unrelated settings", () => {
    const { ctrl, metrics } = createCountingFeishuController();
    const before = ctrl.getSnapshot();
    const staleObject = { ...before.feishuApproval };

    const result = ctrl.applyBulk({
      feishuApproval: staleObject,
      lang: "zh",
    });

    assert.equal(result.status, "error");
    assert.match(result.message, /command-only/);
    assert.deepStrictEqual(ctrl.get("feishuApproval"), before.feishuApproval);
    assert.equal(ctrl.get("lang"), before.lang);
    assert.equal(metrics.persistCalls, 0);
    assert.equal(metrics.subscriberCalls, 0);
  });

  it("rejects a generic Feishu hydrate atomically with unrelated settings", () => {
    const { ctrl, metrics } = createCountingFeishuController();
    const before = ctrl.getSnapshot();
    const staleObject = { ...before.feishuApproval };

    const result = ctrl.hydrate({
      feishuApproval: staleObject,
      lang: "zh",
    });

    assert.equal(result.status, "error");
    assert.match(result.message, /command-only/);
    assert.deepStrictEqual(ctrl.get("feishuApproval"), before.feishuApproval);
    assert.equal(ctrl.get("lang"), before.lang);
    assert.equal(metrics.persistCalls, 0);
    assert.equal(metrics.subscriberCalls, 0);
  });

  it("lets lookup B start before lookup A settles and only B can commit when B resolves first", async () => {
    const { ctrl, coordinator, transport, transportCalls } = createLookupOverlapFixture();
    const first = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-a",
      email: "a-person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const second = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-b",
      email: "b-person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const startedBeforeRelease = transportCalls.slice();

    transport.b.resolve({ status: "ok", approverId: "ou_b" });
    transport.a.resolve({ status: "ok", approverId: "ou_a" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepStrictEqual(startedBeforeRelease, [
      "a-person@example.com",
      "b-person@example.com",
    ]);
    assert.deepEqual(firstResult, { status: "error", code: "lookup-superseded" });
    assert.deepEqual(secondResult, { status: "ok", lookupId: "lookup-2", message: undefined });
    assert.deepEqual(coordinator.consume({
      lookupId: "lookup-1",
      identity: { platform: "feishu", appId: "cli_saved" },
      secretsRevision: 1,
    }), { status: "error", code: "lookup-superseded" });
    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-2" }),
      { status: "ok", message: undefined },
    );
    assert.equal(ctrl.get("feishuApproval").approverId, "ou_b");
  });

  it("keeps lookup A superseded when A transport resolves before B after both already started", async () => {
    const { ctrl, coordinator, transport, transportCalls } = createLookupOverlapFixture();
    const first = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-a",
      email: "a-person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const second = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-b",
      email: "b-person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const startedBeforeRelease = transportCalls.slice();

    transport.a.resolve({ status: "ok", approverId: "ou_a" });
    transport.b.resolve({ status: "ok", approverId: "ou_b" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepStrictEqual(startedBeforeRelease, [
      "a-person@example.com",
      "b-person@example.com",
    ]);
    assert.deepEqual(firstResult, { status: "error", code: "lookup-superseded" });
    assert.deepEqual(secondResult, { status: "ok", lookupId: "lookup-2", message: undefined });
    assert.deepEqual(coordinator.consume({
      lookupId: "lookup-1",
      identity: { platform: "feishu", appId: "cli_saved" },
      secretsRevision: 1,
    }), { status: "error", code: "lookup-superseded" });
    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-2" }),
      { status: "ok", message: undefined },
    );
    assert.equal(ctrl.get("feishuApproval").approverId, "ou_b");
  });

  it("rejects a lookup result after an overlapping credential update changes identity", async () => {
    const prefsPath = makeTempPath();
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      platform: "feishu",
      approverId: "",
      approverSource: "none",
      approverBoundPlatform: "",
      approverBoundAppId: "",
    };
    prefs.save(prefsPath, snapshot);
    const transportStarted = createDeferred();
    const transportRelease = createDeferred();
    const credentialStarted = createDeferred();
    const credentialRelease = createDeferred();
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-credential",
    });
    let savedSecrets = {
      credentialPlatform: "feishu",
      appId: "cli_saved",
      appSecret: "saved-secret",
    };
    let secretsRevision = 1;
    const lookupDeps = {
      getFeishuApprovalPrefs: () => ctrl.get("feishuApproval"),
      getFeishuApprovalSecrets: () => savedSecrets,
      getFeishuApprovalSecretsRevision: () => secretsRevision,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail: ({ signal }) => {
        transportStarted.resolve(signal);
        return transportRelease.promise;
      },
    };
    const ctrl = createSettingsController({
      prefsPath,
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: {
        ...lookupDeps,
        writeFeishuApprovalSecrets: async (nextSecrets) => {
          credentialStarted.resolve();
          await credentialRelease.promise;
          savedSecrets = { ...nextSecrets };
          secretsRevision = 2;
          return { status: "ok", secretsStored: true };
        },
      },
      concurrentDeps: lookupDeps,
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });
    const beforeDisk = fs.readFileSync(prefsPath, "utf8");

    const lookup = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-credential",
      email: "person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const signal = await transportStarted.promise;
    const credentialUpdate = ctrl.applyCommand("feishuApproval.setSecrets", {
      appId: "cli_changed",
      appSecret: "changed-secret",
    });
    await credentialStarted.promise;

    assert.equal(signal.aborted, false);
    credentialRelease.resolve();
    assert.equal((await credentialUpdate).status, "ok");
    transportRelease.resolve({ status: "ok", approverId: "ou_old" });
    assert.deepEqual(await lookup, {
      status: "ok",
      lookupId: "lookup-credential",
      message: undefined,
    });

    const commit = await ctrl.applyCommand("feishuApproval.commitApprover", {
      lookupId: "lookup-credential",
    });
    assert.deepEqual(commit, { status: "error", code: "lookup-credentials-changed" });
    assert.equal(ctrl.get("feishuApproval").approverId, "");
    assert.equal(subscriberCalls, 0);
    assert.equal(fs.readFileSync(prefsPath, "utf8"), beforeDisk);
  });

  it("rejects a ready lookup when a queued credential update linearizes first", async () => {
    const prefsPath = makeTempPath();
    const snapshot = prefs.getDefaults();
    prefs.save(prefsPath, snapshot);
    const transportStarted = createDeferred();
    const transportRelease = createDeferred();
    const credentialStarted = createDeferred();
    const credentialRelease = createDeferred();
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-ready-credential",
    });
    let savedSecrets = {
      credentialPlatform: "feishu",
      appId: "cli_saved",
      appSecret: "saved-secret",
    };
    let secretsRevision = 1;
    const lookupDeps = {
      getFeishuApprovalPrefs: () => ctrl.get("feishuApproval"),
      getFeishuApprovalSecrets: () => savedSecrets,
      getFeishuApprovalSecretsRevision: () => secretsRevision,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail: ({ signal }) => {
        transportStarted.resolve(signal);
        return transportRelease.promise;
      },
    };
    const ctrl = createSettingsController({
      prefsPath,
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: {
        ...lookupDeps,
        writeFeishuApprovalSecrets: async (nextSecrets) => {
          credentialStarted.resolve();
          await credentialRelease.promise;
          savedSecrets = { ...nextSecrets };
          secretsRevision = 2;
          return { status: "ok", secretsStored: true };
        },
      },
      concurrentDeps: lookupDeps,
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });
    const beforeDisk = fs.readFileSync(prefsPath, "utf8");

    const lookup = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-ready-credential",
      email: "person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    await transportStarted.promise;
    transportRelease.resolve({ status: "ok", approverId: "ou_ready" });
    assert.deepEqual(await lookup, {
      status: "ok",
      lookupId: "lookup-ready-credential",
      message: undefined,
    });
    assert.equal(coordinator.inspect().current.hasApproverId, true);

    const credentialUpdate = ctrl.applyCommand("feishuApproval.setSecrets", {
      appId: "cli_changed",
      appSecret: "changed-secret",
    });
    await credentialStarted.promise;
    const commit = ctrl.applyCommand("feishuApproval.commitApprover", {
      lookupId: "lookup-ready-credential",
    });
    credentialRelease.resolve();

    assert.equal((await credentialUpdate).status, "ok");
    assert.deepEqual(await commit, { status: "error", code: "lookup-credentials-changed" });
    assert.equal(savedSecrets.appId, "cli_changed");
    assert.equal(secretsRevision, 2);
    assert.equal(ctrl.get("feishuApproval").approverId, "");
    assert.equal(subscriberCalls, 0);
    assert.equal(fs.readFileSync(prefsPath, "utf8"), beforeDisk);
  });

  it("lets cancel abort a running lookup before transport settles and rejects late success", async () => {
    const prefsPath = makeTempPath();
    const snapshot = prefs.getDefaults();
    prefs.save(prefsPath, snapshot);
    const transportStarted = createDeferred();
    const transportRelease = createDeferred();
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-cancel",
    });
    const lookupDeps = {
      getFeishuApprovalPrefs: () => ctrl.get("feishuApproval"),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 1,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail: ({ signal }) => {
        transportStarted.resolve(signal);
        return transportRelease.promise;
      },
    };
    const ctrl = createSettingsController({
      prefsPath,
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: lookupDeps,
      concurrentDeps: lookupDeps,
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });
    const beforeDisk = fs.readFileSync(prefsPath, "utf8");

    const lookup = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-cancel",
      email: "person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    const signal = await transportStarted.promise;
    const cancel = await ctrl.applyCommand("feishuApproval.cancelApproverLookup", {
      requestId: "request-cancel",
    });

    assert.equal(signal.aborted, true);
    assert.deepEqual(cancel, {
      status: "ok",
      code: "lookup-cancelled",
      message: undefined,
    });
    transportRelease.resolve({ status: "ok", approverId: "ou_late" });
    assert.deepEqual(await lookup, { status: "error", code: "lookup-cancelled" });
    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-cancel" }),
      { status: "error", code: "lookup-cancelled" },
    );
    assert.equal(ctrl.get("feishuApproval").approverId, "");
    assert.equal(subscriberCalls, 0);
    assert.equal(fs.readFileSync(prefsPath, "utf8"), beforeDisk);
  });

  it("converts lookup transport errors to stable codes without retaining or writing partial state", async () => {
    const prefsPath = makeTempPath();
    const snapshot = prefs.getDefaults();
    prefs.save(prefsPath, snapshot);
    const transportStarted = createDeferred();
    const transportRelease = createDeferred();
    const coordinator = createFeishuApprovalLookupCoordinator({
      createLookupId: () => "lookup-error",
    });
    const lookupDeps = {
      getFeishuApprovalPrefs: () => ctrl.get("feishuApproval"),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 1,
      feishuApprovalLookupCoordinator: coordinator,
      lookupFeishuApproverByEmail: ({ signal }) => {
        transportStarted.resolve(signal);
        return transportRelease.promise;
      },
    };
    const ctrl = createSettingsController({
      prefsPath,
      loadResult: { snapshot, locked: false },
      commands: commandRegistry,
      injectedDeps: lookupDeps,
      concurrentDeps: lookupDeps,
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });
    const beforeDisk = fs.readFileSync(prefsPath, "utf8");

    const lookup = ctrl.applyCommand("feishuApproval.resolveApprover", {
      requestId: "request-error",
      email: "person@example.com",
      hasUnsavedCredentialDrafts: false,
    });
    await transportStarted.promise;
    transportRelease.reject(new Error("raw SDK secret=sensitive-token email=person@example.com"));

    assert.deepEqual(await lookup, { status: "error", code: "lookup-failed" });
    assert.equal(coordinator.inspect().current, null);
    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-error" }),
      { status: "error", code: "lookup-stale" },
    );
    assert.equal(ctrl.get("feishuApproval").approverId, "");
    assert.equal(subscriberCalls, 0);
    assert.equal(fs.readFileSync(prefsPath, "utf8"), beforeDisk);
  });

  it("serializes ordinary Feishu updates behind the Test command", async () => {
    let releaseTest;
    let testStarted;
    const started = new Promise((resolve) => { testStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseTest = resolve; });
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      enabled: true,
      approverId: "ou_saved",
      approverSource: "lookup",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_saved",
    };
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: { snapshot, locked: false },
      injectedDeps: {
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: "feishu",
          appId: "cli_saved",
          appSecret: "saved-secret",
        }),
        sendFeishuApprovalTest: async () => {
          testStarted();
          await blocked;
          return { status: "ok", decision: "deny" };
        },
      },
    });

    const testResult = ctrl.applyCommand("feishuApproval.test", {});
    await started;
    const updateResult = ctrl.applyCommand(
      "feishuApproval.updateConfig",
      { connectionTimeoutSeconds: 30 },
    );
    await Promise.resolve();

    assert.strictEqual(ctrl.get("feishuApproval").connectionTimeoutSeconds, 15);
    releaseTest();
    assert.strictEqual((await testResult).status, "ok");
    assert.strictEqual((await updateResult).status, "ok");
    assert.strictEqual(ctrl.get("feishuApproval").connectionTimeoutSeconds, 30);
  });

  it("makes Test linearize before a queued credential update on one coherent pre-update tuple", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      enabled: true,
      approverId: "ou_saved",
      approverSource: "lookup",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_saved",
    };
    const testStarted = createDeferred();
    const testRelease = createDeferred();
    const credentialStarted = createDeferred();
    const credentialRelease = createDeferred();
    let credentialInvoked = false;
    let savedSecrets = {
      credentialPlatform: "feishu",
      appId: "cli_saved",
      appSecret: "saved-secret",
    };
    let secretsRevision = 1;
    let testArgs;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: { snapshot, locked: false },
      injectedDeps: {
        getFeishuApprovalSecrets: () => savedSecrets,
        getFeishuApprovalSecretsRevision: () => secretsRevision,
        sendFeishuApprovalTest: async (args) => {
          testArgs = args;
          testStarted.resolve();
          await testRelease.promise;
          return { status: "ok", decision: "deny" };
        },
        writeFeishuApprovalSecrets: async (nextSecrets) => {
          credentialInvoked = true;
          credentialStarted.resolve();
          await credentialRelease.promise;
          savedSecrets = { ...nextSecrets };
          secretsRevision = 2;
          return { status: "ok", secretsStored: true };
        },
      },
    });

    const testOperation = ctrl.applyCommand("feishuApproval.test", {});
    await testStarted.promise;
    const credentialOperation = ctrl.applyCommand("feishuApproval.setSecrets", {
      appId: "cli_changed",
      appSecret: "changed-secret",
    });
    await Promise.resolve();
    assert.equal(credentialInvoked, false);
    assert.equal(testArgs.config.approverBoundAppId, "cli_saved");
    assert.equal(testArgs.secrets.appId, "cli_saved");
    assert.equal(testArgs.secretsRevision, 1);

    testRelease.resolve();
    assert.deepEqual(await testOperation, { status: "ok", decision: "deny", message: undefined });
    await credentialStarted.promise;
    credentialRelease.resolve();
    assert.equal((await credentialOperation).status, "ok");
    assert.equal(savedSecrets.appId, "cli_changed");
    assert.equal(secretsRevision, 2);
  });

  it("queues Test behind a credential update and evaluates only the post-update identity", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.feishuApproval = {
      ...snapshot.feishuApproval,
      enabled: true,
      approverId: "ou_saved",
      approverSource: "lookup",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_saved",
    };
    const credentialStarted = createDeferred();
    const credentialRelease = createDeferred();
    let savedSecrets = {
      credentialPlatform: "feishu",
      appId: "cli_saved",
      appSecret: "saved-secret",
    };
    let secretsRevision = 1;
    let testStarted = false;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: { snapshot, locked: false },
      injectedDeps: {
        getFeishuApprovalSecrets: () => savedSecrets,
        getFeishuApprovalSecretsRevision: () => secretsRevision,
        writeFeishuApprovalSecrets: async (nextSecrets) => {
          credentialStarted.resolve();
          await credentialRelease.promise;
          savedSecrets = { ...nextSecrets };
          secretsRevision = 2;
          return { status: "ok", secretsStored: true };
        },
        sendFeishuApprovalTest: async () => {
          testStarted = true;
          return { status: "ok", decision: "deny" };
        },
      },
    });

    const credentialOperation = ctrl.applyCommand("feishuApproval.setSecrets", {
      appId: "cli_changed",
      appSecret: "changed-secret",
    });
    await credentialStarted.promise;
    const testOperation = ctrl.applyCommand("feishuApproval.test", {});
    await Promise.resolve();
    assert.equal(testStarted, false);

    credentialRelease.resolve();
    assert.equal((await credentialOperation).status, "ok");
    assert.deepEqual(await testOperation, { status: "error", code: "approver-app-mismatch" });
    assert.equal(testStarted, false);
    assert.equal(savedSecrets.appId, "cli_changed");
    assert.equal(secretsRevision, 2);
  });

  it("persists a consumed approver exactly once and a later cancel cannot roll it back", async () => {
    const snapshot = prefs.getDefaults();
    const coordinator = createFeishuApprovalLookupCoordinator({ createLookupId: () => "lookup-once" });
    const started = coordinator.begin({
      requestId: "request-once",
      identity: { platform: "feishu", appId: "cli_saved" },
      secretsRevision: 1,
    });
    coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_once" });
    const persistedSnapshots = [];
    const ctrl = createSettingsController({
      prefsPath: "unused-prefs-path",
      prefs: {
        load: () => ({ snapshot, locked: false }),
        save: (_path, nextSnapshot) => { persistedSnapshots.push(nextSnapshot); },
      },
      loadResult: { snapshot, locked: false },
      injectedDeps: {
        feishuApprovalLookupCoordinator: coordinator,
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: "feishu",
          appId: "cli_saved",
          appSecret: "saved-secret",
        }),
        getFeishuApprovalSecretsRevision: () => 1,
      },
      concurrentDeps: {
        feishuApprovalLookupCoordinator: coordinator,
      },
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });

    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-once" }),
      { status: "ok", message: undefined },
    );
    assert.equal(persistedSnapshots.length, 1);
    assert.equal(persistedSnapshots[0].feishuApproval.approverId, "ou_once");
    assert.equal(subscriberCalls, 1);

    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.cancelApproverLookup", { requestId: "request-once" }),
      { status: "ok", code: "lookup-result-consumed", message: undefined },
    );
    assert.deepEqual(
      await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-once" }),
      { status: "error", code: "lookup-result-consumed" },
    );
    assert.equal(persistedSnapshots.length, 1);
    assert.equal(subscriberCalls, 1);
    assert.equal(ctrl.get("feishuApproval").approverId, "ou_once");
  });

  it("keeps the store unchanged and the lookup handle consumed when persistence fails", async () => {
    const snapshot = prefs.getDefaults();
    const coordinator = createFeishuApprovalLookupCoordinator({ createLookupId: () => "lookup-once" });
    const started = coordinator.begin({
      requestId: "renderer-request",
      identity: { platform: "feishu", appId: "cli_saved" },
      secretsRevision: 2,
    });
    coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_resolved" });
    const ctrl = createSettingsController({
      prefsPath: "unused-failing-path",
      prefs: {
        load: () => ({ snapshot, locked: false }),
        save: () => { throw new Error("disk full"); },
      },
      injectedDeps: {
        feishuApprovalLookupCoordinator: coordinator,
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: "feishu",
          appId: "cli_saved",
          appSecret: "saved-secret",
        }),
        getFeishuApprovalSecretsRevision: () => 2,
      },
    });
    let subscriberCalls = 0;
    ctrl.subscribe(() => { subscriberCalls += 1; });

    const first = await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-once" });
    assert.equal(first.status, "error");
    assert.equal(ctrl.get("feishuApproval").approverId, "");
    assert.equal(subscriberCalls, 0);

    const second = await ctrl.applyCommand("feishuApproval.commitApprover", { lookupId: "lookup-once" });
    assert.deepEqual(second, { status: "error", code: "lookup-result-consumed" });
    assert.equal(ctrl.get("feishuApproval").approverId, "");
  });
});

describe("subscribe / subscribeKey", () => {
  it("subscribeKey only fires for matching key changes", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let langCalls = 0;
    let langValue = null;
    ctrl.subscribeKey("lang", (val) => { langCalls++; langValue = val; });
    await ctrl.applyUpdate("soundMuted", true); // unrelated
    assert.strictEqual(langCalls, 0);
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(langCalls, 1);
    assert.strictEqual(langValue, "zh");
  });

  it("multiple subscribers all fire on the same change", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let a = 0, b = 0;
    ctrl.subscribe(() => a++);
    ctrl.subscribe(() => b++);
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
  });

  it("does not death-loop when a subscriber re-reads the snapshot", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let calls = 0;
    ctrl.subscribe(() => {
      calls++;
      // Simulate a "re-save" that would cause a death loop in a naive store
      ctrl.persist();
    });
    await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(calls, 1);
  });
});

describe("object-form entries (validate + effect pre-commit gate)", () => {
  it("runs validate then effect; commits only after both succeed", async () => {
    let effectCalls = 0;
    let lastEffectValue = null;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: (v) => typeof v === "boolean"
            ? { status: "ok" }
            : { status: "error", message: "must be boolean" },
          effect: (v) => {
            effectCalls++;
            lastEffectValue = v;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(effectCalls, 1);
    assert.strictEqual(lastEffectValue, true);
    assert.strictEqual(ctrl.get("gated"), true);
  });

  it("does not run effect when validate fails", async () => {
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "error", message: "nope" }),
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.strictEqual(effectCalls, 0);
    assert.strictEqual(ctrl.get("gated"), undefined);
  });

  it("does not commit when effect fails (store stays clean)", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: () => ({ status: "error", message: "system rejected" }),
        },
      },
    });
    let broadcasts = 0;
    ctrl.subscribe(() => broadcasts++);
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /system rejected/);
    assert.strictEqual(ctrl.get("gated"), undefined);
    assert.strictEqual(broadcasts, 0, "no broadcast on effect failure");
  });

  it("propagates effect throws as { status: error }", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: () => { throw new Error("kaboom"); },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", true);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /kaboom/);
    assert.strictEqual(ctrl.get("gated"), undefined);
  });

  it("supports async effect", async () => {
    let resolved = false;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        gated: {
          validate: () => ({ status: "ok" }),
          effect: async () => {
            await new Promise((r) => setTimeout(r, 1));
            resolved = true;
            return { status: "ok" };
          },
        },
      },
    });
    const r = await ctrl.applyUpdate("gated", "anything");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(resolved, true);
  });

  it("noop short-circuits before validate or effect", async () => {
    let validateCalls = 0;
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        lang: {  // override built-in lang with a tracking gate
          validate: () => { validateCalls++; return { status: "ok" }; },
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    // Default lang is "en"; set to "en" again should noop.
    const r = await ctrl.applyUpdate("lang", "en");
    assert.strictEqual(r.noop, true);
    assert.strictEqual(validateCalls, 0);
    assert.strictEqual(effectCalls, 0);
  });
});

describe("hydrate (system → prefs import, no effect)", () => {
  it("runs validate but skips effect, then commits", async () => {
    let effectCalls = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        sysBacked: {
          validate: (v) => typeof v === "boolean"
            ? { status: "ok" }
            : { status: "error", message: "bad" },
          effect: () => { effectCalls++; return { status: "ok" }; },
        },
      },
    });
    const r = await ctrl.hydrate({ sysBacked: true });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(effectCalls, 0, "effect must not run during hydrate");
    assert.strictEqual(ctrl.get("sysBacked"), true);
  });

  it("rejects partial that fails validate without committing anything", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      updates: {
        a: { validate: () => ({ status: "ok" }), effect: () => ({ status: "ok" }) },
        b: { validate: () => ({ status: "error", message: "bad b" }) },
      },
    });
    const r = await ctrl.hydrate({ a: 1, b: 2 });
    assert.strictEqual(r.status, "error");
    assert.strictEqual(ctrl.get("a"), undefined);
    assert.strictEqual(ctrl.get("b"), undefined);
  });

  it("rejects non-object input", () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = ctrl.hydrate(null);
    assert.strictEqual(r.status, "error");
  });

  it("commits multiple keys atomically with a single broadcast", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    let broadcasts = 0;
    let lastChanges = null;
    ctrl.subscribe(({ changes }) => { broadcasts++; lastChanges = changes; });
    // Use existing pure-data fields (function-form entries) — hydrate must
    // work for both function-form and object-form entries.
    const r = await ctrl.hydrate({ lang: "zh", soundMuted: true });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(broadcasts, 1);
    assert.deepStrictEqual(lastChanges, { lang: "zh", soundMuted: true });
  });

  it("noop when value already matches", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    const r = await ctrl.hydrate({ lang: "en" }); // default
    assert.strictEqual(r.noop, true);
  });
});

describe("locked controller (future-version files)", () => {
  it("applyUpdate still validates and updates store but does not persist", async () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: 999, lang: "en" }));
    const originalWarn = console.warn;
    console.warn = () => {};
    let ctrl;
    try {
      ctrl = createSettingsController({ prefsPath: p });
    } finally {
      console.warn = originalWarn;
    }
    const r = await ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(ctrl.get("lang"), "zh");
    // On-disk file should still have version 999 (not overwritten)
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(onDisk.version, 999);
    assert.strictEqual(onDisk.lang, "en");
  });
});

describe("sessionCleanup.setTriple via applyCommand", () => {
  // This is the regression for v4 — applyCommand must accept a triple that
  // would have been rejected if each key were applied separately via
  // applyUpdate, because lowering both knobs simultaneously would otherwise
  // hit the single-key cross-field validator with the pre-change snapshot.
  it("commits an atomic triple that drops both stale intervals together", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: {
          ...prefs.getDefaults(),
          sessionStaleMs: 600_000,
          workingStaleMs: 300_000,
          detachedIdleStaleMs: 30_000,
        },
        locked: false,
      },
    });
    const result = await ctrl.applyCommand("sessionCleanup.setTriple", {
      sessionStaleMs: 120_000,
      workingStaleMs: 60_000,
      detachedIdleStaleMs: 30_000,
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("sessionStaleMs"), 120_000);
    assert.strictEqual(ctrl.get("workingStaleMs"), 60_000);
    assert.strictEqual(ctrl.get("detachedIdleStaleMs"), 30_000);
  });

  it("rejects an inverted triple without partial commit", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      loadResult: {
        snapshot: { ...prefs.getDefaults() },
        locked: false,
      },
    });
    const result = await ctrl.applyCommand("sessionCleanup.setTriple", {
      sessionStaleMs: 120_000,
      workingStaleMs: 300_000,
      detachedIdleStaleMs: 30_000,
    });
    assert.strictEqual(result.status, "error");
    // Original defaults intact.
    assert.strictEqual(ctrl.get("sessionStaleMs"), 600_000);
    assert.strictEqual(ctrl.get("workingStaleMs"), 300_000);
  });
});
