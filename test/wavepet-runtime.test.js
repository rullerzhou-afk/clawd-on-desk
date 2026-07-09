"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { WavePetRuntime } = require("../src/wavepet/runtime");

test("processCodexRecord maps assistant output into a Clawd update", () => {
  const runtime = new WavePetRuntime();
  const update = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "x ".repeat(700) },
  });
  assert.ok(update);
  assert.equal(update.sessionId, "codex:s1");
  assert.equal(update.state, "working");
  assert.equal(update.displayHint, "clawd-working-ultrathink.svg");
  assert.equal(update.extra.agentId, "codex");
  assert.ok(update.extra.wavepet);
});

test("unchanged state can be suppressed unless display hold should refresh", () => {
  const runtime = new WavePetRuntime();
  const first = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "x ".repeat(700) },
  });
  const second = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:13.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "x ".repeat(700) },
  });
  assert.ok(first);
  assert.ok(second);
  assert.equal(second.state, "working");
  assert.equal(second.displayHint, "clawd-working-ultrathink.svg");
  assert.ok(second.extra.wavepet.smoothing.changed === false);
  assert.ok(second.extra.wavepet.smoothing.hold_until_ms > first.extra.wavepet.smoothing.hold_until_ms);
});

test("task_complete emits a completion update", () => {
  const runtime = new WavePetRuntime();
  runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "done soon" },
  });
  const done = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:03.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  });
  assert.ok(done);
  assert.equal(done.state, "attention");
});

test("high severity tool failure maps to a Clawd error state", () => {
  const runtime = new WavePetRuntime();
  runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "e1",
      name: "shell_command",
      arguments: '{"command":"apply_patch"}',
    },
  });

  const update = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "e1",
      output: "Exit code: 1\npatch failed",
    },
  });

  assert.ok(update);
  assert.equal(update.state, "error");
  assert.equal(update.extra.wavepet.state, "overheat_debugging");
});
