"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { buildSessionSnapshot, buildSessionSnapshotEntry, sessionSnapshotSignature } = require("../src/state-session-snapshot");
const { getFocusableLocalHudSessionIds, isFocusableLocalHudSession } = require("../src/session-focus");
const raw = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const done = () => ({ agentId: "codex", rawSessionId: raw, codexClientEphemeral: true,
  codexOriginator: "Codex Desktop", sourcePid: 731, profileId: "local", state: "idle",
  updatedAt: 1234, recentEvents: [{ event: "Stop", at: 1234 }] });
const options = { sessionHudHideCompletedCodexEphemeral: true, focusHostPlatform: "win32", readCodexThreadName: () => null };

it("the default preserves completed side chats and the opt-in only changes HUD projection", () => {
  const sessions = new Map([[raw, done()]]), original = JSON.stringify([...sessions]);
  const visible = buildSessionSnapshot(sessions, { ...options, sessionHudHideCompletedCodexEphemeral: false });
  const hidden = buildSessionSnapshot(sessions, options);
  assert.equal(visible.hudTotalNonIdle, 1); assert.equal(hidden.hudTotalNonIdle, 0);
  assert.equal(hidden.hudLastSessionId, null); assert.equal(hidden.hudLastTitle, null);
  assert.equal(hidden.sessions.length, 1); assert.deepEqual(hidden.orderedIds, [raw]);
  assert.equal(hidden.sessions[0].hiddenFromHud, false, "do not affect Telegram/Discord lifecycle predicates");
  assert.equal(hidden.sessions[0].hudHiddenByPreference, true);
  assert.deepEqual(hidden.sessions[0].focusTarget, visible.sessions[0].focusTarget, "Dashboard navigation remains available");
  assert.equal(isFocusableLocalHudSession(hidden.sessions[0], { osPlatform: "win32" }), true, "shared delivery predicate stays independent");
  assert.deepEqual(getFocusableLocalHudSessionIds(hidden, { osPlatform: "win32" }), []);
  assert.deepEqual(getFocusableLocalHudSessionIds({ sessions: [null, undefined, hidden.sessions[0]] }, { osPlatform: "win32" }), []);
  assert.notEqual(sessionSnapshotSignature(visible), sessionSnapshotSignature(hidden));
  const restored = buildSessionSnapshot(sessions, { ...options, sessionHudHideCompletedCodexEphemeral: false });
  assert.equal(restored.hudTotalNonIdle, 1); assert.equal(JSON.stringify([...sessions]), original);
});

it("busy, unknown, persisted, interrupted and nonlocal sessions cannot match the completed-ephemeral preference", () => {
  const protectedRows = [
    { state: "thinking" }, { state: "working" }, { state: "sweeping" }, { state: "notification" },
    { codexClientEphemeral: undefined }, { codexClientEphemeral: false }, { codexClientEphemeral: "true" },
    { codexOriginator: "codex-tui" }, { codexOriginator: "unknown-client" },
    { agentId: "workbuddy" }, { host: "remote" }, { wslDistro: "Ubuntu" }, { platform: "wsl" },
    { profileId: "other" }, { headless: true }, { transcriptPath: "/sessions/rollout-fixture.jsonl" },
    { transcriptPath: 1 }, { recentEvents: [] },
    { recentEvents: [{ event: "SessionStart" }] }, { recentEvents: [{ event: "Interrupt" }] },
    { recentEvents: [{ event: "StopFailure" }] },
    ...["Notification", "PermissionRequest", "CodexUserInputRequest", "Elicitation", "PostCompact"].map(event =>
      ({ requiresCompletionAck: true, recentEvents: [{ event: "Stop" }, { event }] })),
  ];
  for (const overrides of protectedRows) {
    const row = buildSessionSnapshotEntry(raw, { ...done(), ...overrides }, {}, options);
    assert.equal(row.hudHiddenByPreference, false, JSON.stringify(overrides));
  }
  for (const enabled of [undefined, false, "true", 1]) {
    assert.equal(buildSessionSnapshotEntry(raw, done(), {}, { ...options, sessionHudHideCompletedCodexEphemeral: enabled }).hudHiddenByPreference, false);
  }
});

it("pending native question/approval entries protect a completed row until the last matching prompt leaves", () => {
  const sessions = new Map([[raw, done()]]), pendingPermissionSessionIds = new Set([raw]);
  assert.equal(buildSessionSnapshot(sessions, { ...options, pendingPermissionSessionIds }).hudTotalNonIdle, 1);
  pendingPermissionSessionIds.clear();
  const hidden = buildSessionSnapshot(sessions, { ...options, pendingPermissionSessionIds });
  assert.equal(hidden.hudTotalNonIdle, 0); assert.equal(hidden.sessions[0].badge, "done");
  sessions.get(raw).state = "thinking";
  sessions.get(raw).recentEvents.push({ event: "UserPromptSubmit", at: 2345 });
  assert.equal(buildSessionSnapshot(sessions, options).hudTotalNonIdle, 1, "next activity restores the row immediately");
});

it("main permission changes coalesce a deferred snapshot refresh without resolving or cleaning sessions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const begin = source.indexOf("let codexEphemeralHudRefreshQueued = false;");
  const end = source.indexOf("  get win()", begin);
  assert.ok(begin >= 0 && end > begin);
  const tasks = [], calls = [];
  const context = { sessionHudHideCompletedCodexEphemeral: true, queueMicrotask: cb => tasks.push(cb),
    _state: { emitSessionSnapshot: () => calls.push("snapshot") }, console: { warn: () => calls.push("warning") } };
  vm.createContext(context);
  vm.runInContext(source.slice(begin, end) + "}; globalThis.changed = _permCtx.onPermissionsChanged;", context);
  context.changed("added"); context.changed("removed");
  assert.equal(tasks.length, 1); assert.deepEqual(calls, []);
  tasks.shift()(); assert.deepEqual(calls, ["snapshot"]);
  context.sessionHudHideCompletedCodexEphemeral = false; context.changed("added");
  assert.equal(tasks.length, 0);
});
