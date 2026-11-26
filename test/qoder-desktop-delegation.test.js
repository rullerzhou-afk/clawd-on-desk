"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const { readQoderDesktopSession } = require("../src/qoder-desktop-sessions");
const { createQoderSessionTitleTracker } = require("../src/qoder-session-title");
const { isSessionInProgress } = require("../src/state-session-snapshot");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: CHILD_TTL_MS } = require("../src/state-stale-cleanup");
const { resolveSessionIdentity } = require("../src/session-key");

const sessionKey = (raw) => resolveSessionIdentity(`qoder:${raw}`, "local").sessionId;
const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = sessionKey(PARENT);
const CHILD_ID = sessionKey(CHILD);
const POLL_MS = 2000;
const LIVE_PARENT_PID = 12346;
const DELEGATION = JSON.stringify({ delegationParent: { sessionId: ` qoder:${PARENT} ` } });

themeLoader.init(path.join(__dirname, "..", "src"));
const integrationTheme = themeLoader.loadTheme("clawd");

function createIntegration(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_800_000_000_000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-desktop-"));
  const db = new DatabaseSync(path.join(dir, "main.sqlite"));
  db.exec("CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, extra_json TEXT NOT NULL DEFAULT '{}', "
    + "archived INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE chat_session_context_usage (session_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL)");
  const put = db.prepare("INSERT OR REPLACE INTO chat_sessions "
    + "(session_id, title, extra_json, archived, deleted_at) VALUES (?, ?, ?, ?, ?)");
  const putRow = (raw, { title = null, extra = "{}", archived = 0, deletedAt = null } = {}) =>
    put.run(raw, title, extra, archived, deletedAt);
  const putUsage = db.prepare("INSERT OR REPLACE INTO chat_session_context_usage VALUES (?, ?)");
  putRow(PARENT, { title: "父任务" });
  putRow(CHILD, { title: "子会话", extra: DELEGATION });
  const sounds = [];
  const publications = [];
  const reads = [];
  let runtime;
  const state = initState({
    lang: "en",
    theme: integrationTheme,
    doNotDisturb: false,
    mouseStillSince: Date.now(),
    playSound: (sound) => sounds.push(sound),
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    processKill(pid) {
      if (pid === LIVE_PARENT_PID) return;
      const error = new Error("dead");
      error.code = "ESRCH";
      throw error;
    },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getSessionAliases: () => ({}),
    getStaleConfig: () => ({ sessionStaleMs: options.sessionStaleMs ?? 0, workingStaleMs: 0 }),
    broadcastSessionSnapshot: (snapshot) => publications.push(snapshot),
    onSessionDeleted: options.onSessionDeleted,
    isQoderDesktopSession: (session) => runtime?.isQoderDesktopSession?.(session) === true,
  });
  runtime = createAgentRuntimeMain({
    codexSubagentClassifier: {},
    updateSession: state.updateSession,
    getStateRuntime: () => state,
    now: Date.now,
    qoderSessionTitleTracker: options.qoderSessionTitleTracker,
    qoderDesktopTrackerOptions: {
      now: Date.now,
      pollMs: POLL_MS,
      readerOptions: {
        dataDirs: [dir],
        readSession(input, readerOptions) {
          reads.push(input.rawSessionId);
          return readQoderDesktopSession(input, readerOptions);
        },
      },
    },
  });
  const post = (raw, event, hookState, extra = {}) =>
    runtime.updateSessionFromServer(sessionKey(raw), hookState, event, {
      agentId: "qoder",
      profileId: "local",
      rawSessionId: `qoder:${raw}`,
      cwd: "C:/fixture",
      ...extra,
    });
  t.after(() => {
    state.cleanup();
    runtime.cleanup();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, state, runtime, tracker: runtime.getQoderDesktopTitleTracker(),
    post, putRow, putUsage: (raw, percentage) => putUsage.run(raw, JSON.stringify({ percentage })),
    deleteRow: (raw) => db.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(raw),
    sounds, reads, publications,
    advance: (ms) => t.mock.timers.setTime(Date.now() + ms),
    tick: (ms) => t.mock.timers.tick(ms),
    parent: () => publications.at(-1)?.sessions.find((row) => row.id === PARENT_ID),
  };
}

function startDelegatedWork(h) {
  h.post(PARENT, "SessionStart", "idle");
  h.post(CHILD, "PreToolUse", "working");
  assert.equal(h.parent().activeSubagentCount, 1);
}

describe("Qoder desktop delegation gate", () => {
  it("queries once on the cold tool event and applies a fresh resume title immediately", (t) => {
    const h = createIntegration(t);
    h.post(PARENT, "PreToolUse", "working");
    assert.deepEqual(h.reads, [PARENT]);
    assert.equal(h.parent().sessionTitle, "父任务");

    h.post(PARENT, "Stop", "attention");
    assert.equal(h.parent().state, "idle");
    const beforeResume = h.reads.length;
    h.putRow(PARENT, { title: "Resumed title" });
    h.post(PARENT, "SessionStart", "idle");
    assert.deepEqual(h.reads.slice(beforeResume), [PARENT]);
    assert.equal(h.parent().sessionTitle, "Resumed title");
  });

  it("caches confirmed delegation across windows, including discoveries by poll, until Qoder is cleared", async (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    h.advance(POLL_MS + 1);
    h.post(CHILD, "Stop", "attention");
    assert.deepEqual(h.reads, [PARENT, CHILD]);
    assert.equal(h.parent().activeSubagentCount, 0);
    assert.equal(h.state.sessions.has(CHILD_ID), false);

    const late = "late-child";
    h.putRow(late);
    h.post(late, "PreToolUse", "working");
    h.putRow(late, { extra: DELEGATION });
    h.advance(POLL_MS + 1);
    await h.tracker.poll();
    assert.equal(h.state.sessions.has(sessionKey(late)), false);
    h.advance(POLL_MS + 1);
    const before = h.reads.length;
    h.post(late, "Notification", "notification");
    assert.equal(h.reads.length, before);
    assert.deepEqual(h.sounds, []);

    h.runtime.clearSessionsByAgent("qoder");
    h.post(late, "Notification", "notification");
    assert.deepEqual(h.reads.slice(before), [late]);
    assert.equal(h.state.sessions.has(sessionKey(late)), false);
  });

  it("keeps confirmed delegation on a failed resume read and revokes it on an ordinary row", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    h.post(CHILD, "Stop", "attention");
    assert.equal(h.parent().activeSubagentCount, 0);

    h.deleteRow(CHILD);
    h.advance(POLL_MS);
    h.post(CHILD, "SessionStart", "idle");
    assert.deepEqual(h.reads, [PARENT, CHILD, CHILD]);
    assert.equal(h.state.sessions.has(CHILD_ID), false);

    h.putRow(CHILD, { title: "Ordinary session" });
    h.post(CHILD, "SessionStart", "idle");
    assert.equal(h.state.sessions.get(CHILD_ID)?.sessionTitle, "Ordinary session");
    h.post(CHILD, "PreToolUse", "working");
    assert.equal(h.state.sessions.get(CHILD_ID)?.state, "working");
    assert.equal(h.parent().activeSubagentCount, 0);
    assert.deepEqual(h.reads, [PARENT, CHILD, CHILD, CHILD]);
  });

  for (const [event, state] of [["Stop", "attention"], ["Notification", "notification"]]) {
    for (const [lifecycle, fields] of [["archived", { archived: 1 }], ["deleted", { deletedAt: 1 }]]) {
      it(`keeps ${lifecycle} metadata on a failed ${event} recheck until the original window expires`, (t) => {
        const h = createIntegration(t);
        h.putRow(CHILD, fields);
        h.post(CHILD, "PreToolUse", "working");
        assert.equal(h.state.sessions.has(CHILD_ID), false);
        h.deleteRow(CHILD);

        h.advance(1000);
        h.post(CHILD, event, state);
        h.tick(999);
        assert.deepEqual(h.reads, [CHILD, CHILD]);
        assert.equal(h.state.sessions.has(CHILD_ID), false);
        assert.deepEqual(h.sounds, []);
        assert.ok(!h.publications.some(({ sessions }) => sessions.some((row) => row.id === CHILD_ID && row.badge === "done")));

        h.advance(1);
        h.post(CHILD, event, state);
        h.tick(1000);
        assert.deepEqual(h.reads, [CHILD, CHILD, CHILD]);
        assert.equal(h.state.sessions.has(CHILD_ID), true);
        assert.deepEqual(h.sounds, [event === "Stop" ? "complete" : "confirm"]);
        if (event === "Stop") assert.equal(h.publications.at(-1).sessions[0].badge, "done");
      });
    }

    for (const cached of ["missing", "ordinary"]) {
      it(`rechecks ${cached} metadata before ${event} cues`, (t) => {
        const h = createIntegration(t);
        if (cached === "missing") h.deleteRow(CHILD);
        else h.putRow(CHILD);
        h.post(CHILD, "PreToolUse", "working");
        assert.equal(h.state.sessions.has(CHILD_ID), true);
        h.putRow(CHILD, { extra: DELEGATION });
        h.post(CHILD, event, state);
        h.tick(3000);
        assert.equal(h.state.sessions.has(CHILD_ID), false);
        assert.deepEqual(h.reads, [CHILD, CHILD]);
        assert.deepEqual(h.sounds, []);
        assert.notEqual(h.state.getCurrentState(), "attention");
        assert.ok(!h.publications.some(({ sessions }) => sessions.some((row) => row.id === CHILD_ID && row.badge === "done")));
      });
    }

    it(`allows ${event} when the forced read still has no delegation evidence`, (t) => {
      const h = createIntegration(t);
      h.deleteRow(CHILD);
      h.post(CHILD, "PreToolUse", "working");
      h.post(CHILD, event, state);
      h.tick(1000);
      assert.deepEqual(h.reads, [CHILD, CHILD]);
      assert.equal(h.state.sessions.has(CHILD_ID), true);
      assert.deepEqual(h.sounds, [event === "Stop" ? "complete" : "confirm"]);
    });
  }

  for (const source of ["hook", "poll"]) {
    it(`invalidates a pending JSONL title after ${source} retirement`, async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const finished = Promise.withResolvers();
      const qoderSessionTitleTracker = createQoderSessionTitleTracker({
        fs: {
          async open(...args) {
            entered.resolve();
            await release.promise;
            return fs.promises.open(...args);
          },
        },
        onScan: finished.resolve,
      });
      const h = createIntegration(t, { qoderSessionTitleTracker });
      const transcriptPath = path.join(h.dir, "session.jsonl");
      fs.writeFileSync(transcriptPath, JSON.stringify({
        type: "custom-title", sessionId: PARENT, customTitle: "Old JSONL title",
      }) + "\n");
      h.post(PARENT, "SessionStart", "idle", { transcriptPath });
      await entered.promise;
      try {
        h.putRow(PARENT, { archived: 1 });
        if (source === "hook") {
          h.advance(POLL_MS);
          h.post(PARENT, "PreToolUse", "working", { transcriptPath });
        } else {
          h.advance(10_000);
          await h.tracker.poll();
        }
        assert.equal(h.state.sessions.has(PARENT_ID), false);

        h.putRow(PARENT, { title: "Fresh SQLite title" });
        h.advance(POLL_MS);
        h.post(PARENT, "PreToolUse", "working", { transcriptPath });
        assert.equal(h.parent().sessionTitle, "Fresh SQLite title");
      } finally {
        release.resolve();
        await finished.promise;
      }
      await new Promise(setImmediate);
      assert.equal(h.parent().sessionTitle, "Fresh SQLite title");
    });
  }

  for (const sample of [
    { name: "working", event: "PreToolUse", state: "working", projects: true },
    { name: "thinking", event: "UserPromptSubmit", state: "thinking", projects: true },
    { name: "idle", event: "SessionStart", state: "idle" },
    { name: "stopped", event: "Stop", state: "attention" },
    { name: "archived", event: "PreToolUse", state: "working", archived: 1 },
    { name: "deleted", event: "PreToolUse", state: "working", deletedAt: 1 },
  ]) {
    it(`poll retires a late-discovered ${sample.name} child and publishes the parent count`, async (t) => {
      const h = createIntegration(t);
      h.post(PARENT, "SessionStart", "idle");
      h.putRow(CHILD);
      h.post(CHILD, sample.event, sample.state);
      const child = h.state.sessions.get(CHILD_ID);
      assert.ok(child);
      const childUpdatedAt = child.updatedAt;
      h.putRow(CHILD, { ...sample, extra: DELEGATION });
      h.advance(10_001);
      await h.tracker.poll();
      assert.equal(h.state.sessions.has(CHILD_ID), false);
      assert.equal(h.parent().activeSubagentCount, sample.projects ? 1 : 0);
      assert.ok(h.publications.at(-1).sessions.every((row) => row.id !== CHILD_ID));
      if (sample.projects) {
        h.advance(childUpdatedAt + CHILD_TTL_MS + 1 - Date.now());
        h.state.cleanStaleSessions();
        assert.equal(h.parent().activeSubagentCount, 0, "TTL starts at the child's last hook");
      }
    });
  }

  for (const readFirst of [false, true]) {
    it(`expires the published projection ${readFirst ? "after a read-only prune" : "during stale cleanup"}`, (t) => {
      const h = createIntegration(t);
      startDelegatedWork(h);
      h.tick(1000);
      assert.equal(h.state.getCurrentState(), "juggling");
      h.advance(CHILD_TTL_MS);
      if (readFirst) assert.equal(h.state.hasActiveQoderSubagents(), false);
      assert.equal(h.parent().activeSubagentCount, 1);
      h.state.cleanStaleSessions();
      h.tick(1000);
      assert.equal(h.parent().activeSubagentCount, 0);
      assert.equal(h.parent().effectiveState, "idle");
      assert.equal(h.state.getCurrentState(), "idle");
    });
  }

  it("expires the published projection without replacing a Settings preview", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    h.advance(CHILD_TTL_MS + 1);
    h.state.applyState("working", null, { settingsPreview: true });
    h.state.cleanStaleSessions();
    assert.equal(h.parent().activeSubagentCount, 0);
    assert.equal(h.state.isSettingsPreviewVisual(), true);
  });

  it("ends the parent projection before deletion observers and publishes once", (t) => {
    let observedChildActivity;
    let priorRow;
    const h = createIntegration(t, {
      onSessionDeleted(id) {
        if (id !== PARENT_ID) return;
        // A synchronous observer sees no old ledger even if this key is rebound.
        h.state.sessions.set(id, priorRow);
        observedChildActivity = h.state.hasActiveQoderSubagents();
        h.state.sessions.delete(id);
      },
    });
    startDelegatedWork(h);
    priorRow = h.state.sessions.get(PARENT_ID);
    const before = h.publications.length;

    h.post(PARENT, "SessionEnd", "sleeping");
    h.tick(1000);
    assert.equal(observedChildActivity, false);
    assert.equal(h.publications.length, before + 1);
    assert.deepEqual(h.publications.at(-1).sessions, []);
    assert.equal(h.state.getCurrentState(), "idle");
  });

  it("stopping Codex leaves Qoder active, then clearing Qoder resets trackers and publishes once", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    assert.equal(h.tracker.size(), 1);
    h.tick(1900);
    const before = h.publications.length;
    h.runtime.stopMonitorForAgent("codex");
    assert.equal(h.publications.length, before);
    assert.equal(h.parent().activeSubagentCount, 1);
    assert.equal(h.state.getCurrentState(), "juggling");

    assert.equal(h.runtime.clearSessionsByAgent("qoder"), 1);
    assert.equal(h.tracker.size(), 0);
    assert.equal(h.state.hasActiveQoderSubagents(), false);
    assert.equal(h.publications.length, before + 1);
    assert.deepEqual(h.publications.at(-1).sessions, []);
    assert.equal(h.state.getCurrentState(), "idle");

    h.putRow(CHILD);
    h.post(CHILD, "PreToolUse", "working");
    assert.equal(h.reads.at(-1), CHILD);
    assert.equal(h.state.sessions.has(CHILD_ID), true);
  });

  it("clears orphaned Qoder activity without publishing when no rows were removed", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    const parent = h.state.sessions.get(PARENT_ID);
    h.state.sessions.delete(PARENT_ID);
    const before = h.publications.length;

    assert.equal(h.runtime.clearSessionsByAgent("qoder"), 0);
    assert.equal(h.publications.length, before);
    h.state.sessions.set(PARENT_ID, parent);
    assert.equal(h.state.hasActiveQoderSubagents(), false);
  });

  it("shutdown clears Qoder trackers and projection without broadcasting", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    const before = h.publications.length;
    h.state.cleanup();
    h.runtime.cleanup();
    assert.equal(h.publications.length, before);
    assert.equal(h.state.hasActiveQoderSubagents(), false);
    assert.equal(h.tracker.size(), 0);
  });

  for (const [reason, agentPid] of [["unreachable", null], ["no-source", LIVE_PARENT_PID]]) {
    it(`keeps awake past the parent's own Stop and idle age (${reason}) until its child stops`, (t) => {
      const h = createIntegration(t, { sessionStaleMs: 1000 });
      h.post(PARENT, "PreToolUse", "working", { agentPid });
      h.post(CHILD, "PreToolUse", "working");
      const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
      const start = main.indexOf("function anySessionInProgress()");
      const end = main.indexOf("function reconcilePowerSaveBlocker()", start);
      assert.ok(start >= 0 && end > start);
      const inProgress = vm.runInNewContext(`${main.slice(start, end)}\nanySessionInProgress`, {
        _state: h.state, sessions: h.state.sessions, isSessionInProgress,
      });

      h.tick(1900);
      h.post(PARENT, "Stop", "attention");
      h.tick(1500);
      assert.equal(h.parent().state, "idle");
      assert.equal(h.parent().badge, "done");
      assert.deepEqual(h.sounds, ["complete"]);
      assert.equal(h.state.hasActiveQoderSubagents(), true);
      assert.equal(inProgress(), true);

      h.advance(10_000);
      h.post(CHILD, "PostToolUse", "working");
      const parent = h.state.sessions.get(PARENT_ID);
      assert.equal(parent.agentPid, agentPid);
      assert.equal(parent.sourcePid, null);
      assert.equal(parent.pidReachable, agentPid !== null);
      assert.ok(Date.now() - parent.updatedAt > 1000);
      h.state.cleanStaleSessions();
      assert.equal(h.state.sessions.get(PARENT_ID)?.state, "idle");
      assert.equal(h.parent().badge, "done");
      assert.equal(inProgress(), true);

      h.post(CHILD, "Stop", "attention");
      assert.equal(h.parent().activeSubagentCount, 0);
      assert.equal(h.state.hasActiveQoderSubagents(), false);
      assert.equal(inProgress(), false);
      h.tick(5000);
      assert.deepEqual(h.sounds, ["complete"]);
    });
  }

  for (const childEnd of ["stops", "expires"]) {
    it(`PR #1419: keeps an idle desktop parent with live PIDs until its delegated child ${childEnd}`, (t) => {
      const h = createIntegration(t, { sessionStaleMs: 1000 });
      const processMetadata = { agentPid: LIVE_PARENT_PID, sourcePid: LIVE_PARENT_PID };
      h.post(PARENT, "SessionStart", "idle", processMetadata);
      h.post(CHILD, "PreToolUse", "working");
      h.post(PARENT, "Stop", "attention", processMetadata);
      h.advance(1001);

      const parent = h.state.sessions.get(PARENT_ID);
      assert.equal(parent.state, "idle");
      assert.equal(parent.pidReachable, true);
      assert.equal(h.state.hasActiveQoderSubagents(), true);
      h.state.cleanStaleSessions();
      assert.equal(h.state.sessions.get(PARENT_ID), parent);

      if (childEnd === "stops") h.post(CHILD, "Stop", "attention");
      else h.advance(CHILD_TTL_MS);
      h.state.cleanStaleSessions();
      assert.equal(h.state.sessions.has(PARENT_ID), false);
    });
  }

  it("PR #1419: times out only the idle Qoder session found in SQLite when both PIDs are live", (t) => {
    const deleted = [];
    const h = createIntegration(t, {
      sessionStaleMs: 1000,
      onSessionDeleted: (id, reason) => deleted.push({ id, reason }),
    });
    const cli = "terminal-session";
    const processMetadata = { agentPid: LIVE_PARENT_PID, sourcePid: LIVE_PARENT_PID };
    for (const raw of [PARENT, cli]) {
      h.post(raw, "SessionStart", "idle", processMetadata);
      h.post(raw, "Stop", "attention", processMetadata);
      const session = h.state.sessions.get(sessionKey(raw));
      assert.equal(session.state, "idle");
      assert.equal(session.pidReachable, true);
    }

    h.advance(1001);
    h.state.cleanStaleSessions();
    assert.deepEqual(deleted, [{ id: PARENT_ID, reason: "stale-delete-qoder-desktop-idle-timeout" }]);
    assert.deepEqual([...h.state.sessions.keys()], [sessionKey(cli)]);
  });

  it("PR #1419: still times out a desktop session rebuilt by an ordinary hook inside the cache window", async (t) => {
    const deleted = [];
    const h = createIntegration(t, {
      sessionStaleMs: 1000,
      onSessionDeleted: (id, reason) => deleted.push({ id, reason }),
    });
    const processMetadata = { agentPid: LIVE_PARENT_PID, sourcePid: LIVE_PARENT_PID };
    h.post(PARENT, "SessionStart", "idle", processMetadata);
    h.post(PARENT, "Stop", "attention", processMetadata);
    h.advance(1001);
    h.state.cleanStaleSessions();
    assert.equal(h.state.sessions.has(PARENT_ID), false);

    // The tracker reaps the old entry, and a fresh read cannot rediscover the row.
    await h.tracker.poll();
    assert.equal(h.tracker.size(), 0);
    h.deleteRow(PARENT);
    const readsBefore = h.reads.length;
    h.post(PARENT, "PreToolUse", "working", processMetadata);
    assert.equal(h.state.sessions.get(PARENT_ID)?.state, "working");
    assert.equal(h.reads.length, readsBefore);
    h.post(PARENT, "Stop", "attention", processMetadata);
    assert.equal(h.state.sessions.get(PARENT_ID)?.state, "idle");

    h.advance(1001);
    h.state.cleanStaleSessions();
    assert.equal(h.state.sessions.has(PARENT_ID), false);
    assert.deepEqual(deleted, [
      { id: PARENT_ID, reason: "stale-delete-qoder-desktop-idle-timeout" },
      { id: PARENT_ID, reason: "stale-delete-qoder-desktop-idle-timeout" },
    ]);
  });

  it("still retires a parent whose process exited while its child is active", (t) => {
    const h = createIntegration(t);
    startDelegatedWork(h);
    Object.assign(h.state.sessions.get(PARENT_ID), { pidReachable: true, agentPid: 12345 });
    h.state.cleanStaleSessions();
    assert.equal(h.state.sessions.has(PARENT_ID), false);
    assert.equal(h.state.hasActiveQoderSubagents(), false);
  });

  it("skips WSL events, existing WSL rows and the WSL rows in startup sweep", async (t) => {
    const h = createIntegration(t);
    h.post(PARENT, "SessionStart", "idle", { platform: "wsl" });
    h.post(CHILD, "PreToolUse", "working", { platform: "wsl" });
    h.post(PARENT, "PreToolUse", "working");
    h.post(CHILD, "PreToolUse", "working");
    h.runtime.sweepQoderDesktopSessions();
    h.advance(10_001);
    await h.tracker.poll();
    assert.deepEqual(h.reads, []);
    assert.equal(h.tracker.size(), 0);
    assert.ok(h.state.sessions.has(CHILD_ID));
    assert.equal(h.state.updateQoderSubagentActivity(PARENT_ID, { childId: CHILD, phase: "activity" }), false);
    assert.notEqual(h.state.resolveDisplayState(), "juggling");
  });

  it("startup sweep immediately reconciles rows never registered by the tracker", (t) => {
    const h = createIntegration(t);
    for (const raw of [PARENT, CHILD]) {
      h.state.updateSession(sessionKey(raw), "working", "PreToolUse", {
        agentId: "qoder", rawSessionId: `qoder:${raw}`,
      });
    }
    assert.equal(h.tracker.size(), 0);
    assert.deepEqual(h.reads, []);
    h.runtime.sweepQoderDesktopSessions();
    assert.deepEqual(h.reads, [PARENT, CHILD]);
    assert.equal(h.state.sessions.has(CHILD_ID), false);
    assert.equal(h.parent().sessionTitle, "父任务");
    assert.equal(h.parent().activeSubagentCount, 1);
  });

  it("PR #1419: startup sweep enables the idle timeout only for restored Qoder rows found in SQLite", (t) => {
    const deleted = [];
    const h = createIntegration(t, {
      sessionStaleMs: 1000,
      onSessionDeleted: (id, reason) => deleted.push({ id, reason }),
    });
    const cli = "terminal-session";
    for (const raw of [PARENT, cli]) {
      const id = sessionKey(raw);
      h.state.updateSession(id, "idle", null, {
        agentId: "qoder",
        rawSessionId: `qoder:${raw}`,
        agentPid: LIVE_PARENT_PID,
        sourcePid: LIVE_PARENT_PID,
      });
      assert.equal(h.state.sessions.get(id)?.state, "idle");
      assert.equal(h.state.sessions.get(id)?.pidReachable, true);
    }
    assert.equal(h.tracker.size(), 0);
    assert.deepEqual(h.reads, []);

    h.runtime.sweepQoderDesktopSessions();
    h.advance(1001);
    h.state.cleanStaleSessions();
    assert.deepEqual(deleted, [{ id: PARENT_ID, reason: "stale-delete-qoder-desktop-idle-timeout" }]);
    assert.deepEqual([...h.state.sessions.keys()], [sessionKey(cli)]);
  });

  it("accepts an external title first and later applies the DB title and usage", async (t) => {
    const h = createIntegration(t);
    h.putRow(PARENT);
    h.post(PARENT, "PreToolUse", "working", { sessionTitle: "External" });
    assert.equal(h.parent().sessionTitle, "External");
    h.putRow(PARENT, { title: "父任务" });
    h.putUsage(PARENT, 0.37);
    h.advance(POLL_MS);
    await h.tracker.poll();
    assert.equal(h.parent().sessionTitle, "父任务");
    assert.equal(h.parent().contextUsage.percent, 37);
  });

  for (const lifecycle of [{ archived: 1 }, { deletedAt: 1 }]) {
    it(`late working hooks cannot relight a ${lifecycle.archived ? "previously archived" : "deleted"} child`, (t) => {
      const h = createIntegration(t);
      startDelegatedWork(h);
      if (lifecycle.archived) {
        h.post(CHILD, "Stop", "attention");
        assert.equal(h.parent().activeSubagentCount, 0);
      }
      h.putRow(CHILD, { ...lifecycle, extra: DELEGATION });
      h.advance(lifecycle.archived ? 1 : POLL_MS + 1);
      h.post(CHILD, "PreToolUse", "working");
      assert.equal(h.state.sessions.has(CHILD_ID), false);
      assert.equal(h.parent().activeSubagentCount, 0);
      assert.deepEqual(h.reads, [PARENT, CHILD, CHILD]);
    });
  }

  it("rechecks the lifecycle for late work after Stop discovered the delegation", (t) => {
    const h = createIntegration(t);
    h.post(PARENT, "SessionStart", "idle");
    h.putRow(CHILD);
    h.post(CHILD, "PreToolUse", "working");
    h.putRow(CHILD, { extra: DELEGATION });
    h.post(CHILD, "Stop", "attention");
    assert.equal(h.state.sessions.has(CHILD_ID), false);
    assert.equal(h.parent().activeSubagentCount, 0);

    h.putRow(CHILD, { extra: DELEGATION, archived: 1 });
    h.post(CHILD, "PostToolUse", "working");
    assert.equal(h.state.sessions.has(CHILD_ID), false);
    assert.equal(h.parent().activeSubagentCount, 0);
    assert.deepEqual(h.reads, [PARENT, CHILD, CHILD, CHILD]);
  });

  it("strong parent states win over the juggling projection", (t) => {
    const h = createIntegration(t);
    h.post(PARENT, "UserPromptSubmit", "thinking");
    h.state.sessions.get(PARENT_ID).state = "notification";
    h.post(CHILD, "PreToolUse", "working");
    assert.equal(h.parent().activeSubagentCount, 1);
    assert.equal(h.state.resolveDisplayState(), "notification");
  });
});
