"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");

const {
  shouldShowStateNotify,
  shouldClearStateNotify,
  buildStateNotifyCopy,
} = require("../src/state-notify-bubble");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");
const bubbleCss = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.css"), "utf8");
const permissionSource = fs.readFileSync(path.join(__dirname, "..", "src", "permission.js"), "utf8");

function makeCtx(overrides = {}) {
  return {
    lang: "zh-TW",
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
    dismissPermissionsForDnd: () => {},
    focusTerminalWindow: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
}

describe("state notify bubbles", () => {
  it("only shows fixed-text bubbles for interactive Hermes/Codex state changes", () => {
    assert.strictEqual(shouldShowStateNotify({ agentId: "hermes", state: "thinking", event: "UserPromptSubmit" }), true);
    assert.strictEqual(shouldShowStateNotify({ agentId: "codex", state: "working", event: "PreToolUse" }), true);
    assert.strictEqual(shouldShowStateNotify({ agentId: "claude-code", state: "thinking", event: "UserPromptSubmit" }), false);
    assert.strictEqual(shouldShowStateNotify({ agentId: "hermes", state: "thinking", event: "UserPromptSubmit", headless: true }), false);
    assert.strictEqual(shouldShowStateNotify({ agentId: "hermes", state: "notification", event: "PermissionRequest" }), false);
  });

  it("clears bubbles when a session ends or returns to idle/sleeping", () => {
    assert.strictEqual(shouldClearStateNotify({ state: "sleeping" }), true);
    assert.strictEqual(shouldClearStateNotify({ state: "idle" }), true);
    assert.strictEqual(shouldClearStateNotify({ state: "thinking" }), false);
    assert.strictEqual(shouldClearStateNotify({ state: "working", event: "SessionEnd" }), true);
  });

  it("builds localized tag copy without raw prompt/code fields", () => {
    const copy = buildStateNotifyCopy({
      lang: "zh-TW",
      agentId: "hermes",
      state: "working",
      event: "PreToolUse",
      toolName: "terminal",
      model: "gpt-5.5",
      provider: "openai-codex",
      contextUsage: { percent: 42 },
    });
    assert.deepStrictEqual(Object.keys(copy).sort(), ["agentLabel", "badgeLabel", "state", "statusLabel"]);
    assert.strictEqual(copy.agentLabel, "Phoebe");
    assert.strictEqual(copy.badgeLabel, "PHOEBE · 處理中");
    assert.ok(!JSON.stringify(copy).includes("terminal"));
    assert.ok(!JSON.stringify(copy).includes("gpt-5.5"));
    assert.ok(!JSON.stringify(copy).includes("api_key"));
  });

  it("renders state bubbles as a minimal non-actionable tag", () => {
    assert.match(bubbleRenderer, /card\.classList\.add\("state-notify"\)/);
    assert.match(bubbleRenderer, /actionsContainer\) actionsContainer\.style\.display = "none"/);
    const stateBlockStart = bubbleRenderer.indexOf('data.toolName === "ClawdStateNotify"');
    const codexBlockStart = bubbleRenderer.indexOf('data.toolName === "CodexExec"');
    assert.ok(stateBlockStart >= 0 && codexBlockStart > stateBlockStart);
    const stateBlock = bubbleRenderer.slice(stateBlockStart, codexBlockStart);
    assert.doesNotMatch(stateBlock, /bubbleText\(data\.lang, "gotIt"\)/);
    assert.doesNotMatch(stateBlock, /renderStateDetails/);
    assert.match(stateBlock, /commandBlock\.style\.display = "none"/);
    assert.match(bubbleRenderer, /document\.body\.classList\.add\("state-notify-body"\)/);
    assert.match(bubbleCss, /body\.state-notify-body[\s\S]*?align-items: flex-end;/);
    assert.match(bubbleCss, /\/\* ── Minimal state tag ── \*\//);
    assert.match(bubbleCss, /\.card\.state-notify \{[\s\S]*?width: fit-content;/);
    assert.match(bubbleCss, /@keyframes state-tag-flow/);
    assert.match(bubbleCss, /\.card\.state-notify \.command-block,[\s\S]*?display: none !important;/);
    assert.match(bubbleCss, /\.tool-pill\[data-tool="ClawdStateNotify"\]/);
  });

  it("keeps active state notify tags visible but auto-hides completion after 30s", () => {
    assert.match(permissionSource, /const STATE_NOTIFY_DONE_AUTO_CLOSE_MS = 30 \* 1000/);
    const helperStart = permissionSource.indexOf("function scheduleStateNotifyCompletionExpire");
    const showStart = permissionSource.indexOf("function showStateNotifyBubble");
    const showEnd = permissionSource.indexOf("function getPassiveNotifyAgentId");
    assert.ok(helperStart >= 0 && showStart > helperStart && showEnd > showStart);
    const helperBlock = permissionSource.slice(helperStart, showStart);
    const showBlock = permissionSource.slice(showStart, showEnd);
    assert.match(helperBlock, /isStateNotifyCompletionState\(state\)/);
    assert.match(helperBlock, /schedulePassiveNotifyAutoExpire\(permEntry, STATE_NOTIFY_DONE_AUTO_CLOSE_MS\)/);
    assert.match(showBlock, /scheduleStateNotifyCompletionExpire\(existing, state\)/);
    assert.match(showBlock, /scheduleStateNotifyCompletionExpire\(permEntry, state\)/);
    assert.doesNotMatch(showBlock, /notificationBubbleAutoCloseSeconds/);
  });
});

describe("state notify integration", () => {
  let api;
  let calls;
  let clears;

  beforeEach(() => {
    calls = [];
    clears = [];
    api = require("../src/state")(makeCtx({
      showStateNotifyBubble: (payload) => calls.push(payload),
      clearStateNotifyBubbles: (...args) => clears.push(args),
    }));
  });

  afterEach(() => { api.cleanup(); });

  it("emits fixed-text notify requests for Hermes/Codex state events", () => {
    api.updateSession("h1", "thinking", "UserPromptSubmit", { agentId: "hermes" });
    api.updateSession("h1", "working", "PreToolUse", {
      agentId: "hermes",
      toolName: "terminal",
      model: "gpt-5.5",
      provider: "openai-codex",
      contextUsage: { percent: 42 },
    });
    api.updateSession("c1", "thinking", "UserPromptSubmit", { agentId: "codex" });
    api.updateSession("cc1", "thinking", "UserPromptSubmit", { agentId: "claude-code" });

    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(calls.map((c) => c.agentId), ["hermes", "hermes", "codex"]);
    assert.strictEqual(calls[1].toolName, "terminal");
    assert.strictEqual(calls[1].model, "gpt-5.5");
    assert.strictEqual(calls[1].provider, "openai-codex");
  });

  it("clears the state notify bubble on session end", () => {
    api.updateSession("h1", "thinking", "UserPromptSubmit", { agentId: "hermes" });
    api.updateSession("h1", "sleeping", "SessionEnd", { agentId: "hermes" });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(clears.length, 1);
    assert.strictEqual(clears[0][0], "h1");
  });
});
