"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { getCodexLogEventKey } = require("../hooks/codex-log-event");

describe("getCodexLogEventKey", () => {
  it("normalizes a ContextCompaction item completion to the existing compaction key", () => {
    assert.equal(getCodexLogEventKey("event_msg", {
      type: "item_completed",
      turn_id: "turn-1",
      item: { type: "ContextCompaction", id: "compaction-1" },
    }), "event_msg:context_compacted");
  });

  it("preserves legacy compaction and ordinary JSONL event keys", () => {
    for (const [type, payload, expected] of [
      ["event_msg", { type: "context_compacted" }, "event_msg:context_compacted"],
      ["event_msg", { type: "task_complete" }, "event_msg:task_complete"],
      ["event_msg", { type: "turn_aborted" }, "event_msg:turn_aborted"],
      ["event_msg", { type: "token_count" }, "event_msg:token_count"],
      ["response_item", { type: "function_call" }, "response_item:function_call"],
      ["session_meta", { cwd: "/repo" }, "session_meta"],
      ["unknown", { type: "future_event" }, "unknown:future_event"],
    ]) {
      assert.equal(getCodexLogEventKey(type, payload), expected);
    }
  });

  it("leaves other and malformed item completions unmapped", () => {
    for (const item of [
      undefined, null, false, 1, "ContextCompaction", [], {},
      { type: "AgentMessage" }, { type: "Reasoning" },
      { type: "contextCompaction" }, { type: "ContextCompaction " },
    ]) {
      assert.equal(getCodexLogEventKey("event_msg", {
        type: "item_completed", item,
      }), "event_msg:item_completed");
    }
    for (const payload of [undefined, null, false, 1, "item_completed", []]) {
      assert.equal(getCodexLogEventKey("event_msg", payload), "event_msg");
    }
  });

  it("does not reinterpret checkpoints, response items, or a compaction start", () => {
    const item = { type: "ContextCompaction", id: "compaction-1" };
    for (const [type, payload, expected] of [
      ["compacted", {}, "compacted"],
      ["compacted", { type: "item_completed", item }, "compacted:item_completed"],
      ["response_item", { type: "compaction" }, "response_item:compaction"],
      ["response_item", { type: "item_completed", item }, "response_item:item_completed"],
      ["event_msg", { type: "item_started", item }, "event_msg:item_started"],
    ]) {
      assert.equal(getCodexLogEventKey(type, payload), expected);
    }
  });
});
