"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it, afterEach, mock } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const { isPassiveNotifyEntry } = require("../src/passive-notify-entry");
const createCodexRemoteFallbackNotice = require("../src/codex-remote-fallback-notice");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

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

const activeHarnesses = [];
const activeManagers = [];

function createHarness({
  throwOnWindow = false,
  throwOnLoad = false,
  notificationAutoCloseMs = 60_000,
  automationMode = "auto-tools",
} = {}) {
  const createdWindows = [];
  class FakeBrowserWindow {
    constructor() {
      if (throwOnWindow) throw new Error("BrowserWindow unavailable");
      this.destroyed = false;
      this.sentEvents = [];
      this.webContents = {
        once: (event, cb) => {
          if (event === "did-finish-load" && this._loadFileCalled) cb();
        },
        on: () => {},
        send: (...args) => this.sentEvents.push(args),
      };
      createdWindows.push(this);
    }
    setAlwaysOnTop() {}
    setBounds() {}
    loadFile() {
      this._loadFileCalled = true;
      if (throwOnLoad) throw new Error("bubble html missing");
    }
    showInactive() {}
    setSkipTaskbar() {}
    on() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const fakeElectron = {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      fromWebContents: (sender) => (sender && sender.__window) || null,
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const remoteApprovals = [];
  const fallbackNotices = [];
  let cardDismissedHandler = null;
  const api = loadPermissionWithElectron(fakeElectron)({
    win: { isDestroyed() { return false; } },
    sessions: new Map(),
    hideBubbles: false,
    doNotDisturb: false,
    bubbleFollowPet: false,
    isAgentPermissionsEnabled: () => true,
    isAgentEnabled: () => true,
    getBubblePolicy: (kind) => kind === "notification"
      ? { enabled: true, autoCloseMs: notificationAutoCloseMs }
      : { enabled: true, autoCloseMs: 0 },
    getEffectivePermissionAutomationMode: () => automationMode,
    notifyCodexRemoteFallback: (payload) => {
      fallbackNotices.push(payload);
      return true;
    },
    onCodexRemoteFallbackCardDismissed: (sessionId, entry) => {
      if (cardDismissedHandler) cardDismissedHandler(sessionId, entry);
    },
    getRemoteApprovalClients: () => [{
      name: "fake",
      client: {
        isEnabled: () => true,
        requestApproval() {
          remoteApprovals.push("requested");
          return Promise.resolve(null);
        },
        requestElicitation() {
          remoteApprovals.push("elicitation");
          return Promise.resolve(null);
        },
      },
    }],
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    subscribeShortcuts: () => () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    repositionUpdateBubble: () => {},
    focusTerminalForSession: () => {},
    notifySlackPermission: () => {},
  });
  activeHarnesses.push(api);
  return {
    api,
    createdWindows,
    remoteApprovals,
    fallbackNotices,
    setCardDismissedHandler(handler) {
      cardDismissedHandler = handler;
    },
  };
}

function createWiredManager(options = {}) {
  const harness = options.harness || createHarness(options.harnessOptions);
  const { api } = harness;
  const manager = createCodexRemoteFallbackNotice({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    isSuppressed: () => false,
    show: (payload) => api.showCodexRemoteFallbackNotice(payload),
    refresh: (entry, payload) => api.refreshCodexRemoteFallbackNotice(entry, payload),
    dismiss: (entry, reason) => api.dismissCodexRemoteFallbackNotice(entry, reason),
  });
  activeManagers.push(manager);
  harness.setCardDismissedHandler((sessionId, entry) => manager.noteCardDismissed(sessionId, entry));
  return { api, manager };
}

function createFakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    _listeners: new Map(),
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(data) {
      if (data) this.body += String(data);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    on(event, handler) {
      this._listeners.set(event, handler);
      return this;
    },
    once(event, handler) {
      this._listeners.set(event, handler);
      return this;
    },
    removeListener(event) {
      this._listeners.delete(event);
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
      this.writableFinished = true;
    },
  };
  return res;
}

function remoteCodexEntry(overrides = {}) {
  const toolName = overrides.toolName || "mcp__playwright__browser_navigate";
  return {
    res: createFakeRes(),
    abortHandler: null,
    suggestions: [],
    sessionId: "s1.profile",
    rawSessionId: "codex:remote-1",
    profileId: "remote-1",
    host: "ruller-win",
    bubble: null,
    hideTimer: null,
    toolName,
    toolInput: { url: "https://example.com" },
    resolvedSuggestion: null,
    createdAt: Date.now(),
    interaction: classifyPermissionInteraction({
      agentId: "codex",
      eventKind: "permission",
      toolName,
    }),
    isElicitation: false,
    isCodex: true,
    agentId: "codex",
    codexAutoManual: true,
    codexAutomationClaim: false,
    headless: false,
    codexTurnId: "turn-1",
    toolUseId: "call-1",
    toolInputFingerprint: "fp-1",
    permissionReminder: null,
    permissionReview: null,
    ...overrides,
  };
}

function noticeRequest(overrides = {}) {
  return {
    sessionId: "s1.profile",
    rawSessionId: "codex:remote-1",
    profileId: "remote-1",
    host: "ruller-win",
    toolName: "mcp__playwright__browser_navigate",
    toolInput: { url: "https://example.com" },
    toolUseId: "call-1",
    toolInputFingerprint: "fp-1",
    turnId: "turn-1",
    ...overrides,
  };
}

describe("Codex remote MCP: fallback notice entry", () => {
  afterEach(() => {
    for (const manager of activeManagers.splice(0)) {
      try { manager.dispose(); } catch {}
    }
    for (const api of activeHarnesses.splice(0)) {
      try { api.cleanup(); } catch {}
    }
    mock.timers.reset();
    delete require.cache[PERMISSION_MODULE_PATH];
  });

  it("creates a passive, dismiss-only Codex notice with the real tool as display data", () => {
    const { api } = createHarness();
    const entry = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      rawSessionId: "codex:remote-1",
      profileId: "remote-1",
      host: "ruller-win",
      toolName: "mcp__playwright__browser_navigate",
      toolInput: { url: "https://example.com" },
    });

    assert.ok(entry);
    assert.strictEqual(entry.isCodexNotify, true);
    assert.strictEqual(entry.isCodexRemoteFallbackNotice, true);
    assert.strictEqual(entry.toolName, "CodexExec");
    assert.strictEqual(entry.res, null);
    assert.deepStrictEqual(entry.suggestions, []);
    assert.strictEqual(entry.interaction.intent, "notification");
    assert.strictEqual(entry.displayToolName, "mcp__playwright__browser_navigate");
    assert.deepStrictEqual(entry.displayToolInput, { url: "https://example.com" });
    assert.strictEqual(entry.host, "ruller-win");
    assert.strictEqual(entry.profileId, "remote-1");
    assert.strictEqual(entry.rawSessionId, "codex:remote-1");
    assert.strictEqual(isPassiveNotifyEntry(entry), true);
  });

  it("cannot be auto-approved, sent to a remote approval channel, or counted as pending", () => {
    const { api, remoteApprovals } = createHarness();
    const entry = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      host: "ruller-win",
      toolName: "mcp__playwright__browser_navigate",
      toolInput: { url: "https://example.com" },
    });

    assert.strictEqual(api.wouldAutoAllowPermission(entry), false);
    assert.strictEqual(api.maybeStartRemoteApproval(entry), false);
    assert.deepStrictEqual(remoteApprovals, []);
    assert.strictEqual(
      api.pendingPermissions.filter((pending) => !isPassiveNotifyEntry(pending)).length,
      0
    );
  });

  it("removes the pending entry when the bubble cannot be created", () => {
    const { api } = createHarness({ throwOnWindow: true });
    const entry = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      host: "ruller-win",
      toolName: "mcp__playwright__browser_navigate",
      toolInput: { url: "https://example.com" },
    });
    assert.strictEqual(entry, null);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("refreshes the same session card and keeps the newest display data", () => {
    const { api } = createHarness();
    const first = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      host: "ruller-win",
      toolName: "mcp__playwright__browser_navigate",
      toolInput: { url: "https://first.example" },
    });
    const second = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      host: "ruller-win",
      toolName: "mcp__github__get_issue",
      toolInput: { number: 7 },
    });

    assert.strictEqual(second, first);
    assert.strictEqual(api.pendingPermissions.length, 1);
    assert.strictEqual(first.displayToolName, "mcp__github__get_issue");
    assert.deepStrictEqual(first.displayToolInput, { number: 7 });
  });

  it("never recreates a card through refresh", () => {
    const { api } = createHarness();
    const entry = api.showCodexRemoteFallbackNotice({
      sessionId: "s1.profile",
      rawSessionId: "codex:remote-1",
      profileId: "remote-1",
      host: "ruller-win",
      toolName: "mcp__playwright__browser_navigate",
      toolInput: { url: "https://example.com" },
    });
    assert.ok(entry);
    api.dismissCodexRemoteFallbackNotice(entry, "user-dismissed");
    assert.equal(api.pendingPermissions.length, 0);

    const refreshed = api.refreshCodexRemoteFallbackNotice(entry, {
      sessionId: "s1.profile",
      rawSessionId: "codex:remote-1",
      profileId: "remote-1",
      host: "ruller-win",
      toolName: "mcp__github__get_issue",
      toolInput: { number: 7 },
    });
    assert.equal(refreshed, false);
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("starts a fresh grace period after the user dismisses the card", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const { api, manager } = createWiredManager();
    const dismissals = [];
    const noteCardDismissed = manager.noteCardDismissed;
    manager.noteCardDismissed = (...args) => {
      dismissals.push(args);
      return noteCardDismissed.apply(manager, args);
    };

    manager.notify(noticeRequest({ toolName: "tool-A", toolUseId: null }));
    mock.timers.tick(2_500);
    assert.equal(api.pendingPermissions.length, 1);
    const entry = api.pendingPermissions[0];
    api.handleDecide({ sender: { __window: entry.bubble } }, "got-it");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(dismissals.length, 1);
    assert.equal(dismissals[0][0], "s1.profile");
    assert.equal(dismissals[0][1], entry);

    manager.notify(noticeRequest({
      toolName: "tool-B",
      toolInput: { b: 1 },
      toolUseId: null,
      toolInputFingerprint: "fp-b",
    }));
    mock.timers.tick(2_499);
    assert.equal(api.pendingPermissions.length, 0);
    mock.timers.tick(1);
    assert.equal(api.pendingPermissions.length, 1);
    assert.equal(api.pendingPermissions[0].displayToolName, "tool-B");
  });

  it("starts a fresh grace period after the notification auto-close fires", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const { api, manager } = createWiredManager({
      harnessOptions: { notificationAutoCloseMs: 3_000 },
    });

    manager.notify(noticeRequest({ toolName: "tool-A", toolUseId: null }));
    mock.timers.tick(2_500);
    assert.equal(api.pendingPermissions.length, 1);
    mock.timers.tick(3_000);
    assert.equal(api.pendingPermissions.length, 0);

    manager.notify(noticeRequest({
      toolName: "tool-B",
      toolInput: { b: 1 },
      toolUseId: null,
      toolInputFingerprint: "fp-b",
    }));
    mock.timers.tick(2_499);
    assert.equal(api.pendingPermissions.length, 0);
    mock.timers.tick(1);
    assert.equal(api.pendingPermissions.length, 1);
    assert.equal(api.pendingPermissions[0].displayToolName, "tool-B");
  });

  it("refreshes the remaining request onto the live card", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const { api, manager } = createWiredManager();

    manager.notify(noticeRequest({
      toolName: "tool-A",
      toolUseId: "call-a",
      toolInputFingerprint: "fp-a",
    }));
    manager.notify(noticeRequest({
      toolName: "tool-B",
      toolUseId: "call-b",
      toolInputFingerprint: "fp-b",
    }));
    mock.timers.tick(2_500);
    assert.equal(api.pendingPermissions.length, 1);
    assert.equal(api.pendingPermissions[0].displayToolName, "tool-B");

    manager.handleStateEvent({
      sessionId: "s1.profile",
      event: "PostToolUse",
      toolName: "tool-B",
      toolUseId: "call-b",
      toolInputFingerprint: "fp-b",
      turnId: "turn-1",
    });
    assert.equal(api.pendingPermissions.length, 1);
    assert.equal(api.pendingPermissions[0].displayToolName, "tool-A");
  });

  it("does not pop a removed card when a sibling finishes later", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const { api, manager } = createWiredManager();

    manager.notify(noticeRequest({
      toolName: "tool-A",
      toolUseId: "call-a",
      toolInputFingerprint: "fp-a",
    }));
    manager.notify(noticeRequest({
      toolName: "tool-B",
      toolUseId: "call-b",
      toolInputFingerprint: "fp-b",
    }));
    mock.timers.tick(2_500);
    const entry = api.pendingPermissions[0];
    api.handleDecide({ sender: { __window: entry.bubble } }, "got-it");
    assert.equal(api.pendingPermissions.length, 0);

    manager.handleStateEvent({
      sessionId: "s1.profile",
      event: "PostToolUse",
      toolName: "tool-B",
      toolUseId: "call-b",
      toolInputFingerprint: "fp-b",
      turnId: "turn-1",
    });
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("uses the trusted display host when an automation claim no longer applies", () => {
    const { api, fallbackNotices } = createHarness({ automationMode: "off" });
    const entry = remoteCodexEntry({
      host: null,
      codexRemoteDisplayHost: "ruller-win",
      codexAutomationClaim: true,
    });
    api.addPendingPermission(entry);
    api.showPermissionBubble(entry);

    assert.equal(fallbackNotices.length, 1);
    assert.equal(fallbackNotices[0].host, "ruller-win");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(entry.res.statusCode, 204);
  });

  it("queues a remaining remote Codex request when the internal bubble fails", () => {
    const { api, fallbackNotices } = createHarness({ throwOnLoad: true, automationMode: "off" });
    const entry = remoteCodexEntry({ host: "reported-host", codexRemoteDisplayHost: "ruller-win" });
    api.addPendingPermission(entry);
    api.showPermissionBubble(entry);

    assert.equal(fallbackNotices.length, 1);
    assert.equal(fallbackNotices[0].profileId, "remote-1");
    assert.equal(fallbackNotices[0].host, "ruller-win");
    assert.equal(fallbackNotices[0].toolName, "mcp__playwright__browser_navigate");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(entry.res.statusCode, 204);
  });

  it("Codex remote MCP: a remote Claude bubble load failure returns no-decision without a Codex notice", () => {
    const { api, fallbackNotices } = createHarness({ throwOnLoad: true, automationMode: "off" });
    const entry = remoteCodexEntry({
      agentId: "claude-code",
      isCodex: false,
      codexAutoManual: false,
      rawSessionId: "remote-claude-1",
      interaction: classifyPermissionInteraction({
        agentId: "claude-code",
        eventKind: "permission",
        toolName: "mcp__playwright__browser_navigate",
      }),
    });
    api.addPendingPermission(entry);
    api.showPermissionBubble(entry);

    assert.equal(entry.res.destroyed, true);
    assert.equal(entry.res.statusCode, null);
    assert.equal(entry.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(fallbackNotices.length, 0);
  });

  it("Codex remote MCP: the queue entry rejects remote passive Codex notifications", () => {
    const { api, fallbackNotices } = createHarness();
    const entry = remoteCodexEntry({ isCodexNotify: true });

    assert.equal(api.queueCodexRemoteFallbackForEntry(entry), false);
    assert.equal(fallbackNotices.length, 0);
  });

  it("does not queue a local request when its internal bubble fails", () => {
    const { api, fallbackNotices } = createHarness({ throwOnLoad: true, automationMode: "off" });
    const entry = remoteCodexEntry({ profileId: "local", host: null });
    api.addPendingPermission(entry);
    api.showPermissionBubble(entry);

    assert.equal(fallbackNotices.length, 0);
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(entry.res.statusCode, 204);
  });

  it("stays hidden when DND, the agent gate or notification bubbles are off", () => {
    for (const overrides of [
      { doNotDisturb: true },
      { isAgentEnabled: () => false },
      { isAgentPermissionsEnabled: () => false },
      { getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }) },
      {
        getBubblePolicy: (kind) => kind === "permission"
          ? { enabled: false, autoCloseMs: 0 }
          : { enabled: true, autoCloseMs: 6_000 },
      },
    ]) {
      const fakeElectron = {
        BrowserWindow: Object.assign(class {}, { fromWebContents: () => null }),
        globalShortcut: { register: () => true, unregister() {}, isRegistered: () => false },
      };
      const api = loadPermissionWithElectron(fakeElectron)({
        win: { isDestroyed() { return false; } },
        sessions: new Map(),
        hideBubbles: false,
        doNotDisturb: false,
        bubbleFollowPet: false,
        isAgentPermissionsEnabled: () => true,
        getBubblePolicy: () => ({ enabled: true, autoCloseMs: 60_000 }),
        getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 720 }),
        getHitRectScreen: () => null,
        getHudReservedOffset: () => 0,
        guardAlwaysOnTop: () => {},
        reapplyMacVisibility: () => {},
        subscribeShortcuts: () => () => {},
        reportShortcutFailure: () => {},
        clearShortcutFailure: () => {},
        repositionUpdateBubble: () => {},
        ...overrides,
      });
      const entry = api.showCodexRemoteFallbackNotice({
        sessionId: "s1.profile",
        host: "ruller-win",
        toolName: "mcp__playwright__browser_navigate",
        toolInput: { url: "https://example.com" },
      });
      assert.strictEqual(entry, null, JSON.stringify(overrides));
      assert.strictEqual(api.pendingPermissions.length, 0);
      delete require.cache[PERMISSION_MODULE_PATH];
    }
  });
});
