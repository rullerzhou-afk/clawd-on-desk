// test/state.test.js — Unit tests for src/state.js core logic
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(require("path").join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");
const _calicoTheme = themeLoader.loadTheme("calico");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
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
    t: (k) => k,
    showSessionId: false,
    focusTerminalWindow: () => {},
    // Default: all pids dead
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
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
    o.id || "s1", o.state || "working", o.event || "PreToolUse",
    o.sourcePid ?? null, o.cwd || "/tmp", o.editor || null,
    o.pidChain || null, o.agentPid ?? null, o.agentId || "claude-code",
    o.host || null, o.headless || false, o.displayHint,
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
    assert.strictEqual(api.resolveDisplayState(), "sweeping");
    assert.strictEqual(api.getSvgOverride("sweeping"), "clawd-working-debugger.svg");

    api.setUpdateVisualState(null);
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("update overlay does not override higher-priority agent states", () => {
    // error(8) > sweeping(6) — update checking must not stomp agent error
    api.sessions.set("s1", rawSession("error"));
    api.setUpdateVisualState("checking"); // → sweeping(6)
    assert.strictEqual(api.resolveDisplayState(), "error");

    // notification(7) > sweeping(6)
    api.sessions.set("s1", rawSession("notification"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // carrying(4) < sweeping(6) — update checking still wins over lower
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "sweeping");

    api.setUpdateVisualState(null);
  });

  it("update overlay wins when no sessions exist", () => {
    api.setUpdateVisualState("checking");
    assert.strictEqual(api.resolveDisplayState(), "sweeping");
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
