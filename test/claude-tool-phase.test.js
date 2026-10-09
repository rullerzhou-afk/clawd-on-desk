"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeToolPhaseLedger } = require("../src/claude-tool-phase");

function event(eventName, extra = {}) {
  return { sessionId: "local:claude-code:s1", promptId: "prompt-a", event: eventName, ...extra };
}
function start(ledger, ids = ["tool-a"], extra = {}) {
  ledger.observe(event("UserPromptSubmit", extra));
  for (const toolUseId of ids) ledger.observe(event("PreToolUse", { ...extra, toolUseId }));
}
function batch(ledger, ids = ["tool-a"], extra = {}) {
  return ledger.observe(event("PostToolBatch", { toolUseIds: ids, ...extra }));
}

describe("Claude main-session tool phase", () => {
  it("backfills a retired first Pre only for the exact prompt once, including after a new prompt", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []); batch(ledger, ["late-tool"]); ledger.observe(event("Stop"));
    assert.equal(ledger.observe(event("PreToolUse", { promptId: "wrong", toolUseId: "late-tool" })).countToolCall, false);
    assert.equal(ledger.observe(event("PreToolUse", { promptId: null, toolUseId: "late-tool" })).countToolCall, false);
    ledger.observe(event("UserPromptSubmit", { promptId: "new" }));
    const late = ledger.observe(event("PreToolUse", { toolUseId: "late-tool" }));
    assert.equal(late.countToolCall, true); assert.equal(late.retired, true);
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "late-tool" })).countToolCall, false);
  });

  it("does not backfill observed or capacity-evicted retired tools", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 1 });
    start(ledger, []); batch(ledger, ["old"]); ledger.observe(event("Stop"));
    ledger.observe(event("UserPromptSubmit", { promptId: "new" }));
    ledger.observe(event("PreToolUse", { promptId: "new", toolUseId: "observed" }));
    ledger.observe(event("Stop", { promptId: "new" }));
    assert.notEqual(ledger.observe(event("PreToolUse", { toolUseId: "old" })).countToolCall, true);
    assert.equal(ledger.observe(event("PreToolUse", { promptId: "new", toolUseId: "observed" })).countToolCall, false);
  });

  it("clears a settled early boundary so it cannot exhaust the next early-batch budget", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 2 });
    start(ledger, []);
    assert.equal(batch(ledger, ["a"]).reason, "early-batch");
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "a" })).thinking, true);
    assert.equal(batch(ledger, ["b", "c"]).reason, "early-batch");
  });

  it("never retains a retired tool in an unseen queued prompt", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 1 });
    start(ledger); ledger.observe(event("Stop"));
    assert.equal(batch(ledger, ["tool-a"], { promptId: "queued" }).reason, "closed-turn");
    assert.equal(batch(ledger, ["fresh"], { promptId: "queued" }).reason, "queued-batch");
    assert.equal(ledger.observe(event("PreToolUse", { promptId: "queued", toolUseId: "fresh" })).thinking, true);
  });

  it("retains a queued first batch without reopening the closed turn, within a shared budget", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 2 });
    start(ledger);
    ledger.observe(event("Stop"));
    for (let i = 0; i < 10; i++) assert.equal(batch(ledger, ["queued-a", "queued-b"], { promptId: "queued" }).reason, "queued-batch");
    assert.equal(batch(ledger, ["overflow"], { promptId: "another" }).reason, "closed-turn");
    assert.equal(batch(ledger).accept, false, "queued evidence does not reopen the closed original turn");
    assert.equal(ledger.observe(event("PreToolUse", { promptId: "queued", toolUseId: "queued-a" })).thinking, undefined);
    assert.equal(ledger.observe(event("PreToolUse", { promptId: "queued", toolUseId: "queued-b" })).thinking, true);
  });

  for (const boundary of ["Stop", "SessionEnd", "UserPromptSubmit"]) {
    it(`discards queued early evidence at ${boundary}`, () => {
      const ledger = createClaudeToolPhaseLedger();
      start(ledger);
      ledger.observe(event("Stop"));
      batch(ledger, ["queued-tool"], { promptId: "queued" });
      ledger.observe(event(boundary, boundary === "UserPromptSubmit" ? { promptId: "newer" } : {}));
      const pre = ledger.observe(event("PreToolUse", { promptId: "queued", toolUseId: "queued-tool" }));
      assert.equal(pre.thinking, undefined);
    });
  }

  it("gates a delayed settlement but preserves its failure and later batch progress", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []);
    batch(ledger, ["early"]);
    const failure = ledger.observe(event("PostToolUseFailure", { toolUseId: "early", allowThinking: false }));
    assert.equal(failure.thinking, undefined);
    assert.equal(failure.errorCue, true);
    ledger.observe(event("PreToolUse", { toolUseId: "later" }));
    assert.equal(batch(ledger, ["later"]).thinking, true);
  });

  for (const foreignEvent of ["PreToolUse", "PostToolUse", "Stop"]) {
    it(`keeps the open prompt completable after unseen ${foreignEvent} traffic`, () => {
      const ledger = createClaudeToolPhaseLedger();
      start(ledger);
      ledger.observe(event(foreignEvent, { promptId: "unseen", toolUseId: "foreign-tool" }));
      assert.equal(batch(ledger).accept, false);
      const stop = ledger.observe(event("Stop"));
      assert.equal(stop.accept, true);
      assert.equal(stop.preservePhase, undefined);
      ledger.observe(event("PreToolUse", { promptId: "queued", toolUseId: "queued-tool" }));
      assert.equal(batch(ledger, ["queued-tool"], { promptId: "queued" }).thinking, true);
    });
  }

  for (const multi of [false, true]) {
    for (const tail of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      it(`recovers an early ${multi ? "parallel" : "single-tool"} batch on ${tail}`, () => {
        const ledger = createClaudeToolPhaseLedger();
        start(ledger, multi ? ["slow-tool"] : []);
        const ids = multi ? ["slow-tool", "fast-tool"] : ["fast-tool"];
        assert.equal(batch(ledger, ids).accept, false, "a batch alone must not invent a tool start");
        const recovered = ledger.observe(event(tail, { toolUseId: "fast-tool" }));
        assert.equal(recovered.thinking, true);
        assert.equal(recovered.errorCue, tail === "PostToolUseFailure");
        ledger.observe(event("PreToolUse", { toolUseId: "fast-tool" }));
        const failure = ledger.observe(event("PostToolUseFailure", { toolUseId: "fast-tool" }));
        assert.equal(failure.errorCue, true);
        ledger.observe(event("PreToolUse", { toolUseId: "next-tool" }));
        assert.equal(batch(ledger, ["next-tool"]).thinking, true, "the reordered tool must not block later batches");
      });
    }
  }

  it("settles a reordered old batch without overriding newer unsettled work", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []);
    batch(ledger, ["early-tool"]);
    ledger.observe(event("PreToolUse", { toolUseId: "newer-tool" }));
    const late = ledger.observe(event("PreToolUse", { toolUseId: "early-tool" }));
    assert.equal(late.preservePhase, true);
    assert.equal(late.thinking, undefined);
    assert.equal(batch(ledger, ["newer-tool"]).thinking, true);
  });

  it("clears early batch evidence on terminal and new-prompt boundaries", () => {
    for (const boundary of ["Stop", "StopFailure", "ApiError", "SessionEnd", "UserPromptSubmit"]) {
      const ledger = createClaudeToolPhaseLedger();
      start(ledger, []);
      batch(ledger, ["early-tool"]);
      ledger.observe(event(boundary, boundary === "UserPromptSubmit" ? { promptId: "new-prompt" } : {}));
      assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "early-tool" })).preservePhase, true);
      assert.equal(batch(ledger, ["early-tool"]).accept, false);
    }
  });

  it("bounds early evidence and ignores repeated early batches without consuming its budget", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 2 });
    start(ledger, []);
    for (let i = 0; i < 5; i++) assert.equal(batch(ledger, ["early-a"]).reason, "early-batch");
    assert.equal(batch(ledger, ["early-b"]).reason, "early-batch");
    assert.equal(batch(ledger, ["early-c"]).reason, "early-batch-capacity");
    ledger.observe(event("PreToolUse", { toolUseId: "early-a" }));
    assert.equal(batch(ledger, ["early-a"]).accept, false);
  });

  it("changes phase only at a correlated complete parallel batch", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["read-a", "read-b"]);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "read-a" })).thinking, undefined);
    assert.equal(batch(ledger, ["read-a"]).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "read-b" })).thinking, undefined);
    assert.equal(batch(ledger, ["read-a", "read-b"]).thinking, true);
  });

  it("preserves phase for settled success tails but admits current tool failures", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["read-a", "read-b"]);
    assert.equal(batch(ledger, ["read-b", "read-a"]).thinking, true);
    for (const eventName of ["PreToolUse", "PostToolUse"]) {
      const decision = ledger.observe(event(eventName, { toolUseId: "read-a" }));
      assert.equal(decision.accept, true);
      assert.equal(decision.preservePhase, true);
    }
    const failure = ledger.observe(event("PostToolUseFailure", { toolUseId: "read-a" }));
    assert.equal(failure.accept, true);
    assert.equal(failure.preservePhase, true);
    assert.equal(failure.errorCue, true);
    assert.equal(batch(ledger, ["read-a", "read-b"]).accept, false);
  });

  it("allows a new batch of tools within the same prompt", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(batch(ledger).thinking, true);
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "tool-b" })).accept, true);
    assert.equal(batch(ledger, ["tool-b"]).thinking, true);
    assert.equal(batch(ledger).accept, false);
  });

  it("does not let a partial old batch override completed but unbatched siblings", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["tool-a", "tool-b"]);
    ledger.observe(event("PostToolUse", { toolUseId: "tool-a" }));
    ledger.observe(event("PostToolUse", { toolUseId: "tool-b" }));
    assert.equal(batch(ledger, ["tool-a"]).reason, "other-unsettled-tools");
    assert.equal(batch(ledger, ["tool-a", "tool-b"]).thinking, true);
  });

  it("keeps a failed tool result separate from the batch phase transition", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    const failure = ledger.observe(event("PostToolUseFailure", { toolUseId: "tool-a" }));
    assert.equal(failure.accept, true);
    assert.equal(failure.thinking, undefined);
    assert.equal(batch(ledger).thinking, true);
  });

  for (const terminal of ["Stop", "StopFailure", "ApiError", "SessionEnd"]) {
    it(`does not reopen a turn after ${terminal} with a batch or individual result`, () => {
      const ledger = createClaudeToolPhaseLedger();
      start(ledger);
      assert.equal(ledger.observe(event(terminal)).accept, true);
      assert.equal(batch(ledger).accept, false);
      for (const name of ["PostToolUse", "PostToolUseFailure", "PreToolUse"]) {
        const decision = ledger.observe(event(name, { toolUseId: "tool-a" }));
        assert.equal(decision.accept, true);
        assert.equal(decision.preservePhase, true);
      }
    });
  }

  it("rejects old prompt work and Stop after a newer prompt, then accepts its own batch", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      const decision = ledger.observe(event(eventName, { toolUseId: "tool-a" }));
      assert.equal(decision.accept, true);
      assert.equal(decision.preservePhase, true);
      assert.equal(decision.retired, true);
    }
    assert.equal(batch(ledger).accept, false);
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "tool-b" }));
    assert.equal(batch(ledger, ["tool-b"], { promptId: "prompt-b" }).thinking, true);
  });

  it("retains tool tombstones when a result omits its prompt id", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: "tool-a" })).preservePhase, true);
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "tool-b" }));
    assert.equal(batch(ledger, ["tool-b"], { promptId: "prompt-b" }).thinking, true);
  });

  it("registers a fresh vetoed-Stop continuation under the same prompt", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("Stop"));
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "continuation-tool" })).accept, true);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "continuation-tool" })).accept, true);
    assert.equal(batch(ledger, ["continuation-tool"]).thinking, true);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "next-turn-tool" }));
    assert.equal(batch(ledger, ["next-turn-tool"], { promptId: "prompt-b" }).thinking, true);
  });

  it("closes phase evidence even when an accepted terminal lacks prompt identity", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(ledger.observe(event("Stop", { promptId: null })).accept, true);
    assert.equal(batch(ledger).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: "tool-a" })).preservePhase, true);
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: null })).accept, true);
  });

  it("admits additional same-prompt messages without resetting tools or reopening phase evidence", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, true);
    assert.equal(batch(ledger).thinking, true);
    ledger.observe(event("Stop"));
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, true);
    assert.equal(batch(ledger).accept, false);
  });

  it("does not use prompt identity as a per-message duplicate key", () => {
    const ledger = createClaudeToolPhaseLedger();
    let displayedState = "idle";
    function apply(eventName, state, extra = {}) {
      if (ledger.observe(event(eventName, extra)).accept) displayedState = state;
    }
    apply("UserPromptSubmit", "thinking");
    apply("PreToolUse", "working", { toolUseId: "tool-a" });
    apply("UserPromptSubmit", "thinking");
    assert.equal(displayedState, "thinking");
    assert.equal(batch(ledger).thinking, true);
  });

  it("keeps unknown normal events legacy compatible and does not create a ledger", () => {
    const ledger = createClaudeToolPhaseLedger();
    for (const eventName of ["Notification", "PostCompact", "PreToolUse", "PostToolUse"]) {
      assert.equal(ledger.observe(event(eventName, { promptId: null })).accept, true);
    }
    assert.equal(ledger.size, 0);
    assert.equal(batch(ledger).accept, false);
  });

  it("lets child lifecycle through without altering the main ledger and drops child batches", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      assert.equal(ledger.observe(event(eventName, { subagentId: "child-a", toolUseId: "child-tool" })).accept, true);
    }
    assert.equal(batch(ledger, ["child-tool"], { subagentId: "child-a" }).accept, false);
    assert.equal(batch(ledger).thinking, true);
  });

  it("registers a synthetic main-session subagent tool start by exact tool id", () => {
    const ledger = createClaudeToolPhaseLedger();
    ledger.observe(event("UserPromptSubmit"));
    ledger.observe(event("SubagentStart", { toolUseId: "agent-tool", subagentLifecycleSource: "synthetic-tool" }));
    assert.equal(batch(ledger, ["agent-tool"]).thinking, true);
  });

  it("does not infer a tool start from a native subagent event", () => {
    const ledger = createClaudeToolPhaseLedger();
    ledger.observe(event("UserPromptSubmit"));
    assert.equal(ledger.observe(event("SubagentStart", {
      toolUseId: "agent-tool", subagentLifecycleSource: "native",
    })).accept, true);
    assert.equal(batch(ledger, ["agent-tool"]).accept, false);
  });

  it("keeps an entirely uncorrelated legacy Stop and its tool tails unchanged", () => {
    const ledger = createClaudeToolPhaseLedger();
    assert.equal(ledger.observe(event("Stop", { promptId: null })).accept, true);
    assert.equal(ledger.size, 0);
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: "old-tool" })).accept, true);
    ledger.observe(event("UserPromptSubmit", { promptId: null }));
    for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]) {
      assert.equal(ledger.observe(event(eventName, { promptId: null, toolUseId: "old-tool" })).accept, true);
    }
    assert.equal(batch(ledger, ["old-tool"], { promptId: null }).accept, false);
  });

  for (const missing of ["promptId", "toolUseId"]) {
    it(`preserves legacy tools but declines phase inference when ${missing} is absent`, () => {
      const ledger = createClaudeToolPhaseLedger();
      ledger.observe(event("UserPromptSubmit"));
      assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "tool-a", [missing]: null })).accept, true);
      ledger.observe(event("PreToolUse", { toolUseId: "tool-b" }));
      assert.equal(batch(ledger, ["tool-b"]).accept, false);
    });
  }

  it("declines batches when the prompt itself lacked correlation", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["tool-a"], { promptId: null });
    assert.equal(batch(ledger).accept, false);
    assert.equal(batch(ledger, ["tool-a"], { promptId: null }).accept, false);
  });

  it("declines mismatched or unobserved tool results without suppressing their legacy state", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "not-observed" })).accept, true);
    assert.equal(batch(ledger).accept, false);
  });

  it("recovers a result that arrives before its own start", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "fast-tool" })).reason, "result-before-start");
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "fast-tool" })).reason, "tool-start");
    assert.equal(batch(ledger, ["fast-tool"]).thinking, true);
    ledger.observe(event("PreToolUse", { toolUseId: "next-tool" }));
    ledger.observe(event("PostToolUse", { toolUseId: "next-tool" }));
    assert.equal(batch(ledger, ["next-tool"]).thinking, true, "the whole turn must stay confirmable");
  });

  it("settles a result-before-start tool at its batch and backfills the late start once", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "fast-tool" })).reason, "result-before-start");
    assert.equal(batch(ledger, ["fast-tool"]).thinking, true);
    const late = ledger.observe(event("PreToolUse", { toolUseId: "fast-tool" }));
    assert.equal(late.preservePhase, true);
    assert.equal(late.countToolCall, true);
    assert.notEqual(ledger.observe(event("PreToolUse", { toolUseId: "fast-tool" })).countToolCall, true);
  });

  it("recovers a failure that arrives before its own start", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, []);
    assert.equal(ledger.observe(event("PostToolUseFailure", { toolUseId: "fast-tool" })).reason, "result-before-start");
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "fast-tool" })).reason, "tool-start");
    assert.equal(batch(ledger, ["fast-tool"]).thinking, true);
  });

  it("fails closed when a result-before-start tool exceeds the tool budget", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 1 });
    start(ledger, ["existing-tool"]);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "late-tool" })).reason, "tool-capacity");
    assert.equal(batch(ledger, ["existing-tool"]).accept, false);
  });

  it("rejects mismatched and missing batch prompt identities", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(batch(ledger, ["tool-a"], { promptId: "prompt-b" }).accept, false);
    assert.equal(batch(ledger, ["tool-a"], { promptId: null }).accept, false);
    assert.equal(batch(ledger).thinking, true);
  });

  it("rejects malformed, duplicate, empty, overlong, and oversized batches without consuming valid tools", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    for (const ids of [undefined, null, [], "tool-a", [null], ["tool-a", "tool-a"],
      ["tool-a", "unknown-tool"], ["x".repeat(129)], ["tool-a\ninvalid"],
      Array.from({ length: 65 }, (_, i) => `tool-${i}`)]) {
      assert.equal(ledger.observe(event("PostToolBatch", { toolUseIds: ids })).accept, false);
    }
    assert.equal(batch(ledger).thinking, true);
  });

  it("opens a correlated turn from a tool start when no Submit hook was emitted", () => {
    const ledger = createClaudeToolPhaseLedger();
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "tool-a" })).accept, true);
    ledger.observe(event("UserPromptSubmit"));
    assert.equal(batch(ledger).thinking, true);
  });

  it("does not open phase inference from a correlated prompt arriving after its Stop", () => {
    const ledger = createClaudeToolPhaseLedger();
    assert.equal(ledger.observe(event("Stop")).accept, true);
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, true);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "late-tool" })).accept, true);
    assert.equal(batch(ledger).accept, false);
  });

  it("fails closed for phase inference when the current tool budget is exceeded", () => {
    const ledger = createClaudeToolPhaseLedger({ maxTools: 2 });
    start(ledger, ["a", "b", "c"]);
    assert.equal(batch(ledger, ["a", "b"]).accept, false);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "d" }));
    assert.equal(batch(ledger, ["d"], { promptId: "prompt-b" }).thinking, true);
  });

  it("bounds sessions and treats an evicted session's phase as unproven", () => {
    const ledger = createClaudeToolPhaseLedger({ maxSessions: 2 });
    for (const sessionId of ["one", "two", "three"]) start(ledger, ["tool-a"], { sessionId });
    assert.equal(ledger.size, 2);
    assert.equal(batch(ledger, ["tool-a"], { sessionId: "one" }).accept, false);
    assert.equal(batch(ledger, ["tool-a"], { sessionId: "three" }).thinking, true);
  });

  it("clears all phase evidence when its owner shuts down", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.clear();
    assert.equal(ledger.size, 0);
    assert.equal(batch(ledger).accept, false);
  });

  it("rejects sessionless batches while ordinary state remains unchanged", () => {
    const ledger = createClaudeToolPhaseLedger();
    for (const sessionId of [null, "", "bad\nidentity"]) {
      assert.equal(batch(ledger, ["tool-a"], { sessionId }).accept, false);
      assert.equal(ledger.observe(event("PreToolUse", { sessionId })).accept, true);
    }
  });
});
