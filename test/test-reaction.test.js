"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  normalizeTestResult,
  canPlayTestReaction,
  createTestReactionHandler,
} = require("../src/test-reaction");

describe("test reaction main-process gate", () => {
  it("accepts only the two wire values", () => {
    assert.strictEqual(normalizeTestResult("pass"), "pass");
    assert.strictEqual(normalizeTestResult("fail"), "fail");
    assert.strictEqual(normalizeTestResult("PASS"), null);
    assert.strictEqual(normalizeTestResult({ result: "pass" }), null);
  });

  it("requires opt-in, a visible regular pet, and a non-headless source", () => {
    const base = {
      enabled: true,
      doNotDisturb: false,
      petHidden: false,
      miniMode: false,
      miniTransitioning: false,
      dragging: false,
      headless: false,
      hasPetWindow: true,
    };
    assert.strictEqual(canPlayTestReaction(base), true);
    for (const key of [
      "doNotDisturb",
      "petHidden",
      "miniMode",
      "miniTransitioning",
      "dragging",
      "headless",
    ]) {
      assert.strictEqual(canPlayTestReaction({ ...base, [key]: true }), false, key);
    }
    assert.strictEqual(canPlayTestReaction({ ...base, enabled: false }), false);
    assert.strictEqual(canPlayTestReaction({ ...base, hasPetWindow: false }), false);
  });

  it("fresh-reads every gate and sends one sanitized renderer event", () => {
    const state = {
      enabled: false,
      dnd: false,
      hidden: false,
      mini: false,
      transitioning: false,
      dragging: false,
      window: true,
    };
    const calls = [];
    const handle = createTestReactionHandler({
      getEnabled: () => state.enabled,
      getDoNotDisturb: () => state.dnd,
      isPetHidden: () => state.hidden,
      getMiniMode: () => state.mini,
      getMiniTransitioning: () => state.transitioning,
      isDragging: () => state.dragging,
      hasPetWindow: () => state.window,
      sendToRenderer: (...args) => calls.push(args),
    });

    assert.strictEqual(handle("pass"), false);
    state.enabled = true;
    assert.strictEqual(handle("pass"), true);
    assert.strictEqual(handle("fail", { headless: true }), false);
    assert.strictEqual(handle("unexpected"), false);
    assert.deepStrictEqual(calls, [["play-test-reaction", "pass"]]);
  });
});
