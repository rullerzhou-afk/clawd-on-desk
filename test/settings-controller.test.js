"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
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
    assert.strictEqual(ctrl.hasReadFailure(), false);
  });

  it("respects locked state from future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, JSON.stringify({ version: 999 }));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const ctrl = createSettingsController({ prefsPath: p });
      assert.strictEqual(ctrl.isLocked(), true);
      assert.strictEqual(ctrl.hasReadFailure(), false);
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

describe("mobile permission preview controller boundary", () => {
  it("rejects generic writers for the consent-only child key", async () => {
    const ctrl = createSettingsController({ prefsPath: makeTempPath() });
    assert.strictEqual(ctrl.applyUpdate("mobilePermissionPreviewEnabled", true).status, "error");
    assert.strictEqual(ctrl.applyBulk({ mobilePermissionPreviewEnabled: true }).status, "error");
    assert.strictEqual(ctrl.hydrate({ mobilePermissionPreviewEnabled: true }).status, "error");
  });

  it("serializes reset-and-enable so a double click rotates at most once", async () => {
    let resets = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      injectedDeps: {
        resetMobileAccess: () => { resets++; return `token-${resets}`; },
      },
    });
    assert.deepStrictEqual(ctrl.applyUpdate("mobilePreviewEnabled", true), { status: "ok" });
    const payload = { enabled: true, confirmed: true, resetAccess: true };
    const [first, second] = await Promise.all([
      ctrl.applyCommand("setMobilePermissionPreviewEnabled", payload),
      ctrl.applyCommand("setMobilePermissionPreviewEnabled", payload),
    ]);
    assert.strictEqual(first.status, "ok");
    assert.strictEqual(first.tokenReset, true);
    assert.deepStrictEqual(second, { status: "ok", noop: true, message: undefined });
    assert.strictEqual(resets, 1);
  });

  it("preserves reset phase metadata when the later preference persist fails", async () => {
    const fakePrefs = {
      save() { throw new Error("disk full"); },
    };
    const snapshot = { ...prefs.getDefaults(), mobilePreviewEnabled: true };
    let resets = 0;
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      prefs: fakePrefs,
      loadResult: { snapshot, locked: false },
      injectedDeps: { resetMobileAccess: () => { resets++; return "new-token"; } },
    });
    const result = await ctrl.applyCommand("setMobilePermissionPreviewEnabled", {
      enabled: true,
      confirmed: true,
      resetAccess: true,
    });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "disk full");
    assert.strictEqual(result.tokenReset, true);
    assert.strictEqual(result.rePairRequired, true);
    assert.strictEqual(ctrl.get("mobilePermissionPreviewEnabled"), false);
    assert.strictEqual(resets, 1);
  });
});

describe("Kimi quota collection opt-in", () => {
  it("persists only through its command path", async () => {
    const prefsPath = makeTempPath();
    const ctrl = createSettingsController({ prefsPath });
    const enabled = await ctrl.applyCommand("setKimiQuotaCollectionEnabled", { enabled: true });
    assert.strictEqual(enabled.status, "ok");
    assert.strictEqual(ctrl.get("kimiQuotaCollectionEnabled"), true);
    const relaunched = createSettingsController({ prefsPath });
    assert.strictEqual(relaunched.get("kimiQuotaCollectionEnabled"), true);
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
      ctrl.applyUpdate("kimiQuotaCollectionEnabled", true),
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
    assert.strictEqual(ctrl.get("kimiQuotaCollectionEnabled"), false);
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

  it("preserves irreversible phase metadata when defensive validation fails", async () => {
    const ctrl = createSettingsController({
      prefsPath: makeTempPath(),
      commands: {
        invalidAfterTokenReset: () => ({
          status: "ok",
          tokenReset: true,
          rePairRequired: true,
          commit: { lang: "klingon" },
        }),
      },
    });
    const result = await ctrl.applyCommand("invalidAfterTokenReset", {});
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.tokenReset, true);
    assert.strictEqual(result.rePairRequired, true);
    assert.match(result.message, /klingon|lang/);
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

describe("Feishu resolved-approver commit linearization", () => {
  function createFixture({ failPersistence = false } = {}) {
    const entered = createDeferred();
    const release = createDeferred();
    const saves = [];
    let subscriberCalls = 0;
    let secretsRevision = 1;
    let secrets = {
      credentialPlatform: "feishu",
      appId: "cli_saved",
      appSecret: "saved-secret",
    };
    const gate = async () => {
      entered.resolve();
      await release.promise;
      return { status: "ok" };
    };
    gate.lockKey = "feishuApproval";
    const ctrl = createSettingsController({
      prefsPath: "in-memory-settings",
      prefs: {
        load: () => ({
          snapshot: {
            ...prefs.getDefaults(),
            feishuApproval: {
              ...prefs.getDefaults().feishuApproval,
              platform: "feishu",
            },
          },
          locked: false,
        }),
        save: (_path, snapshot) => {
          if (failPersistence) throw new Error("synthetic disk failure");
          saves.push(snapshot);
        },
      },
      commands: { ...commandRegistry, gate },
      injectedDeps: {
        getFeishuApprovalSecrets: () => ({ ...secrets }),
        getFeishuApprovalSecretsRevision: () => secretsRevision,
        writeFeishuApprovalSecrets: (next) => {
          secrets = { ...next };
          secretsRevision += 1;
          return { status: "ok", secretsStored: true };
        },
      },
    });
    ctrl.subscribe(() => { subscriberCalls += 1; });
    return {
      ctrl,
      entered,
      release,
      saves,
      subscriberCalls: () => subscriberCalls,
      commitPayload: (signal) => ({
        signal,
        approverId: "ou_resolved",
        platform: "feishu",
        appId: "cli_saved",
        secretsRevision: 1,
      }),
    };
  }

  for (const [label, patch, field, expected] of [
    ["enabled", { enabled: true }, "enabled", true],
    ["timeout", { connectionTimeoutSeconds: 30 }, "connectionTimeoutSeconds", 30],
  ]) {
    for (const order of ["patch-first", "commit-first"]) {
      it(`preserves ${label} when ${order} under the Feishu lock`, async () => {
        const fixture = createFixture();
        const signal = new AbortController().signal;
        const gate = fixture.ctrl.applyCommand("gate");
        await fixture.entered.promise;
        const operations = order === "patch-first"
          ? [
              fixture.ctrl.applyCommand("feishuApproval.updateConfig", patch),
              fixture.ctrl.applyCommand("feishuApproval.commitResolvedApprover", fixture.commitPayload(signal)),
            ]
          : [
              fixture.ctrl.applyCommand("feishuApproval.commitResolvedApprover", fixture.commitPayload(signal)),
              fixture.ctrl.applyCommand("feishuApproval.updateConfig", patch),
            ];
        fixture.release.resolve();
        await gate;
        const results = await Promise.all(operations);
        assert.equal(results.every((result) => result.status === "ok"), true);
        assert.equal(fixture.ctrl.get("feishuApproval")[field], expected);
        assert.equal(fixture.ctrl.get("feishuApproval").approverId, "ou_resolved");
      });
    }
  }

  it("rejects a commit cancelled while it waits for the Feishu lock", async () => {
    const fixture = createFixture();
    const abort = new AbortController();
    const gate = fixture.ctrl.applyCommand("gate");
    await fixture.entered.promise;
    const commit = fixture.ctrl.applyCommand(
      "feishuApproval.commitResolvedApprover",
      fixture.commitPayload(abort.signal),
    );
    abort.abort();
    fixture.release.resolve();
    await gate;

    assert.deepStrictEqual(await commit, { status: "error", code: "lookup-cancelled" });
    assert.equal(fixture.ctrl.get("feishuApproval").approverId, "");
    assert.equal(fixture.saves.length, 0);
    assert.equal(fixture.subscriberCalls(), 0);
  });

  it("rejects a queued commit after saved credentials change", async () => {
    const fixture = createFixture();
    const signal = new AbortController().signal;
    const gate = fixture.ctrl.applyCommand("gate");
    await fixture.entered.promise;
    const credentials = fixture.ctrl.applyCommand("feishuApproval.setSecrets", {
      appId: "cli_replaced",
      appSecret: "replacement-secret",
      confirmReplace: true,
    });
    const commit = fixture.ctrl.applyCommand(
      "feishuApproval.commitResolvedApprover",
      fixture.commitPayload(signal),
    );
    fixture.release.resolve();
    await gate;

    assert.equal((await credentials).status, "ok");
    assert.deepStrictEqual(await commit, { status: "error", code: "lookup-credentials-changed" });
    assert.equal(fixture.ctrl.get("feishuApproval").approverId, "");
  });

  it("does not publish a successful commit when persistence fails", async () => {
    const fixture = createFixture({ failPersistence: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await fixture.ctrl.applyCommand(
        "feishuApproval.commitResolvedApprover",
        fixture.commitPayload(new AbortController().signal),
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.status, "error");
    assert.equal(fixture.ctrl.get("feishuApproval").approverId, "");
    assert.equal(fixture.subscriberCalls(), 0);
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

describe("unreadable prefs safe mode", () => {
  function createControllerWithReadFailure(p, injectedDeps = {}) {
    const originalReadFileSync = fs.readFileSync;
    const originalWarn = console.warn;
    fs.readFileSync = (target, ...args) => {
      if (target === p) {
        const err = new Error("injected prefs read failure");
        err.code = "EACCES";
        throw err;
      }
      return originalReadFileSync(target, ...args);
    };
    console.warn = () => {};
    try {
      return createSettingsController({ prefsPath: p, injectedDeps });
    } finally {
      fs.readFileSync = originalReadFileSync;
      console.warn = originalWarn;
    }
  }

  it("blocks updates and commands before any external effect on every platform", async () => {
    const p = makeTempPath();
    const original = JSON.stringify({
      version: prefs.CURRENT_VERSION,
      lang: "en",
      agents: {
        "qwen-code": {
          integrationInstalled: false,
          enabled: false,
        },
      },
    });
    fs.writeFileSync(p, original, "utf8");

    const calls = [];
    const ctrl = createControllerWithReadFailure(p, {
      setOpenAtLogin: (enabled) => calls.push(["openAtLogin", enabled]),
      syncIntegrationForAgent: async (agentId) => {
        calls.push(["sync", agentId]);
        return { status: "ok" };
      },
      startMonitorForAgent: (agentId) => calls.push(["monitor", agentId]),
    });

    assert.strictEqual(ctrl.isLocked(), true);
    assert.strictEqual(ctrl.hasReadFailure(), true);

    const pureUpdate = ctrl.applyUpdate("lang", "zh");
    assert.strictEqual(pureUpdate.status, "error");
    assert.strictEqual(pureUpdate.code, "prefs-read-failure");

    const effectUpdate = ctrl.applyUpdate("openAtLogin", true);
    assert.strictEqual(effectUpdate.status, "error");
    assert.strictEqual(effectUpdate.code, "prefs-read-failure");

    const bulk = ctrl.applyBulk({ soundMuted: true, showTray: false });
    assert.strictEqual(bulk.status, "error");
    assert.strictEqual(bulk.code, "prefs-read-failure");

    const command = await ctrl.applyCommand("installAgentIntegration", {
      agentId: "qwen-code",
    });
    assert.strictEqual(command.status, "error");
    assert.strictEqual(command.code, "prefs-read-failure");

    assert.deepStrictEqual(calls, [], "safe mode must stop external effects before they start");
    assert.strictEqual(ctrl.get("lang"), "en");
    assert.strictEqual(ctrl.get("openAtLogin"), false);
    assert.strictEqual(ctrl.get("agents")["qwen-code"].integrationInstalled, false);
    assert.strictEqual(fs.readFileSync(p, "utf8"), original);
  });

  it("allows side-effect-free startup hydration without making prefs writable", () => {
    const p = makeTempPath();
    const original = JSON.stringify({ version: prefs.CURRENT_VERSION, lang: "en" });
    fs.writeFileSync(p, original, "utf8");
    const ctrl = createControllerWithReadFailure(p);

    const result = ctrl.hydrate({
      openAtLogin: true,
      openAtLoginHydrated: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(ctrl.get("openAtLogin"), true);
    assert.strictEqual(ctrl.get("openAtLoginHydrated"), true);
    assert.deepStrictEqual(ctrl.persist(), {
      status: "ok",
      noop: true,
      locked: true,
      readFailure: true,
    });
    assert.strictEqual(fs.readFileSync(p, "utf8"), original);
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
