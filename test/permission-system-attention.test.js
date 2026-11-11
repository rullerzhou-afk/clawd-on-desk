// Native OS "waiting for you" toasts must describe reality.
//
// The toast is announced from the same points as the Slack heads-up: after the
// renderer acknowledged a visible card, or after a remote client confirmed its
// card was delivered. Queueing a request is not enough, and a request that
// automation answered must never produce one.
//
// These cases run the real permission module and the real notifier together,
// with only Electron faked, so "auto-approved means silent" is checked across
// the actual seam rather than against a stub of either side.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const { EventEmitter } = require("events");

const { classifyPermissionInteraction } = require("../src/permission-automation-policy");
const { createSystemNotifications } = require("../src/system-notifications");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

class FakeBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.bounds = null;
    this.sentEvents = [];
    this.listeners = new Map();
    this.webContents = {
      once: (event, callback) => this.listeners.set(event, callback),
      on: (event, callback) => this.listeners.set(event, callback),
      send: (...args) => this.sentEvents.push(args),
    };
  }

  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  setSkipTaskbar() {}
  showInactive() {}
  focus() {}
  on(event, callback) { this.listeners.set(event, callback); }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    const closed = this.listeners.get("closed");
    if (closed) closed();
  }
  loadFile() {
    const finished = this.listeners.get("did-finish-load");
    if (finished) finished();
  }
}

FakeBrowserWindow.fromWebContents = (sender) => sender && sender.__window || null;

function loadPermissionWithFakeElectron() {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") {
      return {
        BrowserWindow: FakeBrowserWindow,
        globalShortcut: {
          register: () => true,
          unregister() {},
          isRegistered: () => false,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

const initPermission = loadPermissionWithFakeElectron();

function makeCapturingRes() {
  const captured = { statusCode: null, body: "", destroyCalls: 0 };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status) { captured.statusCode = status; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); this.writableEnded = true; },
    destroy() { captured.destroyCalls++; this.destroyed = true; },
    on() {},
    removeListener() {},
  };
}

// Real notifier, fake Electron Notification: `toasts` is what Windows would
// have been asked to show.
function makeNotifier(settings) {
  const toasts = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; this.closed = false; toasts.push(this); }
    show() { this.emit("show"); }
    close() { this.closed = true; }
  }
  const focusCalls = [];
  const notifier = createSystemNotifications({
    Notification: FakeNotification,
    platform: "win32",
    getSettings: () => settings,
    isSuppressed: () => false,
    getLang: () => "en",
    focusSession: (sessionId, options) => { focusCalls.push({ sessionId, options }); return true; },
    openDashboard: () => {},
  });
  return { notifier, toasts, focusCalls };
}

function makeCtx(overrides = {}) {
  const settings = { enabled: true, onDone: true, onError: true, onPermission: true };
  const { notifier, toasts, focusCalls } = makeNotifier(settings);
  const payloads = [];
  const slack = [];
  const ctx = {
    lang: "en",
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getPermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    notifySlackPermission: (payload) => { slack.push(payload); },
    // Same shape as the main.js wiring.
    notifySystemAttention: (payload, options) => {
      payloads.push(payload);
      notifier.notifyAttention({ ...payload, agentName: "Claude Code" }, options);
    },
    ...overrides,
  };
  ctx.settings = settings;
  ctx.toasts = toasts;
  ctx.payloads = payloads;
  ctx.slack = slack;
  ctx.focusCalls = focusCalls;
  ctx.notifier = notifier;
  return ctx;
}

function makePermEntry(overrides = {}) {
  const entry = {
    res: makeCapturingRes(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf / --token=sk-ant-abcdefghijklmnop", description: "clean the tree" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    cwd: "C:\\repos\\alpha",
    sourcePid: 4242,
    ...overrides,
  };
  entry.interaction = overrides.interaction || classifyPermissionInteraction({
    agentId: entry.agentId,
    eventKind: entry.isCodexNotify || entry.isKimiNotify ? "passive-notification" : "permission",
    toolName: entry.toolName,
  });
  return entry;
}

function renderAndAcknowledge(perm, entry, height = 180) {
  perm.showPermissionBubble(entry);
  assert.ok(entry.bubble, "precondition: a desktop bubble was constructed");
  perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, height);
}

describe("system attention toast: only for requests a human must answer", () => {
  it("does not toast when the entry is merely queued or still loading", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.equal(ctx.toasts.length, 0);
    perm.showPermissionBubble(entry);
    assert.equal(ctx.toasts.length, 0, "a loading window is not yet a card the user can see");
  });

  it("toasts once when a human approval is on screen, and survives reflows", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.equal(ctx.toasts.length, 1);
    assert.deepEqual(ctx.toasts[0].options, {
      title: "Claude Code · alpha",
      body: "Waiting for your approval: Bash",
      silent: true,
    });

    perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 220);
    perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 260);
    assert.equal(ctx.toasts.length, 1, "renderer reflows must not toast again");
  });

  it("hands the notifier identity only: no command, input, summary or question text", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);

    assert.equal(ctx.payloads.length, 1);
    assert.deepEqual(Object.keys(ctx.payloads[0]).sort(),
      ["agentId", "focusEntry", "folder", "kind", "sessionId", "toolName"]);
    assert.equal(ctx.payloads[0].sessionId, "session-test");
    assert.equal(ctx.payloads[0].folder, "alpha");
    const leaked = JSON.stringify([ctx.payloads[0], ctx.toasts[0].options]);
    assert.doesNotMatch(leaked, /rm -rf|sk-ant|clean the tree/);
  });

  it("stays silent when unattended automation approves the request", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "unattended" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false, "entry was auto-approved");
    assert.equal(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision.behavior, "allow");
    assert.equal(ctx.payloads.length, 0);
    assert.equal(ctx.toasts.length, 0, "no toast for a request nobody had to answer");
  });

  it("stays silent when auto-tools approves an ordinary tool, but toasts the question it defers", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "auto-tools" });
    const perm = initPermission(ctx);
    const tool = makePermEntry();
    perm.addPendingPermission(tool, "added");
    perm.showPermissionBubble(tool);
    assert.equal(perm.pendingPermissions.includes(tool), false);
    assert.equal(ctx.toasts.length, 0);

    const question = makePermEntry({
      sessionId: "session-question",
      toolName: "AskUserQuestion",
      isElicitation: true,
      toolInput: { questions: [{ question: "What is the production password?" }] },
    });
    perm.addPendingPermission(question, "added");
    renderAndAcknowledge(perm, question);
    assert.equal(perm.pendingPermissions.includes(question), true);
    assert.equal(ctx.toasts.length, 1);
    assert.equal(ctx.toasts[0].options.body, "Waiting for your answer");
    assert.doesNotMatch(JSON.stringify(ctx.toasts[0].options), /password|AskUserQuestion/);
  });

  it("does not toast a request that was resolved before its card rendered", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    perm.showPermissionBubble(entry);
    const bubble = entry.bubble;
    perm.resolvePermissionEntry(entry, "allow");
    perm.handleBubbleHeight({ sender: { __window: bubble } }, 180);
    assert.equal(ctx.toasts.length, 0);
  });

  it("withdraws the toast once the request has been answered", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);
    assert.equal(ctx.toasts[0].closed, false);

    perm.resolvePermissionEntry(entry, "deny");
    // main.js re-broadcasts the session snapshot when a permission resolves.
    ctx.notifier.onSnapshot({ sessions: [] });
    assert.equal(ctx.toasts[0].closed, true);
  });

  it("stays silent during Do Not Disturb", () => {
    const ctx = makeCtx({ doNotDisturb: true });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    perm.showPermissionBubble(entry);
    if (entry.bubble) perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 180);
    assert.equal(ctx.toasts.length, 0);
  });

  it("stays silent for headless sessions", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({ headless: true });
    perm.addPendingPermission(entry, "added");
    perm.showPermissionBubble(entry);
    if (entry.bubble) perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 180);
    assert.equal(ctx.toasts.length, 0);
  });

  it("honors the waiting-for-you switch without touching the Slack heads-up", () => {
    const ctx = makeCtx();
    ctx.settings.onPermission = false;
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);
    assert.equal(ctx.toasts.length, 0);
    assert.equal(ctx.slack.length, 1, "Slack is an independent channel");
    assert.equal(perm.pendingPermissions.includes(entry), true, "the request itself is untouched");
  });

  it("leaves the Slack payload exactly as it was", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);
    assert.equal(ctx.slack.length, 1);
    assert.deepEqual(Object.keys(ctx.slack[0]).sort(),
      ["actionTarget", "agentId", "folder", "kind", "summary", "title", "toolName"]);
  });

  it("works when the native notifier is not wired at all", () => {
    const ctx = makeCtx({ notifySystemAttention: undefined });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.doesNotThrow(() => renderAndAcknowledge(perm, entry));
    assert.equal(ctx.slack.length, 1);
  });

  it("a notifier that throws cannot break the permission flow", () => {
    const ctx = makeCtx({ notifySystemAttention: () => { throw new Error("toast host crashed"); } });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.doesNotThrow(() => renderAndAcknowledge(perm, entry));
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.equal(entry.res.captured.statusCode, null, "no decision was sent on the user's behalf");
  });

  it("also covers plan reviews and passive native-prompt cards, without a synthetic tool name", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const plan = makePermEntry({ sessionId: "plan", toolName: "ExitPlanMode", toolInput: { plan: "ship it to prod" } });
    perm.addPendingPermission(plan, "added");
    renderAndAcknowledge(perm, plan);
    assert.equal(ctx.toasts.length, 1);
    assert.equal(ctx.slack.length, 0, "Slack keeps excluding plan reviews");
    assert.doesNotMatch(JSON.stringify(ctx.toasts[0].options), /ship it/);

    const passive = makePermEntry({
      sessionId: "codex-native",
      agentId: "codex",
      res: null,
      toolName: "CodexExec",
      toolInput: { command: "git push --force" },
      isCodexNotify: true,
    });
    perm.addPendingPermission(passive, "passive-added");
    renderAndAcknowledge(perm, passive);
    assert.equal(ctx.toasts.length, 2);
    assert.equal(ctx.toasts[1].options.body, "Waiting for your approval");
    assert.doesNotMatch(JSON.stringify(ctx.toasts[1].options), /CodexExec|git push/);
  });

  it("keeps two sessions' requests apart, down to the click target", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const first = makePermEntry({ sessionId: "one", cwd: "C:\\repos\\alpha", sourcePid: 111 });
    const second = makePermEntry({ sessionId: "two", cwd: "C:\\repos\\beta", sourcePid: 222, toolName: "Edit" });
    perm.addPendingPermission(first, "added");
    perm.addPendingPermission(second, "added");
    renderAndAcknowledge(perm, first);
    renderAndAcknowledge(perm, second);

    assert.deepEqual(ctx.toasts.map((toast) => toast.options.title), ["Claude Code · alpha", "Claude Code · beta"]);
    ctx.toasts[1].emit("click");
    assert.equal(ctx.focusCalls.length, 1);
    assert.equal(ctx.focusCalls[0].sessionId, "two");
    assert.equal(ctx.focusCalls[0].options.fallbackEntry.sourcePid, 222);
  });
});
