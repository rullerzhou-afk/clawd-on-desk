"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { shouldBypassCCBubble, shouldBypassOpencodeBubble } = require("../src/server").__test;

function makeCtx({ enabled = true, hideBubbles = false } = {}) {
  return {
    isAgentPermissionsEnabled: () => enabled,
    hideBubbles,
  };
}

describe("shouldBypassCCBubble", () => {
  it("does not bypass when the sub-gate is on", () => {
    assert.strictEqual(shouldBypassCCBubble(makeCtx({ enabled: true }), "Bash", "claude-code"), false);
  });

  it("bypasses when the sub-gate is off for a normal permission tool", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, "Bash", "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, "Edit", "codebuddy"), true);
  });

  it("never bypasses ExitPlanMode — Plan Review would break", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, "ExitPlanMode", "claude-code"), false);
  });

  it("never bypasses AskUserQuestion — elicitations would hang CC", () => {
    const ctx = makeCtx({ enabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, "AskUserQuestion", "claude-code"), false);
  });

  it("missing isAgentPermissionsEnabled → fail-open (don't suppress)", () => {
    assert.strictEqual(shouldBypassCCBubble({}, "Bash", "claude-code"), false);
  });

  it("bypasses when hideBubbles is on, even if the per-agent gate is on", () => {
    const ctx = makeCtx({ enabled: true, hideBubbles: true });
    assert.strictEqual(shouldBypassCCBubble(ctx, "Bash", "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, "Edit", "codebuddy"), true);
  });

  it("hideBubbles does NOT bypass ExitPlanMode or AskUserQuestion — those would hang CC", () => {
    const ctx = makeCtx({ enabled: true, hideBubbles: true });
    assert.strictEqual(shouldBypassCCBubble(ctx, "ExitPlanMode", "claude-code"), false);
    assert.strictEqual(shouldBypassCCBubble(ctx, "AskUserQuestion", "claude-code"), false);
  });

  it("hideBubbles works without isAgentPermissionsEnabled helper present", () => {
    assert.strictEqual(shouldBypassCCBubble({ hideBubbles: true }, "Bash", "claude-code"), true);
  });
});

describe("shouldBypassOpencodeBubble", () => {
  it("does not bypass when the sub-gate is on", () => {
    assert.strictEqual(shouldBypassOpencodeBubble(makeCtx({ enabled: true })), false);
  });

  it("bypasses when the sub-gate is off", () => {
    assert.strictEqual(shouldBypassOpencodeBubble(makeCtx({ enabled: false })), true);
  });

  it("always queries the 'opencode' agent id regardless of call context", () => {
    const calls = [];
    const ctx = {
      isAgentPermissionsEnabled: (id) => {
        calls.push(id);
        return false;
      },
    };
    shouldBypassOpencodeBubble(ctx);
    assert.deepStrictEqual(calls, ["opencode"]);
  });

  it("missing isAgentPermissionsEnabled → fail-open", () => {
    assert.strictEqual(shouldBypassOpencodeBubble({}), false);
  });
});
