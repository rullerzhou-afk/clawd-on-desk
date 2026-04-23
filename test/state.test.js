// test/state.test.js — Unit tests for src/state.js core logic
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(require("path").join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");
const _calicoTheme = themeLoader.loadTheme("calico");
const { createTranslator } = require("../src/i18n");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  const ctx = {
    lang: "en",
    theme: _defaultTheme,
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
    // Default: all pids dead
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
  // Real translator — reads ctx.lang at call time so tests that flip
  // ctx.lang between assertions see different strings. Unknown keys fall
  // back to the key itself (existing createTranslator behavior), so tests
  // that predate C2 and still pass internal state keys get identity behavior.
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

function makePidKill(alivePids) {
  return (pid) => {
    if (alivePids.has(pid)) return true;
    const e = new Error("ESRCH"); e.code = "ESRCH"; throw e;
  };
}

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

/** Shorthand for updateSession with named params */
function update(api, o = {}) {
  api.updateSession(
    o.id || "s1",
    o.state || "working",
    o.event || "PreToolUse",
    {
      sourcePid: o.sourcePid ?? null,
      cwd: o.cwd || "/tmp",
      editor: o.editor || null,
      pidChain: o.pidChain || null,
      agentPid: o.agentPid ?? null,
      agentId: o.agentId || "claude-code",
      host: o.host || null,
      headless: o.headless || false,
      displayHint: o.displayHint,
      sessionTitle: o.sessionTitle ?? null,
    },
  );
}

/** Create a raw session object for direct Map insertion */
function rawSession(state, opts = {}) {
  return {
    state,
    updatedAt: opts.updatedAt ?? Date.now(),
    displayHint: opts.displayHint || null,
    sourcePid: opts.sourcePid || null,
    cwd: opts.cwd || "",
    editor: opts.editor || null,
    pidChain: opts.pidChain || null,
    agentPid: opts.agentPid || null,
    agentId: opts.agentId || null,
    host: opts.host || null,
    headless: opts.headless || false,
    sessionTitle: opts.sessionTitle ?? null,
    recentEvents: opts.recentEvents || [],
    pidReachable: opts.pidReachable ?? false,
    resumeState: opts.resumeState || null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Group 1: resolveDisplayState() priority
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveDisplayState()", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  it("no sessions → idle", () => {
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("single working session → working", () => {
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("picks highest priority: working(3) vs error(8) → error", () => {
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("error"));
    assert.strictEqual(api.resolveDisplayState(), "error");
  });

  it("headless sessions excluded from priority", () => {
    api.sessions.set("s1", rawSession("error", { headless: true }));
    api.sessions.set("s2", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("all headless → idle", () => {
    api.sessions.set("s1", rawSession("working", { headless: true }));
    api.sessions.set("s2", rawSession("error", { headless: true }));
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("full priority ordering", () => {
    const ordered = ["sleeping", "idle", "thinking", "working", "juggling", "carrying", "attention", "sweeping", "notification", "error"];
    for (let i = 0; i < ordered.length - 1; i++) {
      const low = ordered[i];
      const high = ordered[i + 1];
      api.sessions.clear();
      api.sessions.set("lo", rawSession(low));
      api.sessions.set("hi", rawSession(high));
      const result = api.resolveDisplayState();
      const hiPri = api.STATE_PRIORITY[high] || 0;
      const rePri = api.STATE_PRIORITY[result] || 0;
      assert.ok(rePri >= hiPri, `expected ${high}(${hiPri}) to win over ${low}, got ${result}(${rePri})`);
    }
  });

  it("update visual overlay wins over session display state until cleared", () => {
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "working");

    api.setUpdateVisualState("checking");
    assert.strictEqual(api.resolveDisplayState(), "thinking");
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-debugger.svg");

    api.setUpdateVisualState("available");
    assert.strictEqual(api.resolveDisplayState(), "notification");
    assert.strictEqual(api.getSvgOverride("notification"), null);

    api.setUpdateVisualState(null);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("checking overlay falls back to the theme thinking visual when no update override is declared", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({ theme: _calicoTheme }));

    api.setUpdateVisualState("checking");
    assert.strictEqual(api.resolveDisplayState(), "thinking");
    assert.strictEqual(api.getSvgOverride("thinking"), "calico-thinking.apng");

    api.setUpdateVisualState("available");
    assert.strictEqual(api.resolveDisplayState(), "notification");
    assert.strictEqual(api.getSvgOverride("notification"), null);

    api.setUpdateVisualState(null);
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("update overlay does not override higher-priority agent states", () => {
    // error(8) > thinking(2) — update checking must not stomp agent error
    api.sessions.set("s1", rawSession("error"));
    api.setUpdateVisualState("checking"); // → thinking(2)
    assert.strictEqual(api.resolveDisplayState(), "error");

    // notification(7) == notification(7)
    api.setUpdateVisualState("available");
    api.sessions.set("s1", rawSession("notification"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // working(3) < notification(7) — available still wins over lower
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    api.setUpdateVisualState(null);
  });

  it("update overlay wins when no sessions exist", () => {
    api.setUpdateVisualState("checking");
    assert.strictEqual(api.resolveDisplayState(), "thinking");
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-debugger.svg");
    api.setUpdateVisualState("available");
    assert.strictEqual(api.resolveDisplayState(), "notification");
    api.setUpdateVisualState(null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 2: setState() debounce + min display
// ═════════════════════════════════════════════════════════════════════════════

describe("setState() debounce", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("first setState → immediate applyState", () => {
    api.setState("working");
    assert.strictEqual(api.getCurrentState(), "working");
  });

  it("during MIN_DISPLAY_MS → deferred", () => {
    api.setState("working");
    assert.strictEqual(api.getCurrentState(), "working");
    // working MIN_DISPLAY_MS = 1000
    api.setState("thinking");
    // should still be working (pending)
    assert.strictEqual(api.getCurrentState(), "working");
  });

  it("pending fires after MIN_DISPLAY_MS elapsed", () => {
    api.setState("working");
    api.setState("idle");
    assert.strictEqual(api.getCurrentState(), "working");
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("higher priority overrides pending", () => {
    api.setState("working");
    api.setState("idle"); // pending
    api.setState("error"); // should override pending
    assert.strictEqual(api.getCurrentState(), "working"); // still waiting
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentState(), "error");
  });

  it("lower priority cannot override pending", () => {
    api.setState("error");
    // error MIN_DISPLAY_MS = 5000
    api.setState("notification"); // pending, prio 7 (ONESHOT — applies directly)
    api.setState("attention");    // prio 5 < notification 7, rejected
    mock.timers.tick(5000);
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("DND → setState is no-op", () => {
    ctx.doNotDisturb = true;
    api.setState("working");
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("miniTransitioning → applyState rejects non-mini states", () => {
    ctx.miniTransitioning = true;
    api.applyState("working");
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("already in sleep sequence → rejects yawning", () => {
    api.applyState("dozing");
    api.setState("yawning");
    assert.strictEqual(api.getCurrentState(), "dozing");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 3: working sub-animations
// ═════════════════════════════════════════════════════════════════════════════

describe("working sub-animations", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  it("1 working session → typing SVG", () => {
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-typing.svg");
  });

  it("2 working sessions → juggling SVG", () => {
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("working"));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-juggling.svg");
  });

  it("3+ working sessions → building SVG", () => {
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("thinking"));
    api.sessions.set("s3", rawSession("working"));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
  });

  it("1 juggling session → juggling SVG", () => {
    api.sessions.set("s1", rawSession("juggling"));
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-working-juggling.svg");
  });

  it("2+ juggling sessions → conducting SVG", () => {
    api.sessions.set("s1", rawSession("juggling"));
    api.sessions.set("s2", rawSession("juggling"));
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-working-conducting.svg");
  });

  it("idle → follow SVG", () => {
    assert.strictEqual(api.getSvgOverride("idle"), "clawd-idle-follow.svg");
  });
});

describe("visual fallback resolution", () => {
  let api;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const theme = cloneTheme(_defaultTheme);
    theme.states.error = [];
    theme._stateBindings.error = { files: [], fallbackTo: "attention" };
    api = require("../src/state")(makeCtx({ theme }));
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("keeps the logical state while resolving visuals through fallbackTo", () => {
    api.applyState("error");
    assert.strictEqual(api.getCurrentState(), "error");
    assert.strictEqual(api.getCurrentSvg(), "clawd-happy.svg");

    mock.timers.tick(5000);
    assert.strictEqual(api.getCurrentState(), "idle");
  });
});

describe("mini mode working routing", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    if (api) api.cleanup();
    mock.timers.reset();
  });

  it("theme defines mini-working → working routes to mini-working", () => {
    ctx = makeCtx({ miniMode: true });
    api = require("../src/state")(ctx);
    api.applyState("mini-idle");
    api.applyState("working");
    assert.strictEqual(api.getCurrentState(), "mini-working");
  });

  it("theme lacks mini-working → working stays on current mini state", () => {
    const theme = cloneTheme(_defaultTheme);
    delete theme.miniMode.states["mini-working"];
    delete theme._stateBindings["mini-working"];
    ctx = makeCtx({ miniMode: true, theme });
    api = require("../src/state")(ctx);
    api.applyState("mini-idle");
    api.applyState("working");
    assert.strictEqual(api.getCurrentState(), "mini-idle");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 4: sleep sequence
// ═════════════════════════════════════════════════════════════════════════════

describe("sleep sequence", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("yawning → 3s → dozing (non-DND)", () => {
    api.applyState("yawning");
    assert.strictEqual(api.getCurrentState(), "yawning");
    mock.timers.tick(3000);
    assert.strictEqual(api.getCurrentState(), "dozing");
  });

  it("yawning → 3s → collapsing (DND)", () => {
    ctx.doNotDisturb = true;
    api.applyState("yawning");
    mock.timers.tick(3000);
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });

  it("collapsing has no auto-return timer", () => {
    api.applyState("collapsing");
    assert.strictEqual(api.getCurrentState(), "collapsing");
    // Tick a long time — should stay collapsing
    mock.timers.tick(60000);
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });

  it("waking → 1.5s → resolveDisplayState (idle when no sessions)", () => {
    api.applyState("waking");
    assert.strictEqual(api.getCurrentState(), "waking");
    mock.timers.tick(1500);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("waking → 1.5s → restores working if active session exists", () => {
    api.sessions.set("s1", rawSession("working"));
    api.applyState("waking");
    mock.timers.tick(1500);
    assert.strictEqual(api.getCurrentState(), "working");
  });
});

describe("wake poll behavior", () => {
  let api, ctx, fakeCursor;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    fakeCursor = { x: 100, y: 100 };
    ctx = makeCtx({ getCursorScreenPoint: () => ({ ...fakeCursor }) });
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("dozing + mouse move → wake-from-doze + 350ms → idle", () => {
    const events = [];
    ctx.sendToRenderer = (ev) => events.push(ev);
    api.applyState("dozing");
    // wake poll starts after 500ms delay
    mock.timers.tick(500);
    // now move cursor
    fakeCursor.x = 200;
    mock.timers.tick(200); // wake poll interval
    assert.ok(events.includes("wake-from-doze"));
    mock.timers.tick(350);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("collapsing + mouse move → waking", () => {
    api.applyState("collapsing");
    mock.timers.tick(500); // wake poll delay
    fakeCursor.x = 200;
    mock.timers.tick(200);
    assert.strictEqual(api.getCurrentState(), "waking");
  });

  it("sleeping + mouse move → waking", () => {
    api.applyState("sleeping");
    mock.timers.tick(500);
    fakeCursor.x = 200;
    mock.timers.tick(200);
    assert.strictEqual(api.getCurrentState(), "waking");
  });

  it("direct sleep without waking art returns straight to idle on mouse move", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.states.waking = [];
    theme._stateBindings.waking = { files: [], fallbackTo: null };

    api.cleanup();
    ctx = makeCtx({ theme, getCursorScreenPoint: () => ({ ...fakeCursor }) });
    api = require("../src/state")(ctx);

    api.applyState("sleeping");
    mock.timers.tick(500);
    fakeCursor.x = 200;
    mock.timers.tick(200);
    assert.strictEqual(api.getCurrentState(), "idle");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-follow.svg");
  });

  it("dozing + still > DEEP_SLEEP_TIMEOUT → collapsing", () => {
    ctx.mouseStillSince = Date.now() - 600000;
    api.applyState("dozing");
    mock.timers.tick(500); // wake poll delay
    mock.timers.tick(200); // poll fires, checks DEEP_SLEEP_TIMEOUT
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 5: cleanStaleSessions()
// ═════════════════════════════════════════════════════════════════════════════

describe("cleanStaleSessions()", () => {
  let api;

  afterEach(() => { api.cleanup(); });

  it("agentPid dead → delete session", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set()) }));
    api.sessions.set("s1", rawSession("working", { agentPid: 9999, pidReachable: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("agentPid alive + sourcePid dead + stale → delete", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set([1000])) }));
    api.sessions.set("s1", rawSession("idle", {
      agentPid: 1000, sourcePid: 2000, pidReachable: true,
      updatedAt: Date.now() - 700000,
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("agentPid alive + sourcePid alive + working > WORKING_STALE_MS → downgrade to idle", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set([1000, 2000])) }));
    api.sessions.set("s1", rawSession("working", {
      agentPid: 1000, sourcePid: 2000, pidReachable: true,
      updatedAt: Date.now() - 310000,
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.get("s1").state, "idle");
  });

  it("pidReachable false + stale → delete", () => {
    api = require("../src/state")(makeCtx());
    api.sessions.set("s1", rawSession("working", {
      pidReachable: false,
      updatedAt: Date.now() - 700000,
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("last non-headless deleted → triggers yawning", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set()) }));
    api.sessions.set("s1", rawSession("working", { agentPid: 9999, pidReachable: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.getCurrentState(), "yawning");
  });

  it("all headless deleted → idle (not yawning)", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set()) }));
    api.sessions.set("s1", rawSession("working", { agentPid: 9999, pidReachable: true, headless: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("headless session deleted does not trigger yawning", () => {
    const alive = new Set([1000]);
    api = require("../src/state")(makeCtx({ processKill: makePidKill(alive) }));
    // One alive non-headless + one dead headless
    api.sessions.set("s1", rawSession("working", { agentPid: 1000, pidReachable: true }));
    api.sessions.set("s2", rawSession("working", { agentPid: 9999, pidReachable: true, headless: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 1);
    assert.ok(api.sessions.has("s1"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 6: updateSession()
// ═════════════════════════════════════════════════════════════════════════════

describe("updateSession()", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx({ processKill: () => true }); // all pids alive
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("new session_id → creates session", () => {
    update(api, { id: "new1", state: "working" });
    assert.ok(api.sessions.has("new1"));
    assert.strictEqual(api.sessions.get("new1").state, "working");
  });

  it("existing session_id → updates state and timestamp", () => {
    update(api, { id: "s1", state: "working" });
    const t1 = api.sessions.get("s1").updatedAt;
    update(api, { id: "s1", state: "thinking" });
    assert.strictEqual(api.sessions.get("s1").state, "thinking");
    assert.ok(api.sessions.get("s1").updatedAt >= t1);
  });

  it("juggling + working (non-SubagentStop) → keeps juggling", () => {
    update(api, { id: "s1", state: "juggling", event: "SubagentStart" });
    assert.strictEqual(api.sessions.get("s1").state, "juggling");
    update(api, { id: "s1", state: "working", event: "PostToolUse" });
    assert.strictEqual(api.sessions.get("s1").state, "juggling");
  });

  it("working + SubagentStart + SubagentStop → restores working", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, { id: "s1", state: "juggling", event: "SubagentStart" });
    update(api, { id: "s1", state: "working", event: "SubagentStop" });
    assert.strictEqual(api.sessions.get("s1").state, "working");
  });

  it("subagent-only session is removed on SubagentStop", () => {
    update(api, { id: "s1", state: "juggling", event: "SubagentStart" });
    assert.ok(api.sessions.has("s1"));
    update(api, { id: "s1", state: "working", event: "SubagentStop" });
    assert.ok(!api.sessions.has("s1"));
  });

  it("late SubagentStop without tracked session is ignored", () => {
    update(api, { id: "ghost", state: "working", event: "SubagentStop" });
    assert.ok(!api.sessions.has("ghost"));
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("SessionEnd → deletes session", () => {
    update(api, { id: "s1", state: "working" });
    assert.ok(api.sessions.has("s1"));
    update(api, { id: "s1", state: "sleeping", event: "SessionEnd" });
    assert.ok(!api.sessions.has("s1"));
  });

  it("PermissionRequest → notification state, no session creation", () => {
    update(api, { id: "perm1", state: "notification", event: "PermissionRequest" });
    assert.ok(!api.sessions.has("perm1"));
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("SessionEnd + sweeping → plays sweeping even with other active sessions", () => {
    // Insert sessions directly to avoid MIN_DISPLAY_MS cascade from setState
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("working"));
    // currentState is idle → no MIN_DISPLAY_MS → sweeping applies immediately
    update(api, { id: "s1", state: "sweeping", event: "SessionEnd" });
    assert.strictEqual(api.getCurrentState(), "sweeping");
  });

  it("SessionEnd + last non-headless → sleeping", () => {
    update(api, { id: "s1", state: "working" });
    mock.timers.tick(1000);
    update(api, { id: "s1", state: "sleeping", event: "SessionEnd" });
    assert.strictEqual(api.getCurrentState(), "sleeping");
  });

  it("headless session does not affect resolveDisplayState", () => {
    update(api, { id: "h1", state: "error", headless: true });
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("session count > MAX_SESSIONS(20) → evicts oldest", () => {
    for (let i = 0; i < 20; i++) {
      update(api, { id: `s${i}`, state: "working" });
    }
    assert.strictEqual(api.sessions.size, 20);
    update(api, { id: "s_new", state: "working" });
    assert.strictEqual(api.sessions.size, 20);
    assert.ok(api.sessions.has("s_new"));
  });

  it("startupRecoveryActive cleared on first updateSession", () => {
    api.startStartupRecovery();
    assert.strictEqual(api.getStartupRecoveryActive(), true);
    update(api, { id: "s1", state: "working" });
    assert.strictEqual(api.getStartupRecoveryActive(), false);
  });

  it("attention is oneshot — stored as idle in session", () => {
    update(api, { id: "s1", state: "working" });
    mock.timers.tick(1000); // past MIN_DISPLAY_MS.working
    update(api, { id: "s1", state: "attention", event: "Stop" });
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
  });

  it("SessionEnd + other non-headless sessions → resolves to highest", () => {
    update(api, { id: "s1", state: "working" });
    update(api, { id: "s2", state: "thinking" });
    update(api, { id: "s1", state: "sleeping", event: "SessionEnd" });
    // s2 remains with thinking
    assert.strictEqual(api.resolveDisplayState(), "thinking");
  });

  // ── session title (B1) ──

  it("stores sessionTitle from updateSession positional arg", () => {
    update(api, { id: "s1", state: "working", sessionTitle: "My Task" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "My Task");
  });

  it("trims whitespace on sessionTitle", () => {
    update(api, { id: "s1", state: "working", sessionTitle: "  Spaced  " });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "Spaced");
  });

  it("strips control characters and truncates long sessionTitle values", () => {
    update(api, {
      id: "s1",
      state: "working",
      sessionTitle: `  Fix\tlogin\nbug ${"x".repeat(100)}  `,
    });
    const title = api.sessions.get("s1").sessionTitle;
    assert.strictEqual(title.startsWith("Fix login bug "), true);
    assert.strictEqual(title.length, 80);
    assert.strictEqual(title.endsWith("…"), true);
    assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(title), false);
  });

  it("sticky sessionTitle: follow-up events without title keep existing", () => {
    update(api, { id: "s1", state: "thinking", sessionTitle: "Persistent Title" });
    update(api, { id: "s1", state: "working" }); // no title in this update
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "Persistent Title");
  });

  it("sticky sessionTitle: empty string does not clear existing title", () => {
    update(api, { id: "s1", state: "thinking", sessionTitle: "Keep Me" });
    update(api, { id: "s1", state: "working", sessionTitle: "" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "Keep Me");
  });

  it("sticky sessionTitle: whitespace-only input does not clear existing title", () => {
    update(api, { id: "s1", state: "thinking", sessionTitle: "Keep Me" });
    update(api, { id: "s1", state: "working", sessionTitle: "   " });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "Keep Me");
  });

  it("sessionTitle can be updated to a new non-empty value", () => {
    update(api, { id: "s1", state: "thinking", sessionTitle: "Old Name" });
    update(api, { id: "s1", state: "working", sessionTitle: "New Name" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "New Name");
  });

  it("new session with no sessionTitle has null field", () => {
    update(api, { id: "s1", state: "working" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, null);
  });

  it("buildSessionSubmenu uses sessionTitle over cwd folder name", () => {
    update(api, {
      id: "s1",
      state: "idle",
      cwd: "/tmp/project-abc",
      sessionTitle: "Fix login bug",
    });
    const menu = api.buildSessionSubmenu();
    // Label format: `${name}  ${stateText}  ${elapsed}` — name should be the title
    assert.ok(
      menu[0].label.includes("Fix login bug"),
      `expected label to include title, got: ${menu[0].label}`
    );
    assert.ok(
      !menu[0].label.includes("project-abc"),
      `expected label to NOT include folder when title present, got: ${menu[0].label}`
    );
  });

  it("buildSessionSubmenu falls back to folder name when sessionTitle is null", () => {
    update(api, {
      id: "s1",
      state: "idle",
      cwd: "/tmp/project-abc",
      // no sessionTitle
    });
    const menu = api.buildSessionSubmenu();
    assert.ok(
      menu[0].label.includes("project-abc"),
      `expected folder fallback, got: ${menu[0].label}`
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 6b: recentEvents + deriveSessionBadge (C1)
// ═════════════════════════════════════════════════════════════════════════════

describe("recentEvents tracking", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  it("pushes events in order, capped at 8 (RECENT_EVENT_LIMIT)", () => {
    for (let i = 0; i < 12; i++) {
      update(api, { id: "s1", state: "working", event: `Event${i}` });
    }
    const events = api.sessions.get("s1").recentEvents;
    assert.strictEqual(events.length, 8);
    // Oldest 4 should have been dropped (Event0..Event3), keeping Event4..Event11
    assert.strictEqual(events[0].event, "Event4");
    assert.strictEqual(events[7].event, "Event11");
  });

  it("does not store an i18n label on events (derived at render time)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    const evt = api.sessions.get("s1").recentEvents[0];
    assert.ok(!("label" in evt), "recentEvents entries must not persist a 'label' field");
  });

  it("records state + event + at timestamp on each entry", () => {
    const before = Date.now();
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit" });
    const after = Date.now();
    const evt = api.sessions.get("s1").recentEvents[0];
    assert.strictEqual(evt.event, "UserPromptSubmit");
    assert.strictEqual(evt.state, "thinking");
    assert.ok(evt.at >= before && evt.at <= after);
  });

  it("recentEvents survives across multiple updates to the same session", () => {
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit" });
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, { id: "s1", state: "idle", event: "Stop" });
    const events = api.sessions.get("s1").recentEvents;
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(
      events.map((e) => e.event),
      ["UserPromptSubmit", "PreToolUse", "Stop"]
    );
  });

  it("handles null event as null (not crash, not skipped)", () => {
    // The update() helper falls back to "PreToolUse" on null event —
    // bypass it here to test the null path directly.
    api.updateSession("s1", "working", null, { cwd: "/tmp", agentId: "claude-code" });
    const events = api.sessions.get("s1").recentEvents;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, null);
  });
});

describe("deriveSessionBadge", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  // ── reachable states (what updateSession actually keeps on session.state) ──
  // oneshot states (attention/error/sweeping/notification/carrying) get
  // normalized to idle by updateSession, so they aren't tested here.

  it("returns 'running' for reachable active states", () => {
    // working / thinking / juggling are what the state machine stores
    for (const st of ["working", "thinking", "juggling"]) {
      assert.strictEqual(
        api.deriveSessionBadge({ state: st, recentEvents: [] }),
        "running",
        `state=${st}`
      );
    }
  });

  it("returns 'interrupted' when idle with StopFailure in recentEvents", () => {
    const s = { state: "idle", recentEvents: [{ event: "StopFailure" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "interrupted");
  });

  it("returns 'interrupted' when idle with PostToolUseFailure in recentEvents", () => {
    const s = { state: "idle", recentEvents: [{ event: "PostToolUseFailure" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "interrupted");
  });

  it("returns 'done' when idle with Stop in recentEvents", () => {
    const s = { state: "idle", recentEvents: [{ event: "Stop" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "done");
  });

  it("returns 'done' when idle with PostCompact in recentEvents", () => {
    const s = { state: "idle", recentEvents: [{ event: "PostCompact" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "done");
  });

  it("returns 'idle' when sleeping (no tombstone, not 'exited')", () => {
    // SessionEnd deletes the session from the Map so menu iteration never
    // sees it — sleeping here comes from other paths (idle timeout etc).
    const s = { state: "sleeping", recentEvents: [{ event: "Stop" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "idle");
  });

  it("returns 'idle' when idle with no notable recentEvents", () => {
    assert.strictEqual(api.deriveSessionBadge({ state: "idle", recentEvents: [] }), "idle");
  });

  it("uses the LATEST event for idle disambiguation", () => {
    // PostToolUseFailure (interrupted) comes before Stop (done)
    // Latest = Stop, so badge should be 'done', not 'interrupted'
    const s = {
      state: "idle",
      recentEvents: [
        { event: "PreToolUse" },
        { event: "PostToolUseFailure" },
        { event: "Stop" },
      ],
    };
    assert.strictEqual(api.deriveSessionBadge(s), "done");
  });

  // ── defensive inputs (not reachable session states but safe to pass) ──

  it("is defensive against null session", () => {
    assert.strictEqual(api.deriveSessionBadge(null), "idle");
  });

  it("is defensive against undefined session", () => {
    assert.strictEqual(api.deriveSessionBadge(undefined), "idle");
  });

  it("treats unknown non-idle state as 'running'", () => {
    // If the state machine ever introduces a new active state, the badge
    // should degrade gracefully to 'running' rather than throw or return
    // undefined.
    assert.strictEqual(
      api.deriveSessionBadge({ state: "bogus-future-state", recentEvents: [] }),
      "running"
    );
  });

  it("handles missing recentEvents field (defensive)", () => {
    assert.strictEqual(api.deriveSessionBadge({ state: "idle" }), "idle");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 6c: Sessions submenu badge + i18n (C2)
// ═════════════════════════════════════════════════════════════════════════════

describe("buildSessionSubmenu badge + i18n", () => {
  let api, ctx;
  const pid = process.pid;

  beforeEach(() => {
    ctx = makeCtx({ processKill: makePidKill(new Set([pid])) });
    api = require("../src/state")(ctx);
  });
  afterEach(() => api.cleanup());

  function menuLabel() {
    // First entry's label — assume single session in these tests so no
    // host-grouping header rows.
    return api.buildSessionSubmenu()[0].label;
  }

  it("shows English 'Running' when session is working (lang=en)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    ctx.lang = "en";
    assert.match(menuLabel(), /Running/);
  });

  it("shows Chinese '运行中' when lang=zh", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    ctx.lang = "zh";
    assert.match(menuLabel(), /运行中/);
  });

  it("shows Korean '실행 중' when lang=ko", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    ctx.lang = "ko";
    assert.match(menuLabel(), /실행 중/);
  });

  it("shows 'Done' after Stop event (en)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    update(api, { id: "s1", state: "idle", event: "Stop", sourcePid: pid });
    ctx.lang = "en";
    assert.match(menuLabel(), /Done/);
  });

  it("shows '已完成' after Stop event (zh)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    update(api, { id: "s1", state: "idle", event: "Stop", sourcePid: pid });
    ctx.lang = "zh";
    assert.match(menuLabel(), /已完成/);
  });

  it("shows 'Interrupted' after StopFailure (en)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    update(api, { id: "s1", state: "idle", event: "StopFailure", sourcePid: pid });
    ctx.lang = "en";
    assert.match(menuLabel(), /Interrupted/);
  });

  it("shows '中断' after StopFailure (zh)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    update(api, { id: "s1", state: "idle", event: "StopFailure", sourcePid: pid });
    ctx.lang = "zh";
    assert.match(menuLabel(), /中断/);
  });

  it("shows 'Idle' for fresh idle session with no notable events (en)", () => {
    update(api, { id: "s1", state: "idle", event: "SessionStart", sourcePid: pid });
    ctx.lang = "en";
    assert.match(menuLabel(), /Idle/);
  });

  it("language switch changes label without needing a new state event", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: pid });
    ctx.lang = "en";
    const enLabel = menuLabel();
    ctx.lang = "zh";
    const zhLabel = menuLabel();
    ctx.lang = "ko";
    const koLabel = menuLabel();
    assert.notStrictEqual(enLabel, zhLabel, "en vs zh should differ");
    assert.notStrictEqual(zhLabel, koLabel, "zh vs ko should differ");
    assert.match(enLabel, /Running/);
    assert.match(zhLabel, /运行中/);
    assert.match(koLabel, /실행 중/);
  });

  it("badge label falls back for idle sessions with only SessionStart", () => {
    // SessionStart event shouldn't flip badge to done/interrupted
    update(api, { id: "s1", state: "idle", event: "SessionStart", sourcePid: pid });
    ctx.lang = "en";
    const label = menuLabel();
    assert.ok(!/Done|Interrupted/.test(label), `unexpected badge in: ${label}`);
    assert.match(label, /Idle/);
  });

  it("sessionTitle still takes precedence over folder name when badge is present", () => {
    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      sourcePid: pid,
      cwd: "/tmp/project-abc",
      sessionTitle: "Fix login bug",
    });
    ctx.lang = "en";
    const label = menuLabel();
    assert.ok(label.includes("Fix login bug"));
    assert.ok(!label.includes("project-abc"));
    assert.match(label, /Running/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 7: DND mode
// ═════════════════════════════════════════════════════════════════════════════

describe("DND mode", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("enableDoNotDisturb non-mini → yawning → 3s → collapsing", () => {
    api.enableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "yawning");
    assert.strictEqual(ctx.doNotDisturb, true);
    mock.timers.tick(3000);
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });

  it("enableDoNotDisturb mini → mini-sleep", () => {
    ctx.miniMode = true;
    api.enableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "mini-sleep");
  });

  it("enableDoNotDisturb direct-sleep theme → sleeping immediately", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    api.cleanup();
    ctx = makeCtx({ theme });
    api = require("../src/state")(ctx);

    api.enableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "sleeping");
  });

  it("DND denies all pending permissions", () => {
    const denied = [];
    ctx.resolvePermissionEntry = (perm, action) => denied.push({ perm, action });
    ctx.pendingPermissions = ["p1", "p2"];
    api.enableDoNotDisturb();
    assert.strictEqual(denied.length, 2);
    assert.strictEqual(denied[0].action, "deny");
    assert.strictEqual(denied[1].action, "deny");
  });

  it("DND clears pending and auto-return timers", () => {
    // Set up a pending timer by transitioning
    api.applyState("attention"); // sets auto-return timer (4s)
    // Now enable DND — should clear auto-return timer, then apply yawning
    api.enableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "yawning");
    // If old auto-return wasn't cleared, ticking 4s would override yawning
    mock.timers.tick(4000);
    // Should NOT have gone to idle from attention auto-return
    // yawning auto-return at 3s → collapsing (DND path)
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });

  it("disableDoNotDisturb non-mini → waking", () => {
    api.enableDoNotDisturb();
    api.disableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "waking");
    assert.strictEqual(ctx.doNotDisturb, false);
  });

  it("disableDoNotDisturb direct-sleep theme without waking art → idle", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.states.waking = [];
    theme._stateBindings.waking = { files: [], fallbackTo: null };

    api.cleanup();
    ctx = makeCtx({ theme });
    api = require("../src/state")(ctx);

    api.enableDoNotDisturb();
    api.disableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "idle");
    assert.strictEqual(ctx.doNotDisturb, false);
  });

  it("disableDoNotDisturb mini → mini-idle", () => {
    ctx.miniMode = true;
    api.enableDoNotDisturb();
    api.disableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "mini-idle");
  });

  it("DND blocks setState", () => {
    api.enableDoNotDisturb();
    mock.timers.tick(3000); // yawning → collapsing
    api.setState("working");
    assert.strictEqual(api.getCurrentState(), "collapsing");
  });
});

describe("refreshTheme()", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  it("updates idle svg and DND sleep path after hot theme switch", () => {
    assert.strictEqual(api.getSvgOverride("idle"), "clawd-idle-follow.svg");

    ctx.theme = _calicoTheme;
    api.refreshTheme();

    assert.strictEqual(api.getSvgOverride("idle"), "calico-idle-follow.svg");
    api.enableDoNotDisturb();
    assert.strictEqual(api.getCurrentState(), "collapsing");
    mock.timers.tick(5200);
    assert.strictEqual(api.getCurrentState(), "sleeping");
  });

  it("uses the refreshed theme wake duration before returning from waking", () => {
    ctx.theme = _calicoTheme;
    api.refreshTheme();

    api.applyState("waking");
    mock.timers.tick(5799);
    assert.strictEqual(api.getCurrentState(), "waking");

    mock.timers.tick(1);
    assert.strictEqual(api.getCurrentState(), "idle");
  });
});
