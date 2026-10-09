"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
const createRuntime = require("../src/agent-runtime-main");
const createFence = require("../src/codex-turn-fence");
const { resolveCodexOfficialHookState, getCodexOfficialTurnKey } = require("../src/server-codex-official-turns");
const { makeSessionKey } = require("../src/session-key");
loader.init(path.join(__dirname, "..", "src"));

describe("Codex compaction follow-up boundaries", () => {
  let state, runtime, theme, sounds, visuals, monitor;
  const opts = { agentId: "codex", agentPid: 42, sourcePid: 42,
    codexOriginator: "Codex Desktop", profileId: "local", headless: false, turnId: "T1" };
  const noop = () => {};
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    theme = structuredClone(loader.loadTheme("clawd"));
    sounds = []; visuals = [];
    state = require("../src/state")({ theme, doNotDisturb: false, miniMode: false,
      miniTransitioning: false, mouseOverPet: false, mouseStillSince: Date.now(), pendingPermissions: [],
      playSound: name => sounds.push(name), sendToRenderer: (channel, value) => {
        if (channel === "state-change") visuals.push(value);
      }, syncHitWin: noop, sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop,
      buildContextMenu: noop, buildTrayMenu: noop, resolvePermissionEntry: noop,
      dismissPermissionsForDnd: noop, focusTerminalWindow: noop, processKill: () => true, t: key => key });
    runtime = createRuntime({ getStateRuntime: () => state,
      updateSession: (...args) => state.updateSession(...args), codexSubagentClassifier: {},
      loadCodexAgent: () => ({ id: "codex" }), loadCodexLogMonitor: () => class {
        constructor(_agent, callback) { monitor = callback; } start() {} stop() {}
      } });
  });
  afterEach(() => { runtime.cleanup(); state.cleanup(); mock.restoreAll(); mock.timers.reset(); });
  const send = (id, value, event, extra = {}) => state.updateSession(id, value, event, { ...opts, ...extra });
  const official = (raw, value, event, extra = {}) => runtime.updateSessionFromServer(
    makeSessionKey({ profileId: "local", rawSessionId: raw }), value, event,
    { ...opts, hookSource: "codex-official", rawSessionId: raw, ...extra });

  it("lets a peer's thinking win, then returns to the still-live compaction", () => {
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(6000);
    send("peer", "thinking", "UserPromptSubmit", { agentId: "workbuddy" });
    mock.timers.tick(6000);
    assert.equal(state.getCurrentState(), "thinking");
    send("peer", "attention", "Stop", { agentId: "workbuddy" });
    mock.timers.tick(theme.timings.minDisplay.thinking + theme.timings.autoReturn.attention + 6000);
    assert.equal(state.getCurrentState(), "sweeping");
    assert.equal(sounds.filter(s => s === "complete").length, 1);
  });

  it("preserves a queued carrying cue when the compaction completion is replayed", () => {
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(1000);
    send("peer", "carrying", "TestCarry", { agentId: "claude-code" });
    mock.timers.tick(1000);
    send("owner", "sweeping", "event_msg:context_compacted");
    mock.timers.tick(theme.timings.minDisplay.sweeping - 2000);
    assert.equal(state.getCurrentState(), "carrying");
    assert.ok(visuals.includes("carrying"));
  });

  it("shows a fast compaction queued behind the previous turn's completion", () => {
    send("owner", "attention", "Stop");
    mock.timers.tick(100);
    send("owner", "thinking", "UserPromptSubmit", { turnId: "T2" });
    send("owner", "sweeping", "PreCompact", { turnId: "T2" });
    mock.timers.tick(100);
    send("owner", "sweeping", "event_msg:context_compacted", { turnId: "T2" });
    mock.timers.tick(theme.timings.minDisplay.attention);
    assert.equal(state.getCurrentState(), "sweeping");
    mock.timers.tick(theme.timings.minDisplay.sweeping + theme.timings.autoReturn.sweeping);
    assert.equal(state.resolveDisplayState(), "idle");
    assert.equal(sounds.filter(s => s === "complete").length, 1);
  });

  it("does not let the old owner's queued timeout release a recreated owner", () => {
    const callbacks = [];
    const originalSetTimeout = globalThis.setTimeout;
    mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (delay === 10 * 60 * 1000) callbacks.push(callback);
      return originalSetTimeout(callback, delay, ...args);
    });
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(1000);
    state.dismissSession("owner");
    send("owner", "sweeping", "PreCompact", { turnId: "T2" });
    assert.equal(callbacks.length, 2);
    callbacks[0]();
    assert.equal(state.resolveDisplayState(), "sweeping");
    mock.timers.tick(10 * 60 * 1000 - 1);
    assert.equal(state.resolveDisplayState(), "sweeping");
    mock.timers.tick(1);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  for (const event of ["Stop", "Interrupt", "event_msg:task_complete", "event_msg:turn_aborted"]) {
    it(`releases a post-turn compaction on ${event} without replaying completion`, () => {
      const raw = "codex:post-turn";
      official(raw, "thinking", "UserPromptSubmit");
      official(raw, "idle", "Stop");
      official(raw, "sweeping", "PreCompact");
      mock.timers.tick(6000);
      const before = sounds.length;
      const beforeSession = structuredClone(state.sessions.get(makeSessionKey({ profileId: "local", rawSessionId: raw })));
      if (event.startsWith("event_msg:")) {
        runtime.startCodexLogMonitor();
        monitor(raw, "idle", event, { turnId: "T1", sourcePid: 42, recapOccurredAt: Date.now() });
      } else official(raw, "idle", event);
      assert.equal(state.resolveDisplayState(), "idle");
      assert.equal(sounds.length, before);
      assert.equal(state.sessions.get(makeSessionKey({ profileId: "local", rawSessionId: raw })).state, "idle");
      assert.deepEqual(state.sessions.get(makeSessionKey({ profileId: "local", rawSessionId: raw })), beforeSession);
    });
  }

  it("accepts a terminal fallback during an in-turn compaction despite recent hooks", () => {
    const raw = "codex:in-turn";
    official(raw, "thinking", "UserPromptSubmit");
    official(raw, "sweeping", "PreCompact");
    mock.timers.tick(6000);
    runtime.startCodexLogMonitor();
    monitor(raw, "idle", "event_msg:task_complete", { turnId: "T1", sourcePid: 42, recapOccurredAt: Date.now() });
    assert.equal(state.resolveDisplayState(), "idle");
    assert.deepEqual(sounds, []);
  });

  it("does not release a newer hold from an old-turn or pre-compaction terminal", () => {
    const raw = "codex:stale-terminal";
    official(raw, "thinking", "UserPromptSubmit");
    official(raw, "idle", "Stop");
    const oldTime = Date.now();
    mock.timers.tick(1000);
    official(raw, "sweeping", "PreCompact");
    mock.timers.tick(6000);
    runtime.startCodexLogMonitor();
    monitor(raw, "idle", "event_msg:task_complete", { turnId: "T1", sourcePid: 42, recapOccurredAt: oldTime });
    assert.equal(state.resolveDisplayState(), "sweeping");
    official(raw, "thinking", "UserPromptSubmit", { turnId: "T2" });
    official(raw, "sweeping", "PreCompact", { turnId: "T2" });
    monitor(raw, "idle", "event_msg:turn_aborted", { turnId: "T1", sourcePid: 42, recapOccurredAt: Date.now() });
    assert.equal(state.resolveDisplayState(), "sweeping");
  });

  it("a permission notification does not establish that compaction ended", () => {
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(6000);
    send("owner", "notification", "Notification");
    mock.timers.tick(theme.timings.autoReturn.notification + 6000);
    assert.equal(state.resolveDisplayState(), "sweeping");
  });

  for (const officialFirst of [true, false]) {
    it(`replays one completion cue when ${officialFirst ? "PostCompact" : "JSONL"} arrives first`, () => {
      const raw = "codex:two-success-channels";
      official(raw, "thinking", "UserPromptSubmit");
      official(raw, "sweeping", "PreCompact");
      mock.timers.tick(6000);
      runtime.startCodexLogMonitor();
      const fromJsonl = () => monitor(raw, "sweeping", "event_msg:context_compacted", {
        turnId: "T1", sourcePid: 42, recapOccurredAt: Date.now(),
      });
      const fromOfficial = () => official(raw, "sweeping", "PostCompact");
      const before = visuals.length;
      if (officialFirst) { fromOfficial(); fromJsonl(); }
      else { fromJsonl(); fromOfficial(); }
      assert.deepEqual(visuals.slice(before), ["sweeping"]);
      mock.timers.tick(12000);
      assert.equal(state.resolveDisplayState(), "idle");
      // Another compaction in the same turn is a new phase, not a duplicate.
      official(raw, "sweeping", "PreCompact");
      mock.timers.tick(6000);
      const afterStart = visuals.length;
      fromOfficial();
      assert.deepEqual(visuals.slice(afterStart), ["sweeping"]);
    });
  }

  it("a late same-turn rollout success cannot release a subsequent compaction", () => {
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(6000);
    const completedAt = Date.now();
    send("owner", "sweeping", "PostCompact");
    mock.timers.tick(1000);
    send("owner", "sweeping", "PreCompact");
    send("owner", "sweeping", "event_msg:context_compacted", { recapOccurredAt: completedAt });
    assert.equal(state.resolveDisplayState(), "sweeping");
  });

  for (const cleanup of ["SessionEnd", "disable", "hide"]) {
    it(`disposes the private hold immediately on ${cleanup}`, () => {
      send("owner", "sweeping", "PreCompact");
      assert.equal(state.hasCodexCompactionHold("owner"), true);
      if (cleanup === "SessionEnd") send("owner", "sleeping", "SessionEnd");
      else if (cleanup === "disable") state.clearSessionsByAgent("codex");
      else state.dismissSession("owner");
      assert.equal(state.hasCodexCompactionHold("owner"), false);
      assert.equal(state.sessions.has("owner"), false);
    });
  }

  it("runtime cleanup cancels all holds and completion dedupe records", () => {
    send("completed", "sweeping", "PostCompact");
    send("owner", "sweeping", "PreCompact");
    state.cleanup();
    assert.equal(state.hasCodexCompactionHold("owner"), false);
    assert.notEqual(send("completed", "sweeping", "event_msg:context_compacted"), false);
  });

  it("duplicate starts retain the original private hold deadline", () => {
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(5 * 60 * 1000);
    send("owner", "sweeping", "PreCompact");
    mock.timers.tick(5 * 60 * 1000 - 1);
    assert.equal(state.hasCodexCompactionHold("owner"), true);
    mock.timers.tick(1);
    assert.equal(state.hasCodexCompactionHold("owner"), false);
  });

  it("capacity eviction releases the oldest private compaction hold", () => {
    for (let i = 0; i < 21; i++) {
      send(`owner-${i}`, "sweeping", "PreCompact");
      mock.timers.tick(1);
    }
    assert.equal(state.sessions.size, 20);
    assert.equal(state.hasCodexCompactionHold("owner-0"), false);
    assert.equal(state.hasCodexCompactionHold("owner-20"), true);
  });

  it("capacity eviction removes completion dedupe before the same id is reused", () => {
    for (let i = 0; i < 21; i++) {
      send(`completed-${i}`, "sweeping", "PostCompact");
      mock.timers.tick(1);
    }
    assert.equal(state.sessions.size, 20);
    assert.equal(state.sessions.has("completed-0"), false);
    assert.notEqual(send("completed-0", "sweeping", "event_msg:context_compacted"), false);
    assert.equal(state.sessions.has("completed-0"), true);
  });

  it("keeps compaction ownership and completion dedupe private to the state runtime", () => {
    send("owner", "sweeping", "PreCompact");
    send("completed", "sweeping", "PostCompact");
    const snapshot = JSON.stringify(state.buildSessionSnapshot());
    assert.doesNotMatch(snapshot, /codexCompaction|startedAt|turnId|\"T1\"/);
    assert.doesNotMatch(JSON.stringify([...state.sessions.values()]), /codexCompaction|startedAt|turnId|\"T1\"/);
  });

  it("keeps WSL marker-only compaction outside the local JSONL completion fallback", () => {
    const raw = "codex:wsl-owner", sid = makeSessionKey({ profileId: "local", rawSessionId: raw });
    official(raw, "thinking", "UserPromptSubmit", { wslDistro: "Ubuntu", sourcePid: null, agentPid: null });
    official(raw, "sweeping", "PreCompact", { wslDistro: "Ubuntu", sourcePid: null, agentPid: null });
    assert.equal(runtime.shouldSuppressCodexLogEvent(sid, "idle", "event_msg:task_complete", "T1", {
      recapOccurredAt: Date.now(),
    }), true);
    assert.equal(state.hasCodexCompactionHold(sid), true);
  });

  it("a local duplicate terminal cannot release a WSL marker-only compaction", () => {
    const raw = "codex:wsl-post-turn", sid = makeSessionKey({ profileId: "local", rawSessionId: raw });
    const wsl = { wslDistro: "Ubuntu", sourcePid: null, agentPid: null };
    official(raw, "thinking", "UserPromptSubmit", wsl);
    official(raw, "idle", "Stop", wsl);
    official(raw, "sweeping", "PreCompact", wsl);
    runtime.startCodexLogMonitor();
    monitor(raw, "idle", "event_msg:task_complete", { turnId: "T1", recapOccurredAt: Date.now() });
    assert.equal(state.hasCodexCompactionHold(sid), true);
    official(raw, "idle", "Interrupt", wsl);
    assert.equal(state.hasCodexCompactionHold(sid), false, "the owning official channel may still release it");
  });

  it("Interrupt closes a tool-using turn without completion and rejects its late tails", () => {
    const raw = "codex:interrupted-turn", sid = makeSessionKey({ profileId: "local", rawSessionId: raw });
    official(raw, "thinking", "UserPromptSubmit");
    official(raw, "working", "PreToolUse");
    official(raw, "sweeping", "PreCompact");
    official(raw, "idle", "Interrupt");
    const before = structuredClone(state.sessions.get(sid));
    assert.equal(state.hasCodexCompactionHold(sid), false);
    assert.equal(official(raw, "attention", "Stop"), false);
    assert.equal(official(raw, "working", "PostToolUse"), false);
    assert.deepEqual(state.sessions.get(sid), before);
    assert.deepEqual(sounds, []);
    official(raw, "thinking", "UserPromptSubmit", { turnId: "T2" });
    assert.equal(state.sessions.get(sid).state, "thinking");
  });

  it("Interrupt retires only its official tool-use record before a later Stop", () => {
    const turns = new Map();
    const resolve = (session, event, turn) => resolveCodexOfficialHookState({
      agent_id: "codex", hook_source: "codex-official", session_id: session, event, turn_id: turn,
    }, event === "PreToolUse" ? "working" : "idle", turns);
    resolve("owner", "PreToolUse", "T1");
    resolve("peer", "PreToolUse", "T1");
    assert.equal(resolve("owner", "Interrupt", "T1").state, "idle");
    assert.equal(turns.has(getCodexOfficialTurnKey("owner", "T1")), false);
    assert.equal(turns.has(getCodexOfficialTurnKey("peer", "T1")), true);
    assert.equal(resolve("owner", "Stop", "T1").state, "idle");
    assert.equal(resolve("peer", "Stop", "T1").state, "attention");
  });
});

describe("Id-less compaction turn compatibility", () => {
  for (const event of ["PreCompact", "PostCompact", "event_msg:context_compacted"]) {
    it(`accepts id-less ${event} while a turn is open without changing its fence`, () => {
      const fence = createFence();
      fence.observe({ sessionId: "s", event: "UserPromptSubmit", state: "thinking", turnId: "T1" });
      const before = fence.getSnapshot("s");
      assert.equal(fence.observe({ sessionId: "s", event, state: "sweeping" }).accept, true);
      assert.deepEqual(fence.getSnapshot("s"), before);
    });
    it(`rejects identified ${event} during an open id-less turn`, () => {
      const fence = createFence();
      fence.observe({ sessionId: "s", event: "UserPromptSubmit", state: "thinking" });
      const before = fence.getSnapshot("s");
      assert.equal(fence.observe({ sessionId: "s", event, state: "sweeping", turnId: "old" }).accept, false);
      assert.deepEqual(fence.getSnapshot("s"), before);
    });
  }
});
