"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const createRuntime = require("../src/agent-runtime-main");
const themeLoader = require("../src/theme-loader");
const { resolveSessionIdentity } = require("../src/session-key");
const { buildStateBody } = require("../hooks/codex-hook");
const { handleStatePost } = require("../src/server-route-state");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: TTL } = require("../src/state-stale-cleanup");

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = n => `codex:${uuid(n)}`;
const key = n => resolveSessionIdentity(raw(n), "local").sessionId;
const noop = () => {};

function harness(t, overrides = {}, minDisplay = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  themeLoader.init(path.join(__dirname, "..", "src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = minDisplay;
  theme.timings.autoReturn = { attention: 5, "mini-happy": 5 };
  const sounds = [], flashes = [], visuals = [];
  const ctx = { theme, lang: "en", doNotDisturb: false, miniMode: false,
    pendingPermissions: [], t: k => k, focusHostPlatform: "darwin",
    playSound: sound => sounds.push(sound), flashTaskbar: () => flashes.push(Date.now()),
    sendToRenderer: (channel, state) => { if (channel === "state-change") visuals.push(state); },
    syncHitWin: noop, sendToHitWin: noop, buildContextMenu: noop, buildTrayMenu: noop,
    processKill: () => true, getStaleConfig: () => ({ sessionStaleMs: 0 }),
    ...overrides,
  };
  const state = require("../src/state")(ctx);
  let runtime, monitor, dir;
  const owners = new Map(), activities = [];
  t.after(() => {
    runtime?.cleanup(); state.cleanup();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const update = (event, phase, n = 1, extra = {}) => state.updateSession(key(n), phase, event, {
    agentId: "codex", profileId: "local", rawSessionId: raw(n), ...extra,
  });
  const count = (n = 1) => state.buildSessionSnapshot().sessions.find(s => s.id === key(n))?.activeSubagentCount;
  const cues = expected => {
    assert.equal(sounds.filter(s => s === "complete").length, expected, "completion sounds");
    assert.equal(flashes.length, expected, "taskbar flashes");
  };
  function child(phase, n = 2, parent = 1, turnId = "child-turn", terminal = true) {
    const accepted = state.updateCodexSubagentActivity(key(parent), {
      childId: raw(n), phase, turnId, occurredAt: Date.now(),
      ...(phase === "stop" && terminal ? { terminal: true } : {}),
    });
    assert.equal(accepted, true, `accepted ${phase} for child ${n}`);
  }
  function pending(children = [2], parent = 1) {
    update("UserPromptSubmit", "thinking", parent);
    for (const n of children) child("start", n, parent);
    update("Stop", "attention", parent);
    assert.equal(count(parent), children.length);
    const session = state.sessions.get(key(parent));
    assert.equal(session.state, "idle");
    assert.equal(session.awaitingInputSinceStop, true);
    cues(0);
  }
  const settle = () => t.mock.timers.tick(6);
  function startRuntime() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-child-cue-"));
    class Monitor extends CodexLogMonitor {
      constructor(config, callback, options) {
        super({ ...config, logConfig: { ...config.logConfig, sessionDir: dir } }, callback, {
          ...options, now: () => Date.now(), onSubagentActivity: (parentId, activity) => {
            activities.push({ parentId, ...activity });
            options.onSubagentActivity(parentId, activity);
          },
        });
        monitor = this;
        this._findCodexWriterPid = () => null;
      }
      start() { this._poll(); }
    }
    runtime = createRuntime({ loadCodexLogMonitor: () => Monitor, now: () => Date.now(),
      getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
    });
    runtime.startCodexLogMonitor();
    return { runtime, monitor, dir };
  }
  function feed(n, type, payload) {
    let tracked = owners.get(n);
    if (!tracked) {
      tracked = { sessionId: raw(n), filePath: path.join(dir, `${uuid(n)}.jsonl`), lastState: "idle",
        pendingUserInputs: new Map(), turnBoundaryOpen: false, backfilling: false };
      owners.set(n, tracked);
    }
    monitor._processLine(JSON.stringify({ timestamp: new Date().toISOString(), type, payload }), tracked);
    return tracked;
  }
  function startChild(n = 2, turnId = "child-turn") {
    if (!owners.has(n)) feed(n, "session_meta", {
      id: uuid(n), source: { subagent: { thread_spawn: { parent_thread_id: uuid(1), depth: 1 } } },
    });
    return feed(n, "event_msg", { type: "task_started", turn_id: turnId });
  }
  return { state, ctx, update, count, cues, child, pending, settle, startRuntime, feed, startChild, activities, visuals };
}

it("PR #1270 follow-up: one child defers sound, flash and happy until its terminal stop", t => {
  const h = harness(t); h.pending();
  const before = structuredClone(h.state.sessions.get(key(1)));
  t.mock.timers.tick(10);
  h.child("stop"); h.cues(1);
  assert.equal(h.state.getCurrentState(), "attention");
  assert.deepEqual(h.visuals.slice(-1), ["attention"]);
  assert.notEqual(h.visuals.at(-2), "idle", "no intermediate idle visual before the deferred happy");
  assert.deepEqual(h.state.sessions.get(key(1)), before);
});

it("PR #1270 follow-up: broadcasts the final child count while completion waits for a minimum display hold", t => {
  const snapshots = [];
  const h = harness(t, { broadcastSessionSnapshot: snapshot => snapshots.push(snapshot) }, { error: 50 });
  const latestParent = () => snapshots.at(-1)?.sessions.find(s => s.id === key(1));
  h.state.setState("error");
  h.pending();
  assert.equal(h.state.getCurrentState(), "error");
  assert.equal(latestParent()?.activeSubagentCount, 1);
  h.child("stop"); h.cues(0);
  assert.equal(h.state.getCurrentState(), "error");
  assert.equal(latestParent()?.activeSubagentCount, 0, "HUD updates before the queued attention applies");
  t.mock.timers.tick(49); h.cues(0);
  assert.equal(h.state.getCurrentState(), "error");
  t.mock.timers.tick(1); h.cues(1);
  assert.equal(h.state.getCurrentState(), "attention");
  h.settle(); h.cues(1);
});

it("PR #1270 follow-up: two children celebrate only the final terminal stop", t => {
  const h = harness(t); h.pending([2, 3]);
  h.child("stop", 2); assert.equal(h.count(), 1); h.cues(0);
  h.child("stop", 3); assert.equal(h.count(), 0); h.cues(1);
});

it("PR #1270 follow-up: duplicate parent completion while children run preserves one deferred cue", t => {
  const h = harness(t); h.pending();
  h.update("event_msg:task_complete", "attention"); h.cues(0);
  assert.equal(h.count(), 1);
  h.child("stop"); h.cues(1);
});

it("PR #1270 follow-up: late duplicate completion after happy returns to idle stays silent", t => {
  const h = harness(t); h.pending(); h.child("stop"); h.cues(1);
  h.settle(); assert.equal(h.state.getCurrentState(), "idle");
  h.update("event_msg:task_complete", "attention"); h.settle(); h.cues(1);
});

it("PR #1270 follow-up: parent SessionEnd celebrates before deleting its row", t => {
  const h = harness(t); h.pending();
  h.update("SessionEnd", "sleeping");
  assert.equal(h.state.sessions.has(key(1)), false); h.cues(1);
  h.settle(); h.update("SessionEnd", "sleeping"); h.cues(1);
});

it("PR #1270 follow-up: parent SessionEnd celebrates while retaining a replyable row", t => {
  const h = harness(t, { hasReplyableCompletionMapping: () => true }); h.pending();
  const before = structuredClone(h.state.sessions.get(key(1)));
  h.update("SessionEnd", "sleeping"); h.cues(1);
  assert.equal(h.state.getCurrentState(), "attention");
  assert.deepEqual(h.state.sessions.get(key(1)), before);
  assert.equal(h.count(), 0);
  h.settle(); h.update("SessionEnd", "sleeping"); h.cues(1);
});

it("PR #1270 follow-up: headless child SessionEnd celebrates once before a duplicate monitor stop", t => {
  const h = harness(t); h.pending();
  h.update("PreToolUse", "working", 2, { headless: true });
  assert.equal(h.count(), 1);
  h.update("SessionEnd", "sleeping", 2, { headless: true }); h.cues(1);
  assert.equal(h.count(), 0);
  h.settle();
  assert.equal(h.state.updateCodexSubagentActivity(key(1), {
    childId: raw(2), turnId: "child-turn", phase: "stop", terminal: true, occurredAt: Date.now(),
  }), false);
  h.cues(1);
});

it("PR #1270 follow-up: mini mode celebrates the final child with mini-happy", t => {
  const h = harness(t, { miniMode: true }); h.pending();
  h.child("stop"); h.cues(1);
  assert.equal(h.state.getCurrentState(), "mini-happy");
});

it("PR #1270 follow-up: Desktop ephemeral completion survives both HUD hiding preferences", t => {
  const h = harness(t, { sessionHudHideCompletedCodexEphemeral: true, sessionHudHideActiveCodexEphemeral: true });
  h.update("UserPromptSubmit", "thinking", 1, { hookSource: "codex-official", codexClientEphemeral: true, codexOriginator: "Codex Desktop" });
  assert.equal(h.state.sessions.get(key(1)).codexClientEphemeral, true);
  assert.equal(h.state.buildSessionSnapshot().sessions[0].hudHiddenByPreference, true);
  h.child("start"); assert.equal(h.count(), 1);
  h.update("Stop", "attention"); h.cues(0);
  assert.equal(h.state.sessions.get(key(1)).awaitingInputSinceStop, true);
  h.child("stop"); h.cues(1);
  assert.equal(h.state.buildSessionSnapshot().sessions[0].hudHiddenByPreference, true);
});

it("PR #1270 follow-up: actual hook route runtime and rollout polling deliver a deferred cue without parent writes", async t => {
  const h = harness(t);
  const { runtime, monitor, dir } = h.startRuntime();
  const date = new Date();
  const day = path.join(dir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  const rollout = n => path.join(day, `rollout-2026-10-30T12-00-00-${uuid(n)}.jsonl`);
  const record = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  const append = (n, type, payload) => fs.appendFileSync(rollout(n), record(type, payload));
  const turns = new Map();
  async function hook(event) {
    const wire = buildStateBody({ hook_event_name: event, session_id: uuid(1), turn_id: "parent-turn",
      transcript_path: rollout(1), source: "cli", originator: "codex-cli", tool_name: "exec_command" },
    () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] }), { platform: "darwin", env: {} });
    assert.equal(wire.session_id, raw(1));
    const req = new EventEmitter(); req.headers = {};
    await new Promise(resolve => {
      const res = { writeHead(code) { this.statusCode = code; }, end() { assert.equal(this.statusCode, 200); resolve(); } };
      handleStatePost(req, res, {
        ctx: { STATE_SVGS: { idle: "x.svg", thinking: "x.svg", working: "x.svg", attention: "x.svg", "codex-turn-end": "x.svg" },
          sessions: h.state.sessions, pendingPermissions: [], isAgentEnabled: () => true,
          updateSession: (...args) => runtime.updateSessionFromServer(...args),
          setState: noop, resolvePermissionEntry: noop, permLog: noop },
        shouldDropForDnd: () => false, codexOfficialTurns: turns,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: noop, droppedByDisabled: noop, droppedByDnd: noop,
          droppedInvalidAgent: noop, droppedUnsupported: noop }),
      });
      req.emit("data", Buffer.from(JSON.stringify(wire))); req.emit("end");
    });
  }
  append(1, "session_meta", { id: uuid(1), source: "cli", originator: "codex-cli" });
  await hook("UserPromptSubmit");
  append(2, "session_meta", { id: uuid(2), source: { subagent: { thread_spawn: { parent_thread_id: uuid(1) } } } });
  append(2, "event_msg", { type: "task_started", turn_id: "child-turn" });
  monitor._poll(); assert.equal(h.count(), 1);
  await hook("PreToolUse");
  h.update("PreToolUse", "working", 1, { turnId: "parent-turn", planProgress: { completed: 1, total: 2 }, assistantLastOutput: "parent output" });
  append(1, "event_msg", { type: "agent_message", message: "parent output" });
  await hook("Stop"); h.cues(0);
  const before = structuredClone(h.state.sessions.get(key(1)));
  assert.equal(before.state, "idle"); assert.equal(before.awaitingInputSinceStop, true);
  assert.deepEqual(before.planProgress, { completed: 1, total: 2, percent: 50 });
  assert.equal(before.assistantLastOutput, "parent output");
  const snapshots = [];
  h.ctx.broadcastSessionSnapshot = snapshot => snapshots.push(snapshot);
  t.mock.timers.tick(10);
  append(2, "event_msg", { type: "task_complete", turn_id: "child-turn" });
  monitor._poll(); h.cues(1);
  assert.equal(h.count(), 0);
  assert.equal(h.activities.at(-1).terminal, true);
  assert.deepEqual(h.state.sessions.get(key(1)), before, "includes recentEvents, updatedAt, plan and output");
  assert.ok(snapshots.some(s => s.sessions.find(row => row.id === key(1))?.activeSubagentCount === 0));
});

it("PR #1270 follow-up: a new prompt then Interrupt cancels the previous deferred cue", t => {
  const h = harness(t); h.pending();
  h.update("UserPromptSubmit", "thinking");
  h.update("Interrupt", "idle");
  assert.equal(h.state.sessions.get(key(1)).state, "idle");
  assert.equal(h.state.sessions.get(key(1)).awaitingInputSinceStop, false);
  h.child("stop"); h.cues(0);
});

it("PR #1270 follow-up: a new prompt cancels the previous deferred cue", t => {
  const h = harness(t); h.pending();
  h.update("UserPromptSubmit", "thinking");
  assert.equal(h.state.sessions.get(key(1)).state, "thinking");
  h.child("stop"); h.cues(0);
});

it("PR #1270 follow-up: parent Interrupt is not a completed turn to celebrate", t => {
  const h = harness(t); h.pending();
  h.update("Interrupt", "idle");
  assert.equal(h.state.sessions.get(key(1)).state, "idle");
  assert.equal(h.state.sessions.get(key(1)).awaitingInputSinceStop, false);
  h.child("stop"); h.cues(0);
});

it("PR #1270 follow-up: children discovered after an already played Stop do not reopen its cue", t => {
  const h = harness(t); h.update("UserPromptSubmit", "thinking"); h.update("Stop", "attention"); h.cues(1);
  h.settle(); assert.equal(h.state.getCurrentState(), "idle");
  h.child("start"); assert.equal(h.count(), 1);
  h.update("event_msg:task_complete", "attention"); h.cues(1);
  h.child("stop"); h.settle(); h.cues(1);
});

it("PR #1270 follow-up: an unrelated headless SessionEnd cannot settle expired parent evidence", t => {
  const h = harness(t);
  h.update("PreToolUse", "working", 4, { headless: true });
  h.pending();
  t.mock.timers.tick(TTL + 1);
  assert.equal(h.count(), 0); assert.equal(h.state.sessions.has(key(1)), true);
  h.update("SessionEnd", "sleeping", 4, { headless: true }); h.cues(0);
  assert.equal(h.state.sessions.has(key(1)), true);
});

it("PR #1270 follow-up: TTL cleanup cancels debt even if the same child later recovers and finishes", t => {
  const h = harness(t); h.pending();
  t.mock.timers.tick(TTL + 1); h.state.cleanStaleSessions();
  assert.equal(h.count(), 0); assert.equal(h.state.sessions.has(key(1)), true);
  h.child("activity"); assert.equal(h.count(), 1);
  h.child("stop"); h.cues(0);
});

it("PR #1270 follow-up: real runtime monitor stop cancels debt without celebrating", t => {
  const h = harness(t); const { runtime } = h.startRuntime();
  h.update("UserPromptSubmit", "thinking"); h.startChild();
  assert.equal(h.count(), 1); h.update("Stop", "attention"); h.cues(0);
  runtime.stopMonitorForAgent("codex"); h.cues(0);
  assert.equal(h.activities.at(-1).phase, "stop");
  assert.equal(h.activities.at(-1).terminal, undefined);
  assert.equal(h.count(), 0); assert.equal(h.state.sessions.has(key(1)), true);
  h.child("start"); h.child("stop"); h.cues(0);
});

it("PR #1270 follow-up: last tracker owner retirement cancels debt before real recovery and completion", t => {
  const h = harness(t); const { monitor } = h.startRuntime();
  h.update("UserPromptSubmit", "thinking"); const owner = h.startChild();
  assert.equal(h.count(), 1); h.update("Stop", "attention"); h.cues(0);
  monitor._detachDelegatedChildOwner(owner);
  assert.equal(h.activities.at(-1).phase, "stop");
  assert.equal(h.activities.at(-1).terminal, undefined); h.cues(0);
  assert.equal(h.count(), 0);
  owner.delegatedChild.owners.add(owner);
  h.feed(2, "response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
  assert.equal(h.count(), 1);
  h.feed(2, "event_msg", { type: "task_complete", turn_id: "child-turn" });
  assert.equal(h.count(), 0); h.cues(0);
});

it("PR #1270 follow-up: child turn replacement cancels debt with a nonterminal stop", t => {
  const h = harness(t); h.startRuntime();
  h.update("UserPromptSubmit", "thinking"); h.startChild();
  h.update("Stop", "attention"); assert.equal(h.count(), 1); h.cues(0);
  h.startChild(2, "next-child-turn");
  assert.deepEqual(h.activities.slice(-2).map(e => [e.phase, e.terminal]), [["stop", undefined], ["start", undefined]]);
  assert.equal(h.count(), 1); h.cues(0);
  h.feed(2, "event_msg", { type: "task_complete", turn_id: "next-child-turn" }); h.cues(0);
});

it("PR #1270 follow-up: a confirmed Kimi hold discards the deferred cue without replay on release", t => {
  const h = harness(t); h.pending();
  h.state.updateSession("kimi:hold", "notification", "PermissionRequest", { agentId: "kimi-cli" });
  assert.equal(h.state.resolveDisplayState(), "notification");
  h.child("stop"); h.cues(0);
  h.state.updateSession("kimi:hold", "working", "PostToolUse", { agentId: "kimi-cli" });
  h.settle(); h.cues(0); assert.notEqual(h.state.resolveDisplayState(), "notification");
});

it("PR #1270 follow-up: separate parents each receive exactly one deferred cue", t => {
  const h = harness(t); h.pending([2]); h.pending([4], 3);
  h.child("stop", 2, 1); h.cues(1); assert.equal(h.count(3), 1);
  h.settle(); assert.notEqual(h.state.getCurrentState(), "attention");
  h.child("stop", 4, 3); h.cues(2); h.settle();
  h.update("event_msg:task_complete", "attention", 1);
  h.update("event_msg:task_complete", "attention", 3); h.cues(2);
});

it("PR #1270 follow-up: a later tool-free turn cannot inherit the previous turn's deferred cue", t => {
  const h = harness(t); h.pending();
  h.update("UserPromptSubmit", "thinking");
  // Official Stop without tool use settles idle without requesting a happy cue.
  h.update("Stop", "idle");
  assert.equal(h.state.sessions.get(key(1)).state, "idle");
  assert.equal(h.state.sessions.get(key(1)).awaitingInputSinceStop, true);
  assert.equal(h.count(), 1); h.cues(0);
  h.child("stop"); h.cues(0);
});

for (const terminal of ["task_complete", "turn_aborted", "Stop", "SessionEnd"]) {
  it(`PR #1270 follow-up: monitor forwards confirmed ${terminal} to the deferred cue`, t => {
    const h = harness(t); const { runtime } = h.startRuntime();
    h.update("UserPromptSubmit", "thinking"); h.startChild();
    h.update("Stop", "attention"); assert.equal(h.count(), 1); h.cues(0);
    if (terminal === "Stop" || terminal === "SessionEnd") {
      runtime.updateSessionFromServer(key(2), terminal === "Stop" ? "idle" : "sleeping", terminal, {
        agentId: "codex", profileId: "local", rawSessionId: raw(2), headless: true,
        hookSource: "codex-official", turnId: "child-turn",
      });
    } else {
      h.feed(2, "event_msg", { type: terminal, turn_id: "child-turn" });
    }
    h.cues(1); assert.equal(h.count(), 0);
    assert.equal(h.activities.at(-1).terminal, true);
    h.settle();
    h.feed(2, "event_msg", { type: "task_complete", turn_id: "child-turn" }); h.cues(1);
  });
}
