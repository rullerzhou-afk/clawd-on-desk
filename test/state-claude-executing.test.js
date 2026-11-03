"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
const { createMemoryRecapSink } = require("../src/recap-sink");
loader.init(path.join(__dirname, "..", "src"));

function runtime(t, overrides = {}) {
  const theme = structuredClone(loader.loadTheme("clawd"));
  theme.timings.minDisplay = {};
  const effects = [], sink = createMemoryRecapSink(), noop = () => {};
  const ctx = { theme, lang: "en", doNotDisturb: false, miniMode: false, miniTransitioning: false,
    mouseOverPet: false, idlePaused: false, mouseStillSince: Date.now(), pendingPermissions: [],
    playSound: noop, sendToRenderer: (...args) => effects.push(args), sendToHitWin: noop,
    syncHitWin: noop, miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop, buildTrayMenu: noop,
    resolvePermissionEntry: noop, dismissPermissionsForDnd: noop, processKill: () => true,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), isAgentEnabled: () => true, t: key => key,
    recapSink: sink, ...overrides };
  const api = require("../src/state")(ctx), sid = "executing-fixture";
  t.after(() => api.cleanup());
  const send = (event, state, extra = {}) => api.updateSession(sid, state, event,
    { agentId: "claude-code", claudePromptId: "prompt-a", toolName: "Read", ...extra });
  const resolve = (behavior, extra = {}) => api.clearPermissionNotification(sid, {
    behavior, permissionSource: { agentId: "claude-code", profileId: "local" }, ...extra,
  });
  const state = () => api.sessions.get(sid)?.state;
  return { api, ctx, sid, send, resolve, state, effects, sink };
}

test("Claude starts a tool hint, conservatively drops it on the first result, then accepts the batch", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking");
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "executing");
  assert.equal(h.api.getCurrentState(), "executing");
  assert.equal(h.api.buildSessionSnapshot().sessions[0].state, "executing");
  assert.equal(h.api.buildSessionSnapshot().sessions[0].badge, "running");
  assert.equal(h.api.getCurrentSvg(), h.ctx.theme.states.working[0]);
  h.send("PreToolUse", "working", { toolUseId: "b" });
  h.send("PostToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "working", "an unresolved sibling is not proof of ongoing execution");
  h.send("PostToolUse", "working", { toolUseId: "b" });
  h.send("PostToolBatch", "thinking", { batchToolUseIds: ["a", "b"] });
  assert.equal(h.state(), "thinking");
  assert.equal(h.sink.snapshot().filter(e => e.metrics.includes("tool-call")).length, 2);
});

for (const result of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${result} before Pre cannot acquire an execution hint`, t => {
    const h = runtime(t);
    h.send("UserPromptSubmit", "thinking");
    h.send(result, result === "PostToolUse" ? "working" : "error", { toolUseId: "a" });
    h.send("PreToolUse", "working", { toolUseId: "a" });
    assert.equal(h.state(), "working");
  });
}

test("a partial early batch never flashes executing while awaiting its other member", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking");
  h.send("PostToolBatch", "thinking", { batchToolUseIds: ["a", "b"] });
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "working");
  h.send("PostToolUse", "working", { toolUseId: "b" });
  assert.equal(h.state(), "thinking");
  h.send("PreToolUse", "working", { toolUseId: "c" });
  assert.equal(h.state(), "executing");
});

test("ordinary tool failure retains interrupted behavior while a settled failure preserves thinking", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking");
  h.send("PreToolUse", "working", { toolUseId: "a" });
  h.send("PostToolUseFailure", "error", { toolUseId: "a" });
  assert.equal(h.state(), "idle");
  assert.equal(h.api.deriveSessionBadge(h.api.sessions.get(h.sid)), "interrupted");
  h.send("PostToolBatch", "thinking", { batchToolUseIds: ["a"] });
  h.send("PostToolUseFailure", "error", { toolUseId: "a" });
  assert.equal(h.state(), "thinking");
});

for (const extra of [
  { agentId: "codex" }, { agentIdDefaulted: true }, { agentId: undefined },
  { profileId: "remote-fixture" }, { host: "remote" }, { wslDistro: "Ubuntu" },
  { headless: true }, { subagentId: "child" }, { claudePromptId: null },
  { toolUseId: null }, { toolName: "AskUserQuestion" }, { toolName: "ExitPlanMode" },
  { toolName: "NewUnreviewedTool" },
]) {
  test(`execution eligibility stays conservative: ${JSON.stringify(extra)}`, t => {
    const h = runtime(t);
    h.send("UserPromptSubmit", "thinking", extra);
    h.send("PreToolUse", "working", { toolUseId: "a", ...extra });
    assert.notEqual(h.state(), "executing");
  });
}

test("effective remote metadata is sticky and DND cannot grant a new hint", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking", { host: "remote" });
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "working");
  h.api.clearSessionsByAgent("claude-code");
  h.ctx.doNotDisturb = true;
  h.send("PreToolUse", "working", { toolUseId: "b" });
  assert.notEqual(h.state(), "executing");
});

for (const behavior of ["deny", "no-decision", undefined]) {
  test(`${behavior} downgrades even while another approval is pending and fences late Pre`, t => {
    const h = runtime(t);
    h.send("UserPromptSubmit", "thinking");
    h.send("PreToolUse", "working", { toolUseId: "a" });
    h.resolve(behavior, { hasPendingForSession: true });
    assert.equal(h.state(), "working");
    h.resolve("allow");
    h.send("PreToolUse", "working", { toolUseId: "late" });
    assert.equal(h.state(), "working", "allow must not clear another request's non-allow fence");
    h.send("UserPromptSubmit", "thinking", { claudePromptId: "new-prompt" });
    h.send("PreToolUse", "working", { claudePromptId: "new-prompt", toolUseId: "new-tool" });
    assert.equal(h.state(), "executing");
  });
}

test("a permission result preceding all command hooks suppresses the first adopted prompt", t => {
  const h = runtime(t);
  h.resolve("no-decision");
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "working");
  h.send("UserPromptSubmit", "thinking");
  h.send("PreToolUse", "working", { toolUseId: "b" });
  assert.equal(h.state(), "working");
  h.send("PostToolBatch", "thinking", { batchToolUseIds: ["a", "b"] });
  h.send("PreToolUse", "working", { toolUseId: "c" });
  assert.equal(h.state(), "executing", "an accepted boundary can restore fresh-start eligibility");
});

test("allow preserves a current hint but never upgrades a working session", t => {
  const h = runtime(t);
  h.send("PreToolUse", "working", { toolUseId: "a" });
  h.resolve("allow");
  assert.equal(h.state(), "executing");
  h.send("PostToolUse", "working", { toolUseId: "a" });
  h.resolve("allow");
  assert.equal(h.state(), "working");
});

test("non-allow preserves the remaining approval's minimum notification display", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const h = runtime(t);
  h.ctx.theme.timings.minDisplay.notification = 5000;
  h.api.refreshTheme();
  h.send("PreToolUse", "working", { toolUseId: "a" });
  h.send("PreToolUse", "working", { toolUseId: "b" });
  h.send("PermissionRequest", "notification");
  h.send("PermissionRequest", "notification");
  assert.equal(h.api.getCurrentState(), "notification");
  h.resolve("deny", { hasPendingForSession: true });
  assert.equal(h.state(), "working", "the logical hint must be invalidated immediately");
  assert.equal(h.api.getCurrentState(), "notification", "do not truncate the other request's cue");
  h.send("PreToolUse", "working", { toolUseId: "late" });
  assert.equal(h.state(), "working");
  t.mock.timers.tick(4999);
  assert.equal(h.api.getCurrentState(), "notification");
  t.mock.timers.tick(1);
  assert.equal(h.api.getCurrentState(), "working", "retain existing one-shot semantics, not a new lock");
});

test("a non-allow after Stop fences the next queued prompt even without Submit", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking");
  h.send("Stop", "attention");
  h.resolve("deny");
  h.send("PreToolUse", "working", { claudePromptId: "queued-prompt", toolUseId: "denied" });
  assert.equal(h.state(), "working");
  h.send("PostToolBatch", "thinking", { claudePromptId: "queued-prompt", batchToolUseIds: ["denied"] });
  h.send("PreToolUse", "working", { claudePromptId: "queued-prompt", toolUseId: "later" });
  assert.equal(h.state(), "executing", "an accepted boundary releases the suppression normally");
});

test("child and other-agent permission results do not downgrade the main Claude hint", t => {
  const h = runtime(t);
  h.send("PreToolUse", "working", { toolUseId: "a" });
  for (const permissionSource of [{ agentId: "codex" }, { agentId: "claude-code", subagentId: "child" }]) {
    h.resolve("deny", { permissionSource });
    assert.equal(h.state(), "executing");
  }
});

test("live children retain juggling and never restore an old execution hint", t => {
  const h = runtime(t);
  h.send("PreToolUse", "working", { toolUseId: "a" });
  h.send("SubagentStart", "juggling", { subagentId: "child", subagentLifecycleSource: "native" });
  assert.equal(h.api.sessions.get(h.sid).resumeState, "working");
  h.send("PreToolUse", "working", { toolUseId: "b" });
  assert.equal(h.state(), "juggling");
  h.send("SubagentStop", "working", { subagentId: "child", subagentLifecycleSource: "native" });
  assert.equal(h.state(), "working");
});

test("design hints survive executing and mini uses the existing working visual", t => {
  const h = runtime(t);
  h.send("UserPromptSubmit", "thinking", { displayHint: "claude-design" });
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.api.sessions.get(h.sid).displayHint, "claude-design");
  assert.equal(h.api.getCurrentSvg(), h.ctx.theme.displayHintMap["claude-design"]);
  h.ctx.miniMode = true;
  h.api.applyState("mini-idle");
  h.send("PreToolUse", "working", { toolUseId: "b" });
  assert.equal(h.api.getCurrentState(), "mini-working");
  assert.equal(h.api.getCurrentSvg(), h.ctx.theme.miniMode.states["mini-working"][0]);
});

test("working fallback shares its stable pick and executing inherits the theme's display hold", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const h = runtime(t);
  h.ctx.theme.states.working = ["working-a.svg", "working-b.svg"];
  h.ctx.theme.workingTiers = [{ minSessions: 1, files: ["working-a.svg", "working-b.svg"] }];
  h.ctx.theme.timings.minDisplay.working = 1000;
  h.api.refreshTheme();
  const random = t.mock.method(Math, "random", () => 0.75);
  h.send("PreToolUse", "working", { toolUseId: "a" });
  assert.equal(h.api.getCurrentSvg(), "working-b.svg");
  h.send("PostToolUse", "working", { toolUseId: "a" });
  assert.equal(h.state(), "working");
  assert.equal(h.api.getCurrentState(), "executing", "executing should inherit the working display hold");
  t.mock.timers.tick(1000);
  assert.equal(h.api.getCurrentState(), "working");
  assert.equal(h.api.getCurrentSvg(), "working-b.svg");
  assert.equal(random.mock.callCount(), 1, "the alias must retain the same working pool selection");
});
