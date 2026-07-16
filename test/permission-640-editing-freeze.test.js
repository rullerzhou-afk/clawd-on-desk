"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

// ── Mock electron before requiring permission.js (same pattern as
// permission-ime-editing.test.js): handleImeEditing and friends resolve IPC
// senders via BrowserWindow.fromWebContents, and the test runtime's
// require("electron") returns a path string.
const __electronMock = {
  BrowserWindow: { fromWebContents: (sender) => (sender && sender.__win) || null },
  globalShortcut: {
    register: () => {}, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false,
  },
};
const __origModuleLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return __electronMock;
  return __origModuleLoad.apply(this, arguments);
};
const initPermission = require("../src/permission");
Module._load = __origModuleLoad;

function makeCtx(overrides = {}) {
  return {
    reapplyMacVisibility: () => {},
    syncImeEditingPetDodge: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => ({ x: 200, y: 200, width: 120, height: 120 }),
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    focusTerminalForSession: () => {},
    win: { isDestroyed: () => false },
    bubbleFollowPet: true,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    pendingPermissions: [],
    subscribeShortcuts: () => () => {},
    onPermissionsChanged: () => {},
    onPermissionResolved: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makeBubble(overrides = {}) {
  return {
    isDestroyed: () => false,
    setBoundsCalls: [],
    setBounds(bounds) { this.setBoundsCalls.push(bounds); },
    getBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }),
    ...overrides,
  };
}

describe("repositionBubbles freeze while editing (#640)", () => {
  it("skips the bubble being typed into and still places the others", () => {
    const ctx = makeCtx();
    const { repositionBubbles, pendingPermissions } = initPermission(ctx);

    const frozen = makeBubble();
    frozen.__clawdMacImeEditing = true;
    const normal = makeBubble();
    pendingPermissions.push(
      { bubble: frozen, suggestions: [], measuredHeight: 120 },
      { bubble: normal, suggestions: [], measuredHeight: 120 },
    );

    repositionBubbles();

    assert.strictEqual(frozen.setBoundsCalls.length, 0,
      "the editing bubble must hold its position");
    assert.strictEqual(normal.setBoundsCalls.length, 1,
      "non-editing bubbles still get placed");
  });

  it("places every bubble again once editing ends", () => {
    const ctx = makeCtx();
    const { repositionBubbles, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble();
    bubble.__clawdMacImeEditing = true;
    pendingPermissions.push({ bubble, suggestions: [], measuredHeight: 120 });

    repositionBubbles();
    assert.strictEqual(bubble.setBoundsCalls.length, 0);

    delete bubble.__clawdMacImeEditing;
    repositionBubbles();
    assert.strictEqual(bubble.setBoundsCalls.length, 1);
  });
});

// #640: the dodge re-scan is funneled through notifyPermissionsChanged, so it
// fires on EVERY pendingPermissions change regardless of platform or editing
// state — the platform gate and the edge-trigger live in topmost-runtime.js
// (covered by topmost-runtime.test.js). What matters here is that every
// production removal path reaches the scan, because a bubble can leave the
// list while its text field still holds focus (Enter submit, auto-close) and
// no blur will ever fire to restore the pet.
describe("pendingPermissions changes re-run the dodge scan (#640)", () => {
  it("fires when removePendingPermission drops a mid-edit bubble", () => {
    const syncs = [];
    const ctx = makeCtx({ syncImeEditingPetDodge: () => syncs.push(true) });
    const { removePendingPermission, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble();
    bubble.__clawdMacImeEditing = true;
    const perm = { bubble, suggestions: [] };
    pendingPermissions.push(perm);

    removePendingPermission(perm, "test");

    assert.strictEqual(syncs.length, 1,
      "removing an editing bubble must re-run the dodge scan");
  });

  it("fires on resolvePermissionEntry — the path Allow/Deny, Enter submit, and auto-close use", () => {
    const syncs = [];
    const ctx = makeCtx({ syncImeEditingPetDodge: () => syncs.push(true) });
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble({ webContents: { send: () => {} } });
    bubble.__clawdMacImeEditing = true;
    const perm = {
      bubble,
      suggestions: [],
      createdAt: Date.now(),
      res: null, // client gone — resolve still must splice and re-scan
    };
    pendingPermissions.push(perm);

    resolvePermissionEntry(perm, "no-decision", "Auto-closed");

    assert.strictEqual(pendingPermissions.length, 0,
      "entry must be spliced by resolvePermissionEntry");
    assert.strictEqual(syncs.length, 1,
      "resolving an editing bubble must re-run the dodge scan — this is the "
      + "production close path, which never goes through removePendingPermission");
    if (perm.hideTimer) clearTimeout(perm.hideTimer);
  });

  it("survives a throwing sync without breaking the removal", () => {
    const ctx = makeCtx({ syncImeEditingPetDodge: () => { throw new Error("boom"); } });
    const { removePendingPermission, pendingPermissions } = initPermission(ctx);

    const perm = { bubble: makeBubble(), suggestions: [] };
    pendingPermissions.push(perm);

    assert.strictEqual(removePendingPermission(perm, "test"), true);
    assert.strictEqual(pendingPermissions.length, 0);
  });
});

// #640: a crashed bubble renderer can never send the focusout/window-blur IPC
// that clears the editing flag — the render-process-gone listener routes here.
describe("handleBubbleRendererGone (#640)", () => {
  it("clears a stuck editing flag and re-runs the visibility pass", () => {
    const reapply = [];
    const ctx = makeCtx({ reapplyMacVisibility: () => reapply.push(true) });
    const { handleBubbleRendererGone } = initPermission(ctx);

    const bubble = makeBubble();
    bubble.__clawdMacImeEditing = true;

    handleBubbleRendererGone(bubble);

    assert.strictEqual(bubble.__clawdMacImeEditing, undefined,
      "a dead renderer can't clear the flag itself — this must");
    assert.strictEqual(reapply.length, 1);
  });

  it("does nothing for a bubble that was not mid-edit", () => {
    const reapply = [];
    const ctx = makeCtx({ reapplyMacVisibility: () => reapply.push(true) });
    const { handleBubbleRendererGone } = initPermission(ctx);

    handleBubbleRendererGone(makeBubble());
    handleBubbleRendererGone(null);

    assert.strictEqual(reapply.length, 0);
  });
});
