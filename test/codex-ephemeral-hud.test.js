"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const createPermissionPresentationRefresh = require("../src/permission-presentation-refresh");
const { buildSessionSnapshot, buildSessionSnapshotEntry, sessionSnapshotSignature } = require("../src/state-session-snapshot");
const { getFocusableLocalHudSessionIds, isFocusableLocalHudSession } = require("../src/session-focus");
const raw = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const done = () => ({ agentId: "codex", rawSessionId: raw, codexClientEphemeral: true,
  codexOriginator: "Codex Desktop", sourcePid: 731, profileId: "local", state: "idle",
  updatedAt: 1234, recentEvents: [{ event: "Stop", at: 1234 }] });
const options = { sessionHudHideCompletedCodexEphemeral: true, focusHostPlatform: "win32", readCodexThreadName: () => null };

it("active temporary chats collapse only with their independent strict opt-in and restore without mutation", () => {
  for (const state of ["thinking", "working"]) {
    const session = { ...done(), state, recentEvents: [{ event: state === "thinking" ? "UserPromptSubmit" : "PreToolUse" }] };
    const sessions = new Map([[raw, session]]), original = JSON.stringify([...sessions]);
    const activeOptions = { ...options, sessionHudHideCompletedCodexEphemeral: false, sessionHudHideActiveCodexEphemeral: true };
    const hidden = buildSessionSnapshot(sessions, activeOptions);
    const visible = buildSessionSnapshot(sessions, { ...activeOptions, sessionHudHideActiveCodexEphemeral: false });
    assert.equal(hidden.hudTotalNonIdle, 0); assert.equal(hidden.sessions.length, 1);
    assert.equal(hidden.sessions[0].hudHiddenByPreference, true);
    assert.equal(hidden.sessions[0].hiddenFromHud, false);
    assert.deepEqual(hidden.sessions[0].focusTarget, visible.sessions[0].focusTarget);
    assert.notEqual(sessionSnapshotSignature(hidden), sessionSnapshotSignature(visible));
    for (const value of [undefined, false, "true", 1]) {
      assert.equal(buildSessionSnapshot(sessions, { ...activeOptions, sessionHudHideActiveCodexEphemeral: value }).hudTotalNonIdle, 1);
    }
    assert.equal(buildSessionSnapshot(sessions, options).hudTotalNonIdle, 1, "existing completion preference cannot hide activity");
    assert.equal(JSON.stringify([...sessions]), original);
  }
  assert.equal(buildSessionSnapshotEntry(raw, done(), {}, { sessionHudHideActiveCodexEphemeral: true }).hudHiddenByPreference, false);
});

it("active collapse requires typed local ephemeral identity and keeps pending decisions visible", () => {
  const activeOptions = { ...options, sessionHudHideActiveCodexEphemeral: true };
  const active = { ...done(), state: "thinking", recentEvents: [{ event: "UserPromptSubmit" }] };
  const protectedRows = [
    ...[undefined, false, "true"].map(codexClientEphemeral => ({ codexClientEphemeral })),
    { codexOriginator: "unknown-client" }, { codexOriginator: "codex-tui" },
    ...["cli", "exec", "mcp", "internal", "subagent", "agent-subagent"].map(codexSource => ({ codexSource })),
    { agentId: "workbuddy" }, { profileId: "remote" }, { host: "remote" }, { wslDistro: "Ubuntu" },
    ...["wsl", "WSL", " wSl "].map(platform => ({ platform })),
    { headless: true }, { subagentId: "child" }, { subagentType: "explorer" }, { recapIsSubagent: true },
    { transcriptPath: "/sessions/rollout-fixture.jsonl" }, { transcriptPath: 1 },
    ...["sweeping", "notification", "sleeping", "idle"].map(state => ({ state, recentEvents: [] })),
    ...["PermissionRequest", "CodexUserInputRequest", "Elicitation"].map(event => ({ recentEvents: [{ event }] })),
  ];
  for (const overrides of protectedRows) {
    assert.equal(buildSessionSnapshotEntry(raw, { ...active, ...overrides }, {}, activeOptions).hudHiddenByPreference, false, JSON.stringify(overrides));
  }
  const pendingPermissionSessionIds = new Set([raw]);
  assert.equal(buildSessionSnapshotEntry(raw, active, {}, { ...activeOptions, pendingPermissionSessionIds }).hudHiddenByPreference, false);
  pendingPermissionSessionIds.clear();
  assert.equal(buildSessionSnapshotEntry(raw, active, {}, { ...activeOptions, pendingPermissionSessionIds }).hudHiddenByPreference, true);
  assert.equal(buildSessionSnapshotEntry(raw, { ...active, codexOriginator: null }, {}, activeOptions).hudHiddenByPreference, true, "typed Darwin ephemeral remains a display fact only");
});

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
    ...["cli", "exec", "mcp", "internal", "subagent", "agent-subagent"].map(codexSource => ({ codexOriginator: null, codexSource })),
    { codexOriginator: null, subagentId: "child" }, { codexOriginator: null, subagentType: "explorer" },
    { codexOriginator: null, recapIsSubagent: true },
    { agentId: "workbuddy" }, { host: "remote" }, { wslDistro: "Ubuntu" },
    ...["wsl", "WSL", " wSl "].map(platform => ({ platform })),
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

it("typed ephemeral completion without Darwin originator is sufficient only for the HUD display preference", () => {
  const session = { ...done(), codexOriginator: null, agentPid: 731, sourcePid: 732 };
  const snapshot = buildSessionSnapshot(new Map([[raw, session]]), { ...options, focusHostPlatform: "darwin" });
  assert.equal(snapshot.hudTotalNonIdle, 0);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].hudHiddenByPreference, true);
  assert.equal(snapshot.sessions[0].codexOriginator, null);
  assert.equal(snapshot.sessions[0].focusTarget.type, "codex-app");
  assert.equal(session.codexOriginator, null, "presentation cannot change canonical identity");
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
  assert.match(source, /onPermissionsChanged: refreshPermissionPresentation/);
  const tasks = [], calls = [];
  let state = { emitSessionSnapshot: () => calls.push("snapshot") };
  const changed = createPermissionPresentationRefresh({ getStateRuntime: () => state, schedule: cb => tasks.push(cb) });
  changed("added"); changed("removed");
  assert.equal(tasks.length, 1); assert.deepEqual(calls, []);
  tasks.shift()(); assert.deepEqual(calls, ["snapshot"]);
  state = { refreshCodexPendingAttention: () => calls.push("presentation"),
    emitSessionSnapshot: () => { throw new Error("presentation method owns its snapshot"); } };
  changed("resolved"); tasks.shift()(); assert.deepEqual(calls, ["snapshot", "presentation"]);
});

it("permission presentation refresh tolerates disposal and can recover from a failed refresh", () => {
  const tasks = [], errors = []; let disposed = false, fail = true, refreshed = 0;
  const changed = createPermissionPresentationRefresh({ schedule: cb => tasks.push(cb), isDisposed: () => disposed,
    getStateRuntime: () => ({ emitSessionSnapshot() { if (fail) throw new Error("fixture failure"); refreshed++; } }),
    onError: error => errors.push(error.message) });
  changed(); tasks.shift()(); assert.deepEqual(errors, ["fixture failure"]);
  fail = false; changed(); tasks.shift()(); assert.equal(refreshed, 1);
  changed(); disposed = true; tasks.shift()(); assert.equal(refreshed, 1);
});
