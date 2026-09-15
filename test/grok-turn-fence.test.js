"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createGrokTurnFence = require("../src/grok-turn-fence");
const { normalizeGrokPromptId, digestGrokPromptId, classifyGrokEvent } = createGrokTurnFence;

function apply(fence, input) {
  const decision = fence.assess(input);
  if (decision.accept && typeof decision.commit === "function") decision.commit();
  return decision;
}

const SID = "grok-build:s1";

function start(fence, promptId) {
  return apply(fence, { sessionId: SID, event: "UserPromptSubmit", state: "thinking", promptId });
}
function terminal(fence, promptId, event = "Stop", state = "attention") {
  return apply(fence, { sessionId: SID, event, state, promptId });
}
function work(fence, promptId, event = "PreToolUse", state = "working") {
  return apply(fence, { sessionId: SID, event, state, promptId });
}
function continuation(fence, promptId) {
  return apply(fence, { sessionId: SID, event: null, state: "working", promptId });
}
function corrective(fence, promptId) {
  return apply(fence, { sessionId: SID, event: "StopCancelled", state: "idle", promptId });
}

describe("Grok turn fence classification", () => {
  it("classifies the Phase 1 kinds, including failure events", () => {
    assert.strictEqual(classifyGrokEvent({ event: "UserPromptSubmit", state: "thinking" }), "start");
    assert.strictEqual(classifyGrokEvent({ event: "PreToolUse", state: "working" }), "work");
    assert.strictEqual(classifyGrokEvent({ event: "Stop", state: "attention" }), "terminal");
    assert.strictEqual(classifyGrokEvent({ event: "StopFailure", state: "error" }), "terminal");
    // PostToolUseFailure is turn work even though its state is `error`.
    assert.strictEqual(classifyGrokEvent({ event: "PostToolUseFailure", state: "error" }), "work");
    assert.strictEqual(classifyGrokEvent({ event: null, state: "working" }), "continuation");
    assert.strictEqual(classifyGrokEvent({ event: "SessionEnd", state: "sleeping" }), "session-end");
    assert.strictEqual(classifyGrokEvent({ event: "SessionStart", state: "idle" }), "session-start");
    assert.strictEqual(
      classifyGrokEvent({ event: "Notification", state: "notification", notificationType: "idle_prompt" }),
      "session-settle"
    );
    assert.strictEqual(classifyGrokEvent({ event: "Notification", state: "notification" }), "housekeeping");
    assert.strictEqual(classifyGrokEvent({ event: "StopCancelled", state: "idle" }), "correction");
  });

  it("rejects rather than truncates overlong or malformed prompt ids", () => {
    assert.strictEqual(normalizeGrokPromptId("  abc  "), "abc");
    assert.strictEqual(normalizeGrokPromptId("bad\nid"), null);
    assert.strictEqual(normalizeGrokPromptId("x".repeat(129)), null);
    assert.strictEqual(normalizeGrokPromptId("x".repeat(128)).length, 128);
    assert.strictEqual(normalizeGrokPromptId(42), null);
    assert.ok(digestGrokPromptId("abc").match(/^[0-9a-f]{8}$/));
    assert.strictEqual(digestGrokPromptId(null), "");
  });
});

describe("Grok turn fence ordering", () => {
  it("drops a late terminal for an older turn after a newer prompt starts", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    const dropped = terminal(fence, "A");
    assert.strictEqual(dropped.accept, false);
    assert.strictEqual(dropped.reason, "duplicate-terminal");
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");
  });

  it("drops duplicate terminals", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    assert.strictEqual(terminal(fence, "B").accept, true);
    const duplicate = terminal(fence, "B");
    assert.strictEqual(duplicate.accept, false);
    assert.strictEqual(duplicate.reason, "duplicate-terminal");
  });

  it("accepts and settles a terminal for an unseen prompt", () => {
    const fence = createGrokTurnFence();
    const decision = terminal(fence, "interrupted-bash");
    assert.strictEqual(decision.accept, true);
    assert.strictEqual(decision.reason, "terminal");
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, null);
    assert.ok(snapshot.tombstones.some((entry) => entry.turnId === "interrupted-bash"));
  });

  it("does not tombstone B on a continuation Stop, then accepts later work and final Stop", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    assert.strictEqual(continuation(fence, "B").accept, true);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");
    assert.strictEqual(fence.getSnapshot(SID).terminalLatch, null);
    assert.strictEqual(work(fence, "B", "PostToolUse").accept, true);
    assert.strictEqual(terminal(fence, "B").accept, true);
    assert.strictEqual(terminal(fence, "B").reason, "duplicate-terminal");
  });

  it("corrects a same-turn Stop with StopCancelled and drops the duplicate correction", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    terminal(fence, "B");
    let snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.tombstones.find((entry) => entry.turnId === "B").terminalEvent, "Stop");

    const correction = corrective(fence, "B");
    assert.strictEqual(correction.accept, true);
    assert.strictEqual(correction.reason, "corrective-terminal");
    snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.tombstones.find((entry) => entry.turnId === "B").terminalEvent, "StopCancelled");

    const duplicate = corrective(fence, "B");
    assert.strictEqual(duplicate.accept, false);
    assert.strictEqual(duplicate.reason, "duplicate-terminal");
  });

  it("settles no-prompt idle_prompt and SessionEnd, but not other notifications", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    const other = apply(fence, {
      sessionId: SID,
      event: "Notification",
      state: "notification",
      notificationType: "permission_prompt",
    });
    assert.strictEqual(other.accept, true);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");

    const idle = apply(fence, {
      sessionId: SID,
      event: "Notification",
      state: "notification",
      notificationType: "idle_prompt",
    });
    assert.strictEqual(idle.accept, true);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, null);

    const ended = apply(fence, { sessionId: SID, event: "SessionEnd", state: "sleeping" });
    assert.strictEqual(ended.accept, true);
    assert.strictEqual(fence.getSnapshot(SID), null);
  });

  it("drops work for a superseded or latched turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    assert.strictEqual(work(fence, "A").reason, "closed-turn-id");
    terminal(fence, "B");
    assert.strictEqual(work(fence, "C").reason, "terminal-latch");
    assert.strictEqual(work(fence, "B").reason, "closed-turn-id");
  });

  it("drops late failure work/terminals after a newer turn completes", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    // PostToolUseFailure A is work for a superseded turn.
    const lateFailure = work(fence, "A", "PostToolUseFailure", "error");
    assert.strictEqual(lateFailure.accept, false);
    assert.strictEqual(lateFailure.reason, "closed-turn-id");
    // StopFailure A is a terminal for a superseded turn.
    const lateStopFailure = terminal(fence, "A", "StopFailure", "error");
    assert.strictEqual(lateStopFailure.accept, false);

    // Complete B, then replay the late A terminal again: still dropped.
    terminal(fence, "B");
    assert.strictEqual(terminal(fence, "A").accept, false);
  });

  it("drops a late StopCancelled for A once B has started, without clearing B", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    terminal(fence, "A");
    assert.strictEqual(fence.getSnapshot(SID).correctableTurnId, "A");

    start(fence, "B");
    const afterStart = fence.getSnapshot(SID);
    assert.strictEqual(afterStart.currentTurnId, "B");
    assert.strictEqual(afterStart.correctableTurnId, null);

    const late = corrective(fence, "A");
    assert.strictEqual(late.accept, false);
    assert.strictEqual(late.reason, "duplicate-terminal");
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, "B");
    assert.strictEqual(snapshot.terminalLatch, null);
  });

  it("drops a late StopCancelled A even after B itself completed", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    terminal(fence, "A");
    start(fence, "B");
    terminal(fence, "B");
    assert.strictEqual(fence.getSnapshot(SID).correctableTurnId, "B");
    const late = corrective(fence, "A");
    assert.strictEqual(late.accept, false);
    assert.strictEqual(fence.getSnapshot(SID).correctableTurnId, "B");
  });

  it("treats PreCompact/PostCompact as presentation without touching the turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    for (const input of [
      { event: "PreCompact", state: "sweeping" },
      { event: "PostCompact", state: "thinking", source: "auto" },
      { event: "PostCompact", state: "idle", source: "manual" },
      { event: "PreCompact", state: "sweeping", promptId: "B" },
    ]) {
      const decision = apply(fence, { sessionId: SID, ...input });
      assert.strictEqual(decision.accept, true, input.event);
      assert.strictEqual(decision.reason, "presentation", input.event);
    }
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, "B");
    assert.strictEqual(snapshot.terminalLatch, null);
    assert.strictEqual(snapshot.correctableTurnId, null);
    assert.deepStrictEqual(snapshot.tombstones, []);
  });

  it("does not create a fence record for a no-id presentation event with no live turn", () => {
    const fence = createGrokTurnFence();
    const decision = apply(fence, { sessionId: SID, event: "PreCompact", state: "sweeping" });
    assert.strictEqual(decision.accept, true);
    assert.strictEqual(decision.reason, "presentation");
    assert.strictEqual(fence.getSnapshot(SID), null);
  });

  it("only lets StopCancelled correct an actual accepted Stop", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    terminal(fence, "B", "StopFailure", "error");
    // StopFailure is not correctable.
    const correction = corrective(fence, "B");
    assert.strictEqual(correction.accept, false);
    assert.strictEqual(correction.reason, "duplicate-terminal");
  });

  it("stops a superseded turn from being corrected after the newer turn completes", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    terminal(fence, "B");
    // A was superseded, not Stopped, so StopCancelled A must not settle.
    const correction = corrective(fence, "A");
    assert.strictEqual(correction.accept, false);
    assert.strictEqual(correction.reason, "duplicate-terminal");
  });

  it("still rejects no-id turn start/continuation and keeps the live turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    const rejected = [
      { event: "UserPromptSubmit", state: "thinking" },
      { event: null, state: "working" },
    ];
    for (const input of rejected) {
      const dropped = apply(fence, { sessionId: SID, ...input });
      assert.strictEqual(dropped.accept, false, input.event || "continuation");
      assert.strictEqual(dropped.reason, "missing-prompt-id", input.event || "continuation");
      assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");
    }
    // A later valid terminal for A still settles: A was never lost.
    assert.strictEqual(terminal(fence, "A").accept, true);
  });

  it("binds prompt-less tool work to the active turn without creating one", () => {
    const fence = createGrokTurnFence();
    // Before any UserPromptSubmit there is no active turn: drop, do not create.
    assert.strictEqual(apply(fence, { sessionId: SID, event: "PreToolUse", state: "working" }).reason, "no-active-turn");
    assert.strictEqual(fence.getSnapshot(SID), null);

    start(fence, "B");
    for (const input of [
      { event: "PreToolUse", state: "working" },
      { event: "PostToolUse", state: "working" },
      { event: "PostToolUseFailure", state: "error" },
    ]) {
      const decision = apply(fence, { sessionId: SID, ...input });
      assert.strictEqual(decision.accept, true, input.event);
      assert.strictEqual(decision.reason, "work", input.event);
    }
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, "B");
    assert.strictEqual(snapshot.terminalLatch, null);
    assert.deepStrictEqual(snapshot.tombstones, []);
  });

  it("rejects prompt-less work after a terminal latch/close and after SessionEnd", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    terminal(fence, "B");
    assert.strictEqual(
      apply(fence, { sessionId: SID, event: "PostToolUse", state: "working" }).reason,
      "terminal-latch"
    );

    start(fence, "C");
    apply(fence, { sessionId: SID, event: "SessionEnd", state: "sleeping" });
    assert.strictEqual(fence.getSnapshot(SID), null);
    assert.strictEqual(
      apply(fence, { sessionId: SID, event: "PostToolUse", state: "working" }).reason,
      "no-active-turn"
    );
  });

  it("does not let a late prompt-less PostToolUse reopen a superseded turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    // A is superseded; a prompt-less tool event must bind to the live B only.
    const decision = apply(fence, { sessionId: SID, event: "PostToolUse", state: "working" });
    assert.strictEqual(decision.accept, true);
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, "B");
    assert.strictEqual(
      snapshot.tombstones.filter((entry) => entry.turnId === "A")[0].terminalEvent,
      "superseded"
    );
  });

  it("accepts a normal SessionStart before any turn without creating one", () => {
    const fence = createGrokTurnFence();
    const decision = apply(fence, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(decision.accept, true);
    assert.strictEqual(decision.reason, "session-start");
    assert.strictEqual(fence.getSnapshot(SID), null);
  });

  it("drops a late SessionStart after UserPromptSubmit and keeps the active turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    const late = apply(fence, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(late.accept, false);
    assert.strictEqual(late.reason, "session-start-after-activity");
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");
    // Round 9 behavior is preserved: a prompt-less tool event still binds to A.
    assert.strictEqual(apply(fence, { sessionId: SID, event: "PreToolUse", state: "working" }).reason, "work");
  });

  it("drops a late SessionStart after a terminal latch or settle", () => {
    const latched = createGrokTurnFence();
    start(latched, "A");
    terminal(latched, "A");
    const afterStop = apply(latched, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(afterStop.accept, false);
    assert.strictEqual(afterStop.reason, "session-start-after-activity");

    const settled = createGrokTurnFence();
    start(settled, "A");
    apply(settled, { sessionId: SID, event: "Notification", state: "notification", notificationType: "idle_prompt" });
    const afterSettle = apply(settled, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(afterSettle.accept, false);
    assert.strictEqual(afterSettle.reason, "session-start-after-activity");
  });

  it("accepts a fresh SessionStart once SessionEnd cleared the fence record", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    terminal(fence, "A");
    assert.strictEqual(apply(fence, { sessionId: SID, event: "SessionEnd", state: "sleeping" }).accept, true);
    assert.strictEqual(fence.getSnapshot(SID), null);
    const restart = apply(fence, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(restart.accept, true);
    assert.strictEqual(restart.reason, "session-start");
  });

  it("does not let a late SessionStart resurrect a superseded turn", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    start(fence, "B");
    const late = apply(fence, { sessionId: SID, event: "SessionStart", state: "idle" });
    assert.strictEqual(late.accept, false);
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, "B");
    assert.strictEqual(
      snapshot.tombstones.filter((entry) => entry.turnId === "A")[0].terminalEvent,
      "superseded"
    );
  });

  it("drops turn-terminal reports that carry no promptId", () => {
    const fence = createGrokTurnFence();
    start(fence, "B");
    for (const [event, state] of [["Stop", "attention"], ["StopFailure", "error"], ["StopCancelled", "idle"]]) {
      const dropped = apply(fence, { sessionId: SID, event, state });
      assert.strictEqual(dropped.accept, false, event);
      assert.strictEqual(dropped.reason, "missing-prompt-id", event);
    }
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");
  });

  it("bounds live sessions and tombstones with deterministic eviction", () => {
    const fence = createGrokTurnFence({ maxSessions: 2, maxTombstones: 2 });
    start(fence, "a");
    for (const sid of ["s1", "s2", "s3"]) {
      apply(fence, { sessionId: `grok-build:${sid}`, event: "UserPromptSubmit", state: "thinking", promptId: "t" });
    }
    assert.ok(fence.size <= 2);
    for (const sid of ["s1", "s2", "s3", "s4"]) {
      apply(fence, { sessionId: `grok-build:${sid}`, event: "Stop", state: "attention", promptId: "t" });
    }
    assert.ok(fence.tombstoneSize <= 2);
  });

  it("does not commit fence records until commit() is called", () => {
    const fence = createGrokTurnFence();
    const startDecision = fence.assess({ sessionId: SID, event: "UserPromptSubmit", state: "thinking", promptId: "A" });
    assert.strictEqual(fence.getSnapshot(SID), null);
    startDecision.commit();
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");

    const terminalDecision = fence.assess({ sessionId: SID, event: "Stop", state: "attention", promptId: "A" });
    assert.strictEqual(terminalDecision.accept, true);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");
    const retry = fence.assess({ sessionId: SID, event: "Stop", state: "attention", promptId: "A" });
    assert.strictEqual(retry.accept, true);
    retry.commit();
    assert.strictEqual(fence.assess({ sessionId: SID, event: "Stop", state: "attention", promptId: "A" }).accept, false);
  });

  it("clears a single session and the whole fence", () => {
    const fence = createGrokTurnFence();
    start(fence, "A");
    assert.strictEqual(fence.clearSession(SID), true);
    assert.strictEqual(fence.getSnapshot(SID), null);
    start(fence, "A");
    fence.clear();
    assert.strictEqual(fence.getSnapshot(SID), null);
  });
});
