// Tests for the ExitPlanMode "Tell Claude what to change" feedback path.
// Validates: handleDecide routes plan-feedback payloads correctly, the wire
// protocol matches CC's expected deny+message schema, and edge cases (empty
// feedback, non-ExitPlanMode tool) are handled safely.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ── Mock electron before requiring permission.js ──
// permission.js does `const { BrowserWindow, globalShortcut } = require("electron")`
// at load, and handleDecide() calls BrowserWindow.fromWebContents(event.sender) to
// map the IPC sender back to its perm entry. The node test runtime's require("electron")
// returns the binary path string (no BrowserWindow), so without this mock the
// handleDecide-driven tests below would throw. The mock resolves a sender to its
// window via a `__win` sentinel; globalShortcut is stubbed to harmless no-ops.
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
    write(chunk) {
      captured.body = (captured.body || "") + String(chunk);
    },
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
    destroy() {
      this.destroyed = true;
    },
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

function makePlanPermEntry(res, overrides = {}) {
  return {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "plan-session-1",
    bubble: null,
    hideTimer: null,
    toolName: "ExitPlanMode",
    toolInput: { plan: "Build a React app" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

// Fake bubble window + IPC event. handleDecide() calls
// BrowserWindow.fromWebContents(event.sender) (mocked above) which resolves
// event.sender.__win back to the perm's bubble, so the lookup
// pendingPermissions.find(p => p.bubble === senderWin) matches.
function makeFakeBubble() {
  return { isDestroyed: () => false, webContents: { send: () => {} }, destroy: () => {} };
}
function makeEventFor(bubble) {
  return { sender: { __win: bubble } };
}

describe("permission plan-feedback handleDecide", () => {
  it("resolves ExitPlanMode with deny + feedback message", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { resolvePermissionEntry, pendingPermissions } = perm;

    const res = createMockResponse();
    const permEntry = makePlanPermEntry(res);
    pendingPermissions.push(permEntry);

    // Directly call resolvePermissionEntry with deny + feedback message
    // (this is what handleDecide routes to)
    resolvePermissionEntry(permEntry, "deny", "改成只用 React，不要 Vue");

    // Verify HTTP response was sent
    assert.strictEqual(res.captured.ended, true, "HTTP response should be ended");
    assert.ok(res.captured.body, "Response body should not be empty");

    const parsed = JSON.parse(res.captured.body);
    assert.strictEqual(
      parsed.hookSpecificOutput.decision.behavior,
      "deny",
      "Wire protocol should carry behavior=deny"
    );
    assert.strictEqual(
      parsed.hookSpecificOutput.decision.message,
      "改成只用 React，不要 Vue",
      "Wire protocol should carry the feedback as decision.message"
    );

    // Entry should be removed from pending
    assert.strictEqual(
      pendingPermissions.indexOf(permEntry),
      -1,
      "Resolved entry should be removed from pendingPermissions"
    );
  });

  it("empty feedback results in dismiss-for-terminal (no HTTP response written)", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions, handleDecide } = perm;

    const res = createMockResponse();
    const fakeBubble = {
      isDestroyed: () => false,
      webContents: { send: () => {} },
      destroy: () => {},
    };
    const permEntry = makePlanPermEntry(res, { bubble: fakeBubble });
    pendingPermissions.push(permEntry);

    // Simulate handleDecide being called with plan-feedback but empty feedback
    // We'll use resolvePermissionEntry logic path — the plan-feedback handler
    // in handleDecide calls dismissPermissionForTerminal for empty feedback.
    // Since handleDecide needs BrowserWindow.fromWebContents, test the logic
    // directly through the exported dismissPermissionForTerminal:
    perm.dismissPermissionForTerminal(permEntry);

    // Should NOT have written an HTTP response (dismissPermissionForTerminal
    // leaves the HTTP connection open for CC to detect socket close)
    assert.strictEqual(res.captured.ended, false, "HTTP response should NOT be ended by dismiss-for-terminal");

    // Entry should be removed
    assert.strictEqual(
      pendingPermissions.indexOf(permEntry),
      -1,
      "Entry should be removed from pendingPermissions"
    );

    // Terminal should be focused
    assert.strictEqual(ctx.focusTerminalCalls.length, 1);
    assert.strictEqual(ctx.focusTerminalCalls[0].sessionId, "plan-session-1");
  });

  it("deny with feedback produces correct CC wire format (hookSpecificOutput envelope)", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { resolvePermissionEntry, pendingPermissions } = perm;

    const res = createMockResponse();
    const permEntry = makePlanPermEntry(res);
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "deny", "Please add error handling");

    const parsed = JSON.parse(res.captured.body);
    // Verify full wire structure
    assert.deepStrictEqual(parsed, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Please add error handling",
        },
      },
    });
  });

  it("non-ExitPlanMode perm receiving plan-feedback object falls through to normal deny", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { resolvePermissionEntry, pendingPermissions } = perm;

    const res = createMockResponse();
    const permEntry = makePlanPermEntry(res, { toolName: "Bash" });
    pendingPermissions.push(permEntry);

    // For a non-ExitPlanMode entry, resolvePermissionEntry with "deny" still
    // produces the standard deny response
    resolvePermissionEntry(permEntry, "deny", "some message");

    assert.strictEqual(res.captured.ended, true);
    const parsed = JSON.parse(res.captured.body);
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
  });
});

// These drive handleDecide() itself — the routing logic the ExitPlanMode
// feedback feature added (toolName guard, behavior.type check, empty→dismiss,
// trim) — through the real IPC entry point, instead of calling
// resolvePermissionEntry/dismissPermissionForTerminal directly. That entry
// point is what an actual "Send"/"Back" click in the bubble reaches.
describe("permission plan-feedback handleDecide routing (IPC entry point)", () => {
  function setup(permOverrides = {}) {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const res = createMockResponse();
    const bubble = makeFakeBubble();
    const permEntry = makePlanPermEntry(res, { bubble, ...permOverrides });
    perm.pendingPermissions.push(permEntry);
    return { ctx, perm, res, bubble, permEntry };
  }

  it("routes ExitPlanMode plan-feedback to deny + trimmed message", () => {
    const { perm, res, bubble, permEntry } = setup();

    perm.handleDecide(makeEventFor(bubble), { type: "plan-feedback", feedback: "  改成只用 React  " });

    assert.strictEqual(res.captured.ended, true);
    const parsed = JSON.parse(res.captured.body);
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(parsed.hookSpecificOutput.decision.message, "改成只用 React", "feedback should be trimmed");
    assert.strictEqual(perm.pendingPermissions.indexOf(permEntry), -1);
  });

  it("routes empty/whitespace plan-feedback to dismiss-for-terminal (socket left open)", () => {
    const { ctx, perm, res, bubble, permEntry } = setup();

    perm.handleDecide(makeEventFor(bubble), { type: "plan-feedback", feedback: "   " });

    // dismiss-for-terminal does NOT write an HTTP decision — it leaves the
    // connection open so CC detects the socket close and falls back to terminal.
    assert.strictEqual(res.captured.ended, false);
    assert.strictEqual(perm.pendingPermissions.indexOf(permEntry), -1);
    assert.strictEqual(ctx.focusTerminalCalls.length, 1);
    assert.strictEqual(ctx.focusTerminalCalls[0].sessionId, "plan-session-1");
  });

  it("does NOT treat a plan-feedback object as feedback for a non-ExitPlanMode tool", () => {
    const { perm, res, bubble, permEntry } = setup({ toolName: "Bash" });

    perm.handleDecide(makeEventFor(bubble), { type: "plan-feedback", feedback: "must not become a message" });

    // toolName guard fails → falls through to the default branch: an object
    // behavior !== "allow" becomes a plain deny, and crucially NO feedback
    // message leaks into the wire for a non-plan tool.
    assert.strictEqual(res.captured.ended, true);
    const parsed = JSON.parse(res.captured.body);
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(parsed.hookSpecificOutput.decision.message, undefined);
    assert.strictEqual(perm.pendingPermissions.indexOf(permEntry), -1);
  });

  it("is a no-op when the sender maps to no pending permission", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    // Sender resolves to a bubble that was never added to pendingPermissions.
    assert.doesNotThrow(() =>
      perm.handleDecide(makeEventFor(makeFakeBubble()), { type: "plan-feedback", feedback: "x" })
    );
  });
});
