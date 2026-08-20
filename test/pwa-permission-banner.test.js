"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");

const ROOT = path.join(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "app.js"), "utf8");
const HTML_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "index.html"), "utf8");
const CSS_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "style.css"), "utf8");
const SW_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "sw.js"), "utf8");
const PROTOCOL_SOURCE = fs.readFileSync(path.join(ROOT, "docs", "mobile-protocol-v1.md"), "utf8");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fakeElement(tag = "div") {
  let html = "";
  let text = "";
  const classes = new Set();
  const attributes = {};
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    attributes,
    listeners,
    queryResults: [],
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
    querySelectorAll() { return this.queryResults; },
    querySelector() { return null; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(value) { html = String(value); },
  });
  Object.defineProperty(el, "textContent", {
    get() { return text; },
    set(value) { text = String(value); html = escapeHtml(text); },
  });
  Object.defineProperty(el, "className", {
    get() { return Array.from(classes).join(" "); },
    set(value) {
      classes.clear();
      String(value || "").split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
  });
  return el;
}

function loadPwa(options = {}) {
  const byId = new Map();
  const documentListeners = {};
  let monotonic = options.monotonic || 100;
  let intervalCount = 0;
  const intervalDelays = [];
  const testApi = {};

  const document = {
    readyState: "loading",
    visibilityState: options.visibilityState || "visible",
    createElement: fakeElement,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fakeElement());
      return byId.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { documentListeners[type] = fn; },
    dispatch(type) { if (documentListeners[type]) documentListeners[type](); },
  };

  class FakeNotification {
    constructor(title, config) {
      this.title = title;
      this.config = config;
      this.closed = false;
      FakeNotification.instances.push(this);
    }
    close() { this.closed = true; }
    static requestPermission() { return Promise.resolve(FakeNotification.permission); }
  }
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];

  const navigator = options.navigator || { serviceWorker: null };
  const window = {
    __CLAWD_MOBILE_TEST__: testApi,
    Notification: FakeNotification,
    location: { search: "", pathname: "/mobile/" },
    addEventListener() {},
  };

  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; FakeWebSocket.instances.push(this); }
    close() {}
    send() {}
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.instances = [];

  const sandbox = {
    window,
    document,
    navigator,
    Notification: FakeNotification,
    WebSocket: FakeWebSocket,
    URLSearchParams,
    history: { replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    performance: { now() { return monotonic; } },
    requestAnimationFrame(fn) { fn(); return 1; },
    setTimeout,
    clearTimeout,
    setInterval(fn, delay) { intervalCount++; intervalDelays.push(delay); return intervalCount; },
    clearInterval() {},
    console,
    Map,
    Set,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(APP_SOURCE, sandbox, { filename: "pwa/app.js" });

  return {
    classes: testApi.exports,
    document,
    byId,
    navigator,
    FakeNotification,
    FakeWebSocket,
    intervalCount: () => intervalCount,
    intervalDelays,
    setMonotonic(value) { monotonic = value; },
  };
}

function permission(overrides = {}) {
  return {
    requestId: "0123456789abcdef0123456789abcdef",
    agentId: "claude-code",
    toolName: "Bash",
    summary: "Run project tests",
    folder: "clawd-on-desk",
    presentedAt: 1000,
    ...overrides,
  };
}

function fakeNotifier() {
  return {
    active: new Set(),
    notified: [],
    dismissed: [],
    cleared: 0,
    syncPermissionIds(ids) {
      const next = new Set(ids);
      this.active.forEach((id) => { if (!next.has(id)) this.dismissed.push(id); });
      this.active = next;
    },
    notifyPermission(id) {
      if (this.active.has(id)) return false;
      this.active.add(id);
      this.notified.push(id);
      return true;
    },
    dismissPermission(id) { this.active.delete(id); this.dismissed.push(id); },
    clearPermissionNotifications() { this.active.clear(); this.cleared++; },
  };
}

function fakeTicker() {
  return { callbacks: [], register(fn) { this.callbacks.push(fn); return function() {}; } };
}

describe("PWA read-only permission banners", () => {
  it("owns a container outside SessionRenderer's replacement node", () => {
    const permissionPos = HTML_SOURCE.indexOf('id="permission-banner-container"');
    const sessionPos = HTML_SOURCE.indexOf('id="session-list"');
    assert.ok(permissionPos >= 0 && sessionPos > permissionPos);

    const h = loadPwa();
    const ticker = fakeTicker();
    const permissionContainer = fakeElement();
    const sessionContainer = fakeElement();
    const banner = new h.classes.PermissionBanner(permissionContainer, fakeNotifier(), ticker);
    banner.replace({ supported: true, enabled: true }, [permission()], 11000);
    const before = permissionContainer.innerHTML;

    const renderer = new h.classes.SessionRenderer(sessionContainer, ticker);
    renderer.updateFromSnapshot({ one: { state: "working", agentId: "codex", updatedAt: 1000 } });
    assert.strictEqual(permissionContainer.innerHTML, before);
    assert.match(sessionContainer.innerHTML, /session-card/);
  });

  it("renders unsupported, disabled, empty, pending, and stale states", () => {
    const h = loadPwa();
    const container = fakeElement();
    const banner = new h.classes.PermissionBanner(container, fakeNotifier(), fakeTicker());
    assert.strictEqual(container.getAttribute("data-state"), "unknown");
    assert.ok(container.classList.contains("hidden"));

    banner.replace({ supported: false, enabled: false }, [], 1000);
    assert.strictEqual(container.getAttribute("data-state"), "unsupported");
    assert.match(container.innerHTML, /桌面端不支持权限预览/);
    assert.strictEqual(container.classList.contains("hidden"), false);

    banner.replace({ supported: true, enabled: false }, [], 1000);
    assert.strictEqual(container.getAttribute("data-state"), "disabled");
    assert.match(container.innerHTML, /桌面端未开启权限预览/);
    assert.strictEqual(container.classList.contains("hidden"), false);

    banner.replace({ supported: true, enabled: true }, [], 1000);
    assert.strictEqual(container.getAttribute("data-state"), "empty");
    assert.match(container.innerHTML, /暂无待处理请求/);

    banner.upsert(permission(), 2000);
    assert.strictEqual(container.getAttribute("data-state"), "pending");
    assert.match(container.innerHTML, /permission-card/);

    banner.setDisconnected(true);
    assert.strictEqual(container.getAttribute("data-state"), "stale");
    assert.match(container.innerHTML, /状态可能已过期/);
  });

  it("idempotently upserts/retracts and escapes every remote display field", () => {
    const h = loadPwa();
    const notifier = fakeNotifier();
    const container = fakeElement();
    const banner = new h.classes.PermissionBanner(container, notifier, fakeTicker());
    banner.replace({ supported: true, enabled: true }, [], 1000);
    const dangerous = permission({
      agentId: '<img src=x onerror="agent">',
      toolName: "<script>tool()</script>",
      summary: "<b>summary</b>",
      folder: "<folder>",
    });

    assert.strictEqual(banner.upsert(dangerous, 2000), true);
    assert.strictEqual(banner.upsert(dangerous, 2000), false);
    assert.strictEqual(banner.records.size, 1);
    assert.deepStrictEqual(notifier.notified, [dangerous.requestId]);
    assert.ok(!container.innerHTML.includes("<script>"));
    assert.ok(!container.innerHTML.includes("<img"));
    assert.match(container.innerHTML, /&lt;script&gt;tool\(\)&lt;\/script&gt;/);
    assert.match(container.innerHTML, /&lt;b&gt;summary&lt;\/b&gt;/);
    assert.strictEqual(banner.retract("missing"), false);
    assert.strictEqual(banner.retract(dangerous.requestId), true);
    assert.strictEqual(banner.records.size, 0);
  });

  it("rejects non-canonical request IDs at the PWA trust boundary", () => {
    const h = loadPwa();
    const container = fakeElement();
    const notifier = fakeNotifier();
    const banner = new h.classes.PermissionBanner(container, notifier, fakeTicker());
    banner.replace({ supported: true, enabled: true }, [], 1000);
    assert.strictEqual(banner.upsert(permission({ requestId: '\" onfocus=\"alert(1)' }), 1000), false);
    assert.strictEqual(banner.records.size, 0);
    assert.deepStrictEqual(notifier.notified, []);
  });

  it("keeps the one-second waiting label out of the polite live region", () => {
    const h = loadPwa();
    const container = fakeElement();
    const banner = new h.classes.PermissionBanner(container, fakeNotifier(), fakeTicker());
    banner.replace({ supported: true, enabled: true }, [permission()], 1000);
    assert.match(container.innerHTML, /permission-time[^>]*aria-live="off"[^>]*aria-hidden="true"/);
  });

  it("authoritative replacement removes old cards without notifying snapshot records", () => {
    const h = loadPwa();
    const notifier = fakeNotifier();
    const container = fakeElement();
    const banner = new h.classes.PermissionBanner(container, notifier, fakeTicker());
    const first = permission();
    banner.replace({ supported: true, enabled: true }, [first], 2000);
    assert.deepStrictEqual(notifier.notified, []);
    assert.strictEqual(banner.records.size, 1);

    const second = permission({ requestId: "fedcba9876543210fedcba9876543210", toolName: "Write" });
    banner.replace({ supported: true, enabled: true }, [second], 3000);
    assert.ok(notifier.dismissed.includes(first.requestId));
    assert.strictEqual(banner.records.has(first.requestId), false);
    assert.strictEqual(banner.records.has(second.requestId), true);
    assert.deepStrictEqual(notifier.notified, []);
  });

  it("uses server-domain age-at-receipt plus monotonic local elapsed", () => {
    const h = loadPwa({ monotonic: 100 });
    const ticker = fakeTicker();
    const container = fakeElement();
    const banner = new h.classes.PermissionBanner(container, fakeNotifier(), ticker);
    banner.replace({ supported: true, enabled: true }, [permission({ presentedAt: 1000 })], 11000);
    const time = fakeElement("span");
    time.setAttribute("data-permission-id", permission().requestId);
    container.queryResults = [time];
    h.setMonotonic(5100);
    ticker.callbacks[0]();
    assert.strictEqual(time.textContent, "已等待 15 秒");
  });

  it("adds no PermissionBanner interval and preserves one shared ticker plus stale cleanup", () => {
    const h = loadPwa();
    const ticker = new h.classes.RelativeTimeTicker();
    const banner = new h.classes.PermissionBanner(fakeElement(), fakeNotifier(), ticker);
    banner.replace({ supported: true, enabled: true }, [], 1000);
    banner.upsert(permission(), 2000);
    banner.retract(permission().requestId);
    const renderer = new h.classes.SessionRenderer(fakeElement(), ticker);
    renderer.startStaleCleanup();
    assert.strictEqual(h.intervalCount(), 2);
    assert.deepStrictEqual(h.intervalDelays, [1000, 15000]);
  });
});

describe("PWA permission notifications and access reset", () => {
  it("does not resurrect a notification after service-worker readiness settles late", async () => {
    let resolveReady;
    let shown = 0;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const navigator = { serviceWorker: { controller: {}, ready } };
    const h = loadPwa({ visibilityState: "hidden", navigator });
    const notifier = new h.classes.NotificationManager();
    notifier.permission = "granted";
    notifier.notifyPermission("late");
    notifier.dismissPermission("late");
    resolveReady({
      showNotification() { shown++; return Promise.resolve(); },
      getNotifications() { return Promise.resolve([]); },
    });
    await ready;
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(shown, 0);
  });

  it("closes a notification whose show promise settles after retract", async () => {
    let resolveShow;
    let landed = false;
    let closed = 0;
    const showPromise = new Promise((resolve) => { resolveShow = resolve; });
    const registration = {
      showNotification() { return showPromise; },
      getNotifications() {
        return Promise.resolve(landed ? [{ close() { closed++; } }] : []);
      },
    };
    const navigator = { serviceWorker: { controller: {}, ready: Promise.resolve(registration) } };
    const h = loadPwa({ visibilityState: "hidden", navigator });
    const notifier = new h.classes.NotificationManager();
    notifier.permission = "granted";

    notifier.notifyPermission("late-show");
    await Promise.resolve();
    notifier.dismissPermission("late-show");
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(closed, 0);

    landed = true;
    resolveShow();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(closed >= 1);
  });

  it("uses a generic notification and closes it on retract", async () => {
    const shown = [];
    let closed = 0;
    const registration = {
      showNotification(title, options) { shown.push({ title, options }); return Promise.resolve(); },
      getNotifications() { return Promise.resolve([{ close() { closed++; } }]); },
    };
    const navigator = { serviceWorker: { controller: {}, ready: Promise.resolve(registration) } };
    const h = loadPwa({ visibilityState: "hidden", navigator });
    const notifier = new h.classes.NotificationManager();
    notifier.permission = "granted";
    notifier.notifyPermission("opaque-id");
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].options.tag, "clawd-perm-opaque-id");
    assert.strictEqual(shown[0].options.body, "Clawd 有一个待处理的权限请求。");
    assert.ok(!/summary|folder|command/i.test(shown[0].options.body));

    notifier.dismissPermission("opaque-id");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(closed >= 1);
  });

  it("authoritative empty replacement closes orphaned permission notifications", async () => {
    let permissionClosed = 0;
    let sessionClosed = 0;
    const registration = {
      getNotifications() {
        return Promise.resolve([
          { tag: "clawd-perm-orphan", close() { permissionClosed++; } },
          { tag: "clawd-working", close() { sessionClosed++; } },
        ]);
      },
    };
    const navigator = { serviceWorker: { controller: {}, ready: Promise.resolve(registration) } };
    const h = loadPwa({ visibilityState: "hidden", navigator });
    const notifier = new h.classes.NotificationManager();
    notifier.syncPermissionIds([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(permissionClosed, 1);
    assert.strictEqual(sessionClosed, 0);
  });

  it("a delayed snapshot cleanup cannot close a later live notification", async () => {
    let resolveReady;
    let closed = 0;
    let shown = 0;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const navigator = { serviceWorker: { controller: {}, ready } };
    const h = loadPwa({ visibilityState: "hidden", navigator });
    const notifier = new h.classes.NotificationManager();
    notifier.permission = "granted";
    notifier.syncPermissionIds([]);
    notifier.notifyPermission("new-live");
    resolveReady({
      getNotifications() {
        return Promise.resolve([{ tag: "clawd-perm-new-live", close() { closed++; } }]);
      },
      showNotification() { shown++; return Promise.resolve(); },
    });
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(shown, 1);
    assert.strictEqual(closed, 0);
  });

  it("handles code 1008 reset and blocks visibility-driven reconnect until re-pair", () => {
    const h = loadPwa();
    const connection = new h.classes.ConnectionManager();
    connection.config = { host: "127.0.0.1", port: 23333, token: "x" };
    let reset = 0;
    let disconnected = 0;
    connection.onAccessReset = function() { reset++; };
    connection.onDisconnected = function() { disconnected++; };
    connection._doConnect();
    const socket = h.FakeWebSocket.instances[0];
    socket.onclose({ code: 1008, reason: "mobile access reset" });
    assert.strictEqual(reset, 1);
    assert.strictEqual(disconnected, 0);
    assert.strictEqual(connection.state, "auth_failed");
    assert.strictEqual(connection.authBlocked, true);

    h.document.visibilityState = "hidden";
    h.document.dispatch("visibilitychange");
    h.document.visibilityState = "visible";
    h.document.dispatch("visibilitychange");
    assert.strictEqual(h.FakeWebSocket.instances.length, 1, "visibility must not revive the rejected token");

    connection.connect({ host: "127.0.0.1", port: 23333, token: "new-token" });
    assert.strictEqual(connection.authBlocked, false);
    assert.strictEqual(h.FakeWebSocket.instances.length, 2, "explicit re-pair may reconnect");
  });

  it("treats code 4001 consent refresh as a reconnectable ordinary disconnect", () => {
    const h = loadPwa();
    const connection = new h.classes.ConnectionManager();
    connection.config = { host: "127.0.0.1", port: 23333, token: "unchanged" };
    let reset = 0;
    let disconnected = 0;
    let reconnect = 0;
    connection.onAccessReset = function() { reset++; };
    connection.onDisconnected = function() { disconnected++; };
    connection._scheduleReconnect = function() { reconnect++; this._setState("reconnecting"); };
    connection._doConnect();
    const socket = h.FakeWebSocket.instances[0];
    socket.onclose({ code: 4001, reason: "Permission preview consent changed" });
    assert.strictEqual(reset, 0);
    assert.strictEqual(disconnected, 1);
    assert.strictEqual(reconnect, 1);
    assert.strictEqual(connection.state, "reconnecting");
  });
});

describe("PWA static and protocol contracts", () => {
  it("contains reduced-motion permission styling and cache v7", () => {
    assert.match(CSS_SOURCE, /prefers-reduced-motion:\s*reduce/);
    assert.match(CSS_SOURCE, /\.permission-card\s*\{\s*animation:\s*none/);
    assert.match(SW_SOURCE, /clawd-mobile-v7/);
    assert.ok(!SW_SOURCE.includes("clawd-mobile-v6"));
  });

  it("documents the read-only additive protocol and its security limits", () => {
    for (const term of [
      "permission_snapshot", "permission_request", "permission_dismissed",
      "token_rotate", "token_rotate_ack", "permission_response",
      "plaintext WebSocket", "0.0.0.0", "best-effort", "no device roster",
    ]) assert.ok(PROTOCOL_SOURCE.includes(term), `missing protocol term: ${term}`);
    assert.ok(!PROTOCOL_SOURCE.includes("polls the desktop session cache every 2 seconds"));
  });
});
