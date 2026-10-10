"use strict";

// Composition regressions: the real rollout parser feeds the real agent runtime,
// turn fence and state store. Only clocks, process liveness and renderers are fake.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CodexLogMonitor = require("../agents/codex-log-monitor");
const codexAgent = require("../agents/codex");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const { makeSessionKey } = require("../src/session-key");
const { isSessionInProgress } = require("../src/state-session-snapshot");
const { createMemoryRecapSink } = require("../src/recap-sink");
const { CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS } = require("../hooks/codex-internal-worker");

const START_MS = Date.parse("2026-10-11T12:00:00.000Z");
const THREAD_A = "aaaaaaaa-1111-4111-8111-111111111111";
const THREAD_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TURN_A = "turn-a";
const keyFor = (thread, profileId = "local") => makeSessionKey({ profileId, rawSessionId: `codex:${thread}` });

function makeHarness(t, { writerPid = null, staleConfig = null, ctxOverrides = {} } = {}) {
  const tempBase = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempBase, "clawd-codex-sessionstart-"));
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  fs.mkdirSync(home); fs.mkdirSync(project);
  const previousCodexHome = process.env.CODEX_HOME;
  const fixtureCodexHome = path.join(home, ".codex");
  fs.mkdirSync(fixtureCodexHome);
  process.env.CODEX_HOME = fixtureCodexHome;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  t.mock.method(os, "homedir", () => home);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START_MS });
  themeLoader.init(path.join(__dirname, "..", "src"));
  const theme = JSON.parse(JSON.stringify(themeLoader.loadTheme("clawd")));
  theme.timings.minDisplay = {};
  theme.timings.autoReturn = {};
  const recap = createMemoryRecapSink({ captureEphemeralIdentity: true });
  const sounds = [], snapshots = [], visuals = [], debug = [];
  const noop = () => {};
  const state = initState({
    lang: "en", theme, pendingPermissions: [], doNotDisturb: false,
    miniMode: false, miniTransitioning: false, mouseOverPet: false,
    mouseStillSince: Date.now(), getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    processKill: () => true, focusHostPlatform: "win32", recapSink: recap,
    getStaleConfig: () => staleConfig,
    isAgentEnabled: (agentId) => agentId === "codex",
    playSound: (sound) => sounds.push(sound),
    sendToRenderer: (channel, value) => { if (channel === "state-change") visuals.push(value); },
    broadcastSessionSnapshot: (snapshot) => snapshots.push(snapshot),
    syncHitWin: noop, sendToHitWin: noop, buildContextMenu: noop, buildTrayMenu: noop,
    focusTerminalWindow: noop, resolvePermissionEntry: noop,
    dismissPermissionsForDnd: noop, getSessionAliases: () => ({}),
    ...ctxOverrides,
  });
  class ManualCodexLogMonitor extends CodexLogMonitor {
    start() {} // No real timer, process discovery or user rollouts are touched.
  }
  const runtime = createAgentRuntimeMain({
    now: () => Date.now(), debugLog: (line) => debug.push(line),
    isAgentEnabled: (agentId) => agentId === "codex",
    loadCodexLogMonitor: () => ManualCodexLogMonitor,
    loadCodexAgent: () => ({ ...codexAgent, logConfig: { ...codexAgent.logConfig, sessionDir: dir } }),
    loadCodexArchiveTracker: () => () => ({ start: noop, stop: noop, isArchived: () => false }),
    getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
  });
  const monitor = runtime.startCodexLogMonitor();
  assert.ok(monitor, "the production Codex parser must be composed into the runtime");
  monitor._findCodexWriterPid = () => writerPid;
  monitor._isProcessAlive = () => true;
  t.after(() => {
    runtime.cleanup(); state.cleanup();
    assert.ok(path.resolve(dir).startsWith(tempBase + path.sep), "cleanup is restricted to the test-owned temp directory");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function append(thread, records) {
    const fileName = `rollout-2026-10-11T12-00-00-${thread}.jsonl`;
    const file = path.join(dir, fileName);
    fs.appendFileSync(file, records.map(record => JSON.stringify({ timestamp: new Date().toISOString(), ...record })).join("\n") + "\n");
    fs.utimesSync(file, new Date(), new Date());
    monitor._pollFile(file, fileName);
    return file;
  }
  function startTurn(thread = THREAD_A, turnId = TURN_A, meta = {}) {
    return append(thread, [
      { type: "session_meta", payload: { id: thread, cwd: project, source: "vscode", ...meta } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    ]);
  }
  function official(thread = THREAD_A, extra = {}) {
    return { agentId: "codex", profileId: "local", rawSessionId: `codex:${thread}`,
      hookSource: "codex-official", ...extra };
  }
  return { state, runtime, monitor, recap, sounds, visuals, snapshots, debug,
    dir, project, append, startTurn, official, advance: (ms) => t.mock.timers.tick(ms) };
}

function activityFields(session) {
  return Object.fromEntries(["state", "updatedAt", "event", "recentEvents", "lastToolBoundaryAt",
    "lastStopAt", "ackedAt", "requiresCompletionAck", "awaitingInputSinceStop",
    "codexWorkingTimeoutAt", "codexWorkingTimeoutActivityAt"].map(field =>
    [field, session[field] === undefined ? undefined : structuredClone(session[field])]));
}

function assertRunning(h, sessionId) {
  const session = h.state.sessions.get(sessionId);
  assert.equal(session.state, "thinking", "late initialization must not demote the accepted running turn");
  assert.equal(isSessionInProgress(session), true, "keep-awake and roam still see a busy session");
  assert.equal(h.state.getCurrentState(), "thinking", "the pet must retain the busy display");
  const snapshot = h.state.buildSessionSnapshot();
  const row = snapshot.sessions.find(value => value.id === sessionId);
  assert.ok(row);
  assert.equal(row.badge, "running", "the HUD cannot become an idle/completed card");
  assert.equal(row.state, "thinking");
  return row;
}

describe("Codex SessionStart after an accepted rollout turn", () => {
  it("keeps a task_started turn busy after a 10.5s late idle official start and merges only initialization metadata", (t) => {
    const h = makeHarness(t);
    h.startTurn();
    const id = keyFor(THREAD_A);
    assertRunning(h, id);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, TURN_A);
    const before = activityFields(h.state.sessions.get(id));
    const recapBefore = h.recap.snapshot();
    const soundsBefore = [...h.sounds];
    h.advance(10500);
    const newCwd = path.join(h.dir, "initialized-project");
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, {
      sessionTitle: "Initialized chat", cwd: newCwd,
      sourcePid: 701, agentPid: 702, pidChain: [701, 702],
      codexOriginator: "Codex Desktop", codexSource: "vscode",
    }));
    const row = assertRunning(h, id);
    assert.deepEqual(activityFields(h.state.sessions.get(id)), before,
      "initialization is not fresh work, a tool/Stop boundary, acknowledgement or history event");
    assert.deepEqual(h.recap.snapshot(), recapBefore, "a late start must not record activity/completion recap");
    assert.deepEqual(h.sounds, soundsBefore);
    assert.equal(row.displayTitle, "Initialized chat");
    assert.equal(h.state.sessions.get(id).cwd, newCwd);
    assert.equal(h.state.sessions.get(id).sourcePid, 701);
    assert.equal(h.state.sessions.get(id).agentPid, 702);
    assert.deepEqual(h.state.sessions.get(id).pidChain, [701, 702]);
    assert.equal(h.state.sessions.get(id).codexOriginator, "Codex Desktop");
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, TURN_A);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).terminalLatch, null);
  });

  it("keeps an accepted legacy id-less task start without inventing a turn identity", (t) => {
    const h = makeHarness(t);
    h.startTurn(THREAD_A, null);
    const id = keyFor(THREAD_A);
    const before = activityFields(h.state.sessions.get(id));
    assert.equal(before.state, "thinking");
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, null);
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assertRunning(h, id);
    assert.deepEqual(activityFields(h.state.sessions.get(id)), before);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, null);
  });

  it("preserves observed work during DND without waking the pet or recording another activity", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.state.enableDoNotDisturb();
    const before = activityFields(h.state.sessions.get(id));
    h.advance(10500); // Allow the normal sleep transition before observing the event.
    const displayBefore = h.state.getCurrentState();
    const soundsBefore = [...h.sounds], recapBefore = h.recap.snapshot();
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).state, "thinking");
    assert.deepEqual(activityFields(h.state.sessions.get(id)), before);
    assert.equal(h.state.getCurrentState(), displayBefore);
    assert.deepEqual(h.sounds, soundsBefore);
    assert.deepEqual(h.recap.snapshot(), recapBefore);
  });

  it("does not resolve a pending approval or end its session grant during initialization", (t) => {
    const id = keyFor(THREAD_A);
    const request = { agentId: "codex", sessionId: id, res: {}, toolName: "shell_command" };
    const pending = [request], decisions = [];
    const grant = { grantId: "fixture-grant", agentId: "codex", sessionId: id, mode: "auto-tools" };
    const grants = new Map([[id, grant]]);
    const h = makeHarness(t, { ctxOverrides: {
      pendingPermissions: pending,
      resolvePermissionEntry: (...args) => decisions.push(args),
      getSessionAutomationRecords: () => [...grants.values()],
      onSessionAutomationLifecycleEnd: ({ sessionId }) => grants.delete(sessionId),
    } });
    h.startTurn();
    const before = activityFields(h.state.sessions.get(id));
    const displayBefore = h.state.getCurrentState();
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).state, "thinking");
    assert.deepEqual(activityFields(h.state.sessions.get(id)), before);
    assert.equal(h.state.getCurrentState(), displayBefore);
    assert.deepEqual(decisions, []);
    assert.deepEqual(pending, [request]);
    assert.strictEqual(grants.get(id), grant);
  });

  it("keeps a genuinely new thread cold until its own prompt starts a new turn", (t) => {
    const h = makeHarness(t);
    h.startTurn(); h.advance(10500);
    const coldId = keyFor(THREAD_B);
    h.runtime.updateSessionFromServer(coldId, "idle", "SessionStart", h.official(THREAD_B, {
      sourcePid: 701, sessionTitle: "New thread", sessionStartSource: "clear",
    }));
    assert.equal(h.state.sessions.get(coldId).state, "idle");
    assert.equal(isSessionInProgress(h.state.sessions.get(coldId)), false);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(coldId), null,
      "another thread's accepted open turn cannot initialize this one as busy");
    h.runtime.updateSessionFromServer(coldId, "thinking", "UserPromptSubmit", h.official(THREAD_B, { turnId: "turn-b" }));
    assert.equal(h.state.sessions.get(coldId).state, "thinking");
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(coldId).currentTurnId, "turn-b");
  });

  for (const terminal of ["Stop", "Interrupt"]) {
    it(`does not reopen a ${terminal}-closed turn, but admits the next real prompt`, (t) => {
      const h = makeHarness(t);
      h.startTurn(); const id = keyFor(THREAD_A);
      h.runtime.updateSessionFromServer(id, "idle", terminal, h.official(THREAD_A, { turnId: TURN_A }));
      h.advance(10500);
      h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
      assert.equal(h.state.sessions.get(id).state, "idle");
      assert.equal(isSessionInProgress(h.state.sessions.get(id)), false);
      assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).terminalLatch.terminalEvent, terminal);
      h.append(THREAD_A, [{ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "late-old-tool", turn_id: TURN_A } }]);
      assert.equal(h.state.sessions.get(id).state, "idle", "old rollout work remains fenced");
      h.runtime.updateSessionFromServer(id, "thinking", "UserPromptSubmit", h.official(THREAD_A, { turnId: "turn-b" }));
      assert.equal(h.state.sessions.get(id).state, "thinking");
      assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, "turn-b");
    });
  }

  it("does not reconstruct busy ownership after SessionEnd deleted the existing row", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.runtime.updateSessionFromServer(id, "sleeping", "SessionEnd", h.official());
    assert.equal(h.state.sessions.has(id), false);
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).state, "idle");
    assert.equal(isSessionInProgress(h.state.sessions.get(id)), false);
  });

  it("does not use a shared desktop PID as authority over a peer conversation", (t) => {
    const h = makeHarness(t, { writerPid: 701 });
    h.startTurn(THREAD_A, TURN_A, { originator: "Codex Desktop" });
    h.startTurn(THREAD_B, "peer-turn", { originator: "Codex Desktop" });
    const id = keyFor(THREAD_A), peerId = keyFor(THREAD_B);
    const peerBefore = activityFields(h.state.sessions.get(peerId));
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, { sourcePid: 701, agentPid: 701 }));
    assert.equal(h.state.sessions.get(id).state, "thinking");
    assert.deepEqual(activityFields(h.state.sessions.get(peerId)), peerBefore);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(id).currentTurnId, TURN_A);
    assert.equal(h.runtime.getCodexTurnFenceSnapshot(peerId).currentTurnId, "peer-turn");
  });

  it("does not turn a non-timeout idle row back into work from fence history alone", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.state.updateSession(id, "idle", null, { agentId: "codex", profileId: "local" });
    assert.equal(h.state.sessions.get(id).codexWorkingTimeoutAt, undefined);
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).state, "idle");
    assert.equal(isSessionInProgress(h.state.sessions.get(id)), false);
  });

  it("keeps actual compaction holds on their established SessionStart release path", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.runtime.updateSessionFromServer(id, "sweeping", "PreCompact", h.official(THREAD_A, { turnId: TURN_A }));
    assert.equal(h.state.hasCodexCompactionHold(id), true);
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, { sessionStartSource: "compact" }));
    assert.equal(h.state.sessions.get(id).state, "idle");
    assert.equal(h.state.hasCodexCompactionHold(id), false);
  });

  for (const scope of [
    { name: "remote", extra: { host: "test-remote" } },
    { name: "WSL", extra: { wslDistro: "Test-Distro" } },
    { name: "headless", extra: { headless: true } },
  ]) {
    it(`does not expand initialization preservation to ${scope.name} sessions`, (t) => {
      const h = makeHarness(t);
      h.startTurn(); const id = keyFor(THREAD_A);
      h.runtime.updateSessionFromServer(id, "thinking", "UserPromptSubmit", h.official(THREAD_A, { turnId: "scoped-turn", ...scope.extra }));
      h.advance(10500);
      h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, scope.extra));
      assert.equal(h.state.sessions.get(id).state, "idle");
    });
  }

  it("never keeps a recognized ambient-suggestion row busy", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, {
      codexInternalThread: CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS,
    }));
    assert.equal(h.state.sessions.has(id), false);
  });

  it("accepts real same-turn reasoning progress after late initialization but still expires when progress stops", (t) => {
    const h = makeHarness(t, { staleConfig: { sessionStaleMs: 600000, codexWorkingStaleMs: 30000 } });
    h.startTurn(); const id = keyFor(THREAD_A);
    const initialActivityAt = h.state.sessions.get(id).updatedAt;
    h.advance(10500);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).updatedAt, initialActivityAt);
    const eventsBefore = structuredClone(h.state.sessions.get(id).recentEvents);
    h.advance(5000);
    const progressAt = Date.now();
    h.append(THREAD_A, [{ type: "event_msg", payload: { type: "agent_reasoning", text: "fixture reasoning", turn_id: TURN_A } }]);
    assert.equal(h.state.sessions.get(id).updatedAt, progressAt, "the production parser's progress callback must still refresh liveness");
    assert.deepEqual(h.state.sessions.get(id).recentEvents, eventsBefore, "reasoning progress is not a replayed lifecycle boundary");
    assertRunning(h, id);
    h.advance(5000);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
    assert.equal(h.state.sessions.get(id).updatedAt, progressAt, "another initialization cannot extend the quiet segment");
    h.advance(24999);
    h.state.cleanStaleSessions();
    assert.equal(h.state.sessions.get(id).state, "thinking", "keep the session until its real-progress timeout");
    h.advance(2);
    h.state.cleanStaleSessions();
    assert.equal(h.state.sessions.get(id).state, "idle", "initialization must not defeat the configured working timeout");
    assert.equal(h.state.sessions.get(id).codexWorkingTimeoutActivityAt, progressAt);
    assert.equal(isSessionInProgress(h.state.sessions.get(id)), false);
  });

  it("keeps parser-established working state, display hint and tool boundary without repeated initialization broadcasts", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.advance(100);
    h.append(THREAD_A, [{ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "working-tool", turn_id: TURN_A } }]);
    assert.equal(h.state.sessions.get(id).state, "working");
    h.runtime.updateSessionFromServer(id, "working", "PostToolUse", h.official(THREAD_A, {
      turnId: TURN_A, toolName: "Read", displayHint: "reading", sourcePid: 701, agentPid: 702,
    }));
    assert.ok(Number.isSafeInteger(h.state.sessions.get(id).lastToolBoundaryAt));
    const activityBefore = activityFields(h.state.sessions.get(id));
    const hintBefore = h.state.sessions.get(id).displayHint;
    const recapBefore = h.recap.snapshot();
    const snapshotCount = h.snapshots.length, visualCount = h.visuals.length;
    h.advance(10500);
    for (let index = 0; index < 3; index++) {
      h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official());
      h.advance(1000);
    }
    assert.deepEqual(activityFields(h.state.sessions.get(id)), activityBefore);
    assert.equal(h.state.sessions.get(id).displayHint, hintBefore);
    assert.equal(isSessionInProgress(h.state.sessions.get(id)), true);
    assert.deepEqual(h.recap.snapshot(), recapBefore);
    assert.equal(h.snapshots.length, snapshotCount, "equivalent initialization metadata is a renderer no-op");
    assert.equal(h.visuals.length, visualCount, "working animation must not restart or turn idle");
  });

  it("merges model and context metadata without replacing a formal title by a prompt fallback", (t) => {
    const h = makeHarness(t);
    h.startTurn(); const id = keyFor(THREAD_A);
    h.runtime.updateSessionMetadataFromServer(id, { expectedAgentId: "codex", sessionTitle: "Formal title",
      model: "fixture-model-before", contextUsage: { used: 1000, limit: 20000, percent: 5, source: "codex" } });
    const activityBefore = activityFields(h.state.sessions.get(id));
    h.advance(10500);
    const metadata = h.official(THREAD_A, { sessionTitle: "New prompt first line", sessionTitleFromPrompt: true,
      model: "fixture-model-after", contextUsage: { used: 6000, limit: 24000, percent: 25, source: "codex" } });
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", metadata);
    const session = h.state.sessions.get(id);
    assert.equal(session.sessionTitle, "Formal title");
    assert.equal(session.sessionTitleFromPrompt, false);
    assert.equal(session.model, "fixture-model-after");
    assert.deepEqual(session.contextUsage, { used: 6000, limit: 24000, percent: 25, source: "codex" });
    assert.deepEqual(activityFields(session), activityBefore);
    const metadataStamp = session.metadataUpdatedAt, snapshotCount = h.snapshots.length;
    h.advance(1000);
    h.runtime.updateSessionFromServer(id, "idle", "SessionStart", metadata);
    assert.equal(session.metadataUpdatedAt, metadataStamp);
    assert.equal(h.snapshots.length, snapshotCount, "unchanged title/model/context cannot create another snapshot");
  });

  for (const change of [
    { name: "source PID change", extra: { sourcePid: 801, agentPid: 802, wtHwnd: "123456" } },
    { name: "window handle change", extra: { sourcePid: 701, agentPid: 702, wtHwnd: "234567" } },
    { name: "authoritative all-null process replacement", extra: { replaceProcessMetadata: true,
      sourcePid: null, agentPid: null, wtHwnd: null, pidChain: null, editor: null } },
  ]) {
    it(`preserves an unchanged Orca focus key but clears it on ${change.name}`, (t) => {
      const h = makeHarness(t);
      h.startTurn(); const id = keyFor(THREAD_A);
      h.runtime.updateSessionFromServer(id, "working", "PostToolUse", h.official(THREAD_A, {
        turnId: TURN_A, sourcePid: 701, agentPid: 702, wtHwnd: "123456", pidChain: [701, 702],
        editor: "fixture-editor", orcaPaneKey: "fixture:owned-pane",
      }));
      const activityBefore = activityFields(h.state.sessions.get(id));
      h.advance(10500);
      h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, {
        sourcePid: 701, agentPid: 702, wtHwnd: "123456",
      }));
      assert.equal(h.state.sessions.get(id).orcaPaneKey, "fixture:owned-pane", "same-owner initialization without a key preserves valid focus identity");
      h.runtime.updateSessionFromServer(id, "idle", "SessionStart", h.official(THREAD_A, change.extra));
      assert.equal(h.state.sessions.get(id).orcaPaneKey, null, "changed process/window ownership cannot retain the old pane target");
      assert.deepEqual(activityFields(h.state.sessions.get(id)), activityBefore, "process replacement is metadata, not a new turn");
      if (change.extra.replaceProcessMetadata) {
        assert.equal(h.state.sessions.get(id).sourcePid, null);
        assert.equal(h.state.sessions.get(id).agentPid, null);
        assert.equal(h.state.sessions.get(id).wtHwnd, null);
        assert.equal(h.state.sessions.get(id).pidChain, null);
        assert.equal(h.state.sessions.get(id).editor, null);
      }
    });
  }
});
