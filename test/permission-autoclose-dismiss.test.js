// Autoclose dismiss-without-decision semantics. The autoclose timer fires
// resolvePermissionEntry(perm, "no-decision", reason); each agent branch
// must dispose of the bubble without forwarding a synthetic user decision.
//
//   Claude Code / CodeBuddy → res.destroy()        (chat fallback)
//   Codex                   → sendCodexNoDecisionResponse (204)
//   Pi                      → sendNoDecisionResponse (204, pi label)
//   Elicitation             → res.destroy() + focusTerminalForSession
//   opencode                → silent drop (no bridge POST)
//
// "no-decision" must NEVER fall through to sendPermissionResponse — that would
// either auto-allow (default branch) or auto-deny the tool call, which codex
// review round 2/3 explicitly rejected as substituting for the user.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    destroyCalls: 0,
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
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    write(chunk) { captured.body = (captured.body || "") + String(chunk); },
    end(chunk) {
      if (chunk !== undefined) captured.body = (captured.body || "") + String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    destroy() {
      captured.destroyCalls++;
      this.destroyed = true;
    },
    on(evt, fn) { (captured.listeners[evt] = captured.listeners[evt] || []).push(fn); },
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
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
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
    sessions: new Map(),
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

function makePermEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "echo x" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000, // > MIN_BUBBLE_DISPLAY_MS so no delay path
    ...overrides,
  };
}

describe("permission autoclose: no-decision dismiss semantics", () => {
  it("CC default branch destroys the socket without sending a decision", () => {
    const ctx = makeCtx();
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);
    const permEntry = makePermEntry();
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "no-decision", "Auto-closed");

    assert.equal(permEntry.res.captured.destroyCalls, 1, "res.destroy() should fire");
    assert.equal(permEntry.res.captured.ended, false, "no decision body should be written");
    assert.equal(permEntry.res.captured.statusCode, null, "no writeHead should occur");
    assert.equal(pendingPermissions.indexOf(permEntry), -1, "pending entry should be spliced");
  });

  it("Codex branch sends 204 no-decision instead of allow/deny", () => {
    const ctx = makeCtx();
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);
    const permEntry = makePermEntry({ isCodex: true });
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "no-decision", "Auto-closed");

    assert.equal(permEntry.res.captured.statusCode, 204, "Codex no-decision is 204");
    assert.equal(permEntry.res.captured.destroyCalls, 0, "should not destroy socket on codex path");
    assert.equal(pendingPermissions.indexOf(permEntry), -1);
  });

  it("Pi branch sends 204 no-decision", () => {
    const ctx = makeCtx();
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);
    const permEntry = makePermEntry({ isPi: true });
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "no-decision", "Auto-closed");

    assert.equal(permEntry.res.captured.statusCode, 204);
    assert.equal(permEntry.res.captured.destroyCalls, 0);
    assert.equal(pendingPermissions.indexOf(permEntry), -1);
  });

  it("Elicitation branch destroys the socket and focuses the terminal", () => {
    const ctx = makeCtx();
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);
    const permEntry = makePermEntry({
      isElicitation: true,
      sessionId: "elicit-7",
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Q?" }] },
    });
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "no-decision", "Auto-closed");

    assert.equal(permEntry.res.captured.destroyCalls, 1, "elicitation socket destroyed");
    assert.equal(permEntry.res.captured.ended, false, "no Elicitation deny body should be sent");
    assert.deepEqual(ctx.focusTerminalCalls, ["elicit-7"], "originating terminal should be focused");
    assert.equal(pendingPermissions.indexOf(permEntry), -1);
  });

  it("dismissInteractivePermissionBubbles clears any armed autoCloseTimer", () => {
    // Direct-dismiss paths (DND, agent disable, "permission bubbles" toggle
    // off) bypass resolvePermissionEntry entirely — see permission.js
    // dismissInteractivePermissionWithoutDecision. Forgetting to clear
    // perm.autoCloseTimer there leaks the entry/window/response references
    // until the timer fires.
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { dismissInteractivePermissionBubbles, pendingPermissions } = perm;
    const permEntry = makePermEntry();
    let timerFired = false;
    permEntry.autoCloseTimer = setTimeout(() => { timerFired = true; }, 999999);
    pendingPermissions.push(permEntry);

    dismissInteractivePermissionBubbles();

    assert.equal(permEntry.autoCloseTimer, null, "autoCloseTimer should be cleared on direct dismiss");
    assert.equal(pendingPermissions.indexOf(permEntry), -1, "entry should be spliced");
    assert.equal(timerFired, false, "timer must not have fired (clearTimeout effective)");
  });

  it("opencode branch silently drops without bridge POST", () => {
    let bridgeReplyCalls = 0;
    const ctx = makeCtx();
    // opencode entries have res=null and route decisions through bridge.
    // For no-decision we want zero outbound traffic (silent drop) so the TUI
    // can prompt the user in-terminal. We can't fully assert "no bridge POST"
    // without a network stub, but we can assert the entry is spliced and
    // status code / destroy / focusTerminal stay untouched.
    const { resolvePermissionEntry, pendingPermissions } = initPermission(ctx);
    const permEntry = makePermEntry({
      isOpencode: true,
      res: null,
      opencodeRequestId: "per_test",
      opencodeBridgeUrl: "http://127.0.0.1:1/reply", // intentionally unreachable
      opencodeBridgeToken: "token",
    });
    pendingPermissions.push(permEntry);

    resolvePermissionEntry(permEntry, "no-decision", "Auto-closed");

    assert.equal(pendingPermissions.indexOf(permEntry), -1, "opencode entry should be spliced");
    assert.equal(ctx.focusTerminalCalls.length, 0, "opencode does not focus terminal");
  });
});
