// Wire-level tests for the "Go to Terminal" (deny-and-focus) action on
// regular permission cards (issue #689). The renderer DOM half of the chain
// is covered by bubble-go-to-terminal.test.js; these tests pin the backend
// half: handleDecide → per-protocol wire outcome. They guard the two P0s
// found in the first cut of the fix:
//   1. CC/CodeBuddy block on the PermissionRequest HTTP hook (600s) and show
//      nothing in the terminal while it is pending. The socket must be
//      DESTROYED (dropped connection = non-blocking hook error → native
//      prompt takes over immediately), never parked until the hook timeout,
//      and never answered with a deny on the user's behalf.
//   2. The hermes plugin treats a 204 no-decision exactly like allow
//      (fail-open past its CLAWD_HERMES_PERMISSION_TOOLS gate), so the bubble
//      payload must forward isHermes for the renderer to suppress the action,
//      and the defensive handleDecide branch must still never emit a deny.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ── Mock electron before requiring permission.js (same seam as
// permission-plan-feedback.test.js) ──
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

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    listeners: {},
  };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    setHeader(key, value) { captured.headers[key] = value; },
    writeHead(status, headers) {
      captured.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(captured.headers, headers);
    },
    write(chunk) { captured.body = (captured.body || "") + String(chunk); },
    end(chunk) {
      if (chunk !== undefined) captured.body = (captured.body || "") + String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    on(evt, fn) {
      (captured.listeners[evt] = captured.listeners[evt] || []).push(fn);
    },
    removeListener(evt, fn) {
      const arr = captured.listeners[evt] || [];
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    destroy() { this.destroyed = true; },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalCalls: [],
    focusTerminalForSession(sessionId, opts) {
      this.focusTerminalCalls.push({ sessionId, opts });
    },
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    updateDebugLog: null,
    sessionDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    pendingPermissions: [],
    subscribeShortcuts: () => () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    onPermissionsChanged: () => {},
    onPermissionResolved: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makeFakeBubble() {
  return { isDestroyed: () => false, webContents: { send: () => {} }, destroy: () => {} };
}
function makeEventFor(bubble) {
  return { sender: { __win: bubble } };
}

function makePermEntry(res, overrides = {}) {
  const entry = {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "wire-session-1",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf build" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
  // Mirror the server route: the abort handler is registered on the socket.
  res.on("close", entry.abortHandler);
  return entry;
}

describe("go-to-terminal wire semantics (issue #689)", () => {
  it("destroys the CC hook socket without a decision and focuses the terminal", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions, handleDecide } = perm;

    const res = createMockResponse();
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(res, { bubble });
    pendingPermissions.push(permEntry);

    handleDecide(makeEventFor(bubble), "deny-and-focus");

    // Dropped, not parked; empty, not denied.
    assert.strictEqual(res.destroyed, true, "hook socket must be destroyed immediately");
    assert.strictEqual(res.captured.ended, false, "no response may be written");
    assert.strictEqual(res.captured.body, null, "no decision body may be written");
    // Abort handler detached before destroy — the close event can't
    // double-resolve the removed entry.
    assert.deepStrictEqual(res.captured.listeners.close, [], "close listener must be detached");
    assert.strictEqual(pendingPermissions.indexOf(permEntry), -1, "entry must be removed");
    assert.strictEqual(ctx.focusTerminalCalls.length, 1);
    assert.strictEqual(ctx.focusTerminalCalls[0].sessionId, "wire-session-1");
  });

  it("treats a repeated deny-and-focus for the same bubble as a no-op", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions, handleDecide } = perm;

    const res = createMockResponse();
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(res, { bubble });
    pendingPermissions.push(permEntry);

    handleDecide(makeEventFor(bubble), "deny-and-focus");
    handleDecide(makeEventFor(bubble), "deny-and-focus");

    assert.strictEqual(ctx.focusTerminalCalls.length, 1, "second IPC must not focus again");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("opencode: leaves the already-ACKed bridge response untouched", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions, handleDecide } = perm;

    // The opencode plugin's POST is 200-ACKed on arrival — by the time the
    // bubble is up, res is already finished. The destroy guard must not touch
    // it, and no bridge reply is owed (native TUI owns the request).
    const res = createMockResponse();
    res.end();
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(res, {
      bubble,
      isOpencode: true,
      toolName: "bash",
    });
    pendingPermissions.push(permEntry);

    handleDecide(makeEventFor(bubble), "deny-and-focus");

    assert.strictEqual(res.destroyed, false, "finished ACK socket must not be destroyed");
    assert.strictEqual(pendingPermissions.indexOf(permEntry), -1, "entry must be removed");
    assert.strictEqual(ctx.focusTerminalCalls.length, 1);
  });

  it("forwards isHermes in the bubble payload so the renderer suppresses the action", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);

    const hermesPayload = perm.buildPermissionBubblePayload(
      makePermEntry(createMockResponse(), { isHermes: true })
    );
    assert.strictEqual(hermesPayload.isHermes, true);

    const defaultPayload = perm.buildPermissionBubblePayload(
      makePermEntry(createMockResponse())
    );
    assert.strictEqual(defaultPayload.isHermes, false);
  });

  it("Hermes defensive branch: deny-and-focus still answers no-decision, never deny", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions, handleDecide } = perm;

    const res = createMockResponse();
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(res, { bubble, isHermes: true });
    pendingPermissions.push(permEntry);

    // No UI offers this on Hermes cards anymore; if it ever arrives anyway
    // (legacy renderer, future regression), the answer must stay a bodyless
    // no-decision — a deny here would decide on the user's behalf.
    handleDecide(makeEventFor(bubble), "deny-and-focus");

    assert.strictEqual(res.captured.statusCode, 204, "must answer 204 no-decision");
    const body = res.captured.body || "";
    assert.ok(!body.includes("deny"), "must not carry a deny decision");
    assert.strictEqual(pendingPermissions.indexOf(permEntry), -1, "entry must be removed");
    assert.strictEqual(ctx.focusTerminalCalls.length, 1, "terminal still gets focus");
  });
});
