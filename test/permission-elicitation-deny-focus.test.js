// Regression test: when an elicitation permission is resolved with "deny"
// (e.g. via the AskUserQuestion bubble's "Go to Terminal" fallback), the
// permission layer must (1) send the Elicitation deny response so Claude
// Code can fall back to the native terminal prompt, and (2) call
// ctx.focusTerminalForSession so the originating terminal/workspace comes
// forward. Both steps live in src/permission.js's `isElicitation` branch
// of resolvePermissionEntry — replacing the bubble button with
// "deny-and-focus" would skip step (1) and leave the blocking HTTP hook
// open.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");

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
    setHeader(key, value) { captured.headers[key] = value; },
    writeHead(status, headers) {
      captured.statusCode = status;
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
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalCalls: [],
    focusTerminalForSession(sessionId) { this.focusTerminalCalls.push(sessionId); },
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => null,
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
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

describe("permission elicitation deny → focus regression", () => {
  it("sends an Elicitation deny response and focuses the originating session", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { resolvePermissionEntry, pendingPermissions } = perm;

    const res = createMockResponse();
    const permEntry = {
      res,
      abortHandler: () => {},
      suggestions: [],
      sessionId: "elicit-session-42",
      bubble: null,
      hideTimer: null,
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Q?" }] },
      resolvedSuggestion: null,
      createdAt: Date.now() - 5000, // older than MIN_BUBBLE_DISPLAY_MS so deny resolves immediately
      isElicitation: true,
    };
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "deny", "User answered in terminal");

    // (1) HTTP response must be ended with a deny so the Elicitation hook
    //     unblocks and Claude Code falls back to the native terminal prompt.
    assert.equal(res.captured.ended, true, "Elicitation HTTP response should be ended");
    assert.ok(res.captured.body, "Response body should not be empty");
    const parsed = JSON.parse(res.captured.body);
    assert.equal(
      parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName,
      "Elicitation",
      "Body should target the Elicitation hook so Claude Code falls back to the native terminal prompt"
    );
    assert.equal(
      parsed.hookSpecificOutput && parsed.hookSpecificOutput.decision &&
        parsed.hookSpecificOutput.decision.behavior,
      "deny",
      "Body should carry decision.behavior=deny"
    );

    // (2) The originating session's terminal must be focused.
    assert.deepEqual(
      ctx.focusTerminalCalls,
      ["elicit-session-42"],
      "ctx.focusTerminalForSession should be called exactly once with the elicitation session id"
    );

    // The pending entry must be cleaned up.
    assert.equal(pendingPermissions.indexOf(permEntry), -1, "Resolved entry should be removed from pendingPermissions");
  });
});
