"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { describe, it } = require("node:test");

// ── Mock electron before requiring permission.js ──
// permission.js does `const { BrowserWindow, globalShortcut } = require("electron")`
// at load, and handleImeEditing() calls BrowserWindow.fromWebContents(event.sender)
// to map the IPC sender back to its perm entry. The test runtime's
// require("electron") returns a path string (no BrowserWindow), so mock it: a
// sender resolves to its window via a `__win` sentinel.
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

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");
}

// The macOS IME-occlusion fix spans three processes: the bubble renderer
// detects text-input focus, the preload forwards it over IPC, and the main
// process (permission.js) drops the bubble out of always-on-top while a text
// field is focused. This smoke test guards the wiring end to end so a change
// in one file that silently breaks the chain gets caught.
describe("macOS IME editing wiring", () => {
  it("renderer reports text-input focus/blur to the main process", () => {
    const renderer = read("bubble-renderer.js");
    assert.match(renderer, /addEventListener\("focusin"/);
    assert.match(renderer, /addEventListener\("focusout"/);
    assert.match(renderer, /setImeEditing\(true\)/);
    assert.match(renderer, /setImeEditing\(false\)/);
    // Element-level focus events miss whole-window focus loss (Cmd-Tab away
    // mid-composition), so a window-level blur net must clear the editing state.
    assert.match(renderer, /window\.addEventListener\("blur"/);
  });

  it("preload exposes setImeEditing over the bubble-ime-editing channel", () => {
    const preload = read("preload-bubble.js");
    assert.match(preload, /setImeEditing:/);
    assert.match(preload, /"bubble-ime-editing"/);
  });

  it("permission main handles the channel and toggles the editing flag", () => {
    const permission = read("permission.js");
    assert.match(permission, /on\("bubble-ime-editing"/);
    assert.match(permission, /function handleImeEditing/);
    assert.match(permission, /__clawdMacImeEditing = true/);
    // Text-input bubbles opt out of the native SkyLight stationary treatment.
    assert.match(permission, /__clawdMacTextInputBubble = true/);
  });
});

// handleImeEditing only flips the __clawdMacImeEditing flag and defers the
// actual window-visibility change to reapplyMacVisibility (single source of
// truth). It early-returns off macOS, so the behavioral assertions run on darwin.
const macOnly = { skip: process.platform !== "darwin" ? "macOS-only" : false };

function makeCtx(reapplySpy) {
  return {
    reapplyMacVisibility: reapplySpy,
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    focusTerminalForSession: () => {},
    win: null,
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
  };
}

function makeBubble(overrides = {}) {
  return { isDestroyed: () => false, ...overrides };
}
function eventFor(bubble) {
  return { sender: { __win: bubble } };
}

describe("handleImeEditing (macOS)", () => {
  it("sets the flag on focus and clears it on blur, reapplying each time", macOnly, () => {
    const reapply = [];
    const ctx = makeCtx(() => reapply.push(true));
    const { handleImeEditing, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble();
    pendingPermissions.push({ bubble });

    handleImeEditing(eventFor(bubble), true);
    assert.strictEqual(bubble.__clawdMacImeEditing, true);
    assert.strictEqual(reapply.length, 1);

    handleImeEditing(eventFor(bubble), false);
    assert.strictEqual(bubble.__clawdMacImeEditing, undefined);
    assert.strictEqual(reapply.length, 2);
  });

  it("ignores a sender that matches no pending permission", macOnly, () => {
    const reapply = [];
    const ctx = makeCtx(() => reapply.push(true));
    const { handleImeEditing, pendingPermissions } = initPermission(ctx);
    pendingPermissions.push({ bubble: makeBubble() });

    handleImeEditing(eventFor(makeBubble()), true); // different, unmatched window
    assert.strictEqual(reapply.length, 0);
  });

  it("ignores a destroyed bubble instead of touching it", macOnly, () => {
    const reapply = [];
    const ctx = makeCtx(() => reapply.push(true));
    const { handleImeEditing, pendingPermissions } = initPermission(ctx);
    const bubble = makeBubble({ isDestroyed: () => true });
    pendingPermissions.push({ bubble });

    handleImeEditing(eventFor(bubble), true);
    assert.strictEqual(bubble.__clawdMacImeEditing, undefined);
    assert.strictEqual(reapply.length, 0);
  });
});
