"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createDshStateSequenceFence } = require("../src/dsh-state-sequence");

test("DSH state fence accepts an ordered lifecycle and rejects duplicate or stale delivery", () => {
  const fence = createDshStateSequenceFence();
  const sessionId = "deepseek-harness:s1";
  assert.deepStrictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 4 }), {
    accepted: true,
    reason: "start",
  });
  assert.deepStrictEqual(fence.accept({ sessionId, event: "PreToolUse", eventSeq: 4 }), {
    accepted: true,
    reason: "event",
  });
  assert.strictEqual(fence.accept({ sessionId, event: "PostToolUse", eventSeq: 4 }).accepted, false);
  assert.strictEqual(fence.accept({ sessionId, event: "PostToolUse", eventSeq: 3 }).accepted, false);
  assert.strictEqual(fence.accept({ sessionId, event: "SessionEnd", sessionSeq: 4 }).reason, "stale-end-watermark");
  assert.strictEqual(fence.accept({ sessionId, event: "SessionEnd", sessionSeq: 5 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "Stop", eventSeq: 6 }).reason, "session-ended");
  assert.strictEqual(fence.accept({ sessionId, event: "SessionEnd", sessionSeq: 5 }).reason, "duplicate-end");
});

test("DSH state fence requires the canonical namespace and upstream sequence fields", () => {
  const fence = createDshStateSequenceFence();
  assert.strictEqual(fence.accept({ sessionId: "raw", event: "SessionStart", sessionSeq: 0 }).reason, "invalid-session");
  assert.strictEqual(fence.accept({ sessionId: "deepseek-harness:s1", event: "SessionStart" }).reason, "missing-session-watermark");
  assert.strictEqual(fence.accept({ sessionId: "deepseek-harness:s1", event: "PreToolUse" }).reason, "missing-event-seq");
});

test("DSH state fence permits a new created lifecycle after disposal", () => {
  const fence = createDshStateSequenceFence();
  const sessionId = "deepseek-harness:reused";
  assert.strictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 0 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "SessionEnd", sessionSeq: 0 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 0 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "UserPromptSubmit", eventSeq: 0 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "SessionEnd", sessionSeq: 1 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 0 }).reason, "stale-session-restart");
  assert.strictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 8 }).accepted, true);
  assert.strictEqual(fence.accept({ sessionId, event: "UserPromptSubmit", eventSeq: 8 }).accepted, true);
});

test("DSH state fence rejects a second created watermark while the session is active", () => {
  const fence = createDshStateSequenceFence();
  const sessionId = "deepseek-harness:active";
  assert.strictEqual(fence.accept({ sessionId, event: "SessionStart", sessionSeq: 2 }).accepted, true);
  assert.strictEqual(
    fence.accept({ sessionId, event: "SessionStart", sessionSeq: 9 }).reason,
    "active-session-restart",
  );
  assert.strictEqual(fence.snapshot(sessionId).startWatermark, 2);
});

test("DSH state fence remains bounded and evicts ended/old records first", () => {
  const fence = createDshStateSequenceFence({ maxSessions: 2 });
  fence.accept({ sessionId: "deepseek-harness:a", event: "SessionStart", sessionSeq: 0 });
  fence.accept({ sessionId: "deepseek-harness:a", event: "SessionEnd", sessionSeq: 0 });
  fence.accept({ sessionId: "deepseek-harness:b", event: "SessionStart", sessionSeq: 0 });
  fence.accept({ sessionId: "deepseek-harness:c", event: "SessionStart", sessionSeq: 0 });
  assert.strictEqual(fence.snapshot("deepseek-harness:a"), null);
  assert.ok(fence.snapshot("deepseek-harness:b"));
  assert.ok(fence.snapshot("deepseek-harness:c"));
});
