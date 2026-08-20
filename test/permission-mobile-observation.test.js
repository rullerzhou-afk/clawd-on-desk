"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { afterEach, test } = require("node:test");
const {
  INTERACTION_INTENT,
  classifyPermissionInteraction,
} = require("../src/permission-automation-policy");
const {
  createSessionAutomationCoordinator,
} = require("../src/session-automation-coordinator");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithElectron(fakeElectron) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function createResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    statusCode: null,
    body: "",
    on() {},
    removeListener() {},
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function createHarness() {
  const windows = [];
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.visible = false;
      this.handlers = new Map();
      this.sent = [];
      this.webContents = {
        once: (event, listener) => this.handlers.set(`wc-once:${event}`, listener),
        on: (event, listener) => this.handlers.set(`wc:${event}`, listener),
        send: (...args) => {
          if (this.throwOnSend) throw new Error("synthetic renderer send failure");
          this.sent.push(args);
        },
        isDestroyed: () => this.destroyed,
      };
      windows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    setBounds(bounds) { this.bounds = bounds; }
    loadFile() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    on(event, listener) { this.handlers.set(event, listener); }
    finishLoad() {
      const listener = this.handlers.get("wc-once:did-finish-load");
      this.handlers.delete("wc-once:did-finish-load");
      if (listener) listener();
    }
    failLoad() {
      const listener = this.handlers.get("wc-once:did-fail-load");
      this.handlers.delete("wc-once:did-fail-load");
      if (listener) listener({}, -6, "FILE_NOT_FOUND");
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      const listener = this.handlers.get("closed");
      if (listener) listener();
    }
  }

  const fakeElectron = {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      fromWebContents(sender) { return sender && sender.__window || null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const initPermission = loadPermissionWithElectron(fakeElectron);
  const changed = [];
  const resolved = [];
  const sessions = new Map();
  const ctx = {
    win: { isDestroyed() { return false; } },
    lang: "en",
    sessions,
    hideBubbles: false,
    doNotDisturb: false,
    petHidden: false,
    bubbleFollowPet: false,
    permDebugLog: null,
    getTextScale: () => 1,
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    subscribeShortcuts: () => () => {},
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 100, y: 100, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    repositionSessionHud: () => {},
    focusTerminalForSession: () => {},
    getRemoteApprovalClients: () => [],
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    onPermissionsChanged: (reason) => changed.push(reason),
    onPermissionResolved: (entry, meta) => resolved.push({ entry, meta }),
  };
  return {
    api: initPermission(ctx),
    ctx,
    windows,
    changed,
    resolved,
  };
}

function addOrdinaryPermission(harness, overrides = {}) {
  const agentId = overrides.agentId || "claude-code";
  const toolName = overrides.toolName || "Bash";
  const sessionId = overrides.sessionId || `session-${harness.api.pendingPermissions.length + 1}`;
  if (!harness.ctx.sessions.has(sessionId)) {
    harness.ctx.sessions.set(sessionId, {
      cwd: "C:\\Users\\alice\\private-project",
      headless: false,
    });
  }
  const entry = {
    res: createResponse(),
    abortHandler: () => {},
    suggestions: [{ type: "setMode", mode: "acceptEdits" }],
    sessionId,
    bubble: null,
    hideTimer: null,
    toolName,
    toolInput: {
      command: "echo raw-command-must-not-leave",
      description: "Run tests with token sk-proj-12345678901234567890",
    },
    agentId,
    interaction: classifyPermissionInteraction({ agentId, toolName }),
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
  harness.api.addPendingPermission(entry);
  harness.api.showPermissionBubble(entry);
  return entry;
}

function observationEvents(api) {
  const events = [];
  const unsubscribe = api.permissionObservation.subscribe((event) => events.push(event));
  return { events, unsubscribe };
}

afterEach(() => {
  delete require.cache[PERMISSION_MODULE_PATH];
});

test("publishes only after successful content sync with an exact frozen safe record", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);

  const entry = addOrdinaryPermission(harness, { toolName: "BrandNewRiskyTool" });
  assert.strictEqual(entry.interaction.intent, INTERACTION_INTENT.UNKNOWN);
  assert.strictEqual(entry.interaction.capabilities.allowDeny, true);
  assert.strictEqual(events.length, 1, "enable emits only the initial empty replacement");

  entry.bubble.finishLoad();
  assert.strictEqual(events.length, 2);
  const upsert = events[1];
  assert.strictEqual(upsert.type, "upsert");
  assert.ok(Object.isFrozen(upsert));
  assert.ok(Object.isFrozen(upsert.record));
  assert.deepStrictEqual(Object.keys(upsert.record), [
    "requestId", "agentId", "toolName", "summary", "folder", "presentedAt",
  ]);
  assert.match(upsert.record.requestId, /^[0-9a-f]{32}$/);
  assert.strictEqual(upsert.record.agentId, "claude-code");
  assert.strictEqual(upsert.record.toolName, "BrandNewRiskyTool");
  assert.strictEqual(upsert.record.folder, "private-project");
  assert.ok(!upsert.record.summary.includes("sk-proj-12345678901234567890"));

  const serialized = JSON.stringify(upsert.record);
  assert.ok(!serialized.includes(entry.sessionId));
  assert.ok(!serialized.includes("raw-command-must-not-leave"));
  assert.ok(!serialized.includes("C:\\\\Users"));
  assert.ok(!serialized.includes("acceptEdits"));

  const firstId = upsert.record.requestId;
  const firstPresentedAt = upsert.record.presentedAt;
  assert.strictEqual(harness.api.syncPermissionBubbleContent(entry), true);
  assert.strictEqual(events.length, 2, "later content resync does not republish or remark");
  const snapshot = harness.api.permissionObservation.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.feature));
  assert.ok(Object.isFrozen(snapshot.records));
  assert.strictEqual(snapshot.records[0].requestId, firstId);
  assert.strictEqual(snapshot.records[0].presentedAt, firstPresentedAt);
});

test("every capability-enabled non-Claude adapter reaches the projection", () => {
  for (const agentId of ["codebuddy", "codex", "qwen-code", "hermes"]) {
    const harness = createHarness();
    const { events } = observationEvents(harness.api);
    harness.api.permissionObservation.setEnabled(true);
    const entry = addOrdinaryPermission(harness, {
      agentId,
      sessionId: `${agentId}-positive`,
      toolName: "BrandNewRiskyTool",
    });
    entry.bubble.finishLoad();
    const upserts = events.filter((event) => event.type === "upsert");
    assert.strictEqual(upserts.length, 1, agentId);
    assert.strictEqual(upserts[0].record.agentId, agentId);
  }
});

test("marks while disabled and rebuilds the hidden pending bubble exactly once", () => {
  const harness = createHarness();
  const entry = addOrdinaryPermission(harness);
  entry.bubble.finishLoad();
  entry.bubble.hide();

  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "replace");
  assert.strictEqual(events[0].feature.enabled, true);
  assert.strictEqual(events[0].records.length, 1);
  assert.ok(Object.isFrozen(events[0]));
  assert.ok(Object.isFrozen(events[0].feature));
  assert.ok(Object.isFrozen(events[0].records));

  harness.api.permissionObservation.setEnabled(true);
  assert.strictEqual(events.length, 1, "same-value enable is idempotent");
  harness.api.permissionObservation.setEnabled(false);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events[1].records, []);
  assert.strictEqual(events[1].feature.enabled, false);
});

test("failed content send and ineligible entries never enter the projection", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);

  const failed = addOrdinaryPermission(harness);
  failed.bubble.throwOnSend = true;
  failed.bubble.finishLoad();
  failed.bubble.throwOnSend = false;
  assert.strictEqual(harness.api.syncPermissionBubbleContent(failed), true);

  const unsupported = addOrdinaryPermission(harness, {
    agentId: "copilot-cli",
    sessionId: "copilot-session",
  });
  unsupported.bubble.finishLoad();

  const remoteOnly = addOrdinaryPermission(harness, {
    remoteOnly: true,
    sessionId: "remote-only",
  });
  remoteOnly.bubble.finishLoad();

  const headless = addOrdinaryPermission(harness, {
    headless: true,
    sessionId: "headless",
  });
  headless.bubble.finishLoad();

  const custom = addOrdinaryPermission(harness, {
    agentId: "custom-local-tool",
    sessionId: "custom",
  });
  custom.bubble.finishLoad();

  const elicitation = addOrdinaryPermission(harness, {
    toolName: "AskUserQuestion",
    sessionId: "elicitation",
  });
  elicitation.bubble.finishLoad();

  const planReview = addOrdinaryPermission(harness, {
    toolName: "ExitPlanMode",
    sessionId: "plan-review",
  });
  planReview.bubble.finishLoad();

  const passive = addOrdinaryPermission(harness, {
    agentId: "codex",
    isCodexNotify: true,
    sessionId: "passive",
  });
  passive.bubble.finishLoad();

  assert.strictEqual(events.filter((event) => event.type === "upsert").length, 0);
  assert.deepStrictEqual(harness.api.permissionObservation.snapshot().records, []);
});

test("subscriber failures are contained and unsubscribe is synchronous", () => {
  const harness = createHarness();
  const received = [];
  harness.api.permissionObservation.subscribe(() => {
    throw new Error("synthetic subscriber failure");
  });
  const unsubscribe = harness.api.permissionObservation.subscribe((event) => received.push(event));

  harness.api.permissionObservation.setEnabled(true);
  assert.strictEqual(received.length, 1);
  unsubscribe();
  harness.api.permissionObservation.setEnabled(false);
  assert.strictEqual(received.length, 1);
});

test("enable rebuild excludes destroyed, replaced, and delayed presentations", () => {
  const harness = createHarness();
  const destroyed = addOrdinaryPermission(harness, { sessionId: "destroyed" });
  destroyed.bubble.finishLoad();
  destroyed.bubble.destroyed = true;

  const replaced = addOrdinaryPermission(harness, { sessionId: "replaced" });
  replaced.bubble.finishLoad();

  const delayed = addOrdinaryPermission(harness, { sessionId: "delayed" });
  delayed.bubble.finishLoad();
  replaced.bubble = { isDestroyed: () => false };
  delayed._delayedResolve = true;

  harness.api.permissionObservation.setEnabled(true);
  assert.deepStrictEqual(harness.api.permissionObservation.snapshot().records, []);
});

test("resolution retracts once and delayed disconnect yields to DND", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);
  const direct = addOrdinaryPermission(harness, { sessionId: "direct" });
  direct.bubble.finishLoad();
  events.length = 0;

  harness.api.resolvePermissionEntry(direct, "allow", undefined, {
    disposition: { reason: "resolved", decided: true },
  });
  assert.deepStrictEqual(
    events.map(({ type, reason, decided }) => ({ type, reason, decided })),
    [{ type: "retract", reason: "resolved", decided: true }]
  );
  assert.strictEqual(harness.resolved.length, 1);
  harness.api.resolvePermissionEntry(direct, "deny", undefined, {
    disposition: { reason: "suppressed", decided: false },
  });
  assert.strictEqual(events.length, 1, "already detached entry cannot retract twice");
  assert.strictEqual(harness.resolved.length, 1, "notifyPermissionResolved remains once");

  const timedOut = addOrdinaryPermission(harness, { sessionId: "timeout" });
  timedOut.bubble.finishLoad();
  events.length = 0;
  timedOut.createdAt = Date.now() - 100;
  harness.ctx.getBubblePolicy = () => ({ enabled: true, autoCloseMs: 1 });
  harness.api.refreshPermissionAutoCloseForPolicy();
  assert.deepStrictEqual(
    events.map(({ type, reason, decided }) => ({ type, reason, decided })),
    [{ type: "retract", reason: "timeout", decided: false }]
  );
  harness.ctx.getBubblePolicy = () => ({ enabled: true, autoCloseMs: 0 });

  const delayedActual = addOrdinaryPermission(harness, {
    sessionId: "delayed-actual",
    createdAt: Date.now(),
  });
  delayedActual.bubble.finishLoad();
  events.length = 0;
  let delayedCallback = null;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => {
    delayedCallback = callback;
    return { synthetic: true };
  };
  try {
    harness.api.resolvePermissionEntry(delayedActual, "no-decision", "Client disconnected", {
      disposition: { reason: "agent_gone", decided: false },
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  assert.strictEqual(typeof delayedCallback, "function");
  assert.deepStrictEqual(events, []);
  delayedCallback();
  assert.deepStrictEqual(
    events.map(({ type, reason, decided }) => ({ type, reason, decided })),
    [{ type: "retract", reason: "agent_gone", decided: false }]
  );

  const delayed = addOrdinaryPermission(harness, {
    sessionId: "delayed-disconnect",
    createdAt: Date.now(),
  });
  delayed.bubble.finishLoad();
  events.length = 0;
  harness.api.resolvePermissionEntry(delayed, "no-decision", "Client disconnected", {
    disposition: { reason: "agent_gone", decided: false },
  });
  assert.deepStrictEqual(events, [], "disconnect remains projected during display grace");
  harness.api.dismissPermissionsForDnd();
  assert.deepStrictEqual(
    events.map(({ type, reason, decided }) => ({ type, reason, decided })),
    [{ type: "retract", reason: "suppressed", decided: false }]
  );
});

test("bubble close distinguishes explicit deny from no-decision fallback", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);

  const claude = addOrdinaryPermission(harness, { sessionId: "claude-close" });
  claude.bubble.finishLoad();
  events.length = 0;
  claude.bubble.destroy();
  assert.deepStrictEqual(
    events.map(({ reason, decided }) => ({ reason, decided })),
    [{ reason: "resolved", decided: true }]
  );

  const qwen = addOrdinaryPermission(harness, {
    agentId: "qwen-code",
    isQwenCode: true,
    sessionId: "qwen-close",
  });
  qwen.bubble.finishLoad();
  events.length = 0;
  qwen.bubble.destroy();
  assert.deepStrictEqual(
    events.map(({ reason, decided }) => ({ reason, decided })),
    [{ reason: "handed_to_terminal", decided: false }]
  );
});

test("terminal handoff stays undecided and post-presentation automation resolves", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);

  const terminal = addOrdinaryPermission(harness, { sessionId: "terminal" });
  terminal.bubble.finishLoad();
  events.length = 0;
  harness.api.dismissPermissionForTerminal(terminal);
  assert.deepStrictEqual(
    events.map(({ reason, decided }) => ({ reason, decided })),
    [{ reason: "handed_to_terminal", decided: false }]
  );

  const automated = addOrdinaryPermission(harness, { sessionId: "automated" });
  automated.bubble.finishLoad();
  events.length = 0;
  const coordinator = createSessionAutomationCoordinator({
    store: { get: () => null },
    listPending: () => harness.api.pendingPermissions,
    canAutoResolvePendingPermission: () => true,
    resolvePermissionEntry: harness.api.resolvePermissionEntry,
  });
  assert.strictEqual(coordinator.resolveIfAllowed(automated), true);
  assert.deepStrictEqual(
    events.map(({ reason, decided }) => ({ reason, decided })),
    [{ reason: "resolved", decided: true }]
  );
});

test("invalid desktop suggestion index records the explicit deny as decided", () => {
  const harness = createHarness();
  const { events } = observationEvents(harness.api);
  harness.api.permissionObservation.setEnabled(true);
  const entry = addOrdinaryPermission(harness, { sessionId: "invalid-suggestion" });
  entry.bubble.finishLoad();
  events.length = 0;

  harness.api.handleDecide(
    { sender: { __window: entry.bubble } },
    "suggestion:99"
  );

  assert.deepStrictEqual(
    events.map(({ reason, decided }) => ({ reason, decided })),
    [{ reason: "resolved", decided: true }]
  );
  assert.strictEqual(entry.res.statusCode, 200);
  assert.match(entry.res.body, /"behavior":"deny"/);
  assert.match(entry.res.body, /Invalid suggestion index/);
});
