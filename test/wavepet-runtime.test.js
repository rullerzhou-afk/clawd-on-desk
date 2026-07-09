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
    payload: { type: "agent_message", message: "hello" },
  });
  const second = runtime.processCodexRecord("codex:s1", {
    timestamp: "2026-07-09T00:00:02.000Z",
    type: "event_msg",
    payload: { type: "token_count" },
  });
  assert.ok(first);
  assert.equal(second, null);
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
