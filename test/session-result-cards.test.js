"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionResultCards } = require("../src/session-result-cards");
const loader = require("../src/theme-loader");
loader.init(require("node:path").join(__dirname, "../src"));
const noop = () => {};
function setup(t, extra = {}) {
  const cards = createSessionResultCards({ enabled: true, ...extra });
  const activities = [];
  const ctx = {
    theme: loader.loadTheme("clawd"), doNotDisturb: false, miniMode: false,
    miniTransitioning: false, mouseOverPet: false, mouseStillSince: Date.now(),
    pendingPermissions: [], playSound: noop, sendToRenderer: noop, syncHitWin: noop,
    sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop,
    buildTrayMenu: noop, resolvePermissionEntry: noop, focusTerminalWindow: noop,
    t: key => key, resolveAgentDisplayName: id => id,
    broadcastSessionSnapshot: snapshot => cards.onSnapshot(snapshot),
    onAcceptedSessionActivity: (input, entry) => { activities.push(input); cards.observe(input, entry); },
  };
  const state = require("../src/state")(ctx);
  t.after(() => state.cleanup());
  const event = (agentId, status, name, opts = {}, id = "parent") =>
    state.updateSession(id, status, name, { agentId, ...opts });
  return { cards, state, event, ctx, activities };
}
for (const agent of ["claude-code", "codex", "kimi-cli", "grok-build"]) {
  test(agent + " confirmed main completion persists through housekeeping and row removal", t => {
    const { cards, event, state } = setup(t);
    event(agent, "thinking", "UserPromptSubmit");
    event(agent, "attention", "Stop", { assistantLastOutput: "Finished." });
    assert.equal(cards.list().length, 1);
    assert.equal(cards.list()[0].kind, "completed");
    const original = cards.list()[0];
    event(agent, "working", "SubagentStop", { subagentId: "child" });
    assert.equal(cards.list()[0].id, original.id);
    event(agent, "sleeping", "SessionEnd");
    assert.equal(cards.list()[0].id, original.id);
    cards.onSnapshot(state.buildSessionSnapshot());
    cards.dismiss(original.id, original.generation);
    event(agent, "attention", "Stop", { assistantLastOutput: "Finished." });
    assert.equal(cards.list().length, 0);
  });
}
for (const agent of ["claude-code", "kimi-cli", "grok-build"]) {
  test(agent + " explicit failure survives new receipt time and a late Stop", t => {
    const { cards, event } = setup(t);
    event(agent, "working", "PreToolUse");
    event(agent, "error", "StopFailure");
    assert.equal(cards.list()[0]?.kind, "failed");
    const id = cards.list()[0].id;
    event(agent, "error", "StopFailure");
    event(agent, "attention", "Stop", { assistantLastOutput: "Late." });
    assert.equal(cards.list()[0].id, id);
    event(agent, "sleeping", "SessionEnd");
    assert.equal(cards.list()[0].id, id);
  });
}
test("Codex idle-only Stop cannot emit; same timestamp attention upgrade can", t => {
  const { cards, event } = setup(t);
  t.mock.method(Date, "now", () => 1800000000000);
  event("codex", "thinking", "UserPromptSubmit");
  event("codex", "idle", "Stop");
  assert.equal(cards.list().length, 0);
  event("codex", "attention", "Stop");
  assert.equal(cards.list()[0]?.kind, "completed");
});
test("transient failures, child failures, headless, remote and unsupported agents do not emit", t => {
  const { cards, event } = setup(t);
  event("claude-code", "working", "PreToolUse");
  event("claude-code", "error", "PostToolUseFailure");
  event("claude-code", "working", "SubagentStart", { subagentId: "child" });
  event("claude-code", "error", "StopFailure", { subagentId: "child" });
  for (const extra of [{ headless: true }, { subagentType: "Explore" }, { recapIsSubagent: true },
    { profileId: "remote-1", host: "server" }, { wslDistro: "Ubuntu" }]) {
    event("kimi-cli", "error", "StopFailure", extra, JSON.stringify(extra));
  }
  for (const agent of ["opencode", "mimocode", "copilot-cli", "codex", "custom-example"]) {
    event(agent, "error", "StopFailure", {}, agent);
  }
  assert.equal(cards.list().length, 0);
});
test("cancellation retracts completion and a late completion cannot revive it", t => {
  const { cards, event } = setup(t);
  for (const agent of ["codex", "kimi-cli", "grok-build"]) {
    event(agent, "thinking", "UserPromptSubmit", {}, agent);
    event(agent, "attention", "Stop", {}, agent);
    assert.equal(cards.list().length, 1);
    event(agent, "idle", agent === "grok-build" ? "StopCancelled" : "Interrupt", {}, agent);
    assert.equal(cards.list().length, 0);
    event(agent, "attention", "Stop", {}, agent);
    assert.equal(cards.list().length, 0);
  }
});
test("new actual activity clears and re-arms; stale dismiss cannot clear the next result", t => {
  const { cards, event } = setup(t);
  event("kimi-cli", "attention", "Stop");
  const old = cards.list()[0];
  event("kimi-cli", "thinking", "UserPromptSubmit");
  assert.equal(cards.list().length, 0);
  event("kimi-cli", "attention", "Stop");
  const next = cards.list()[0];
  assert.notEqual(next.id, old.id);
  assert.equal(cards.dismiss(old.id, old.generation), false);
  assert.equal(cards.list()[0].id, next.id);
});
test("closed feature still advances phases; enabling never backfills", t => {
  let agentEnabled = true;
  const { cards, event, state } = setup(t, { enabled: false, isAgentEnabled: () => agentEnabled });
  event("kimi-cli", "attention", "Stop");
  cards.syncSettings(true);
  cards.onSnapshot(state.buildSessionSnapshot());
  event("kimi-cli", "attention", "Stop");
  assert.equal(cards.list().length, 0);
  event("kimi-cli", "thinking", "UserPromptSubmit");
  event("kimi-cli", "attention", "Stop");
  assert.equal(cards.list().length, 1);
  agentEnabled = false;
  cards.syncSettings(true);
  agentEnabled = true;
  cards.syncSettings(true);
  event("kimi-cli", "attention", "Stop");
  assert.equal(cards.list().length, 0);
});
test("DND collects results and snapshot changes/hidden rows never acknowledge", t => {
  const { cards, event, ctx, state } = setup(t);
  ctx.doNotDisturb = true;
  event("kimi-cli", "attention", "Stop");
  assert.equal(cards.list().length, 1);
  const snapshot = state.buildSessionSnapshot();
  snapshot.sessions[0].displayTitle = "<script>renamed</script>";
  snapshot.sessions[0].hiddenFromHud = true;
  cards.onSnapshot(snapshot);
  assert.equal(cards.list()[0].title, "<script>renamed</script>");
  cards.onSnapshot({ sessions: [] });
  assert.equal(cards.list().length, 1);
});
test("capacity eviction retains dedupe phase; live row eviction does not discard results", t => {
  const { cards, event } = setup(t, { maxCards: 2, maxPhases: 30 });
  for (let i = 0; i < 24; i++) event("kimi-cli", "attention", "Stop", {}, "session-" + i);
  assert.equal(cards.list().length, 2);
  assert.equal(cards.list()[0].sessionId, "session-23");
  event("kimi-cli", "attention", "Stop", {}, "session-0");
  assert.equal(cards.list()[0].sessionId, "session-23");
});
test("accounting-only events never reach the result observer", t => {
  const { state, activities } = setup(t);
  state.recordRecapEventOnly({
    agentId: "codex", sessionId: "x", rawSessionId: "x", occurredAt: Date.now(),
    event: "response_item:web_search_call",
  });
  assert.equal(activities.length, 0);
});
test("Claude completion debounce only emits after promotion and respects continuing work", t => {
  const old = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
  process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
  t.after(() => {
    if (old === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = old;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const { cards, event } = setup(t);
  event("claude-code", "working", "PreToolUse");
  event("claude-code", "attention", "Stop");
  assert.equal(cards.list().length, 0);
  t.mock.timers.tick(1000);
  assert.equal(cards.list()[0]?.kind, "completed");
  event("claude-code", "thinking", "UserPromptSubmit");
  event("claude-code", "attention", "Stop");
  t.mock.timers.tick(500);
  event("claude-code", "working", "PreToolUse");
  t.mock.timers.tick(2000);
  assert.equal(cards.list().length, 0);
});
test("Claude background work holds both completion and terminal failure cards", t => {
  const { cards, event, state } = setup(t);
  event("claude-code", "working", "PreToolUse");
  event("claude-code", "juggling", "SubagentStart", { subagentId: "child" });
  event("claude-code", "attention", "Stop", { backgroundSubagentsCount: 1, assistantLastOutput: "Parent done." });
  assert.equal(cards.list().length, 0);
  assert.equal(state.promoteCompletion("parent"), false);
  event("claude-code", "error", "StopFailure");
  assert.equal(cards.list().length, 0);
});
test("Codex permission cleanup restoring a done tail does not resurrect a dismissed card", t => {
  const { cards, event, state } = setup(t);
  event("codex", "attention", "Stop");
  const card = cards.list()[0];
  cards.dismiss(card.id, card.generation);
  event("codex", "notification", "PermissionRequest");
  state.clearPermissionNotification("parent");
  assert.equal(cards.list().length, 0);
});
