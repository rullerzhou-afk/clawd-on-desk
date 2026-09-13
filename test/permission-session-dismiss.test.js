"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getPermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
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

describe("permission session-scoped archive retirement", () => {
  it("dismisses only the matching session and hands interactive prompts back with no-decision", () => {
    const perm = initPermission(makeCtx());
    const captured = [];
    const makeRes = (label) => ({
      label,
      statusCode: null,
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead(code) {
        this.statusCode = code;
        this.headersSent = true;
        captured.push([label, code]);
      },
      end() { this.writableEnded = true; },
      on() {},
      removeListener() {},
    });

    const interactive = {
      res: makeRes("interactive"),
      abortHandler: () => {},
      sessionId: "sid-A",
      bubble: null,
      toolName: "Bash",
      toolInput: {},
      suggestions: [],
      agentId: "codex",
      isCodex: true,
      createdAt: Date.now(),
    };
    interactive.interaction = classifyPermissionInteraction({
      agentId: "codex",
      eventKind: "permission",
      toolName: "Bash",
    });
    const passive = { sessionId: "sid-A", isCodexUserInputNotify: true, bubble: null, autoExpireTimer: null };
    const other = { sessionId: "sid-B", isCodexUserInputNotify: true, bubble: null, autoExpireTimer: null };
    perm.pendingPermissions.push(interactive, passive, other);

    assert.strictEqual(perm.dismissPermissionsForSession("sid-A", "codex-session-archived"), 2);
    assert.deepStrictEqual(perm.pendingPermissions.map((entry) => entry), [other]);
    assert.deepStrictEqual(captured, [["interactive", 204]], "no allow/deny is fabricated");
    assert.strictEqual(perm.dismissPermissionsForSession("", "reason"), 0);
    assert.strictEqual(perm.dismissPermissionsForSession("sid-missing", "reason"), 0);
  });
});
