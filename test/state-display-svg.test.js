const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx() {
  return {
    theme: _defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    mouseStillSince: Date.now(),
    playSound() {},
    sendToRenderer() {},
    syncHitWin() {},
    sendToHitWin() {},
    miniPeekIn() {},
    miniPeekOut() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    pendingPermissions: [],
    resolvePermissionEntry() {},
    t: (k) => k,
    focusTerminalWindow() {},
  };
}

describe("display_svg session hints (updateSession path)", () => {
  let api;
  const pid = process.pid;

  beforeEach(() => {
    api = require("../src/state")(makeCtx());
  });

  function baseOpts(overrides = {}) {
    return {
      cwd: "/tmp",
      editor: "cursor",
      agentPid: pid,
      agentId: "cursor-agent",
      ...overrides,
    };
  }

  it("uses allowlisted display_svg for working state", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "clawd-working-building.svg" }));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
  });

  it("falls back to getWorkingSvg when no hint", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts());
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("ignores non-allowlisted svg and falls back", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "evil.svg" }));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("picks the most recently updated session among working sessions", async () => {
    api.updateSession("a", "working", "PreToolUse", baseOpts({ cwd: "/a", displayHint: "clawd-working-building.svg" }));
    await new Promise((r) => setTimeout(r, 5));
    api.updateSession("b", "working", "PostToolUse", baseOpts({ cwd: "/b", displayHint: "clawd-idle-reading.svg" }));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-idle-reading.svg");
  });

  it("clears hint when display_svg is null", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "clawd-working-building.svg" }));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
    api.updateSession("c1", "working", "PostToolUse", baseOpts({ displayHint: null }));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("applies thinking hint for thinking state", () => {
    api.updateSession("c1", "thinking", "AfterAgentThought", baseOpts({ displayHint: "clawd-working-thinking.svg" }));
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-thinking.svg");
  });

  it("shows painting for /design and heart eyes at its Claude Stop", async () => {
    const previousDebounce = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    try {
      const claude = baseOpts({ agentId: "claude-code" });
      api.updateSession("design", "thinking", "UserPromptExpansion", { ...claude, displayHint: "claude-design" });
      assert.strictEqual(api.getSvgOverride("thinking"), "clawd-designing.svg");
      api.updateSession("design", "working", "PreToolUse", claude);
      assert.strictEqual(api.getSvgOverride("working"), "clawd-designing.svg");
      api.updateSession("design", "attention", "Stop", claude);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      assert.strictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
    } finally {
      if (previousDebounce === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
      else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = previousDebounce;
    }
  });

  it("keeps painting during the completion hold, then shows heart eyes", async () => {
    const previousDebounce = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
    try {
      const claude = baseOpts({ agentId: "claude-code" });
      api.updateSession("design-held", "thinking", "UserPromptExpansion", {
        ...claude, displayHint: "claude-design",
      });
      api.updateSession("design-held", "attention", "Stop", claude);
      assert.strictEqual(api.getCurrentSvg(), "clawd-designing.svg");
      await new Promise((resolve) => setTimeout(resolve, 2150));
      assert.strictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
    } finally {
      if (previousDebounce === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
      else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = previousDebounce;
    }
  });
});

// #509: user-selected default idle visual flows through state.js
describe("default idle visual (getIdleVisualChoice ctx hook)", () => {
  it("getSvgOverride('idle') returns the user choice when set", () => {
    const ctx = makeCtx();
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    const api = require("../src/state")(ctx);
    assert.strictEqual(api.getSvgOverride("idle"), "clawd-idle-reading.svg");
  });

  it("getSvgOverride('idle') falls back to the follow sprite when unset", () => {
    const ctx = makeCtx();
    ctx.getIdleVisualChoice = () => null;
    const api = require("../src/state")(ctx);
    assert.strictEqual(api.getSvgOverride("idle"), "clawd-idle-follow.svg");

    const apiNoHook = require("../src/state")(makeCtx());
    assert.strictEqual(apiNoHook.getSvgOverride("idle"), "clawd-idle-follow.svg");
  });

  it("applyState('idle') with no override rests on the user choice", () => {
    const ctx = makeCtx();
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    const api = require("../src/state")(ctx);
    api.applyState("idle");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-reading.svg");
  });

  it("applyState('idle') without the hook keeps today's behavior", () => {
    const api = require("../src/state")(makeCtx());
    api.applyState("idle");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-follow.svg");
  });

  it("an explicit svgOverride still wins over the user choice", () => {
    const ctx = makeCtx();
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    const api = require("../src/state")(ctx);
    api.applyState("idle", "clawd-idle-bubble.svg");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-bubble.svg");
  });
});
