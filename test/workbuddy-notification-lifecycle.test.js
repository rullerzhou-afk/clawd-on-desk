"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const { IGNORED_NOTIFICATION_TYPES } = require("../hooks/workbuddy-hook");
const { handleStatePost } = require("../src/server-route-state");
const initState = require("../src/state");
const { makeSessionKey } = require("../src/session-key");
const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");
const themeLoader = require("../src/theme-loader");

themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");
const HOOK = path.resolve(__dirname, "..", "hooks", "workbuddy-hook.js");
const RAW_ID = "workbuddy-notification-fixture";
const SID = makeSessionKey({ profileId: "local", rawSessionId: RAW_ID });

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for the real session transition");
}

function createFixture(t) {
  const harness = createSpawnedHookHarness({ prefix: "wb-notification-" });
  const sounds = [];
  const stateCtx = {
    lang: "en", theme, doNotDisturb: false, miniTransitioning: false,
    miniMode: false, mouseOverPet: false, idlePaused: false,
    mouseStillSince: Date.now(), pendingPermissions: [],
    playSound: (sound) => sounds.push(sound),
    sendToRenderer: () => {}, syncHitWin: () => {}, sendToHitWin: () => {},
    buildContextMenu: () => {}, buildTrayMenu: () => {},
    processKill: () => { throw Object.assign(new Error("fixture has no PID"), { code: "ESRCH" }); },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    isAgentNotificationHookEnabled: () => true,
  };
  const api = initState(stateCtx);
  t.after(() => { api.cleanup(); harness.cleanup(); });
  const ctx = {
    STATE_SVGS: Object.fromEntries(["idle", "thinking", "working", "attention", "notification", "sleeping", "sweeping"].map((state) => [state, "fixture.svg"])),
    pendingPermissions: [], sessions: api.sessions,
    isAgentEnabled: () => true,
    updateSession: api.updateSession,
    setState: () => {}, updateAccountQuota: () => {}, resolvePermissionEntry: () => {},
    permLog: () => {}, handleTestResult: () => {},
  };

  async function dispatch(hookName, fields = {}) {
    const ignored = hookName === "Notification" && IGNORED_NOTIFICATION_TYPES.has(fields.notification_type);
    const result = harness.run({
      script: HOOK,
      payload: { hook_event_name: hookName, session_id: RAW_ID, cwd: "/fixture/workbuddy", ...fields },
      httpContract: ignored ? "expect-none" : "expect-attempt",
      env: { CLAWD_REMOTE: "1", CLAWD_POST_RECORDER_SUCCEED: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}\n", "native WorkBuddy remains the decision owner");
    assert.equal(result.stderr, "");
    for (const attempt of result.attempts.filter((entry) => entry.method === "POST")) {
      assert.equal(attempt.path, "/state", "there must be no /permission request");
      assert.ok(attempt.body, "capture the shipped adapter's actual request bytes");
      const req = new EventEmitter();
      req.headers = {};
      const response = new Promise((resolve) => {
        const res = { writeHead(code) { this.status = code; }, end() { resolve(this.status); } };
        handleStatePost(req, res, {
          ctx, codexOfficialTurns: new Map(), shouldDropForDnd: () => false,
          createRequestHookRecorder: () => ({
            acceptedUnlessDnd() {}, droppedByDisabled() {}, droppedByDnd() {},
            droppedInvalidAgent() {}, droppedUnsupported() {},
          }),
        });
        req.emit("data", Buffer.from(attempt.body));
        req.emit("end");
      });
      assert.equal(await response, 200);
    }
  }
  return { harness, api, sounds, dispatch, snapshot: () => buildSessionSnapshotEntry(SID, api.sessions.get(SID)) };
}

describe("WorkBuddy native idle notifications", () => {
  it("answers idle_prompt locally without HTTP, runtime reads, or a process walk", (t) => {
    const { harness } = createFixture(t);
    for (const remote of [false, true]) {
      const result = harness.run({
        script: HOOK, httpContract: "expect-none", probeProcessSpawns: true,
        env: { CLAWD_RECORD_RUNTIME_READS: "1", ...(remote ? { CLAWD_REMOTE: "1" } : {}) },
        payload: { hook_event_name: "Notification", session_id: RAW_ID, notification_type: "idle_prompt" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");
      assert.equal(result.stderr, "");
      assert.deepEqual(result.attempts, []);
      assert.deepEqual(result.spawns, []);
    }
  });

  it("keeps a completed HUD row after the native 60-second idle reminder and starts the next turn", async (t) => {
    const f = createFixture(t);
    await f.dispatch("UserPromptSubmit");
    await f.dispatch("PreToolUse");
    await f.dispatch("PostToolUse");
    await f.dispatch("Stop");
    await waitFor(() => f.snapshot().badge === "done");
    assert.equal(f.snapshot().badge, "done");
    const before = { ...f.api.sessions.get(SID) };
    f.sounds.length = 0;
    await f.dispatch("Notification", { notification_type: "idle_prompt", message: "CodeBuddy is waiting for your input" });
    const after = f.api.sessions.get(SID);
    assert.equal(after.updatedAt, before.updatedAt, "the reminder must not count as new work");
    assert.deepEqual(after.recentEvents, before.recentEvents, "Stop must remain the completion boundary");
    assert.equal(f.snapshot().badge, "done");
    assert.equal(f.snapshot().lastEvent.rawEvent, "Stop", "HUD must not show the Notification/Waiting chip");
    assert.deepEqual(f.sounds, [], "there is no new wait alert");
    await f.dispatch("UserPromptSubmit");
    assert.equal(f.snapshot().badge, "running");
    assert.equal(f.snapshot().state, "thinking");
    assert.equal(f.snapshot().lastEvent.rawEvent, "UserPromptSubmit");
  });

  it("does not create an idle-reminder-only HUD row or settle an active turn", async (t) => {
    const f = createFixture(t);
    await f.dispatch("Notification", { notification_type: "idle_prompt" });
    assert.equal(f.api.sessions.size, 0);
    await f.dispatch("UserPromptSubmit");
    const before = { ...f.api.sessions.get(SID) };
    await f.dispatch("Notification", { notification_type: "idle_prompt" });
    assert.equal(f.snapshot().state, "thinking");
    assert.equal(f.api.sessions.get(SID).updatedAt, before.updatedAt);
    assert.deepEqual(f.api.sessions.get(SID).recentEvents, before.recentEvents);
  });

  it("issue #655: swallows a per-turn auth_success without settling a running turn or alerting", async (t) => {
    const f = createFixture(t);
    await f.dispatch("UserPromptSubmit");
    const before = { ...f.api.sessions.get(SID) };
    f.sounds.length = 0;
    await f.dispatch("Notification", { notification_type: "auth_success" });
    const after = f.api.sessions.get(SID);
    assert.equal(after.state, "thinking");
    assert.equal(after.updatedAt, before.updatedAt, "the login toast must not count as new work");
    assert.deepEqual(after.recentEvents, before.recentEvents, "UserPromptSubmit must remain the boundary");
    assert.deepEqual(f.sounds, [], "there is no new wait alert");
  });

  it("issue #655: does not create a HUD card from an auth_success before any session exists", async (t) => {
    const f = createFixture(t);
    await f.dispatch("Notification", { notification_type: "auth_success" });
    assert.equal(f.api.sessions.size, 0);
  });

  it("still forwards native permission, elicitation, needs-input, and legacy notifications", async (t) => {
    const f = createFixture(t);
    for (const notificationType of ["permission_prompt", "elicitation_dialog", "agent_needs_input", "future_type", undefined]) {
      await f.dispatch("Stop");
      f.sounds.length = 0;
      await f.dispatch("Notification", notificationType ? { notification_type: notificationType } : {});
      assert.equal(f.snapshot().lastEvent.rawEvent, "Notification", String(notificationType));
      assert.notEqual(f.snapshot().badge, "done", "a real input request must remain visible");
      if (notificationType === "permission_prompt") {
        // Positive control for the auth_success "no sound" assertions above:
        // a genuinely forwarded notification really does ring the pet. The
        // alert may queue behind the completed turn's attention min-display.
        await waitFor(() => f.sounds.includes("confirm"), 6000);
        assert.ok(f.sounds.includes("confirm"), "a real permission prompt still rings the pet");
      }
      await f.dispatch("UserPromptSubmit");
      assert.equal(f.snapshot().lastEvent.rawEvent, "UserPromptSubmit");
      assert.equal(f.snapshot().state, "thinking");
    }
  });
});
