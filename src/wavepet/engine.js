"use strict";

const STATE_ZH = {
  reading_understanding: "读题理解",
  steady_work: "稳定工作",
  deep_output: "深度输出",
  overheat_debugging: "红温调试",
  closing: "收束",
};

const STATE_PRIORITY = {
  steady_work: 0,
  reading_understanding: 1,
  closing: 2,
  deep_output: 3,
  overheat_debugging: 4,
};

const MIN_VISIBLE_MS = {
  reading_understanding: 3500,
  steady_work: 6000,
  deep_output: 12000,
  overheat_debugging: 18000,
  closing: 8000,
};

const DEFAULT_THRESHOLDS = {
  long_output_tokens: 300,
  long_thinking_tokens: 120,
  heavy_feedback_tokens: 1200,
  tool_wait_ms: 8000,
  silent_wait_ms: 3000,
  overheat_pressure: 0.75,
  closing_signal: 0.70,
};

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function createTurnSummary() {
  return {
    assistant_tokens: 0,
    thinking_tokens: 0,
    feedback_tokens: 0,
    tool_count: 0,
    read_tool_count: 0,
    command_count: 0,
    edit_count: 0,
    test_count: 0,
    error_count: 0,
    finish_count: 0,
  };
}

function visibleLoad(turn) {
  return (turn.assistant_tokens || 0) + (turn.thinking_tokens || 0);
}

function presentationFor(state, intensity) {
  const table = {
    reading_understanding: ["reading", "neutral", "读题", "我先看看..."],
    steady_work: ["typing", "neutral", "工作", "稳定推进中"],
    deep_output: ["intense_typing", "focus", "输出", "正在认真写..."],
    overheat_debugging: ["shake", "hot", "调试", "压力上来了"],
    closing: ["settle", "cool", "收束", "快整理好了"],
  };
  const [motion, tint, badge, bubble] = table[state];
  return {
    motion,
    tint,
    scale: Number((1 + Math.min(0.08, intensity * 0.08)).toFixed(3)),
    badge,
    bubble,
    cadence_ms: Math.max(250, Math.round(900 - intensity * 450)),
    min_visible_ms: MIN_VISIBLE_MS[state],
  };
}

function reasonFor(state) {
  return {
    reading_understanding: "Early low-pressure turn; likely reading or understanding context.",
    steady_work: "Codex is making normal progress without strong waiting pressure.",
    deep_output: "Current output, thinking, or silence is long enough to feel like deep work.",
    overheat_debugging: "Errors, tests, logs, or validation pressure are high.",
    closing: "Completion or wrap-up signals are stronger than active pressure.",
  }[state];
}

class WavePetEngine {
  constructor(options = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.recentWindow = options.recentWindow || 5;
    this.sessionId = "default";
    this.turnId = "turn_0";
    this.turnIndex = 0;
    this.active = false;
    this.goalMode = false;
    this.current = createTurnSummary();
    this.recentTurns = [];
    this.lastEventMs = null;
    this.lastActivityMs = null;
    this.assistantStartMs = null;
    this.openToolStartMs = null;
    this.openToolKind = "";
    this.openToolName = "";
    this.pendingUserTokens = 0;
    this.state = "steady_work";
    this.rawState = "steady_work";
    this.candidateState = null;
    this.candidateTicks = 0;
    this.ticksInState = 0;
    this.stateEnteredMs = null;
    this.holdUntilMs = 0;
    this.transientClosingBoost = 0;

    const initNow = Date.now();
    const initSignals = this._signals(initNow);
    this.lastOutput = this._output(
      initNow,
      this.rawState,
      initSignals,
      this._scores(initSignals),
      "steady_work",
      false
    );
  }

  update(event = {}) {
    const now = Number.isFinite(event.timestamp_ms)
      ? Math.floor(event.timestamp_ms)
      : this._nextTimestamp();
    this.sessionId = String(event.session_id || this.sessionId);
    this.turnId = String(event.turn_id || this.turnId);
    const eventName = String(event.event || "tick");
    this._applyEvent(eventName, event, now);
    const signals = this._signals(now);
    const scores = this._scores(signals);
    const rawState = this._rawState(scores);
    const { previousState, changed } = this._smooth(rawState, scores, now);
    this.lastEventMs = now;
    if (eventName !== "tick") this.lastActivityMs = now;
    this.lastOutput = this._output(
      now,
      rawState,
      signals,
      scores,
      previousState,
      changed
    );
    this.transientClosingBoost = 0;
    return this.lastOutput;
  }

  getState() {
    return this.lastOutput;
  }

  _nextTimestamp() {
    return (this.lastEventMs || 0) + 1000;
  }

  _closeCurrentTurn() {
    this.recentTurns.push(this.current);
    while (this.recentTurns.length > this.recentWindow) this.recentTurns.shift();
    this.current = createTurnSummary();
    this.active = false;
    this.goalMode = false;
    this.turnIndex += 1;
    this.assistantStartMs = null;
    this.openToolStartMs = null;
    this.openToolKind = "";
    this.openToolName = "";
  }

  _applyEvent(name, event, now) {
    if (name === "user_message") {
      if (this.active) this._closeCurrentTurn();
      this.pendingUserTokens += Number(event.token_estimate || 0);
      return;
    }

    if (name === "assistant_start") {
      if (this.active) this._closeCurrentTurn();
      this.active = true;
      this.goalMode = !!(event.goal_mode || event.mode === "goal");
      this.assistantStartMs = now;
      this.lastActivityMs = now;
      this.current = createTurnSummary();
      this.current.feedback_tokens = this.pendingUserTokens;
      this.pendingUserTokens = 0;
      return;
    }

    if (name === "assistant_token_delta") {
      this.current.assistant_tokens += Number(event.delta_tokens_est || 0);
    } else if (name === "thinking_delta") {
      this.current.thinking_tokens += Number(event.delta_tokens_est || 0);
    } else if (name === "tool_call_start") {
      const kind = String(event.call_kind || "tool");
      this.current.tool_count += 1;
      if (kind === "read") this.current.read_tool_count += 1;
      else if (kind === "command") this.current.command_count += 1;
      else if (kind === "test") this.current.test_count += 1;
      else if (kind === "edit") this.current.edit_count += 1;
      this.openToolStartMs = now;
      this.openToolKind = kind;
      this.openToolName = String(event.tool_name || "");
    } else if (name === "tool_call_end") {
      this.current.feedback_tokens += Number(event.output_tokens_est || 0);
      if (event.success === false) this.current.error_count += 1;
      this.openToolStartMs = null;
      this.openToolKind = "";
      this.openToolName = "";
    } else if (name === "file_edit") {
      this.current.edit_count += 1;
    } else if (name === "test_run_end") {
      this.current.test_count += 1;
      this.current.feedback_tokens += Number(event.output_tokens_est || 0);
      const failures = Number(event.failure_count_est || 0);
      if (event.success === false || failures > 0) {
        this.current.error_count += Math.max(1, failures);
      }
    } else if (name === "error_feedback") {
      const severity = String(event.severity || "error");
      this.current.error_count += severity === "fatal" || severity === "high" ? 2 : 1;
      this.current.feedback_tokens += Number(event.token_estimate || 0);
    } else if (name === "task_end_signal") {
      this.current.finish_count += Number(event.confidence || 1) >= 0.5 ? 1 : 0;
    } else if (name === "assistant_end") {
      if (["stop", "complete", "done"].includes(String(event.finish_reason || ""))) {
        this.current.finish_count += 1;
      }
      this.transientClosingBoost = this.current.finish_count;
      this._closeCurrentTurn();
    }
  }

  _recentSum(attr) {
    return this.recentTurns.reduce((sum, turn) => sum + Number(turn[attr] || 0), 0);
  }

  _recentMax(attr) {
    return this.recentTurns.reduce((max, turn) => Math.max(max, Number(turn[attr] || 0)), 0);
  }

  _visibleLoadSlope() {
    const values = [...this.recentTurns.map(visibleLoad), visibleLoad(this.current)];
    if (values.length < 2) return 0;
    return (values[values.length - 1] - values[0]) / Math.max(1, values.length - 1);
  }

  _signals(now) {
    const t = this.thresholds;
    const silentMs =
      this.active && this.lastActivityMs != null
        ? Math.max(0, now - this.lastActivityMs)
        : 0;
    const toolWaitMs =
      this.openToolStartMs != null ? Math.max(0, now - this.openToolStartMs) : 0;
    const outputLoad = this.current.assistant_tokens / t.long_output_tokens;
    const thinkingLoad = this.current.thinking_tokens / t.long_thinking_tokens;
    const feedbackLoad = this.current.feedback_tokens / t.heavy_feedback_tokens;
    const toolDensity = Math.min(1, this.current.tool_count / 5);
    const readToolDensity = Math.min(1, this.current.read_tool_count / 4);
    const commandDensity = Math.min(1, this.current.command_count / 3);
    const editPressure = Math.min(1, this.current.edit_count / 3);
    const testPressure = Math.min(1, this.current.test_count / 2);
    const recentErrors = this._recentSum("error_count");
    const recentTests = this._recentSum("test_count");
    const errorPressure = Math.min(
      1,
      this.current.error_count * 0.25 +
        recentErrors * 0.12 +
        this.current.test_count * 0.12 +
        recentTests * 0.06 +
        Math.min(1, feedbackLoad) * 0.25
    );
    const toolWaitLoad = toolWaitMs / t.tool_wait_ms;
    const commandWaitLoad = this.openToolKind === "command" ? toolWaitLoad : 0;
    const analysisToolLoad = Math.max(readToolDensity, toolDensity * 0.45);
    const silentWaitLoad = (this.goalMode ? 1.25 : 1) * silentMs / t.silent_wait_ms;
    const stalledPressure = Math.max(0, silentWaitLoad - 2) / 2;
    const commandStallPressure = Math.max(0, commandWaitLoad - 2) / 2;
    const closingSignal = Math.min(
      1,
      (this.current.finish_count + this.transientClosingBoost) * 0.8 +
        Math.max(0, -this._visibleLoadSlope()) * 0.2
    );

    return {
      output_load: clamp(outputLoad),
      thinking_load: clamp(thinkingLoad),
      feedback_load: clamp(feedbackLoad),
      tool_density: clamp(toolDensity),
      analysis_tool_load: clamp(analysisToolLoad),
      command_density: clamp(commandDensity),
      command_wait_load: clamp(commandWaitLoad),
      edit_pressure: clamp(editPressure),
      test_pressure: clamp(testPressure),
      error_pressure: clamp(errorPressure),
      tool_wait_load: clamp(toolWaitLoad),
      silent_wait_load: clamp(silentWaitLoad),
      stalled_pressure: clamp(Math.max(stalledPressure, commandStallPressure)),
      closing_signal: clamp(closingSignal),
    };
  }

  _scores(signals) {
    let reading = this.turnIndex <= 2 ? 0.65 : 0.05;
    reading *= 1 - Math.max(signals.output_load, signals.error_pressure);
    reading *= 1 - signals.edit_pressure;
    reading = Math.max(
      reading,
      signals.analysis_tool_load * (1 - signals.edit_pressure) * 0.85
    );
    const deep = Math.max(
      signals.output_load,
      signals.thinking_load,
      signals.silent_wait_load * 0.9,
      signals.tool_wait_load * 0.65,
      signals.edit_pressure * 0.65
    );
    const overheat = Math.max(
      signals.error_pressure,
      signals.test_pressure * 0.35,
      signals.stalled_pressure * 0.65
    );
    const closing = signals.closing_signal * (1 - Math.min(0.8, overheat));
    const activeWork = Math.max(
      signals.edit_pressure,
      signals.command_density * 0.55,
      signals.tool_density * 0.35
    );
    const steady = Math.max(
      0.45 * (1 - Math.max(deep, overheat, closing)) + 0.25,
      activeWork
    );

    return {
      reading_understanding: clamp(reading),
      steady_work: clamp(steady),
      deep_output: clamp(deep),
      overheat_debugging: clamp(overheat),
      closing: clamp(closing),
    };
  }

  _rawState(scores) {
    const priority = [
      "overheat_debugging",
      "deep_output",
      "closing",
      "reading_understanding",
      "steady_work",
    ];
    const best = priority.reduce((winner, name) =>
      scores[name] > scores[winner] ? name : winner
    , priority[0]);

    if (scores.overheat_debugging >= this.thresholds.overheat_pressure) {
      return "overheat_debugging";
    }
    if (scores.deep_output >= 0.75) return "deep_output";
    if (scores.closing >= this.thresholds.closing_signal) return "closing";
    if (scores.reading_understanding >= 0.45) return "reading_understanding";
    return scores[best] >= 0.45 ? best : "steady_work";
  }

  _refreshHold(state, scores, now, force = false) {
    const visibleMs = MIN_VISIBLE_MS[state] || 0;
    if (visibleMs <= 0) {
      if (force) this.holdUntilMs = now;
      return;
    }

    const score = scores[state] || 0;
    if (
      force ||
      score >= 0.45 ||
      ["deep_output", "overheat_debugging", "closing"].includes(state)
    ) {
      this.holdUntilMs = Math.max(this.holdUntilMs, now + visibleMs);
    }
  }

  _strongEnoughImmediateSwitch(state, scores) {
    const score = scores[state] || 0;
    if (state === "overheat_debugging") return score >= this.thresholds.overheat_pressure;
    if (state === "deep_output") return score >= 0.75;
    if (state === "closing") return score >= this.thresholds.closing_signal;
    if (state === "reading_understanding") return score >= 0.45;
    return score >= 0.65;
  }

  _smooth(rawState, scores, now) {
    const previousState = this.state;
    if (this.stateEnteredMs == null) this.stateEnteredMs = now;

    if (rawState === this.state) {
      this.candidateState = null;
      this.candidateTicks = 0;
      this.ticksInState += 1;
      this._refreshHold(rawState, scores, now);
      this.rawState = rawState;
      return { previousState, changed: false };
    }

    const higherPriority = STATE_PRIORITY[rawState] > STATE_PRIORITY[this.state];
    if (higherPriority && this._strongEnoughImmediateSwitch(rawState, scores)) {
      this.state = rawState;
      this.stateEnteredMs = now;
      this._refreshHold(rawState, scores, now, true);
      this.candidateState = null;
      this.candidateTicks = 0;
      this.ticksInState = 1;
      this.rawState = rawState;
      return { previousState, changed: previousState !== this.state };
    }

    if (now < this.holdUntilMs && !higherPriority) {
      this.candidateState = rawState;
      this.candidateTicks = 1;
      this.ticksInState += 1;
      this.rawState = rawState;
      return { previousState, changed: false };
    }

    const minDwellMs =
      this.state === "overheat_debugging"
        ? 4000
        : this.state === "deep_output"
          ? 2000
          : 0;
    const elapsed = this.lastEventMs == null ? 0 : now - this.lastEventMs;
    const enoughMargin = scores[rawState] >= (scores[this.state] || 0) + 0.20;

    if (this.candidateState === rawState) this.candidateTicks += 1;
    else {
      this.candidateState = rawState;
      this.candidateTicks = 1;
    }

    const canLeaveOverheat =
      this.state !== "overheat_debugging" || scores.overheat_debugging < 0.45;
    const dwellOk =
      minDwellMs === 0 || this.ticksInState * Math.max(elapsed, 500) >= minDwellMs;

    if (canLeaveOverheat && dwellOk && (this.candidateTicks >= 2 || enoughMargin)) {
      this.state = rawState;
      this.stateEnteredMs = now;
      this._refreshHold(rawState, scores, now, true);
      this.ticksInState = 1;
      this.rawState = rawState;
      return { previousState, changed: previousState !== this.state };
    }

    this.ticksInState += 1;
    this.rawState = rawState;
    return { previousState, changed: false };
  }

  _onlineFeatures(now) {
    return {
      history_turn_index: this.turnIndex,
      recent_error_count_sum: this._recentSum("error_count"),
      recent_test_count_sum: this._recentSum("test_count"),
      recent_edit_count_sum: this._recentSum("edit_count"),
      recent_assistant_tokens_max: this._recentMax("assistant_tokens"),
      recent_feedback_tokens_max: this._recentMax("feedback_tokens"),
      current_assistant_tokens_streamed: this.current.assistant_tokens,
      current_thinking_tokens_streamed: this.current.thinking_tokens,
      current_feedback_tokens: this.current.feedback_tokens,
      current_tool_count: this.current.tool_count,
      current_read_tool_count: this.current.read_tool_count,
      current_command_count: this.current.command_count,
      current_error_count: this.current.error_count,
      current_test_count: this.current.test_count,
      current_edit_count: this.current.edit_count,
      current_tool_wait_ms: this.openToolStartMs == null ? 0 : now - this.openToolStartMs,
      current_silent_wait_ms:
        !this.active || this.lastActivityMs == null ? 0 : Math.max(0, now - this.lastActivityMs),
      open_tool_kind: this.openToolKind,
      open_tool_name: this.openToolName,
      goal_mode: this.goalMode,
    };
  }

  _output(now, rawState, signals, scores, previousState, changed) {
    const intensity = clamp(
      Math.max(scores[this.state], signals.output_load, signals.error_pressure)
    );
    const enteredMs = this.stateEnteredMs == null ? now : this.stateEnteredMs;

    return {
      schema_version: "codex_pet_state.v0",
      session_id: this.sessionId,
      turn_id: this.turnId,
      timestamp_ms: now,
      state: this.state,
      state_zh: STATE_ZH[this.state],
      intensity: Number(intensity.toFixed(4)),
      confidence: Number(clamp(scores[this.state]).toFixed(4)),
      reason: reasonFor(this.state),
      signals: Object.fromEntries(
        Object.entries(signals).map(([key, value]) => [key, Number(value.toFixed(4))])
      ),
      online_features: this._onlineFeatures(now),
      state_scores: Object.fromEntries(
        Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(4))])
      ),
      presentation: presentationFor(this.state, intensity),
      smoothing: {
        previous_state: previousState,
        raw_state: rawState,
        ticks_in_state: this.ticksInState,
        state_age_ms: Math.max(0, now - enteredMs),
        hold_until_ms: this.holdUntilMs,
        remaining_hold_ms: Math.max(0, this.holdUntilMs - now),
        changed,
      },
    };
  }
}

module.exports = {
  WavePetEngine,
  STATE_ZH,
  STATE_PRIORITY,
  MIN_VISIBLE_MS,
};
