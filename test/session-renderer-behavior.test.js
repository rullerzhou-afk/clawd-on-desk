"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

class FakeClassList {
  constructor(element) { this.element = element; }
  add(...names) {
    const set = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.parentNode = null;
    this.ownerDocument = null;
  }
  appendChild(child) {
    if (child && typeof child === "object") child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  async dispatch(name, overrides = {}) {
    const event = {
      stopped: false,
      prevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; },
      key: "",
      ...overrides,
    };
    for (const listener of this.listeners.get(name) || []) await listener(event);
    return event;
  }
  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    return byClass(this, selector.slice(1))[0] || null;
  }
  replaceWith() {}
  contains(target) {
    if (target === this) return true;
    return descendants(this).includes(target);
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  select() {}
}

function createDocument(ids) {
  const listeners = new Map();
  const document = {
    title: "",
    activeElement: null,
    createElement: (tag) => {
      const element = new FakeElement(tag);
      element.ownerDocument = document;
      return element;
    },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => document.createElement("fragment"),
    getElementById: (id) => document.elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    async dispatch(name, event = {}) {
      for (const listener of listeners.get(name) || []) await listener(event);
    },
    elements: new Map(),
  };
  for (const id of ids) {
    const element = document.createElement("div");
    document.elements.set(id, element);
  }
  return document;
}

function descendants(root) {
  const result = [];
  for (const child of root.children || []) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function translations() {
  return {
    dashboardWindowTitle: "Sessions",
    dashboardCount: "{n} active",
    dashboardJumpTerminal: "Jump",
    dashboardOpenFolder: "Open Folder",
    sessionFocusUnavailableRemote: "Remote sessions cannot focus a terminal on this computer.",
    sessionFocusUnavailableWebui: "WebUI sessions do not have a local terminal window.",
    sessionFocusUnavailableMissingTerminalInfo: "This session did not provide terminal window information.",
    sessionOpenFolderFailed: "Could not open folder: {reason}",
    sessionOpenFolderUnavailable: "This folder is no longer available.",
    sessionJustNow: "now",
    sessionHudElapsedSec: "{n}s",
    sessionMinAgo: "{n}m",
    sessionHrAgo: "{n}h",
    sessionBadgeIdle: "Idle",
    sessionLocal: "Local",
    sessionAutomationLabel: "Session automation",
    sessionAutomationFollowGlobal: "Follow global",
    sessionAutomationAsk: "Always ask",
    sessionAutomationAutoTools: "Auto-allow tools",
    sessionAutomationUnavailable: "Unavailable",
    sessionAutomationChangeFailed: "Could not update session automation.",
    sessionAutomationOrphansTitle: "Ended or hidden sessions",
    sessionAutomationOrphansHint: "These overrides remain active until revoked.",
    sessionAutomationRevoke: "Revoke",
    dashboardKimiQuotaRefresh: "Refresh Kimi quota",
    dashboardKimiQuotaRefreshing: "Refreshing Kimi…",
    dashboardKimiQuotaUpdated: "Kimi quota updated.",
    dashboardKimiQuotaRefreshFailed: "Refresh failed: {reason}",
    dashboardKimiQuotaEmpty: "No quota data yet. Click refresh to fetch it.",
    dashboardKimiQuotaRefreshShort: "Refresh",
    dashboardQuickSelectTitle: "Quick Select",
    dashboardQuickSelectHint: "Press 1–9 to jump · Esc to exit",
    dashboardQuickSelectEmpty: "No focusable sessions are available.",
    dashboardQuickSelectUnavailable: "This session is no longer available.",
    dashboardQuickSelectAlreadyRequested: "A jump to this session was already requested.",
  };
}

function session(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    state: "idle",
    badge: "idle",
    updatedAt: Date.now(),
    canFocus: false,
    sourceType: "local",
    host: null,
    platform: null,
    cwd: "/safe/project",
    ...overrides,
  };
}

async function loadDashboard(
  sessions,
  openResult = { status: "ok" },
  snapshotOverrides = {},
  automationResult = { status: "applied" },
  kimiOptions = {}
) {
  const document = createDocument([
    "title",
    "count",
    "content",
    "quotaSummary",
    "quickSelectLayer",
    "quickSelectTitle",
    "quickSelectHint",
    "quickSelectOptions",
    "quickSelectFeedback",
  ]);
  const openCalls = [];
  const automationCalls = [];
  const kimiRefreshCalls = [];
  const quickSelectActivationCalls = [];
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;
  let timeoutNowMs = 0;
  let renderInterval = null;
  let snapshotListener = null;
  let quickSelectIntentListener = null;
  let quickSelectExitListener = null;
  let pendingQuickSelectIntent = kimiOptions.quickSelectIntent === true;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: (listener) => { snapshotListener = listener; },
    onQuickSelectIntent: (listener) => { quickSelectIntentListener = listener; },
    onQuickSelectExit: (listener) => { quickSelectExitListener = listener; },
    consumeQuickSelectIntent: async () => {
      const enterQuickSelect = pendingQuickSelectIntent;
      pendingQuickSelectIntent = false;
      return { status: "ok", enterQuickSelect };
    },
    activateQuickSelectSession: async (payload) => {
      quickSelectActivationCalls.push(payload);
      return typeof kimiOptions.quickSelectActivationResult === "function"
        ? kimiOptions.quickSelectActivationResult(payload)
        : (kimiOptions.quickSelectActivationResult || { status: "submitted" });
    },
    getI18n: async () => ({ lang: "en", translations: translations() }),
    getSnapshot: async () => ({
      sessions,
      groups: [{ host: "", ids: sessions.map((s) => s.id) }],
      ...snapshotOverrides,
    }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: () => {},
    ackCompletion: async () => ({ status: "noop" }),
    hideSession: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async (payload) => {
      automationCalls.push(["set", payload]);
      return typeof automationResult === "function"
        ? automationResult("set", payload)
        : automationResult;
    },
    clearSessionAutomationGrant: async (payload) => {
      automationCalls.push(["clear", payload]);
      return typeof automationResult === "function"
        ? automationResult("clear", payload)
        : automationResult;
    },
    getKimiQuotaStatus: async () => kimiOptions.status || {
      status: "ok",
      configured: false,
      decryptable: false,
      collectionEnabled: false,
      agentEnabled: true,
    },
    refreshKimiQuota: async () => {
      kimiRefreshCalls.push(true);
      return kimiOptions.refreshResult || { status: "ok" };
    },
  };
  const windowListeners = new Map();
  const fakeWindow = {
    dashboardAPI: api,
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(listener);
    },
  };
  const scheduleTimeout = (callback, delayMs = 0) => {
    const timeoutId = nextTimeoutId++;
    const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : 0;
    timeoutCallbacks.set(timeoutId, {
      callback,
      dueAt: timeoutNowMs + delay,
    });
    if (kimiOptions.deferTimeouts !== true) {
      queueMicrotask(() => {
        const pending = timeoutCallbacks.get(timeoutId);
        if (!pending) return;
        timeoutCallbacks.delete(timeoutId);
        timeoutNowMs = Math.max(timeoutNowMs, pending.dueAt);
        pending.callback();
      });
    }
    return timeoutId;
  };
  const advanceTimersByTime = async (advanceMs) => {
    const amount = Number(advanceMs);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("advanceMs must be non-negative");
    const targetTime = timeoutNowMs + amount;
    while (true) {
      const next = [...timeoutCallbacks.entries()]
        .filter(([, pending]) => pending.dueAt <= targetTime)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
      if (!next) break;
      const [timeoutId, pending] = next;
      timeoutCallbacks.delete(timeoutId);
      timeoutNowMs = pending.dueAt;
      pending.callback();
      await Promise.resolve();
    }
    timeoutNowMs = targetTime;
    await flush();
  };
  const context = vm.createContext({
    window: fakeWindow, document, console, Intl, Date,
    setInterval: (callback) => { renderInterval = callback; return 1; },
    setTimeout: scheduleTimeout,
    clearTimeout: (timeoutId) => timeoutCallbacks.delete(timeoutId),
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"), context);
  await flush();
  return {
    root: document.elements.get("content"),
    quotaSummary: document.elements.get("quotaSummary"),
    quickSelectLayer: document.elements.get("quickSelectLayer"),
    quickSelectOptions: document.elements.get("quickSelectOptions"),
    quickSelectFeedback: document.elements.get("quickSelectFeedback"),
    openCalls,
    automationCalls,
    kimiRefreshCalls,
    quickSelectActivationCalls,
    pushSnapshot: async (nextSessions, nextOverrides = {}) => {
      snapshotListener({
        sessions: nextSessions,
        groups: [{ host: "", ids: nextSessions.map((entry) => entry.id) }],
        ...nextOverrides,
      });
      await flush();
    },
    triggerQuickSelect: async () => {
      pendingQuickSelectIntent = true;
      quickSelectIntentListener();
      await flush();
    },
    exitQuickSelect: () => quickSelectExitListener(),
    blurWindow: async () => {
      for (const listener of windowListeners.get("blur") || []) await listener();
    },
    pointerDown: async (target) => document.dispatch("pointerdown", { target }),
    advanceTimersByTime,
    tickRender: () => { if (renderInterval) renderInterval(); },
  };
}

async function loadHud(sessions, openResult = { status: "ok" }) {
  const document = createDocument(["hud"]);
  const openCalls = [];
  let snapshotListener = null;
  let feedbackTimeout = null;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: (listener) => { snapshotListener = listener; },
    getI18n: async () => ({ lang: "en", translations: translations() }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: () => {},
    ackCompletion: async () => ({ status: "noop" }),
    openDashboard: () => {},
    setPinned: () => {},
  };
  const context = vm.createContext({
    window: { sessionHudAPI: api }, document, console, Date,
    setInterval: () => 0,
    setTimeout: (callback) => { feedbackTimeout = callback; return 1; },
    clearTimeout: () => { feedbackTimeout = null; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"), context);
  await flush();
  snapshotListener({ sessions, orderedIds: sessions.map((entry) => entry.id) });
  return {
    root: document.elements.get("hud"),
    openCalls,
    pushSnapshot: (nextSessions = sessions) => snapshotListener({
      sessions: nextSessions,
      orderedIds: nextSessions.map((entry) => entry.id),
    }),
    expireFeedback: async () => {
      const callback = feedbackTimeout;
      feedbackTimeout = null;
      if (callback) callback();
      await flush();
    },
  };
}

test("Dashboard renders local/remote/webui reasons and only local folder action", async () => {
  const { root } = await loadDashboard([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  assert.strictEqual(byClass(root, "card-unfocusable").length, 3);
  assert.deepStrictEqual(byClass(root, "focus-unavailable-reason").map((el) => el.textContent), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);

  const cards = byClass(root, "card");
  const jumpButtons = (card) => descendants(card)
    .filter((el) => el.tagName === "BUTTON" && el.textContent === "Jump");
  assert.deepStrictEqual(jumpButtons(cards[0]).map((button) => button.disabled), [true]);
  assert.deepStrictEqual(jumpButtons(cards[1]), []);
  assert.deepStrictEqual(jumpButtons(cards[2]).map((button) => button.disabled), [true]);
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("Dashboard Quick Select keeps digit mapping stable while the live order changes", async () => {
  const dashboard = await loadDashboard(
    [
      session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" }),
      session("b", { canFocus: true, displayTitle: "Beta", agentId: "claude-code" }),
      session("c", { canFocus: false, displayTitle: "Gamma" }),
    ],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true }
  );

  assert.strictEqual(dashboard.quickSelectLayer.hidden, false);
  assert.deepStrictEqual(
    byClass(dashboard.quickSelectOptions, "quick-select-option-title")
      .map((element) => element.textContent),
    ["Alpha", "Beta"]
  );

  await dashboard.pushSnapshot([
    session("b", { canFocus: true, displayTitle: "Beta", agentId: "claude-code" }),
    session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" }),
  ]);
  await dashboard.quickSelectLayer.dispatch("keydown", { key: "1" });
  await dashboard.quickSelectLayer.dispatch("keyup", { key: "1" });
  await flush();

  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 1);
  assert.strictEqual(dashboard.quickSelectActivationCalls[0].sessionId, "a");
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);
});

test("Dashboard Quick Select consumes rapid repeated digits before focus handoff", async () => {
  const dashboard = await loadDashboard(
    [
      session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" }),
      session("b", { canFocus: true, displayTitle: "Beta", agentId: "claude-code" }),
    ],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true, deferTimeouts: true }
  );

  const firstDown = await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Digit1",
  });
  const firstUp = await dashboard.quickSelectLayer.dispatch("keyup", {
    key: "1",
    code: "Digit1",
  });
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);
  assert.strictEqual(dashboard.quickSelectLayer.hidden, false);

  await dashboard.advanceTimersByTime(60);
  const secondDown = await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Digit1",
  });
  const repeatedDown = await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Digit1",
    repeat: true,
  });
  await dashboard.advanceTimersByTime(120);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);

  const secondUp = await dashboard.quickSelectLayer.dispatch("keyup", {
    key: "1",
    code: "Digit1",
  });
  for (const event of [firstDown, firstUp, secondDown, repeatedDown, secondUp]) {
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(event.stopped, true);
  }
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);

  await dashboard.advanceTimersByTime(119);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);
  await dashboard.advanceTimersByTime(1);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 1);
  assert.strictEqual(dashboard.quickSelectActivationCalls[0].sessionId, "a");
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);
});

test("Dashboard Quick Select tracks a digit release when Shift changes event.key", async () => {
  const dashboard = await loadDashboard(
    [session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" })],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true, deferTimeouts: true }
  );

  await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Digit1",
  });
  const shiftedUp = await dashboard.quickSelectLayer.dispatch("keyup", {
    key: "!",
    code: "Digit1",
    shiftKey: true,
  });
  assert.strictEqual(shiftedUp.prevented, true);
  assert.strictEqual(shiftedUp.stopped, true);

  await dashboard.advanceTimersByTime(119);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);
  await dashboard.advanceTimersByTime(1);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 1);
  assert.strictEqual(dashboard.quickSelectActivationCalls[0].sessionId, "a");
});

test("Dashboard Quick Select waits for distinct top-row and numpad digit releases", async () => {
  const dashboard = await loadDashboard(
    [session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" })],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true, deferTimeouts: true }
  );

  await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Digit1",
  });
  await dashboard.quickSelectLayer.dispatch("keydown", {
    key: "1",
    code: "Numpad1",
  });
  await dashboard.quickSelectLayer.dispatch("keyup", {
    key: "1",
    code: "Digit1",
  });
  await dashboard.advanceTimersByTime(500);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);

  await dashboard.quickSelectLayer.dispatch("keyup", {
    key: "1",
    code: "Numpad1",
  });
  await dashboard.advanceTimersByTime(119);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 0);
  await dashboard.advanceTimersByTime(1);
  assert.strictEqual(dashboard.quickSelectActivationCalls.length, 1);
  assert.strictEqual(dashboard.quickSelectActivationCalls[0].sessionId, "a");
});

test("Dashboard Quick Select cancels a pending digit handoff when it exits", async () => {
  const dashboard = await loadDashboard(
    [session("a", { canFocus: true, displayTitle: "Alpha", agentId: "codex" })],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true, deferTimeouts: true }
  );

  await dashboard.quickSelectLayer.dispatch("keydown", { key: "1", code: "Digit1" });
  await dashboard.quickSelectLayer.dispatch("keydown", { key: "Escape" });
  await dashboard.advanceTimersByTime(1000);

  assert.deepStrictEqual(dashboard.quickSelectActivationCalls, []);
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);
});

test("Dashboard Quick Select keeps stale digits unavailable and exits without trapping focus", async () => {
  const dashboard = await loadDashboard(
    [
      session("a", { canFocus: true, displayTitle: "Alpha" }),
      session("b", { canFocus: true, displayTitle: "Beta" }),
    ],
    { status: "ok" },
    {},
    { status: "applied" },
    { quickSelectIntent: true }
  );

  await dashboard.pushSnapshot([
    session("b", { canFocus: true, displayTitle: "Beta" }),
  ]);
  await dashboard.quickSelectLayer.dispatch("keydown", { key: "1" });
  await flush();
  assert.deepStrictEqual(dashboard.quickSelectActivationCalls, []);
  assert.strictEqual(
    dashboard.quickSelectFeedback.textContent,
    "This session is no longer available."
  );
  assert.strictEqual(dashboard.quickSelectLayer.hidden, false);

  await dashboard.quickSelectLayer.dispatch("keydown", { key: "Escape" });
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);

  await dashboard.triggerQuickSelect();
  await dashboard.quickSelectLayer.dispatch("keydown", { key: "Tab" });
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);

  await dashboard.triggerQuickSelect();
  await dashboard.pointerDown(dashboard.root);
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);

  await dashboard.triggerQuickSelect();
  await dashboard.blurWindow();
  assert.strictEqual(dashboard.quickSelectLayer.hidden, true);
});

test("Dashboard hosts the manual Kimi quota refresh inside the Kimi quota section", async () => {
  const dashboard = await loadDashboard(
    [],
    { status: "ok" },
    {},
    { status: "applied" },
    {
      status: {
        status: "ok",
        configured: true,
        decryptable: true,
        collectionEnabled: true,
        agentEnabled: true,
      },
    }
  );

  // Connected but nothing reported yet: the section stays visible with an
  // empty hint so the refresh that fetches the first numbers has a home.
  const button = byClass(dashboard.quotaSummary, "quota-refresh-button")[0];
  assert.ok(button, "Kimi quota section header should host the refresh button");
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.title, "Refresh Kimi quota");
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-empty-hint").length, 1);

  await button.dispatch("click");
  await flush();

  assert.strictEqual(dashboard.kimiRefreshCalls.length, 1);
  assert.strictEqual(button.disabled, false);
  const feedback = byClass(dashboard.quotaSummary, "quota-refresh-feedback")[0];
  assert.ok(feedback, "Kimi quota section header should host the refresh feedback");
  assert.strictEqual(feedback.hidden, false);
  assert.strictEqual(feedback.textContent, "Kimi quota updated.");
});

test("Dashboard renders no Kimi quota section or refresh for a disconnected key", async () => {
  const dashboard = await loadDashboard([]);

  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-refresh-button").length, 0);
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-section").length, 0);
});

test("Dashboard quota bars apply the same warn and hot boundaries as Orbit", async () => {
  const dashboard = await loadDashboard([], { status: "ok" }, {
    accountQuota: [{
      host: null,
      claudeQuota: {
        lastSeenAt: Date.now(),
        group: {
          claudeFiveHour: { usedPercent: 59 },
          claudeWeekly: { usedPercent: 60 },
        },
      },
      codexQuota: {
        lastSeenAt: Date.now(),
        group: {
          codexFiveHour: { usedPercent: 85 },
          codexWeekly: { usedPercent: 86 },
        },
      },
    }],
  });

  const classesByWidth = new Map(
    byClass(dashboard.quotaSummary, "quota-bar-fill")
      .map((fill) => [fill.style.width, fill.className])
  );
  assert.match(classesByWidth.get("59%"), /\bsev-ok\b/);
  assert.match(classesByWidth.get("60%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("85%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("86%"), /\bsev-hot\b/);
});

test("Dashboard renders the resolved custom agent name instead of its raw id", async () => {
  const { root } = await loadDashboard([
    session("custom", {
      agentId: "custom-nova-0123456789ab",
      agentName: "Nova AI",
    }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Nova AI/);
  assert.doesNotMatch(renderedText, /custom-nova/);
});

test("Dashboard keeps curated labels for built-in agents", async () => {
  const { root } = await loadDashboard([
    session("codex", { agentId: "codex", agentName: "Codex CLI" }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Codex/);
  assert.doesNotMatch(renderedText, /Codex CLI/);
});

test("Dashboard folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadDashboard([session("local")], { status: "error", message: "denied" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  const feedback = byClass(root, "session-action-feedback")[0];
  assert.ok(feedback);
  assert.strictEqual(feedback.attributes["aria-live"], "polite");
  assert.strictEqual(feedback.textContent, "Could not open folder: denied");
});

test("Dashboard preserves folder pending and failure state across interval renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const { root, openCalls, tickRender } = await loadDashboard(
    [session("local")],
    () => pendingResult
  );

  const clickPromise = byClass(root, "open-folder-button")[0].dispatch("click");
  await flush();
  tickRender();

  const replacementButton = byClass(root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);

  resolveOpen({ status: "error", message: "slow denial" });
  await clickPromise;
  tickRender();
  assert.strictEqual(
    byClass(root, "session-action-feedback")[0].textContent,
    "Could not open folder: slow denial"
  );
  assert.strictEqual(byClass(root, "open-folder-button")[0].disabled, false);
});

test("Dashboard session automation sends only sessionId/mode and exact grantId", async () => {
  const configurable = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "inherit",
  });
  const activeButIneligible = session("active", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "auto-tools",
    sessionAutomationGrantId: "grant-current",
  });
  const inactiveIneligible = session("inactive", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "inherit",
  });
  const { root, automationCalls } = await loadDashboard([configurable, activeButIneligible, inactiveIneligible]);
  const selects = byClass(root, "session-automation-select");
  assert.strictEqual(selects.length, 2);

  selects[0].value = "off";
  await selects[0].dispatch("change");
  selects[1].value = "inherit";
  await selects[1].dispatch("change");

  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["set", { sessionId: "configurable", mode: "off" }],
    ["clear", { grantId: "grant-current" }],
  ]);
});

test("Dashboard renders and revokes an orphan grant by exact grantId", async () => {
  const { root, automationCalls } = await loadDashboard([], { status: "ok" }, {
    sessionAutomationOrphans: [{
      agentId: "claude-code",
      sessionId: "ended",
      mode: "auto-tools",
      displayLabel: "Ended project",
      sessionAutomationGrantId: "grant-orphan",
    }],
  });

  assert.strictEqual(byClass(root, "automation-orphan-card").length, 1);
  assert.strictEqual(byClass(root, "automation-orphan-title")[0].textContent, "Ended project");
  const revoke = byClass(root, "automation-orphan-card")[0].children[1];
  await revoke.dispatch("click");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["clear", { grantId: "grant-orphan" }],
  ]);
});

test("Dashboard keeps session automation failure feedback visible after rerender", async () => {
  const { root } = await loadDashboard([
    session("configurable", {
      canConfigureSessionAutomation: true,
      sessionAutomationMode: "inherit",
    }),
  ], { status: "ok" }, {}, { status: "full" });
  const select = byClass(root, "session-automation-select")[0];
  select.value = "auto-tools";
  await select.dispatch("change");

  assert.strictEqual(byClass(root, "session-automation-select")[0].value, "inherit");
  assert.strictEqual(
    byClass(root, "session-automation-feedback")[0].textContent,
    "Could not update session automation."
  );
});

test("HUD unfocusable click explains why and offers folder only for local non-webui", async () => {
  const { root } = await loadHud([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  const rows = byClass(root, "row-unfocusable");
  assert.deepStrictEqual(rows.map((row) => row.title), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);
  await rows[0].dispatch("click");
  assert.strictEqual(
    byClass(root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("HUD folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadHud([session("local")], { status: "not-available" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  assert.strictEqual(byClass(root, "session-inline-feedback")[0].textContent, "This folder is no longer available.");
});

test("HUD preserves folder pending state across snapshot renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const harness = await loadHud([session("local")], () => pendingResult);

  const clickPromise = byClass(harness.root, "open-folder-button")[0].dispatch("click");
  await flush();
  harness.pushSnapshot();

  const replacementButton = byClass(harness.root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(harness.openCalls, [["local"]]);

  resolveOpen({ status: "ok" });
  await clickPromise;
  assert.strictEqual(byClass(harness.root, "open-folder-button")[0].disabled, false);
});

test("HUD feedback survives snapshot renders and clears on its timeout", async () => {
  const harness = await loadHud([session("local")]);
  await byClass(harness.root, "row-unfocusable")[0].dispatch("click");
  harness.pushSnapshot();
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );

  await harness.expireFeedback();
  assert.strictEqual(byClass(harness.root, "session-inline-feedback").length, 0);
  assert.strictEqual(byClass(harness.root, "title")[0].textContent, "local");
});

test("unfocusable and folder feedback copy exists in all supported languages", () => {
  const keys = [
    "dashboardOpenFolder",
    "sessionOpenFolderFailed",
    "sessionOpenFolderUnavailable",
    "sessionFocusUnavailableRemote",
    "sessionFocusUnavailableWebui",
    "sessionFocusUnavailableMissingTerminalInfo",
  ];
  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key} is required`);
  }
});
