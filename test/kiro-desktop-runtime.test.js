"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createAgentRuntime = require("../src/agent-runtime-main");
const themeLoader = require("../src/theme-loader");
const { resolveSessionIdentity } = require("../src/session-key");
const prefs = require("../src/prefs");
const actions = require("../src/settings-actions-agents");
const { RECORD_TYPES: T } = require("../agents/kiro-desktop-log-monitor");
const { MAX_PENDING_AGE_MS } = require("../src/kiro-desktop-interactions");

// Compose the real state owner with isolated monitor and card substitutes.
function harness(t, contextOverrides = {}, stateOverrides = {}) {
  const instances = [];
  const cards = new Map();
  const pendingPermissions = [];
  const context = { isAgentEnabled: () => true, isAgentPermissionsEnabled: () => true, ...contextOverrides };
  class Monitor {
    constructor(options) {
      this.emit = options.onRecord;
      this.started = 0;
      instances.push(this);
    }
    start() {
      this.started++;
    }
    stop() {
      this.stopped = true;
    }
  }
  const permission = {
    showKiroDesktopReminder(info) {
      cards.set(info.sessionId, info);
      if (!pendingPermissions.some(entry => entry.sessionId === info.sessionId)) {
        pendingPermissions.push({ agentId: "kiro-desktop", sessionId: info.sessionId, isKiroDesktopNotify: true });
      }
      return true;
    },
    removeKiroDesktopReminder(id, reason) {
      const entry = cards.get(id);
      cards.delete(id);
      const index = pendingPermissions.findIndex(entry => entry.sessionId === id);
      if (index >= 0) pendingPermissions.splice(index, 1);
      entry?.onDismiss({ kiroInteractionKey: entry.interactionKey }, reason);
    },
  };
  themeLoader.init(path.resolve(__dirname, "../src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = {};
  theme.timings.autoReturn = {};
  let runtime;
  const noop = () => {};
  const ctx = {
    lang: "en",
    theme,
    pendingPermissions,
    get doNotDisturb() {
      return context.doNotDisturb === true;
    },
    set doNotDisturb(value) {
      context.doNotDisturb = value;
    },
    sendToRenderer: noop, syncHitWin: noop, sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop,
    playSound: noop, buildContextMenu: noop, buildTrayMenu: noop, broadcastSessionSnapshot: noop,
    focusTerminalWindow: noop, resolvePermissionEntry: noop,
    dismissPermissionsForDnd: () => runtime?.clearKiroDesktopReminderCards("dnd"),
    resyncKiroDesktopReminderCards: () => runtime?.resyncKiroDesktopReminderCards(),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), t: key => key, processKill: () => true,
    getKiroDesktopPendingSessionIds: () => runtime?.getKiroDesktopPendingSessionIds() || new Set(),
    onSessionDeleted: id => runtime?.clearKiroDesktopSession(id),
    ...stateOverrides,
  };
  const state = require("../src/state")(ctx);
  runtime = createAgentRuntime({
    getStateRuntime: () => state,
    getPermissionRuntime: () => permission,
    getKiroDesktopReminderContext: () => context,
    loadKiroDesktopMonitor: () => Monitor,
    updateSession: (...args) => state.updateSession(...args),
  });
  t.after(() => {
    runtime.cleanup();
    state.cleanup();
  });
  const sessionId = resolveSessionIdentity("sess_one", "local").sessionId;
  const hook = event => runtime.updateSessionFromServer(sessionId, "working", event, {
    agentId: "kiro-desktop",
    rawSessionId: "sess_one",
    profileId: "local",
    sourcePid: 42,
    agentPid: 42,
    cwd: "/repo",
  });
  const emit = (type = T.PENDING, extra = {}) => instances.at(-1).emit({
    type,
    sessionId: "sess_one",
    executionId: "e",
    toolCallId: "t",
    consentRound: 1,
    interactionType: "tool_approval",
    question: "Confirm?",
    ...extra,
  });
  const snapshot = () => state.buildSessionSnapshot().sessions.find(session => session.id === sessionId);
  runtime.startMonitorForAgent("kiro-desktop", { integrationInstalled: true });
  return { runtime, state, cards, permission, context, instances, sessionId, hook, emit, snapshot, ctx };
}

test("kiro-desktop: canonical hook and monitor identity share one session and preserve PID", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  assert.equal(h.state.sessions.size, 1);
  assert.equal(h.state.sessions.get(h.sessionId).sourcePid, 42);
  assert.deepEqual([...h.runtime.getKiroDesktopPendingSessionIds()], [h.sessionId]);
  assert.equal(h.cards.has(h.sessionId), true);
  assert.equal(h.cards.has("sess_one"), false);
  h.emit(T.RESOLVED);
  assert.equal(h.cards.size, 0);
  assert.equal(h.state.sessions.size, 1);
});

for (const reminders of [true, false]) {
  test(`kiro-desktop: pending projection preserves working and restores it with reminders ${reminders}`, t => {
    const h = harness(t, { isAgentPermissionsEnabled: () => reminders });
    h.hook("PreToolUse");
    h.emit();
    assert.equal(h.state.sessions.get(h.sessionId).state, "working");
    assert.equal(h.snapshot().pendingAttention, true);
    assert.equal(h.state.resolveDisplayState(), "notification");
    assert.equal(h.state.getCurrentState(), "notification");
    assert.equal(h.cards.size, reminders ? 1 : 0);
    h.emit(T.RESOLVED);
    assert.equal(h.snapshot().pendingAttention, false);
    assert.equal(h.state.sessions.get(h.sessionId).state, "working");
    assert.equal(h.state.resolveDisplayState(), "working");
    assert.equal(h.state.getCurrentState(), "working");
  });
}

test("kiro-desktop: multiple pending interactions update the single card until all resolve", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  h.emit(T.PENDING, { consentRound: 2, question: "Again?" });
  assert.equal(h.cards.size, 1);
  assert.equal(h.cards.get(h.sessionId).question, "Again?");
  h.emit(T.RESOLVED, { consentRound: 2 });
  assert.equal(h.cards.get(h.sessionId).question, "Confirm?");
  h.emit(T.RESOLVED, { executionId: "old" });
  assert.equal(h.cards.size, 1);
  h.emit(T.RESOLVED);
  assert.equal(h.cards.size, 0);
});

test("kiro-desktop: dismissed card keeps pending attention and only a new key can reopen it", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  h.permission.removeKiroDesktopReminder(h.sessionId, "ipc-decide");
  assert.equal(h.cards.size, 0);
  assert.equal(h.snapshot().pendingAttention, true);
  h.emit();
  assert.equal(h.cards.size, 0);
  h.emit(T.PENDING, { consentRound: 2 });
  assert.equal(h.cards.size, 1);
  h.emit(T.RESOLVED, { consentRound: 2 });
  assert.equal(h.cards.size, 0);
  h.emit(T.RESOLVED);
  assert.equal(h.snapshot().pendingAttention, false);
});

for (const override of [
  { doNotDisturb: true },
  { notificationBubbleAutoCloseSeconds: 0 },
  { hideBubbles: true },
  { permissionBubblesEnabled: false },
  { isAgentPermissionsEnabled: () => false },
  { isAgentEnabled: () => false },
]) {
  test(`kiro-desktop: suppression clears cards while retaining the ledger ${Object.keys(override)[0]}`, t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    Object.assign(h.context, override);
    h.emit(T.PENDING, { consentRound: 2 });
    assert.equal(h.cards.size, 0);
    assert.equal(h.snapshot().pendingAttention, true);
    h.runtime.stopMonitorForAgent("kiro-desktop");
    assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, 0);
    h.instances[0].emit({ type: T.PENDING, sessionId: "sess_one" });
    assert.equal(h.cards.size, 0);
  });
}

test("kiro-desktop: stop generations ignore old callbacks even after restart", t => {
  const h = harness(t), old = h.instances[0];
  h.hook("PreToolUse");
  h.emit();
  h.runtime.stopMonitorForAgent("kiro-desktop");
  assert.equal(h.cards.size, 0);
  h.runtime.startMonitorForAgent("kiro-desktop", { integrationInstalled: true });
  old.emit({ type: T.PENDING, sessionId: "sess_one" });
  assert.equal(h.cards.size, 0);
  h.emit();
  assert.equal(h.cards.size, 1);
});

test("kiro-desktop: pending without a hook can show a card without creating a session", t => {
  const h = harness(t);
  h.emit();
  assert.equal(h.cards.size, 1);
  assert.equal(h.state.sessions.size, 0);
  assert.equal(h.state.resolveDisplayState(), "idle");
});

for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
  test(`kiro-desktop: hook boundary ${event} cleans the ledger at the canonical entry`, t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    h.hook(event);
    assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, event === "PostToolUse" ? 1 : 0);
  });
}

for (const boundarySource of ["observed", "recovered"]) {
  test(`kiro-desktop: ${boundarySource} turn end clears only its execution without changing working`, t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    h.emit(T.PENDING, { executionId: "new", question: "New execution" });
    h.emit(T.TURN_END, { stopReason: "cancelled", boundarySource });
    assert.equal(h.cards.size, 1);
    assert.equal(h.cards.get(h.sessionId).executionId, "new");
    assert.equal(h.state.sessions.get(h.sessionId).state, "working");
    h.emit(T.RESOLVED, { executionId: "new" });
    assert.equal(h.cards.size, 0);
  });
}

for (const type of [T.REBASELINE, T.UNTRACKED]) {
  test(`kiro-desktop: ${type} clears pending and card`, t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    h.emit(type);
    assert.equal(h.cards.size, 0);
    assert.equal(h.snapshot().pendingAttention, false);
  });
}

test("kiro-desktop: Settings install and enable carry installation intent into monitor start", async t => {
  const h = harness(t);
  h.runtime.stopMonitorForAgent("kiro-desktop");
  const snapshot = prefs.getDefaults();
  const starts = [];
  const deps = { snapshot, syncIntegrationForAgent: () => ({ status: "ok" }),
    startMonitorForAgent(id, intent) {
      starts.push([id, intent]);
      h.runtime.startMonitorForAgent(id, intent);
    } };
  const result = await actions.installAgentIntegration({ agentId: "kiro-desktop" }, deps);
  assert.equal(result.status, "ok");
  assert.deepEqual(starts.at(-1), ["kiro-desktop", { integrationInstalled: true }]);
  assert.equal(h.instances.length, 2);
  h.runtime.stopMonitorForAgent("kiro-desktop");
  actions.setAgentFlag({ agentId: "kiro-desktop", flag: "enabled", value: true }, deps);
  assert.equal(h.instances.length, 2, "enabled without installation must not start");
  snapshot.agents["kiro-desktop"].integrationInstalled = true;
  actions.setAgentFlag({ agentId: "kiro-desktop", flag: "enabled", value: true }, deps);
  assert.equal(h.instances.length, 3);
  h.runtime.stopMonitorForAgent("kiro-desktop");
  starts.length = 0;
  const failed = await actions.installAgentIntegration({ agentId: "kiro-desktop" }, {
    ...deps,
    syncIntegrationForAgent: () => ({ status: "error" }),
  });
  assert.equal(failed.status, "error");
  assert.equal(starts.length, 0);
});

for (const action of ["disable", "uninstall"]) {
  test(`kiro-desktop: Settings ${action} clears the ledger, scoped card and old callbacks`, async t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    const snapshot = prefs.getDefaults();
    Object.assign(snapshot.agents["kiro-desktop"], { enabled: true, integrationInstalled: true });
    const deps = { snapshot, stopMonitorForAgent: id => h.runtime.stopMonitorForAgent(id),
      clearSessionsByAgent: id => h.state.clearSessionsByAgent(id),
      dismissPermissionsByAgent() {}, uninstallIntegrationForAgent: () => ({ registrationRemoved: true }) };
    const result = action === "disable"
    ? actions.setAgentFlag({ agentId: "kiro-desktop", flag: "enabled", value: false }, deps)
    : await actions.uninstallAgentIntegration({ agentId: "kiro-desktop" }, deps);
    assert.equal(result.status, "ok");
    assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, 0);
    assert.equal(h.cards.size, 0);
    assert.equal(h.state.sessions.size, 0);
    h.emit();
    assert.equal(h.cards.size, 0);
  });
}

test("kiro-desktop: reminder switch removes only its scoped card and keeps pending projection", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  const snapshot = prefs.getDefaults();
  Object.assign(snapshot.agents["kiro-desktop"], { enabled: true, integrationInstalled: true });
  actions.setAgentFlag({ agentId: "kiro-desktop", flag: "permissionsEnabled", value: false }, { snapshot,
    dismissPermissionsByAgent(id) {
      assert.equal(id, "kiro-desktop");
      h.permission.removeKiroDesktopReminder(h.sessionId, "disabled");
    },
  });
  assert.equal(h.cards.size, 0);
  assert.equal(h.snapshot().pendingAttention, true);
});

test("kiro-desktop: application startup and Settings forwarding retain explicit installed gate", () => {
  const fs = require("node:fs");
  const main = fs.readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8");
  assert.match(
    main,
    /isAgentEnabled\("kiro-desktop"\) && _runtimeAgentGate\.isAgentIntegrationInstalled\("kiro-desktop"\)/,
  );
  assert.match(
    main,
    /startMonitorForAgent: \(id, intent\) => agentRuntime && agentRuntime\.startMonitorForAgent\(id, intent\)/,
  );
});

test("kiro-desktop: late execution boundary cannot idle work waiting on another execution", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit(T.PENDING, { executionId: "current" });
  h.emit(T.TURN_END, { executionId: "old", boundarySource: "observed", stopReason: "cancelled" });
  assert.equal(h.state.sessions.get(h.sessionId).state, "working");
  assert.equal(h.cards.size, 1);
  h.emit(T.RESOLVED, { executionId: "current" });
  assert.equal(h.state.resolveDisplayState(), "working");
});


test("kiro-desktop: pending approval survives working timeout and resolves back to working", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  t.mock.timers.tick(300001);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.get(h.sessionId).state, "working");
  h.emit(T.RESOLVED);
  assert.equal(h.state.resolveDisplayState(), "working");
  assert.equal(h.snapshot().pendingAttention, false);
});

test("kiro-desktop: pending approval survives both working and idle age windows", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  t.mock.timers.tick(300001);
  h.state.cleanStaleSessions();
  t.mock.timers.tick(600001);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.size, 1);
  assert.equal(h.state.sessions.get(h.sessionId).state, "working");
  assert.equal(h.runtime.getKiroDesktopPendingSessionIds().has(h.sessionId), true);
  assert.equal(h.cards.size, 1);
  assert.equal(h.state.resolveDisplayState(), "notification");
  h.state.sessions.get(h.sessionId).state = "idle";
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.size, 1);
  h.emit(T.RESOLVED);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.size, 0);
});

test("kiro-desktop: pending approval still retires when the IDE process exits", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let alive = true;
  const h = harness(t, {}, {
    processKill() {
      if (!alive) {
        const error = new Error("process exited");
        error.code = "ESRCH";
        throw error;
      }
    },
  });
  const deletionReasons = [];
  const onDeleted = h.ctx.onSessionDeleted;
  h.ctx.onSessionDeleted = (id, reason) => {
    deletionReasons.push(reason);
    onDeleted(id);
  };
  h.hook("PreToolUse");
  h.emit();
  t.mock.timers.tick(900002);
  alive = false;
  h.state.cleanStaleSessions();
  assert.equal(deletionReasons[0], "stale-delete-agent-exit");
  assert.equal(h.state.sessions.size, 0);
  assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, 0);
  assert.equal(h.cards.size, 0);
});

test("kiro-desktop: late cancelled execution cannot reset a new hook turn without pending", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  h.hook("UserPromptSubmit");
  h.hook("PreToolUse");
  h.emit(T.TURN_END, { executionId: "e", boundarySource: "observed", stopReason: "cancelled" });
  assert.equal(h.state.sessions.get(h.sessionId).state, "working");
  assert.equal(h.state.resolveDisplayState(), "working");
});

for (const dismissed of [false, true]) {
  test(`kiro-desktop: DND restoration respects manual dismissal ${dismissed}`, t => {
    const h = harness(t);
    h.hook("PreToolUse");
    h.emit();
    if (dismissed) h.permission.removeKiroDesktopReminder(h.sessionId, "ipc-decide");
    h.state.enableDoNotDisturb();
    assert.equal(h.cards.size, 0);
    assert.equal(h.runtime.getKiroDesktopPendingSessionIds().has(h.sessionId), true);
    h.state.disableDoNotDisturb();
    assert.equal(h.cards.size, dismissed ? 0 : 1);
  });
}

test("kiro-desktop: native focus dismissal stays closed when reminder cards resync", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  h.permission.removeKiroDesktopReminder(h.sessionId, "ipc-decide");
  h.runtime.resyncKiroDesktopReminderCards();
  assert.equal(h.cards.size, 0);
  assert.equal(h.snapshot().pendingAttention, true);
});

test("kiro-desktop: resolving dismissed newest pending reveals an undismissed older one", t => {
  const h = harness(t);
  h.hook("PreToolUse");
  h.emit();
  h.emit(T.PENDING, { consentRound: 2, question: "Second" });
  h.permission.removeKiroDesktopReminder(h.sessionId, "ipc-decide");
  h.emit(T.RESOLVED, { consentRound: 2 });
  assert.equal(h.cards.size, 1);
  assert.equal(h.cards.get(h.sessionId).question, "Confirm?");
});

// Drive actual settings commits so policy readers see the committed gates.
function settingsHarness(t, h) {
  const { createSettingsController } = require("../src/settings-controller");
  const createRouter = require("../src/settings-effect-router");
  const snapshot = prefs.getDefaults();
  Object.assign(snapshot.agents["kiro-desktop"], {
    enabled: true,
    integrationInstalled: true,
  });
  const controller = createSettingsController({
    loadResult: { snapshot, locked: false },
    injectedDeps: {
      dismissPermissionsByAgent() {
        h.permission.removeKiroDesktopReminder(h.sessionId, "permissions-disabled");
      },
    },
  });
  h.context.isAgentPermissionsEnabled = id => controller.getSnapshot().agents[id].permissionsEnabled;
  const router = createRouter({
    settingsController: controller,
    updateMirrors: changes => Object.assign(h.context, changes),
    clearKiroDesktopReminderCards: reason => h.runtime.clearKiroDesktopReminderCards(reason),
    resyncKiroDesktopReminderCards: () => h.runtime.resyncKiroDesktopReminderCards(),
  });
  router.start();
  t.after(() => router.dispose());
  return controller;
}

for (const [key, off, on] of [
  ["notificationBubbleAutoCloseSeconds", 0, 6],
  ["permissionBubblesEnabled", false, true],
  ["hideBubbles", true, false],
]) {
  test(`kiro-desktop: committed ${key} restoration reopens the pending card`, async t => {
    const h = harness(t);
    const controller = settingsHarness(t, h);
    h.hook("PreToolUse");
    h.emit();
    await controller.applyUpdate(key, off);
    assert.equal(h.cards.size, 0);
    assert.equal(h.snapshot().pendingAttention, true);
    await controller.applyUpdate(key, on);
    assert.equal(h.cards.size, 1);
  });
}

test("kiro-desktop: committed reminder switch restoration reopens without a new pending record", async t => {
  const h = harness(t);
  const controller = settingsHarness(t, h);
  h.hook("PreToolUse");
  h.emit();
  await controller.applyCommand("setAgentFlag", {
    agentId: "kiro-desktop", flag: "permissionsEnabled", value: false,
  });
  assert.equal(h.cards.size, 0);
  assert.equal(h.snapshot().pendingAttention, true);
  await controller.applyCommand("setAgentFlag", {
    agentId: "kiro-desktop", flag: "permissionsEnabled", value: true,
  });
  assert.equal(h.cards.size, 1);
});


test("kiro-desktop: stale sweep expires a day-old pending without hooks and resumes ordinary cleanup", t => {
  const startedAt = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: startedAt });
  const h = harness(t);
  h.hook("PreToolUse");
  const session = h.state.sessions.get(h.sessionId);
  session.agentPid = null;
  session.sourcePid = null;
  session.pidReachable = false;
  h.emit();
  t.mock.timers.setTime(startedAt + MAX_PENDING_AGE_MS);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.get(h.sessionId).state, "working");
  assert.equal(h.runtime.getKiroDesktopPendingSessionIds().has(h.sessionId), true);
  assert.equal(h.cards.size, 1);
  t.mock.timers.setTime(startedAt + MAX_PENDING_AGE_MS + 1);
  h.state.cleanStaleSessions();
  assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, 0);
  assert.equal(h.cards.size, 0);
  assert.equal(h.snapshot().pendingAttention, false);
  assert.equal(h.state.sessions.get(h.sessionId).state, "idle");
  t.mock.timers.setTime(startedAt + MAX_PENDING_AGE_MS + 600002);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.size, 0);
});
