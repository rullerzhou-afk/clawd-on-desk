const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");

themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx() {
  const kimiNotifyShown = [];
  const kimiNotifyDetails = [];
  const kimiNotifyCleared = [];
  const ctx = {
    lang: "en",
    theme: defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    focusTerminalWindow: () => {},
    showKimiNotifyBubble: (entry) => {
      kimiNotifyShown.push(entry.sessionId);
      kimiNotifyDetails.push(entry);
    },
    clearKimiNotifyBubbles: (sessionId) => { kimiNotifyCleared.push(sessionId || "__all__"); },
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  };
  ctx._kimiNotifyShown = kimiNotifyShown;
  ctx._kimiNotifyDetails = kimiNotifyDetails;
  ctx._kimiNotifyCleared = kimiNotifyCleared;
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

describe("Kimi permission hold by session", () => {
  let api;
  let ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("does not block other sessions from updating while pinned notification is active", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    api.updateSession("kimi-b", "working", "PreToolUse", { agentId: "kimi-cli" });

    assert.strictEqual(api.sessions.get("kimi-b").state, "working");
    assert.strictEqual(api.resolveDisplayState(), "notification");
  });

  it("clears only the matching session hold on terminal events", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    api.updateSession("kimi-b", "notification", "PermissionRequest", { agentId: "kimi-cli" });

    // kimi-a's user answers (PostToolUse arrives) — kimi-b's hold must remain.
    api.updateSession("kimi-a", "working", "PostToolUse", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // Then kimi-b answers — display falls back to working.
    api.updateSession("kimi-b", "working", "PostToolUse", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("hold persists for tens of seconds while user thinks (no premature clear)", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // User stares at the TUI for 90 seconds (phone, lunch, deciding).
    // The hold MUST still be active.
    mock.timers.tick(90 * 1000);
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // After 10 minutes the safety cap finally releases.
    mock.timers.tick(10 * 60 * 1000);
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("CLAWD_KIMI_PERMISSION_MAX_MS=0 disables the safety timer entirely", () => {
    const old = process.env.CLAWD_KIMI_PERMISSION_MAX_MS;
    api.cleanup();
    try {
      process.env.CLAWD_KIMI_PERMISSION_MAX_MS = "0";
      ctx = makeCtx();
      api = require("../src/state")(ctx);

      api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
      assert.strictEqual(api.resolveDisplayState(), "notification");

      // Even an absurdly long wait should keep the hold.
      mock.timers.tick(60 * 60 * 1000); // 1h
      assert.strictEqual(api.resolveDisplayState(), "notification");
    } finally {
      if (old == null) delete process.env.CLAWD_KIMI_PERMISSION_MAX_MS;
      else process.env.CLAWD_KIMI_PERMISSION_MAX_MS = old;
    }
  });

  it("UserPromptSubmit clears the hold (Reject + tell-the-model path)", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    api.updateSession("kimi-a", "thinking", "UserPromptSubmit", { agentId: "kimi-cli" });
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
  });

  it("StopFailure clears the hold", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    api.updateSession("kimi-a", "error", "StopFailure", { agentId: "kimi-cli" });
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
  });

  it("a new PreToolUse for the same session drops the previous hold", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // New round starts: stale hold from the previous tool must not bleed in.
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      tool_name: "read_file",
    });
    // Without permission_suspect this is a non-gated tool — no new hold.
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("shows and clears Kimi notify bubble with hold lifecycle", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.deepStrictEqual(ctx._kimiNotifyShown, ["kimi-a"]);

    api.updateSession("kimi-a", "working", "PostToolUse", { agentId: "kimi-cli" });
    assert.deepStrictEqual(ctx._kimiNotifyCleared, ["kimi-a"]);
  });

  it("forwards repeated permission pulses so the bubble layer can refresh in place", () => {
    // Anti-stacking lives in showKimiNotifyBubble (per-session refresh, codex
    // idiom) — the state layer must keep forwarding so request #2's detail
    // replaces request #1's stale cue.
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.deepStrictEqual(ctx._kimiNotifyShown, ["kimi-a", "kimi-a"]);
  });

  it("forwards fresh detail while a hold is active so the cue never goes stale", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Bash",
      permissionCommand: "ls -la",
      permissionToolInput: { command: "ls -la" },
    });
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Bash",
      permissionCommand: "rm -rf build",
      permissionToolInput: { command: "rm -rf build" },
    });
    assert.strictEqual(ctx._kimiNotifyDetails.length, 2);
    const second = ctx._kimiNotifyDetails[1];
    assert.strictEqual(second.permissionCommand, "rm -rf build");
    assert.deepStrictEqual(second.permissionToolInput, { command: "rm -rf build" });
  });

  it("forwards native permission detail incl. structured tool_input to the notify bubble", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Write",
      permissionAction: "Writing: cue-probe.txt",
      permissionToolInput: { file_path: "cue-probe.txt" },
    });
    assert.strictEqual(ctx._kimiNotifyDetails.length, 1);
    const detail = ctx._kimiNotifyDetails[0];
    assert.strictEqual(detail.toolName, "Write");
    assert.strictEqual(detail.permissionAction, "Writing: cue-probe.txt");
    assert.deepStrictEqual(detail.permissionToolInput, { file_path: "cue-probe.txt" });
  });

  it("legacy permission pulses pass null tool_input to the notify bubble", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "shell",
    });
    assert.strictEqual(ctx._kimiNotifyDetails.length, 1);
    assert.strictEqual(ctx._kimiNotifyDetails[0].permissionToolInput, null);
  });

  it("clears Kimi notify bubble when clearSessionsByAgent disposes the hold", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.deepStrictEqual(ctx._kimiNotifyShown, ["kimi-a"]);
    // settings-actions normally pairs this with dismissPermissionsByAgent;
    // we still want the bubble cleared if a direct caller doesn't.
    const removed = api.clearSessionsByAgent("kimi-cli");
    assert.ok(removed >= 1);
    assert.ok(ctx._kimiNotifyCleared.includes("kimi-a"));
  });

  it("does not create a new Kimi hold while DND is active", () => {
    api.enableDoNotDisturb();
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    // Sanity: hold was suppressed, so the lock should NOT be active and the
    // bubble channel should NOT have been called.
    assert.deepStrictEqual(ctx._kimiNotifyShown, []);

    // Turn DND off and confirm the pet does not pin notification.
    api.disableDoNotDisturb();
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
  });

  it("clears existing Kimi holds when DND is enabled", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");
    api.enableDoNotDisturb();
    // The hold must have been dropped by enableDoNotDisturb. After turning
    // DND off the pet should not snap back to a permanent notification
    // animation with no bubble to show.
    api.disableDoNotDisturb();
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
  });

  it("does not create a hold when Kimi permissions are disabled", () => {
    ctx.isAgentPermissionsEnabled = (id) => id !== "kimi-cli";
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    // Pre-fix the setState("notification") ran unconditionally before the
    // hold gate, so the pet flashed notification with no follow-up bubble
    // when the user had disabled Kimi permissions in Settings. Asserting
    // currentState (not just resolveDisplayState) catches that regression.
    assert.deepStrictEqual(ctx._kimiNotifyShown, []);
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
    assert.notStrictEqual(api.getCurrentState(), "notification");
  });

  it("disposeAllKimiPermissionState clears holds without triggering a state resolve", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");
    const disposed = api.disposeAllKimiPermissionState();
    assert.strictEqual(disposed, true);
    // After disposal the lock must be gone — this is the function main.js
    // calls from _deferredDismissPermissionsByAgent when the user toggles
    // permissionsEnabled=false for Kimi.
    assert.notStrictEqual(api.resolveDisplayState(), "notification");
    // Idempotent: calling again with nothing to clear returns false.
    assert.strictEqual(api.disposeAllKimiPermissionState(), false);
  });
});

describe("Kimi permission suspect heuristic", () => {
  let api;
  let ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("keeps pet on working during the suspect window (no instant flash)", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    // Immediately after PreToolUse the pet should look like normal working,
    // not notification — this is the fix for the "animation plays before
    // Kimi actually asks" complaint.
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("auto-approved tools cancel the suspect timer (no notification flashes)", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    // PostToolUse arrives well within the 800ms default window.
    mock.timers.tick(100);
    api.updateSession("kimi-a", "working", "PostToolUse", { agentId: "kimi-cli" });
    // Exhaust any remaining time — the suspect timer must not fire.
    mock.timers.tick(5000);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("promotes to notification hold if no PostToolUse arrives in time", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    // Default suspect window is 800ms; let it expire.
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentState(), "notification");
    assert.strictEqual(api.resolveDisplayState(), "notification");
  });

  it("does not let a heuristic Kimi hold swallow another agent's one-shot", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentState(), "notification");

    api.updateSession("claude-a", "attention", "Stop", { agentId: "claude-code" });
    // The current notification finishes its minimum display interval, then
    // the external one-shot plays instead of being dropped.
    mock.timers.tick(5000);
    assert.strictEqual(api.getCurrentState(), "attention");

    // Once the one-shot finishes, the still-pending Kimi cue becomes visible
    // again instead of being lost permanently.
    mock.timers.tick(5000);
    assert.strictEqual(api.getCurrentState(), "notification");
    assert.strictEqual(api.resolveDisplayState(), "notification");
  });

  it("PostToolUseFailure also cancels suspect (error path is treated as auto-approved)", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    mock.timers.tick(100);
    api.updateSession("kimi-a", "error", "PostToolUseFailure", { agentId: "kimi-cli" });
    mock.timers.tick(5000);
    // Error state wins but notification must not have triggered.
    assert.notStrictEqual(api.getCurrentState(), "notification");
  });

  it("SessionEnd cancels any pending suspect timer", () => {
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      permissionSuspect: true,
    });
    api.updateSession("kimi-a", "sleeping", "SessionEnd", { agentId: "kimi-cli" });
    mock.timers.tick(5000);
    // Session is gone and suspect should not have promoted.
    assert.notStrictEqual(api.getCurrentState(), "notification");
    assert.strictEqual(api.sessions.has("kimi-a"), false);
  });
});

describe("Global permission animation lock", () => {
  let api;
  let ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("forces notification as highest-priority display while Kimi permission hold is pending", () => {
    api.sessions.set("s1", { state: "working", updatedAt: Date.now(), headless: false });
    assert.strictEqual(api.resolveDisplayState(), "working");

    api.updateSession("k1", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");
  });

  it("blocks oneshot state transitions while Kimi hold is pending", () => {
    api.updateSession("k1", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.getCurrentState(), "notification");

    api.updateSession("s1", "attention", "Stop", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("resumes normal state resolution after Kimi hold is cleared", () => {
    api.sessions.set("s1", { state: "working", updatedAt: Date.now(), headless: false });
    api.updateSession("k1", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    api.updateSession("k1", "working", "PostToolUse", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "working");
  });
});

// Batched approvals: legacy kimi-cli fires every queued PreToolUse up front,
// then blocks on the approval TUI one tool at a time. The gate ledger must
// re-surface a cue for each remaining approval after the previous one is
// answered — without it only the FIRST prompt ever gets a card.
describe("Kimi permission gate ledger (batched approvals)", () => {
  let api;
  let ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  const gatedPre = (sid, gateId, detail = {}) => api.updateSession(sid, "working", "PreToolUse", {
    agentId: "kimi-cli",
    permissionSuspect: true,
    permissionGateOpen: true,
    permissionGateId: gateId,
    toolName: detail.toolName ?? null,
    permissionAction: detail.permissionAction ?? null,
    permissionCommand: detail.permissionCommand ?? null,
    permissionToolInput: detail.permissionToolInput ?? null,
  });

  const gatedPost = (sid, gateId, event = "PostToolUse") => api.updateSession(
    sid,
    event === "PostToolUseFailure" ? "error" : "working",
    event,
    { agentId: "kimi-cli", permissionGated: true, permissionGateId: gateId }
  );

  it("re-arms a second cue with the next gate's detail after the first batched approval (core defect repro)", () => {
    gatedPre("kimi-a", "t1", { toolName: "write_file", permissionToolInput: { file_path: "a.txt" } });
    gatedPre("kimi-a", "t2", { toolName: "shell", permissionToolInput: { command: "Remove-Item a.txt" } });

    // Suspect window expires -> first cue, described by the OLDEST gate (t1),
    // not by the PreToolUse that happened to arrive last.
    mock.timers.tick(1000);
    assert.strictEqual(api.resolveDisplayState(), "notification");
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(ctx._kimiNotifyDetails[0].toolName, "write_file");

    // User answers #1 in the terminal: cue drops instantly (no stuck
    // notification), then the pending t2 re-arms its own cue ~800ms later.
    gatedPost("kimi-a", "t1");
    assert.strictEqual(api.resolveDisplayState(), "working");
    mock.timers.tick(1000);
    assert.strictEqual(api.resolveDisplayState(), "notification");
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, "shell");
    assert.deepStrictEqual(ctx._kimiNotifyDetails[1].permissionToolInput, { command: "Remove-Item a.txt" });

    // Answering #2 settles everything — no third cue ever.
    gatedPost("kimi-a", "t2");
    assert.strictEqual(api.resolveDisplayState(), "working");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
  });

  it("single gated call does not regress: one cue, no re-arm", () => {
    gatedPre("kimi-a", "t1", { toolName: "shell" });
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    gatedPost("kimi-a", "t1");
    assert.strictEqual(api.resolveDisplayState(), "working");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("preserves the first gated cue when a later batched Pre is non-gated", () => {
    gatedPre("kimi-a", "t1", { toolName: "shell", permissionToolInput: { command: "Remove-Item a.txt" } });
    api.updateSession("kimi-a", "working", "PreToolUse", {
      agentId: "kimi-cli",
      toolName: "read_file",
    });

    mock.timers.tick(1000);
    assert.strictEqual(api.resolveDisplayState(), "notification");
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(ctx._kimiNotifyDetails[0].toolName, "shell");
  });

  it("auto-approved chain never flashes: consecutive gated Posts inside the window cancel the re-arm", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(100);
    gatedPost("kimi-a", "t1");
    mock.timers.tick(100);
    gatedPost("kimi-a", "t2");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 0);
    assert.notStrictEqual(api.getCurrentState(), "notification");
  });

  it("synthesized immediate PermissionRequests join the ledger, keep the cue on the queue head, and re-arm after each answer", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      permissionGateOpen: true,
      permissionGateId: "t1",
      toolName: "shell",
      permissionCommand: "npm install",
    });
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(ctx._kimiNotifyDetails[0].toolName, "shell");

    // Batched request #2 lands while the terminal still blocks on #1: the
    // refreshed card must KEEP describing the queue head (t1), not flip to
    // the newest arrival.
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      permissionGateOpen: true,
      permissionGateId: "t2",
      toolName: "write_file",
    });
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, "shell");
    assert.strictEqual(ctx._kimiNotifyDetails[1].permissionCommand, "npm install");

    gatedPost("kimi-a", "t1");
    mock.timers.tick(1000);
    // Re-armed cue advances to the remaining gate's detail.
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
    assert.strictEqual(ctx._kimiNotifyDetails[2].toolName, "write_file");

    gatedPost("kimi-a", "t2");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
  });

  it("native Kimi Code PermissionRequests keep refresh-to-newest semantics (no gate marker)", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Bash",
      permissionCommand: "echo one",
    });
    // Native events fire when their prompt is really on screen — a second
    // request means the terminal moved on, so the card follows the newest.
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Write",
      permissionAction: "Writing: b.txt",
    });
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, "Write");
    assert.strictEqual(ctx._kimiNotifyDetails[1].permissionAction, "Writing: b.txt");
  });

  it("native Kimi Code PermissionRequests (no gate marker) stay out of the ledger", () => {
    api.updateSession("kimi-a", "notification", "PermissionRequest", {
      agentId: "kimi-cli",
      toolName: "Bash",
      permissionCommand: "echo hi",
    });
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    // Non-gated Post (Kimi Code tool names never match the legacy gate set).
    api.updateSession("kimi-a", "working", "PostToolUse", { agentId: "kimi-cli" });
    mock.timers.tick(5000);
    // No ledger entry -> no re-arm, exactly the pre-ledger behavior.
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("id semantics: unknown-id Post is a no-op on the ledger; duplicate opens refresh in place; out-of-order Posts pair exactly", () => {
    gatedPre("kimi-a", "t1", { toolName: "write_file" });
    gatedPre("kimi-a", "t1", { toolName: "write_file" }); // duplicate open refreshes, no queue inflation
    gatedPre("kimi-a", "t2", { toolName: "shell" });
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    // Out-of-order: t2 settles first — t1 must survive and drive the re-arm.
    gatedPost("kimi-a", "t2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, "write_file");

    // Unknown id: ledger untouched (t1 still pending), cue re-arms again.
    gatedPost("kimi-a", "t-unknown");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
    assert.strictEqual(ctx._kimiNotifyDetails[2].toolName, "write_file");

    gatedPost("kimi-a", "t1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
  });

  it("anonymous gates close FIFO and mixed queues keep exact-id pairing separate", () => {
    gatedPre("kimi-a", null, { toolName: "write_file" }); // anon #1 (oldest)
    gatedPre("kimi-a", "t2", { toolName: "shell" });
    gatedPre("kimi-a", null, { toolName: "background" }); // anon #2
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.strictEqual(ctx._kimiNotifyDetails[0].toolName, "write_file");

    // Anonymous Post settles the OLDEST anonymous gate (anon #1), never t2.
    gatedPost("kimi-a", null);
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, "shell");

    gatedPost("kimi-a", "t2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
    assert.strictEqual(ctx._kimiNotifyDetails[2].toolName, "background");

    gatedPost("kimi-a", null);
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 3);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("null detail (old hook without forwarding) degrades to the generic cue", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(1000);
    gatedPost("kimi-a", "t1");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    assert.strictEqual(ctx._kimiNotifyDetails[1].toolName, null);
    assert.strictEqual(ctx._kimiNotifyDetails[1].permissionToolInput, null);
  });

  it("turn-level events drop the ledger: no re-arm after UserPromptSubmit", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    // Reject-and-tell-model: the whole approval context is gone.
    api.updateSession("kimi-a", "thinking", "UserPromptSubmit", { agentId: "kimi-cli" });
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
    assert.notStrictEqual(api.getCurrentState(), "notification");

    // A later gated Post must not resurrect anything either.
    gatedPost("kimi-a", "t1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
  });

  it("Stop and SessionEnd drop the ledger", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(1000);
    api.updateSession("kimi-a", "attention", "Stop", { agentId: "kimi-cli" });
    gatedPost("kimi-a", "t1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    gatedPre("kimi-b", "u1");
    gatedPre("kimi-b", "u2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
    api.updateSession("kimi-b", "sleeping", "SessionEnd", { agentId: "kimi-cli" });
    gatedPost("kimi-b", "u1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 2);
  });

  it("safety cap drops the ledger with the cue", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    // Every release signal is lost; the 10-minute cap fires and must take the
    // stale ledger with it.
    mock.timers.tick(10 * 60 * 1000);
    assert.notStrictEqual(api.getCurrentState(), "notification");

    // A straggler Post can no longer re-arm anything.
    gatedPost("kimi-a", "t1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
  });

  it("disposeAllKimiPermissionState (DND / permissions-off path) clears queued gates", () => {
    gatedPre("kimi-a", "t1");
    gatedPre("kimi-a", "t2");
    mock.timers.tick(1000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);

    api.disposeAllKimiPermissionState();
    gatedPost("kimi-a", "t1");
    mock.timers.tick(5000);
    assert.strictEqual(ctx._kimiNotifyShown.length, 1);
  });
});
