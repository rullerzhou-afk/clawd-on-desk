"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const createCodexTurnFence = require("../src/codex-turn-fence");
const createCodexOfficialActivity = require("../src/codex-official-activity");

function event(overrides = {}) {
  return {
    sessionId: "codex:s1",
    source: "official",
    event: "PreToolUse",
    state: "working",
    turnId: "A",
    ...overrides,
  };
}

describe("codex turn fence", () => {
  it("drops a same-turn official work tail after Stop", () => {
    const fence = createCodexTurnFence();
    assert.strictEqual(fence.observe(event({ event: "UserPromptSubmit", state: "thinking" })).accept, true);
    assert.strictEqual(fence.observe(event()).accept, true);
    assert.strictEqual(fence.observe(event({ event: "Stop", state: "attention" })).accept, true);
    assert.deepStrictEqual(
      fence.observe(event({ event: "PostToolUse" })),
      { accept: false, reason: "closed-turn-id" }
    );
  });

  it("shares exact identity across JSONL terminal and official tail", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking" }));
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "event_msg:turn_aborted",
      state: "idle",
    })).accept, true);
    assert.strictEqual(fence.observe(event({ event: "PostToolUse" })).reason, "closed-turn-id");
  });

  it("opens B explicitly while retaining A's tombstone", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "Stop", state: "idle" }));
    assert.strictEqual(fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" })).accept, true);
    assert.strictEqual(fence.observe(event({ event: "PostToolUse", turnId: "B" })).accept, true);
    assert.strictEqual(fence.observe(event({ event: "PostToolUse", turnId: "A" })).reason, "closed-turn-id");
    assert.deepStrictEqual(fence.getSnapshot("codex:s1").closedTurnIds, ["A"]);
  });

  it("does not let a stale terminal A close active B", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" }));
    assert.strictEqual(fence.observe(event({ event: "Stop", state: "idle", turnId: "A" })).reason, "stale-terminal");
    assert.strictEqual(fence.getSnapshot("codex:s1").currentTurnId, "B");
    assert.strictEqual(fence.observe(event({ event: "PostToolUse", turnId: "B" })).accept, true);
  });

  it("rejects a delayed explicit start for an already closed turn", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ source: "jsonl", event: "event_msg:turn_aborted", state: "idle" }));
    assert.strictEqual(
      fence.observe(event({ event: "UserPromptSubmit", state: "thinking" })).reason,
      "closed-turn-id"
    );
  });

  it("uses an ID-less latch until an explicit start reopens it", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ source: "jsonl", event: "event_msg:turn_aborted", state: "idle", turnId: null }));
    assert.strictEqual(fence.observe(event({ turnId: null })).reason, "terminal-latch");
    assert.strictEqual(fence.observe(event({ turnId: "B" })).reason, "terminal-latch");
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "event_msg:user_message",
      state: "thinking",
      turnId: "B",
    })).reason, "terminal-latch");
    assert.strictEqual(fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" })).accept, true);
    assert.strictEqual(fence.observe(event({ turnId: "B" })).accept, true);
  });

  it("fails open when no canonical session id is available", () => {
    const fence = createCodexTurnFence();
    assert.deepStrictEqual(fence.observe(event({ sessionId: null })), {
      accept: true,
      reason: "no-session",
    });
    assert.strictEqual(fence.size, 0);
  });

  it("does not tombstone an inferred B on a delayed ID-less terminal", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" }));
    assert.strictEqual(fence.observe(event({ event: "Stop", state: "idle", turnId: null })).accept, true);
    assert.deepStrictEqual(fence.getSnapshot("codex:s1").closedTurnIds, []);
    assert.strictEqual(fence.observe(event({ event: "Stop", state: "attention", turnId: "B" })).accept, true);
    assert.strictEqual(fence.observe(event({ event: "Stop", state: "attention", turnId: "B" })).reason, "duplicate-terminal");
  });

  it("does not let work replace a different known current turn", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" }));
    assert.strictEqual(fence.observe(event({ turnId: "A" })).reason, "unexpected-distinct-work");
    assert.strictEqual(fence.getSnapshot("codex:s1").currentTurnId, "B");
  });

  it("keeps consecutive tombstones and makes duplicate terminals idempotent", () => {
    const fence = createCodexTurnFence();
    for (const turnId of ["A", "B", "C"]) {
      fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId }));
      fence.observe(event({ event: "Stop", state: "idle", turnId }));
    }
    for (const turnId of ["A", "B", "C"]) {
      assert.strictEqual(fence.observe(event({ event: "PostToolUse", turnId })).reason, "closed-turn-id");
      assert.strictEqual(fence.observe(event({ event: "Stop", state: "idle", turnId })).reason, "duplicate-terminal");
    }
  });

  it("handles synthetic backfill as an explicit boundary only when it recovered an open ID", () => {
    const fence = createCodexTurnFence();
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "response_item:function_call",
      syntheticBackfill: true,
      turnBoundaryOpen: true,
      turnId: "A",
    })).accept, true);
    fence.observe(event({ event: "Stop", state: "idle", turnId: "A" }));
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "response_item:function_call",
      syntheticBackfill: true,
      turnBoundaryOpen: true,
      turnId: "A",
    })).reason, "closed-turn-id");
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "response_item:function_call",
      syntheticBackfill: true,
      turnBoundaryOpen: false,
      turnId: null,
    })).reason, "synthetic-ambiguous");
    assert.strictEqual(fence.observe(event({
      source: "jsonl",
      event: "response_item:function_call",
      syntheticBackfill: true,
      turnBoundaryOpen: true,
      turnId: "B",
    })).accept, true);
  });

  it("isolates sessions and clears all lifecycle state explicitly", () => {
    const fence = createCodexTurnFence();
    fence.observe(event({ event: "Stop", state: "idle" }));
    assert.strictEqual(fence.observe(event({ sessionId: "codex:s2", turnId: "A" })).accept, true);
    fence.clear();
    assert.strictEqual(fence.size, 0);
    assert.strictEqual(fence.observe(event()).accept, true);
  });

  it("bounds session records and global tombstones deterministically", () => {
    const logs = [];
    const fence = createCodexTurnFence({
      maxSessions: 2,
      maxClosedTurns: 2,
      debugLog: (line) => logs.push(line),
    });
    for (const [sessionId, turnId] of [["s1", "A"], ["s2", "B"], ["s3", "C"]]) {
      fence.observe(event({ sessionId, event: "Stop", state: "idle", turnId }));
    }
    assert.strictEqual(fence.size, 2);
    assert.ok(fence.closedSize <= 2);
    assert.strictEqual(fence.getSnapshot("s1"), null);
    assert.ok(logs.some((line) => line.includes("session-capacity")));
  });

  it("keeps fallback protection after tombstone eviction until identity becomes ambiguous", () => {
    const logs = [];
    const fence = createCodexTurnFence({
      maxClosedTurns: 1,
      debugLog: (line) => logs.push(line),
    });
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "A" }));
    fence.observe(event({ event: "Stop", state: "attention", turnId: "A" }));
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: "B" }));
    fence.observe(event({ event: "Stop", state: "attention", turnId: "B" }));

    assert.deepStrictEqual(fence.getSnapshot("codex:s1").closedTurnIds, ["B"]);
    assert.ok(logs.some((line) => line.includes("reason=tombstone-capacity")));
    assert.strictEqual(
      fence.observe(event({ event: "PostToolUse", state: "working", turnId: "A" })).reason,
      "terminal-latch"
    );

    // A real but ID-less start is the bounded-memory ambiguity boundary: it
    // explicitly reopens lifecycle state without naming a current turn. Once
    // A's tombstone has been evicted, later work can only fail open.
    fence.observe(event({ event: "UserPromptSubmit", state: "thinking", turnId: null }));
    assert.deepStrictEqual(
      fence.observe(event({ event: "PostToolUse", state: "working", turnId: "A" })),
      { accept: true, reason: "work" }
    );
  });

  it("fails open for a tail whose entire session record was capacity-evicted", () => {
    const fence = createCodexTurnFence({ maxSessions: 1 });
    fence.observe(event({ sessionId: "s1", event: "Stop", state: "attention", turnId: "A" }));
    fence.observe(event({ sessionId: "s2", event: "UserPromptSubmit", state: "thinking", turnId: "B" }));
    assert.strictEqual(fence.getSnapshot("s1"), null);
    assert.deepStrictEqual(
      fence.observe(event({ sessionId: "s1", event: "PostToolUse", state: "working", turnId: "A" })),
      { accept: true, reason: "work" }
    );
  });
});

describe("codex official activity index", () => {
  it("suppresses exact IDs independently and keeps ID-less fallback conservative", () => {
    let currentTime = 1000;
    const activity = createCodexOfficialActivity({ now: () => currentTime });
    activity.mark("s1", "A");
    assert.strictEqual(activity.hasRecent("s1", "A"), true);
    assert.strictEqual(activity.hasRecent("s1", "B"), false);
    assert.strictEqual(activity.hasRecent("s1", null), true);
    activity.mark("s1", null);
    assert.strictEqual(activity.hasRecent("s1", "B"), true);
  });

  it("expires marks without using them as lifecycle freshness", () => {
    let currentTime = 0;
    const activity = createCodexOfficialActivity({ now: () => currentTime, ttlMs: 100 });
    activity.mark("s1", "A");
    currentTime = 101;
    assert.strictEqual(activity.hasRecent("s1", "A"), false);
    assert.strictEqual(activity.size, 0);
  });

  it("bounds exact marks per session and session LRU capacity", () => {
    const activity = createCodexOfficialActivity({ maxExactMarks: 2, maxSessions: 2 });
    activity.mark("s1", "A");
    activity.mark("s1", "B");
    activity.mark("s1", "C");
    assert.strictEqual(activity.hasRecent("s1", "A"), false);
    assert.strictEqual(activity.hasRecent("s1", "B"), true);
    activity.mark("s2", "A");
    activity.mark("s3", "A");
    assert.strictEqual(activity.size, 2);
    assert.strictEqual(activity.getSnapshot("s1"), null);
  });
});
