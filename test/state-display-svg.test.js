const { describe, it, beforeEach, afterEach, mock } = require("node:test");
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


describe("Claude design turn continuity", () => {
  let api;
  let savedDebounce;
  const claude = { cwd: "/tmp", agentId: "claude-code", agentPid: process.pid };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    savedDebounce = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    const ctx = makeCtx();
    ctx.theme = structuredClone(_defaultTheme);
    // Skip visual minimum holds so assertions inspect the event's own cue.
    ctx.theme.timings.minDisplay = Object.fromEntries(
      Object.keys(ctx.theme.timings.minDisplay).map((state) => [state, 0]),
    );
    api = require("../src/state")(ctx);
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
    if (savedDebounce === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounce;
  });

  function startDesign(opts = claude) {
    api.updateSession("design", "thinking", "UserPromptExpansion", {
      ...opts, displayHint: "claude-design",
    });
    api.updateSession("design", "working", "PreToolUse", opts);
  }

  function finishDesign() {
    api.updateSession("design", "working", "PreToolUse", claude);
    assert.strictEqual(api.getCurrentSvg(), "clawd-designing.svg");
    api.updateSession("design", "attention", "Stop", claude);
    assert.strictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
    assert.strictEqual(api.sessions.get("design").displayHint, null);
  }

  for (const [event, state] of [
    ["PostToolUseFailure", "error"],
    ["Notification", "notification"],
    ["Elicitation", "notification"],
    ["PreCompact", "sweeping"],
    ["WorktreeCreate", "carrying"],
  ]) {
    it(`retains the turn hint through ${event}, while showing its normal cue`, () => {
      startDesign();
      api.updateSession("design", state, event, claude);
      assert.strictEqual(api.getCurrentState(), state);
      assert.strictEqual(api.sessions.get("design").state, "idle");
      assert.strictEqual(api.sessions.get("design").displayHint, "claude-design");
      assert.notStrictEqual(api.getSvgOverride("idle"), "clawd-designing.svg");
      finishDesign();
    });
  }

  it("preserves the hint across a complete automatic compaction lifecycle", () => {
    startDesign();
    api.updateSession("design", "sweeping", "PreCompact", claude);
    api.updateSession("design", "idle", "SessionStart", { ...claude, sessionStartSource: "compact" });
    assert.strictEqual(api.sessions.get("design").displayHint, "claude-design");
    api.updateSession("design", "thinking", "PostCompact", claude);
    assert.strictEqual(api.getCurrentSvg(), "clawd-designing.svg");
    finishDesign();
  });

  it("keeps the completion hint when a notification arrives in the Stop debounce window", () => {
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
    startDesign();
    api.updateSession("design", "attention", "Stop", claude);
    api.updateSession("design", "notification", "Notification", claude);
    assert.strictEqual(api.getCurrentState(), "notification");
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
    assert.strictEqual(api.sessions.get("design").displayHint, null);
  });

  for (const [event, state, extra] of [
    ["StopFailure", "error", {}],
    ["ApiError", "error", {}],
    ["SessionEnd", "sleeping", {}],
    ["SessionStart", "idle", { sessionStartSource: "startup" }],
    ["SessionStart", "idle", { sessionStartSource: "clear" }],
  ]) {
    it(`clears the design hint at ${event}/${extra.sessionStartSource || state}`, () => {
      startDesign();
      api.updateSession("design", state, event, { ...claude, ...extra });
      assert.notStrictEqual(api.sessions.get("design")?.displayHint, "claude-design");
      assert.notStrictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
      api.updateSession("design", "working", "PreToolUse", claude);
      api.updateSession("design", "attention", "Stop", claude);
      assert.strictEqual(api.getCurrentSvg(), "clawd-happy.svg");
    });
  }

  it("clears the hint on the next ordinary prompt and honors explicit null on an interruption", () => {
    startDesign();
    api.updateSession("design", "notification", "Notification", claude);
    api.updateSession("design", "thinking", "UserPromptSubmit", { ...claude, displayHint: null });
    assert.strictEqual(api.sessions.get("design").displayHint, null);
    assert.strictEqual(api.getCurrentSvg(), "clawd-working-thinking.svg");
    startDesign();
    api.updateSession("design", "notification", "Notification", { ...claude, displayHint: null });
    assert.strictEqual(api.sessions.get("design").displayHint, null);
  });

  it("does not preserve a Claude turn hint for another agent", () => {
    const opts = { ...claude, agentId: "cursor-agent" };
    startDesign(opts);
    api.updateSession("design", "notification", "Notification", opts);
    assert.strictEqual(api.sessions.get("design").displayHint, null);
    api.updateSession("design", "working", "PreToolUse", opts);
    api.updateSession("design", "attention", "Stop", opts);
    assert.notStrictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
  });

  it("does not let a child Stop consume the parent's design completion", () => {
    startDesign();
    api.updateSession("design", "attention", "Stop", { ...claude, subagentId: "child-design" });
    assert.notStrictEqual(api.getCurrentSvg(), "clawd-heart-eyes.svg");
    assert.strictEqual(api.sessions.get("design").displayHint, "claude-design");
  });

  it("does not retain an ordinary per-tool visual hint across a notification", () => {
    api.updateSession("tool", "working", "PreToolUse", {
      ...claude, displayHint: "clawd-working-building.svg",
    });
    api.updateSession("tool", "notification", "Notification", claude);
    assert.strictEqual(api.sessions.get("tool").displayHint, null);
  });
});

describe("multi-file thinking / working pools", () => {
  let api;
  let random;
  const opts = { cwd: "/tmp", editor: "cursor", agentPid: process.pid, agentId: "cursor-agent" };
  const THINKING = ["clawd-working-thinking.svg", "clawd-idle-reading.svg", "clawd-working-debugger.svg"];
  const ONE_SESSION = ["clawd-working-typing.svg", "clawd-working-building.svg"];
  const TWO_SESSIONS = ["clawd-headphones-groove.svg", "clawd-working-juggling.svg"];

  function poolTheme() {
    const theme = structuredClone(_defaultTheme);
    delete theme._stateBindings;
    theme.timings.minDisplay = Object.fromEntries(
      Object.keys(theme.timings.minDisplay).map((state) => [state, 0]),
    );
    theme.states.thinking = [...THINKING];
    theme.workingTiers = [
      { minSessions: 2, files: [...TWO_SESSIONS] },
      { minSessions: 1, file: ONE_SESSION[0], files: [...ONE_SESSION] },
    ];
    return theme;
  }

  function useRolls(...values) {
    random = mock.method(Math, "random", () => (values.length > 0 ? values.shift() : 0));
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    if (api) api.cleanup();
    api = null;
    mock.timers.reset();
    mock.restoreAll();
  });

  it("keeps one drawn clip while the state lasts and draws again on re-entry", () => {
    useRolls(0, 0.99, 0.99);
    api = require("../src/state")({ ...makeCtx(), theme: poolTheme() });

    api.updateSession("s1", "thinking", "UserPromptSubmit", opts);
    assert.strictEqual(api.getCurrentSvg(), THINKING[0]);
    api.updateSession("s1", "thinking", "UserPromptSubmit", opts);
    assert.strictEqual(api.getSvgOverride("thinking"), THINKING[0]);

    api.updateSession("s1", "working", "PreToolUse", opts);
    assert.strictEqual(api.getCurrentSvg(), ONE_SESSION[1]);
    for (const event of ["PostToolUse", "PreToolUse", "PostToolUse"]) {
      api.updateSession("s1", "working", event, opts);
      assert.strictEqual(api.getCurrentSvg(), ONE_SESSION[1]);
    }
    assert.strictEqual(random.mock.callCount(), 2);

    api.updateSession("s1", "thinking", "UserPromptSubmit", opts);
    assert.strictEqual(api.getCurrentSvg(), THINKING[2]);
    assert.strictEqual(random.mock.callCount(), 3);
  });

  it("draws again when the working tier changes", () => {
    useRolls(0, 0.99, 0.99);
    api = require("../src/state")({ ...makeCtx(), theme: poolTheme() });

    api.updateSession("s1", "working", "PreToolUse", opts);
    assert.strictEqual(api.getCurrentSvg(), ONE_SESSION[0]);
    api.updateSession("s2", "working", "PreToolUse", { ...opts, cwd: "/tmp/other" });
    assert.strictEqual(api.getCurrentSvg(), TWO_SESSIONS[1]);
    api.updateSession("s2", "working", "PostToolUse", { ...opts, cwd: "/tmp/other" });
    assert.strictEqual(api.getCurrentSvg(), TWO_SESSIONS[1]);
    assert.strictEqual(random.mock.callCount(), 2);
  });

  it("forgets held picks when the theme is refreshed", () => {
    useRolls(0, 0.99);
    api = require("../src/state")({ ...makeCtx(), theme: poolTheme() });
    assert.strictEqual(api.getSvgOverride("thinking"), THINKING[0]);
    assert.strictEqual(api.getSvgOverride("thinking"), THINKING[0]);
    api.refreshTheme();
    assert.strictEqual(api.getSvgOverride("thinking"), THINKING[2]);
  });

  it("never draws for single-file states and file-only tiers", () => {
    useRolls(0.99);
    const ctx = makeCtx();
    ctx.theme = structuredClone(_defaultTheme);
    ctx.theme.timings.minDisplay = Object.fromEntries(
      Object.keys(ctx.theme.timings.minDisplay).map((state) => [state, 0]),
    );
    api = require("../src/state")(ctx);
    api.updateSession("s1", "thinking", "UserPromptSubmit", opts);
    assert.strictEqual(api.getCurrentSvg(), "clawd-working-thinking.svg");
    api.updateSession("s1", "working", "PreToolUse", opts);
    assert.strictEqual(api.getCurrentSvg(), "clawd-working-typing.svg");
    assert.strictEqual(random.mock.callCount(), 0);
  });
});
