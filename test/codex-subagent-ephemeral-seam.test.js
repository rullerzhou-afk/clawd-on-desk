"use strict";

// Seam between delegated-child presentation (#1270) and the temporary-chat
// collapse options (#1258): the child/pending projection must run before the
// strict temporary-chat filter, in both the HUD snapshot and the pet.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const themeLoader = require("../src/theme-loader");
const { resolveSessionIdentity } = require("../src/session-key");
const { isHudSession } = require("../src/session-hud").__test;

const rawParent = "codex:aaaaaaaa-2222-4222-8222-222222222222";
const parentId = resolveSessionIdentity(rawParent, "local").sessionId;
const rawChild = "codex:bbbbbbbb-2222-4222-8222-222222222222";
const rawSecondChild = "codex:cccccccc-2222-4222-8222-222222222222";

function makeState(overrides = {}) {
  themeLoader.init(path.join(__dirname, "..", "src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
  return require("../src/state")({ theme, lang: "en", doNotDisturb: false,
    miniMode: false, pendingPermissions: [], t: k => k,
    playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
    buildContextMenu() {}, buildTrayMenu() {}, processKill() { return true; },
    ...overrides,
  });
}

describe("Codex delegated children x temporary-chat collapse", () => {
  let state;
  afterEach(() => state && state.cleanup());
  const parentEvent = (phase, event) => state.updateSession(parentId, phase, event, {
    agentId: "codex", profileId: "local", rawSessionId: rawParent, hookSource: "codex-official",
    codexClientEphemeral: true, codexOriginator: "Codex Desktop",
  });
  const child = (phase, childId = rawChild) => state.updateCodexSubagentActivity(parentId, {
    childId, turnId: "child-turn", phase, occurredAt: Date.now(),
  });
  const row = () => state.buildSessionSnapshot().sessions.find(entry => entry.id === parentId);

  it("keeps a working temporary parent visible through 2->1->0 children, then collapses it", () => {
    state = makeState({ sessionHudHideActiveCodexEphemeral: true });
    parentEvent("thinking", "UserPromptSubmit");
    parentEvent("working", "PreToolUse");
    assert.equal(state.sessions.get(parentId).codexClientEphemeral, true);
    assert.equal(isHudSession(row()), false, "precondition: the active option hides the working row");
    assert.equal(state.resolveDisplayState(), "idle");

    assert.equal(child("start"), true);
    assert.equal(child("start", rawSecondChild), true);
    assert.equal(row().activeSubagentCount, 2);
    assert.equal(row().hudHiddenByPreference, false);
    assert.equal(isHudSession(row()), true);
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(state.getCurrentState(), "juggling");
    assert.equal(state.getSvgOverride("juggling"), "clawd-working-juggling.svg");

    assert.equal(child("stop", rawSecondChild), true);
    assert.equal(row().activeSubagentCount, 1);
    assert.equal(isHudSession(row()), true);
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(state.getSvgOverride("juggling"), "clawd-headphones-groove.svg");

    assert.equal(child("stop"), true);
    assert.equal(row().activeSubagentCount, 0);
    assert.equal(isHudSession(row()), false);
    assert.equal(state.resolveDisplayState(), "idle");
    assert.equal(state.getCurrentState(), "idle");
    assert.equal(state.sessions.get(parentId).state, "working", "canonical parent phase is untouched");
  });

  it("keeps a completed temporary parent visible until its last child ends, then applies the completed option", () => {
    state = makeState({ sessionHudHideActiveCodexEphemeral: true, sessionHudHideCompletedCodexEphemeral: true });
    parentEvent("thinking", "UserPromptSubmit");
    parentEvent("working", "PreToolUse");
    child("start");
    parentEvent("attention", "Stop");
    assert.equal(state.sessions.get(parentId).state, "idle");
    assert.equal(isHudSession(row()), true);
    assert.equal(state.resolveDisplayState(), "juggling");

    child("stop");
    assert.equal(row().hudHiddenByPreference, true);
    assert.equal(isHudSession(row()), false);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  it("keeps a working temporary parent with a native question card visible as notification", () => {
    const pendingPermissions = [];
    state = makeState({ sessionHudHideActiveCodexEphemeral: true, pendingPermissions });
    parentEvent("thinking", "UserPromptSubmit");
    parentEvent("working", "PreToolUse");
    assert.equal(isHudSession(row()), false, "precondition: the active option hides the working row");

    pendingPermissions.push({ agentId: "codex", sessionId: parentId, res: null,
      isCodexUserInputNotify: true });
    state.refreshCodexPendingAttention();
    assert.equal(row().pendingAttention, true);
    assert.equal(row().effectiveState, "notification");
    assert.equal(isHudSession(row()), true);
    assert.equal(state.resolveDisplayState(), "notification");
    assert.equal(state.getCurrentState(), "notification");

    pendingPermissions.length = 0;
    state.refreshCodexPendingAttention();
    assert.equal(isHudSession(row()), false);
    assert.equal(state.resolveDisplayState(), "idle");
  });
});
