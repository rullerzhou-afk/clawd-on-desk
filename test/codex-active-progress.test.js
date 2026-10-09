"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
const createRuntime = require("../src/agent-runtime-main");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");
const createRoam = require("../src/roam");
const { isSessionInProgress } = require("../src/state-session-snapshot");
const { makeSessionKey } = require("../src/session-key");

loader.init(path.join(__dirname, "..", "src"));

describe("Codex activity clock and automatic roaming", () => {
  let state, runtime, monitor, ctx, tracked, roam, alive;
  const raw = "codex:synthetic-active-thread";
  const sid = makeSessionKey({ profileId: "local", rawSessionId: raw });
  const noop = () => {};
  const officialOptions = { agentId: "codex", hookSource: "codex-official", profileId: "local",
    rawSessionId: raw, turnId: "T1", codexOriginator: "Codex Desktop", agentPid: 42, sourcePid: 42 };
  const official = (value, event, extra = {}) => runtime.updateSessionFromServer(sid, value, event,
    { ...officialOptions, ...extra });
  const record = (type, subtype, extra = {}, timestamp = Date.now()) => monitor._processLine(JSON.stringify({
    type, timestamp: new Date(timestamp).toISOString(), payload: { type: subtype, turn_id: "T1", ...extra },
  }), tracked);
  const start = (value = "thinking") => {
    official(value, "UserPromptSubmit");
    record("event_msg", "task_started");
    if (value === "working") official("working", "PreToolUse");
  };
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.method(Math, "random", () => 0.9);
    const theme = structuredClone(loader.loadTheme("clawd"));
    theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
    alive = new Set([42, 84]);
    ctx = { theme, doNotDisturb: false, miniMode: false, miniTransitioning: false,
      mouseOverPet: false, mouseStillSince: Date.now(), pendingPermissions: [],
      playSound: noop, sendToRenderer: noop, syncHitWin: noop, sendToHitWin: noop,
      miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop, buildTrayMenu: noop,
      resolvePermissionEntry: noop, dismissPermissionsForDnd: noop, focusTerminalWindow: noop,
      processKill: pid => {
        if (alive.has(pid)) return true;
        const error = new Error("synthetic process exit"); error.code = "ESRCH"; throw error;
      }, getStaleConfig: () => ({ codexWorkingStaleMs: 60000, sessionStaleMs: 600000 }),
      t: key => key };
    state = require("../src/state")(ctx);
    class ManualMonitor extends CodexLogMonitor {
      constructor(agent, callback, options) {
        super(agent, callback, { ...options, codexDir: path.join(__dirname, "fixtures", "synthetic-empty-codex-home") });
        this._resolveTrackedAgentPid = () => 42;
      }
      start() {} stop() {}
    }
    runtime = createRuntime({ now: () => Date.now(), getStateRuntime: () => state,
      updateSession: (...args) => state.updateSession(...args), loadCodexAgent: () => codexConfig,
      loadCodexLogMonitor: () => ManualMonitor });
    monitor = runtime.startCodexLogMonitor();
    tracked = { sessionId: raw, filePath: path.join(__dirname, "fixtures", "synthetic-rollout.jsonl"),
      cwd: "", codexOriginator: "Codex Desktop", codexSource: "vscode", lastState: null,
      lastEventTime: Date.now(), activeTurnId: null, turnBoundaryOpen: false, pendingUserInputs: new Map(),
      backfilling: false, initializingUserInputs: false, agentPid: 42 };
  });
  afterEach(() => { roam?.cancelRoam(); roam = null; runtime.cleanup(); state.cleanup(); mock.restoreAll(); mock.timers.reset(); });

  it("fresh same-turn tool progress suppressed by official hooks still extends the inactivity clock", () => {
    start();
    const beforeHistory = structuredClone(state.sessions.get(sid).recentEvents);
    mock.timers.tick(50000);
    record("response_item", "function_call", { name: "read_files", call_id: "synthetic-call" });
    mock.timers.tick(10001);
    state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.equal(state.sessions.get(sid).updatedAt, 50000);
    assert.deepEqual(state.sessions.get(sid).recentEvents, beforeHistory);
    mock.timers.tick(50000);
    state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle", "the configured no-progress timeout must remain bounded");
  });

  for (const [type, subtype, extra] of [["event_msg", "agent_reasoning", {}],
    ["response_item", "reasoning", {}], ["event_msg", "agent_message", { message: "synthetic progress" }]]) {
    it(`live ${type}:${subtype} keeps an open thinking turn active without another hook`, () => {
      start();
      mock.timers.tick(50000);
      record(type, subtype, extra);
      mock.timers.tick(10001);
      state.cleanStaleSessions();
      assert.equal(state.sessions.get(sid).state, "thinking");
      assert.equal(state.sessions.get(sid).updatedAt, 50000);
    });
  }

  it("a repeated working tool result counts as activity even when the visual transition is deduplicated", () => {
    start("working");
    tracked.lastState = "working";
    mock.timers.tick(50000);
    record("event_msg", "exec_command_end", { call_id: "synthetic-command" });
    mock.timers.tick(10001);
    state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "working");
    assert.equal(state.sessions.get(sid).updatedAt, 50000);
  });

  it("fresh progress revives a timeout-idled open turn with its thinking state", () => {
    start();
    mock.timers.tick(60001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle");
    record("event_msg", "agent_reasoning");
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.equal(state.resolveDisplayState(), "thinking");
    assert.equal(state.buildSessionSnapshot().sessions.find(entry => entry.id === sid).badge, "running");
  });

  it("a fresh record written before the timeout tick may arrive one poll later", () => {
    start(); mock.timers.tick(60001); state.cleanStaleSessions();
    record("event_msg", "agent_reasoning", {}, 59000);
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.equal(state.sessions.get(sid).updatedAt, 59000);
  });

  it("a delayed record already beyond the configured inactivity window cannot revive a task", () => {
    start(); mock.timers.tick(61001); state.cleanStaleSessions();
    record("event_msg", "agent_reasoning", {}, 500);
    assert.equal(state.sessions.get(sid).state, "idle");
    assert.equal(state.sessions.get(sid).updatedAt, 61001);
  });

  it("quota telemetry cannot extend or revive an inactive task", () => {
    start();
    mock.timers.tick(50000);
    record("event_msg", "token_count", { info: { last_token_usage: { total_tokens: 12 }, model_context_window: 100 } });
    mock.timers.tick(10001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle");
    record("event_msg", "token_count", { info: { last_token_usage: { total_tokens: 13 }, model_context_window: 100 } });
    assert.equal(state.sessions.get(sid).state, "idle");
  });

  it("a non-timeout idle state is not revived by model progress", () => {
    start(); official("notification", "Notification");
    assert.equal(state.sessions.get(sid).state, "idle");
    mock.timers.tick(1000); record("event_msg", "agent_reasoning");
    assert.equal(state.sessions.get(sid).state, "idle");
    assert.equal(state.sessions.get(sid).updatedAt, 0);
  });

  it("model progress cannot create a missing row", () => {
    start(); state.dismissSession(sid);
    mock.timers.tick(1000); record("event_msg", "agent_reasoning");
    assert.equal(state.sessions.has(sid), false);
  });

  it("id-less progress cannot prove ownership of an active clock", () => {
    official("thinking", "UserPromptSubmit", { turnId: null });
    record("event_msg", "task_started", { turn_id: null });
    mock.timers.tick(50000); record("event_msg", "agent_reasoning", { turn_id: null });
    assert.equal(state.sessions.get(sid).updatedAt, 0);
  });

  it("a model record without a timestamp cannot feed activity", () => {
    start(); mock.timers.tick(50000);
    monitor._processLine(JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning", turn_id: "T1" } }), tracked);
    assert.equal(state.sessions.get(sid).updatedAt, 0);
  });

  it("the timeout revival marker stays private and is cleared by accepted activity", () => {
    start(); mock.timers.tick(60001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).codexWorkingTimeoutAt, 60001);
    assert.doesNotMatch(JSON.stringify(state.buildSessionSnapshot()), /codexWorkingTimeout/);
    record("event_msg", "agent_reasoning");
    assert.equal(state.sessions.get(sid).codexWorkingTimeoutAt, undefined);
  });

  it("Desktop threads sharing a process remain independent in the busy and HUD projections", () => {
    start();
    const peer = makeSessionKey({ profileId: "local", rawSessionId: "codex:synthetic-peer" });
    runtime.updateSessionFromServer(peer, "idle", "Stop", { ...officialOptions,
      rawSessionId: "codex:synthetic-peer", turnId: "peer-turn" });
    assert.equal(state.resolveDisplayState(), "thinking");
    assert.equal(state.buildSessionSnapshot().hudTotalNonIdle, 2);
    assert.ok(state.buildSessionSnapshot().sessions.every(entry => !entry.hiddenFromHud));
  });

  it("keeps three busy conversations independent when two Codex threads share a live process", () => {
    start();
    const peerRaw = "codex:synthetic-three-peer", peer = makeSessionKey({ profileId: "local", rawSessionId: peerRaw });
    const buddy = makeSessionKey({ profileId: "local", rawSessionId: "workbuddy:synthetic-three" });
    const peerOptions = { ...officialOptions, rawSessionId: peerRaw };
    runtime.updateSessionFromServer(peer, "thinking", "UserPromptSubmit", peerOptions);
    runtime.updateSessionFromServer(peer, "working", "PreToolUse", peerOptions);
    state.updateSession(buddy, "thinking", "UserPromptSubmit", { agentId: "workbuddy", agentPid: 84, sourcePid: 84 });
    mock.timers.tick(50000);
    runtime.updateSessionFromServer(peer, "working", "PostToolUse", peerOptions);
    state.updateSession(buddy, "thinking", "UserPromptSubmit", { agentId: "workbuddy", agentPid: 84, sourcePid: 84 });
    mock.timers.tick(10001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle", "only the silent conversation reaches its configured cutoff");
    mock.timers.tick(1); record("event_msg", "agent_reasoning");
    const snapshot = state.buildSessionSnapshot();
    assert.equal(snapshot.hudTotalNonIdle, 3);
    assert.deepEqual(new Map(snapshot.sessions.map(entry => [entry.id, entry.state])),
      new Map([[sid, "thinking"], [peer, "working"], [buddy, "thinking"]]));
    assert.ok(snapshot.sessions.every(entry => !entry.hiddenFromHud && entry.badge === "running"));
    assert.equal(state.sessions.get(sid).agentPid, state.sessions.get(peer).agentPid);
    assert.equal(state.sessions.get(sid).updatedAt, 60002);
    assert.equal(state.sessions.get(peer).updatedAt, 50000);
    assert.equal(state.sessions.get(buddy).updatedAt, 50000);
    state.applyState("idle");
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.equal(frames(), 0);
  });

  for (const invalid of ["backfill", "old timestamp", "future timestamp", "another turn", "WSL", "headless"]) {
    it(`${invalid} progress cannot feed the active clock`, () => {
      start(); mock.timers.tick(50000);
      if (invalid === "backfill") tracked.backfilling = true;
      if (invalid === "WSL") state.sessions.get(sid).wslDistro = "SyntheticDistro";
      if (invalid === "headless") state.sessions.get(sid).headless = true;
      const timestamp = invalid === "old timestamp" ? 0 : invalid === "future timestamp" ? 55000 : Date.now();
      record("event_msg", "agent_reasoning", invalid === "another turn" ? { turn_id: "T2" } : {}, timestamp);
      assert.equal(state.sessions.get(sid).updatedAt, 0);
    });
  }

  for (const terminal of ["Stop", "Interrupt", "event_msg:turn_aborted", "SessionEnd"]) {
    it(`late progress cannot reopen a task after ${terminal}`, () => {
      start();
      if (terminal === "event_msg:turn_aborted") record("event_msg", "turn_aborted");
      else official(terminal === "SessionEnd" ? "sleeping" : "idle", terminal);
      mock.timers.tick(50000);
      record("event_msg", "agent_reasoning");
      assert.notEqual(state.sessions.get(sid)?.state, "thinking");
      assert.notEqual(state.sessions.get(sid)?.state, "working");
    });
  }

  const makeRoam = () => {
    let frames = 0;
    const bounds = { x: 400, y: 300, width: 120, height: 120 };
    roam = createRoam({ win: { isDestroyed: () => false }, getCurrentState: state.getCurrentState,
      getMiniMode: () => ctx.miniMode, resolveDisplayState: state.resolveDisplayState,
      hasActiveSessions: () => [...state.sessions.values()].some(isSessionInProgress),
      getPetWindowBounds: () => bounds, getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      clampToScreenVisual: (x, y) => ({ x, y }), applyPetWindowBounds: () => { frames++; },
      applyState: state.applyState, setState: state.setState, syncHitWin: noop, repositionSessionHud: noop,
      repositionAnchoredSurfaces: noop, repositionBubbles: noop });
    roam.setEnabled(true);
    return () => frames;
  };

  it("canonical busy sessions block automatic roaming through an idle visual reaction", () => {
    start(); state.applyState("idle");
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.equal(frames(), 0);
    assert.equal(roam.isRoamAnimating(), false);
    assert.equal(state.sessions.get(sid).state, "thinking");
  });

  it("a busy session arriving while roaming cancels the next frame and restores canonical work", () => {
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.ok(frames() > 0);
    const before = frames();
    state.sessions.set(sid, { state: "working", agentId: "codex", codexOriginator: "Codex Desktop", updatedAt: Date.now() });
    mock.timers.tick(16);
    assert.equal(frames(), before);
    assert.equal(roam.isRoamAnimating(), false);
    assert.equal(state.getCurrentState(), "working");
  });

  it("legitimate completion permits ordinary idle roaming again", () => {
    start(); official("idle", "Stop");
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.ok(frames() > 0);
  });

  it("no-progress retirement still permits roaming even while the shared Desktop process lives", () => {
    start(); mock.timers.tick(60001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle");
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.ok(frames() > 0);
  });

  it("DND keeps a progress-revived task out of the visible work animation", () => {
    start(); mock.timers.tick(60001); state.cleanStaleSessions();
    state.enableDoNotDisturb();
    record("event_msg", "agent_reasoning");
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.notEqual(state.getCurrentState(), "thinking");
    assert.notEqual(state.getCurrentState(), "working");
    const frames = makeRoam(); roam.tick(); mock.timers.tick(8032);
    assert.equal(frames(), 0);
  });

  it("an old queued Stop probe cannot retire a newly active turn", () => {
    const callbacks = [];
    const originalSetTimeout = globalThis.setTimeout;
    mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (delay === 1000) callbacks.push(callback);
      return originalSetTimeout(callback, delay, ...args);
    });
    start(); official("idle", "Stop");
    assert.ok(callbacks.length > 0);
    official("thinking", "UserPromptSubmit", { turnId: "T2", agentPid: 84, sourcePid: 84 });
    alive.delete(42);
    callbacks.forEach(callback => callback());
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.equal(state.sessions.get(sid).agentPid, 84);
  });
});
