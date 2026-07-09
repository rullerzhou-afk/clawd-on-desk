"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { WavePetEngine } = require("../src/wavepet/engine");

function ev(event, at, extra = {}) {
  return {
    event,
    session_id: "codex:s1",
    turn_id: "turn_1",
    timestamp_ms: at,
    ...extra,
  };
}

test("starts with steady work and moves to reading on early read tools", () => {
  const engine = new WavePetEngine();
  engine.update(ev("user_message", 1000, { token_estimate: 20 }));
  engine.update(ev("assistant_start", 1500));
  const state = engine.update(ev("tool_call_start", 2000, { tool_name: "shell_command", call_kind: "read" }));
  assert.equal(state.state, "reading_understanding");
  assert.ok(state.signals.analysis_tool_load > 0);
});

test("long output enters deep output", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  engine.update(ev("assistant_token_delta", 2000, { delta_tokens_est: 260 }));
  const state = engine.update(ev("assistant_token_delta", 3000, { delta_tokens_est: 120 }));
  assert.equal(state.state, "deep_output");
  assert.ok(state.presentation.min_visible_ms >= 12000);
});

test("failed tests enter overheat debugging", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  engine.update(ev("test_run_end", 2000, { success: false, output_tokens_est: 1000, failure_count_est: 2 }));
  const state = engine.update(ev("error_feedback", 2100, { severity: "high", token_estimate: 300 }));
  assert.equal(state.state, "overheat_debugging");
  assert.ok(state.signals.error_pressure > 0.45);
});

test("assistant end closes current turn and returns closing signal before later steady state", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  engine.update(ev("task_end_signal", 2000, { confidence: 1.0 }));
  const state = engine.update(ev("assistant_end", 2000, { finish_reason: "stop" }));
  assert.equal(state.state, "closing");
  assert.equal(state.online_features.history_turn_index, 1);
});

test("hold prevents immediate downgrade from deep output", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  const deep = engine.update(ev("assistant_token_delta", 2000, { delta_tokens_est: 400 }));
  assert.equal(deep.state, "deep_output");
  const tick = engine.update(ev("tick", 3000));
  assert.equal(tick.state, "deep_output");
  assert.ok(tick.smoothing.remaining_hold_ms > 0);
});
