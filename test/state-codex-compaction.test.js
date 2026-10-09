"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const loader = require("../src/theme-loader");
loader.init(path.join(__dirname, "..", "src"));

describe("Codex compaction across desktop conversations", () => {
  let state, ctx, calls, theme, processAlive;
  const opts = { agentId: "codex", agentPid: 42, sourcePid: 42,
    codexOriginator: "Codex Desktop", headless: false };
  const noop = () => {};
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    theme = structuredClone(loader.loadTheme("clawd"));
    calls = [];
    processAlive = true;
    ctx = { theme, doNotDisturb: false, miniMode: false, miniTransitioning: false,
      mouseOverPet: false, mouseStillSince: Date.now(), pendingPermissions: [],
      playSound: name => calls.push(["sound", name]), sendToRenderer: (...args) => calls.push(args), syncHitWin: noop,
      sendToHitWin: noop, miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop,
      buildTrayMenu: noop, resolvePermissionEntry: noop, dismissPermissionsForDnd: noop,
      focusTerminalWindow: noop, processKill: () => {
        if (processAlive) return true;
        const e = new Error("ESRCH"); e.code = "ESRCH"; throw e;
      }, t: key => key };
    state = require("../src/state")(ctx);
  });
  afterEach(() => { state.cleanup(); mock.timers.reset(); });
  const send = (id, value, event, extra = {}) => state.updateSession(id, value, event, { ...opts, ...extra });

  it("yields to another conversation's work and completion, then resumes sweeping", () => {
    send("compacting", "sweeping", "PreCompact");
    mock.timers.tick(theme.timings.minDisplay.sweeping + 1000);
    send("other", "working", "PreToolUse");
    assert.equal(state.sessions.get("other").state, "working");
    assert.equal(state.getCurrentState(), "working");
    mock.timers.tick(226113);
    send("other", "working", "PostToolUse");
    assert.equal(state.getCurrentState(), "working");
    send("other", "attention", "Stop", { agentId: "claude-code", agentPid: null, sourcePid: null });
    assert.ok(calls.some(call => call[0] === "sound" && call[1] === "complete"));
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "sweeping");
    send("compacting", "sweeping", "event_msg:context_compacted");
    mock.timers.tick(2286);
    send("compacting", "idle", "SessionStart", { sessionStartSource: "compact" });
    assert.equal(state.getCurrentState(), "sweeping");
    mock.timers.tick(theme.timings.minDisplay.sweeping - 2286);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  it("plays WorkBuddy completion queued behind sweeping even when compaction finishes first", () => {
    send("compacting", "sweeping", "PreCompact");
    mock.timers.tick(1000);
    send("workbuddy", "thinking", "UserPromptSubmit", { agentId: "workbuddy", agentPid: 77, sourcePid: 77 });
    send("workbuddy", "attention", "Stop", { agentId: "workbuddy", agentPid: 77, sourcePid: 77 });
    assert.equal(state.deriveSessionBadge(state.sessions.get("workbuddy")), "done");
    mock.timers.tick(1000);
    send("compacting", "sweeping", "event_msg:context_compacted");
    mock.timers.tick(theme.timings.minDisplay.sweeping - 2000);
    assert.equal(state.getCurrentState(), "attention");
    assert.equal(calls.filter(call => call[0] === "sound" && call[1] === "complete").length, 1);
  });

  for (const event of ["PreCompact", "event_msg:context_compacted"]) {
    it(`lets active WorkBuddy work win over a new Codex ${event} cue`, () => {
      send("workbuddy", "working", "PreToolUse", { agentId: "workbuddy", agentPid: 77, sourcePid: 77 });
      mock.timers.tick(2000);
      send("compacting", "sweeping", event);
      mock.timers.tick(10000);
      assert.equal(state.getCurrentState(), "working");
    });
  }

  it("preserves WorkBuddy completion when a sibling Codex completes while another still compacts", () => {
    send("compacting-a", "sweeping", "PreCompact");
    send("compacting-b", "sweeping", "PreCompact");
    mock.timers.tick(1000);
    send("workbuddy", "attention", "Stop", { agentId: "workbuddy", agentPid: 77, sourcePid: 77 });
    mock.timers.tick(1000);
    send("compacting-b", "sweeping", "event_msg:context_compacted");
    mock.timers.tick(theme.timings.minDisplay.sweeping - 2000);
    assert.equal(state.getCurrentState(), "attention");
    assert.ok(calls.some(call => call[0] === "sound" && call[1] === "complete"));
    mock.timers.tick(theme.timings.autoReturn.attention);
    assert.equal(state.getCurrentState(), "sweeping");
  });

  it("does not let a duplicate WorkBuddy Stop reconciliation replace its queued completion", () => {
    send("compacting", "sweeping", "PreCompact");
    mock.timers.tick(6000);
    const buddy = { agentId: "workbuddy", agentPid: 77, sourcePid: 77 };
    send("workbuddy", "working", "PreToolUse", buddy);
    mock.timers.tick(100);
    send("workbuddy", "attention", "Stop", buddy);
    send("workbuddy", "attention", "Stop", buddy);
    mock.timers.tick(theme.timings.minDisplay.working - 100);
    assert.equal(state.getCurrentState(), "attention");
    assert.equal(calls.filter(call => call[0] === "sound" && call[1] === "complete").length, 1);
  });

  it("keeps each compaction independent when two conversations compact", () => {
    send("first", "sweeping", "PreCompact");
    send("second", "sweeping", "PreCompact");
    mock.timers.tick(7000);
    send("first", "sweeping", "event_msg:context_compacted");
    send("first", "working", "PreToolUse");
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "working");
    send("first", "attention", "Stop");
    mock.timers.tick(theme.timings.autoReturn.attention);
    mock.timers.tick(theme.timings.minDisplay.sweeping);
    assert.equal(state.getCurrentState(), "sweeping");
    send("second", "sweeping", "event_msg:context_compacted");
    send("second", "idle", "SessionStart");
    mock.timers.tick(theme.timings.minDisplay.sweeping);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  for (const [value, event] of [["working", "PreToolUse"], ["thinking", "UserPromptSubmit"],
    ["idle", "event_msg:turn_aborted"], ["idle", "SessionStart"]]) {
    it(`releases a missed completion when the same conversation emits ${event}`, () => {
      send("first", "sweeping", "PreCompact");
      mock.timers.tick(7000);
      send("first", value, event);
      send("other", "working", "PreToolUse");
      mock.timers.tick(7000);
      assert.equal(state.getCurrentState(), "working");
    });
  }

  for (const cleanup of ["SessionEnd", "clear", "hide", "process-exit"]) {
    it(`releases the compaction owner on ${cleanup}`, () => {
      send("first", "sweeping", "PreCompact");
      mock.timers.tick(7000);
      if (cleanup === "SessionEnd") send("first", "sleeping", "SessionEnd");
      else if (cleanup === "clear") state.clearSessionsByAgent("codex");
      else if (cleanup === "hide") state.dismissSession("first");
      else {
        processAlive = false;
        state.cleanStaleSessions();
      }
      send("other", "working", "PreToolUse", { agentId: "claude-code", agentPid: null, sourcePid: null });
      mock.timers.tick(7000);
      assert.equal(state.getCurrentState(), "working");
      send("other", "attention", "Stop", { agentId: "claude-code", agentPid: null, sourcePid: null });
      mock.timers.tick(7000);
      assert.equal(state.resolveDisplayState(), "idle", "a released owner must not leave a latent sweep");
    });
  }

  it("bounds a lost completion without extending the cap for duplicate starts", () => {
    send("first", "sweeping", "PreCompact");
    mock.timers.tick(5 * 60 * 1000);
    send("first", "sweeping", "PreCompact");
    mock.timers.tick(5 * 60 * 1000 - 1);
    assert.equal(state.getCurrentState(), "sweeping");
    mock.timers.tick(1);
    assert.equal(state.resolveDisplayState(), "idle");
  });

  it("does not give headless compaction a global animation", () => {
    send("other", "working", "PreToolUse");
    mock.timers.tick(2000);
    send("child", "sweeping", "PreCompact", { headless: true });
    send("child", "sweeping", "event_msg:context_compacted", { headless: true });
    assert.equal(state.getCurrentState(), "working");
  });

  it("preserves Mini interactions while retaining compaction for normal mode", () => {
    ctx.miniMode = true;
    state.applyState("mini-idle");
    send("first", "sweeping", "PreCompact");
    send("other", "working", "PreToolUse");
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "mini-working");
    ctx.miniMode = false;
    const resolved = state.resolveDisplayState();
    state.setState(resolved);
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "working");
  });

  it("honors disabled sweeping and DND while tracking the real lifecycle", () => {
    ctx.isOneshotDisabled = value => value === "sweeping";
    send("first", "sweeping", "PreCompact");
    send("other", "working", "PreToolUse");
    assert.equal(state.getCurrentState(), "working");
    ctx.isOneshotDisabled = () => false;
    state.enableDoNotDisturb();
    mock.timers.tick(7000);
    send("first", "sweeping", "event_msg:context_compacted");
    state.disableDoNotDisturb();
    mock.timers.tick(20000);
    assert.equal(state.resolveDisplayState(), "working");
  });

  it("keeps a confirmed permission request above a compaction", () => {
    send("first", "sweeping", "PreCompact");
    mock.timers.tick(7000);
    ctx.isAgentPermissionsEnabled = () => true;
    ctx.showKimiNotifyBubble = noop;
    ctx.clearKimiNotifyBubbles = noop;
    send("other", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "notification");
    send("other", "working", "PostToolUse", { agentId: "kimi-cli" });
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "working");
    send("other", "attention", "Stop", { agentId: "kimi-cli" });
    mock.timers.tick(7000);
    assert.equal(state.getCurrentState(), "sweeping");
  });
});
