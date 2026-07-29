"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { shouldBypassElicitationBubble } = require("../src/server-route-permission");

describe("shouldBypassElicitationBubble", () => {
  it("does not bypass when the pref is on", () => {
    const ctx = { elicitationBubblesEnabled: true };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "AskUserQuestion"), false);
  });

  it("bypasses AskUserQuestion when the pref is off", () => {
    const ctx = { elicitationBubblesEnabled: false };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "AskUserQuestion"), true);
  });

  it("only gates AskUserQuestion — other tools are untouched", () => {
    const ctx = { elicitationBubblesEnabled: false };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "Bash"), false);
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "ExitPlanMode"), false);
  });

  it("missing pref → fail-open (keep showing the bubble)", () => {
    assert.strictEqual(shouldBypassElicitationBubble({}, "AskUserQuestion"), false);
  });
});
