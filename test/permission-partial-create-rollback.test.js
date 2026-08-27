"use strict";

// Partial-create rollback for showPermissionBubble: a synchronous throw after
// the BrowserWindow exists (platform APIs, shortcut sync, autoclose arming)
// must destroy the window instead of orphaning it with live close handlers
// while the route-level catch drops the pending entry.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function loadPermissionWithElectron(fakeElectron) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function createRollbackHarness({ throwAt }) {
  const createdWindows = [];
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this._closedHandler = null;
      this._didFinishLoad = null;
      this.sentEvents = [];
      this.webContents = {
        once: (event, cb) => {
          if (event === "did-finish-load") this._didFinishLoad = cb;
        },
        on() {},
        send: (...args) => { this.sentEvents.push(args); },
      };
      createdWindows.push(this);
    }
    setAlwaysOnTop() {}
    setBounds() {}
    loadFile() {
      if (typeof this._didFinishLoad === "function") this._didFinishLoad();
    }
    showInactive() {
      if (throwAt === "showInactive" && this === createdWindows[0]) {
        throw new Error("showInactive boom");
      }
    }
    setSkipTaskbar() {}
    on(event, cb) {
      if (event === "closed") this._closedHandler = cb;
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      this.destroyed = true;
      if (typeof this._closedHandler === "function") this._closedHandler();
    }
  }

  const fakeElectron = {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      fromWebContents() { return null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const permissionFactory = loadPermissionWithElectron(fakeElectron);
  const api = permissionFactory({
    win: { isDestroyed() { return false; } },
    hideBubbles: false,
    doNotDisturb: false,
    bubbleFollowPet: false,
    sessions: new Map(),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    isAgentPermissionsEnabled: () => true,
    subscribeShortcuts: () => () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    repositionUpdateBubble: () => {},
    focusTerminalForSession: () => {},
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
  });
  return { api, createdWindows };
}

function makeZcodeEntry(api) {
  const entry = {
    sessionId: "zcode:s1",
    agentId: "zcode",
    isZcode: true,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    interaction: classifyPermissionInteraction({ agentId: "zcode", toolName: "Bash" }),
    suggestions: [],
    bubble: null,
    hideTimer: null,
    createdAt: Date.now(),
  };
  api.pendingPermissions.push(entry);
  return entry;
}

function makeAskEntry(api, sessionId) {
  const entry = {
    sessionId,
    agentId: "claude-code",
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [{
        question: "Choose one",
        options: [{ label: "One", description: "First option" }],
      }],
    },
    interaction: classifyPermissionInteraction({
      agentId: "claude-code",
      toolName: "AskUserQuestion",
    }),
    suggestions: [],
    bubble: null,
    hideTimer: null,
    createdAt: Date.now(),
  };
  api.addPendingPermission(entry);
  return entry;
}

describe("showPermissionBubble partial-create rollback", () => {
  it("destroys the window and rethrows when a post-create step throws", () => {
    const { api, createdWindows } = createRollbackHarness({ throwAt: "showInactive" });
    const entry = makeZcodeEntry(api);

    assert.throws(() => api.showPermissionBubble(entry), /showInactive boom/);

    // The window was torn down — no orphaned BrowserWindow with live handlers.
    assert.strictEqual(createdWindows.length, 1);
    assert.strictEqual(createdWindows[0].destroyed, true);
    // The entry no longer points at the destroyed window; the route-level
    // catch owns removing it from pendingPermissions and answering 204.
    assert.strictEqual(entry.bubble, null);
  });

  it("leaves no window behind when nothing throws (control)", () => {
    const { api, createdWindows } = createRollbackHarness({ throwAt: null });
    const entry = makeZcodeEntry(api);

    api.showPermissionBubble(entry);

    assert.strictEqual(createdWindows.length, 1);
    assert.strictEqual(createdWindows[0].destroyed, false);
    assert.strictEqual(entry.bubble, createdWindows[0]);
  });

  it("rolls back a creation-time Ask owner so the next Ask can expand", () => {
    const { api, createdWindows } = createRollbackHarness({ throwAt: "showInactive" });
    const failed = makeAskEntry(api, "ask-failed");

    assert.throws(() => api.showPermissionBubble(failed), /showInactive boom/);
    assert.strictEqual(failed.expanded, false);
    api.removePendingPermission(failed, "route-create-failed");

    const next = makeAskEntry(api, "ask-next");
    api.showPermissionBubble(next);

    assert.strictEqual(next.expanded, true,
      "the failed window must not leave a stale expanded owner behind");
    assert.strictEqual(createdWindows[1].destroyed, false);
  });
});
