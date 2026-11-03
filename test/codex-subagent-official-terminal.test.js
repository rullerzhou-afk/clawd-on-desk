"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const createRuntime = require("../src/agent-runtime-main");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codex = require("../agents/codex");
const themeLoader = require("../src/theme-loader");
const { resolveSessionIdentity } = require("../src/session-key");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: TTL } = require("../src/state-stale-cleanup");

const parent = "00000000-0000-4000-8000-000000000001";
const childA = "00000000-0000-4000-8000-000000000002";
const childB = "00000000-0000-4000-8000-000000000003";
const unknown = "00000000-0000-4000-8000-000000000004";
const raw = id => `codex:${id}`;
const key = id => resolveSessionIdentity(raw(id), "local").sessionId;

describe("official Codex child turn completion and model progress", () => {
  let state, runtime, monitor, dir, owners, activity;
  beforeEach(() => {
    themeLoader.init(path.join(__dirname, "..", "src"));
    const theme = structuredClone(themeLoader.loadTheme("clawd"));
    theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
    state = require("../src/state")({ theme, lang: "en", doNotDisturb: false,
      miniMode: false, pendingPermissions: [], t: k => k,
      playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
      buildContextMenu() {}, buildTrayMenu() {}, processKill() { return true; },
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-child-"));
    owners = new Map();
    class Monitor extends CodexLogMonitor {
      constructor(agent, callback, options) {
        super({ ...agent, logConfig: { ...agent.logConfig, sessionDir: dir } }, callback, { ...options, now: () => Date.now() });
        monitor = this;
        activity = options.onSubagentActivity;
        this._findCodexWriterPid = () => null;
      }
      start() {}
    }
    runtime = createRuntime({ loadCodexLogMonitor: () => Monitor, loadCodexAgent: () => codex, now: () => Date.now(),
      getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
    });
    runtime.startCodexLogMonitor();
    official(parent, "UserPromptSubmit", "parent-turn");
  });
  afterEach(() => { runtime.cleanup(); state.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

  function official(id, event, turnId, extra = {}) {
    return runtime.updateSessionFromServer(key(id), event === "UserPromptSubmit" ? "thinking" : "attention", event, {
      agentId: "codex", profileId: "local", hookSource: "codex-official", rawSessionId: raw(id),
      headless: id !== parent, turnId, ...extra,
    });
  }
  function feed(id, type, payload, at = Date.now()) {
    let owner = owners.get(id);
    if (!owner) {
      owner = { sessionId: raw(id), filePath: path.join(dir, `${id}.jsonl`), lastState: "idle",
        pendingUserInputs: new Map(), turnBoundaryOpen: false, backfilling: false };
      owners.set(id, owner);
    }
    monitor._processLine(JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }), owner);
    return owner;
  }
  function start(id = childA, turnId = "child-a") {
    if (!owners.has(id)) feed(id, "session_meta", { id,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
    feed(id, "event_msg", { type: "task_started", turn_id: turnId });
  }
  const count = () => state.buildSessionSnapshot().sessions.find(s => s.id === key(parent)).activeSubagentCount;

  it("releases only the matching child on accepted official Stop/Interrupt without a JSONL terminal", () => {
    start(); start(childB, "child-b");
    assert.equal(count(), 2);
    const realParent = structuredClone(state.sessions.get(key(parent)));
    official(childA, "Stop", "child-a");
    assert.equal(count(), 1);
    assert.equal(owners.get(childA).delegatedChild.turnId, null);
    assert.equal(owners.get(childA).activeTurnId, null);
    assert.equal(owners.get(childA).turnBoundaryOpen, false);
    assert.deepEqual(state.sessions.get(key(parent)), realParent);
    official(childA, "Stop", "child-a");
    official(unknown, "Stop", "child-b");
    assert.equal(count(), 1);
    official(childB, "Interrupt", "child-b");
    assert.equal(count(), 0);
    assert.equal(state.resolveDisplayState(), "thinking");
  });

  it("keeps independently running children through their parent's ordinary Stop", () => {
    start(); start(childB, "child-b");
    official(parent, "Stop", "parent-turn");
    assert.equal(count(), 2);
    assert.equal(state.sessions.get(key(parent)).state, "idle");
    assert.equal(state.resolveDisplayState(), "juggling");
    official(childA, "Stop", "child-a"); official(childB, "Stop", "child-b");
    assert.equal(count(), 0);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  it("rejects old/unknown/id-less terminals and duplicate delivery after a newer child turn starts", () => {
    start(); official(childA, "Stop", "child-a");
    start(childA, "child-next"); official(childA, "UserPromptSubmit", "child-next");
    for (const turn of ["child-a", "unknown-turn", null]) {
      official(childA, "Stop", turn);
      assert.equal(count(), 1);
      assert.equal(owners.get(childA).delegatedChild.turnId, "child-next");
    }
    // The id-less ordinary fence is conservative; the child-own fence must
    // still permit an accurately identified terminal for this generation.
    official(childA, "Stop", "child-next");
    assert.equal(count(), 0);
    start(childA, "third"); official(childA, "UserPromptSubmit", "third");
    official(childA, "Interrupt", "child-next");
    assert.equal(count(), 1);
  });

  it("does not apply remote/WSL or mismatched raw identities to the local child projection", () => {
    start();
    for (const extra of [{ host: "remote" }, { wslDistro: "distro" }, { platform: " WSL " }, { profileId: "remote" },
      { rawSessionId: raw(childB) }]) {
      official(childA, "Stop", "child-a", extra);
      feed(childA, "response_item", { type: "reasoning", turn_id: "child-a" });
      assert.equal(count(), 1);
      assert.equal(runtime.getCodexTurnFenceSnapshot(key(childA))?.closedTurnIds.includes("child-a") || false, false);
    }
  });

  it("rejects a completed turn discovered in a later child header/backfill but permits a different new turn", () => {
    official(childA, "Stop", "late-discovery");
    const owner = feed(childA, "session_meta", { id: childA,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
    owner.backfilling = true;
    feed(childA, "event_msg", { type: "task_started", turn_id: "late-discovery" });
    owner.backfilling = false;
    monitor._emitBackfillSnapshot(owner);
    assert.equal(count(), 0);
    assert.equal(owner.delegatedChild.turnId, null);
    feed(childA, "response_item", { type: "reasoning", turn_id: "late-discovery" });
    assert.equal(count(), 0);
    start(childA, "new-discovered-turn");
    assert.equal(count(), 1);
    // A thread with no proven thread_spawn ownership remains uncounted.
    feed(unknown, "session_meta", { id: unknown, source: "cli" });
    start(unknown, "unrelated");
    assert.equal(count(), 1);
  });

  it("rechecks cached child starts when the parent appears after an official child terminal", () => {
    state.sessions.delete(key(parent));
    // Model the trusted child callback arriving while its parent is absent.
    // No currently tracked monitor owner can remove the cached entry on Stop.
    activity(raw(parent), { childId: raw(childA), turnId: "pending-turn", phase: "start", occurredAt: Date.now() });
    official(childA, "Stop", "pending-turn");
    official(parent, "UserPromptSubmit", "parent-late");
    assert.equal(count(), 0, "flush must recheck the child's closed turn, not the parent's turn");
    activity(raw(parent), { childId: raw(childA), turnId: "pending-turn", phase: "activity", occurredAt: Date.now() });
    assert.equal(count(), 0);
    activity(raw(parent), { childId: raw(childA), turnId: "new-pending-turn", phase: "start", occurredAt: Date.now() });
    assert.equal(count(), 1);
  });

  it("closes every duplicate file owner and cannot replay or progress the completed turn back into the count", () => {
    start();
    const owner = owners.get(childA);
    const duplicate = { ...owner, delegatedChild: null, filePath: path.join(dir, "duplicate.jsonl"), pendingUserInputs: new Map() };
    const duplicateFeed = (type, payload) => monitor._processLine(JSON.stringify({
      timestamp: new Date().toISOString(), type, payload,
    }), duplicate);
    duplicateFeed("session_meta", { id: childA, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
    duplicateFeed("event_msg", { type: "task_started", turn_id: "child-a" });
    assert.equal(count(), 1);
    official(childA, "Stop", "child-a");
    for (const tracked of [owner, duplicate]) {
      assert.equal(tracked.turnBoundaryOpen, false);
      assert.equal(tracked.activeTurnId, null);
    }
    duplicateFeed("event_msg", { type: "task_started", turn_id: "child-a" });
    duplicateFeed("response_item", { type: "reasoning", turn_id: "child-a" });
    monitor._emitBackfillSnapshot(duplicate);
    assert.equal(count(), 0);
    start(childA, "child-new");
    assert.equal(count(), 1);
  });

  it("recovers and renews a quiet child's count on fenced model progress but not tokens or metadata", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const modelEvents = [["event_msg", "agent_message"], ["event_msg", "agent_reasoning"],
      ["event_msg", "agent_reasoning_raw_content"], ["response_item", "reasoning"]];
    start();
    assert.equal(count(), 1);
    for (const [type, event] of modelEvents) {
      mock.timers.tick(TTL + 1);
      assert.equal(count(), 0);
      feed(childA, "event_msg", { type: "token_count" });
      feed(childA, "turn_context", { turn_id: "child-a" });
      assert.equal(count(), 0);
      feed(childA, type, { type: event, turn_id: "wrong-turn" });
      feed(childA, type, { type: event, turn_id: "child-a" }, Date.now() + 1501);
      assert.equal(count(), 0);
      feed(childA, type, { type: event, turn_id: "child-a" });
      assert.equal(count(), 1, `${type}:${event} proves progress in the open child turn`);
    }
    official(childA, "Stop", "child-a");
    for (const [type, event] of modelEvents) feed(childA, type, { type: event, turn_id: "child-a" });
    assert.equal(count(), 0);
  });

  it("reasserts current children after parent presentation loss without increasing count or changing real activity", () => {
    start(); start(childB, "child-b");
    const childAt = owners.get(childA).delegatedChild.lastActivityAt;
    state.dismissSession(key(parent));
    official(parent, "UserPromptSubmit", "parent-recovered");
    assert.equal(count(), 0);
    feed(childA, "response_item", { type: "reasoning", turn_id: "child-a" });
    assert.equal(count(), 0, "activity alone cannot readmit a lost state-side child membership");
    const parentBeforeRefresh = structuredClone(state.sessions.get(key(parent)));
    assert.equal(monitor.refreshSubagentsOfParent(parent), 2);
    assert.equal(count(), 2);
    const realChildAt = owners.get(childA).delegatedChild.lastActivityAt;
    assert.ok(realChildAt >= childAt);
    for (let i = 0; i < 3; i++) {
      assert.equal(monitor.refreshSubagentsOfParent(raw(parent)), 2);
      assert.equal(count(), 2);
      assert.equal(owners.get(childA).delegatedChild.lastActivityAt, realChildAt);
    }
    assert.deepEqual(state.sessions.get(key(parent)), parentBeforeRefresh);
    official(childA, "Stop", "child-a");
    assert.equal(monitor.refreshSubagentsOfParent(parent), 1);
    assert.equal(count(), 1);
  });

  it("never refreshes closed, stale, guardian or other-parent work", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    start(); start(childB, "child-b");
    official(childA, "Stop", "child-a");
    mock.timers.tick(TTL + 1);
    const otherChild = "00000000-0000-4000-8000-000000000005";
    feed(otherChild, "session_meta", { id: otherChild,
      source: { subagent: { thread_spawn: { parent_thread_id: unknown } } } });
    start(otherChild, "other-parent-turn");
    feed(unknown, "session_meta", { id: unknown, source: { subagent: { other: "guardian" } } });
    start(unknown, "guardian-turn");
    state.clearCodexSubagentActivities();
    assert.equal(monitor.refreshSubagentsOfParent(parent), 0);
    assert.equal(count(), 0);
    assert.equal(monitor.refreshSubagentsOfParent("invalid-id"), 0);
  });

  it("never publishes or refreshes preboot child evidence until real postboot progress", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    monitor._bootTimeMs = Date.now() + 1;
    start();
    assert.equal(count(), 0);
    assert.equal(monitor.refreshSubagentsOfParent(parent), 0);
    mock.timers.tick(2);
    feed(childA, "response_item", { type: "reasoning", turn_id: "child-a" });
    assert.equal(count(), 1);
    state.clearCodexSubagentActivities();
    assert.equal(monitor.refreshSubagentsOfParent(parent), 1);
    assert.equal(count(), 1);
  });

  it("keeps only private preboot child lifecycle ordering so real postboot reasoning revives open but never closed turns", ({ mock }) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const bornAt = Date.now();
    monitor._bootTimeMs = bornAt + 1000;
    const calls = [];
    const admit = monitor._onSubagentActivity;
    monitor._onSubagentActivity = (...args) => { calls.push(args); return admit(...args); };
    for (const id of [childA, childB]) feed(id, "session_meta", { id,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } } }, bornAt);
    const open = owners.get(childA), closed = owners.get(childB);
    assert.equal(monitor._observePreBootDelegatedTurn(open, "event_msg:task_started", "inherited-parent", bornAt - 1), null);
    assert.equal(open.delegatedChild.turnId, null, "history preceding the child's identified birth cannot seed its own turn");
    assert.equal(monitor._observePreBootDelegatedTurn(open, "event_msg:task_started", "preboot-open", bornAt), "start");
    assert.equal(monitor._observePreBootDelegatedTurn(closed, "event_msg:task_started", "preboot-closed", bornAt), "start");
    assert.equal(monitor._observePreBootDelegatedTurn(closed, "event_msg:task_complete", "preboot-closed", bornAt + 1), "stop");
    assert.deepEqual(calls, []);
    assert.equal(count(), 0);
    assert.equal(monitor.refreshSubagentsOfParent(parent), 0);
    const at = open.delegatedChild.lastActivityAt;
    assert.equal(monitor._observePreBootDelegatedTurn(open, "response_item:reasoning", "preboot-open", bornAt + 2), null);
    assert.equal(open.delegatedChild.lastActivityAt, at, "preboot model records do not grant activity freshness");
    monitor._bootTimeMs = bornAt + 5000;
    assert.equal(monitor._observePreBootDelegatedTurn(open, "event_msg:task_complete", "preboot-open", bornAt + 1501), null);
    assert.equal(open.delegatedChild.turnId, "preboot-open", "future records cannot close its accepted turn");
    monitor._bootTimeMs = bornAt + 1000;
    mock.timers.tick(1001);
    feed(childA, "response_item", { type: "reasoning", turn_id: "preboot-open" });
    feed(childB, "response_item", { type: "reasoning", turn_id: "preboot-closed" });
    assert.equal(count(), 1);
    assert.deepEqual(calls.map(([, event]) => [event.childId, event.turnId, event.phase]), [
      [raw(childA), "preboot-open", "start"],
    ]);
    assert.equal(closed.delegatedChild.turnId, null);
  });
});
