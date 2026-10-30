"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
const createRuntime = require("../src/agent-runtime-main");
const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexConfig = require("../agents/codex");
const { makeSessionKey } = require("../src/session-key");

loader.init(path.join(__dirname, "..", "src"));

describe("local Codex process handoff needs current thread progress", () => {
  let state, runtime, monitor, tracked, alive, enabled, archived, config, refreshedParents;
  const raw = "codex:synthetic-handoff";
  const sid = makeSessionKey({ profileId: "local", rawSessionId: raw });
  const transcriptPath = path.join(__dirname, "fixtures", "synthetic-handoff.jsonl");
  const noop = () => {};
  const official = (value, event, extra = {}) => runtime.updateSessionFromServer(sid, value, event, {
    agentId: "codex", profileId: "local", rawSessionId: raw, hookSource: "codex-official",
    turnId: "T1", codexOriginator: "Codex Desktop", agentPid: 42, sourcePid: 42,
    transcriptPath, ...extra,
  });
  const record = (subtype = "agent_reasoning", extra = {}, occurredAt = Date.now()) => {
    monitor._processLine(JSON.stringify({ type: "event_msg", timestamp: new Date(occurredAt).toISOString(),
      payload: { type: subtype, turn_id: "T1", ...extra } }), tracked);
  };
  const start = () => { official("thinking", "UserPromptSubmit"); record("task_started"); };
  const retire = () => { alive.delete(42); state.cleanStaleSessions(); assert.equal(state.sessions.has(sid), false); };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    alive = new Set([42, 84]); enabled = true; archived = false; refreshedParents = [];
    config = { codexWorkingStaleMs: 60000, sessionStaleMs: 600000 };
    const theme = structuredClone(loader.loadTheme("clawd"));
    theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
    state = require("../src/state")({ theme, doNotDisturb: false,
      playSound: noop, sendToRenderer: noop, syncHitWin: noop, sendToHitWin: noop,
      miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop, buildTrayMenu: noop,
      resolvePermissionEntry: noop, dismissPermissionsForDnd: noop, focusTerminalWindow: noop,
      processKill: pid => { if (alive.has(pid)) return true;
        const error = new Error("synthetic dead process"); error.code = "ESRCH"; throw error; },
      getStaleConfig: () => config, t: key => key });
    class ManualMonitor extends CodexLogMonitor {
      constructor(agent, callback, options) {
        super(agent, callback, { ...options, codexDir: path.join(__dirname, "fixtures", "synthetic-empty-codex-home") });
        this._resolveTrackedAgentPid = () => null;
      }
      start() {} stop() {}
    }
    runtime = createRuntime({ now: () => Date.now(), getStateRuntime: () => state,
      updateSession: (...args) => state.updateSession(...args), isAgentEnabled: () => enabled,
      codexArchiveTracker: { start: noop, stop: noop, isArchived: () => archived },
      loadCodexAgent: () => codexConfig, loadCodexLogMonitor: () => ManualMonitor });
    monitor = runtime.startCodexLogMonitor();
    monitor.refreshSubagentsOfParent = parentId => refreshedParents.push(parentId);
    tracked = { sessionId: raw, filePath: transcriptPath, cwd: "", codexOriginator: "Codex Desktop",
      lastState: null, activeTurnId: null, turnBoundaryOpen: false, pendingUserInputs: new Map(),
      backfilling: false, initializingUserInputs: false };
  });
  afterEach(() => { runtime.cleanup(); state.cleanup(); mock.restoreAll(); mock.timers.reset(); });

  it("detaches a dead shared PID only for the conversation producing fresh accepted progress", () => {
    start();
    const peer = makeSessionKey({ profileId: "local", rawSessionId: "codex:synthetic-peer" });
    state.updateSession(peer, "thinking", "UserPromptSubmit", { agentId: "codex", agentPid: 42, sourcePid: 42 });
    const history = structuredClone(state.sessions.get(sid).recentEvents);
    alive.delete(42); mock.timers.tick(1000); record();
    assert.equal(state.sessions.get(sid).agentPid, null);
    assert.equal(state.sessions.get(sid).sourcePid, null);
    assert.equal(state.sessions.get(sid).pidReachable, false);
    assert.deepEqual(state.sessions.get(sid).recentEvents, history);
    assert.deepEqual(refreshedParents, [], "an existing row's ordinary activity cannot re-declare children");
    state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.equal(state.sessions.has(peer), false, "a peer's shared PID does not prove its thread is alive");
    mock.timers.tick(60001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle", "the user's one-minute no-progress policy still applies");
  });

  it("recovers only an agent-exit retired own-turn row without copying transcript content", () => {
    start();
    const session = state.sessions.get(sid);
    session.assistantLastOutput = "private synthetic output";
    session.sessionTitle = "private prompt fallback"; session.sessionTitleFromPrompt = true;
    retire(); mock.timers.tick(1000); record();
    const recovered = state.sessions.get(sid);
    assert.equal(recovered.state, "thinking");
    assert.equal(recovered.agentPid, null);
    assert.equal(recovered.assistantLastOutput, undefined);
    assert.equal(recovered.sessionTitle, undefined);
    assert.deepEqual(recovered.recentEvents, []);
    assert.equal(state.resolveDisplayState(), "thinking");
    assert.deepEqual(refreshedParents, [raw]);
    mock.timers.tick(1); record();
    assert.deepEqual(refreshedParents, [raw], "only the successful missing-row restoration requests refresh");
    assert.doesNotMatch(JSON.stringify(state.buildSessionSnapshot()), /ProcessExitRecovery|private synthetic|private prompt/);
  });

  for (const turnId of [null, "T1"]) {
    it(`late ${turnId ? "identified" : "idless"} official initialization after agent exit waits for real progress`, () => {
      start(); retire();
      const ownerBefore = runtime.getCodexTurnFenceSnapshot(sid);
      mock.timers.tick(1000);
      official("idle", "SessionStart", { turnId, agentPid: 84, sourcePid: 84 });
      assert.equal(state.sessions.has(sid), false, "initialization cannot replace the retired active turn with idle");
      assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T1", transcriptPath }), true);
      assert.deepEqual(runtime.getCodexTurnFenceSnapshot(sid), ownerBefore, "initialization never advances the turn clock");
      assert.deepEqual(refreshedParents, [], "initialization alone cannot re-admit children");
      mock.timers.tick(1000); record();
      assert.equal(state.sessions.get(sid).state, "thinking");
      assert.equal(state.sessions.get(sid).updatedAt, 2000);
      assert.deepEqual(refreshedParents, [raw]);
    });
  }

  it("the recovery query is exact, private, and never extends the retention TTL", () => {
    start(); retire();
    assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T2", transcriptPath }), false);
    assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T1", transcriptPath: transcriptPath + ".other" }), false);
    assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T1", transcriptPath }), true);
    mock.timers.tick(599000);
    official("idle", "SessionStart", { turnId: null, agentPid: 84, sourcePid: 84 });
    assert.equal(state.sessions.has(sid), false);
    mock.timers.tick(1001);
    assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T1", transcriptPath }), false);
    assert.equal(state.sessions.has(sid), false);
  });

  for (const mismatch of ["wrong turn", "wrong path", "expired", "SessionEnd"]) {
    it(`does not hold an ordinary initializer after ${mismatch} invalidates the recovery tuple`, () => {
      start(); retire();
      if (mismatch === "expired") mock.timers.tick(600001);
      if (mismatch === "SessionEnd") official("sleeping", "SessionEnd", { agentPid: null, sourcePid: null });
      official("idle", "SessionStart", { agentPid: 84, sourcePid: 84,
        turnId: mismatch === "wrong turn" ? "T2" : null,
        transcriptPath: mismatch === "wrong path" ? transcriptPath + ".other" : transcriptPath });
      assert.equal(state.sessions.get(sid).state, "idle");
      assert.equal(state.hasRecoverableCodexProcessExit(sid, { turnId: "T1", transcriptPath }), false);
      record();
      assert.equal(state.sessions.get(sid).state, "idle");
      assert.deepEqual(refreshedParents, []);
    });
  }

  for (const terminal of ["Stop", "Interrupt", "SessionEnd"]) {
    it(`does not recover after accepted ${terminal}`, () => {
      start(); retire(); official(terminal === "SessionEnd" ? "sleeping" : "idle", terminal,
        { agentPid: null, sourcePid: null });
      mock.timers.tick(1000); record();
      assert.notEqual(state.sessions.get(sid)?.state, "thinking");
    });
  }

  for (const invalid of ["dismiss", "dismiss after delete", "disabled", "archived", "headless", "replay", "different turn", "old record", "wrong transcript", "expired cache", "configured timeout", "guardian", "metadata"]) {
    it(`rejects ${invalid} as recovery authority`, () => {
      start();
      if (invalid === "dismiss") state.dismissSession(sid);
      else retire();
      if (invalid === "dismiss after delete") state.dismissSession(sid);
      if (invalid === "disabled") enabled = false;
      if (invalid === "archived") archived = true;
      if (invalid === "headless") tracked.isSubagent = true;
      if (invalid === "replay") tracked.backfilling = true;
      if (invalid === "wrong transcript") tracked.filePath += ".other";
      if (invalid === "expired cache") mock.timers.tick(600001);
      else mock.timers.tick(40000);
      if (invalid === "configured timeout") config.codexWorkingStaleMs = 100;
      record(invalid === "guardian" ? "guardian_assessment" : invalid === "metadata" ? "token_count" : "agent_reasoning",
        invalid === "different turn" ? { turn_id: "T2" } : {},
        invalid === "old record" ? 1 : invalid === "configured timeout" ? Date.now() - 1000 : Date.now());
      assert.equal(state.sessions.has(sid), false);
      assert.deepEqual(refreshedParents, [], "failed or disabled recovery cannot refresh children");
    });
  }

  it("cannot replace a newer turn's process or clock with older turn progress", () => {
    start(); retire(); official("thinking", "UserPromptSubmit", { turnId: "T2", agentPid: 84, sourcePid: 84 });
    mock.timers.tick(1000); record();
    assert.equal(state.sessions.get(sid).agentPid, 84);
    assert.equal(state.sessions.get(sid).updatedAt, 0);
  });

  it("clears a still-live old source and every inherited focus target after its agent dies", () => {
    start();
    Object.assign(state.sessions.get(sid), { sourcePid: 84, wtHwnd: "123", pidChain: [42, 84],
      orcaPaneKey: "old", herdrPaneId: "old", herdrSocket: "old", tmuxSocket: "old", tmuxClient: "old",
      ghosttyTerminalId: "old", dshCarrier: "old", editor: "old", sessionAutomationIdentity: { eligible: true } });
    alive.delete(42); mock.timers.tick(1000); record();
    const current = state.sessions.get(sid);
    for (const key of ["agentPid", "sourcePid", "wtHwnd", "pidChain", "orcaPaneKey", "herdrPaneId", "herdrSocket",
      "tmuxSocket", "tmuxClient", "ghosttyTerminalId", "dshCarrier", "editor", "sessionAutomationIdentity"]) {
      assert.equal(current[key], null, key);
    }
  });

  for (const platform of ["wsl", "WSL", " wSl "]) {
    it(`a platform-only ${JSON.stringify(platform)} marker cannot borrow this host's progress or process checks`, () => {
      start(); state.sessions.get(sid).platform = platform;
      alive.delete(42); mock.timers.tick(1000); record();
      assert.equal(state.sessions.get(sid).agentPid, 42);
      assert.equal(state.sessions.get(sid).updatedAt, 0);
    });
  }

  it("the state recovery API rejects an invalid phase before inserting a row", () => {
    start(); retire(); mock.timers.tick(1000);
    assert.equal(state.acceptCodexLiveProcessProgress(sid, { turnId: "T1", transcriptPath,
      now: Date.now(), activityState: "idle" }), false);
    assert.equal(state.sessions.has(sid), false);
    record(); assert.equal(state.sessions.get(sid).state, "thinking");
  });

  it("recovery keeps DND quiet while retaining canonical active work", () => {
    start(); retire(); state.enableDoNotDisturb(); mock.timers.tick(1000); record();
    assert.equal(state.sessions.get(sid).state, "thinking");
    assert.notEqual(state.getCurrentState(), "thinking");
    assert.notEqual(state.getCurrentState(), "working");
  });

  it("the process-evidence freshness bound does not shorten the user's timeout-revival window", () => {
    start(); mock.timers.tick(60001); state.cleanStaleSessions();
    assert.equal(state.sessions.get(sid).state, "idle");
    mock.timers.tick(60000); record("agent_reasoning", {}, Date.now() - 40000);
    assert.equal(state.sessions.get(sid).state, "thinking");
  });

  it("successful restoration works with a standalone monitor without a child-refresh method", () => {
    delete monitor.refreshSubagentsOfParent;
    start(); retire(); mock.timers.tick(1000); record();
    assert.equal(state.sessions.get(sid).state, "thinking");
  });

  it("a pathless late initializer cannot consume a known open recovery tuple, while recovery still needs its exact path", () => {
    start(); retire(); mock.timers.tick(1000);
    official("idle", "SessionStart", {turnId:null,transcriptPath:null,agentPid:84,sourcePid:84});
    assert.equal(state.sessions.has(sid),false);
    assert.equal(state.hasRecoverableCodexProcessExit(sid,{turnId:"T1",transcriptPath:null}),false);
    assert.equal(state.acceptCodexLiveProcessProgress(sid,{turnId:"T1",transcriptPath:null,
      now:Date.now(),activityState:"thinking"}),false);
    record();
    assert.equal(state.sessions.get(sid).state,"thinking");
  });

  for (const platform of ["wsl", "WSL", " wSl "]) {
    it(`platform-only ${JSON.stringify(platform)} official hooks never create a local turn fence`, () => {
      official("thinking", "UserPromptSubmit", { platform, turnId: "WSL-T1" });
      assert.equal(runtime.getCodexTurnFenceSnapshot(sid), null);
      assert.deepEqual(refreshedParents, []);
    });
  }
});
