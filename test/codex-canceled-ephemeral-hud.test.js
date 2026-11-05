"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSessionSnapshot, buildSessionSnapshotEntry, shouldHideActiveCodexEphemeral,
  sessionSnapshotSignature,
} = require("../src/state-session-snapshot");
const { getFocusableLocalHudSessionIds } = require("../src/session-focus");

const id = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const options = { sessionHudHideCanceledCodexEphemeral: true,
  focusHostPlatform: "win32", readCodexThreadName: () => null };
const canceled = extra => ({ agentId: "codex", rawSessionId: id,
  profileId: "local", codexOriginator: "Codex Desktop", codexClientEphemeral: true,
  state: "idle", sourcePid: 731, updatedAt: 1234,
  recentEvents: [{ event: "UserPromptSubmit", at: 1000 }, { event: "Interrupt", at: 1234 }], ...extra });
const entry = (session, prefs = options) => buildSessionSnapshotEntry(id, session, {}, prefs);

it("canceled temporary chats remain visible by default and collapse only with the independent typed opt-in", () => {
  for (const enabled of [undefined, false, "true", 1, null]) {
    assert.equal(entry(canceled(), { ...options, sessionHudHideCanceledCodexEphemeral: enabled }).hudHiddenByPreference, false);
  }
  assert.equal(entry(canceled(), {
    sessionHudHideActiveCodexEphemeral: true, sessionHudHideCompletedCodexEphemeral: true,
  }).hudHiddenByPreference, false, "older completion/active preferences retain their existing contract");
  const hidden = entry(canceled());
  assert.equal(hidden.hudHiddenByPreference, true);
  assert.equal(hidden.badge, "idle", "cancellation must not become successful completion");
  assert.equal(hidden.lastEvent.rawEvent, "Interrupt");
});

it("the cancellation rule requires idle and the exact accepted Interrupt event", () => {
  for (const event of ["Stop", "event_msg:task_complete", "event_msg:turn_aborted", "SessionStart",
    "SessionEnd", "Notification", "CodexUserInputRequest", "Elicitation", "PermissionRequest",
    "StopFailure", "PostToolUseFailure", "ApiError", "PostCompact", undefined]) {
    assert.equal(entry(canceled({ recentEvents: event ? [{ event }] : [] })).hudHiddenByPreference, false, String(event));
  }
  for (const state of ["thinking", "working", "juggling", "notification", "error", "sweeping", "sleeping"]) {
    assert.equal(entry(canceled({ state })).hudHiddenByPreference, false, state);
  }
  assert.equal(entry(canceled({ recentEvents: [{ event: "Interrupt" }, { event: "UserPromptSubmit" }] })).hudHiddenByPreference, false,
    "stale interruption history cannot hide a fresh lifecycle");
});

it("unknown, persistent, child, remote and WSL sessions are not inferred temporary from a project or ID label", () => {
  const protectedRows = [
    ...[undefined, false, "true", 1].map(codexClientEphemeral => ({ codexClientEphemeral })),
    { agentId: "workbuddy" }, { codexOriginator: "codex-tui" }, { codexOriginator: "unknown-client" },
    ...["cli", "exec", "mcp", "internal", "subagent", "agent-subagent", " subagent "].map(codexSource => ({ codexSource })),
    { profileId: "remote" }, { host: "remote" }, { wslDistro: "Ubuntu" },
    ...["wsl", "WSL", " wSl "].map(platform => ({ platform })),
    { headless: true }, { subagentId: "child" }, { subagentType: "explorer" }, { recapIsSubagent: true },
    { transcriptPath: "C:/sessions/rollout-fixture.jsonl" }, { transcriptPath: 1 },
  ];
  for (const override of protectedRows) {
    assert.equal(entry(canceled({ sessionTitle: "分析 · fixture", cwd: "C:/project", ...override })).hudHiddenByPreference,
      false, JSON.stringify(override));
  }
  assert.equal(entry(canceled({ codexOriginator: null })).hudHiddenByPreference, true,
    "an existing typed Darwin temporary fact does not need a manufactured originator");
});

it("pending approval/native-question facts, completion acknowledgement and known children veto canceled hiding", () => {
  const pendingPermissionSessionIds = new Set([id]);
  assert.equal(entry(canceled(), { ...options, pendingPermissionSessionIds }).hudHiddenByPreference, false);
  pendingPermissionSessionIds.clear();
  assert.equal(entry(canceled(), { ...options, pendingPermissionSessionIds }).hudHiddenByPreference, true);
  for (const extra of [
    { requiresCompletionAck: true },
    { subagentTracker: { confirmedIds: new Set(["child"]), legacyFloor: false } },
    { subagentTracker: { confirmedIds: new Set(), legacyFloor: true } },
  ]) assert.equal(entry(canceled(extra)).hudHiddenByPreference, false);

  for (const presentation of [
    { activeSubagentCount: 1, effectiveState: "juggling" },
    { activeSubagentCount: 2, effectiveState: "juggling" },
    { pendingAttention: true, effectiveState: "notification" },
  ]) {
    const snapshot = buildSessionSnapshot(new Map([[id, canceled()]]), {
      ...options, getSessionPresentation: () => presentation,
    });
    assert.equal(snapshot.sessions[0].hudHiddenByPreference, false);
    assert.equal(snapshot.hudTotalNonIdle, 1, "the final verified presentation veto stays authoritative");
  }
});

it("canceled hiding changes only HUD projection and restores the retained row when disabled", () => {
  const session = canceled(), original = structuredClone(session), sessions = new Map([[id, session]]);
  const visible = buildSessionSnapshot(sessions, { ...options, sessionHudHideCanceledCodexEphemeral: false });
  const hidden = buildSessionSnapshot(sessions, options);
  assert.equal(visible.hudTotalNonIdle, 1); assert.equal(hidden.hudTotalNonIdle, 0);
  assert.equal(hidden.hudLastSessionId, null);
  assert.equal(hidden.sessions.length, 1); assert.deepEqual(hidden.orderedIds, [id]);
  assert.equal(hidden.sessions[0].hiddenFromHud, false);
  assert.deepEqual(hidden.sessions[0].focusTarget, visible.sessions[0].focusTarget, "Dashboard navigation keeps its existing contract");
  assert.deepEqual(getFocusableLocalHudSessionIds(hidden, { osPlatform: "win32" }), []);
  assert.notEqual(sessionSnapshotSignature(hidden), sessionSnapshotSignature(visible));
  assert.deepEqual(session, original); assert.equal(sessions.get(id), session);
  const restored = buildSessionSnapshot(sessions, { ...options, sessionHudHideCanceledCodexEphemeral: false });
  assert.equal(restored.hudTotalNonIdle, 1);
});

it("canceled-only preference never broadens the active-only pet predicate", () => {
  const allOptions = { ...options, sessionHudHideCompletedCodexEphemeral: true,
    sessionHudHideActiveCodexEphemeral: true };
  assert.equal(shouldHideActiveCodexEphemeral(id, canceled(), allOptions), false);
  assert.equal(shouldHideActiveCodexEphemeral(id, canceled({ state: "thinking",
    recentEvents: [{ event: "UserPromptSubmit" }] }), allOptions), true);
});
