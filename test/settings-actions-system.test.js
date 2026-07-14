"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const systemActions = require("../src/settings-actions-system");

test("settings system actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(systemActions).sort(), [
    "autoStartWithClaude",
    "createRepairDoctorIssue",
    "installHooks",
    "manageClaudeHooksAutomatically",
    "openAtLogin",
    "repairLocalServer",
    "restartClawd",
    "uninstallHooks",
  ]);
  assert.strictEqual(systemActions.autoStartWithClaude.lockKey, systemActions.manageClaudeHooksAutomatically.lockKey);
  assert.strictEqual(systemActions.installHooks.lockKey, systemActions.uninstallHooks.lockKey);
});

test("settings system actions keep auto-start inert when hook management is disabled", () => {
  const calls = [];
  const result = systemActions.autoStartWithClaude.effect(true, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
    installAutoStart: () => calls.push("install"),
    uninstallAutoStart: () => calls.push("uninstall"),
  });

  assert.deepStrictEqual(result, { status: "ok", noop: true });
  assert.deepStrictEqual(calls, []);
});

test("settings system actions await the auto-start queue Promise before reporting success", async () => {
  const calls = [];
  const result = await systemActions.autoStartWithClaude.effect(true, {
    snapshot: prefs.getDefaults(),
    installAutoStart: async () => {
      calls.push("install");
      return { status: "ok", enabled: true };
    },
    uninstallAutoStart: () => calls.push("uninstall"),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, ["install"]);
});

test("settings system actions do not report auto-start success when the queue resolves an error", async () => {
  const result = await systemActions.autoStartWithClaude.effect(false, {
    snapshot: prefs.getDefaults(),
    installAutoStart: () => {
      throw new Error("should not run");
    },
    uninstallAutoStart: async () => ({ status: "error", message: "queue disposed" }),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /queue disposed/);
});

test("settings system actions sync hooks before starting the watcher", async () => {
  const calls = [];
  const result = await systemActions.manageClaudeHooksAutomatically.effect(true, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => {
      calls.push("sync");
    },
    startClaudeSettingsWatcher: () => calls.push("start"),
    stopClaudeSettingsWatcher: () => calls.push("stop"),
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, ["sync", "start"]);
});

test("settings system actions do not start the watcher when the queued Claude sync resolves an error", async () => {
  const calls = [];
  const result = await systemActions.manageClaudeHooksAutomatically.effect(true, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => ({ status: "error", message: "write failed" }),
    startClaudeSettingsWatcher: () => calls.push("start"),
    stopClaudeSettingsWatcher: () => calls.push("stop"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /write failed/);
  assert.deepStrictEqual(calls, []);
});

test("settings system actions report installHooks failure when the queue resolves an error, without throwing", async () => {
  const result = await systemActions.installHooks(null, {
    syncClaudeHooksNow: async () => ({ status: "error", message: "disposed" }),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /disposed/);
});

test("settings system actions restore the watcher when uninstallHooks resolves a queue error", async () => {
  const calls = [];
  const result = await systemActions.uninstallHooks(null, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    stopClaudeSettingsWatcher: () => calls.push("stop"),
    uninstallClaudeHooksNow: async () => {
      calls.push("uninstall");
      return { status: "error", message: "queue disposed" };
    },
    startClaudeSettingsWatcher: () => calls.push("start"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /queue disposed/);
  assert.deepStrictEqual(calls, ["stop", "uninstall", "start"]);
});

test("settings system actions restore the watcher when hook uninstall fails", async () => {
  const calls = [];
  const result = await systemActions.uninstallHooks(null, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    stopClaudeSettingsWatcher: () => calls.push("stop"),
    uninstallClaudeHooksNow: async () => {
      calls.push("uninstall");
      throw new Error("locked");
    },
    startClaudeSettingsWatcher: () => calls.push("start"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /locked/);
  assert.deepStrictEqual(calls, ["stop", "uninstall", "start"]);
});

test("settings system actions route Doctor repairs through injected cross-module actions", async () => {
  const calls = [];
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({
    repairAgentIntegration: async (payload, deps) => {
      calls.push({ kind: "agent", payload, deps });
      return { status: "ok", message: "agent repaired" };
    },
    setBubbleCategoryEnabled: (payload, deps) => {
      calls.push({ kind: "bubble", payload, deps });
      return { status: "ok", commit: { permissionBubblesEnabled: true } };
    },
  });
  const deps = { snapshot: prefs.getDefaults() };

  const agentResult = await repairDoctorIssue({ type: "agent-integration", agentId: "codex" }, deps);
  const bubbleResult = await repairDoctorIssue({ type: "permission-bubble-policy" }, deps);

  assert.deepStrictEqual(agentResult, { status: "ok", message: "agent repaired" });
  assert.deepStrictEqual(bubbleResult, {
    status: "ok",
    commit: { permissionBubblesEnabled: true },
  });
  assert.strictEqual(calls[0].kind, "agent");
  assert.strictEqual(calls[0].payload.agentId, "codex");
  assert.strictEqual(calls[0].deps, deps);
  assert.deepStrictEqual(calls[1], {
    kind: "bubble",
    payload: { category: "permission", enabled: true },
    deps,
  });
});

test("settings system actions normalize local server repair failures", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => false,
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /Local server repair failed/);
});

test("settings system actions require restart confirmation", () => {
  const calls = [];
  const result = systemActions.restartClawd({}, {
    restartClawd: () => calls.push("restart"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /confirmation/);
  assert.deepStrictEqual(calls, []);
});
