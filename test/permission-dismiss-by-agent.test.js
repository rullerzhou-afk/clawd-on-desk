"use strict";

// dismissPermissionsByAgent scope semantics (#451): the default sweep clears
// every pending entry for the agent; { subagentOnly: true } clears only
// entries stamped with a CC subagent origin and mirrors the
// shouldBypassCCSubagentBubble exemptions — ExitPlanMode / AskUserQuestion
// bubbles stay up even when the sub-gate flips off.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function createMockResponse() {
  const captured = { destroyCalls: 0 };
  return {
    captured,
    destroyed: false,
    writableFinished: false,
    on() {},
    removeListener() {},
    destroy() {
      captured.destroyCalls++;
      this.destroyed = true;
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession: () => {},
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
  const entry = {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "echo x" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    subagentId: null,
    subagentType: null,
    ...overrides,
  };
  entry.interaction = overrides.interaction || classifyPermissionInteraction({
    agentId: entry.agentId,
    toolName: entry.toolName,
  });
  return entry;
}

describe("dismissPermissionsByAgent subagentOnly scope (#451)", () => {
  it("clears only non-exempt CC subagent entries", () => {
    const perm = initPermission(makeCtx());
    const main = makePermEntry();
    const sub = makePermEntry({ subagentId: "uuid-1", subagentType: "Explore" });
    const subPlan = makePermEntry({ subagentId: "uuid-2", toolName: "ExitPlanMode" });
    const subAsk = makePermEntry({ subagentId: "uuid-3", toolName: "AskUserQuestion", isElicitation: true });
    const codex = makePermEntry({ agentId: "codex", isCodex: true });
    perm.pendingPermissions.push(main, sub, subPlan, subAsk, codex);

    const removed = perm.dismissPermissionsByAgent("claude-code", { subagentOnly: true });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(perm.pendingPermissions, [main, subPlan, subAsk, codex]);
    assert.strictEqual(sub.res.captured.destroyCalls, 1);
    assert.strictEqual(main.res.captured.destroyCalls, 0);
    assert.strictEqual(subPlan.res.captured.destroyCalls, 0);
    assert.strictEqual(subAsk.res.captured.destroyCalls, 0);
    assert.strictEqual(codex.res.captured.destroyCalls, 0);
  });

  it("returns 0 and touches nothing when no subagent entries are pending", () => {
    const perm = initPermission(makeCtx());
    const main = makePermEntry();
    perm.pendingPermissions.push(main);

    const removed = perm.dismissPermissionsByAgent("claude-code", { subagentOnly: true });

    assert.strictEqual(removed, 0);
    assert.deepStrictEqual(perm.pendingPermissions, [main]);
    assert.strictEqual(main.res.captured.destroyCalls, 0);
  });

  it("default sweep still clears every entry for the agent, exempt tools included", () => {
    const perm = initPermission(makeCtx());
    const main = makePermEntry();
    const sub = makePermEntry({ subagentId: "uuid-1" });
    const subPlan = makePermEntry({ subagentId: "uuid-2", toolName: "ExitPlanMode" });
    const codex = makePermEntry({ agentId: "codex", isCodex: true });
    perm.pendingPermissions.push(main, sub, subPlan, codex);

    const removed = perm.dismissPermissionsByAgent("claude-code");

    assert.strictEqual(removed, 3);
    assert.deepStrictEqual(perm.pendingPermissions, [codex]);
    assert.strictEqual(main.res.captured.destroyCalls, 1);
    assert.strictEqual(sub.res.captured.destroyCalls, 1);
    assert.strictEqual(subPlan.res.captured.destroyCalls, 1);
  });
});
