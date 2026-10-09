"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clearSubagentTracker,
  cloneSubagentTracker,
  getSubagentVisualCount,
  hasConfirmedSubagents,
  hasSubagentHoldEvidence,
  normalizeChildId,
} = require("../src/subagent-lifecycle");

test("normalizes only bounded single-line child ids", () => {
  assert.strictEqual(normalizeChildId("  child-a  "), "child-a");
  assert.strictEqual(normalizeChildId(""), null);
  assert.strictEqual(normalizeChildId("child\nother"), null);
  assert.strictEqual(normalizeChildId("x".repeat(257)), null);
  assert.strictEqual(normalizeChildId(42), null);
});

test("clones and sanitizes tracker identities without mutating the source", () => {
  const source = {
    subagentTracker: {
      confirmedIds: new Set([" child-a ", "child-a", "", "bad\rvalue"]),
      legacyFloor: true,
      recoveredFloor: true,
    },
  };
  const tracker = cloneSubagentTracker(source);

  assert.deepStrictEqual([...tracker.confirmedIds], ["child-a"]);
  assert.strictEqual(tracker.legacyFloor, true);
  assert.strictEqual(tracker.recoveredFloor, true);
  tracker.confirmedIds.add("child-b");
  assert.strictEqual(source.subagentTracker.confirmedIds.has("child-b"), false);
});

test("uses independent evidence as a visual floor instead of summing it", () => {
  const tracker = {
    confirmedIds: new Set(["child-a", "child-b"]),
    legacyFloor: true,
    recoveredFloor: true,
  };
  assert.strictEqual(getSubagentVisualCount(tracker), 2);
  assert.strictEqual(hasConfirmedSubagents(tracker), true);
  assert.strictEqual(hasSubagentHoldEvidence(tracker), true);
});

test("recovery affects the visual floor but cannot hold lifecycle state", () => {
  const tracker = {
    confirmedIds: new Set(),
    legacyFloor: false,
    recoveredFloor: true,
  };
  assert.strictEqual(getSubagentVisualCount(tracker), 1);
  assert.strictEqual(hasConfirmedSubagents(tracker), false);
  assert.strictEqual(hasSubagentHoldEvidence(tracker), false);

  clearSubagentTracker(tracker);
  assert.strictEqual(getSubagentVisualCount(tracker), 0);
});
