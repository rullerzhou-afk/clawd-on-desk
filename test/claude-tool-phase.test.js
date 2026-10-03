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
  it("changes phase only at a correlated complete parallel batch", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["read-a", "read-b"]);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "read-a" })).thinking, undefined);
    assert.equal(batch(ledger, ["read-a"]).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "read-b" })).thinking, undefined);
    assert.equal(batch(ledger, ["read-a", "read-b"]).thinking, true);
  });

  it("accepts a batch before async individual results and drops their tails", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger, ["read-a", "read-b"]);
    assert.equal(batch(ledger, ["read-b", "read-a"]).thinking, true);
    for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      assert.equal(ledger.observe(event(eventName, { toolUseId: "read-a" })).accept, false);
    }
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
      assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "tool-a" })).accept, false);
      assert.equal(ledger.observe(event("PostToolUseFailure", { toolUseId: "tool-a" })).accept, false);
      assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "tool-a" })).accept, false);
    });
  }

  it("rejects old prompt work and Stop after a newer prompt, then accepts its own batch", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      assert.equal(ledger.observe(event(eventName, { toolUseId: "tool-a" })).accept, false);
    }
    assert.equal(batch(ledger).accept, false);
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "tool-b" }));
    assert.equal(batch(ledger, ["tool-b"], { promptId: "prompt-b" }).thinking, true);
  });

  it("retains tool tombstones when a result omits its prompt id", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: "tool-a" })).accept, false);
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "tool-b" }));
    assert.equal(batch(ledger, ["tool-b"], { promptId: "prompt-b" }).thinking, true);
  });

  it("keeps a fresh vetoed-Stop continuation legacy compatible without reviving its old phase", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    ledger.observe(event("Stop"));
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "continuation-tool" })).accept, true);
    assert.equal(batch(ledger, ["continuation-tool"]).accept, false);
    ledger.observe(event("UserPromptSubmit", { promptId: "prompt-b" }));
    ledger.observe(event("PreToolUse", { promptId: "prompt-b", toolUseId: "next-turn-tool" }));
    assert.equal(batch(ledger, ["next-turn-tool"], { promptId: "prompt-b" }).thinking, true);
  });

  it("closes phase evidence even when an accepted terminal lacks prompt identity", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(ledger.observe(event("Stop", { promptId: null })).accept, true);
    assert.equal(batch(ledger).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: "tool-a" })).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { promptId: null, toolUseId: null })).accept, true);
  });

  it("does not reset a current ledger for duplicate prompts or reopen a closed prompt", () => {
    const ledger = createClaudeToolPhaseLedger();
    start(ledger);
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, false);
    assert.equal(batch(ledger).thinking, true);
    ledger.observe(event("Stop"));
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, false);
  });

  it("does not let a duplicate prompt overwrite a later working tool phase", () => {
    const ledger = createClaudeToolPhaseLedger();
    let displayedState = "idle";
    function apply(eventName, state, extra = {}) {
      if (ledger.observe(event(eventName, extra)).accept) displayedState = state;
    }
    apply("UserPromptSubmit", "thinking");
    apply("PreToolUse", "working", { toolUseId: "tool-a" });
    apply("UserPromptSubmit", "thinking");
    assert.equal(displayedState, "working");
    assert.equal(batch(ledger).thinking, true);
  });

  it("keeps unknown normal events legacy compatible and does not create a ledger", () => {
    const ledger = createClaudeToolPhaseLedger();
    for (const eventName of ["Notification", "PostCompact", "PreToolUse", "PostToolUse"]) {
      assert.equal(ledger.observe(event(eventName)).accept, true);
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

  it("does not infer an epoch from tools that arrived before the prompt", () => {
    const ledger = createClaudeToolPhaseLedger();
    assert.equal(ledger.observe(event("PreToolUse", { toolUseId: "tool-a" })).accept, true);
    ledger.observe(event("UserPromptSubmit"));
    assert.equal(batch(ledger).accept, false);
  });

  it("does not open phase inference from a correlated prompt arriving after its Stop", () => {
    const ledger = createClaudeToolPhaseLedger();
    assert.equal(ledger.observe(event("Stop")).accept, true);
    assert.equal(ledger.observe(event("UserPromptSubmit")).accept, false);
    assert.equal(ledger.observe(event("PostToolUse", { toolUseId: "late-tool" })).accept, false);
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
