"use strict";

// #601: hiding the pet must not kill the permission hotkeys wholesale. New
// requests still pop bubbles while hidden (docs/project/theme-state-ui.md), so
// the hotkeys stay registered exactly when a visible bubble exists — and a
// keypress must never resolve a collapsed (invisible) request.

const assert = require("node:assert");
const Module = require("node:module");
const { afterEach, test } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

const ALLOW_ACCEL = "CommandOrControl+Shift+Y";
const DENY_ACCEL = "CommandOrControl+Shift+N";

function loadPermissionWithMocks({ electron, platform = "win32" }) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatform.enumerable,
    value: platform,
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "child_process") return { execFile() {} };
    return originalLoad.apply(this, arguments);
  };

  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createGlobalShortcut() {
  const registered = new Map();
  return {
    registered,
    register(accelerator, handler) {
      registered.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || {};
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
    },
    on() {},
    removeListener() {},
  };
}

function createFakeBubble({ visible }) {
  return {
    destroyed: false,
    visible,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    hide() { this.visible = false; },
    showInactive() { this.visible = true; },
    destroy() { this.destroyed = true; },
    webContents: { send() {} },
  };
}

function createContext() {
  return {
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    subscribeShortcuts: () => () => {},
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    permDebugLog: null,
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
  };
}

function loadPermission() {
  const globalShortcut = createGlobalShortcut();
  const initPermission = loadPermissionWithMocks({
    electron: {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut,
    },
  });
  const context = createContext();
  return { permission: initPermission(context), context, globalShortcut };
}

function pushPending(permission, { bubble = null, res = createResponse() } = {}) {
  const entry = {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-hidden-pet",
    bubble,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
  };
  permission.pendingPermissions.push(entry);
  return entry;
}

afterEach(() => {
  delete require.cache[PERMISSION_MODULE_PATH];
});

test("pet hidden: hotkeys unregister when only collapsed bubbles remain", () => {
  const { permission, context, globalShortcut } = loadPermission();
  pushPending(permission, { bubble: createFakeBubble({ visible: true }) });
  permission.syncPermissionShortcuts();
  assert.ok(globalShortcut.registered.has(ALLOW_ACCEL));

  // Hiding the pet collapses the pending bubble, then re-syncs the shortcuts.
  context.petHidden = true;
  permission.pendingPermissions[0].bubble.hide();
  permission.syncPermissionShortcuts();

  assert.strictEqual(globalShortcut.registered.size, 0);
});

test("pet hidden: a new visible bubble keeps the hotkeys registered", () => {
  const { permission, context, globalShortcut } = loadPermission();
  context.petHidden = true;
  pushPending(permission, { bubble: createFakeBubble({ visible: true }) });
  permission.syncPermissionShortcuts();

  assert.ok(globalShortcut.registered.has(ALLOW_ACCEL));
  assert.ok(globalShortcut.registered.has(DENY_ACCEL));
});

test("pet hidden: hotkey resolves the visible request, never the collapsed one", () => {
  const { permission, context, globalShortcut } = loadPermission();
  const collapsedRes = createResponse();
  const visibleRes = createResponse();
  const collapsed = pushPending(permission, {
    bubble: createFakeBubble({ visible: false }),
    res: collapsedRes,
  });
  pushPending(permission, {
    bubble: createFakeBubble({ visible: true }),
    res: visibleRes,
  });
  context.petHidden = true;
  permission.syncPermissionShortcuts();

  const handler = globalShortcut.registered.get(ALLOW_ACCEL);
  assert.strictEqual(typeof handler, "function");
  handler();

  assert.strictEqual(visibleRes.statusCode, 200);
  assert.match(visibleRes.body, /"behavior":"allow"/);
  assert.strictEqual(collapsedRes.statusCode, null);
  assert.deepStrictEqual(permission.pendingPermissions, [collapsed]);
  // Only the collapsed request remains, so the resolve-path re-sync must have
  // dropped the hotkeys again.
  assert.strictEqual(globalShortcut.registered.size, 0);
});

// Defensive: real hide semantics only produce collapsed-older + visible-newer,
// but the invariant is "newest VISIBLE wins", not "newest pending" — lock it in
// against a future reordering or an out-of-band collapsed newer bubble.
test("pet hidden: hotkey targets the newest visible request even when a newer one is collapsed", () => {
  const { permission, context, globalShortcut } = loadPermission();
  const visibleRes = createResponse();
  const collapsedRes = createResponse();
  pushPending(permission, {
    bubble: createFakeBubble({ visible: true }),
    res: visibleRes,
  });
  pushPending(permission, {
    bubble: createFakeBubble({ visible: false }),
    res: collapsedRes,
  });
  context.petHidden = true;
  permission.syncPermissionShortcuts();

  const handler = globalShortcut.registered.get(ALLOW_ACCEL);
  assert.strictEqual(typeof handler, "function");
  handler();

  assert.strictEqual(visibleRes.statusCode, 200);
  assert.match(visibleRes.body, /"behavior":"allow"/);
  assert.strictEqual(collapsedRes.statusCode, null);
  assert.strictEqual(permission.pendingPermissions.length, 1);
});

test("pet visible: a pending entry without a bubble window still registers hotkeys", () => {
  const { permission, globalShortcut } = loadPermission();
  pushPending(permission, { bubble: null });
  permission.syncPermissionShortcuts();

  assert.ok(globalShortcut.registered.has(ALLOW_ACCEL));
  assert.ok(globalShortcut.registered.has(DENY_ACCEL));
});
