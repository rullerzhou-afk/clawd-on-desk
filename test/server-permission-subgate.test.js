"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { shouldBypassCCBubble, shouldBypassOpencodeBubble, shouldBypassPiBubble } = require("../src/server").__test;

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

  it("bypasses normal permission tools when the split permission category is off", () => {
    const ctx = makeCtx({ enabled: true, permissionBubblesEnabled: false });
    assert.strictEqual(shouldBypassCCBubble(ctx, "Bash", "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble(ctx, "Edit", "codebuddy"), true);
  });

  it("hideBubbles does NOT bypass ExitPlanMode or AskUserQuestion — those would hang CC", () => {
    const ctx = makeCtx({ enabled: true, hideBubbles: true });
    assert.strictEqual(shouldBypassCCBubble(ctx, "ExitPlanMode", "claude-code"), false);
    assert.strictEqual(shouldBypassCCBubble(ctx, "AskUserQuestion", "claude-code"), false);
  });

  it("split permission category does NOT bypass ExitPlanMode or AskUserQuestion", () => {
    const ctx = makeCtx({ enabled: true, permissionBubblesEnabled: false });
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

describe("shouldBypassPiBubble", () => {
  it("does not bypass when the Pi sub-gate is on", () => {
    assert.strictEqual(shouldBypassPiBubble(makeCtx({ enabled: true })), false);
  });

  it("bypasses when the Pi sub-gate or split permission category is off", () => {
    assert.strictEqual(shouldBypassPiBubble(makeCtx({ enabled: false })), true);
    assert.strictEqual(shouldBypassPiBubble(makeCtx({ enabled: true, permissionBubblesEnabled: false })), true);
  });

  it("always queries the 'pi' agent id regardless of call context", () => {
    const calls = [];
    const ctx = {
      isAgentPermissionsEnabled: (id) => {
        calls.push(id);
        return false;
      },
    };
    shouldBypassPiBubble(ctx);
    assert.deepStrictEqual(calls, ["pi"]);
  });
});
