"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const { normalizePlanProgress, planProgressFromCall } = require("../hooks/codex-plan-progress");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");

test("plan progress accepts only bounded, valid update_plan steps", () => {
  const call = (plan) => ({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan }) });
  assert.deepEqual(planProgressFromCall(call([
    { status: "completed" }, { status: "in_progress" }, { status: "pending" },
  ])), { completed: 1, total: 3, percent: 33 });
  assert.equal(planProgressFromCall(call([])), null);
  assert.equal(planProgressFromCall(call([{ status: "unknown" }])), null);
  assert.equal(planProgressFromCall({ type: "function_call", name: "exec_command", arguments: "{}" }), undefined);
  assert.equal(normalizePlanProgress({ completed: 201, total: 201 }), null);
  assert.equal(normalizePlanProgress({ completed: 2, total: 1 }), null);
});

test("Codex JSONL carries a plan, preserves it at turn end, and clears it on the next turn", () => {
  const events = [];
  const monitor = new CodexLogMonitor({
    ...codexConfig,
    logConfig: { ...codexConfig.logConfig, sessionDir: path.join(os.tmpdir(), "codex-plan-progress-test") },
  }, (...event) => events.push(event));
  monitor._findCodexWriterPid = () => null;
  const tracked = {
    sessionId: "codex:plan-fixture",
    filePath: path.join(os.tmpdir(), "plan-fixture.jsonl"),
    cwd: "/fixture",
    backfilling: false,
    pendingUserInputs: new Map(),
    initializingUserInputs: false,
    planProgress: null,
    activeTurnId: null,
    turnBoundaryOpen: false,
    lastState: "working",
    hadToolUse: true,
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
  };
  const process = (type, payload) => monitor._processLine(JSON.stringify({
    timestamp: new Date().toISOString(), type, payload,
  }), tracked);

  try {
    process("response_item", {
      type: "function_call",
      name: "update_plan",
      call_id: "plan-1",
      arguments: JSON.stringify({ plan: [{ status: "completed" }, { status: "pending" }] }),
    });
    assert.equal(events.at(-1)[3].planProgress.percent, 50);

    process("event_msg", { type: "task_complete", turn_id: "turn-1" });
    assert.equal(events.at(-1)[3].planProgress.percent, 50);

    process("event_msg", { type: "task_started", turn_id: "turn-2" });
    assert.equal(tracked.planProgress, null);
    assert.equal(events.at(-1)[2], "event_msg:task_started");
    assert.equal(events.at(-1)[3].planProgress, null);

    process("response_item", {
      type: "function_call",
      name: "functions.update_plan",
      call_id: "plan-2",
      arguments: "{ invalid json",
    });
    assert.equal(events.at(-1)[3].planProgress, null);
  } finally {
    monitor.stop();
  }
});

test("pending request_user_input startup replay carries only its own turn's checklist", () => {
  const shown = [];
  const monitor = new CodexLogMonitor({
    ...codexConfig,
    logConfig: { ...codexConfig.logConfig, sessionDir: path.join(os.tmpdir(), "codex-plan-progress-replay") },
  }, () => {}, { onUserInputRequest: (...args) => shown.push(args) });
  monitor._findCodexWriterPid = () => null;
  const tracked = {
    sessionId: "codex:replayed-question",
    cwd: "/repo", planProgress: { completed: 2, total: 4, percent: 50 },
    planProgressTurnId: "turn-B", isSubagent: false,
    pendingUserInputs: new Map([
      ["q-B", { callId: "q-B", questions: [], activity: { turnId: "turn-B", userInputReplay: true } }],
      ["q-A", { callId: "q-A", questions: [], activity: { turnId: "turn-A", userInputReplay: true } }],
    ]),
  };
  try {
    monitor._emitPendingUserInputRequests(tracked);
    assert.equal(shown.length, 2);
    assert.equal(shown[0][2].turnId, "turn-B");
    assert.deepEqual(shown[0][2].planProgress, tracked.planProgress);
    assert.equal(shown[0][2].planProgressTurnId, "turn-B");
    assert.equal(shown[1][2].turnId, "turn-A");
    assert.equal(Object.hasOwn(shown[1][2], "planProgress"), false,
      "a stale unanswered request may not inherit another turn's progress");
  } finally {
    monitor.stop();
  }
});
