const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");

themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx() {
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
    showSessionId: false,
    focusTerminalWindow: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  };
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

  it("forces notification as highest-priority display while permissions are pending", () => {
    api.sessions.set("s1", { state: "working", updatedAt: Date.now(), headless: false });
    assert.strictEqual(api.resolveDisplayState(), "working");

    ctx.pendingPermissions.push({ sessionId: "s1", toolName: "Bash" });
    assert.strictEqual(api.resolveDisplayState(), "notification");
  });

  it("blocks oneshot state transitions while permissions are pending", () => {
    ctx.pendingPermissions.push({ sessionId: "s1", toolName: "Bash" });
    api.updateSession("s1", "notification", "PermissionRequest", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "notification");

    api.updateSession("s1", "attention", "Stop", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("resumes normal state resolution after permission queue is cleared", () => {
    api.sessions.set("s1", { state: "working", updatedAt: Date.now(), headless: false });
    ctx.pendingPermissions.push({ sessionId: "s1", toolName: "Bash" });
    assert.strictEqual(api.resolveDisplayState(), "notification");

    ctx.pendingPermissions.length = 0;
    assert.strictEqual(api.resolveDisplayState(), "working");
  });
});
