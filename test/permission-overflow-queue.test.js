"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const { describe, it, mock } = require("node:test");

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.__window = owner;
    this.sent = [];
  }
  send(channel, payload) { this.sent.push([channel, payload]); }
  insertCSS() { return undefined; }
  setZoomFactor() {}
  isDestroyed() { return false; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  static fromWebContents(sender) { return sender && sender.__window || null; }

  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = {
      x: options.x || 0,
      y: options.y || 0,
      width: options.width || 340,
      height: options.height || 200,
    };
    this.visible = options.show === true;
    this.destroyed = false;
    this.focusCount = 0;
    this.webContents = new FakeWebContents(this);
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  getBounds() { return { ...this.bounds }; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focusCount += 1; this.visible = true; }
  setAlwaysOnTop() {}
  loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
}

function loadPermission() {
  const registered = new Map();
  const globalShortcut = {
    register(accelerator, handler) { registered.set(accelerator, handler); return true; },
    unregister(accelerator) { registered.delete(accelerator); },
    isRegistered(accelerator) { return registered.has(accelerator); },
  };
  const modulePath = require.resolve("../src/permission");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return { BrowserWindow: FakeBrowserWindow, globalShortcut };
    if (request === "child_process") {
      const childProcess = originalLoad.call(this, "node:child_process", parent, isMain);
      return {
        ...childProcess,
        execFile(_file, _args, _options, callback) {
          callback(new Error("frontmost app unavailable in test"), "");
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const initPermission = require("../src/permission");
  Module._load = originalLoad;
  return { initPermission, registered };
}

function interaction() {
  return {
    intent: "tool-approval",
    automationEligibility: { autoTools: false, unattended: false },
    capabilities: {
      allowDeny: true,
      answerQuestions: false,
      planFeedback: false,
      nativeFallback: true,
    },
  };
}

function askInteraction() {
  return {
    intent: "human-question",
    automationEligibility: { autoTools: false, unattended: false },
    capabilities: {
      allowDeny: false,
      answerQuestions: true,
      planFeedback: false,
      nativeFallback: true,
    },
  };
}

function requestBubble() {
  return new FakeBrowserWindow({ width: 340, height: 150, show: false });
}

function requestEntry(index, bubble) {
  return {
    bubble,
    bubbleReady: true,
    measuredHeight: 150,
    compactMeasuredHeight: 150,
    suggestions: [],
    sessionId: "shared-session",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: `echo request-${index}` },
    interaction: interaction(),
    createdAt: Date.now(),
  };
}

function askEntry(index) {
  return {
    suggestions: [],
    sessionId: `ask-session-${index}`,
    agentId: "claude-code",
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [{
        id: "0",
        question: `Question ${index}?`,
        options: [
          { label: "One", description: "First option" },
          { label: "Two", description: "Second option" },
        ],
      }],
    },
    interaction: askInteraction(),
    isElicitation: true,
    createdAt: Date.now(),
  };
}

function lastQueuePayload(queueWindow) {
  const sent = queueWindow.webContents.sent.filter(([channel]) => channel === "permission-queue-show");
  return sent.at(-1) && sent.at(-1)[1];
}

function makeCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    lang: "en",
    sessions: new Map([["shared-session", { cwd: "/tmp/project" }]]),
    bubbleFollowPet: false,
    bubbleFixedCorner: "bottom-right",
    doNotDisturb: false,
    petHidden: false,
    getSettingsSnapshot: () => ({}),
    subscribeShortcuts: () => () => {},
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 80, height: 80 }),
    getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    getTextScale: () => 1,
    guardAlwaysOnTop() {},
    reapplyMacVisibility() {},
    repositionUpdateBubble() {},
    repositionSessionHud() {},
    ...overrides,
  };
}

function findQueueWindow() {
  return FakeBrowserWindow.instances.find((win) => (
    win.options.webPreferences
    && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
  ));
}

describe("permission Ask default expansion", () => {
  it("expands only the first safe Ask before its initial payload without focusing", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    }));

    const first = askEntry(1);
    permission.addPendingPermission(first);
    permission.showPermissionBubble(first);

    assert.strictEqual(first.expanded, true);
    assert.strictEqual(first.measurementEpoch, 0);
    assert.strictEqual(first.bubble.focusCount, 0);
    assert.ok(!first.bubble.webContents.sent.some(([channel]) => (
      channel === "permission-restore-active-control"
    )), "arrival must not carry explicit focus intent");

    first.bubble.webContents.emit("did-finish-load");
    const firstPayload = first.bubble.webContents.sent.find(([channel]) => (
      channel === "permission-show"
    ));
    assert.strictEqual(firstPayload[1].presentation.expanded, true);
    assert.strictEqual(firstPayload[1].presentation.measurementEpoch, 0);
    permission.handleBubbleHeight(
      { sender: first.bubble.webContents },
      { state: "expanded", measurementEpoch: 0, height: 420 }
    );
    assert.strictEqual(first.expandedMeasuredHeight, 420,
      "the initial expanded height ACK must use the unchanged creation epoch");
    assert.strictEqual(first.measurementEpoch, 0);

    const second = askEntry(2);
    permission.addPendingPermission(second);
    permission.showPermissionBubble(second);

    assert.strictEqual(first.expanded, true);
    assert.strictEqual(second.expanded, false);
    assert.strictEqual(second.bubble.focusCount, 0);

    permission.handleBubbleExpanded({ sender: first.bubble.webContents }, false);
    permission.reconcilePermissionPresentation("collapsed-stays-compact");
    assert.strictEqual(first.expanded, false);
    assert.strictEqual(second.expanded, false,
      "ordinary reconciliation must not promote an already-present Ask");

    const third = askEntry(3);
    permission.addPendingPermission(third);
    permission.showPermissionBubble(third);
    assert.strictEqual(first.expanded, false, "the collapsed Ask must never reopen itself");
    assert.strictEqual(second.expanded, false, "an already-present Ask is not promoted");
    assert.strictEqual(third.expanded, true,
      "a genuinely new Ask may independently use the safe arrival transition");
  });

  it("clears a removed owner without promoting an already-present Ask", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    }));
    const first = askEntry(1);
    const second = askEntry(2);
    permission.addPendingPermission(first);
    permission.showPermissionBubble(first);
    permission.addPendingPermission(second);
    permission.showPermissionBubble(second);
    assert.strictEqual(first.expanded, true);
    assert.strictEqual(second.expanded, false);

    permission.removePendingPermission(first, "owner-resolved");
    permission.reconcilePermissionPresentation("owner-resolved");

    assert.strictEqual(second.expanded, false,
      "owner removal only clears stale ownership; it never auto-promotes a sibling");
  });

  it("uses the shared Ask capability boundary without agent or tool-name special cases", () => {
    const cases = [
      {
        name: "Hermes clarify",
        expected: true,
        mutate(entry) { entry.agentId = "hermes"; entry.toolName = "clarify"; },
      },
      {
        name: "ZCode non-answerable Ask",
        expected: false,
        mutate(entry) {
          entry.agentId = "zcode";
          entry.interaction.capabilities.answerQuestions = false;
        },
      },
      {
        name: "Qwen non-answerable Ask",
        expected: false,
        mutate(entry) {
          entry.agentId = "qwen-code";
          entry.interaction.capabilities.answerQuestions = false;
        },
      },
      {
        name: "Plan feedback",
        expected: false,
        mutate(entry) {
          entry.toolName = "ExitPlanMode";
          entry.interaction.intent = "plan-review";
          entry.interaction.capabilities.answerQuestions = false;
          entry.interaction.capabilities.planFeedback = true;
        },
      },
      {
        name: "Codex passive user input",
        expected: false,
        mutate(entry) {
          entry.agentId = "codex";
          entry.isCodexUserInputNotify = true;
        },
      },
      {
        name: "remote-only answerable Ask",
        expected: false,
        mutate(entry) { entry.remoteOnly = true; },
      },
    ];

    for (const testCase of cases) {
      FakeBrowserWindow.instances = [];
      const { initPermission } = loadPermission();
      const permission = initPermission(makeCtx({
        getBubbleWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      }));
      const entry = askEntry(1);
      testCase.mutate(entry);
      permission.addPendingPermission(entry);
      permission.showPermissionBubble(entry);
      assert.strictEqual(entry.expanded, testCase.expected, testCase.name);
    }
  });

  it("keeps arrival compact when only the hypothetical expanded stack is unsafe", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 420 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 420 }),
    }));
    const sibling = requestEntry(1, requestBubble());
    permission.pendingPermissions.push(sibling);
    const ask = askEntry(2);
    permission.addPendingPermission(ask);
    permission.showPermissionBubble(ask);

    assert.strictEqual(ask.expanded, false,
      "the live new entry and its sibling must both participate in the safety preflight");
    assert.strictEqual(findQueueWindow(), undefined,
      "the same stack remains a safe normal presentation when the Ask is compact");
  });

  it("keeps a newly arrived Ask compact while the first overflow revision is pending", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx());
    permission.pendingPermissions.push(
      requestEntry(1, requestBubble()),
      requestEntry(2, requestBubble()),
      requestEntry(3, requestBubble())
    );
    permission.reconcilePermissionPresentation("pending-overflow");
    const queueWindow = findQueueWindow();
    assert.ok(queueWindow, "the first representation is waiting for its renderer ACK");

    const ask = askEntry(4);
    permission.addPendingPermission(ask);
    permission.showPermissionBubble(ask);

    assert.strictEqual(ask.expanded, false);
    assert.strictEqual(ask.bubble.isVisible(), true,
      "before the first ACK, #944 keeps request windows accessible instead of hiding them early");
  });

  it("keeps a newly arrived Ask compact behind an ACKed overflow representation", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx());
    const existing = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...existing);
    permission.reconcilePermissionPresentation("establish-overflow");
    const queueWindow = findQueueWindow();
    queueWindow.webContents.emit("did-finish-load");
    const committed = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: committed.revision }
    );

    const ask = askEntry(4);
    permission.addPendingPermission(ask);
    permission.showPermissionBubble(ask);

    assert.strictEqual(ask.expanded, false);
    assert.strictEqual(ask.bubble.isVisible(), false,
      "the old ACKed representation owns visibility until the new revision is acknowledged");
  });

  it("caps an expanded representative so it shares the work area with the launcher", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({ getTextScale: () => 1.6 }));
    const expanded = requestEntry(1, requestBubble());
    expanded.sessionId = "expanded-session";
    expanded.interaction = askInteraction();
    expanded.toolName = "AskUserQuestion";
    expanded.expanded = true;
    expanded.expandedMeasuredHeight = 620;
    const hidden = requestEntry(2, requestBubble());
    hidden.sessionId = "expanded-session";
    permission.pendingPermissions.push(expanded, hidden);

    permission.reconcilePermissionPresentation("expanded-with-launcher");
    const queueWindow = findQueueWindow();
    assert.ok(queueWindow, "overflow creates a queue launcher");
    queueWindow.webContents.emit("did-finish-load");
    const payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    const workAreaBottom = 360;
    assert.ok(expanded.bubble.bounds.y >= 0);
    assert.ok(expanded.bubble.bounds.y + expanded.bubble.bounds.height <= workAreaBottom);
    assert.ok(queueWindow.bounds.y >= 0);
    assert.ok(queueWindow.bounds.y + queueWindow.bounds.height <= workAreaBottom);
    assert.ok(expanded.bubble.bounds.y + expanded.bubble.bounds.height <= queueWindow.bounds.y,
      "the protected Ask and launcher must not overlap");
    assert.ok(expanded.bubble.bounds.height < 334,
      "the overflow-only cap reserves launcher height instead of using the full work-area cap");
  });

  it("keeps optional representatives from squeezing the expanded owner below its selection budget", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 1104 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 1104 }),
      getTextScale: () => 1.25,
    }));
    const expanded = requestEntry(1, requestBubble());
    expanded.sessionId = "expanded";
    expanded.expanded = true;
    expanded.expandedMeasuredHeight = 620;
    expanded.interaction = askInteraction();
    const siblings = [2, 3, 4, 5, 6].map((index) => {
      const entry = requestEntry(index, requestBubble());
      entry.sessionId = `sibling-${index}`;
      entry.measuredHeight = 152;
      entry.compactMeasuredHeight = 152;
      return entry;
    });
    permission.pendingPermissions.push(expanded, ...siblings);

    permission.reconcilePermissionPresentation("expanded-with-siblings");
    const queueWindow = findQueueWindow();
    queueWindow.webContents.emit("did-finish-load");
    const payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    const visibleSiblings = siblings.filter((entry) => entry.bubble.isVisible());
    assert.strictEqual(visibleSiblings.length, 1,
      "optional session representatives go to the launcher before they can shrink the protected Ask");
    assert.strictEqual(expanded.bubble.bounds.height, 662,
      "the 125% Ask keeps its 60% work-area budget instead of collapsing below the readable floor");
    const visibleBounds = [expanded, ...visibleSiblings]
      .map((entry) => entry.bubble.getBounds())
      .concat(queueWindow.getBounds());
    assert.ok(visibleBounds.every((bounds) => bounds.y >= 0 && bounds.y + bounds.height <= 1104));
  });

  it("positions a newly arrived request when an unsafe first queue candidate is rejected", () => {
    FakeBrowserWindow.instances = [];
    let hudBounds = { x: 0, y: 0, width: 800, height: 360 };
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getSessionHudBounds: () => hudBounds,
    }));
    const expanded = requestEntry(1, requestBubble());
    expanded.expanded = true;
    expanded.measurementEpoch = 7;
    expanded.expandedHeightBudget = 620;
    expanded.expandedBudgetKey = "stale-work-area";
    expanded.expandedHeightBudgetMeasured = true;
    expanded.bubble.visible = true;
    permission.pendingPermissions.push(expanded);
    const arriving = requestEntry(2, null);
    permission.addPendingPermission(arriving);

    permission.showPermissionBubble(arriving);

    assert.strictEqual(findQueueWindow(), undefined,
      "an unsafe representation must not enter the queue commit protocol");
    assert.strictEqual(arriving.bubble.isVisible(), true);
    assert.notDeepStrictEqual(
      { x: arriving.bubble.bounds.x, y: arriving.bubble.bounds.y },
      { x: 0, y: 0 },
      "the normal-mode defensive fallback must replace the constructor's temporary top-left bounds"
    );
    assert.strictEqual(expanded.measurementEpoch, 7,
      "a rejected speculative representative set must not bump the committed presentation epoch");

    hudBounds = null;
    permission.reconcilePermissionPresentation("unsafe-first-overflow-cleared");
    assert.strictEqual(arriving.bubble.isVisible(), true,
      "normal fallback ownership includes the newly positioned request");
  });

  it("preserves an ACKed representation when an expanded candidate later becomes unsafe", () => {
    FakeBrowserWindow.instances = [];
    let hudBounds = null;
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx({
      getSessionHudBounds: () => hudBounds,
    }));
    const expanded = requestEntry(1, requestBubble());
    expanded.expanded = true;
    expanded.expandedMeasuredHeight = 620;
    const hidden = requestEntry(2, requestBubble());
    permission.pendingPermissions.push(expanded, hidden);
    permission.reconcilePermissionPresentation("safe-expanded-overflow");
    const queueWindow = findQueueWindow();
    queueWindow.webContents.emit("did-finish-load");
    const committed = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: committed.revision }
    );
    const before = {
      payloadCount: queueWindow.webContents.sent.filter(([channel]) => (
        channel === "permission-queue-show"
      )).length,
      queueBounds: queueWindow.getBounds(),
      requests: permission.pendingPermissions.map((entry) => ({
        visible: entry.bubble.isVisible(),
        bounds: entry.bubble.getBounds(),
      })),
    };

    hudBounds = { x: 0, y: 0, width: 800, height: 360 };
    permission.reconcilePermissionPresentation("unsafe-expanded-overflow");

    assert.strictEqual(queueWindow.webContents.sent.filter(([channel]) => (
      channel === "permission-queue-show"
    )).length, before.payloadCount, "unsafe geometry must not publish a new revision");
    assert.deepStrictEqual(queueWindow.getBounds(), before.queueBounds);
    assert.deepStrictEqual(permission.pendingPermissions.map((entry) => ({
      visible: entry.bubble.isVisible(),
      bounds: entry.bubble.getBounds(),
    })), before.requests, "the ACKed ownership and window presentation stay unchanged");
  });
});

describe("permission overflow queue", () => {
  it("commits representation only after ACK, swaps request windows safely, and falls back with zero decisions", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission, registered } = loadPermission();
    const announced = [];
    let permissionAutoCloseMs = 0;
    const ctx = {
      win: { isDestroyed: () => false },
      lang: "en",
      sessions: new Map([["shared-session", { cwd: "/tmp/project" }]]),
      bubbleFollowPet: false,
      bubbleFixedCorner: "bottom-right",
      doNotDisturb: false,
      petHidden: false,
      getSettingsSnapshot: () => ({ shortcuts: { permissionAllow: "CommandOrControl+Enter", permissionDeny: "Escape" } }),
      subscribeShortcuts: () => () => {},
      getBubblePolicy: () => ({ enabled: true, autoCloseMs: permissionAutoCloseMs }),
      getPetWindowBounds: () => ({ x: 0, y: 0, width: 80, height: 80 }),
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
      getHitRectScreen: () => null,
      getHudReservedOffset: () => 0,
      getTextScale: () => 1,
      guardAlwaysOnTop() {},
      reapplyMacVisibility() {},
      repositionUpdateBubble() {},
      repositionSessionHud() {},
      notifySlackPermission(payload) { announced.push(payload); },
    };
    const permission = initPermission(ctx);
    const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...entries);

    permission.syncPermissionShortcuts();
    assert.strictEqual(registered.size, 2, "normal mode keeps existing shortcuts");

    permission.reconcilePermissionPresentation("test-overflow");
    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    assert.ok(queueWindow, "overflow creates the navigation window");
    assert.ok(entries.every((entry) => entry.bubble.isVisible()),
      "request cards remain visible until the queue renderer proves delivery");
    assert.strictEqual(queueWindow.isVisible(), false);
    assert.strictEqual(registered.size, 2,
      "overflow keeps shortcuts while a request card is visibly represented");

    queueWindow.webContents.emit("did-finish-load");
    const firstPayload = lastQueuePayload(queueWindow);
    assert.strictEqual(firstPayload.totalCount, 3);
    assert.strictEqual(firstPayload.hiddenCount, 2);
    assert.strictEqual(firstPayload.sessions.length, 1);
    const firstRow = firstPayload.sessions[0].entries[0];
    assert.deepStrictEqual(
      Object.keys(firstRow).sort(),
      ["action", "kind", "selected", "summary", "toolLabel", "uiEntryId", "visible"],
      "the queue receives navigation metadata only"
    );
    assert.ok(!JSON.stringify(firstPayload).includes("toolInput"));
    assert.ok(!JSON.stringify(firstPayload).includes("detailText"));
    assert.strictEqual(announced.length, 0);

    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: firstPayload.revision }
    );
    assert.strictEqual(queueWindow.isVisible(), true);
    assert.strictEqual(entries.filter((entry) => entry.bubble.isVisible()).length, 1);
    assert.strictEqual(announced.length, 2, "hidden entries announce only after queue ACK");
    permissionAutoCloseMs = 60_000;
    permission.refreshPermissionAutoCloseForPolicy();
    assert.ok(
      entries.filter((entry) => !entry.bubble.isVisible()).every((entry) => entry.autoCloseTimer),
      "overflow-hidden requests keep their normal auto-close lifetime"
    );
    permissionAutoCloseMs = 0;
    permission.refreshPermissionAutoCloseForPolicy();

    const lateEntry = requestEntry(4, requestBubble());
    entries.push(lateEntry);
    permission.pendingPermissions.push(lateEntry);
    permission.reconcilePermissionPresentation("late-entry");
    const latePayload = lastQueuePayload(queueWindow);
    assert.strictEqual(latePayload.totalCount, 4);
    permission.handleBubbleHeight(
      { sender: lateEntry.bubble.webContents },
      { height: 150, state: "compact", measurementEpoch: 0 }
    );
    assert.strictEqual(announced.length, 2,
      "a never-visible request height ACK cannot announce before the queue represents it");
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: latePayload.revision }
    );
    assert.strictEqual(announced.length, 3,
      "the late hidden request announces from the queue ACK exactly once");

    const lateVisibleEntry = requestEntry(5, requestBubble());
    lateVisibleEntry.sessionId = "second-session";
    lateVisibleEntry.measuredHeight = 60;
    lateVisibleEntry.compactMeasuredHeight = 60;
    entries.push(lateVisibleEntry);
    permission.pendingPermissions.push(lateVisibleEntry);
    permission.reconcilePermissionPresentation("late-visible-session");
    const lateVisiblePayload = lastQueuePayload(queueWindow);
    const lateVisibleRow = lateVisiblePayload.sessions
      .flatMap((session) => session.entries)
      .find((entry) => entry.uiEntryId === lateVisibleEntry.uiEntryId);
    assert.strictEqual(lateVisibleRow.visible, true);
    permission.handleBubbleHeight(
      { sender: lateVisibleEntry.bubble.webContents },
      { height: 60, state: "compact", measurementEpoch: 0 }
    );
    assert.strictEqual(announced.length, 3,
      "a future representative still cannot announce while the old commit keeps it hidden");
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: lateVisiblePayload.revision }
    );
    assert.ok(
      lateVisibleEntry.bubble.webContents.sent.some(([channel]) => channel === "permission-presentation"),
      "the committed visible representative is asked for a fresh local height acknowledgement"
    );
    permission.handleBubbleHeight(
      { sender: lateVisibleEntry.bubble.webContents },
      { height: 60, state: "compact", measurementEpoch: 0 }
    );
    assert.strictEqual(announced.length, 4,
      "the newly visible representative announces through the normal visible-window path");

    entries[0].compositionActive = true;
    permission.reconcilePermissionPresentation("composition-started");
    const lockedPayload = lastQueuePayload(queueWindow);
    assert.strictEqual(lockedPayload.switchingLocked, true);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: lockedPayload.revision }
    );
    assert.strictEqual(
      permission.handleQueueDrawerOpen({ sender: queueWindow.webContents }),
      false,
      "the launcher cannot replace a request window while IME composition is active"
    );
    entries[0].compositionActive = false;
    permission.reconcilePermissionPresentation("composition-ended");
    const unlockedPayload = lastQueuePayload(queueWindow);
    assert.strictEqual(unlockedPayload.switchingLocked, false);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: unlockedPayload.revision }
    );

    permission.handleQueueDrawerOpen({ sender: queueWindow.webContents });
    const drawerPayload = lastQueuePayload(queueWindow);
    assert.strictEqual(drawerPayload.drawerOpen, true);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: drawerPayload.revision, height: 300 }
    );
    assert.ok(entries.every((entry) => !entry.bubble.isVisible()),
      "the open drawer is the only visible permission surface");
    assert.strictEqual(registered.size, 0,
      "the open drawer disables shortcuts because no request card is visible");

    permission.handleQueueSelect(
      { sender: queueWindow.webContents },
      { uiEntryId: entries[1].uiEntryId, intent: "view" }
    );
    assert.strictEqual(entries[1].bubble.isVisible(), true, "the selected original window returns");
    assert.strictEqual(entries[0].bubble.isVisible(), false, "the old same-session representative is replaced");

    const selectedPayload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: selectedPayload.revision }
    );
    queueWindow.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    assert.ok(entries.every((entry) => entry.bubble.isVisible()),
      "queue failure restores the first-stage request stack");
    assert.strictEqual(permission.pendingPermissions.length, 5,
      "queue failure never decides or releases requests");
  });

  it("hotkeys resolve only the bottommost visible request and wait for hidden requests", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission, registered } = loadPermission();
    const permission = initPermission(makeCtx({
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 550 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 550 }),
      getSettingsSnapshot: () => ({
        shortcuts: {
          permissionAllow: "CommandOrControl+Enter",
          permissionDeny: "Escape",
        },
      }),
    }));
    const entries = [1, 2, 3, 4].map((index) => {
      const entry = requestEntry(index, requestBubble());
      entry.sessionId = `session-${index}`;
      return entry;
    });
    permission.pendingPermissions.push(...entries);
    permission.reconcilePermissionPresentation("hotkey-overflow");

    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    const payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    const visibleBefore = entries.filter((entry) => entry.bubble.isVisible());
    const hiddenBefore = entries.filter((entry) => !entry.bubble.isVisible());
    assert.deepStrictEqual(visibleBefore, entries.slice(0, 3));
    assert.deepStrictEqual(hiddenBefore, [entries[3]]);
    assert.strictEqual(registered.size, 2);

    registered.get("CommandOrControl+Enter")();
    assert.strictEqual(permission.pendingPermissions.includes(entries[2]), false,
      "the shortcut resolves the bottommost visible request");
    assert.strictEqual(permission.pendingPermissions.includes(entries[3]), true,
      "a hidden newer request is not resolved early");
    assert.strictEqual(entries[3].bubble.isVisible(), true,
      "the hidden request becomes eligible only after it is represented on screen");

    registered.get("CommandOrControl+Enter")();
    assert.strictEqual(permission.pendingPermissions.includes(entries[3]), false,
      "the next shortcut may resolve the request after it becomes visible");
    permission.cleanup();
  });

  it("keeps pet-hidden old requests out of a queue created for new requests", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const ctx = {
      win: { isDestroyed: () => false },
      lang: "en",
      sessions: new Map([["shared-session", { cwd: "/tmp/project" }]]),
      bubbleFollowPet: false,
      bubbleFixedCorner: "bottom-right",
      doNotDisturb: false,
      petHidden: false,
      getSettingsSnapshot: () => ({}),
      subscribeShortcuts: () => () => {},
      getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
      getPetWindowBounds: () => ({ x: 0, y: 0, width: 80, height: 80 }),
      getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
      getHitRectScreen: () => null,
      getHudReservedOffset: () => 0,
      getTextScale: () => 1,
      guardAlwaysOnTop() {},
      reapplyMacVisibility() {},
      repositionUpdateBubble() {},
      repositionSessionHud() {},
    };
    const permission = initPermission(ctx);
    const oldEntries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...oldEntries);
    permission.reconcilePermissionPresentation("old-overflow");
    let queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    let payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    permission.handleQueueSelect(
      { sender: queueWindow.webContents },
      { uiEntryId: oldEntries[1].uiEntryId, intent: "view" }
    );
    payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    permission.hidePermissionSurfacesForPet();
    assert.ok(oldEntries.every((entry) => !entry.bubble.isVisible()));

    const newEntries = [4, 5, 6].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...newEntries);
    permission.reconcilePermissionPresentation("new-while-hidden");
    queueWindow = FakeBrowserWindow.instances.filter((win) => (
      !win.isDestroyed()
      && win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    )).at(-1);
    queueWindow.webContents.emit("did-finish-load");
    payload = lastQueuePayload(queueWindow);
    assert.strictEqual(payload.totalCount, 3);
    assert.ok(payload.sessions[0].entries.every((entry) => /request-[456]/.test(entry.summary)),
      "the queue shown while the pet is hidden must not leak old summaries");
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );

    permission.showPermissionSurfacesForPet();
    payload = lastQueuePayload(queueWindow);
    assert.strictEqual(payload.totalCount, 6, "showing the pet merges old pending entries back in");
    const restoredSelection = payload.sessions
      .flatMap((session) => session.entries)
      .find((entry) => entry.uiEntryId === oldEntries[1].uiEntryId);
    assert.strictEqual(restoredSelection.selected, true,
      "petHidden must not clear the user's still-pending representative selection");
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );
    queueWindow.webContents.emit("render-process-gone", {}, { reason: "cleanup" });
  });

  it("auto-closes one hidden request and publishes the smaller queue without deciding siblings", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    let permission = null;
    try {
      FakeBrowserWindow.instances = [];
      const { initPermission } = loadPermission();
      let permissionAutoCloseMs = 0;
      const ctx = {
        win: { isDestroyed: () => false },
        lang: "en",
        sessions: new Map([["shared-session", { cwd: "/tmp/project" }]]),
        bubbleFollowPet: false,
        bubbleFixedCorner: "bottom-right",
        doNotDisturb: false,
        petHidden: false,
        getSettingsSnapshot: () => ({}),
        subscribeShortcuts: () => () => {},
        getBubblePolicy: () => ({ enabled: true, autoCloseMs: permissionAutoCloseMs }),
        getPetWindowBounds: () => ({ x: 0, y: 0, width: 80, height: 80 }),
        getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
        getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 360 }),
        getHitRectScreen: () => null,
        getHudReservedOffset: () => 0,
        getTextScale: () => 1,
        guardAlwaysOnTop() {},
        reapplyMacVisibility() {},
        repositionUpdateBubble() {},
        repositionSessionHud() {},
      };
      permission = initPermission(ctx);
      const entries = [1, 2, 3, 4].map((index) => requestEntry(index, requestBubble()));
      const hiddenTarget = entries[1];
      for (const entry of entries.filter((candidate) => candidate !== hiddenTarget)) {
        entry.interaction = {
          intent: "human-question",
          automationEligibility: { autoTools: false, unattended: false },
          capabilities: {
            allowDeny: false,
            answerQuestions: true,
            planFeedback: false,
            nativeFallback: true,
          },
        };
      }
      permission.pendingPermissions.push(...entries);
      permission.reconcilePermissionPresentation("auto-close-overflow");
      const queueWindow = FakeBrowserWindow.instances.find((win) => (
        win.options.webPreferences
        && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
      ));
      queueWindow.webContents.emit("did-finish-load");
      const initialPayload = lastQueuePayload(queueWindow);
      permission.handleQueuePresentationAck(
        { sender: queueWindow.webContents },
        { revision: initialPayload.revision }
      );
      assert.strictEqual(hiddenTarget.bubble.isVisible(), false);

      permissionAutoCloseMs = 1_000;
      permission.refreshPermissionAutoCloseForPolicy();
      assert.ok(hiddenTarget.autoCloseTimer, "the hidden ordinary request owns the timer");
      assert.ok(entries.filter((entry) => entry !== hiddenTarget).every((entry) => !entry.autoCloseTimer));
      mock.timers.tick(1_000);

      assert.deepStrictEqual(permission.pendingPermissions, entries.filter((entry) => entry !== hiddenTarget));
      assert.strictEqual(lastQueuePayload(queueWindow).totalCount, 3);
    } finally {
      if (permission) permission.cleanup();
      mock.timers.reset();
    }
  });

  it("falls back to the request stack when the queue never acknowledges its revision", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
    let permission = null;
    try {
      FakeBrowserWindow.instances = [];
      const { initPermission } = loadPermission();
      permission = initPermission(makeCtx());
      const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
      permission.pendingPermissions.push(...entries);
      permission.reconcilePermissionPresentation("ack-timeout");
      const queueWindow = FakeBrowserWindow.instances.find((win) => (
        win.options.webPreferences
        && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
      ));
      queueWindow.webContents.emit("did-finish-load");
      assert.ok(lastQueuePayload(queueWindow), "the unacknowledged revision was delivered");

      mock.timers.tick(1_499);
      assert.strictEqual(queueWindow.isDestroyed(), false);
      mock.timers.tick(1);

      assert.strictEqual(queueWindow.isDestroyed(), true, "the missed ACK abandons this queue episode");
      assert.deepStrictEqual(permission.pendingPermissions, entries, "fallback never decides a request");
      assert.ok(entries.every((entry) => entry.bubble.isVisible()),
        "every original request window remains available after fallback");
      assert.strictEqual(
        FakeBrowserWindow.instances.filter((win) => (
          !win.isDestroyed()
          && win.options.webPreferences
          && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
        )).length,
        0,
        "the same overflow episode does not retry the failed queue"
      );
    } finally {
      if (permission) permission.cleanup();
      mock.timers.reset();
    }
  });

  it("keeps a composing request as the visible representative when overflow begins", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx());
    const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    entries[1].compositionActive = true;
    permission.pendingPermissions.push(...entries);
    permission.reconcilePermissionPresentation("composition-protected");
    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    const payload = lastQueuePayload(queueWindow);
    const composingRow = payload.sessions[0].entries.find((row) => (
      row.uiEntryId === entries[1].uiEntryId
    ));
    assert.strictEqual(composingRow.visible, true);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );
    assert.strictEqual(entries[1].bubble.isVisible(), true);
    queueWindow.webContents.emit("render-process-gone", {}, { reason: "cleanup" });
  });

  it("does not hide a request if composition starts while the drawer commit is pending", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const permission = initPermission(makeCtx());
    const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...entries);
    permission.reconcilePermissionPresentation("composition-race");
    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    let payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );
    assert.strictEqual(entries[0].bubble.isVisible(), true);

    permission.handleQueueDrawerOpen({ sender: queueWindow.webContents });
    permission.handleCompositionActive(
      { sender: entries[0].bubble.webContents },
      true
    );
    payload = lastQueuePayload(queueWindow);
    assert.strictEqual(payload.drawerOpen, true);
    assert.strictEqual(payload.switchingLocked, true);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision, height: 300 }
    );

    assert.strictEqual(entries[0].bubble.isVisible(), true,
      "a late composition start wins over the drawer's hide-all commit");
    queueWindow.webContents.emit("render-process-gone", {}, { reason: "cleanup" });
  });

  it("requests a fresh height ACK when queue failure reveals an unannounced request", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const announced = [];
    const permission = initPermission(makeCtx({
      notifySlackPermission(payload) { announced.push(payload); },
    }));
    const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...entries);
    permission.reconcilePermissionPresentation("slack-initial");
    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    let payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );
    assert.strictEqual(announced.length, 2);

    const lateEntry = requestEntry(4, requestBubble());
    permission.pendingPermissions.push(lateEntry);
    permission.reconcilePermissionPresentation("slack-late");
    payload = lastQueuePayload(queueWindow);
    assert.strictEqual(payload.totalCount, 4);
    assert.strictEqual(lateEntry.bubble.isVisible(), false);
    assert.strictEqual(lateEntry._slackPermissionAnnounced, undefined);

    queueWindow.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    assert.strictEqual(lateEntry.bubble.isVisible(), true);
    assert.ok(
      lateEntry.bubble.webContents.sent.some(([channel]) => channel === "permission-presentation"),
      "the newly visible original renderer is asked to prove its presentation"
    );
    permission.handleBubbleHeight(
      { sender: lateEntry.bubble.webContents },
      { height: 150, state: "compact", measurementEpoch: 0 }
    );
    assert.strictEqual(announced.length, 3, "the normal visible-window ACK owns Slack delivery");
  });

  it("requests a fresh height ACK when a late request returns directly to normal mode", () => {
    FakeBrowserWindow.instances = [];
    const { initPermission } = loadPermission();
    const announced = [];
    const permission = initPermission(makeCtx({
      notifySlackPermission(payload) { announced.push(payload); },
    }));
    const entries = [1, 2, 3].map((index) => requestEntry(index, requestBubble()));
    permission.pendingPermissions.push(...entries);
    permission.reconcilePermissionPresentation("slack-normal-initial");
    const queueWindow = FakeBrowserWindow.instances.find((win) => (
      win.options.webPreferences
      && path.basename(win.options.webPreferences.preload) === "preload-permission-queue.js"
    ));
    queueWindow.webContents.emit("did-finish-load");
    let payload = lastQueuePayload(queueWindow);
    permission.handleQueuePresentationAck(
      { sender: queueWindow.webContents },
      { revision: payload.revision }
    );
    assert.strictEqual(announced.length, 2);

    const lateEntry = requestEntry(4, requestBubble());
    permission.pendingPermissions.push(lateEntry);
    permission.reconcilePermissionPresentation("slack-normal-late");
    payload = lastQueuePayload(queueWindow);
    assert.strictEqual(payload.totalCount, 4);
    assert.strictEqual(lateEntry.bubble.isVisible(), false);

    permission.removePendingPermission(entries[1], "test-stack-shrink");
    permission.removePendingPermission(entries[2], "test-stack-shrink");
    permission.reconcilePermissionPresentation("slack-return-normal");

    assert.strictEqual(queueWindow.isDestroyed(), true);
    assert.strictEqual(lateEntry.bubble.isVisible(), true);
    assert.ok(
      lateEntry.bubble.webContents.sent.some(([channel]) => channel === "permission-presentation"),
      "normal-mode restoration asks the original renderer for visibility proof"
    );
    permission.handleBubbleHeight(
      { sender: lateEntry.bubble.webContents },
      { height: 150, state: "compact", measurementEpoch: 0 }
    );
    assert.strictEqual(announced.length, 3);
  });
});
