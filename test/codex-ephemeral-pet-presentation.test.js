"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const themeLoader = require("../src/theme-loader");
const initState = require("../src/state");
const { isSessionInProgress, buildSessionSnapshotEntry } = require("../src/state-session-snapshot");
const createSettingsEffectRouter = require("../src/settings-effect-router");
themeLoader.init(path.join(__dirname, "..", "src"));
const sid = "codex:aaaaaaaa-1111-4111-8111-111111111111";
const temporary = (extra = {}) => ({ agentId: "codex", codexClientEphemeral: true,
  codexOriginator: "Codex Desktop", profileId: "local", state: "thinking",
  updatedAt: Date.now(), recentEvents: [{ event: "UserPromptSubmit", at: Date.now() }], ...extra });

function harness(t, extra = {}) {
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.minDisplay = {};
  const ctx = { theme, lang: "en", pendingPermissions: [], sessionHudHideActiveCodexEphemeral: true,
    processKill() { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    playSound() {}, sendToRenderer() {}, sendToHitWin() {}, syncHitWin() {},
    t: key => key, buildContextMenu() {}, buildTrayMenu() {}, ...extra };
  const api = initState(ctx);
  t.after(() => api.cleanup());
  return { api, ctx };
}

test("strict hidden activity stops driving both pet phase and its SVG without retiring canonical work", t => {
  const { api, ctx } = harness(t);
  const row = temporary(); api.sessions.set(sid, row);
  assert.equal(api.resolveDisplayState(), "idle");
  assert.equal(isSessionInProgress(api.sessions.get(sid)), true, "OS keep-awake still reads canonical work");
  const projected = api.getPetPresentationSessions();
  assert.equal(projected.size, 0); assert.equal(api.sessions.get(sid), row);
  ctx.sessionHudHideActiveCodexEphemeral = false;
  assert.equal(api.getPetPresentationSessions(), api.sessions);
  assert.equal(api.resolveDisplayState(), "thinking");
  const visibleThinkingSvg = api.getSvgOverride("thinking");
  ctx.sessionHudHideActiveCodexEphemeral = true;
  assert.notEqual(api.getSvgOverride("idle"), visibleThinkingSvg);
  api.sessions.set("workbuddy:real", { state: "working", agentId: "workbuddy", updatedAt: Date.now() });
  assert.equal(api.resolveDisplayState(), "working");
});

test("pending decisions, completion acknowledgement, errors and known child overlays veto strict hiding", t => {
  const { api, ctx } = harness(t);
  const protectedRows = [
    { requiresCompletionAck: true }, { transcriptPath: "C:/sessions/rollout.jsonl" },
    { subagentTracker: { confirmedIds: new Set(["real-child"]) } },
    { state: "juggling", subagentTracker: { confirmedIds: new Set(["a", "b"]) } },
    ...["PermissionRequest", "CodexUserInputRequest", "Elicitation", "Notification", "StopFailure", "PostToolUseFailure", "ApiError", "Interrupt"].map(event => ({ recentEvents: [{ event }] })),
  ];
  for (const extra of protectedRows) {
    const row = temporary(extra), source = new Map([[sid, row]]);
    assert.equal(api.getPetPresentationSessions(source), source, JSON.stringify(extra));
    assert.equal(buildSessionSnapshotEntry(sid, row, {}, { sessionHudHideActiveCodexEphemeral: true }).hudHiddenByPreference, false);
  }
  const source = new Map([[sid, temporary()]]);
  ctx.pendingPermissions.push({ sessionId: sid });
  assert.equal(api.getPetPresentationSessions(source), source);
  ctx.pendingPermissions.length = 0;
  assert.equal(api.getPetPresentationSessions(source).size, 0);
});

test("hidden temporary workers cannot inflate the real worker's animation tier", t => {
  const { api, ctx } = harness(t);
  api.sessions.set("workbuddy:real", { state: "working", agentId: "workbuddy", updatedAt: Date.now() });
  const oneWorkerSvg = api.getSvgOverride("working");
  api.sessions.set(sid, temporary({ state: "working" }));
  api.sessions.set("codex:bbbbbbbb-1111-4111-8111-111111111111", temporary({ state: "working" }));
  assert.equal(api.getSvgOverride("working"), oneWorkerSvg);
  ctx.sessionHudHideActiveCodexEphemeral = false;
  assert.notEqual(api.getSvgOverride("working"), oneWorkerSvg);
  assert.equal(api.sessions.size, 3);
});

test("strict rendering accepts prior verified child/pending projections without mutating either map", t => {
  const { api } = harness(t);
  const canonical = temporary(); api.sessions.set(sid, canonical);
  const childOverlay = { ...canonical, state: "juggling", subagentTracker: { confirmedIds: new Set(["child"]) } };
  const projected = new Map([[sid, childOverlay], ["hidden", temporary()]]);
  const filtered = api.getPetPresentationSessions(projected);
  assert.equal(filtered.get(sid), childOverlay); assert.equal(filtered.size, 1);
  assert.equal(projected.size, 2); assert.equal(api.sessions.get(sid), canonical);
});

test("hidden temporary progress cannot wake an existing sleep sequence", t => {
  const { api } = harness(t);
  for (const asleep of ["sleeping", "dozing", "yawning"]) {
    api.applyState(asleep);
    api.updateSession(sid, "thinking", "UserPromptSubmit", { ...temporary(), hookSource: "codex-official" });
    assert.equal(api.sessions.get(sid).state, "thinking");
    assert.equal(api.getCurrentState(), asleep);
  }
});

test("hidden temporary progress cannot disturb mini idle or sleep", t => {
  const { api } = harness(t, { miniMode: true });
  for (const asleep of ["mini-sleep", "mini-idle", "mini-peek-hold"]) {
    api.applyState(asleep);
    api.updateSession(sid, "thinking", "UserPromptSubmit", { ...temporary(), hookSource: "codex-official" });
    assert.equal(api.sessions.get(sid).state, "thinking");
    assert.equal(api.getCurrentState(), asleep);
  }
});

test("switching strict rendering on settles a hidden mini-working visual", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { api } = harness(t, { miniMode: true });
  api.sessions.set(sid, temporary());
  api.applyState("mini-working");
  api.refreshPetPresentation();
  t.mock.timers.tick(10000);
  assert.equal(api.getCurrentState(), "mini-idle");
  assert.equal(api.sessions.get(sid).state, "thinking");
});

test("preference refresh settles a false thinking visual and turning off restores real temporary activity", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { api, ctx } = harness(t);
  api.sessions.set(sid, temporary());
  api.applyState("thinking", api.getSvgOverride("thinking"));
  api.refreshPetPresentation();
  assert.equal(api.resolveDisplayState(), "idle");
  t.mock.timers.tick(10000);
  assert.equal(api.getCurrentState(), "idle");
  ctx.sessionHudHideActiveCodexEphemeral = false;
  api.refreshPetPresentation();
  assert.equal(api.resolveDisplayState(), "thinking");
  t.mock.timers.tick(10000);
  assert.equal(api.getCurrentState(), "thinking");
  assert.equal(api.sessions.size, 1);
});

test("completed-row preference alone never removes activity from pet rendering", t => {
  const { api } = harness(t, { sessionHudHideActiveCodexEphemeral: false, sessionHudHideCompletedCodexEphemeral: true });
  api.sessions.set(sid, temporary());
  assert.equal(api.resolveDisplayState(), "thinking");
  assert.equal(api.getPetPresentationSessions(), api.sessions);
});

test("active-only settings effect refreshes pet after mirror update, without lifecycle or power effects", () => {
  let receive; const calls = [];
  const router = createSettingsEffectRouter({ settingsController: { getSnapshot: () => ({}), subscribeKey: () => () => {}, subscribe(fn) { receive = fn; return () => {}; } },
    updateMirrors: () => calls.push("mirror"), emitSessionSnapshot: () => calls.push("snapshot"),
    refreshPetPresentation: () => calls.push("pet"), cleanStaleSessions: () => calls.push("cleanup"),
    reconcilePowerSaveBlocker: () => calls.push("power") });
  router.start();
  receive({ changes: { sessionHudHideActiveCodexEphemeral: true }, snapshot: {} });
  assert.deepEqual(calls, ["mirror", "snapshot", "pet"]);
  calls.length = 0;
  receive({ changes: { sessionHudHideCompletedCodexEphemeral: true }, snapshot: {} });
  assert.deepEqual(calls, ["mirror", "snapshot"]);
  router.dispose();
});
