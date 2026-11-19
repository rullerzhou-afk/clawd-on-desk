"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codex = require("../agents/codex");
const themeLoader = require("../src/theme-loader");
const createRuntime = require("../src/agent-runtime-main");
const { resolveSessionIdentity } = require("../src/session-key");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: TTL } = require("../src/state-stale-cleanup");
// Test aliases are resolved to native UUIDs before any production boundary.
const nativeIds = new Map();
function native(id) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return id;
  if (!nativeIds.has(id)) nativeIds.set(id, `00000000-0000-4000-8000-${String(nativeIds.size + 1).padStart(12, "0")}`);
  return nativeIds.get(id);
}
const raw = id => `codex:${native(id)}`;
const key = id => resolveSessionIdentity(raw(id), "local").sessionId;

function makeState(overrides = {}, notificationAutoReturnMs = 0) {
  themeLoader.init(path.join(__dirname, "..", "src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
  if (notificationAutoReturnMs) theme.timings.autoReturn.notification = notificationAutoReturnMs;
  return require("../src/state")({ theme, lang: "en", doNotDisturb: false,
    miniMode: false, pendingPermissions: [], t: k => k,
    playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
    buildContextMenu() {}, buildTrayMenu() {}, processKill() { return true; },
    ...overrides,
  });
}

describe("Codex delegated child presentation", () => {
  let state;
  beforeEach(() => { state = makeState(); });
  afterEach(() => state.cleanup());
  const update = (s, event = "PreToolUse", phase = "working", extra = {}) =>
    s.updateSession(key("parent"), phase, event, { agentId: "codex", profileId: "local", ...extra });
  const child = (s, id, phase = "start", turn = "child-turn", at = Date.now()) =>
    s.updateCodexSubagentActivity(key("parent"), { childId: raw(id), turnId: turn, phase, occurredAt: at });
  const svg = s => s.getSvgOverride(s.resolveDisplayState());

  it("projects 2→1→0 over the latest real parent phase without changing its metadata", () => {
    update(state, "PreToolUse", "working", { sourcePid: 123, planProgress: { total: 1, completed: 0 } });
    const parent = state.sessions.get(key("parent"));
    const original = structuredClone(parent);
    child(state, "a"); child(state, "b"); child(state, "a");
    assert.equal(svg(state), "clawd-working-juggling.svg");
    assert.deepEqual(parent, original);
    update(state, "UserPromptSubmit", "thinking");
    assert.equal(state.resolveDisplayState(), "juggling");
    child(state, "a", "stop");
    assert.equal(svg(state), "clawd-headphones-groove.svg");
    child(state, "a", "stop"); child(state, "unknown", "stop");
    assert.equal(svg(state), "clawd-headphones-groove.svg");
    child(state, "b", "stop");
    assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("keeps a child through parent Stop, then returns to idle with no fabricated event", () => {
    update(state); child(state, "a");
    update(state, "Stop", "attention");
    const parent = state.sessions.get(key("parent"));
    assert.equal(parent.state, "idle");
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(state.getCurrentState(), "juggling");
    assert.equal(state.hasActiveCodexSubagents(), true);
    const before = structuredClone(parent);
    child(state, "a", "stop");
    assert.equal(state.resolveDisplayState(), "idle");
    assert.equal(state.hasActiveCodexSubagents(), false);
    assert.deepEqual(state.sessions.get(key("parent")), before);
  });

  it("rejects missing/headless/remote parents and never readmits activity after parent retirement", () => {
    assert.equal(child(state, "a"), false);
    update(state, "PreToolUse", "working", { headless: true });
    assert.equal(child(state, "a"), false);
    state.sessions.clear(); update(state, "PreToolUse", "working", { host: "remote" });
    assert.equal(child(state, "a"), false);
    state.sessions.clear(); update(state, "PreToolUse", "working", { platform: "wsl" });
    assert.equal(child(state, "a"), false);
    state.sessions.clear(); update(state); child(state, "a");
    update(state, "SessionEnd", "sleeping");
    update(state);
    assert.equal(child(state, "a", "activity"), false);
    assert.equal(state.resolveDisplayState(), "working");
  });

  it("child progress protects stale parent only while real evidence remains fresh", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"] });
    update(state); child(state, "a");
    const at = state.sessions.get(key("parent")).updatedAt;
    mock.timers.tick(TTL - 1);
    child(state, "a", "activity");
    state.cleanStaleSessions();
    assert.equal(state.sessions.get(key("parent")).updatedAt, at);
    assert.equal(state.resolveDisplayState(), "juggling");
    mock.timers.tick(TTL + 1); state.cleanStaleSessions();
    assert.notEqual(state.resolveDisplayState(), "juggling");
  });

  it("exports effective state/count separately from the parent's real completion and plan", () => {
    update(state); child(state, "a"); update(state, "Stop", "attention");
    const entry = state.buildSessionSnapshot().sessions.find(e => e.id === key("parent"));
    assert.equal(entry.state, "idle");
    assert.equal(entry.effectiveState, "juggling");
    assert.equal(entry.activeSubagentCount, 1);
    assert.equal(entry.lastEvent.rawEvent, "Stop");
    child(state, "a", "stop");
    assert.equal(state.buildSessionSnapshot().sessions.find(e => e.id === key("parent")).activeSubagentCount, 0);
  });

  it("preserves sweeping and permission presentation while child progress arrives", () => {
    update(state); state.applyState("sweeping"); child(state, "a");
    state.updateSession(key("a"), "working", "response_item:function_call", { agentId: "codex", headless: true });
    assert.equal(state.getCurrentState(), "sweeping");
    state.applyState("notification"); child(state, "b");
    assert.equal(state.getCurrentState(), "notification");
  });

  it("recovers a timed-out child on real fenced progress but releases it on disable/dismiss", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"] });
    update(state); child(state, "a");
    mock.timers.tick(TTL + 1);
    assert.equal(state.resolveDisplayState(), "working");
    assert.equal(state.hasActiveCodexSubagents(), false);
    child(state, "a", "activity");
    assert.equal(state.resolveDisplayState(), "juggling");
    state.dismissSession(key("parent")); update(state);
    assert.equal(child(state, "a", "activity"), false);
    child(state, "b"); state.clearSessionsByAgent("codex"); update(state);
    assert.equal(child(state, "b", "activity"), false);
  });

  it("does not project a grandchild onto the root or merge other parent sessions", () => {
    update(state); child(state, "a");
    state.updateSession(key("a"), "working", "PreToolUse", { agentId: "codex", headless: true });
    assert.equal(state.updateCodexSubagentActivity(key("a"), {
      childId: raw("grandchild"), turnId: "turn", phase: "start", occurredAt: Date.now(),
    }), false);
    assert.equal(svg(state), "clawd-headphones-groove.svg");
    state.updateSession(key("other"), "working", "PreToolUse", { agentId: "codex", profileId: "remote-profile" });
    assert.equal(state.updateCodexSubagentActivity(key("other"), {
      childId: raw("a"), turnId: "turn", phase: "start", occurredAt: Date.now(),
    }), false);
  });

  it("maintains evidence silently through DND and preserves preview/sleeping parent gates", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"] });
    update(state); state.enableDoNotDisturb();
    const sleep = state.getCurrentState();
    child(state, "a"); child(state, "a", "activity");
    assert.equal(state.getCurrentState(), sleep);
    child(state, "a", "stop");
    assert.equal(state.getCurrentState(), sleep);
    child(state, "b"); mock.timers.tick(TTL + 1); state.cleanStaleSessions();
    assert.equal(state.getCurrentState(), sleep);
    state.disableDoNotDisturb();
    update(state);
    state.applyState("working", "preview.svg", { settingsPreview: true });
    child(state, "preview-child");
    assert.equal(state.isSettingsPreviewVisual(), true);
    state.sessions.get(key("parent")).state = "sleeping";
    assert.equal(child(state, "sleep-child"), false);
    assert.equal(state.hasActiveCodexSubagents(), false);
  });

  it("ends delegated admission even when SessionEnd retains a replyable parent row", () => {
    state.cleanup(); state = makeState({ hasReplyableCompletionMapping: () => true });
    update(state); child(state, "a"); update(state, "Stop", "attention");
    update(state, "SessionEnd", "sleeping");
    assert.equal(state.sessions.get(key("parent")).state, "idle");
    assert.equal(state.hasActiveCodexSubagents(), false);
    assert.equal(state.getCurrentState(), "attention");
    assert.equal(child(state, "a", "activity"), false);
    assert.equal(child(state, "new-child"), false);
    update(state, "UserPromptSubmit", "thinking");
    child(state, "new-child"); assert.equal(state.resolveDisplayState(), "juggling");
  });
});

describe("Codex monitor delegated lifecycle", () => {
  let dir, monitor, events, tracked, nowMs;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-child-"));
    events = [];
    nowMs = null;
    monitor = new CodexLogMonitor({ ...codex, logConfig: { ...codex.logConfig, sessionDir: dir } }, () => {}, {
      onSubagentActivity: (parentId, event) => events.push({ parentId, ...event }),
      now: () => nowMs ?? Date.now(),
    });
    monitor._findCodexWriterPid = () => null;
    tracked = { sessionId: raw("child"), filePath: path.join(dir, "child.jsonl"), lastState: "idle",
      pendingUserInputs: new Map(), turnBoundaryOpen: false, backfilling: false };
  });
  afterEach(() => { monitor.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  function feed(type, payload, at = Date.now()) {
    monitor._processLine(JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }), tracked);
  }
  function header(source = { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } }) {
    source = structuredClone(source);
    const spawn = source.subagent?.thread_spawn;
    if (spawn && ["parent", "child"].includes(spawn.parent_thread_id)) spawn.parent_thread_id = native(spawn.parent_thread_id);
    feed("session_meta", { source });
  }
  function start(turn = "turn-a") { feed("event_msg", { type: "task_started", turn_id: turn }); }
  function stop(turn = "turn-a", type = "task_complete") { feed("event_msg", { type, turn_id: turn }); }

  it("counts only explicit thread_spawn children, independent of tool namespaces", () => {
    header(); start();
    assert.equal(events.length, 1);
    assert.equal(events[0].parentId, raw("parent"));
    assert.equal(events[0].phase, "start");
    assert.equal(events[0].childId, raw("child"));
    assert.equal(events[0].turnId, "turn-a");
    stop(); assert.equal(events.at(-1).phase, "stop");
  });

  it("ignores guardian, metadata-only, orphan tools and failed launches", () => {
    header({ subagent: { other: "guardian" } }); start(); stop();
    assert.deepEqual(events, []);
    header(); feed("response_item", { type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: "{}" });
    feed("event_msg", { type: "token_count" });
    assert.deepEqual(events, []);
  });

  it("fences duplicate and old-terminal delivery across child turns and cancellation", () => {
    header(); start(); start(); stop(); stop();
    start("turn-b"); stop("turn-a");
    feed("response_item", { type: "function_call", turn_id: "turn-a", name: "ignored" });
    assert.deepEqual(events.map(e => [e.phase, e.turnId]), [
      ["start", "turn-a"], ["stop", "turn-a"], ["start", "turn-b"],
    ]);
    stop("turn-b", "turn_aborted");
    assert.equal(events.at(-1).phase, "stop");
    start("turn-a"); assert.equal(events.at(-1).phase, "stop");
  });

  it("rejects future records before they alter child turns or block later valid work", () => {
    nowMs = Date.now();
    header();
    feed("event_msg", { type: "task_started", turn_id: "accepted" }, nowMs);
    const child = tracked.delegatedChild;
    for (const [type, turn] of [["task_started", "future"], ["task_complete", "accepted"], ["turn_aborted", "accepted"]]) {
      feed("event_msg", { type, turn_id: turn }, nowMs + 1501);
    }
    feed("response_item", { type: "function_call", turn_id: "accepted", name: "exec_command" }, nowMs + 60000);
    assert.equal(child.turnId, "accepted");
    assert.equal(child.latestStartAt, nowMs);
    assert.equal(child.lastActivityAt, nowMs);
    assert.deepEqual([...child.closed], []);
    assert.deepEqual(events.map(e => [e.phase, e.turnId]), [["start", "accepted"]]);
    feed("event_msg", { type: "task_complete", turn_id: "accepted" }, nowMs + 1);
    feed("event_msg", { type: "task_started", turn_id: "next-valid" }, nowMs + 2);
    assert.deepEqual(events.map(e => [e.phase, e.turnId]), [
      ["start", "accepted"], ["stop", "accepted"], ["start", "next-valid"],
    ]);
    feed("event_msg", { type: "task_complete", turn_id: "next-valid" }, nowMs + 1500);
    assert.equal(events.at(-1).phase, "stop", "the allowed skew boundary remains accepted");
  });

  it("replays a fork without inheriting its parent's header, open turn, question, plan or title", () => {
    nowMs = Date.now();
    const source = { subagent: { thread_spawn: { parent_thread_id: native("parent") } } };
    tracked.backfilling = true;
    feed("session_meta", { id: native("child"), cwd: "/fixture/child", originator: "Codex Desktop", source }, nowMs);
    const child = tracked.delegatedChild;
    feed("session_meta", { id: native("parent"), cwd: "/fixture/parent", originator: "codex-cli", source: "cli" }, nowMs - 10000);
    feed("event_msg", { type: "task_started", turn_id: "inherited-open" }, nowMs - 9000);
    feed("response_item", { type: "function_call", name: "request_user_input", call_id: "parent-question",
      arguments: JSON.stringify({ questions: [{ id: "choice", question: "Fixture?", options: [] }] }) }, nowMs - 8000);
    feed("response_item", { type: "function_call", name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "Fixture", status: "in_progress" }] }) }, nowMs - 7000);
    feed("turn_context", { summary: "Inherited title" }, nowMs - 6000);
    feed("event_msg", { type: "agent_message", message: "Inherited output" }, nowMs - 5000);
    feed("event_msg", { type: "task_complete", turn_id: "inherited-closed" }, nowMs - 4000);
    assert.equal(tracked.delegatedChild, child);
    assert.equal(monitor._isTrackedSubagent(tracked), true);
    assert.equal(tracked.cwd, "/fixture/child");
    assert.equal(tracked.codexOriginator, "Codex Desktop");
    assert.equal(tracked.activeTurnId ?? null, null);
    assert.equal(tracked.turnBoundaryOpen, false);
    assert.equal(tracked.pendingUserInputs.size, 0);
    assert.equal(tracked.planProgress ?? null, null);
    assert.equal(tracked.sessionTitle ?? null, null);
    assert.equal(tracked.assistantLastOutput ?? null, null);
    assert.equal(child.turnId, null);
    assert.deepEqual([...child.closed], []);
    assert.deepEqual(events, []);
    // A genuine same-thread metadata update remains supported, but cannot
    // advance birth past the real start that follows in the file.
    feed("session_meta", { id: native("child"), cwd: "/fixture/updated-child", source }, nowMs + 100);
    assert.equal(child.bornAt, nowMs);
    assert.equal(tracked.cwd, "/fixture/updated-child");
    feed("event_msg", { type: "task_started", turn_id: "child-own" }, nowMs);
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.deepEqual(events.map(e => [e.phase, e.turnId]), [["start", "child-own"]]);
    feed("event_msg", { type: "task_complete", turn_id: "child-own" }, nowMs + 101);
    assert.equal(events.at(-1).phase, "stop");
    assert.equal(tracked.turnBoundaryOpen, false);
  });

  it("isolates malformed and foreign metadata while retaining root updates and missing-id legacy records", () => {
    nowMs = Date.now();
    const source = { subagent: { thread_spawn: { parent_thread_id: native("parent") } } };
    feed("session_meta", { id: native("child"), source, cwd: "/fixture/child" }, nowMs);
    const child = tracked.delegatedChild;
    for (const id of [null, "", 12, {}, "malformed", native("parent")]) {
      feed("session_meta", { id, source: "cli", cwd: "/fixture/wrong" }, nowMs);
    }
    assert.equal(tracked.delegatedChild, child);
    assert.equal(tracked.cwd, "/fixture/child");
    assert.equal(monitor._isTrackedSubagent(tracked), true);
    // A known guardian must not become delegated through an inherited child header.
    tracked = { sessionId: raw("guardian"), filePath: path.join(dir, "guardian.jsonl"), lastState: "idle",
      pendingUserInputs: new Map(), turnBoundaryOpen: false, backfilling: true };
    feed("session_meta", { id: native("guardian"), source: { subagent: { other: "guardian" } } }, nowMs);
    feed("session_meta", { id: native("child"), source }, nowMs);
    feed("event_msg", { type: "task_started", turn_id: "guardian-turn" }, nowMs);
    monitor._emitBackfillSnapshot(tracked);
    assert.equal(tracked.delegatedChild, undefined);
    assert.equal(monitor._isTrackedSubagent(tracked), true);
    assert.deepEqual(events, []);
    // Root metadata with its own ID and legacy headers with no ID still update.
    tracked = { sessionId: raw("parent"), filePath: path.join(dir, "root.jsonl"), lastState: "idle",
      pendingUserInputs: new Map(), turnBoundaryOpen: false, backfilling: true };
    feed("session_meta", { id: native("parent"), source: "cli", cwd: "/fixture/root" }, nowMs);
    feed("session_meta", { id: native("parent"), source: "cli", cwd: "/fixture/root-updated" }, nowMs + 1);
    feed("session_meta", { source: "cli", cwd: "/fixture/legacy-updated" }, nowMs + 2);
    feed("event_msg", { type: "task_started", turn_id: "root-old" }, nowMs - 1000);
    assert.equal(tracked.cwd, "/fixture/legacy-updated");
    assert.equal(tracked.activeTurnId, "root-old", "root replay does not acquire a child birth cutoff");
    assert.equal(monitor._isTrackedSubagent(tracked), false);
    assert.equal(tracked.delegatedChild, undefined);
  });

  it("does not invent a child birth when an own header omits its timestamp", () => {
    nowMs = Date.now();
    tracked.backfilling = true;
    monitor._processLine(JSON.stringify({ type: "session_meta", payload: { id: native("child"), source: {
      subagent: { thread_spawn: { parent_thread_id: native("parent") } },
    } } }), tracked);
    assert.equal(tracked.delegatedChild.bornAt, undefined);
    feed("event_msg", { type: "task_started", turn_id: "legacy" }, nowMs - 1000);
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.equal(events.at(-1).phase, "start");
  });

  it("preserves the identified child birth across cold head/tail recovery and deferred finalization", () => {
    nowMs = Date.now();
    const filename = `rollout-2026-10-26T00-00-00-${native("child")}.jsonl`;
    const file = path.join(dir, filename);
    const line = (type, payload, at) => JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() });
    fs.writeFileSync(file, [
      line("session_meta", { id: native("child"), source: {
        subagent: { thread_spawn: { parent_thread_id: native("parent") } },
      } }, nowMs - 1000),
      JSON.stringify({ type: "fixture-padding", padding: "x".repeat(1100000) }),
      line("session_meta", { id: native("parent"), source: "cli" }, nowMs - 5000),
      line("event_msg", { type: "task_started", turn_id: "inherited" }, nowMs - 4000),
      line("event_msg", { type: "task_started", turn_id: "own" }, nowMs - 500),
    ].join("\n") + "\n");
    const recovered = monitor._recoverStalePendingUserInput(file, filename, null, { deferSideEffects: true });
    assert.ok(recovered);
    assert.deepEqual(events, []);
    monitor._finalizeRecoveredTracker(recovered);
    assert.equal(recovered.delegatedChild.bornAt, nowMs - 1000);
    assert.equal(recovered.delegatedChild.turnId, "own");
    assert.deepEqual([...recovered.delegatedChild.closed], []);
    assert.deepEqual(events.map(e => [e.phase, e.turnId]), [["start", "own"]]);
  });

  it("backfill emits only a fresh active final snapshot, never finished or ancient turns", () => {
    tracked.backfilling = true; header(); start(); stop();
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.deepEqual(events, []);
    tracked.backfilling = true; start("turn-b");
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.equal(events.length, 1); assert.equal(events[0].phase, "start");
    monitor._emitBackfillSnapshot(tracked); assert.equal(events.length, 1);
  });

  it("monitor stop and tracker retirement release previously projected children", () => {
    header(); start(); monitor._tracked.set(tracked.filePath, tracked);
    monitor._retireTrackedFile(tracked.filePath, tracked);
    assert.equal(events.at(-1).phase, "stop");
  });

  it("rejects self-reference, oversized/unknown metadata shapes and cyclic parent relations", () => {
    for (const parent of ["child", "", "project-name", "x".repeat(257), "bad\nparent", null, 12]) {
      header({ subagent: { thread_spawn: { parent_thread_id: parent } } }); start();
    }
    assert.deepEqual(events, []);
    header({ subagent: { other: "guardian", thread_spawn: { parent_thread_id: "parent" } } }); start();
    assert.deepEqual(events, []);
    header({ subagent: { thread_spawn: { parent_thread_id: "parent", agent_role: "guardian", agent_nickname: "guardian" } } });
    start(); assert.equal(events.at(-1).phase, "start", "role/name text never replaces explicit thread ownership");
    const other = { ...tracked, sessionId: raw("parent"), delegatedChild: null, pendingUserInputs: new Map() };
    monitor._processLine(JSON.stringify({ type: "session_meta", payload: { source: {
      subagent: { thread_spawn: { parent_thread_id: native("child") } },
    } } }), other);
    assert.equal(events.at(-1).phase, "stop", "cycle invalidates already-published ownership");
  });

  it("deduplicates the same child across multiple rollout files and ignores late starts after terminal", () => {
    header(); start();
    const other = { ...tracked, delegatedChild: null, filePath: path.join(dir, "other.jsonl"), pendingUserInputs: new Map() };
    const line = (type, payload) => monitor._processLine(JSON.stringify({ timestamp: new Date().toISOString(), type, payload }), other);
    line("session_meta", { source: { subagent: { thread_spawn: { parent_thread_id: native("parent") } } } });
    line("event_msg", { type: "task_started", turn_id: "turn-a" });
    assert.equal(events.length, 1);
    stop(); line("event_msg", { type: "task_started", turn_id: "turn-a" });
    assert.deepEqual(events.map(e => e.phase), ["start", "stop"]);
  });

  it("retiring one duplicate tracker preserves another live owner, while SessionEnd closes every owner", () => {
    header(); start();
    const other = { ...tracked, delegatedChild: null, filePath: path.join(dir, "duplicate.jsonl"), pendingUserInputs: new Map() };
    const line = (type, payload) => monitor._processLine(JSON.stringify({ timestamp: new Date().toISOString(), type, payload }), other);
    line("session_meta", { source: { subagent: { thread_spawn: { parent_thread_id: native("parent") } } } });
    line("event_msg", { type: "task_started", turn_id: "turn-a" });
    monitor._tracked.set(tracked.filePath, tracked); monitor._tracked.set(other.filePath, other);
    monitor._retireTrackedFile(tracked.filePath, tracked);
    assert.deepEqual(events.map(e => e.phase), ["start"]);
    line("response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    assert.equal(events.at(-1).phase, "activity");
    monitor.endSubagent(native("child"));
    assert.equal(events.at(-1).phase, "stop");
    const count = events.length;
    line("response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    line("event_msg", { type: "task_started", turn_id: "turn-a" });
    assert.equal(events.length, count);
  });

  it("recovers a last-owner capacity retirement only on fresh real activity, never after authoritative child or parent end", () => {
    header(); start(); monitor._tracked.set(tracked.filePath, tracked);
    monitor._pruneTrackedFilesIfNeeded(0);
    assert.equal(events.at(-1).phase, "stop");
    feed("event_msg", { type: "token_count" });
    assert.equal(events.at(-1).phase, "stop");
    feed("response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    assert.equal(events.at(-1).phase, "start");
    assert.equal(events.at(-1).turnId, "turn-a");
    monitor.endSubagentsOfParent(native("parent"));
    const count = events.length;
    feed("response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    start(); assert.equal(events.length, count);
    const future = Date.now() + 1;
    feed("event_msg", { type: "task_started", turn_id: "new-child-turn" }, future);
    assert.equal(events.at(-1).turnId, "new-child-turn");
    monitor.endSubagent(native("child"));
    const ended = events.length;
    feed("response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    assert.equal(events.length, ended);
  });

  it("does not recover an ancient active turn when metadata changes the file modification time", () => {
    tracked.backfilling = true; header();
    feed("event_msg", { type: "task_started", turn_id: "old" }, Date.now() - TTL - 100);
    feed("event_msg", { type: "token_count" });
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.deepEqual(events, []);
  });

  it("uses its child-own open turn after an old terminal corrupted ordinary monitor bookkeeping", () => {
    header(); start(); start("turn-b"); stop("turn-a");
    feed("response_item", { type: "function_call", namespace: "functions", name: "exec", arguments: "{}" });
    assert.equal(events.at(-1).phase, "activity");
    assert.equal(events.at(-1).turnId, "turn-b");
    monitor.stop(); assert.equal(events.at(-1).phase, "stop");
  });

  it("cannot replace a newer turn by replaying an older file for the same child", () => {
    tracked.backfilling = true; header();
    const at = Date.now();
    feed("event_msg", { type: "task_started", turn_id: "new-turn" }, at);
    const other = { ...tracked, delegatedChild: null, filePath: path.join(dir, "old.jsonl"), pendingUserInputs: new Map() };
    monitor._processLine(JSON.stringify({ type: "session_meta", payload: {
      source: { subagent: { thread_spawn: { parent_thread_id: native("parent") } } },
    } }), other);
    monitor._processLine(JSON.stringify({ timestamp: new Date(at - 1000).toISOString(), type: "event_msg",
      payload: { type: "task_started", turn_id: "old-turn" } }), other);
    monitor._processLine(JSON.stringify({ timestamp: new Date(at - 500).toISOString(), type: "event_msg",
      payload: { type: "task_complete", turn_id: "old-turn" } }), other);
    tracked.backfilling = false; monitor._emitBackfillSnapshot(tracked);
    assert.equal(events.length, 1); assert.equal(events[0].turnId, "new-turn");
  });
});

it("runtime routes child presentation around the parent turn fence and ordinary state callback", () => {
  const state = makeState(); let callback; let clears = 0;
  class FakeMonitor { constructor(_config, _callback, options) { callback = options.onSubagentActivity; } start() {} stop() {} }
  const runtime = createRuntime({ loadCodexLogMonitor: () => FakeMonitor, loadCodexAgent: () => codex,
    getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
    clearCodexNotifyBubbles() { clears++; },
  });
  try {
    runtime.startCodexLogMonitor();
    runtime.updateSessionFromServer(key("parent"), "working", "UserPromptSubmit", {
      agentId: "codex", profileId: "local", hookSource: "codex-official", turnId: "parent-turn",
    });
    const before = runtime.getCodexTurnFenceSnapshot(key("parent"));
    const cleared = clears;
    callback(raw("parent"), { childId: raw("child"), turnId: "child-turn", phase: "start", occurredAt: Date.now() });
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.deepEqual(runtime.getCodexTurnFenceSnapshot(key("parent")), before);
    assert.equal(clears, cleared);
  } finally { runtime.cleanup(); state.cleanup(); }
});

describe("Codex delegated runtime admission", () => {
  let state, runtime, activity, emit, enabled, supported, archived;
  const parent = native("parent");
  const event = (phase = "start", id = "child", turn = "child-turn") => ({
    childId: raw(id), turnId: turn, phase, occurredAt: Date.now(),
  });
  beforeEach(() => {
    state = makeState(); enabled = true; supported = true; archived = false;
    class FakeMonitor {
      constructor(_config, callback, options) {
        emit = (parentId, ...args) => callback(raw(parentId), ...args);
        activity = (parentId, event) => options.onSubagentActivity(raw(parentId), event);
      }
      start() {} stop() {}
    }
    runtime = createRuntime({ loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ ...codex, capabilities: { get subagent() { return supported; } } }),
      getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
      isAgentEnabled: () => enabled,
      codexArchiveTracker: { isArchived: () => archived, start() {}, stop() {} },
    });
    runtime.startCodexLogMonitor();
  });
  afterEach(() => { runtime.cleanup(); state.cleanup(); });
  function prompt(turn = "parent-turn") {
    runtime.updateSessionFromServer(key(parent), "thinking", "UserPromptSubmit", {
      agentId: "codex", profileId: "local", hookSource: "codex-official", turnId: turn,
    });
  }

  it("holds active startup evidence without creating a missing parent, then reconciles after actual parent acceptance", () => {
    activity(parent, event()); assert.equal(state.sessions.size, 0);
    prompt(); assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(state.sessions.size, 1);
    assert.equal(state.sessions.get(key(parent)).state, "thinking");
  });

  it("never replays already-completed startup evidence when the parent appears later", () => {
    activity(parent, event()); activity(parent, event("stop")); prompt();
    assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("retires pending startup evidence when an official child SessionEnd precedes its parent", () => {
    activity(parent, event());
    runtime.updateSessionFromServer(key("child"), "sleeping", "SessionEnd", {
      agentId: "codex", profileId: "local", hookSource: "codex-official", headless: true, rawSessionId: raw("child"),
    });
    prompt(); assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("rejects disabled/capability-off/archived owners and SessionEnd tombstones", () => {
    prompt(); enabled = false; activity(parent, event()); enabled = true;
    assert.equal(state.resolveDisplayState(), "thinking");
    supported = false; activity(parent, event()); supported = true;
    assert.equal(state.resolveDisplayState(), "thinking");
    archived = true; activity(parent, event()); archived = false;
    assert.equal(state.resolveDisplayState(), "thinking");
    runtime.updateSessionFromServer(key(parent), "sleeping", "SessionEnd", {
      agentId: "codex", profileId: "local", hookSource: "codex-official",
    });
    activity(parent, event());
    assert.equal(state.sessions.has(key(parent)), false);
    prompt("parent-next"); assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("continues observing children when ordinary JSONL working events are covered by official hooks", () => {
    prompt();
    emit(parent, "working", "response_item:function_call", { turnId: "parent-turn" });
    activity(parent, event());
    assert.equal(state.resolveDisplayState(), "juggling");
    prompt("parent-new");
    emit(parent, "attention", "event_msg:task_complete", { turnId: "parent-turn" });
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(state.sessions.get(key(parent)).state, "thinking");
    activity(parent, event("stop"));
    assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("rejects platform-only WSL parents in the runtime callback without changing other local gates", () => {
    prompt(); state.sessions.get(key(parent)).platform = "wsl";
    activity(parent, event());
    assert.equal(state.resolveDisplayState(), "thinking");
    assert.equal(state.hasActiveCodexSubagents(), false);
  });
});

it("real rollout polling joins bare UUID thread_spawn metadata to a hook→route→runtime parent", async () => {
  const { EventEmitter } = require("node:events");
  const { buildStateBody } = require("../hooks/codex-hook");
  const { handleStatePost } = require("../src/server-route-state");
  const state = makeState({ hasReplyableCompletionMapping: () => true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-child-e2e-"));
  const date = new Date();
  const day = path.join(dir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  let monitor;
  class RealMonitor extends CodexLogMonitor {
    constructor(config, callback, options) {
      super({ ...config, logConfig: { ...config.logConfig, sessionDir: dir } }, callback, options);
      monitor = this; this._findCodexWriterPid = () => null;
    }
    start() { this._poll(); }
  }
  let enabled = true;
  const runtime = createRuntime({ loadCodexLogMonitor: () => RealMonitor, isAgentEnabled: () => enabled,
    getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
  });
  const parent = native("e2e-parent");
  const childA = native("e2e-a"), childB = native("e2e-b");
  const rollout = id => path.join(day, `rollout-2026-10-26T12-00-00-${id}.jsonl`);
  const record = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  const write = (id, source) => fs.writeFileSync(rollout(id), record("session_meta", { id, source, originator: "codex-cli" }));
  const append = (id, type, payload) => fs.appendFileSync(rollout(id), record(type, payload));
  const officialTurns = new Map();
  async function hook(event, turnId, target = parent) {
    const wire = buildStateBody({ hook_event_name: event, session_id: target, turn_id: turnId,
      transcript_path: rollout(target), ...(target === parent ? { source: "cli" } : {}), originator: "codex-cli",
    }, () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] }));
    assert.equal(wire.session_id, `codex:${target}`);
    const req = new EventEmitter(); req.headers = {};
    await new Promise(resolve => {
      const res = { statusCode: 0, writeHead(status) { this.statusCode = status; },
        end() { assert.equal(this.statusCode, 200); resolve(); } };
      const no = () => {};
      handleStatePost(req, res, {
        ctx: { STATE_SVGS: { idle: "x.svg", thinking: "x.svg", working: "x.svg", sleeping: "x.svg", attention: "x.svg", "codex-turn-end": "x.svg" },
          sessions: state.sessions, pendingPermissions: [], isAgentEnabled: () => true,
          updateSession: (...args) => runtime.updateSessionFromServer(...args), setState: no,
          resolvePermissionEntry: no, permLog: no,
        },
        shouldDropForDnd: () => false, codexOfficialTurns: officialTurns,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: no, droppedByDisabled: no, droppedByDnd: no,
          droppedInvalidAgent: no, droppedUnsupported: no }),
      });
      req.emit("data", Buffer.from(JSON.stringify(wire))); req.emit("end");
    });
  }
  try {
    write(parent, "cli");
    await hook("UserPromptSubmit", "parent-turn");
    const parentKey = resolveSessionIdentity(`codex:${parent}`, "local").sessionId;
    assert.equal(state.sessions.get(parentKey).state, "thinking");
    runtime.startCodexLogMonitor();
    for (const id of [childA, childB]) {
      write(id, { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_role: "worker" } } });
      append(id, "event_msg", { type: "task_started", turn_id: `turn-${id}` });
    }
    monitor._poll();
    const count = () => state.buildSessionSnapshot().sessions.find(e => e.id === parentKey).activeSubagentCount;
    assert.equal(count(), 2);
    assert.equal(state.getSvgOverride(state.resolveDisplayState()), "clawd-working-juggling.svg");
    assert.equal(state.buildSessionSnapshot().sessions.filter(e => !e.headless).length, 1);
    monitor._retireTrackedFile(rollout(childA), monitor._tracked.get(rollout(childA)));
    assert.equal(count(), 1);
    append(childA, "response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    monitor._poll(); assert.equal(count(), 2, "real new file bytes recover the last retired owner in the same child turn");
    append(childA, "event_msg", { type: "task_complete", turn_id: `turn-${childA}` });
    monitor._poll(); assert.equal(count(), 1);
    await hook("Stop", "parent-turn");
    assert.equal(state.sessions.get(parentKey).state, "idle");
    assert.equal(state.resolveDisplayState(), "juggling");
    append(childB, "event_msg", { type: "task_complete", turn_id: `turn-${childB}` });
    monitor._poll(); assert.equal(count(), 0);
    assert.equal(state.resolveDisplayState(), "idle");
    // Real runtime disable/monitor teardown must release after the gate closes,
    // even though no UI operation deletes the still-replyable parent row.
    append(childA, "event_msg", { type: "task_started", turn_id: "child-followup" });
    monitor._poll(); assert.equal(count(), 1);
    enabled = false; runtime.stopMonitorForAgent("codex");
    assert.equal(count(), 0); assert.equal(state.hasActiveCodexSubagents(), false);
    assert.equal(state.sessions.has(parentKey), true);
    enabled = true; runtime.startMonitorForAgent("codex");
    assert.equal(count(), 1);
    await hook("SessionEnd", "child-followup", childA);
    assert.equal(count(), 0, "official child SessionEnd releases only its parent projection");
    append(childB, "event_msg", { type: "task_started", turn_id: "before-parent-end" });
    monitor._poll(); assert.equal(count(), 1);
    await hook("SessionEnd", "parent-turn");
    assert.equal(state.sessions.has(parentKey), true, "replyable mapping retains the real parent row");
    assert.equal(count(), 0); assert.equal(state.hasActiveCodexSubagents(), false);
    append(childA, "response_item", { type: "function_call", name: "exec_command", arguments: "{}" });
    append(childB, "event_msg", { type: "task_started", turn_id: "post-parent-end" });
    monitor._poll();
    assert.equal(count(), 0, "late child activity cannot reopen an ended but replyable parent");
    assert.equal(state.hasActiveCodexSubagents(), false);
  } finally { runtime.cleanup(); state.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("pure snapshot presentation keeps an active child's completed parent visible without changing completion semantics", () => {
  const { buildSessionSnapshot, sessionSnapshotSignature } = require("../src/state-session-snapshot");
  const parent = { agentId: "codex", state: "idle", profileId: "local", updatedAt: Date.now(),
    sourcePid: 123, pidReachable: true, requiresCompletionAck: true,
    planProgress: { completed: 1, total: 3 }, recentEvents: [{ event: "Stop", at: Date.now() }] };
  const sessions = new Map([[key("parent"), parent]]);
  const options = { sessionHudCleanupDetached: true, isProcessAlive: () => false,
    getSessionPresentation: () => ({ effectiveState: "juggling", activeSubagentCount: 2 }) };
  const before = structuredClone(parent);
  const active = buildSessionSnapshot(sessions, options);
  assert.equal(active.hudTotalNonIdle, 1);
  assert.equal(active.sessions[0].state, "idle"); assert.equal(active.sessions[0].badge, "done");
  assert.equal(active.sessions[0].effectiveState, "juggling");
  assert.equal(active.sessions[0].hudHiddenByPreference, false);
  assert.equal(active.sessions[0].requiresCompletionAck, true);
  assert.equal(active.sessions[0].planProgress.completed, 1);
  assert.deepEqual(parent, before);
  const done = buildSessionSnapshot(sessions, { ...options,
    getSessionPresentation: () => ({ effectiveState: "idle", activeSubagentCount: 0 }) });
  assert.equal(done.hudTotalNonIdle, 0);
  assert.notEqual(sessionSnapshotSignature(active), sessionSnapshotSignature(done));
});

it("verified child or native pending keeps a superseded HUD parent visible without expanding focus or changing plain PID dedupe", ({ mock }) => {
  mock.timers.enable({ apis: ["Date"] });
  const pending = [];
  const state = makeState({ pendingPermissions: pending });
  const olderId = key("older-shared-process"), newerId = key("newer-shared-process");
  const entry = () => state.buildSessionSnapshot().sessions.find(e => e.id === olderId);
  try {
    state.updateSession(olderId, "working", "PreToolUse", { agentId: "codex", agentPid: 2001 });
    mock.timers.tick(10);
    state.updateSession(newerId, "working", "PreToolUse", { agentId: "codex", agentPid: 2001 });
    assert.equal(entry().hiddenFromHud, true, "plain sessions retain the existing same-PID dedupe");
    assert.equal(entry().canFocus, false);
    state.updateCodexSubagentActivity(olderId, {
      childId: raw("verified-shared-process-child"), turnId: "verified-turn", phase: "start", occurredAt: Date.now(),
    });
    assert.equal(entry().activeSubagentCount, 1);
    assert.equal(entry().hiddenFromHud, false, "a verified child relationship keeps the actual older parent visible");
    assert.equal(entry().canFocus, false, "visibility evidence does not establish focus identity");
    assert.equal(entry().focusTarget, null);
    state.updateCodexSubagentActivity(olderId, {
      childId: raw("verified-shared-process-child"), turnId: "verified-turn", phase: "stop", occurredAt: Date.now(),
    });
    assert.equal(entry().hiddenFromHud, true, "the old dedupe resumes when verified work ends");
    pending.push({ sessionId: olderId, agentId: "codex", res: null, isCodexUserInputNotify: true });
    assert.equal(entry().activeSubagentCount, 0);
    assert.equal(entry().pendingAttention, true);
    assert.equal(entry().hiddenFromHud, false);
    assert.equal(entry().canFocus, false);
    pending.length = 0;
    assert.equal(entry().hiddenFromHud, true);
  } finally { state.cleanup(); }
});

it("HUD shows effective busy state and postpones its unread bell while preserving foreground cues", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");
  const context = vm.createContext({ document: { getElementById: () => ({}) },
    ClawdSessionFocusUnavailable: { canOfferLocalFolder() {}, focusUnavailableReasonKey() {} },
    ClawdSessionHudTaggedFallback: { taggedFallbackTag() {} },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("init().catch")), context);
  const session = { id: key("parent"), state: "idle", badge: "done", effectiveState: "juggling",
    activeSubagentCount: 1, updatedAt: Date.now(), requiresCompletionAck: true, lastEvent: { rawEvent: "Stop" } };
  context.session = session;
  vm.runInContext("updateUnread([session])", context);
  assert.equal(vm.runInContext("stateChipInfo(session).cls", context), "chip-juggling");
  assert.equal(vm.runInContext("showUnreadCompletion(session)", context), false);
  session.lastEvent.rawEvent = "PermissionRequest";
  assert.equal(vm.runInContext("stateChipInfo(session).cls", context), "chip-notification");
  session.lastEvent.rawEvent = "Stop"; session.activeSubagentCount = 0;
  assert.equal(vm.runInContext("showUnreadCompletion(session)", context), true);
  assert.equal(session.requiresCompletionAck, true); assert.equal(session.badge, "done");
  const state = makeState();
  try {
    state.updateSession(key("parent"), "working", "PreToolUse", { agentId: "codex" });
    state.updateCodexSubagentActivity(key("parent"), {
      childId: raw("child"), turnId: "child-turn", phase: "start", occurredAt: Date.now(),
    });
    state.updateSession(key("parent"), "error", "StopFailure", { agentId: "codex" });
    context.session = state.buildSessionSnapshot().sessions.find(e => e.id === key("parent"));
    assert.equal(context.session.state, "idle"); assert.equal(context.session.badge, "interrupted");
    assert.equal(context.session.activeSubagentCount, 1);
    assert.equal(vm.runInContext("stateChipInfo(session).cls", context), "chip-interrupted");
  } finally { state.cleanup(); }
});

it("real runtime native question pins attention beyond notification return and final child stop without rewriting the parent", ({ mock }) => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pending = [];
  const state = makeState({ pendingPermissions: pending }, 5);
  let callbacks;
  class FakeMonitor { constructor(_config, _cb, options) { callbacks = options; } start() {} stop() {} }
  const runtime = createRuntime({ loadCodexLogMonitor: () => FakeMonitor,
    getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
    showCodexUserInputBubble(input) {
      pending.push({ sessionId: input.sessionId, agentId: "codex", res: null,
        isCodexUserInputNotify: true, codexUserInputCallId: input.callId,
        toolName: "CodexUserInput", toolInput: { questions: input.questions } });
      return true;
    },
  });
  try {
    runtime.startCodexLogMonitor();
    runtime.updateSessionFromServer(key("parent"), "working", "UserPromptSubmit", {
      agentId: "codex", profileId: "local", hookSource: "codex-official", turnId: "parent-turn",
    });
    runtime.updateSessionFromServer(key("parent"), "working", "PreToolUse", {
      agentId: "codex", profileId: "local", hookSource: "codex-official", turnId: "parent-turn",
    });
    callbacks.onSubagentActivity(raw("parent"), { childId: raw("child"), turnId: "child-turn", phase: "start", occurredAt: Date.now() });
    callbacks.onUserInputRequest(raw("parent"), { callId: "fixture", questions: [] }, { turnId: "parent-turn" });
    const parent = state.sessions.get(key("parent"));
    assert.equal(parent.state, "working"); assert.equal(parent.recentEvents.at(-1).event, "PreToolUse");
    const entry = () => state.buildSessionSnapshot().sessions.find(e => e.id === key("parent"));
    assert.equal(entry().pendingAttention, true); assert.equal(entry().effectiveState, "notification");
    mock.timers.tick(6); assert.equal(state.getCurrentState(), "notification");
    callbacks.onSubagentActivity(raw("parent"), { childId: raw("child"), turnId: "child-turn", phase: "activity", occurredAt: Date.now() });
    assert.equal(state.resolveDisplayState(), "notification");
    callbacks.onSubagentActivity(raw("parent"), { childId: raw("child"), turnId: "child-turn", phase: "stop", occurredAt: Date.now() });
    mock.timers.tick(6);
    assert.equal(state.hasActiveCodexSubagents(), false);
    assert.equal(state.getCurrentState(), "notification");
    assert.equal(entry().activeSubagentCount, 0); assert.equal(entry().pendingAttention, true);
    pending.length = 0;
    mock.timers.tick(6);
    assert.equal(state.resolveDisplayState(), "working"); assert.equal(state.getCurrentState(), "working");
    assert.equal(parent.state, "working"); assert.equal(parent.recentEvents.at(-1).event, "PreToolUse");
  } finally { runtime.cleanup(); state.cleanup(); }
});

it("actual permission add/remove/resolve coalesces attention snapshots without lifecycle traffic or interrupting other agents", () => {
  const Module = require("node:module");
  const modulePath = require.resolve("../src/permission");
  const oldCached = require.cache[modulePath]; delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function(request, ...args) {
    if (request === "electron") return {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: { register() { return true; }, unregister() {}, isRegistered() { return false; } },
    };
    return originalLoad.call(this, request, ...args);
  };
  let initPermission;
  try { initPermission = require("../src/permission"); } finally { Module._load = originalLoad; }
  const scheduled = [], snapshots = [];
  let state;
  const refresh = require("../src/permission-presentation-refresh")({
    schedule: fn => scheduled.push(fn), getStateRuntime: () => state,
  });
  const perm = initPermission({ sessions: new Map(), win: null, lang: "en", permDebugLog: null,
    onPermissionsChanged: refresh, getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    focusTerminalForSession() {},
  });
  state = makeState({ pendingPermissions: perm.pendingPermissions,
    broadcastSessionSnapshot: snapshot => snapshots.push(snapshot),
  });
  const flush = () => { while (scheduled.length) scheduled.shift()(); };
  const last = () => snapshots.at(-1).sessions.find(e => e.id === key("parent"));
  const question = () => ({ sessionId: key("parent"), agentId: "codex", res: null,
    isCodexUserInputNotify: true, codexUserInputCallId: "fixture", toolName: "CodexUserInput",
    toolInput: { questions: [] } });
  try {
    state.updateSession(key("parent"), "working", "PreToolUse", { agentId: "codex" });
    const native = question();
    perm.addPendingPermission(native); refresh(); refresh();
    assert.equal(scheduled.length, 1);
    flush(); assert.equal(last().pendingAttention, true);
    assert.equal(state.getCurrentState(), "notification");
    perm.removePendingPermission(native); flush();
    assert.equal(last().pendingAttention, false);
    assert.equal(state.getCurrentState(), "working");
    const second = question(); perm.addPendingPermission(second); flush();
    perm.resolvePermissionEntry(second, "no-decision"); flush();
    assert.equal(last().pendingAttention, false);
    assert.equal(state.getCurrentState(), "working");
    for (const agentId of ["claude-code", "opencode"]) {
      const other = { agentId, sessionId: key(`pending-${agentId}`), res: null };
      perm.addPendingPermission(other); state.applyState("notification"); flush();
      const waiting = question(); perm.addPendingPermission(waiting); flush();
      perm.removePendingPermission(waiting); flush();
      assert.equal(last().pendingAttention, false);
      assert.equal(state.getCurrentState(), "notification", `${agentId} waiting presentation must remain owned by its existing path`);
      perm.removePendingPermission(other); flush();
    }
    assert.equal(state.sessions.get(key("parent")).state, "working");
    assert.equal(state.sessions.get(key("parent")).recentEvents.at(-1).event, "PreToolUse");
  } finally {
    state.cleanup();
    if (oldCached) require.cache[modulePath] = oldCached; else delete require.cache[modulePath];
  }
});
