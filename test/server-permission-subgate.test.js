"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  shouldBypassCCBubble,
  shouldBypassFamilyBubble,
} = require("../src/server").__test;
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function ccInteraction(toolName, agentId = "claude-code") {
  return classifyPermissionInteraction({ agentId, toolName });
}

function makeCtx({ enabled = true, hideBubbles = false, permissionBubblesEnabled = true } = {}) {
  return {
    isAgentPermissionsEnabled: () => enabled,
    hideBubbles,
    getBubblePolicy: (kind) => (
      kind === "permission"
        ? { enabled: permissionBubblesEnabled && !hideBubbles, autoCloseMs: null }
        : { enabled: !hideBubbles, autoCloseMs: 1000 }
    ),
  };
}

describe("shouldBypassCCBubble", () => {
  it("does not bypass when the sub-gate is on", () => {
    assert.strictEqual(shouldBypassCCBubble(
      makeCtx({ enabled: true }),
      ccInteraction("Bash"),
      "claude-code"
    ), false);
  });

  it("bypasses when the sub-gate is off for a normal permission tool", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Bash"), "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Edit", "codebuddy"), "codebuddy"), true);
  });

  it("never bypasses ExitPlanMode — Plan Review would break", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("ExitPlanMode"), "claude-code"), false);
  });

  it("never bypasses AskUserQuestion — elicitations would hang CC", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("AskUserQuestion"), "claude-code"), false);
  });

  it("missing isAgentPermissionsEnabled → fail-open (don't suppress)", () => {
    assert.strictEqual(shouldBypassCCBubble({}, ccInteraction("Bash"), "claude-code"), false);
  });

  it("bypasses when hideBubbles is on, even if the per-agent gate is on", () => {
    const ctx = makeCtx({ enabled: true, hideBubbles: true });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Bash"), "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Edit", "codebuddy"), "codebuddy"), true);
  });

  it("bypasses normal permission tools when the split permission category is off", () => {
    const ctx = makeCtx({ enabled: true, permissionBubblesEnabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Bash"), "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("Edit", "codebuddy"), "codebuddy"), true);
  });

  it("hideBubbles does NOT bypass ExitPlanMode or AskUserQuestion — those would hang CC", () => {
    const ctx = makeCtx({ enabled: true, hideBubbles: true });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("ExitPlanMode"), "claude-code"), false);
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("AskUserQuestion"), "claude-code"), false);
  });

  it("split permission category does NOT bypass ExitPlanMode or AskUserQuestion", () => {
    const ctx = makeCtx({ enabled: true, permissionBubblesEnabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("ExitPlanMode"), "claude-code"), false);
    assert.strictEqual(shouldBypassCCBubble(ctx, ccInteraction("AskUserQuestion"), "claude-code"), false);
  });

  it("hideBubbles works without isAgentPermissionsEnabled helper present", () => {
    assert.strictEqual(shouldBypassCCBubble(
      { hideBubbles: true },
      ccInteraction("Bash"),
      "claude-code"
    ), true);
  });
});

describe("shouldBypassFamilyBubble", () => {
  it("does not bypass when the sub-gate is on", () => {
    assert.strictEqual(shouldBypassFamilyBubble(makeCtx({ enabled: true }), "opencode"), false);
  });

  it("bypasses when the sub-gate is off", () => {
    assert.strictEqual(shouldBypassFamilyBubble(makeCtx({ enabled: false }), "opencode"), true);
  });

  it("queries exactly the caller's agent id — sub-gates stay per-agent", () => {
    const calls = [];
    const ctx = {
      isAgentPermissionsEnabled: (id) => {
        calls.push(id);
        return false;
      },
    };
    shouldBypassFamilyBubble(ctx, "opencode");
    shouldBypassFamilyBubble(ctx, "mimocode");
    assert.deepStrictEqual(calls, ["opencode", "mimocode"]);
  });

  it("missing isAgentPermissionsEnabled → fail-open", () => {
    assert.strictEqual(shouldBypassFamilyBubble({}, "opencode"), false);
  });
});

// D2/D3: shouldBypassAntigravityBubble and shouldBypassPiBubble are absent
// because both integrations are state-only; no bubble path exists for a
// subgate to gate.
