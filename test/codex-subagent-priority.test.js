"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const themeLoader = require("../src/theme-loader");
const initState = require("../src/state");
const { resolveSessionIdentity } = require("../src/session-key");
const { resolveDominantSessionState } = require("../src/state-priority");
const createPresentation = require("../src/codex-subagent-presentation");

const raw = suffix => `codex:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const key = suffix => resolveSessionIdentity(raw(suffix), "local").sessionId;

function setup(t, originator) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  themeLoader.init(path.join(__dirname, "../src"));
  const theme = structuredClone(themeLoader.loadTheme("clawd"));
  theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
  const state = initState({ theme, lang: "en", doNotDisturb: false, miniMode: false,
    pendingPermissions: [], t: key => key, processKill: () => true,
    playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
    buildContextMenu() {}, buildTrayMenu() {},
  });
  t.after(() => state.cleanup());
  const opts = { agentId: "codex", profileId: "local", agentPid: 4242,
    ...(originator ? { codexOriginator: originator } : {}) };
  state.updateSession(key(1), "working", "PreToolUse", opts);
  t.mock.timers.tick(10);
  state.updateSession(key(2), "thinking", "UserPromptSubmit", opts);
  const child = (id, phase = "start") => state.updateCodexSubagentActivity(key(1), {
    childId: raw(id), turnId: `turn-${id}`, phase, occurredAt: Date.now(),
  });
  const row = () => state.buildSessionSnapshot().sessions.find(row => row.id === key(1));
  return { state, child, row, svg: () => state.getSvgOverride(state.resolveDisplayState()) };
}

describe("Codex verified-child visual priority", () => {
  it("keeps an older same-PID parent in the 2→1→0 animation without changing its canonical metadata or focus", t => {
    const { state, child, row, svg } = setup(t);
    assert.equal(state.resolveDisplayState(), "thinking", "plain PID dedupe still chooses the newer thread");
    assert.equal(row().hiddenFromHud, true);
    assert.equal(row().canFocus, false);
    const before = structuredClone(state.sessions.get(key(1)));
    child(3); child(4);
    assert.equal(state.resolveDisplayState(), "juggling");
    assert.equal(svg(), "clawd-working-juggling.svg");
    assert.equal(row().activeSubagentCount, 2);
    assert.equal(row().hiddenFromHud, false);
    assert.equal(row().canFocus, false);
    assert.equal(row().focusTarget, null);
    assert.deepEqual(state.sessions.get(key(1)), before);
    child(3, "stop");
    assert.equal(svg(), "clawd-headphones-groove.svg");
    child(4, "stop");
    assert.equal(state.resolveDisplayState(), "thinking");
    assert.equal(row().hiddenFromHud, true);
    assert.equal(row().activeSubagentCount, 0);
    assert.deepEqual(state.sessions.get(key(1)), before);
  });

  it("retains the ordinary known-Desktop multi-thread behavior after child activity ends", t => {
    const { state, child, svg } = setup(t, "codex_work_desktop");
    assert.equal(state.resolveDisplayState(), "working");
    child(3); child(4);
    assert.equal(svg(), "clawd-working-juggling.svg");
    child(3, "stop"); child(4, "stop");
    assert.equal(state.resolveDisplayState(), "working", "Desktop threads remain independent");
  });

  for (const strongState of ["notification", "sweeping", "error"]) {
    it(`preserves an older parent's ${strongState} state and hint while its verified child prevents visual dedupe`, t => {
      const { state, child } = setup(t);
      // Stored strong states may be supplied by restored/other state callers;
      // this test exercises their projection rather than normalizing them via
      // the ordinary one-shot event path before visual selection.
      const parent = state.sessions.get(key(1));
      parent.state = strongState;
      parent.displayHint = "fixture-strong-hint";
      const before = structuredClone(parent);
      assert.equal(state.resolveDisplayState(), "thinking");
      child(3);
      assert.equal(state.resolveDisplayState(), strongState);
      assert.deepEqual(state.sessions.get(key(1)), before);
      child(3, "stop");
      assert.equal(state.resolveDisplayState(), "thinking", "ending the child restores ordinary PID dedupe");
      assert.deepEqual(state.sessions.get(key(1)), before);

      // Verify the clone itself retains the stronger state's display hint,
      // even when native attention is also present, without tagging canonical.
      const projection = createPresentation(state.sessions);
      projection.update(key(1), { childId: raw(4), turnId: "strong-turn", phase: "start", occurredAt: Date.now() });
      const projected = projection.project(new Set([key(1)])).get(key(1));
      assert.equal(projected.state, strongState);
      assert.equal(projected.displayHint, parent.displayHint);
      assert.equal(createPresentation.isVerifiedChildProjection(projected), true);
      assert.equal(createPresentation.isVerifiedChildProjection(parent), false);
    });
  }

  it("does not bypass ordinary process dedupe for canonical or serialized child-shaped fields", () => {
    const older = { agentId: "codex", agentPid: 4242, state: "juggling", updatedAt: 100,
      activeSubagentCount: 2, subagentTracker: { confirmedIds: new Set(["a", "b"]) } };
    const newer = { agentId: "codex", agentPid: 4242, state: "idle", updatedAt: 200 };
    assert.equal(resolveDominantSessionState(new Map([[key(1), older], [key(2), newer]])), "idle");
    assert.equal(resolveDominantSessionState(new Map([[key(1), JSON.parse(JSON.stringify(older))], [key(2), newer]])), "idle");
  });
});
