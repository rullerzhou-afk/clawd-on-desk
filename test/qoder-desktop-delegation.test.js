"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const { createQoderDesktopTitleTracker } = require("../src/qoder-desktop-sessions");

themeLoader.init(path.join(__dirname, "..", "src"));
const integrationTheme = themeLoader.loadTheme("clawd");

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const ARCH = "33333333-3333-4333-8333-333333333333";

function withFixtureDb(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-desktop-"));
  const db = new DatabaseSync(path.join(dir, "main.sqlite"));
  db.exec("CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, extra_json TEXT NOT NULL DEFAULT '{}', "
    + "session_kind TEXT NOT NULL DEFAULT 'standard', owner_session_id TEXT, archived INTEGER NOT NULL DEFAULT 0, "
    + "deleted_at INTEGER)");
  const insert = db.prepare("INSERT INTO chat_sessions (session_id, title, extra_json) VALUES (?, ?, ?)");
  insert.run(PARENT, "父任务", "{}");
  insert.run(CHILD, "子会话", JSON.stringify({ delegationParent: { sessionId: PARENT } }));
  insert.run(ARCH, "归档会话", "{}");
  db.close();
  return { dir, dbPath: path.join(dir, "main.sqlite") };
}

function reopen(dbPath) {
  return new DatabaseSync(dbPath);
}

async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out: ${label}`);
}

function createIntegration(dataDirs) {
  const state = initState({
    lang: "en",
    theme: integrationTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    processKill: () => { const error = new Error("dead"); error.code = "ESRCH"; throw error; },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getSessionAliases: () => ({}),
  });
  const localQoder = (sessionId) => {
    const session = state.sessions.get(sessionId);
    return session && session.agentId === "qoder" && (session.profileId || "local") === "local"
      && !session.host && !session.wslDistro ? session : null;
  };
  const tracker = createQoderDesktopTitleTracker({
    pollMs: 40,
    readerOptions: { dataDirs },
    getSession: localQoder,
    onRetired: ({ sessionId }) => { state.dismissSession(sessionId); },
    updateTitle: (sessionId, title) => {
      state.updateSessionMetadata(sessionId, { sessionTitle: title, expectedAgentId: "qoder" });
    },
  });
  const runtime = createAgentRuntimeMain({
    codexSubagentClassifier: {},
    updateSession: state.updateSession,
    getStateRuntime: () => state,
    qoderDesktopTitleTracker: tracker,
    isAgentEnabled: () => true,
  });
  const post = (raw, event, hookState) => runtime.updateSessionFromServer(`qoder:${raw}`, hookState, event, {
    agent_id: undefined,
    agentId: "qoder",
    profileId: "local",
    rawSessionId: raw,
    cwd: "C:/fixture",
  });
  return {
    state, runtime, tracker, post,
    cleanup: () => { runtime.cleanup(); state.cleanup(); },
  };
}

describe("Qoder desktop delegation gate", () => {
  it("delegated child opens no card and projects working onto the parent", async () => {
    const { dir } = withFixtureDb();
    const integration = createIntegration([dir]);
    try {
      integration.post(PARENT, "UserPromptSubmit", "thinking");
      assert.strictEqual(integration.state.sessions.has(`qoder:${PARENT}`), true);
      await waitFor(() => integration.state.buildSessionSnapshot().sessions
        .some((s) => s.rawSessionId === PARENT && s.sessionTitle === "父任务"), "parent title");
      integration.post(PARENT, "Stop", "idle");
      assert.strictEqual(integration.state.sessions.get(`qoder:${PARENT}`).state, "idle");

      assert.strictEqual(integration.post(CHILD, "PreToolUse", "working"), false);
      assert.strictEqual(integration.state.sessions.has(`qoder:${CHILD}`), false);
      assert.strictEqual(integration.state.sessions.get(`qoder:${PARENT}`).state, "working");

      assert.strictEqual(integration.post(CHILD, "Stop", "attention"), false);
      assert.strictEqual(integration.state.sessions.has(`qoder:${CHILD}`), false);
    } finally { integration.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("a row opened before recognition is dismissed once the DB marks it archived", async () => {
    const { dir, dbPath } = withFixtureDb();
    const integration = createIntegration([dir]);
    try {
      integration.post(ARCH, "UserPromptSubmit", "thinking");
      assert.strictEqual(integration.state.sessions.has(`qoder:${ARCH}`), true);
      assert.strictEqual(integration.state.sessions.has(`qoder:${ARCH}`), true);
      const db = reopen(dbPath);
      db.prepare("UPDATE chat_sessions SET archived = 1 WHERE session_id = ?").run(ARCH);
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.strictEqual(integration.post(ARCH, "PreToolUse", "working"), false);
      assert.strictEqual(integration.state.sessions.has(`qoder:${ARCH}`), false);
    } finally { integration.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("sweep retires restored delegated rows and names surviving parents", async () => {
    const { dir, dbPath } = withFixtureDb();
    const integration = createIntegration([dir]);
    try {
      // Simulate a restored row created before the delegation was known.
      const db = reopen(dbPath);
      db.prepare("UPDATE chat_sessions SET extra_json = '{}' WHERE session_id = ?").run(CHILD);
      db.close();
      integration.post(CHILD, "UserPromptSubmit", "thinking");
      assert.strictEqual(integration.state.sessions.has(`qoder:${CHILD}`), true);
      const db2 = reopen(dbPath);
      db2.prepare("UPDATE chat_sessions SET extra_json = ? WHERE session_id = ?")
        .run(JSON.stringify({ delegationParent: { sessionId: PARENT } }), CHILD);
      db2.close();
      integration.post(PARENT, "UserPromptSubmit", "thinking");

      integration.runtime.sweepQoderDesktopSessions();
      await waitFor(() => !integration.state.sessions.has(`qoder:${CHILD}`), "child retired by sweep");
      await waitFor(() => integration.state.buildSessionSnapshot().sessions
        .some((s) => s.rawSessionId === PARENT && s.sessionTitle === "父任务"), "parent named by sweep");
    } finally { integration.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("an unreadable database never suppresses", async () => {
    const integration = createIntegration([]);
    try {
      integration.post(CHILD, "UserPromptSubmit", "thinking");
      assert.strictEqual(integration.state.sessions.has(`qoder:${CHILD}`), true);
    } finally { integration.cleanup(); }
  });
});