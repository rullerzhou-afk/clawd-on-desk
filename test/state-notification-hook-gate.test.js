"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");

themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx({ notificationHookEnabled = true } = {}) {
  const rendererEvents = [];
  const soundsPlayed = [];
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
    playSound: (name) => { soundsPlayed.push(name); },
    sendToRenderer: (channel, ...args) => { rendererEvents.push([channel, ...args]); },
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    focusTerminalWindow: () => {},
    showKimiNotifyBubble: () => {},
    clearKimiNotifyBubbles: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    isAgentNotificationHookEnabled: () => notificationHookEnabled,
  };
  ctx._rendererEvents = rendererEvents;
  ctx._soundsPlayed = soundsPlayed;
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

describe("updateSession: Notification hook gate", () => {
  let api;
  let ctx;
  let savedDebounceEnv;

  beforeEach(() => {
    // These tests exercise the Notification gate, not the #406 completion
    // debounce — disable the debounce so a Claude Stop settles immediately.
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
  });

  afterEach(() => {
    if (api) api.cleanup();
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("mutes Notification bell + animation when the per-agent flag is off", () => {
    // Presentation-layer mute: session bookkeeping still runs (so the agent
    // stays visible in the Sessions menu, stale timers keep refreshing, and
    // Kimi hold-release cleanup still fires) — only the notification visual
    // and confirm sound are skipped. Mirrors the Animation Map "events still
    // fire" contract.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    assert.strictEqual(api.sessions.has("cc-1"), true, "session must still be registered (bookkeeping runs)");
    assert.strictEqual(api.sessions.get("cc-1").state, "idle", "session state resolves to idle after Notification");
    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "pet must still get a state-change (to idle, not notification)");
    assert.notStrictEqual(stateChanges[0][1], "notification", "must not enter notification state");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "confirm sound must not play");
  });

  it("lets Notification events through when the per-agent flag is on", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "notification state must be broadcast");
    assert.strictEqual(stateChanges[0][1], "notification");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "confirm sound must play");
  });

  it("mutes mini alert for post-completion idle Notification while keeping bookkeeping", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    ctx.miniMode = true;
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "mini-happy", "completion should still show mini-happy");

    mock.timers.tick(defaultTheme.timings.autoReturn["mini-happy"] + 1);
    assert.strictEqual(api.getCurrentState(), "mini-idle", "mini-happy should settle before the idle ping");
    ctx._rendererEvents.length = 0;
    ctx._soundsPlayed.length = 0;

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.every(([, s]) => s !== "mini-alert"), "post-completion idle ping must not show mini-alert");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "post-completion idle ping must not play confirm");
    assert.deepStrictEqual(
      api.sessions.get("cc-1").recentEvents.map((entry) => entry.event),
      ["Stop", "Notification"],
      "Notification event should still be recorded"
    );
  });

  it("keeps standalone mini Notification alerts enabled", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    ctx.miniMode = true;
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "standalone mini notification should still broadcast");
    assert.strictEqual(stateChanges[0][1], "mini-alert");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "standalone mini notification should still chime");
  });

  it("restores mini Notification alerts after user activity follows completion", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    ctx.miniMode = true;
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    mock.timers.tick(defaultTheme.timings.autoReturn["mini-happy"] + 1);
    ctx._rendererEvents.length = 0;
    ctx._soundsPlayed.length = 0;

    api.updateSession("cc-1", "thinking", "UserPromptSubmit", { agentId: "claude-code" });
    assert.strictEqual(
      api.sessions.get("cc-1").awaitingInputSinceStop,
      false,
      "new user activity should clear the post-completion idle tail"
    );
    ctx._rendererEvents.length = 0;
    ctx._soundsPlayed.length = 0;

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "notification after user activity should broadcast");
    assert.strictEqual(stateChanges[0][1], "mini-alert");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "notification after user activity should chime");
  });

  it("keeps post-completion Notification alerts enabled outside mini mode", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    mock.timers.tick(defaultTheme.timings.autoReturn.attention + 1);
    ctx._rendererEvents.length = 0;
    ctx._soundsPlayed.length = 0;

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "normal-mode wait-for-input alert should still broadcast");
    assert.strictEqual(stateChanges[0][1], "notification");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "normal-mode wait-for-input alert should still chime");
  });

  it("mutes Gemini Notification bell + animation when the per-agent flag is off", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("gemini-1", "notification", "Notification", { agentId: "gemini-cli" });

    assert.strictEqual(api.sessions.has("gemini-1"), true, "Gemini session must still be registered");
    assert.strictEqual(api.sessions.get("gemini-1").state, "idle", "Gemini Notification must still resolve bookkeeping");
    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "pet must still get a state-change broadcast");
    assert.notStrictEqual(stateChanges[0][1], "notification", "Gemini mute must skip notification state");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "Gemini mute must suppress confirm sound");
  });

  it("lets Gemini Notification through when the per-agent flag is on", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("gemini-1", "notification", "Notification", { agentId: "gemini-cli" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "Gemini notification state must be broadcast");
    assert.strictEqual(stateChanges[0][1], "notification");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "Gemini notification must play confirm sound");
  });

  it("mutes Qoder state-only permission notifications when the per-agent flag is off", () => {
    // Qoder is state-only: hooks/qoder-hook.js maps its PermissionRequest /
    // PermissionDenied events to a Clawd Notification event, so they ride this
    // per-agent mute gate like any passive notification. This is the opposite
    // of a real permission agent (next test), whose PermissionRequest keeps its
    // bell because Clawd actually answers that decision.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("qoder-1", "notification", "Notification", { agentId: "qoder" });

    assert.strictEqual(api.sessions.has("qoder-1"), true, "Qoder session must still be registered (bookkeeping runs)");
    assert.strictEqual(api.sessions.get("qoder-1").state, "idle", "Qoder Notification resolves bookkeeping to idle");
    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "pet must still get a state-change broadcast");
    assert.notStrictEqual(stateChanges[0][1], "notification", "muted: must not enter notification state");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "muted: confirm sound must not play");
  });

  it("lets Qoder state-only notifications through when the per-agent flag is on", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("qoder-1", "notification", "Notification", { agentId: "qoder" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "Qoder notification must broadcast");
    assert.strictEqual(stateChanges[0][1], "notification");
    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "Qoder notification must play confirm");
  });

  it("never drops PermissionRequest events even when the flag is off", () => {
    // Permission bubbles must keep their bell regardless of idle-alert prefs.
    // PermissionRequest is handled by the branch before the gate and never
    // reaches the Notification-hook check.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "PermissionRequest", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "permission request must still broadcast notification");
    assert.strictEqual(stateChanges[0][1], "notification");
  });

  it("can mute only the Codex native PermissionRequest prompt sound", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "notification", "PermissionRequest", {
      agentId: "codex",
      muteNotificationSound: true,
    });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "Codex native prompt must still show notification");
    assert.strictEqual(stateChanges[0][1], "notification");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "Codex native prompt sound must be muted");
  });

  it("lets Codex PermissionRequest play confirm when no mute flag is set", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "notification", "PermissionRequest", {
      agentId: "codex",
    });

    assert.deepStrictEqual(ctx._soundsPlayed, ["confirm"], "baseline prompt sound must still play");
  });

  it("keeps Codex native prompt sound muted across notification auto-return", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "notification", "PermissionRequest", {
      agentId: "codex",
      sourcePid: 123,
      muteNotificationSound: true,
    });

    assert.deepStrictEqual(ctx._soundsPlayed, [], "initial prompt sound must be muted");
    mock.timers.tick(defaultTheme.timings.autoReturn.notification + 1);
    assert.deepStrictEqual(ctx._soundsPlayed, [], "auto-return re-resolve must not replay confirm");
  });

  it("keeps Codex native prompt sound muted through the pending min-display path", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.applyState("attention");
    ctx._soundsPlayed.length = 0;
    api.updateSession("codex-1", "notification", "PermissionRequest", {
      agentId: "codex",
      muteNotificationSound: true,
    });

    assert.deepStrictEqual(ctx._soundsPlayed, [], "pending notification should not sound immediately");
    mock.timers.tick(defaultTheme.timings.minDisplay.attention + 1);
    assert.deepStrictEqual(ctx._soundsPlayed, [], "pending notification must preserve mute options");
  });

  it("mutes Codex native prompt sound in mini-alert mode", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    ctx.miniMode = true;
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "notification", "PermissionRequest", {
      agentId: "codex",
      muteNotificationSound: true,
    });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "mini mode should still show the alert animation");
    assert.strictEqual(stateChanges[0][1], "mini-alert");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "mini-alert prompt sound must be muted");
  });

  it("keeps Codex completion sound even when native prompt sound is muted", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "attention", "Stop", {
      agentId: "codex",
      muteNotificationSound: true,
    });

    assert.deepStrictEqual(ctx._soundsPlayed, ["complete"], "completion sound must still play");
  });

  it("never drops Elicitation events even when the flag is off", () => {
    // Elicitation fires notification state via a separate path (server.js
    // updateSession call with event="Elicitation"). The Notification gate
    // must be event-name-specific, not state-specific.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "Elicitation", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "elicitation must still broadcast notification");
  });

  it("lets non-Notification events through regardless of the flag", () => {
    // Non-notification events must not be touched by the gate. Use "working"
    // (a sticky state) as the probe since oneshots like attention auto-return
    // to idle and wouldn't prove the event landed.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "thinking", "UserPromptSubmit", { agentId: "claude-code" });
    api.updateSession("cc-1", "working", "PreToolUse", { agentId: "claude-code" });

    assert.ok(api.sessions.has("cc-1"), "session must be registered");
    assert.strictEqual(api.sessions.get("cc-1").state, "working", "working state must stick");
  });

  it("fails open when the ctx reader is missing", () => {
    // Mirror the existing agent-gate fail-open contract: a partial ctx
    // must not accidentally silence the pet.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: true });
    delete ctx.isAgentNotificationHookEnabled;
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "notification", "Notification", { agentId: "claude-code" });

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    assert.ok(stateChanges.length >= 1, "no reader → fail open → event must pass through");
  });

  it("uses the session's remembered agentId when the event omits it", () => {
    // An agent emits Notification without re-sending agent_id; the gate must
    // resolve the agent from the prior session entry (same pattern used by
    // PermissionRequest gating above).
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const perAgent = { "claude-code": false, "kimi-cli": true };
    ctx = makeCtx({ notificationHookEnabled: true });
    ctx.isAgentNotificationHookEnabled = (id) => perAgent[id] !== false;
    api = require("../src/state")(ctx);

    // Prime the session with its agentId via a normal event.
    api.updateSession("cc-1", "thinking", "UserPromptSubmit", { agentId: "claude-code" });
    ctx._rendererEvents.length = 0;
    ctx._soundsPlayed.length = 0;

    // Now send Notification without agentId — gate must still mute for CC.
    api.updateSession("cc-1", "notification", "Notification", {});

    const stateChanges = ctx._rendererEvents.filter(([ch]) => ch === "state-change");
    // Pet still gets a broadcast (fall-through to resolveDisplayState), but
    // never enters notification state and never plays the bell.
    assert.ok(stateChanges.every(([, s]) => s !== "notification"), "must not enter notification state");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "no bell when gate resolves agentId from session");
  });

  it("does not break Kimi hold-release when the flag is off", () => {
    // Regression guard: Kimi's permission hold is cleared by a subsequent
    // `Notification` event (KIMI_HOLD_CLEAR_EVENTS in state.js). An earlier
    // version of this gate early-returned at the top of updateSession, which
    // skipped the Kimi cleanup and left the pet pinned on notification until
    // the 10-minute safety timeout. The presentation-layer gate must run
    // *after* the Kimi cleanup block so hold-release keeps working.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ notificationHookEnabled: false });
    api = require("../src/state")(ctx);

    // Open a Kimi permission hold — pet pins on notification.
    api.updateSession("kimi-a", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    assert.strictEqual(api.resolveDisplayState(), "notification", "hold pins display");

    // Kimi emits Notification with the toggle off. The bell must be muted
    // *and* the hold must release so the pet returns to idle.
    api.updateSession("kimi-a", "notification", "Notification", { agentId: "kimi-cli" });

    assert.strictEqual(
      api.resolveDisplayState(),
      "idle",
      "Kimi hold must release even when the Notification bell is muted"
    );
  });
});
