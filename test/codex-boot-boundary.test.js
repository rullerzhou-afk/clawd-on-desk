"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");

describe("local Codex rollout recovery respects this host's boot", () => {
  const base = 1000000, boot = base - 10000, preboot = boot - 1000;
  const uuid = "11111111-2222-3333-4444-555555555555";
  let monitor, tracked, events, questions, activity, tmp;
  const line = (type, subtype, occurredAt, extra = {}) => JSON.stringify({ type,
    timestamp: new Date(occurredAt).toISOString(),
    payload: { ...(subtype ? { type: subtype } : {}), turn_id: "T1", ...extra } });
  const request = occurredAt => line("response_item", "function_call", occurredAt, {
    name: "request_user_input", call_id: "synthetic-question", arguments: JSON.stringify({
      questions: [{ id: "q", header: "Choice", question: "Pick", options: [] }],
    }),
  });
  const makeMonitor = (bootTimeMs = boot) => new CodexLogMonitor(codexConfig, (...args) => events.push(args), {
    bootTimeMs, codexDir: tmp, onActivity: (...args) => activity.push(args),
    onUserInputRequest: (...args) => questions.push(args),
  });
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: base });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-boot-"));
    events = []; questions = []; activity = [];
    monitor = makeMonitor(); monitor._resolveTrackedAgentPid = () => null;
    tracked = { sessionId: "codex:" + uuid, filePath: path.join(tmp, "synthetic.jsonl"),
      cwd: "", lastState: null, activeTurnId: null, turnBoundaryOpen: false,
      pendingUserInputs: new Map(), backfilling: true, initializingUserInputs: true };
  });
  afterEach(() => {
    monitor.stop(); mock.timers.reset();
    // Delete only this test's verified, uniquely-created directory.
    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(tmp).startsWith("clawd-codex-boot-"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("preboot open work and questions cannot synthesize active or pending rows", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("response_item", "function_call", preboot, { name: "shell_command" }), tracked);
    monitor._processLine(request(preboot), tracked);
    monitor._emitBackfillSnapshot(tracked);
    tracked.backfilling = false; tracked.initializingUserInputs = false;
    monitor._emitPendingUserInputRequests(tracked);
    assert.deepEqual(events, []);
    assert.deepEqual(questions, []);
    assert.deepEqual(activity, []);
    assert.equal(tracked.activeTurnId, "T1", "private ownership remains available for a real continuation");
  });

  it("retains context metadata without turning preboot work into a lifecycle event", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("event_msg", "token_count", preboot, {
      info: { last_token_usage: { total_tokens: 50 }, model_context_window: 100 },
    }), tracked);
    monitor._emitBackfillSnapshot(tracked);
    assert.equal(events.length, 1);
    assert.equal(events[0][2], "event_msg:token_count");
    assert.equal(events[0][3].contextUsage.used, 50);
    assert.equal(events[0][3].syntheticBackfill, undefined);
    assert.deepEqual(activity, []);
  });

  it("offers only preboot lifecycle order to an optional private child observer without publishing it", () => {
    const observed = [];
    monitor._observePreBootDelegatedTurn = (owner, event, turnId, at) => {
      assert.equal(owner, tracked);
      observed.push({event, turnId, at});
    };
    monitor._processLine(line("session_meta", null, preboot, {id: uuid}), tracked);
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("event_msg", "agent_reasoning", preboot), tracked);
    monitor._processLine(line("event_msg", "task_complete", preboot), tracked);
    assert.deepEqual(observed, [
      {event: "event_msg:task_started", turnId: "T1", at: preboot},
      {event: "event_msg:task_complete", turnId: "T1", at: preboot},
    ]);
    monitor._emitBackfillSnapshot(tracked);
    assert.equal(tracked.bootActivityAt, undefined);
    assert.deepEqual(events, []);
    assert.deepEqual(questions, []);
    assert.deepEqual(activity, []);
    monitor._processLine(line("event_msg", "task_started", base, {turn_id: "T2"}), tracked);
    assert.equal(observed.length, 2, "postboot records use their normal processing path");
  });

  it("postboot quota-only telemetry cannot make preboot work active", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("event_msg", "token_count", base, {
      info: { last_token_usage: { total_tokens: 50 }, model_context_window: 100 },
    }), tracked);
    monitor._emitBackfillSnapshot(tracked);
    assert.ok(events.every(event => event[2] === "event_msg:token_count"));
    assert.deepEqual(activity, []);
  });

  it("postboot guardian-only history cannot admit a preboot open turn", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("event_msg", "guardian_assessment", base), tracked);
    monitor._finalizeReplayAfterScan(tracked.filePath, tracked);
    assert.equal(tracked.bootActivityAt, undefined);
    assert.equal(tracked.lastState, "thinking");
    assert.deepEqual(events, []);
    assert.deepEqual(activity, []);
  });

  it("guardian cannot replace an admitted postboot thinking phase in a backfill snapshot", () => {
    monitor._processLine(line("event_msg", "task_started", boot + 1000), tracked);
    monitor._processLine(line("event_msg", "guardian_assessment", base), tracked);
    monitor._finalizeReplayAfterScan(tracked.filePath, tracked);
    assert.equal(tracked.bootActivityAt, boot + 1000);
    assert.equal(events.length, 1);
    assert.equal(events[0][1], "thinking");
    assert.equal(events[0][2], "event_msg:task_started");
    assert.deepEqual(activity, []);
    monitor._processLine(line("event_msg", "guardian_assessment", base), tracked);
    assert.equal(tracked.lastState, "thinking", "live guardian also leaves the admitted phase alone");
    assert.equal(events.length, 1);
  });

  it("a real postboot continuation or new turn can emit its own live progress", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._emitBackfillSnapshot(tracked);
    tracked.backfilling = false; tracked.initializingUserInputs = false;
    monitor._processLine(line("event_msg", "agent_reasoning", base), tracked);
    assert.equal(activity.length, 1);
    assert.equal(activity[0][3].turnId, "T1");
    monitor._processLine(line("event_msg", "task_started", base, { turn_id: "T2" }), tracked);
    assert.equal(events.at(-1)[2], "event_msg:task_started");
    assert.equal(events.at(-1)[3].turnId, "T2");
  });

  it("a metadata-only startup snapshot does not erase a later real continuation's private phase", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(line("event_msg", "token_count", preboot, {
      info: { last_token_usage: { total_tokens: 50 }, model_context_window: 100 },
    }), tracked);
    monitor._emitBackfillSnapshot(tracked);
    tracked.backfilling = false; tracked.initializingUserInputs = false;
    monitor._processLine(line("event_msg", "agent_reasoning", base), tracked);
    assert.equal(activity.length, 1);
    assert.equal(activity[0][1], "thinking");
  });

  for (const reset of ["clear unpublished replay", "rebaseline replaced file"]) {
    it(`${reset} drops postboot evidence before another preboot replay`, () => {
      monitor._processLine(line("event_msg", "task_started", base), tracked);
      assert.equal(tracked.bootActivityAt, base);
      if (reset === "rebaseline replaced file") {
        monitor._rebaselineTrackedFile(tracked.filePath, tracked, 0, "synthetic-replaced-file");
      } else {
        monitor._clearUnpublishedReplayState(tracked);
      }
      assert.equal(tracked.bootActivityAt, undefined);
      // The next attach replays a file with only the previous boot's open turn.
      tracked.backfilling = true; tracked.initializingUserInputs = true;
      monitor._processLine(line("event_msg", "task_started", preboot), tracked);
      monitor._finalizeReplayAfterScan(tracked.filePath, tracked);
      assert.deepEqual(events, []);
      assert.deepEqual(questions, []);
      assert.deepEqual(activity, []);
    });
  }

  for (const refreshedMtime of [false, true]) {
    it(`rejects preboot pending recovery with ${refreshedMtime ? "refreshed" : "old"} file mtime`, () => {
      const name = "rollout-2026-10-27T00-00-00-" + uuid + ".jsonl";
      const file = path.join(tmp, name);
      fs.writeFileSync(file, [line("session_meta", null, preboot, { id: uuid, cwd: "/synthetic" }),
        line("event_msg", "task_started", preboot), request(preboot)].join("\n") + "\n");
      const stamp = new Date(refreshedMtime ? base : base - 600000);
      fs.utimesSync(file, stamp, stamp);
      const recovered = monitor._recoverStalePendingUserInput(file, name, fs.statSync(file));
      if (recovered) monitor._emitPendingUserInputRequests(recovered);
      assert.deepEqual(questions, []);
      assert.ok(events.every(event => event[2] === "event_msg:token_count"));
    });
  }

  it("does recover a postboot pending question from an older rollout", () => {
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._processLine(request(base), tracked);
    tracked.backfilling = false; tracked.initializingUserInputs = false;
    monitor._emitPendingUserInputRequests(tracked);
    assert.equal(questions.length, 1);
  });

  it("direct monitors without a host boundary retain their existing remote/test contract", () => {
    monitor = makeMonitor(null);
    monitor._processLine(line("event_msg", "task_started", preboot), tracked);
    monitor._emitBackfillSnapshot(tracked);
    assert.equal(events.length, 1);
    assert.equal(events[0][3].syntheticBackfill, true);
  });
});
