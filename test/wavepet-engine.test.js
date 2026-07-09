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

test("assistant end closes the turn once, preserves transient closing, and later settles", () => {
  const engine = new WavePetEngine();
  for (let i = 0; i < 2; i += 1) {
    engine.update(ev("assistant_start", 1000 + i * 1000));
    engine.update(ev("assistant_end", 1200 + i * 1000, { finish_reason: "stop" }));
  }

  engine.update(ev("assistant_start", 1000));
  engine.update(ev("assistant_token_delta", 1500, { delta_tokens_est: 100 }));
  engine.update(ev("task_end_signal", 2000, { confidence: 1.0 }));
  const state = engine.update(ev("assistant_end", 2000, { finish_reason: "stop" }));
  assert.equal(state.state, "closing");
  assert.equal(state.online_features.history_turn_index, 3);
  assert.equal(state.online_features.current_assistant_tokens_streamed, 0);
  assert.equal(state.online_features.recent_assistant_tokens_max, 100);
  assert.equal(state.online_features.recent_error_count_sum, 0);

  const settled = engine.update(ev("tick", 11000));
  assert.equal(settled.state, "steady_work");
  assert.notEqual(settled.smoothing.raw_state, "closing");
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

test("strong higher-priority overheat switches immediately from deep output", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  const deep = engine.update(ev("assistant_token_delta", 2000, { delta_tokens_est: 400 }));
  assert.equal(deep.state, "deep_output");

  const state = engine.update(
    ev("test_run_end", 3000, {
      success: false,
      output_tokens_est: 1000,
      failure_count_est: 2,
    })
  );

  assert.equal(state.smoothing.raw_state, "overheat_debugging");
  assert.equal(state.state, "overheat_debugging");
});

test("inactive turns report zero silent wait in signals and diagnostics", () => {
  const engine = new WavePetEngine();
  engine.update(ev("assistant_start", 1000));
  engine.update(ev("assistant_end", 2000, { finish_reason: "stop" }));

  const state = engine.update(ev("tick", 9000));
  assert.equal(state.signals.silent_wait_load, 0);
  assert.equal(state.online_features.current_silent_wait_ms, 0);
});
