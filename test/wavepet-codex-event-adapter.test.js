"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { CodexWavePetAdapter } = require("../src/wavepet/codex-event-adapter");

test("user_message creates a new turn and user event", () => {
  const adapter = new CodexWavePetAdapter({ sessionId: "codex:s1" });
  const events = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "帮我改代码" },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "user_message");
  assert.equal(events[0].session_id, "codex:s1");
  assert.equal(events[0].turn_id, "turn_1");
  assert.ok(events[0].token_estimate > 0);
});

test("assistant message starts assistant and emits output delta", () => {
  const adapter = new CodexWavePetAdapter({ sessionId: "codex:s1" });
  const events = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "我先看看文件。" },
  });
  assert.deepEqual(events.map((event) => event.event), ["assistant_start", "assistant_token_delta"]);
  assert.ok(events[1].delta_tokens_est > 0);
});

test("reasoning records emit thinking deltas", () => {
  const adapter = new CodexWavePetAdapter({ sessionId: "codex:s1" });
  const events = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:02.000Z",
    type: "response_item",
    payload: { type: "reasoning", summary: [{ text: "Need inspect files" }] },
  });
  assert.equal(events[0].event, "thinking_delta");
  assert.ok(events[0].delta_tokens_est > 0);
});

test("tool call and output emit tool lifecycle and edit/test/error events", () => {
  const adapter = new CodexWavePetAdapter({ sessionId: "codex:s1" });
  const start = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:03.000Z",
    type: "response_item",
    payload: { type: "function_call", call_id: "c1", name: "shell_command", arguments: "{\"command\":\"npm test\"}" },
  });
  assert.equal(start[0].event, "tool_call_start");
  assert.equal(start[0].call_kind, "test");

  const end = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:05.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: "Exit code: 1\nfailed" },
  });
  assert.deepEqual(end.map((event) => event.event), ["tool_call_end", "test_run_end"]);
  assert.equal(end[0].success, false);
  assert.equal(end[1].failure_count_est, 1);
});

test("task_complete emits task end and assistant end", () => {
  const adapter = new CodexWavePetAdapter({ sessionId: "codex:s1" });
  const events = adapter.eventsFromRecord({
    timestamp: "2026-07-09T00:00:06.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  });
  assert.deepEqual(events.map((event) => event.event), ["task_end_signal", "assistant_end"]);
});
