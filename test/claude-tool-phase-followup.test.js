"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
const { createMemoryRecapSink } = require("../src/recap-sink");
const { createClaudeToolPhaseLedger } = require("../src/claude-tool-phase");
loader.init(path.join(__dirname, "..", "src"));

function runtime() {
  const effects = [], sounds = [], sink = createMemoryRecapSink();
  const noop = () => {};
  const theme = structuredClone(loader.loadTheme("clawd"));
  theme.timings.minDisplay = {};
  const ctx = { lang: "en", theme, doNotDisturb: false, miniMode: false, miniTransitioning: false,
    mouseOverPet: false, idlePaused: false, mouseStillSince: Date.now(), pendingPermissions: [],
    playSound: name => sounds.push(name), sendToRenderer: (...args) => effects.push(args),
    syncHitWin: noop, sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop,
    buildContextMenu: noop, buildTrayMenu: noop, resolvePermissionEntry: noop,
    dismissPermissionsForDnd: noop, focusTerminalWindow: noop, processKill: () => true,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), recapSink: sink, isAgentEnabled: () => true,
    t: key => key };
  const api = require("../src/state")(ctx), sid = "qa-claude-phase";
  const send = (event, value, extra = {}) => api.updateSession(sid, value, event,
    { agentId: "claude-code", rawSessionId: sid, claudePromptId: "qa-prompt", ...extra });
  return { api, ctx, sink, effects, sounds, sid, send };
}
function check(name, fn) {
  test(name, async t => {
    const actual = {};
    await fn(t, actual);
  });
}

check("a settled Agent start cannot revive a child that already stopped", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["agent-tool"] });
    h.send("PostToolUse", "working", { toolUseId: "agent-tool", toolName: "Agent" });
    h.send("SubagentStart", "juggling", { subagentId: "child-a", subagentLifecycleSource: "native" });
    h.send("SubagentStop", "working", { subagentId: "child-a", subagentLifecycleSource: "native" });
    const before = JSON.stringify(h.api.buildSessionSnapshot());
    h.send("SubagentStart", "juggling", { toolUseId: "agent-tool", toolName: "Agent", subagentLifecycleSource: "synthetic-tool" });
    actual.state = h.api.sessions.get(h.sid).state;
    assert.equal(actual.state, "thinking");
    assert.equal(h.api.sessions.get(h.sid).subagentTracker.legacyFloor, false);
    assert.equal(JSON.stringify(h.api.buildSessionSnapshot()), before);
    h.send("SubagentStart", "juggling", { toolUseId: "fresh-agent", toolName: "Agent", subagentLifecycleSource: "synthetic-tool" });
    assert.equal(h.api.sessions.get(h.sid).state, "juggling", "fresh tool starts remain live evidence");
  } finally { h.api.cleanup(); }
});

check("an unknown child Stop cannot suppress a delayed settled Agent start", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["agent-tool"] });
    h.send("PostToolUse", "working", { toolUseId: "agent-tool" });
    h.send("SubagentStop", "working", { subagentId: "unknown-child", subagentLifecycleSource: "native" });
    h.send("SubagentStart", "juggling", { toolUseId: "agent-tool", toolName: "Agent", subagentLifecycleSource: "synthetic-tool" });
    actual.state = h.api.sessions.get(h.sid).state;
    assert.equal(actual.state, "juggling");
  } finally { h.api.cleanup(); }
});

check("a queued first Pre after its Stop counts once without reviving completion", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking"); h.send("Stop", "attention");
    const queued = { claudePromptId: "queued", toolUseId: "queued-tool" };
    h.send("PostToolBatch", "thinking", { ...queued, batchToolUseIds: ["queued-tool"] });
    h.send("Stop", "attention", { ...queued, assistantLastOutput: "fixture answer" });
    const before = JSON.stringify(h.api.buildSessionSnapshot()), soundCount = h.sounds.length;
    h.send("PreToolUse", "working", queued); h.send("PreToolUse", "working", queued);
    actual.tools = h.sink.snapshot().filter(event => event.metrics.includes("tool-call")).length;
    assert.equal(actual.tools, 1);
    assert.equal(JSON.stringify(h.api.buildSessionSnapshot()), before);
    assert.equal(h.sounds.length, soundCount);
    assert.equal(h.api.deriveSessionBadge(h.api.sessions.get(h.sid)), "done");
  } finally { h.api.cleanup(); }
});

for (const gate of ["approval", "DND", "headless"]) {
  check(`retained batch rechecks ${gate} before a delayed tool callback`, (_t, actual) => {
    const h = runtime();
    try {
      h.send("UserPromptSubmit", "thinking");
      h.send("PostToolBatch", "thinking", { batchToolUseIds: ["fast-tool"] });
      if (gate === "approval") h.ctx.pendingPermissions.push({ sessionId: h.sid, agentId: "claude-code", res: {}, toolUseId: "approval-other" });
      if (gate === "DND") h.ctx.doNotDisturb = true;
      h.send("PreToolUse", "working", { toolUseId: "fast-tool", headless: gate === "headless" });
      actual.logicalState = h.api.sessions.get(h.sid).state;
      actual.pendingApprovals = h.ctx.pendingPermissions.length;
      actual.headless = h.api.sessions.get(h.sid).headless;
      actual.petState = h.api.getCurrentState();
      assert.equal(actual.logicalState, "working", "the delayed callback must not acquire the batch thinking hint behind a stronger gate");
    } finally { h.api.cleanup(); }
  });
}

check("Batch then Post then synthetic SubagentStart retains collaboration", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["agent-tool"] });
    h.send("PostToolUse", "working", { toolUseId: "agent-tool", toolName: "Agent" });
    h.send("SubagentStart", "juggling", { toolUseId: "agent-tool", toolName: "Agent", subagentLifecycleSource: "synthetic-tool" });
    actual.logicalState = h.api.sessions.get(h.sid).state;
    actual.liveSubagentEvidence = h.api.sessions.get(h.sid).subagentTracker.legacyFloor;
    assert.equal(actual.logicalState, "juggling");
    assert.equal(actual.liveSubagentEvidence, true);
  } finally { h.api.cleanup(); }
});

check("late failure settling an early batch resumes the still-live subagent", (t, actual) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["failed-tool"] });
    h.send("SubagentStart", "juggling", { subagentId: "live-child", subagentLifecycleSource: "native" });
    h.send("PostToolUseFailure", "error", { toolUseId: "failed-tool", toolName: "Bash" });
    actual.logicalState = h.api.sessions.get(h.sid).state;
    actual.confirmedChildren = h.api.sessions.get(h.sid).subagentTracker.confirmedIds.size;
    actual.petState = h.api.getCurrentState();
    assert.equal(actual.petState, "error");
    t.mock.timers.tick(h.ctx.theme.timings.autoReturn.error);
    actual.petStateAfterError = h.api.getCurrentState();
    assert.equal(actual.petStateAfterError, "juggling", "the error cue must return to visible collaboration");
    assert.equal(actual.logicalState, "juggling", "error must resume live collaboration instead of thinking");
  } finally { h.api.cleanup(); t.mock.timers.reset(); }
});

check("first Pre arriving after Batch and Post still counts exactly one tool", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["late-pre-tool"] });
    h.send("PostToolUse", "working", { toolUseId: "late-pre-tool", toolName: "ToolSearch" });
    h.send("PreToolUse", "working", { toolUseId: "late-pre-tool", toolName: "ToolSearch" });
    h.send("PreToolUse", "working", { toolUseId: "late-pre-tool", toolName: "ToolSearch" });
    actual.toolCalls = h.sink.snapshot().filter(event => event.metrics.includes("tool-call")).length;
    actual.logicalState = h.api.sessions.get(h.sid).state;
    assert.equal(actual.logicalState, "thinking");
    assert.equal(actual.toolCalls, 1);
  } finally { h.api.cleanup(); }
});

check("queued turn retains its first batch when that batch precedes its first Pre", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("Stop", "attention");
    const queued = { claudePromptId: "queued-prompt", toolUseId: "queued-tool" };
    actual.batchAccepted = h.send("PostToolBatch", "thinking", { ...queued, batchToolUseIds: ["queued-tool"] });
    h.send("PreToolUse", "working", queued);
    h.send("PostToolUse", "working", queued);
    actual.logicalAfterBatchTools = h.api.sessions.get(h.sid).state;
    h.send("PreToolUse", "working", { ...queued, toolUseId: "next-tool" });
    actual.nextBatchAccepted = h.send("PostToolBatch", "thinking", { ...queued, batchToolUseIds: ["next-tool"] });
    actual.logicalAfterNextBatch = h.api.sessions.get(h.sid).state;
    h.send("Stop", "attention", queued);
    actual.finalBadge = h.api.deriveSessionBadge(h.api.sessions.get(h.sid));
    actual.finalState = h.api.sessions.get(h.sid).state;
    assert.equal(actual.finalBadge, "done", "completion must remain intact");
    assert.equal(actual.logicalAfterBatchTools, "thinking");
    assert.equal(actual.logicalAfterNextBatch, "thinking");
  } finally { h.api.cleanup(); }
});

check("parallel early batch waits for all members and clears its settled boundary", (_t, actual) => {
  const h = runtime();
  try {
    h.send("UserPromptSubmit", "thinking");
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["a", "b"] });
    h.send("PreToolUse", "working", { toolUseId: "a" });
    actual.partialState = h.api.sessions.get(h.sid).state;
    assert.equal(actual.partialState, "working");
    h.send("PostToolUse", "working", { toolUseId: "b" });
    assert.equal(h.api.sessions.get(h.sid).state, "thinking");
    h.send("PreToolUse", "working", { toolUseId: "new" });
    h.send("PostToolBatch", "thinking", { batchToolUseIds: ["new"] });
    actual.nextState = h.api.sessions.get(h.sid).state;
    assert.equal(actual.nextState, "thinking");
    h.send("Stop", "attention");
    assert.equal(h.api.deriveSessionBadge(h.api.sessions.get(h.sid)), "done");
  } finally { h.api.cleanup(); }
});

check("clearing the ledger discards already-settled early evidence", (_t, actual) => {
  const ledger = createClaudeToolPhaseLedger();
  const base = { sessionId: "qa-ledger", promptId: "same" };
  ledger.observe({ ...base, event: "UserPromptSubmit" });
  ledger.observe({ ...base, event: "PostToolBatch", toolUseIds: ["tool"] });
  assert.equal(ledger.observe({ ...base, event: "PreToolUse", toolUseId: "tool" }).thinking, true);
  ledger.clear();
  actual.sizeAfterClear = ledger.size;
  assert.equal(actual.sizeAfterClear, 0);
  assert.equal(ledger.observe({ ...base, event: "PostToolBatch", toolUseIds: ["tool"] }).accept, false);
});
