"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const createState = require("../src/state");
const createRuntime = require("../src/agent-runtime-main");
const Monitor = require("../agents/codex-log-monitor");
const agent = require("../agents/codex");
const themeLoader = require("../src/theme-loader");
const { makeSessionKey } = require("../src/session-key");

function fixture(t, showCard = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-input-fence-"));
  themeLoader.init(path.join(__dirname, "../src"));
  const theme = JSON.parse(JSON.stringify(themeLoader.loadTheme("clawd")));
  theme.timings.minDisplay = {};
  theme.timings.autoReturn = {};
  const noop = () => {};
  const recorded = [];
  const state = createState({
    theme, lang: "en", doNotDisturb: false, miniMode: false,
    playSound: noop, sendToRenderer: noop, syncHitWin: noop, sendToHitWin: noop,
    miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop, buildTrayMenu: noop,
    pendingPermissions: [], resolvePermissionEntry: noop, dismissPermissionsForDnd: noop,
    focusTerminalWindow: noop, focusHostPlatform: "darwin", processKill: () => true,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }), t: key => key,
    recapSink: { record: event => recorded.push(event) },
  });
  class IsolatedMonitor extends Monitor { start() {} }
  const shown = [];
  const runtime = createRuntime({
    loadCodexLogMonitor: () => IsolatedMonitor,
    loadCodexAgent: () => ({ ...agent, logConfig: { ...agent.logConfig, sessionDir: root } }),
    getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args),
    isAgentEnabled: () => true,
    codexSubagentClassifier: { registerSession: () => "root", classify: () => "root", clear: noop },
    showCodexUserInputBubble: (...args) => { shown.push(args); return showCard; },
    clearCodexUserInputBubbles: noop,
  });
  const monitor = runtime.startCodexLogMonitor();
  monitor._codexDir = root;
  monitor._resolveTrackedAgentPid = () => null;
  const sid = "codex:synthetic-session";
  const key = makeSessionKey({ profileId: "local", rawSessionId: sid });
  const tracked = { sessionId: sid, cwd: root, isSubagent: false,
    lastState: "working", pendingUserInputs: new Map(), backfilling: false,
    initializingUserInputs: false, activeTurnId: "A", turnBoundaryOpen: true };
  const official = (event, turnId) => runtime.updateSessionFromServer(
    key, event === "Stop" ? "attention" : "working", event,
    { agentId: "codex", profileId: "local", rawSessionId: sid,
      hookSource: "codex-official", turnId, codexOriginator: "Codex Desktop" }
  );
  const line = (type, payload) => monitor._processLine(JSON.stringify({
    timestamp: new Date().toISOString(), type, payload,
  }), tracked);
  const question = (id = "question") => line("response_item", {
    type: "function_call", name: "request_user_input", call_id: id,
    arguments: JSON.stringify({ questions: [{ id: "q", header: "Choice", question: "Pick one",
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] }),
  });
  const answer = (id = "question") => line("response_item", {
    type: "function_call_output", call_id: id, output: "{}",
  });
  t.after(() => { runtime.cleanup(); state.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  return { state, runtime, tracked, key, official, line, question, answer, shown, recorded };
}

for (const showCard of [false, true]) {
test(`late question and answer cannot revive a closed turn (card shown: ${showCard})`, t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 3, 10) });
  const f = fixture(t, showCard);
  f.official("UserPromptSubmit", "A");
  f.official("Stop", "A");
  const count = f.recorded.length;
  assert.equal(f.state.sessions.get(f.key).state, "idle");
  const before = f.state.sessions.get(f.key).updatedAt;
  t.mock.timers.tick(60000);
  f.question();
  assert.equal(f.shown.length, 1, "passive UI recovery remains available");
  assert.equal(f.state.sessions.get(f.key).state, "idle");
  f.answer();
  f.line("event_msg", { type: "task_complete", turn_id: "A" });
  assert.equal(f.state.sessions.get(f.key).state, "idle");
  assert.equal(f.state.sessions.get(f.key).updatedAt, before);
  assert.equal(f.state.deriveSessionBadge(f.state.sessions.get(f.key)), "done");
  assert.equal(f.recorded.length, count, "passive UI does not count as accepted activity");
});

test(`new turn rejects old, replayed, or unidentified activity (card shown: ${showCard})`, t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 3, 10) });
  const f = fixture(t, showCard);
  f.official("UserPromptSubmit", "A");
  f.question("old");
  f.official("Stop", "A");
  f.official("UserPromptSubmit", "B");
  // Observe touches at the real state boundary: B is already working, so merely
  // asserting its state would miss an unauthorized extension of its lifetime.
  const before = f.state.sessions.get(f.key).updatedAt;
  t.mock.timers.tick(60000);
  const touches = [];
  const original = f.state.touchSessionActivity;
  f.state.touchSessionActivity = (...args) => { touches.push(args); return original(...args); };
  f.question("late-A");
  f.tracked.activeTurnId = "B";
  f.answer("old"); // Output must retain request A's identity despite monitor B.
  assert.equal(touches.length, 0);
  f.tracked.activeTurnId = null;
  f.tracked.turnBoundaryOpen = false;
  f.question("idless");
  f.answer("idless");
  assert.equal(touches.length, 0);
  f.tracked.activeTurnId = "B";
  f.tracked.turnBoundaryOpen = true;
  f.tracked.backfilling = true;
  f.question("replayed");
  f.answer("replayed");
  f.tracked.backfilling = false;
  assert.equal(touches.length, 0);
  assert.equal(f.state.sessions.get(f.key).updatedAt, before);
  f.question("live-B");
  f.answer("live-B");
  assert.equal(touches.length, 2, "live request and answer each refresh B");
  assert.equal(f.state.sessions.get(f.key).updatedAt, Date.now());
  f.line("event_msg", { type: "task_complete", turn_id: "B" });
  assert.equal(touches.length, 2, "terminal cleanup is not a liveness event");
});
}
