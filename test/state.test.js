// test/state.test.js — Unit tests for src/state.js core logic
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");
const _calicoTheme = themeLoader.loadTheme("calico");
const { createTranslator } = require("../src/i18n");
const { makeSessionKey, resolveSessionIdentity } = require("../src/session-key");
const { isSessionInProgress } = require("../src/state-session-snapshot");
const { countLiveSubagents } = require("../src/state-visual-resolver");

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
    dismissPermissionsForDnd: () => {},
    focusTerminalWindow: () => {},
    focusHostPlatform: "darwin",
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
      wtHwnd: o.wtHwnd ?? null,
      cwd: o.cwd || "/tmp",
      editor: o.editor || null,
      pidChain: o.pidChain || null,
      orcaPaneKey: o.orcaPaneKey ?? null,
      agentPid: o.agentPid ?? null,
      agentId: o.agentId || "claude-code",
      profileId: o.profileId,
      rawSessionId: o.rawSessionId,
      host: o.host || null,
      headless: o.headless || false,
      displayHint: o.displayHint,
      sessionTitle: o.sessionTitle ?? null,
      contextUsage: o.contextUsage ?? null,
      contextUsageOrigin: o.contextUsageOrigin ?? null,
      antigravityQuota: o.antigravityQuota ?? null,
      claudeQuota: o.claudeQuota ?? null,
      platform: o.platform ?? null,
      model: o.model ?? null,
      provider: o.provider ?? null,
      codexOriginator: o.codexOriginator ?? null,
      codexSource: o.codexSource ?? null,
      ghosttyTerminalId: o.ghosttyTerminalId ?? null,
      assistantLastOutput: o.assistantLastOutput ?? null,
      assistantLastOutputTruncated: o.assistantLastOutputTruncated ?? false,
      toolName: o.toolName ?? null,
      transcriptPath: o.transcriptPath ?? null,
      backgroundTasksCount: o.backgroundTasksCount ?? 0,
      ...(Object.prototype.hasOwnProperty.call(o, "backgroundSubagentsCount")
        ? { backgroundSubagentsCount: o.backgroundSubagentsCount }
        : {}),
      sessionCronsCount: o.sessionCronsCount ?? 0,
      stopHookActive: o.stopHookActive ?? false,
      transientPermissionEvent: o.transientPermissionEvent === true,
      sessionAutomationIdentity: o.sessionAutomationIdentity ?? null,
      subagentId: o.subagentId ?? null,
      subagentType: o.subagentType ?? null,
      subagentLifecycleSource: o.subagentLifecycleSource ?? null,
      sessionStartSource: o.sessionStartSource ?? null,
      recapBoundary: o.recapBoundary ?? null,
      recapDedupeId: o.recapDedupeId ?? null,
      recapOccurredAt: o.recapOccurredAt ?? null,
      recapSuppressed: o.recapSuppressed === true,
      toolUseId: o.toolUseId ?? null,
      replaceProcessMetadata: o.replaceProcessMetadata === true,
    },
  );
}

describe("remote profile session namespace", () => {
  let api;

  afterEach(() => { if (api) api.cleanup(); });

  it("keeps identical raw ids independent through update, permission, stale cleanup, ack, and end", () => {
    api = require("../src/state")(makeCtx());
    const rawSessionId = "same-raw-session";
    const aId = makeSessionKey({ profileId: "profile-a", rawSessionId });
    const bId = makeSessionKey({ profileId: "profile-b", rawSessionId });

    update(api, {
      id: aId,
      state: "working",
      event: "PreToolUse",
      profileId: "profile-a",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    update(api, {
      id: bId,
      state: "thinking",
      event: "UserPromptSubmit",
      profileId: "profile-b",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    assert.strictEqual(api.sessions.size, 2);
    assert.strictEqual(api.sessions.get(aId).profileId, "profile-a");
    assert.strictEqual(api.sessions.get(bId).profileId, "profile-b");

    update(api, {
      id: aId,
      state: "notification",
      event: "PermissionRequest",
      transientPermissionEvent: true,
      profileId: "profile-a",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    assert.strictEqual(api.sessions.get(aId).state, "working");
    assert.strictEqual(api.sessions.get(bId).state, "thinking");

    update(api, {
      id: aId,
      state: "sleeping",
      event: "stale-cleanup",
      profileId: "profile-a",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    assert.ok(api.sessions.has(bId), "A stale cleanup cannot remove B");

    update(api, {
      id: bId,
      state: "idle",
      event: "Stop",
      profileId: "profile-b",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    assert.strictEqual(api.ackSessionCompletion(bId), true);
    assert.notStrictEqual(api.sessions.get(aId).completionAcknowledged, true);

    update(api, {
      id: aId,
      state: "idle",
      event: "SessionEnd",
      profileId: "profile-a",
      rawSessionId,
      host: "shared-host",
      agentId: "codex",
    });
    assert.strictEqual(api.sessions.has(aId), false);
    assert.strictEqual(api.sessions.has(bId), true);
  });
});

/** Create a raw session object for direct Map insertion */
function rawSession(state, opts = {}) {
  return {
    state,
    updatedAt: opts.updatedAt ?? Date.now(),
    displayHint: opts.displayHint || null,
    sourcePid: opts.sourcePid || null,
    wtHwnd: opts.wtHwnd || null,
    cwd: opts.cwd || "",
    editor: opts.editor || null,
    pidChain: opts.pidChain || null,
    agentPid: opts.agentPid || null,
    agentId: opts.agentId || null,
    host: opts.host || null,
    headless: opts.headless || false,
    platform: opts.platform || null,
    model: opts.model || null,
    provider: opts.provider || null,
    codexOriginator: opts.codexOriginator || null,
    codexSource: opts.codexSource || null,
    ghosttyTerminalId: opts.ghosttyTerminalId || null,
    sessionTitle: opts.sessionTitle ?? null,
    recentEvents: opts.recentEvents || [],
    pidReachable: opts.pidReachable ?? false,
    resumeState: opts.resumeState || null,
    ...(opts.subagentTracker ? { subagentTracker: opts.subagentTracker } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Group 1: resolveDisplayState() priority
// ═════════════════════════════════════════════════════════════════════════════

describe("restoreSessionFromLease()", () => {
  let api;

  afterEach(() => { if (api) api.cleanup(); });

  function lease(overrides = {}) {
    return {
      version: 1,
      agentId: "claude-code",
      sessionId: "claude-real-session",
      active: true,
      state: "working",
      eventAt: Date.now() - 1000,
      validUntil: null,
      pid: process.pid,
      sourcePid: process.pid,
      processStartIdentity: null,
      sourceProcessStartIdentity: null,
      cwd: "C:/work/project",
      title: "Recovered task",
      ...overrides,
    };
  }

  it("restores the real session without replaying sounds, events, or broadcasts", () => {
    const sounds = [];
    const broadcasts = [];
    api = require("../src/state")(makeCtx({
      processKill: () => true,
      playSound: (name) => sounds.push(name),
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
    assert.strictEqual(api.restoreSessionFromLease(lease()), true);
    assert.deepStrictEqual(sounds, []);
    assert.deepStrictEqual(broadcasts, []);
    assert.strictEqual(api.sessions.size, 1);
    const sessionId = makeSessionKey({ profileId: "local", rawSessionId: "claude-real-session" });
    const session = api.sessions.get(sessionId);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(session, "claudeBackgroundSubagentHoldAt"),
      false,
    );
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.profileId, "local");
    assert.strictEqual(session.rawSessionId, "claude-real-session");
    assert.strictEqual(session.startupRecovered, true);
    assert.deepStrictEqual(session.recentEvents, []);
    assert.strictEqual(session.requiresCompletionAck, undefined);
    assert.strictEqual(session.contextUsageOrigin, null);
    const entry = api.buildSessionSnapshot().sessions[0];
    assert.strictEqual(entry.id, sessionId);
    assert.strictEqual(entry.startupRecovered, true);
    assert.strictEqual(entry.canFocus, false);
  });

  it("lets the next real hook update the same canonical id, then SessionEnd removes it", () => {
    api = require("../src/state")(makeCtx({ processKill: () => true }));
    assert.strictEqual(api.restoreSessionFromLease(lease()), true);
    assert.strictEqual(api.restoreSessionFromLease(lease({ sessionId: "other-session", state: "thinking" })), true);
    const sessionId = makeSessionKey({ profileId: "local", rawSessionId: "claude-real-session" });
    const otherSessionId = makeSessionKey({ profileId: "local", rawSessionId: "other-session" });
    update(api, {
      id: sessionId,
      state: "working",
      event: "PostToolUse",
      sourcePid: process.pid,
      agentPid: process.pid,
      profileId: "local",
      rawSessionId: "claude-real-session",
    });
    assert.strictEqual(api.sessions.size, 2);
    assert.strictEqual(api.sessions.get(sessionId).startupRecovered, undefined);
    assert.strictEqual(api.sessions.get(otherSessionId).startupRecovered, true);
    update(api, {
      id: sessionId,
      state: "idle",
      event: "SessionEnd",
      profileId: "local",
      rawSessionId: "claude-real-session",
    });
    assert.strictEqual(api.sessions.has(sessionId), false);
    assert.strictEqual(api.sessions.size, 1);
  });

  it("uses a recovered juggling lease as a visual floor and replaces it on fresh identity", () => {
    api = require("../src/state")(makeCtx({ processKill: () => true }));
    assert.strictEqual(api.restoreSessionFromLease(lease({ state: "juggling" })), true);
    const sessionId = makeSessionKey({ profileId: "local", rawSessionId: "claude-real-session" });
    assert.strictEqual(api.sessions.get(sessionId).subagentTracker.recoveredFloor, true);
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-headphones-groove.svg");

    update(api, {
      id: sessionId,
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
      subagentLifecycleSource: "native",
      sourcePid: process.pid,
      agentPid: process.pid,
      profileId: "local",
      rawSessionId: "claude-real-session",
    });
    const tracker = api.sessions.get(sessionId).subagentTracker;
    assert.strictEqual(tracker.recoveredFloor, false);
    assert.deepStrictEqual([...tracker.confirmedIds], ["child-a"]);
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-headphones-groove.svg");
  });

  it("never overwrites a session that arrived from a real hook first", () => {
    api = require("../src/state")(makeCtx({ processKill: () => true }));
    const sessionId = makeSessionKey({ profileId: "local", rawSessionId: "claude-real-session" });
    update(api, {
      id: sessionId,
      state: "thinking",
      event: "UserPromptSubmit",
      profileId: "local",
      rawSessionId: "claude-real-session",
    });
    assert.strictEqual(api.restoreSessionFromLease(lease()), false);
    assert.strictEqual(api.sessions.get(sessionId).state, "thinking");
    assert.strictEqual(api.sessions.get(sessionId).startupRecovered, undefined);
  });
});

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

  it("refreshes the active checking update visual override when the theme changes", () => {
    const ctx = makeCtx();
    api.cleanup();
    api = require("../src/state")(ctx);

    api.setUpdateVisualState("checking");
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-debugger.svg");

    ctx.theme = _calicoTheme;
    api.refreshTheme();
    assert.strictEqual(api.getSvgOverride("thinking"), "calico-thinking.apng");

    ctx.theme = _defaultTheme;
    api.refreshTheme();
    assert.strictEqual(api.getSvgOverride("thinking"), "clawd-working-debugger.svg");
  });

  it("update overlay does not override higher-priority agent states", () => {
    // error(8) > thinking(2) — update checking must not stomp agent error
    api.sessions.set("s1", rawSession("error"));
    api.setUpdateVisualState("checking"); // → thinking(2)
    assert.strictEqual(api.resolveDisplayState(), "error");

    // notification(7) == checking overlay priority(7) — live notification wins ties
    api.sessions.set("s1", rawSession("notification"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // notification(7) == notification(7)
    api.setUpdateVisualState("available");
    api.sessions.set("s1", rawSession("notification"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    // working(3) < notification(7) — available still wins over lower
    api.sessions.set("s1", rawSession("working"));
    assert.strictEqual(api.resolveDisplayState(), "notification");

    api.setUpdateVisualState(null);
  });

  it("checking overlay does not override an active Kimi permission lock", () => {
    api.cleanup();
    const ctx = makeCtx({
      isAgentPermissionsEnabled: () => true,
      showKimiNotifyBubble: () => {},
      clearKimiNotifyBubbles: () => {},
    });
    api = require("../src/state")(ctx);

    update(api, {
      id: "kimi-perm",
      state: "notification",
      event: "PermissionRequest",
      agentId: "kimi-cli",
    });
    api.setUpdateVisualState("checking");

    assert.strictEqual(api.resolveDisplayState(), "notification");
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

  it("bypassMinDisplay immediately exits an interruptible roam hold and clears its pending idle", () => {
    api.cleanup();
    const theme = cloneTheme(_defaultTheme);
    theme.timings.minDisplay.roam = 60000;
    const stateChanges = [];
    ctx = makeCtx({
      theme,
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    api.applyState("roam");
    stateChanges.length = 0;

    api.setState("idle");
    assert.strictEqual(api.getCurrentState(), "roam",
      "a normal transition should still respect the theme's roam min-display");

    api.setState("idle", undefined, { bypassMinDisplay: true });
    assert.strictEqual(api.getCurrentState(), "idle",
      "an explicit interruption must restore idle immediately");
    assert.deepStrictEqual(stateChanges, ["idle"]);

    mock.timers.tick(60000);
    assert.deepStrictEqual(stateChanges, ["idle"],
      "the superseded delayed idle must not fire later");
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
    api.setState("idle", undefined, { bypassMinDisplay: true }); // bypass must not bypass priority
    mock.timers.tick(5000);
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("DND → setState is no-op", () => {
    ctx.doNotDisturb = true;
    api.setState("working", undefined, { bypassMinDisplay: true });
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

  it("2 working sessions → headphones groove SVG", () => {
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("working"));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-headphones-groove.svg");
  });

  it("3+ working sessions → building SVG", () => {
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("thinking"));
    api.sessions.set("s3", rawSession("working"));
    assert.strictEqual(api.getSvgOverride("working"), "clawd-working-building.svg");
  });

  it("1 juggling session → headphones groove SVG", () => {
    api.sessions.set("s1", rawSession("juggling"));
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-headphones-groove.svg");
  });

  it("2+ juggling sessions → three-ball juggling SVG", () => {
    api.sessions.set("s1", rawSession("juggling"));
    api.sessions.set("s2", rawSession("juggling"));
    assert.strictEqual(api.getSvgOverride("juggling"), "clawd-working-juggling.svg");
  });

  it("idle → follow SVG", () => {
    assert.strictEqual(api.getSvgOverride("idle"), "clawd-idle-follow.svg");
  });
});

// #862 — the tier above counts juggling SESSIONS, but the docs promise tiering
// by live SUBAGENT count, and one session can host several. That gap had zero
// coverage, so these drive the real event entry point rather than seeding
// api.sessions directly.
describe("#862 juggling tier counts subagents, not sessions", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  const GROOVE = "clawd-headphones-groove.svg";
  const JUGGLE = "clawd-working-juggling.svg";
  const TYPING = "clawd-working-typing.svg";

  function start(id = "s1", child = "child-1") {
    update(api, {
      id,
      state: "juggling",
      event: "SubagentStart",
      subagentId: child,
      subagentLifecycleSource: "native",
    });
  }
  function stop(id = "s1", child = "child-1") {
    update(api, {
      id,
      state: "working",
      event: "SubagentStop",
      subagentId: child,
      subagentLifecycleSource: "native",
    });
  }
  function anonymousStart(id = "s1", agentId = "cursor-agent") {
    update(api, { id, agentId, state: "juggling", event: "subagentStart" });
  }
  function anonymousStop(id = "s1", agentId = "cursor-agent") {
    update(api, { id, agentId, state: "working", event: "subagentStop" });
  }
  function work(id = "s1") { update(api, { id, state: "working", event: "PreToolUse" }); }
  function shown() { return api.getSvgOverride(api.resolveDisplayState()); }

  it("one session with 1 subagent → headphones groove", () => {
    work(); start();
    assert.strictEqual(shown(), GROOVE);
  });

  it("one session with 2 subagents → three-ball juggling", () => {
    work(); start("s1", "child-a"); start("s1", "child-b");
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.strictEqual(shown(), JUGGLE);
  });

  it("holds juggling when one of two subagents stops", () => {
    work(); start("s1", "child-a"); start("s1", "child-b"); stop("s1", "child-a");
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.strictEqual(shown(), GROOVE);
  });

  it("restores working only after the last subagent stops", () => {
    work(); start("s1", "child-a"); start("s1", "child-b");
    stop("s1", "child-a"); stop("s1", "child-b");
    assert.strictEqual(api.resolveDisplayState(), "working");
    assert.strictEqual(shown(), TYPING);
  });

  it("a new run resets the count when stops were lost", () => {
    work(); start("s1", "child-a"); start("s1", "child-b");
    // agent crashed — both stops never arrive; session leaves juggling normally
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
    });
    work();
    start("s1", "child-c");
    assert.strictEqual(shown(), GROOVE, "stale count must not carry into the new run");
  });

  it("still escalates across two sessions with one subagent each", () => {
    work("s1"); work("s2"); start("s1", "child-a"); start("s2", "child-b");
    assert.strictEqual(shown(), JUGGLE);
  });

  it("excludes headless subagents from the visual tier", () => {
    work("s1");
    start("s1", "child-a");
    update(api, {
      id: "headless",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-hidden",
      subagentLifecycleSource: "native",
      headless: true,
    });
    assert.strictEqual(shown(), GROOVE);
  });

  it("deduplicates same-id starts and ignores duplicate/unknown stops", () => {
    work();
    start("s1", "child-a");
    start("s1", "child-a");
    assert.strictEqual(shown(), GROOVE);
    start("s1", "child-b");
    stop("s1", "unknown-child");
    assert.strictEqual(shown(), JUGGLE);
    stop("s1", "child-a");
    stop("s1", "child-a");
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.strictEqual(shown(), GROOVE);
  });

  it("classifies nested Agent ids as originators, not the launched child", () => {
    work();
    start("s1", "parent-child");
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "parent-child",
      subagentLifecycleSource: "synthetic-tool",
      toolName: "Agent",
    });
    assert.strictEqual(shown(), GROOVE, "synthetic delivery must not invent a second child");
    start("s1", "nested-child");
    assert.strictEqual(shown(), JUGGLE);
  });

  it("bounds anonymous Cursor/Kimi lanes at one and restores on first stop", () => {
    for (const [id, agentId] of [
      ["cursor", "cursor-agent"],
      ["kimi", "kimi-cli"],
    ]) {
      anonymousStart(id, agentId);
      anonymousStart(id, agentId);
      assert.strictEqual(api.sessions.get(id).subagentTracker.legacyFloor, true);
      assert.strictEqual(api.sessions.get(id).subagentTracker.confirmedIds.size, 0);
      anonymousStop(id, agentId);
      assert.ok(!api.sessions.has(id));
    }
  });

  it("matches the Desktop D0 Agent/native ordering without double counting", () => {
    work();
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentLifecycleSource: "synthetic-tool",
      toolName: "Agent",
    });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentLifecycleSource: "synthetic-tool",
      toolName: "Agent",
    });
    assert.strictEqual(shown(), GROOVE, "anonymous observations remain a floor of one");

    start("s1", "desktop-child-a");
    start("s1", "desktop-child-b");
    assert.strictEqual(shown(), JUGGLE);

    stop("s1", "desktop-child-a");
    assert.strictEqual(shown(), GROOVE);
    stop("s1", "desktop-child-b");
    assert.strictEqual(api.resolveDisplayState(), "working");

    update(api, { id: "s1", state: "working", event: "PostToolUse", toolName: "Agent" });
    assert.strictEqual(shown(), TYPING);
  });

  it("treats Reasonix's unmatched anonymous stop as inert", () => {
    anonymousStop("reasonix-only-stop", "reasonix");
    assert.strictEqual(api.sessions.has("reasonix-only-stop"), false);
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("keeps confirmed, anonymous, and recovered lanes independent across sessions", () => {
    api.sessions.set("confirmed", rawSession("juggling", {
      subagentTracker: {
        confirmedIds: new Set(["child-a", "child-b"]),
        legacyFloor: false,
        recoveredFloor: false,
      },
    }));
    api.sessions.set("anonymous", rawSession("juggling", {
      subagentTracker: {
        confirmedIds: new Set(),
        legacyFloor: true,
        recoveredFloor: false,
      },
    }));
    api.sessions.set("recovered", rawSession("juggling", {
      subagentTracker: {
        confirmedIds: new Set(),
        legacyFloor: false,
        recoveredFloor: true,
      },
    }));
    assert.strictEqual(countLiveSubagents(api.sessions), 4);
  });

  it("readmits a child when activity follows a vetoed SubagentStop", () => {
    work();
    start("s1", "child-a");
    stop("s1", "child-a");
    assert.strictEqual(api.resolveDisplayState(), "working");
    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      subagentId: "child-a",
      toolName: "Bash",
    });
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.has("child-a"), true);
  });

  it("keeps confirmed background children across a parent UserPromptSubmit", () => {
    work();
    start("s1", "child-a");
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit" });
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.has("child-a"), true);
  });

  it("preserves confirmed children across compact/resume SessionStart events", () => {
    work();
    start("s1", "child-a");
    update(api, {
      id: "s1",
      state: "thinking",
      event: "SessionStart",
      sessionStartSource: "compact",
    });
    assert.strictEqual(api.resolveDisplayState(), "juggling");
    assert.deepStrictEqual(
      [...api.sessions.get("s1").subagentTracker.confirmedIds],
      ["child-a"]
    );

    update(api, {
      id: "s1",
      state: "thinking",
      event: "SessionStart",
      sessionStartSource: "resume",
    });
    assert.deepStrictEqual(
      [...api.sessions.get("s1").subagentTracker.confirmedIds],
      ["child-a"]
    );
  });

  it("clears tracker and typed marker at a fresh startup/clear SessionStart boundary", () => {
    work();
    start("s1", "child-a");
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    assert.ok(Number.isFinite(api.sessions.get("s1").claudeBackgroundSubagentHoldAt));
    update(api, {
      id: "s1",
      state: "idle",
      event: "SessionStart",
      sessionStartSource: "startup",
    });
    assert.strictEqual(api.resolveDisplayState(), "idle");
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, null);

    start("s1", "child-b");
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    assert.ok(Number.isFinite(api.sessions.get("s1").claudeBackgroundSubagentHoldAt));
    update(api, {
      id: "s1",
      state: "idle",
      event: "SessionStart",
      sessionStartSource: "clear",
    });
    assert.strictEqual(api.resolveDisplayState(), "idle");
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, null);
  });

  it("keeps one-shot presentation separate from the underlying juggling state", () => {
    work();
    start("s1", "child-a");
    update(api, { id: "s1", state: "error", event: "PostToolUseFailure" });
    assert.strictEqual(api.sessions.get("s1").state, "juggling");
    assert.strictEqual(api.resolveDisplayState(), "juggling");
  });

  it("bounds a failed legacy synthetic Task until accepted main completion", () => {
    work();
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentLifecycleSource: "synthetic-task",
      toolName: "Task",
    });
    update(api, { id: "s1", state: "error", event: "PostToolUseFailure", toolName: "Task" });
    assert.strictEqual(api.sessions.get("s1").subagentTracker.legacyFloor, true);
    assert.strictEqual(api.resolveDisplayState(), "juggling");

    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
    });
    assert.strictEqual(api.sessions.get("s1").subagentTracker.legacyFloor, false);
    assert.strictEqual(api.resolveDisplayState(), "idle");
  });

  it("subagent-scoped SessionEnd removes only the matching child", () => {
    work();
    start("s1", "child-a");
    start("s1", "child-b");
    update(api, {
      id: "s1",
      state: "sleeping",
      event: "SessionEnd",
      subagentId: "child-a",
      subagentLifecycleSource: "native",
    });
    assert.ok(api.sessions.has("s1"));
    assert.deepStrictEqual(
      [...api.sessions.get("s1").subagentTracker.confirmedIds],
      ["child-b"]
    );
    assert.strictEqual(api.resolveDisplayState(), "juggling");
  });

  it("drops tracker state with parent SessionEnd, dismiss, and agent disable", () => {
    work();
    start("s1", "child-a");
    update(api, { id: "s1", state: "sleeping", event: "SessionEnd" });
    assert.strictEqual(api.sessions.has("s1"), false);

    work("dismissed");
    start("dismissed", "child-b");
    assert.strictEqual(api.dismissSession("dismissed"), true);
    assert.strictEqual(api.sessions.has("dismissed"), false);

    work("disabled");
    start("disabled", "child-c");
    assert.strictEqual(api.clearSessionsByAgent("claude-code"), 1);
    assert.strictEqual(api.sessions.has("disabled"), false);
  });
});

describe("#862 renderer tier timing", () => {
  let api;
  let changes;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    changes = [];
    api = require("../src/state")(makeCtx({
      sendToRenderer: (channel, state, svg) => {
        if (channel === "state-change") changes.push([state, svg]);
      },
    }));
    api.applyState("working", "clawd-working-typing.svg");
    changes.length = 0;
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
  });

  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  function native(event, child, state) {
    update(api, {
      id: "s1",
      state,
      event,
      subagentId: child,
      subagentLifecycleSource: "native",
    });
  }

  it("re-resolves 1→2→1 during the working min-display window", () => {
    native("SubagentStart", "child-a", "juggling");
    native("SubagentStart", "child-b", "juggling");
    native("SubagentStop", "child-b", "working");
    assert.deepStrictEqual(changes, [], "working should remain visible for its minimum duration");

    mock.timers.tick(1000);
    assert.deepStrictEqual(changes, [["juggling", "clawd-headphones-groove.svg"]],
      "the delayed paint must use the live 1-child tier, not a stale queued 2+ asset");
  });

  it("updates the rendered asset as confirmed ids move 2→1→0", () => {
    native("SubagentStart", "child-a", "juggling");
    native("SubagentStart", "child-b", "juggling");
    mock.timers.tick(1000);
    assert.deepStrictEqual(changes.at(-1), ["juggling", "clawd-working-juggling.svg"]);

    native("SubagentStop", "child-a", "working");
    assert.deepStrictEqual(changes.at(-1), ["juggling", "clawd-headphones-groove.svg"]);

    native("SubagentStop", "child-b", "working");
    assert.deepStrictEqual(changes.at(-1), ["working", "clawd-working-typing.svg"]);
  });

  it("returns from a one-shot error to the live juggling tier", () => {
    native("SubagentStart", "child-a", "juggling");
    mock.timers.tick(1000);
    changes.length = 0;

    update(api, { id: "s1", state: "error", event: "PostToolUseFailure" });
    assert.deepStrictEqual(changes.at(-1), ["error", "clawd-error.svg"]);
    assert.strictEqual(api.sessions.get("s1").state, "juggling");

    mock.timers.tick(5000);
    assert.deepStrictEqual(changes.at(-1), ["juggling", "clawd-headphones-groove.svg"]);
  });
});

describe("hitbox selection", () => {
  let api;

  afterEach(() => { if (api) api.cleanup(); });

  it("uses a file-specific hitbox for the displayed SVG", () => {
    const theme = cloneTheme(_defaultTheme);
    const fileBox = { x: 10, y: 11, w: 12, h: 13 };
    theme.fileHitBoxes = { "clawd-working-typing.svg": fileBox };
    api = require("../src/state")(makeCtx({ theme }));

    api.applyState("working", "clawd-working-typing.svg");

    assert.deepStrictEqual(api.getCurrentHitBox(), fileBox);
  });

  it("keeps wide/default fallback when no file-specific hitbox exists", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.fileHitBoxes = {};
    api = require("../src/state")(makeCtx({ theme }));

    api.applyState("error", "clawd-error.svg");
    assert.deepStrictEqual(api.getCurrentHitBox(), theme.hitBoxes.wide);

    api.applyState("working", "clawd-working-typing.svg");
    assert.deepStrictEqual(api.getCurrentHitBox(), theme.hitBoxes.default);
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

  it("wake-from-doze returns to the user-selected idle visual", () => {
    api.cleanup();
    ctx = makeCtx({
      getCursorScreenPoint: () => ({ ...fakeCursor }),
      getIdleVisualChoice: () => "clawd-idle-reading.svg",
    });
    const changes = [];
    ctx.sendToRenderer = (ev, ...args) => { if (ev === "state-change") changes.push(args); };
    api = require("../src/state")(ctx);

    api.applyState("dozing");
    mock.timers.tick(500);
    fakeCursor.x = 200;
    mock.timers.tick(200);
    mock.timers.tick(350);
    assert.strictEqual(api.getCurrentState(), "idle");
    assert.deepStrictEqual(changes[changes.length - 1], ["idle", "clawd-idle-reading.svg"]);
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

  // ── wake-poll lifecycle hardening (kept after the low-power cadence change was
  // dropped): the start timer is now tracked so it can't fire after teardown. ──
  it("keeps the wake cursor baseline when state changes mid-poll", () => {
    api.applyState("collapsing");
    mock.timers.tick(500); // start delay → wake poll begins, baseline = current cursor
    api.applyState("sleeping"); // state change must NOT reset the baseline or the timer
    fakeCursor.x = 200;
    mock.timers.tick(200); // existing poll still sees movement from the original baseline
    assert.strictEqual(api.getCurrentState(), "waking");
  });

  it("cleanup clears a pending wake-poll start before it samples the cursor", () => {
    let cursorCalls = 0;
    api.cleanup();
    ctx = makeCtx({
      getCursorScreenPoint: () => { cursorCalls += 1; return { ...fakeCursor }; },
    });
    api = require("../src/state")(ctx);

    api.applyState("dozing"); // schedules the 500ms wake-poll start
    api.cleanup();            // must cancel the pending start timer
    mock.timers.tick(500);

    assert.strictEqual(cursorCalls, 0);
  });

  it("DND clears a pending wake-poll start before it samples the cursor", () => {
    let cursorCalls = 0;
    api.cleanup();
    ctx = makeCtx({
      getCursorScreenPoint: () => { cursorCalls += 1; return { ...fakeCursor }; },
    });
    api = require("../src/state")(ctx);

    api.applyState("dozing");
    api.enableDoNotDisturb(); // leaving the wake-poll states must cancel the pending start
    mock.timers.tick(500);

    assert.strictEqual(cursorCalls, 0);
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
    const session = rawSession("working", { agentPid: 9999, pidReachable: true });
    session.claudeBackgroundSubagentHoldAt = Date.now();
    api.sessions.set("s1", session);
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("clears the exact session automation identity before stale deletion", () => {
    const lifecycle = [];
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      onSessionAutomationLifecycleEnd: (payload) => lifecycle.push(payload),
    }));
    api.sessions.set("s1", rawSession("working", {
      agentId: "claude-code",
      agentPid: 9999,
      pidReachable: true,
    }));
    api.cleanStaleSessions();
    assert.deepStrictEqual(lifecycle, [{
      agentId: "claude-code",
      sessionId: "s1",
      reason: "stale-delete-agent-exit",
    }]);
    assert.strictEqual(api.sessions.size, 0);
  });

  it("empty-session return rests on the user-selected idle visual", () => {
    const changes = [];
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      getIdleVisualChoice: () => "clawd-idle-reading.svg",
      sendToRenderer: (ev, ...args) => { if (ev === "state-change") changes.push(args); },
    }));
    api.sessions.set("s1", rawSession("working", { agentPid: 9999, pidReachable: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
    assert.deepStrictEqual(changes[changes.length - 1], ["idle", "clawd-idle-reading.svg"]);
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
    const staleSession = rawSession("working", {
      agentPid: 1000, sourcePid: 2000, pidReachable: true,
      updatedAt: Date.now() - 310000,
      subagentTracker: {
        confirmedIds: new Set(["child-a"]),
        legacyFloor: true,
        recoveredFloor: true,
      },
    });
    staleSession.claudeBackgroundSubagentHoldAt = Date.now() - 310000;
    api.sessions.set("s1", staleSession);
    api.cleanStaleSessions();
    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(session.subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(session.subagentTracker.legacyFloor, false);
    assert.strictEqual(session.subagentTracker.recoveredFloor, false);
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, null);
  });

  it("parent progress postpones the configured silence fallback without clearing the typed marker", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set([1000, 2000])),
      getStaleConfig: () => ({ sessionStaleMs: 1000, workingStaleMs: 100 }),
    }));
    const session = rawSession("working", {
      agentId: "claude-code",
      agentPid: 1000,
      sourcePid: 2000,
      pidReachable: true,
      updatedAt: Date.now() - 99,
    });
    session.claudeBackgroundSubagentHoldAt = Date.now() - 1000;
    api.sessions.set("s1", session);

    assert.strictEqual(api.touchSessionActivity("s1", { agentId: "claude-code" }), true);
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(Number.isFinite(api.sessions.get("s1").claudeBackgroundSubagentHoldAt));

    api.sessions.get("s1").updatedAt = Date.now() - 101;
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, null);
  });

  it("keeps local OpenCode blocker-facing work active past the generic session cutoff", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set([1000, 2000])),
      getStaleConfig: () => ({
        sessionStaleMs: 600_000,
        workingStaleMs: 300_000,
      }),
    }));
    api.sessions.set("opencode:s1", rawSession("working", {
      agentId: "opencode",
      agentPid: 1000,
      sourcePid: 2000,
      pidReachable: true,
      updatedAt: Date.now() - 600_001,
    }));

    api.cleanStaleSessions();

    const active = api.sessions.get("opencode:s1");
    assert.strictEqual(active.state, "working");
    assert.strictEqual(isSessionInProgress(active), true);
  });

  it("genuine OpenCode session.idle completion still records normal Stop semantics", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set([1000, 2000])),
    }));
    api.updateSession("opencode:s1", "working", "PreToolUse", {
      agentId: "opencode",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
    });
    api.updateSession("opencode:s1", "attention", "Stop", {
      agentId: "opencode",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
    });

    const completed = api.sessions.get("opencode:s1");
    assert.strictEqual(completed.state, "idle");
    assert.strictEqual(completed.recentEvents.at(-1).event, "Stop");
    assert.strictEqual(api.deriveSessionBadge(completed), "done");
  });

  it("pidReachable false + stale work idles first, then expires through idle retention", () => {
    api = require("../src/state")(makeCtx());
    api.sessions.set("s1", rawSession("working", {
      pidReachable: false,
      updatedAt: Date.now() - 700000,
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    api.sessions.get("s1").updatedAt = Date.now() - 700000;
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("detached ended idle session expires quickly when auto-clear is enabled", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("s1", rawSession("idle", {
      agentId: "claude-code",
      sourcePid: 9999,
      pidReachable: true,
      updatedAt: Date.now() - 31000,
      recentEvents: [{ event: "Stop", state: "attention", at: Date.now() - 32000 }],
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
  });

  it("detached idle session stays by default before normal stale cleanup", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set()) }));
    api.sessions.set("s1", rawSession("idle", {
      agentId: "claude-code",
      sourcePid: 9999,
      pidReachable: true,
      updatedAt: Date.now() - 31000,
      recentEvents: [{ event: "Stop", state: "attention", at: Date.now() - 32000 }],
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 1);
  });

  it("broadcasts HUD-hidden state before deleting detached ended session", () => {
    const alivePids = new Set([9999]);
    const broadcasts = [];
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(alivePids),
      sessionHudCleanupDetached: true,
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
    api.sessions.set("s1", rawSession("idle", {
      agentId: "claude-code",
      sourcePid: 9999,
      pidReachable: true,
      updatedAt: Date.now() - 10000,
      recentEvents: [{ event: "Stop", state: "attention", at: Date.now() - 11000 }],
    }));

    assert.strictEqual(api.emitSessionSnapshot({ force: true }).changed, true);
    assert.strictEqual(broadcasts[0].sessions.find((s) => s.id === "s1").hiddenFromHud, false);

    alivePids.delete(9999);
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 1);
    assert.strictEqual(broadcasts.length, 2);
    assert.strictEqual(broadcasts[1].sessions.find((s) => s.id === "s1").hiddenFromHud, true);
  });

  it("detached idle session without an ended badge does not auto-clear", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("s1", rawSession("idle", {
      agentId: "gemini-cli",
      sourcePid: 9999,
      pidReachable: true,
      updatedAt: Date.now() - 31000,
      recentEvents: [{ event: "AfterAgent", state: "idle", at: Date.now() - 32000 }],
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 1);
  });

  it("detached ended session does not auto-clear when pid reachability was never confirmed", () => {
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("s1", rawSession("idle", {
      agentId: "claude-code",
      sourcePid: 9999,
      pidReachable: false,
      updatedAt: Date.now() - 31000,
      recentEvents: [{ event: "Stop", state: "attention", at: Date.now() - 32000 }],
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 1);
  });

  it("detached ended Kimi auto-clear disposes notification state", () => {
    const cleared = [];
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
      clearKimiNotifyBubbles: (id, reason) => cleared.push({ id, reason }),
    }));
    api.updateSession("k1", "notification", "PermissionRequest", { agentId: "kimi-cli" });
    api.sessions.set("k1", rawSession("idle", {
      agentId: "kimi-cli",
      sourcePid: 9999,
      pidReachable: true,
      updatedAt: Date.now() - 31000,
      recentEvents: [{ event: "Stop", state: "attention", at: Date.now() - 32000 }],
    }));
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.size, 0);
    assert.deepStrictEqual(cleared, [{ id: "k1", reason: "kimi-session-disposed" }]);
  });

  it("last non-headless deleted → returns to idle", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set()) }));
    api.sessions.set("s1", rawSession("working", { agentPid: 9999, pidReachable: true }));
    api.cleanStaleSessions();
    assert.strictEqual(api.getCurrentState(), "idle");
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

  it("stores only a normalized route-owned session automation assessment", () => {
    update(api, {
      id: "automation-identity",
      sessionAutomationIdentity: {
        eligible: false,
        reason: "  placeholder-session-id  ",
        senderControlledExtra: true,
      },
    });

    const stored = api.sessions.get("automation-identity").sessionAutomationIdentity;
    assert.deepStrictEqual(stored, {
      eligible: false,
      reason: "placeholder-session-id",
    });
    assert.strictEqual(Object.isFrozen(stored), true);

    update(api, {
      id: "automation-identity",
      event: "PostToolUse",
      sessionAutomationIdentity: { eligible: "yes", reason: "malformed" },
    });
    assert.deepStrictEqual(
      api.sessions.get("automation-identity").sessionAutomationIdentity,
      { eligible: false, reason: "invalid-route-assessment" },
      "malformed internal input must fail closed instead of preserving eligibility"
    );
  });

  // #627 safety net: the pid-snapshot cache omits pid_chain on cache-hit events,
  // relying on updateSession MERGING (keeping the last pidChain) rather than
  // OVERWRITING it to null. If a future refactor flips this to overwrite, the
  // cache would blank out terminal-tab focus — this test pins the behavior.
  it("update omitting pidChain keeps the previously stored pidChain (MERGE)", () => {
    update(api, { id: "merge1", event: "SessionStart", state: "idle", pidChain: [700, 800, 900], sourcePid: 900 });
    assert.deepStrictEqual(api.sessions.get("merge1").pidChain, [700, 800, 900]);

    // A high-frequency event that carries no pid_chain must not clear it.
    update(api, { id: "merge1", event: "PreToolUse", state: "working", pidChain: null, sourcePid: 900 });
    assert.deepStrictEqual(
      api.sessions.get("merge1").pidChain,
      [700, 800, 900],
      "omitting pidChain must merge (keep old), not overwrite with null",
    );
  });

  // Same MERGE guarantee on the PermissionRequest persistence path (state.js:1367),
  // which is a separate code branch from the main update path. #627 does not cache
  // this path (PermissionRequest is an HTTP hook), but plan §6 asks both branches
  // be pinned so a future refactor cannot flip either to overwrite-with-null.
  it("PermissionRequest path also merges pidChain when a later request omits it", () => {
    const sid = "codex:merge-perm";
    update(api, { id: sid, event: "PermissionRequest", state: "notification", agentId: "codex", sourcePid: 456, agentPid: 456, pidChain: [321, 456] });
    assert.deepStrictEqual(api.sessions.get(sid).pidChain, [321, 456]);

    // A later codex PermissionRequest that still persists focus (sourcePid set)
    // but omits pidChain must keep the old chain, not blank it.
    update(api, { id: sid, event: "PermissionRequest", state: "notification", agentId: "codex", sourcePid: 456, agentPid: 456, pidChain: null });
    assert.deepStrictEqual(
      api.sessions.get(sid).pidChain,
      [321, 456],
      "PermissionRequest path must merge, not overwrite with null",
    );
  });

  it("authoritative state metadata replaces and clears every derived process field", () => {
    update(api, {
      id: "authoritative-state",
      event: "SessionStart",
      sourcePid: 100,
      agentPid: 200,
      pidChain: [100, 200],
      editor: "code",
      wtHwnd: "1234",
      orcaPaneKey: "tab-1:leaf-1",
    });

    update(api, {
      id: "authoritative-state",
      event: "PreToolUse",
      replaceProcessMetadata: true,
      sourcePid: null,
      agentPid: null,
      pidChain: null,
      editor: null,
    });

    const session = api.sessions.get("authoritative-state");
    assert.strictEqual(session.sourcePid, null);
    assert.strictEqual(session.agentPid, null);
    assert.strictEqual(session.pidChain, null);
    assert.strictEqual(session.editor, null);
    assert.strictEqual(session.wtHwnd, null);
    assert.strictEqual(session.orcaPaneKey, null);
    assert.strictEqual(session.pidReachable, false);
  });

  it("authoritative Cursor clear preserves its adapter-owned editor fallback", () => {
    update(api, {
      id: "authoritative-cursor",
      event: "SessionStart",
      agentId: "cursor-agent",
      sourcePid: 100,
      agentPid: 200,
      pidChain: [100, 200],
      editor: "cursor",
    });
    update(api, {
      id: "authoritative-cursor",
      event: "PreToolUse",
      agentId: "cursor-agent",
      replaceProcessMetadata: true,
      editor: "cursor",
    });

    const session = api.sessions.get("authoritative-cursor");
    assert.strictEqual(session.sourcePid, null);
    assert.strictEqual(session.agentPid, null);
    assert.strictEqual(session.pidChain, null);
    assert.strictEqual(session.editor, "cursor");
  });

  it("authoritative Codex PermissionRequest clears stale focus without creating an all-null ghost", () => {
    const sid = "codex:authoritative-permission";
    update(api, {
      id: sid,
      event: "PermissionRequest",
      state: "notification",
      agentId: "codex",
      sourcePid: 456,
      agentPid: 456,
      pidChain: [321, 456],
      wtHwnd: "9876",
      orcaPaneKey: "tab-2:leaf-2",
      replaceProcessMetadata: true,
    });
    update(api, {
      id: sid,
      event: "PermissionRequest",
      state: "notification",
      agentId: "codex",
      replaceProcessMetadata: true,
    });

    const session = api.sessions.get(sid);
    assert.strictEqual(session.sourcePid, null);
    assert.strictEqual(session.agentPid, null);
    assert.strictEqual(session.pidChain, null);
    assert.strictEqual(session.wtHwnd, null);
    assert.strictEqual(session.orcaPaneKey, null);
    assert.strictEqual(session.pidReachable, false);

    api.updateSession("codex:all-null-new", "notification", "PermissionRequest", {
      agentId: "codex",
      replaceProcessMetadata: true,
    });
    assert.strictEqual(api.sessions.has("codex:all-null-new"), false);
  });

  it("existing session_id → updates state and timestamp", () => {
    update(api, { id: "s1", state: "working" });
    const t1 = api.sessions.get("s1").updatedAt;
    update(api, { id: "s1", state: "thinking" });
    assert.strictEqual(api.sessions.get("s1").state, "thinking");
    assert.ok(api.sessions.get("s1").updatedAt >= t1);
  });

  it("defaulted Claude attribution does not overwrite a remembered agent id", () => {
    api.updateSession("opencode-s1", "thinking", "UserPromptSubmit", {
      agentId: "opencode",
      cwd: "/repo",
    });
    api.updateSession("opencode-s1", "working", "PreToolUse", {
      agentId: "claude-code",
      agentIdDefaulted: true,
    });

    assert.strictEqual(api.sessions.get("opencode-s1").agentId, "opencode");
  });

  it("explicit attribution can replace a remembered agent id for a reused session id", () => {
    api.updateSession("shared-s1", "thinking", "UserPromptSubmit", {
      agentId: "opencode",
      cwd: "/repo",
    });
    api.updateSession("shared-s1", "working", "PreToolUse", {
      agentId: "claude-code",
    });

    assert.strictEqual(api.sessions.get("shared-s1").agentId, "claude-code");
  });

  it("defaulted Claude attribution is still used for new legacy sessions", () => {
    api.updateSession("legacy-s1", "working", "PreToolUse", {
      agentId: "claude-code",
      agentIdDefaulted: true,
    });

    assert.strictEqual(api.sessions.get("legacy-s1").agentId, "claude-code");
  });

  it("opencode namespaced ids do not collide with bare Claude session ids", () => {
    api.updateSession("opencode:shared-sid", "thinking", "UserPromptSubmit", {
      agentId: "opencode",
      sessionTitle: "hello",
    });
    api.updateSession("shared-sid", "attention", "Stop", {
      agentId: "claude-code",
      sessionTitle: "hi",
    });

    assert.strictEqual(api.sessions.get("opencode:shared-sid").agentId, "opencode");
    assert.strictEqual(api.sessions.get("opencode:shared-sid").sessionTitle, "hello");
    assert.strictEqual(api.sessions.get("shared-sid").agentId, "claude-code");
    assert.strictEqual(api.sessions.get("shared-sid").sessionTitle, "hi");
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

  it("clears session automation before a main SessionEnd but not a subagent lifecycle event", () => {
    api.cleanup();
    const lifecycle = [];
    api = require("../src/state")(makeCtx({
      onSessionAutomationLifecycleEnd: (payload) => lifecycle.push(payload),
    }));
    update(api, { id: "main", agentId: "claude-code", state: "working" });
    update(api, {
      id: "main",
      agentId: "claude-code",
      state: "sleeping",
      event: "SessionEnd",
    });
    update(api, { id: "sub", agentId: "claude-code", state: "working" });
    update(api, {
      id: "sub",
      agentId: "claude-code",
      state: "sleeping",
      event: "SessionEnd",
      subagentId: "child-1",
    });
    assert.deepStrictEqual(lifecycle, [{
      agentId: "claude-code",
      sessionId: "main",
      reason: "session-end",
    }]);
  });

  it("dismissSession removes only Clawd bookkeeping for that session", () => {
    update(api, { id: "s1", state: "working" });
    update(api, { id: "s2", state: "thinking" });

    assert.strictEqual(api.dismissSession("s1"), true);
    assert.ok(!api.sessions.has("s1"));
    assert.ok(api.sessions.has("s2"));
    assert.strictEqual(api.resolveDisplayState(), "thinking");
    assert.strictEqual(api.dismissSession("missing"), false);
  });

  it("PermissionRequest → notification state, no session creation", () => {
    update(api, {
      id: "perm1",
      state: "notification",
      event: "PermissionRequest",
      sessionAutomationIdentity: { eligible: true, reason: "eligible" },
    });
    assert.ok(!api.sessions.has("perm1"));
    assert.strictEqual(api.getCurrentState(), "notification");
  });

  it("PermissionRequest refreshes identity only on an existing same-agent session", () => {
    update(api, {
      id: "perm-existing",
      state: "working",
      event: "PreToolUse",
      agentId: "claude-code",
    });
    const existing = api.sessions.get("perm-existing");
    existing.startupRecovered = true;
    assert.strictEqual(existing.sessionAutomationIdentity, null);

    update(api, {
      id: "perm-existing",
      state: "notification",
      event: "PermissionRequest",
      agentId: "claude-code",
      sessionAutomationIdentity: { eligible: true, reason: "eligible" },
    });

    assert.strictEqual(api.sessions.get("perm-existing").state, "working");
    assert.strictEqual(api.sessions.get("perm-existing").startupRecovered, true);
    assert.deepStrictEqual(
      api.sessions.get("perm-existing").sessionAutomationIdentity,
      { eligible: true, reason: "eligible" }
    );

    update(api, {
      id: "perm-existing",
      state: "notification",
      event: "PermissionRequest",
      agentId: "claude-code",
      sessionAutomationIdentity: { eligible: false, reason: "placeholder-session-id" },
    });
    assert.deepStrictEqual(
      api.sessions.get("perm-existing").sessionAutomationIdentity,
      { eligible: false, reason: "placeholder-session-id" },
      "a later fail-closed route assessment must replace stale eligibility"
    );
  });

  it("PermissionRequest never writes an identity across an agent collision", () => {
    update(api, {
      id: "shared-session-id",
      state: "working",
      event: "PreToolUse",
      agentId: "codex",
      sessionAutomationIdentity: { eligible: false, reason: "codex-unverified" },
    });

    update(api, {
      id: "shared-session-id",
      state: "notification",
      event: "PermissionRequest",
      agentId: "claude-code",
      sessionAutomationIdentity: { eligible: true, reason: "eligible" },
    });

    const session = api.sessions.get("shared-session-id");
    assert.strictEqual(session.agentId, "codex");
    assert.deepStrictEqual(
      session.sessionAutomationIdentity,
      { eligible: false, reason: "codex-unverified" }
    );
  });

  it("Codex user-input request flashes notification while preserving session state", () => {
    update(api, {
      id: "codex:question",
      state: "working",
      event: "PreToolUse",
      agentId: "codex",
      sourcePid: 456,
      cwd: "/repo",
    });
    update(api, {
      id: "codex:question",
      state: "notification",
      event: "CodexUserInputRequest",
      agentId: "codex",
      sourcePid: 456,
      cwd: "/repo",
      transientPermissionEvent: true,
    });

    assert.strictEqual(api.sessions.get("codex:question").state, "working");
    mock.timers.tick(1000);
    assert.strictEqual(api.getCurrentState(), "notification");
    assert.strictEqual(api.sessions.get("codex:question").recentEvents.at(-1).event, "PreToolUse");
  });

  it("Codex PermissionRequest persists focus metadata for snapshots", () => {
    update(api, {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
      cwd: "/repo",
      agentPid: 456,
      pidChain: [789, 456],
      model: "gpt-5.4",
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
    });

    const session = api.sessions.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.ok(session);
    assert.strictEqual(session.agentId, "codex");
    assert.strictEqual(session.sourcePid, 456);
    assert.strictEqual(session.cwd, "/repo");
    assert.deepStrictEqual(session.pidChain, [789, 456]);
    assert.strictEqual(session.codexOriginator, "Codex Desktop");
    assert.strictEqual(session.codexSource, "vscode");
    const entry = api.getLastSessionSnapshot().sessions.find((item) =>
      item.id === "codex:019e115a-4df2-7ed0-b90e-8e6345aca777"
    );
    assert.strictEqual(entry.canFocus, true);
    assert.deepStrictEqual(entry.focusTarget, {
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
  });

  it("Codex Desktop focus metadata downgrades on Windows", () => {
    api = require("../src/state")(makeCtx({ focusHostPlatform: "win32" }));

    update(api, {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
      agentPid: 456,
      codexOriginator: "Codex Desktop",
    });
    update(api, {
      id: "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
      state: "working",
      event: "PreToolUse",
      agentId: "codex",
      codexOriginator: "Codex Desktop",
    });

    const byId = new Map(api.getLastSessionSnapshot().sessions.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").canFocus, true);
    assert.deepStrictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").focusTarget, {
      type: "terminal",
      url: null,
    });
    assert.strictEqual(byId.get("codex:019e115b-4df2-7ed0-b90e-8e6345aca777").canFocus, false);
    assert.strictEqual(byId.get("codex:019e115b-4df2-7ed0-b90e-8e6345aca777").focusTarget, null);
  });

  it("keeps wtHwnd sticky when later events do not provide one", () => {
    update(api, {
      id: "s1",
      state: "idle",
      event: "SessionStart",
      sourcePid: 100,
      wtHwnd: "123456",
    });
    update(api, {
      id: "s1",
      state: "working",
      event: "PostToolUse",
      sourcePid: 100,
    });

    const session = api.sessions.get("s1");
    assert.strictEqual(session.wtHwnd, "123456");
    const entry = api.getLastSessionSnapshot().sessions.find((item) => item.id === "s1");
    assert.strictEqual(entry.wtHwnd, "123456");
  });

  it("keeps the Orca pane key sticky across later events that omit it", () => {
    // Remote bodies never carry the pane key and some agents post state without
    // the process-metadata block at all, so a later event without it must not
    // blank the key or focus loses the pane.
    update(api, {
      id: "s1",
      state: "thinking",
      event: "UserPromptSubmit",
      sourcePid: 100,
      orcaPaneKey: "tab-1:leaf-1",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    update(api, { id: "s1", state: "working", event: "PreToolUse", sourcePid: 100 });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      sourcePid: 100,
      orcaPaneKey: "tab-2:leaf-2",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-2:leaf-2");
  });

  it("drops a stale Orca pane key when the session restarts in another terminal", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      event: "UserPromptSubmit",
      sourcePid: 100,
      orcaPaneKey: "tab-1:leaf-1",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    // Resuming the same session id from a different terminal posts a SessionStart
    // whose env has no pane key. Keeping the old one would raise Orca instead of
    // the terminal the agent actually moved to, and the pane key outranks the
    // wt_hwnd that would have been correct.
    update(api, { id: "s1", state: "idle", event: "SessionStart", sourcePid: 200, wtHwnd: "4660" });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, null);
    assert.strictEqual(api.sessions.get("s1").wtHwnd, "4660");

    // A SessionStart that does carry one still wins.
    update(api, {
      id: "s1",
      state: "idle",
      event: "SessionStart",
      sourcePid: 300,
      orcaPaneKey: "tab-9:leaf-9",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-9:leaf-9");
  });

  it("drops a stale Orca pane key on every spelling of a session start", () => {
    // Producers do not agree on the name: copilot-hook.js posts its raw argv name
    // "sessionStart" and kiro-hook.js posts "agentSpawn". Matching only
    // "SessionStart" left both able to keep a stale key indefinitely, and Kiro is
    // the worst case — its stdin carries no session id, so every session merges
    // into "default" and the key would never be cleared at all.
    for (const event of ["SessionStart", "sessionStart", "agentSpawn"]) {
      update(api, {
        id: "s1",
        state: "thinking",
        event: "UserPromptSubmit",
        sourcePid: 100,
        orcaPaneKey: "tab-1:leaf-1",
      });
      assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

      update(api, { id: "s1", state: "idle", event, sourcePid: 200, wtHwnd: "4660" });
      assert.strictEqual(api.sessions.get("s1").orcaPaneKey, null, `${event} must clear the pane key`);
    }
  });

  it("drops a stale Orca pane key when a producer with no session-start event moves terminal", () => {
    // antigravity-hook.js posts none of the three session-start spellings, so the
    // event-name rule never fires for it and a pane key outlived its pane forever.
    // Its id normalizes payload.conversationId, so resuming the same conversation
    // from another terminal lands back on this same entry.
    update(api, {
      id: "s1",
      state: "thinking",
      event: "agentMessage",
      sourcePid: 100,
      orcaPaneKey: "tab-1:leaf-1",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    update(api, { id: "s1", state: "working", event: "agentMessage", sourcePid: 200, wtHwnd: "4660" });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, null);
    assert.strictEqual(api.sessions.get("s1").sourcePid, 200);
    assert.strictEqual(api.sessions.get("s1").wtHwnd, "4660");
  });

  it("drops a stale Orca pane key when only the terminal window handle changes", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      event: "agentMessage",
      sourcePid: 100,
      wtHwnd: "1111",
      orcaPaneKey: "tab-1:leaf-1",
    });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    update(api, { id: "s1", state: "working", event: "agentMessage", sourcePid: 100, wtHwnd: "2222" });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, null);
  });

  it("keeps the Orca pane key when a later event carries no new terminal identity", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      event: "agentMessage",
      sourcePid: 100,
      orcaPaneKey: "tab-1:leaf-1",
    });

    // Most events omit the process-metadata block entirely; treating "absent" as
    // "changed" would blank the key on the very next event and undo the feature.
    update(api, { id: "s1", state: "working", event: "agentMessage" });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");

    // Producers are not consistent about the wire type of the pid, and a bare
    // !== would read 100 and "100" as two different terminals.
    update(api, { id: "s1", state: "working", event: "agentMessage", sourcePid: "100" });
    assert.strictEqual(api.sessions.get("s1").orcaPaneKey, "tab-1:leaf-1");
  });

  it("keeps Ghostty terminal id sticky and allows focus-only metadata updates", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      event: "UserPromptSubmit",
      sourcePid: 100,
      ghosttyTerminalId: "term-a",
    });
    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      sourcePid: 100,
    });

    assert.strictEqual(api.sessions.get("s1").ghosttyTerminalId, "term-a");
    assert.strictEqual(api.updateSessionFocusMetadata("s1", { ghosttyTerminalId: "term-b" }), true);
    assert.strictEqual(api.sessions.get("s1").ghosttyTerminalId, "term-b");
    assert.strictEqual(api.updateSessionFocusMetadata("s1", {
      sourcePid: 999,
      ghosttyTerminalId: "term-wrong-source",
    }), false);
    assert.strictEqual(api.sessions.get("s1").ghosttyTerminalId, "term-b");
    assert.strictEqual(api.updateSessionFocusMetadata("missing", { ghosttyTerminalId: "term-c" }), false);
    assert.strictEqual(api.updateSessionFocusMetadata("s1", { ghosttyTerminalId: "error:-2753" }), false);
    assert.strictEqual(api.updateSessionFocusMetadata("s1", { ghosttyTerminalId: "missing-frontmost" }), false);
    assert.strictEqual(api.sessions.get("s1").ghosttyTerminalId, "term-b");
  });

  it("Codex PermissionRequest focus metadata respects the session cap", () => {
    for (let i = 0; i < 20; i++) {
      update(api, { id: `s${i}`, state: "working" });
      mock.timers.tick(1);
    }
    assert.strictEqual(api.sessions.size, 20);

    update(api, {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
      codexOriginator: "Codex Desktop",
    });

    assert.strictEqual(api.sessions.size, 20);
    assert.ok(api.sessions.has("codex:019e115a-4df2-7ed0-b90e-8e6345aca777"));
    assert.ok(!api.sessions.has("s0"));
  });

  it("Codex PermissionRequest without an existing session does not persist notification", () => {
    update(api, {
      id: "codex:new-permission",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
      cwd: "/repo",
    });

    assert.strictEqual(api.getCurrentState(), "notification");
    assert.strictEqual(api.sessions.get("codex:new-permission").state, "idle");
    assert.strictEqual(api.resolveDisplayState(), "idle");

    mock.timers.tick(5000);

    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("Codex transient PermissionRequest preserves focus without keeping a waiting tail", () => {
    update(api, { id: "codex:native", state: "working", event: "PreToolUse", agentId: "codex" });

    api.updateSession("codex:native", "notification", "PermissionRequest", {
      agentId: "codex",
      sourcePid: 456,
      transientPermissionEvent: true,
    });

    const session = api.sessions.get("codex:native");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.sourcePid, 456);
    assert.strictEqual(session.recentEvents.at(-1).event, "PreToolUse");
    assert.ok(!session.recentEvents.some((entry) => entry.event === "PermissionRequest"));
  });

  it("stores one-shot visuals as idle while permission prompts preserve active work", () => {
    update(api, { id: "notify", state: "notification", event: "Notification", agentId: "claude-code" });
    assert.strictEqual(api.sessions.get("notify").state, "idle");

    update(api, { id: "done", state: "attention", event: "Stop", agentId: "claude-code" });
    assert.strictEqual(api.sessions.get("done").state, "idle");

    update(api, { id: "perm-active", state: "working", event: "PreToolUse", agentId: "codex" });
    update(api, {
      id: "perm-active",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
    });

    assert.strictEqual(api.sessions.get("perm-active").state, "working");
  });

  it("clearPermissionNotification releases a persisted notification session immediately", () => {
    api.sessions.set("codex:stale-permission", rawSession("notification", {
      agentId: "codex",
      sourcePid: 456,
      pidReachable: true,
    }));
    api.setState("notification");

    assert.strictEqual(api.getCurrentState(), "notification");

    assert.strictEqual(api.clearPermissionNotification("codex:stale-permission"), true);

    assert.strictEqual(api.sessions.get("codex:stale-permission").state, "idle");
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("clearPermissionNotification removes a resolved PermissionRequest tail event", () => {
    update(api, { id: "perm-active", state: "working", event: "PreToolUse", agentId: "codex" });
    update(api, {
      id: "perm-active",
      state: "notification",
      event: "PermissionRequest",
      agentId: "codex",
      sourcePid: 456,
    });

    assert.strictEqual(api.sessions.get("perm-active").recentEvents.at(-1).event, "PermissionRequest");

    assert.strictEqual(api.clearPermissionNotification("perm-active"), true);

    const session = api.sessions.get("perm-active");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.recentEvents.at(-1).event, "PreToolUse");
    assert.strictEqual(api.resolveDisplayState(), "working");
  });

  it("clearPermissionNotification restores Codex work state after stale idle downgrade", () => {
    api.sessions.set("codex:stale-approved", rawSession("idle", {
      agentId: "codex",
      sourcePid: 456,
      pidReachable: true,
      recentEvents: [
        { event: "PreToolUse", state: "working", at: Date.now() - 360000 },
        { event: "PermissionRequest", state: "working", at: Date.now() - 350000 },
      ],
    }));

    assert.strictEqual(api.clearPermissionNotification("codex:stale-approved"), true);

    const session = api.sessions.get("codex:stale-approved");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.recentEvents.at(-1).event, "PreToolUse");
    assert.strictEqual(api.getCurrentState(), "working");
  });

  it("clearPermissionNotification keeps the tail while another permission is pending", () => {
    api.sessions.set("codex:stacked", rawSession("working", {
      agentId: "codex",
      sourcePid: 456,
      pidReachable: true,
      recentEvents: [
        { event: "PreToolUse", state: "working", at: Date.now() - 2000 },
        { event: "PermissionRequest", state: "working", at: Date.now() - 1000 },
      ],
    }));

    assert.strictEqual(
      api.clearPermissionNotification("codex:stacked", { hasPendingForSession: true }),
      false,
    );

    const session = api.sessions.get("codex:stacked");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.recentEvents.at(-1).event, "PermissionRequest");
  });

  it("clearPermissionNotification also strips a resolved remote Codex tail", () => {
    api.sessions.set("codex:remote-approved", rawSession("idle", {
      agentId: "codex",
      host: "ssh://devbox",
      recentEvents: [
        { event: "PreToolUse", state: "working", at: Date.now() - 360000 },
        { event: "PermissionRequest", state: "working", at: Date.now() - 350000 },
      ],
    }));

    assert.strictEqual(api.clearPermissionNotification("codex:remote-approved"), true);

    const session = api.sessions.get("codex:remote-approved");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.recentEvents.at(-1).event, "PreToolUse");
  });

  it("SessionEnd + sweeping → plays sweeping even with other active sessions", () => {
    // Insert sessions directly to avoid MIN_DISPLAY_MS cascade from setState
    api.sessions.set("s1", rawSession("working"));
    api.sessions.set("s2", rawSession("working"));
    // currentState is idle → no MIN_DISPLAY_MS → sweeping applies immediately
    update(api, { id: "s1", state: "sweeping", event: "SessionEnd" });
    assert.strictEqual(api.getCurrentState(), "sweeping");
  });

  it("SessionEnd + last non-headless → idle", () => {
    update(api, { id: "s1", state: "working" });
    mock.timers.tick(1000);
    update(api, { id: "s1", state: "sleeping", event: "SessionEnd" });
    assert.strictEqual(api.getCurrentState(), "idle");
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

  it("includes hookSource in session debug logs", () => {
    const logs = [];
    ctx.debugLog = (msg) => logs.push(msg);

    api.updateSession("s1", "working", "PreToolUse", {
      cwd: "/tmp",
      agentId: "codex",
      hookSource: "codex-official",
    });

    assert.ok(logs.some((msg) => msg.includes("source=codex-official")));
  });

  it("Codex Stop schedules an exit probe and deletes when agentPid exits", () => {
    api.cleanup();
    const alive = new Set([1000, 2000]);
    const logs = [];
    ctx = makeCtx({
      processKill: makePidKill(alive),
      debugLog: (msg) => logs.push(msg),
    });
    api = require("../src/state")(ctx);

    api.updateSession("c1", "thinking", "UserPromptSubmit", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
    });
    api.updateSession("c1", "idle", "Stop", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
      hookSource: "codex-official",
    });

    assert.ok(api.sessions.has("c1"));
    assert.ok(logs.some((msg) => msg.includes("codex-exit-probe schedule")));

    alive.delete(1000);
    mock.timers.tick(1000);

    assert.ok(!api.sessions.has("c1"));
    assert.strictEqual(api.getCurrentState(), "idle");
    assert.ok(logs.some((msg) => msg.includes("codex-exit-probe delete reason=agent-exit")));
  });

  it("Codex exit probe keeps the session when agentPid stays alive", () => {
    api.cleanup();
    const alive = new Set([1000, 2000]);
    const logs = [];
    ctx = makeCtx({
      processKill: makePidKill(alive),
      debugLog: (msg) => logs.push(msg),
    });
    api = require("../src/state")(ctx);

    api.updateSession("c1", "idle", "Stop", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    mock.timers.tick(15000);

    assert.ok(api.sessions.has("c1"));
    assert.ok(logs.some((msg) => msg.includes("codex-exit-probe keep reason=agent-alive")));
  });

  it("Codex exit probe cancels when new activity arrives", () => {
    api.cleanup();
    const alive = new Set([1000, 2000]);
    const logs = [];
    ctx = makeCtx({
      processKill: makePidKill(alive),
      debugLog: (msg) => logs.push(msg),
    });
    api = require("../src/state")(ctx);

    api.updateSession("c1", "idle", "Stop", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    api.updateSession("c1", "thinking", "UserPromptSubmit", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
      hookSource: "codex-official",
    });

    alive.delete(1000);
    mock.timers.tick(15000);

    assert.ok(api.sessions.has("c1"));
    assert.ok(logs.some((msg) => msg.includes("codex-exit-probe cancel sid=c1 reason=UserPromptSubmit")));
  });

  it("upgrades pidReachable when later Codex hooks provide a live pid", () => {
    api.cleanup();
    const alive = new Set([1000, 2000]);
    ctx = makeCtx({ processKill: makePidKill(alive) });
    api = require("../src/state")(ctx);

    api.updateSession("c1", "thinking", "event_msg:task_started", {
      agentId: "codex",
      cwd: "/tmp",
    });
    assert.strictEqual(api.sessions.get("c1").pidReachable, false);

    api.updateSession("c1", "thinking", "UserPromptSubmit", {
      agentId: "codex",
      agentPid: 1000,
      sourcePid: 2000,
      cwd: "/tmp",
      hookSource: "codex-official",
    });

    assert.strictEqual(api.sessions.get("c1").pidReachable, true);
  });

  it("attention is oneshot — stored as idle in session", () => {
    update(api, { id: "s1", state: "working" });
    mock.timers.tick(1000); // past MIN_DISPLAY_MS.working
    update(api, { id: "s1", state: "attention", event: "Stop" });
    // Debounce is opt-in (default 0), so a Claude Stop celebrates immediately
    // and the one-shot attention is stored as idle.
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
  });

  it("does not replay the completion animation for a duplicate Stop without progress", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    update(api, { id: "s1", state: "working" });
    mock.timers.tick(1000);
    stateChanges.length = 0;

    update(api, { id: "s1", state: "attention", event: "Stop" });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    assert.deepStrictEqual(stateChanges, ["attention"]);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
    mock.timers.tick(4000);
    assert.strictEqual(api.getCurrentState(), "idle");

    soundsPlayed.length = 0;
    stateChanges.length = 0;
    update(api, { id: "s1", state: "attention", event: "Stop" });

    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    assert.ok(!stateChanges.includes("attention"), "duplicate Stop must not re-send attention");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("presents a later attention Stop when an earlier ID-less Stop only idled the session", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    update(api, {
      id: "codex:s1",
      state: "thinking",
      event: "UserPromptSubmit",
      agentId: "codex",
    });
    mock.timers.tick(1000);
    stateChanges.length = 0;

    // A terminal without identity may resolve idle because the server cannot
    // associate it with the turn's tool ledger. It closes lifecycle state but
    // has not presented completion UX yet.
    update(api, {
      id: "codex:s1",
      state: "idle",
      event: "Stop",
      agentId: "codex",
    });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    stateChanges.length = 0;

    // The later ID-bearing Stop is authoritative and resolves attention. It
    // must upgrade the existing completion tail and celebrate exactly once.
    update(api, {
      id: "codex:s1",
      state: "attention",
      event: "Stop",
      agentId: "codex",
    });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    assert.deepStrictEqual(stateChanges, ["attention"]);
    const completionEvents = api.sessions.get("codex:s1").recentEvents.filter((entry) => entry.event === "Stop");
    assert.strictEqual(completionEvents.length, 1);
    assert.strictEqual(completionEvents[0].state, "attention");

    mock.timers.tick(4000);
    soundsPlayed.length = 0;
    stateChanges.length = 0;
    update(api, {
      id: "codex:s1",
      state: "attention",
      event: "Stop",
      agentId: "codex",
    });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    assert.ok(!stateChanges.includes("attention"));
  });

  it("Codex Stop followed by token_count and task_complete still auto-returns from attention", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    api.updateSession("codex:s1", "working", "PreToolUse", {
      agentId: "codex",
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    mock.timers.tick(1000);
    stateChanges.length = 0;

    api.updateSession("codex:s1", "attention", "Stop", {
      agentId: "codex",
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.deepStrictEqual(stateChanges, ["attention"]);
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);

    mock.timers.tick(900);
    api.updateSession("codex:s1", "working", "event_msg:token_count", {
      agentId: "codex",
      cwd: "/tmp",
      preserveState: true,
      contextUsage: { used: 100, limit: 1000, percent: 10, source: "codex" },
    });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.strictEqual(api.sessions.get("codex:s1").awaitingInputSinceStop, true);

    api.updateSession("codex:s1", "attention", "event_msg:task_complete", {
      agentId: "codex",
      cwd: "/tmp",
    });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    assert.deepStrictEqual(stateChanges, ["attention"]);

    mock.timers.tick(3100);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("does not replay remote Codex task_complete after the completion animation returned to idle", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    update(api, {
      id: "codex:remote",
      state: "attention",
      event: "event_msg:task_complete",
      agentId: "codex",
      host: "ssh:box",
    });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    assert.deepStrictEqual(stateChanges, ["attention"]);
    assert.strictEqual(api.sessions.get("codex:remote").requiresCompletionAck, true);
    mock.timers.tick(4000);
    const firstEvents = api.sessions.get("codex:remote").recentEvents.map((entry) => ({ ...entry }));
    assert.strictEqual(api.getCurrentState(), "idle");

    soundsPlayed.length = 0;
    stateChanges.length = 0;
    update(api, {
      id: "codex:remote",
      state: "attention",
      event: "event_msg:task_complete",
      agentId: "codex",
      host: "ssh:box",
    });

    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    assert.ok(!stateChanges.includes("attention"), "duplicate task_complete must not re-send attention");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("codex:remote")), "done");
    assert.strictEqual(api.sessions.get("codex:remote").requiresCompletionAck, true);
    assert.deepStrictEqual(api.sessions.get("codex:remote").recentEvents, firstEvents);
  });


  it("keeps official Codex Stop as the completion tail when JSONL task_complete arrives later", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    api.updateSession("codex:s2", "working", "PreToolUse", {
      agentId: "codex",
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    mock.timers.tick(1000);
    stateChanges.length = 0;

    api.updateSession("codex:s2", "attention", "Stop", {
      agentId: "codex",
      cwd: "/tmp",
      hookSource: "codex-official",
    });
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    const firstEvents = api.sessions.get("codex:s2").recentEvents.map((entry) => ({ ...entry }));
    assert.strictEqual(firstEvents.at(-1).event, "Stop");
    mock.timers.tick(4000);
    assert.strictEqual(api.getCurrentState(), "idle");

    soundsPlayed.length = 0;
    stateChanges.length = 0;
    api.updateSession("codex:s2", "attention", "event_msg:task_complete", {
      agentId: "codex",
      cwd: "/tmp",
    });

    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    assert.ok(!stateChanges.includes("attention"), "late task_complete must not re-send attention");
    const session = api.sessions.get("codex:s2");
    assert.deepStrictEqual(session.recentEvents, firstEvents);
    assert.strictEqual(session.recentEvents.at(-1).event, "Stop");
    assert.strictEqual(api.deriveSessionBadge(session), "done");
    assert.strictEqual(api.getCurrentState(), "idle");
  });
  it("still plays completion after new progress follows a completed turn", () => {
    const soundsPlayed = [];
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    mock.timers.tick(1000);
    update(api, { id: "s1", state: "attention", event: "Stop" });
    mock.timers.tick(4000);

    soundsPlayed.length = 0;
    stateChanges.length = 0;
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit" });
    mock.timers.tick(1000);
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    mock.timers.tick(1000);
    stateChanges.length = 0;

    update(api, { id: "s1", state: "attention", event: "Stop" });

    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    assert.deepStrictEqual(stateChanges, ["attention"]);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
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

  it("keeps the FIRST title for traecode sessions (follow-up prompts never overwrite)", () => {
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit", agentId: "traecode", sessionTitle: "第一个问题" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "第一个问题");

    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit", agentId: "traecode", sessionTitle: "第二个问题" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "第一个问题");

    // An empty candidate must never clear the sticky first title either.
    update(api, { id: "s1", state: "working", event: "PreToolUse", agentId: "traecode", sessionTitle: "" });
    assert.strictEqual(api.sessions.get("s1").sessionTitle, "第一个问题");
  });

  it("lets the latest title win for non-traecode agents (unchanged behaviour)", () => {
    update(api, { id: "s2", state: "thinking", event: "UserPromptSubmit", agentId: "claude-code", sessionTitle: "旧标题" });
    update(api, { id: "s2", state: "thinking", event: "UserPromptSubmit", agentId: "claude-code", sessionTitle: "新标题" });
    assert.strictEqual(api.sessions.get("s2").sessionTitle, "新标题");
  });

  it("stores optional platform and model metadata", () => {
    update(api, {
      id: "s1",
      state: "working",
      platform: "webui",
      model: "gpt-5.4",
      provider: "openai",
    });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.platform, "webui");
    assert.strictEqual(session.model, "gpt-5.4");
    assert.strictEqual(session.provider, "openai");

    update(api, { id: "s1", state: "idle", event: "Stop" });
    assert.strictEqual(api.sessions.get("s1").platform, "webui");
    assert.strictEqual(api.sessions.get("s1").model, "gpt-5.4");
    assert.strictEqual(api.sessions.get("s1").provider, "openai");
  });

  it("stores contextUsage from updateSession opts", () => {
    update(api, {
      id: "s1",
      state: "working",
      contextUsage: {
        used: 1000,
        limit: 200000,
        percent: 1,
        source: "claude",
      },
    });

    assert.deepStrictEqual(api.sessions.get("s1").contextUsage, {
      used: 1000,
      limit: 200000,
      percent: 1,
      source: "claude",
    });
    assert.strictEqual(api.sessions.get("s1").contextUsageOrigin, "claude-transcript");
  });

  it("keeps contextUsage sticky when later events omit it", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      contextUsage: { used: 1000, source: "claude" },
    });
    update(api, { id: "s1", state: "working" });

    assert.deepStrictEqual(api.sessions.get("s1").contextUsage, {
      used: 1000,
      source: "claude",
    });
  });

  it("preserveState does not stop a one-shot visual from playing (cross-file contract)", () => {
    // Characterization, not endorsement. preserveState pins the STORED state;
    // the one-shot branch plays whatever `state` it is handed and bypasses
    // resolveDisplayState() entirely. So a metadata-only update that carries a
    // one-shot still animates the pet, even though the session stays idle.
    //
    // agents/codex-log-monitor.js depends on this: it filters `token_count`'s
    // carried state down to sustained ones precisely because preserveState
    // would not save it. If this test ever fails because preserveState grew to
    // cover one-shots, that filter becomes redundant (harmless) — update it
    // there rather than deleting it blind.
    const stateChanges = [];
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      sendToRenderer: (channel, state) => {
        if (channel === "state-change") stateChanges.push(state);
      },
    });
    api = require("../src/state")(ctx);

    // Turn is long over; pet is back to idle. This is what Codex Desktop's
    // focus-triggered token_count refresh actually lands on.
    api.updateSession("codex:s1", "idle", "event_msg:task_complete", {
      agentId: "codex",
      cwd: "/tmp",
    });
    stateChanges.length = 0;

    api.updateSession("codex:s1", "attention", "event_msg:token_count", {
      agentId: "codex",
      cwd: "/tmp",
      preserveState: true,
      contextUsage: { used: 2000, limit: 200000, percent: 1, source: "codex" },
    });

    assert.strictEqual(api.sessions.get("codex:s1").state, "idle",
      "preserveState must pin the stored state");
    assert.deepStrictEqual(stateChanges, ["attention"],
      "and yet the one-shot visual still plays — this is why the monitor filters the carry");
  });

  it("updates contextUsage without changing state when preserveState is true", () => {
    update(api, {
      id: "codex:abc",
      state: "working",
      agentId: "codex",
    });
    api.updateSession("codex:abc", "idle", "event_msg:task_complete", {
      agentId: "codex",
      cwd: "/tmp",
      preserveState: true,
      contextUsage: {
        used: 49961,
        limit: 258400,
        percent: 19,
        source: "codex",
      },
    });

    const session = api.sessions.get("codex:abc");
    assert.strictEqual(session.state, "working");
    assert.deepStrictEqual(session.contextUsage, {
      used: 49961,
      limit: 258400,
      percent: 19,
      source: "codex",
    });
  });

  // Account quota is not session state: it lives in the session-independent
  // per-source store (src/state-account-quota.js), fed via updateAccountQuota
  // and exported as snapshot.accountQuota — the headline case is "check a
  // remote's quota before starting work" when no session exists at all.
  it("updateAccountQuota stores per-source quota with no session required", () => {
    const resetAt = Date.now() + 3600000;
    const applied = api.updateAccountQuota("pi", {
      claudeQuota: {
        claudeFiveHour: { usedPercent: 24, resetAt },
        claudeWeekly: { usedPercent: 41 },
      },
    });

    assert.strictEqual(applied, true);
    assert.strictEqual(api.sessions.size, 0, "quota must never create sessions");
    const { snapshot } = api.emitSessionSnapshot({ force: true });
    assert.strictEqual(snapshot.accountQuota.length, 1);
    const entry = snapshot.accountQuota[0];
    assert.strictEqual(entry.host, "pi");
    assert.deepStrictEqual(entry.claudeQuota.group, {
      claudeFiveHour: { usedPercent: 24, resetAt, lastSeenAt: 0 },
      claudeWeekly: { usedPercent: 41, lastSeenAt: 0 },
    });
    assert.ok(Number.isFinite(entry.claudeQuota.updatedAt));
  });

  it("updateAccountQuota keeps sources independent and sorts local first", () => {
    const resetAt = Date.now() + 3600000;
    api.updateAccountQuota("pi", { codexQuota: { codexWeekly: { usedPercent: 43, resetAt } } });
    api.updateAccountQuota(null, { codexQuota: { codexWeekly: { usedPercent: 7, resetAt } } });

    const { snapshot } = api.emitSessionSnapshot({ force: true });
    assert.deepStrictEqual(snapshot.accountQuota.map((e) => e.host), [null, "pi"]);
    assert.strictEqual(snapshot.accountQuota[0].codexQuota.group.codexWeekly.usedPercent, 7);
    assert.strictEqual(snapshot.accountQuota[1].codexQuota.group.codexWeekly.usedPercent, 43);
  });

  it("clearLocalClaudeQuota removes local + WSL Claude only and broadcasts once", () => {
    const broadcasts = [];
    const localApi = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
    const resetAt = Date.now() + 3600000;
    localApi.updateAccountQuota(null, {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt } },
      codexQuota: { codexWeekly: { usedPercent: 7, resetAt } },
    });
    localApi.updateAccountQuota("wsl:Ubuntu", {
      claudeQuota: { claudeWeekly: { usedPercent: 42, resetAt } },
    });
    localApi.updateAccountQuota("remote:ssh-work", {
      displayHost: "workbox",
      claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt } },
    });
    const before = broadcasts.length;

    assert.strictEqual(localApi.clearLocalClaudeQuota(), 2);
    assert.strictEqual(broadcasts.length, before + 1);
    const snapshot = broadcasts.at(-1).accountQuota;
    const local = snapshot.find((entry) => entry.host === null);
    assert.strictEqual(local.claudeQuota, undefined);
    assert.strictEqual(local.codexQuota.group.codexWeekly.usedPercent, 7);
    assert.strictEqual(snapshot.some((entry) => entry.host === "wsl:Ubuntu"), false,
      "an empty WSL source should disappear");
    assert.strictEqual(
      snapshot.find((entry) => entry.host === "workbox").claudeQuota.group.claudeWeekly.usedPercent,
      90,
      "Remote SSH Claude quota must survive local opt-out"
    );

    assert.strictEqual(localApi.clearLocalClaudeQuota(), 0);
    assert.strictEqual(broadcasts.length, before + 1, "no-op cleanup must not rebroadcast");
    localApi.cleanup();
  });

  it("cleans persisted local Claude quota on startup when collection is disabled", () => {
    const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-aq-optout-")), "account-quota.json");
    const { createAccountQuotaStore } = require("../src/state-account-quota");
    const seed = createAccountQuotaStore({ persistPath });
    const resetAt = Date.now() + 3600000;
    seed.update(null, {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt } },
      codexQuota: { codexWeekly: { usedPercent: 7, resetAt } },
    });
    seed.update("remote:ssh-work", {
      displayHost: "workbox",
      claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt } },
    });
    seed.flush();

    const localApi = require("../src/state")(makeCtx({
      accountQuotaPersistPath: persistPath,
      claudeQuotaCollectionEnabled: false,
    }));
    const snapshot = localApi.buildSessionSnapshot().accountQuota;
    assert.strictEqual(snapshot.find((entry) => entry.host === null).claudeQuota, undefined);
    assert.strictEqual(snapshot.find((entry) => entry.host === null).codexQuota.group.codexWeekly.usedPercent, 7);
    assert.strictEqual(snapshot.find((entry) => entry.host === "workbox").claudeQuota.group.claudeWeekly.usedPercent, 90);
    localApi.cleanup();

    const reloaded = createAccountQuotaStore({ persistPath }).snapshot();
    assert.strictEqual(reloaded.find((entry) => entry.host === null).claudeQuota, undefined,
      "startup cleanup must be persisted synchronously");
    assert.strictEqual(reloaded.find((entry) => entry.host === "workbox").claudeQuota.group.claudeWeekly.usedPercent, 90);
  });

  it("commits, flushes, and clears only local Kimi quota", () => {
    const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-state-")), "account-quota.json");
    const localApi = require("../src/state")(makeCtx({
      accountQuotaPersistPath: persistPath,
      kimiQuotaCollectionEnabled: true,
    }));
    const resetAt = Date.now() + 3600000;
    assert.deepStrictEqual(localApi.commitLocalKimiQuota({
      kimiFiveHour: { usedPercent: 12, resetAt, capturedAt: Date.now() },
      kimiWeekly: { usedPercent: 4, resetAt: resetAt + 86400000, capturedAt: Date.now() },
    }), { accepted: true, persisted: true });
    assert.strictEqual(
      localApi.buildSessionSnapshot().accountQuota[0].kimiQuota.group.kimiFiveHour.usedPercent,
      12
    );
    assert.deepStrictEqual(localApi.clearLocalKimiQuota(), { cleared: true, persisted: true });
    assert.strictEqual(localApi.buildSessionSnapshot().accountQuota.length, 0);
    localApi.cleanup();
    assert.strictEqual(
      require("../src/state-account-quota").createAccountQuotaStore({ persistPath }).snapshot().length,
      0,
      "the explicit disconnect boundary must survive restart"
    );
  });

  it("cleans a persisted local Kimi cache on startup when collection is disabled", () => {
    const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-optout-")), "account-quota.json");
    const { createAccountQuotaStore } = require("../src/state-account-quota");
    const seed = createAccountQuotaStore({ persistPath });
    const resetAt = Date.now() + 3600000;
    seed.update(null, {
      kimiQuota: { kimiFiveHour: { usedPercent: 18, resetAt } },
      codexQuota: { codexWeekly: { usedPercent: 7, resetAt } },
    });
    seed.flush();

    const localApi = require("../src/state")(makeCtx({
      accountQuotaPersistPath: persistPath,
      kimiQuotaCollectionEnabled: false,
    }));
    const local = localApi.buildSessionSnapshot().accountQuota.find((entry) => entry.host === null);
    assert.strictEqual(local.kimiQuota, undefined);
    assert.strictEqual(local.codexQuota.group.codexWeekly.usedPercent, 7);
    localApi.cleanup();

    const reloaded = createAccountQuotaStore({ persistPath }).snapshot()[0];
    assert.strictEqual(reloaded.kimiQuota, undefined);
    assert.strictEqual(reloaded.codexQuota.group.codexWeekly.usedPercent, 7);
  });

  it("updateAccountQuota change-detects identical refreshes (no re-broadcast, no re-stamp)", () => {
    const broadcasts = [];
    const localApi = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
    const resetAt = Date.now() + 3600000;
    localApi.updateAccountQuota(null, { claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt } } });
    const before = broadcasts.length;
    assert.ok(before > 0, "first quota report must broadcast");
    const stampBefore = localApi.getLastSessionSnapshot().accountQuota[0].claudeQuota.updatedAt;

    const applied = localApi.updateAccountQuota(null, {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt } },
    });

    assert.strictEqual(applied, false);
    assert.strictEqual(broadcasts.length, before, "identical refresh must not re-broadcast");
    assert.strictEqual(
      localApi.getLastSessionSnapshot().accountQuota[0].claudeQuota.updatedAt,
      stampBefore,
      "identical refresh must not look fresher"
    );
  });

  it("broadcasts consecutive Spark-only quota changes for the same source", () => {
    const broadcasts = [];
    const localApi = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
    const resetAt = Date.now() + 3600000;
    localApi.updateAccountQuota(null, {
      codexSparkQuota: {
        codexWeekly: { usedPercent: 7, windowMinutes: 10080, resetAt },
      },
    });
    const afterFirst = broadcasts.length;
    assert.ok(afterFirst > 0, "first Spark report must broadcast");

    localApi.updateAccountQuota(null, {
      codexSparkQuota: {
        codexWeekly: { usedPercent: 9, windowMinutes: 10080, resetAt },
      },
    });
    assert.strictEqual(broadcasts.length, afterFirst + 1);
    assert.strictEqual(
      broadcasts.at(-1).accountQuota[0].codexSparkQuota.group.codexWeekly.usedPercent,
      9
    );
    localApi.cleanup();
  });

  it("updateAccountQuota drops invalid groups", () => {
    const applied = api.updateAccountQuota("pi", {
      claudeQuota: { claudeFiveHour: { usedPercent: "not-a-number" } },
    });

    assert.strictEqual(applied, false);
    const { snapshot } = api.emitSessionSnapshot({ force: true });
    assert.deepStrictEqual(snapshot.accountQuota, []);
  });

  it("cleanup flushes pending account-quota writes to disk (before-quit path)", () => {
    const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-aq-")), "account-quota.json");
    const localApi = require("../src/state")(makeCtx({ accountQuotaPersistPath: persistPath }));
    localApi.updateAccountQuota("pi", {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt: Date.now() + 3600000 } },
    });
    // The persist debounce has not fired yet — before-quit cleanup must not
    // lose the final window of updates.
    localApi.cleanup();

    const persisted = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    assert.strictEqual(persisted.sources.length, 1);
    assert.strictEqual(persisted.sources[0].host, "pi");
  });

  it("rejects incoming buckets whose resetAt already passed, keeps live siblings", () => {
    api.updateAccountQuota(null, {
      claudeQuota: {
        // Already expired at write time: the number is wrong, not stale —
        // the store refuses it outright. (Buckets that expire AFTER being
        // stored are flagged instead; covered with a mocked clock in
        // test/state-account-quota.test.js.)
        claudeFiveHour: { usedPercent: 80, resetAt: Date.now() - 60000 },
        claudeWeekly: { usedPercent: 41, resetAt: Date.now() + 3600000 },
      },
    });

    const { snapshot } = api.emitSessionSnapshot({ force: true });
    const group = snapshot.accountQuota[0].claudeQuota.group;
    assert.strictEqual(group.claudeFiveHour, undefined);
    assert.strictEqual(group.claudeWeekly.expired, undefined);
    assert.strictEqual(group.claudeWeekly.usedPercent, 41);
  });

  it("touchSessionActivity refreshes only a matching existing session and can revive proven work", () => {
    update(api, {
      id: "codex:s1",
      state: "working",
      agentId: "codex",
      profileId: "local",
    });
    const session = api.sessions.get("codex:s1");
    session.state = "idle";
    session.updatedAt = 12345;
    const recentEventsBefore = JSON.stringify(session.recentEvents);

    assert.strictEqual(api.touchSessionActivity("ghost", {
      agentId: "codex",
      profileId: "local",
      localOnly: true,
      reviveIdle: true,
      now: 50000,
    }), false);
    assert.strictEqual(api.sessions.has("ghost"), false);
    assert.strictEqual(api.touchSessionActivity("codex:s1", {
      agentId: "claude-code",
      now: 50000,
    }), false);
    assert.strictEqual(session.updatedAt, 12345);

    assert.strictEqual(api.touchSessionActivity("codex:s1", {
      agentId: "codex",
      profileId: "local",
      localOnly: true,
      reviveIdle: true,
      now: 50000,
    }), true);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.updatedAt, 50000);
    assert.strictEqual(JSON.stringify(session.recentEvents), recentEventsBefore);
  });

  it("touchSessionActivity does not extend a completed session awaiting acknowledgement", () => {
    update(api, { id: "codex:done", state: "idle", agentId: "codex", profileId: "local" });
    const session = api.sessions.get("codex:done");
    session.requiresCompletionAck = true;
    session.updatedAt = 12345;

    assert.strictEqual(api.touchSessionActivity("codex:done", {
      agentId: "codex",
      profileId: "local",
      localOnly: true,
      reviveIdle: true,
      now: 50000,
    }), false);
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(session.updatedAt, 12345);
  });

  // #590 B2 — statusline refresh POSTs go through updateSessionMetadata,
  // which annotates context usage onto an existing session and does nothing
  // else: no session creation, no recentEvents append, no updatedAt bump.
  // (Account quota deliberately does NOT flow through here — see the
  // updateAccountQuota tests above.)
  it("updateSessionMetadata annotates contextUsage without touching lifecycle fields", () => {
    update(api, { id: "s1", state: "working" });
    const session = api.sessions.get("s1");
    session.updatedAt = 12345; // pin so a bump is detectable
    const recentEventsBefore = JSON.stringify(session.recentEvents);

    const applied = api.updateSessionMetadata("s1", {
      contextUsage: { used: 50000, limit: 200000, percent: 25, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });

    assert.strictEqual(applied, true);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.updatedAt, 12345);
    assert.strictEqual(JSON.stringify(session.recentEvents), recentEventsBefore);
    assert.deepStrictEqual(session.contextUsage, { used: 50000, limit: 200000, percent: 25, source: "claude" });
    assert.strictEqual(session.contextUsageOrigin, "claude-statusline");
    assert.ok(Number.isFinite(session.metadataUpdatedAt), "telemetry change must stamp metadataUpdatedAt");
  });

  it("keeps a statusline window authoritative while transcript events refresh only used tokens", () => {
    update(api, {
      id: "s1",
      state: "thinking",
      contextUsage: { used: 50000, limit: 200000, percent: 25, source: "claude" },
      contextUsageOrigin: "claude-transcript",
    });
    api.updateSessionMetadata("s1", {
      contextUsage: { used: 60000, limit: 1000000, percent: 6, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      contextUsage: { used: 70000, limit: 200000, percent: 35, source: "claude" },
      contextUsageOrigin: "claude-transcript",
    });

    const session = api.sessions.get("s1");
    assert.deepStrictEqual(session.contextUsage, {
      used: 70000,
      limit: 1000000,
      percent: 7,
      source: "claude",
    });
    assert.strictEqual(session.contextUsageOrigin, "claude-statusline");
  });

  // #830 — opencode-family plugin reports context usage with source
  // "opencode" and the opencode-statusline origin. Same telemetry authority
  // contract as claude-statusline: metadata wins, but there is no transcript
  // backfill channel, so a later opencode-statusline update simply replaces
  // the window (no limit-merge rule like the claude-transcript case).
  it("accepts opencode context metadata and keeps the opencode-statusline origin", () => {
    update(api, { id: "opencode:s1", agentId: "opencode", state: "working" });
    const session = api.sessions.get("opencode:s1");
    session.updatedAt = 12345; // pin so a bump is detectable

    const applied = api.updateSessionMetadata("opencode:s1", {
      contextUsage: { used: 32000, limit: 128000, percent: 25, source: "opencode" },
      contextUsageOrigin: "opencode-statusline",
    });

    assert.strictEqual(applied, true);
    assert.strictEqual(session.updatedAt, 12345, "telemetry must not touch lifecycle freshness");
    assert.deepStrictEqual(session.contextUsage, {
      used: 32000,
      limit: 128000,
      percent: 25,
      source: "opencode",
    });
    assert.strictEqual(session.contextUsageOrigin, "opencode-statusline");
  });

  it("keeps the opencode-statusline window authoritative over later opencode state events", () => {
    update(api, { id: "opencode:s1", agentId: "opencode", state: "working" });
    api.updateSessionMetadata("opencode:s1", {
      contextUsage: { used: 32000, limit: 128000, percent: 25, source: "opencode" },
      contextUsageOrigin: "opencode-statusline",
    });
    // Later lifecycle POSTs (which ride the same opencode-statusline origin,
    // unlike the claude transcript path) replace the window wholesale.
    update(api, {
      id: "opencode:s1",
      state: "thinking",
      event: "UserPromptSubmit",
      contextUsage: { used: 90000, limit: 200000, percent: 45, source: "opencode" },
      contextUsageOrigin: "opencode-statusline",
    });

    const session = api.sessions.get("opencode:s1");
    assert.deepStrictEqual(session.contextUsage, {
      used: 90000,
      limit: 200000,
      percent: 45,
      source: "opencode",
    });
    assert.strictEqual(session.contextUsageOrigin, "opencode-statusline");
  });

  it("discards unknown context usage sources for opencode-origin telemetry", () => {
    update(api, { id: "opencode:s1", agentId: "opencode", state: "working" });
    const applied = api.updateSessionMetadata("opencode:s1", {
      contextUsage: { used: 1000, limit: 200000, percent: 1, source: "suspicious" },
      contextUsageOrigin: "opencode-statusline",
    });

    assert.strictEqual(applied, true);
    assert.deepStrictEqual(api.sessions.get("opencode:s1").contextUsage, {
      used: 1000,
      limit: 200000,
      percent: 1,
    });
    assert.strictEqual(api.sessions.get("opencode:s1").contextUsageOrigin, "opencode-statusline");
  });

  it("carries authority through a context-free rebuild before the next transcript update", () => {
    update(api, { id: "s1", state: "working" });
    api.updateSessionMetadata("s1", {
      contextUsage: { used: 60000, limit: 1000000, percent: 6, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });

    update(api, { id: "s1", state: "thinking", event: "PostToolUse" });
    update(api, {
      id: "s1",
      state: "working",
      event: "PreToolUse",
      contextUsage: { used: 80000, limit: 200000, percent: 40, source: "claude" },
      contextUsageOrigin: "claude-transcript",
    });

    const session = api.sessions.get("s1");
    assert.deepStrictEqual(session.contextUsage, {
      used: 80000,
      limit: 1000000,
      percent: 8,
      source: "claude",
    });
    assert.strictEqual(session.contextUsageOrigin, "claude-statusline");
  });

  it("carries the internal context origin through the permission-focus explicit rebuild", () => {
    update(api, { id: "codex:s1", agentId: "codex", state: "working" });
    const session = api.sessions.get("codex:s1");
    // White-box structural guard: Claude statusline authority is not normally
    // attached to a Codex session, but this explicit rebuild is Codex-only.
    // Seeding the marker here catches a future omission from the rebuilt
    // object without manufacturing an impossible route-level attribution.
    session.contextUsage = { used: 60000, limit: 1000000, percent: 6, source: "claude" };
    session.contextUsageOrigin = "claude-statusline";

    api.updateSession("codex:s1", "notification", "PermissionRequest", {
      agentId: "codex",
      sourcePid: 123,
    });

    const rebuilt = api.sessions.get("codex:s1");
    assert.notStrictEqual(rebuilt, session);
    assert.deepStrictEqual(rebuilt.contextUsage, {
      used: 60000,
      limit: 1000000,
      percent: 6,
      source: "claude",
    });
    assert.strictEqual(rebuilt.contextUsageOrigin, "claude-statusline");
  });

  it("clears statusline authority for every local-profile Claude session, including WSL, but not SSH profiles", () => {
    update(api, {
      id: "local",
      contextUsage: { used: 1, limit: 1000000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    update(api, {
      id: "wsl",
      profileId: "local",
      host: "wsl:Ubuntu",
      contextUsage: { used: 2, limit: 1000000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    update(api, {
      id: "ssh",
      profileId: "ssh-work",
      host: "workbox",
      contextUsage: { used: 3, limit: 1000000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });

    assert.strictEqual(api.clearClaudeStatuslineAuthority("local"), 2);
    assert.strictEqual(api.sessions.get("local").contextUsageOrigin, null);
    assert.strictEqual(api.sessions.get("wsl").contextUsageOrigin, null);
    assert.strictEqual(api.sessions.get("ssh").contextUsageOrigin, "claude-statusline");
  });

  it("updateSessionMetadata never creates a session for an unknown id", () => {
    const applied = api.updateSessionMetadata("ghost", {
      contextUsage: { used: 1000, limit: 200000, percent: 1, source: "claude" },
    });

    assert.strictEqual(applied, false);
    assert.strictEqual(api.sessions.has("ghost"), false);
  });

  it("updateSessionMetadata ignores a payload with no valid metadata fields", () => {
    update(api, { id: "s1", state: "working" });
    const session = api.sessions.get("s1");

    const applied = api.updateSessionMetadata("s1", {
      contextUsage: { used: -5 },
    });

    assert.strictEqual(applied, false);
    assert.strictEqual(session.contextUsage, null);
  });

  it("updateSessionMetadata rejects invalid context without re-accepting existing metadata", () => {
    update(api, { id: "s1", state: "working" });
    const session = api.sessions.get("s1");
    api.updateSessionMetadata("s1", {
      contextUsage: { used: 100, limit: 200000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    session.metadataUpdatedAt = 777;

    const applied = api.updateSessionMetadata("s1", {
      contextUsage: { used: -5 },
    });

    assert.strictEqual(applied, false);
    assert.deepStrictEqual(session.contextUsage, {
      used: 100,
      limit: 200000,
      percent: 0,
      source: "claude",
    });
    assert.strictEqual(session.contextUsageOrigin, "claude-statusline");
    assert.strictEqual(session.metadataUpdatedAt, 777);
  });

  it("updateSessionMetadata stamps metadataUpdatedAt on change only, never updatedAt", () => {
    update(api, { id: "s1", state: "working" });
    const session = api.sessions.get("s1");
    session.updatedAt = 12345;

    api.updateSessionMetadata("s1", {
      contextUsage: { used: 100, limit: 200000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    assert.ok(Number.isFinite(session.metadataUpdatedAt), "telemetry change must stamp metadataUpdatedAt");
    assert.strictEqual(session.updatedAt, 12345);

    session.metadataUpdatedAt = 777; // pin so a re-stamp is detectable
    const acceptedNoop = api.updateSessionMetadata("s1", {
      contextUsage: { used: 100, limit: 200000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    assert.strictEqual(acceptedNoop, true, "a valid identical refresh is accepted even without mutation");
    assert.strictEqual(session.metadataUpdatedAt, 777, "identical refresh must not re-stamp");
  });

  it("updateSessionMetadata stores a title without touching lifecycle state or telemetry stamp", () => {
    update(api, { id: "s1", state: "working" });
    const session = api.sessions.get("s1");
    session.updatedAt = 12345; // pin so a bump is detectable
    session.metadataUpdatedAt = 777; // pin so a re-stamp is detectable
    const recentEventsBefore = JSON.stringify(session.recentEvents);

    const applied = api.updateSessionMetadata("s1", { sessionTitle: "New Title" });

    assert.strictEqual(applied, true);
    assert.strictEqual(session.sessionTitle, "New Title");
    // Lifecycle untouched: state, updatedAt, recent events all unchanged.
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.updatedAt, 12345);
    assert.strictEqual(JSON.stringify(session.recentEvents), recentEventsBefore);
    // Telemetry freshness must NOT be stamped by a rename (#841 review).
    assert.strictEqual(session.metadataUpdatedAt, 777);
    assert.strictEqual(session.contextUsage, null);
    assert.strictEqual(session.contextUsageOrigin, null);
  });

  it("updateSessionMetadata treats a same/normalized-equivalent title as a no-op", () => {
    update(api, { id: "s1", state: "working" });
    api.updateSessionMetadata("s1", { sessionTitle: "Stable Title" });
    const session = api.sessions.get("s1");
    session.metadataUpdatedAt = 777;

    // Same title -> no change, no re-stamp.
    const appliedSame = api.updateSessionMetadata("s1", { sessionTitle: "Stable Title" });
    assert.strictEqual(appliedSame, true);
    assert.strictEqual(session.sessionTitle, "Stable Title");
    assert.strictEqual(session.metadataUpdatedAt, 777);

    // Normalized-equivalent title (extra whitespace/control chars) collapses
    // to the stored title via normalizeTitle -> still a no-op, no re-stamp.
    const appliedNormalized = api.updateSessionMetadata("s1", { sessionTitle: "  Stable\t Title  " });
    assert.strictEqual(appliedNormalized, true);
    assert.strictEqual(session.sessionTitle, "Stable Title");
    assert.strictEqual(session.metadataUpdatedAt, 777);
  });

  it("updateSessionMetadata returns false for an unknown session on a title-only payload", () => {
    const applied = api.updateSessionMetadata("ghost", { sessionTitle: "Ghost Title" });
    assert.strictEqual(applied, false);
    assert.strictEqual(api.sessions.has("ghost"), false);
  });

  it("lifecycle events carry metadataUpdatedAt forward with the telemetry they preserve", () => {
    update(api, { id: "s1", state: "working" });
    api.updateSessionMetadata("s1", {
      contextUsage: { used: 100, limit: 200000, percent: 0, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
    api.sessions.get("s1").metadataUpdatedAt = 777; // pin to make loss detectable

    update(api, { id: "s1", state: "working", event: "PostToolUse" });

    const session = api.sessions.get("s1");
    assert.deepStrictEqual(session.contextUsage, { used: 100, limit: 200000, percent: 0, source: "claude" });
    assert.strictEqual(session.metadataUpdatedAt, 777, "hook-event rebuild must not drop the freshness stamp");
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

  it("updates recentEvents when an existing session receives a oneshot error", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, { id: "s1", state: "error", event: "PostToolUseFailure" });

    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "idle");
    assert.deepStrictEqual(
      session.recentEvents.map((e) => e.event),
      ["PreToolUse", "PostToolUseFailure"]
    );
    assert.strictEqual(api.deriveSessionBadge(session), "interrupted");
  });

  it("handles null event as null (not crash, not skipped)", () => {
    // The update() helper falls back to "PreToolUse" on null event —
    // bypass it here to test the null path directly.
    api.updateSession("s1", "working", null, { cwd: "/tmp", agentId: "claude-code" });
    const events = api.sessions.get("s1").recentEvents;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, null);
  });

  it("records Gemini PreCompress without changing the active session state", () => {
    update(api, { id: "g1", state: "thinking", event: "UserPromptSubmit", agentId: "gemini-cli" });
    api.updateSession("g1", "idle", "PreCompress", {
      cwd: "/tmp",
      agentId: "gemini-cli",
      preserveState: true,
    });

    const session = api.sessions.get("g1");
    assert.strictEqual(session.state, "thinking");
    assert.deepStrictEqual(
      session.recentEvents.map((entry) => entry.event),
      ["UserPromptSubmit", "PreCompress"]
    );
  });

  it("keeps the pet display state on Gemini PreCompress while exposing the event in session snapshots", () => {
    const stateChanges = [];
    api.cleanup();
    api = require("../src/state")(makeCtx({
      sendToRenderer: (...args) => stateChanges.push(args),
      syncHitWin: () => {},
      sendToHitWin: () => {},
    }));

    update(api, { id: "g1", state: "thinking", event: "UserPromptSubmit", agentId: "gemini-cli" });
    const beforeCount = stateChanges.length;
    api.updateSession("g1", "idle", "PreCompress", {
      cwd: "/tmp",
      agentId: "gemini-cli",
      preserveState: true,
    });

    assert.strictEqual(api.resolveDisplayState(), "thinking");
    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions[0].lastEvent.rawEvent, "PreCompress");
    assert.strictEqual(snapshot.sessions[0].lastEvent.labelKey, "eventLabelPreCompress");
    assert.strictEqual(stateChanges.length, beforeCount);
    assert.ok(stateChanges.every((entry) => entry[1] !== "sweeping"));
  });

  it("returns Gemini sessions to idle on AfterAgent without marking them done", () => {
    update(api, { id: "g1", state: "working", event: "PreToolUse", agentId: "gemini-cli" });
    api.updateSession("g1", "idle", "AfterAgent", {
      cwd: "/tmp",
      agentId: "gemini-cli",
    });

    const session = api.sessions.get("g1");
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(api.deriveSessionBadge(session), "idle");
    assert.deepStrictEqual(
      session.recentEvents.map((entry) => entry.event),
      ["PreToolUse", "AfterAgent"]
    );
  });
});

describe("buildSessionSnapshot", () => {
  let api, ctx;
  const pid = process.pid;

  beforeEach(() => {
    ctx = makeCtx({ processKill: makePidKill(new Set([pid])) });
    api = require("../src/state")(ctx);
  });
  afterEach(() => api.cleanup());

  it("returns a JSON-serializable empty snapshot", () => {
    const snapshot = api.buildSessionSnapshot();
    // Icon URLs are absolute file:// paths (machine-dependent) — assert the
    // shape, then compare the rest exactly.
    const { quotaAgentIcons, ...rest } = snapshot;
    assert.deepStrictEqual(Object.keys(quotaAgentIcons).sort(), [
      "antigravityQuota", "claudeQuota", "codexQuota", "kimiQuota",
    ]);
    assert.deepStrictEqual(rest, {
      sessions: [],
      groups: [],
      orderedIds: [],
      menuOrderedIds: [],
      hudTotalNonIdle: 0,
      hudLastSessionId: null,
      hudLastTitle: null,
      lastSessionId: null,
      lastTitle: null,
      accountQuota: [],
      sessionAutomationOrphans: [],
    });
    assert.doesNotThrow(() => JSON.stringify(snapshot));
  });

  it("never exposes the private Claude background-subagent marker in snapshots (#952)", () => {
    update(api, {
      id: "typed-private",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent output.",
    });
    assert.ok(Number.isFinite(api.sessions.get("typed-private").claudeBackgroundSubagentHoldAt));
    const serialized = JSON.stringify(api.buildSessionSnapshot());
    assert.ok(!serialized.includes("claudeBackgroundSubagentHoldAt"));
    assert.ok(!serialized.includes("backgroundSubagentsCount"));
  });

  it("builds renderer-safe fields, groups, and both dashboard/menu orderings", () => {
    api.sessions.set("old-working", rawSession("working", {
      updatedAt: 1000,
      sourcePid: pid,
      cwd: "/tmp/old-project",
      agentId: "claude-code",
      sessionTitle: "Fix login",
      recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      subagentTracker: {
        confirmedIds: new Set(["private-child-id"]),
        legacyFloor: false,
        recoveredFloor: false,
      },
    }));
    api.sessions.set("latest-remote", rawSession("idle", {
      updatedAt: 3000,
      cwd: "/tmp/latest-project",
      agentId: "codex",
      host: "remote-box",
      headless: true,
      recentEvents: [{ event: "MysteryEvent", state: "idle", at: 2900 }],
    }));
    api.sessions.set("error-local", rawSession("error", {
      updatedAt: 2000,
      cwd: "/tmp/error-project",
      agentId: "missing-agent",
      recentEvents: [],
    }));

    const snapshot = api.buildSessionSnapshot();

    assert.doesNotThrow(() => JSON.stringify(snapshot));
    assert.deepStrictEqual(snapshot.orderedIds, ["latest-remote", "error-local", "old-working"]);
    assert.deepStrictEqual(snapshot.menuOrderedIds, ["error-local", "old-working", "latest-remote"]);
    assert.deepStrictEqual(snapshot.groups, [
      { host: "", ids: ["error-local", "old-working"], displayHost: "" },
      { host: "remote-box", ids: ["latest-remote"], displayHost: "remote-box" },
    ]);
    assert.strictEqual(snapshot.hudTotalNonIdle, 2);
    assert.strictEqual(snapshot.hudLastSessionId, "error-local");
    assert.strictEqual(snapshot.hudLastTitle, "error-project");
    assert.strictEqual(snapshot.lastSessionId, "latest-remote");
    assert.strictEqual(snapshot.lastTitle, "latest-project");

    const oldWorking = snapshot.sessions.find((s) => s.id === "old-working");
    assert.strictEqual(oldWorking.badge, "running");
    assert.strictEqual(oldWorking.sessionTitle, "Fix login");
    assert.strictEqual(oldWorking.displayTitle, "Fix login");
    assert.strictEqual(oldWorking.iconUrl.startsWith("file:"), true);
    assert.deepStrictEqual(oldWorking.lastEvent, {
      labelKey: "eventLabelPreToolUse",
      rawEvent: "PreToolUse",
      at: 900,
    });
    assert.strictEqual(Object.hasOwn(oldWorking, "subagentTracker"), false,
      "private child identities must not cross the Dashboard/HUD/mobile snapshot boundary");

    const latestRemote = snapshot.sessions.find((s) => s.id === "latest-remote");
    assert.strictEqual(latestRemote.headless, true);
    assert.strictEqual(latestRemote.displayTitle, "latest-project");
    assert.deepStrictEqual(latestRemote.lastEvent, {
      labelKey: null,
      rawEvent: "MysteryEvent",
      at: 2900,
    });

    const errorLocal = snapshot.sessions.find((s) => s.id === "error-local");
    assert.strictEqual(errorLocal.displayTitle, "error-project");
    assert.strictEqual(errorLocal.iconUrl, null);
  });

  it("keeps headless sessions in Dashboard data but excludes them from HUD aggregates", () => {
    api.sessions.set("headless-active", rawSession("working", {
      updatedAt: 3000,
      cwd: "/tmp/headless",
      agentId: "claude-code",
      headless: true,
    }));
    api.sessions.set("interactive-active", rawSession("thinking", {
      updatedAt: 2000,
      cwd: "/tmp/interactive",
      agentId: "codex",
    }));

    const snapshot = api.buildSessionSnapshot();

    assert.deepStrictEqual(snapshot.orderedIds, ["headless-active", "interactive-active"]);
    assert.strictEqual(snapshot.sessions.length, 2);
    assert.strictEqual(snapshot.lastSessionId, "headless-active");
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "interactive-active");
    assert.strictEqual(snapshot.hudLastTitle, "interactive");
  });

  it("keeps done idle interactive sessions in HUD aggregates", () => {
    api.sessions.set("done-local", rawSession("idle", {
      updatedAt: 3000,
      sourcePid: pid,
      pidReachable: true,
      cwd: "/tmp/done-project",
      agentId: "claude-code",
      recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
    }));
    api.sessions.set("sleeping-local", rawSession("sleeping", {
      updatedAt: 4000,
      sourcePid: pid,
      cwd: "/tmp/sleeping-project",
      agentId: "codex",
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").badge, "done");
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "done-local");
    assert.strictEqual(snapshot.hudLastTitle, "done-project");
  });

  it("dedupes local Codex sessions that share one agent process across display and HUD", () => {
    api.sessions.set("codex:old", rawSession("working", {
      updatedAt: 1000,
      sourcePid: pid,
      agentPid: pid,
      pidReachable: true,
      cwd: "/tmp/current-project",
      agentId: "codex",
      recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
    }));
    api.sessions.set("codex:new", rawSession("idle", {
      updatedAt: 2000,
      sourcePid: pid,
      agentPid: pid,
      pidReachable: true,
      cwd: "/tmp/current-project",
      agentId: "codex",
      recentEvents: [{ event: "Stop", state: "attention", at: 1900 }],
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(api.resolveDisplayState(), "idle");
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "codex:old").hiddenFromHud, true);
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "codex:new").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "codex:new");
  });

  it("hides detached ended idle sessions from HUD aggregates when auto-clear is enabled and source is dead", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("done-local", rawSession("idle", {
      updatedAt: 3000,
      sourcePid: 9999,
      pidReachable: true,
      cwd: "/tmp/done-project",
      agentId: "claude-code",
      recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").badge, "done");
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").hiddenFromHud, true);
    assert.strictEqual(snapshot.hudTotalNonIdle, 0);
    assert.strictEqual(snapshot.hudLastSessionId, null);
    assert.strictEqual(snapshot.hudLastTitle, null);
  });

  it("keeps detached idle sessions in HUD aggregates when auto-clear is enabled but badge is idle", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("idle-local", rawSession("idle", {
      updatedAt: 3000,
      sourcePid: 9999,
      pidReachable: true,
      cwd: "/tmp/idle-project",
      agentId: "gemini-cli",
      recentEvents: [{ event: "AfterAgent", state: "idle", at: 2900 }],
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "idle-local").badge, "idle");
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "idle-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "idle-local");
  });

  it("keeps detached ended sessions in HUD aggregates when pid reachability is unknown", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      processKill: makePidKill(new Set()),
      sessionHudCleanupDetached: true,
    }));
    api.sessions.set("done-local", rawSession("idle", {
      updatedAt: 3000,
      sourcePid: 9999,
      pidReachable: false,
      cwd: "/tmp/done-project",
      agentId: "claude-code",
      recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").badge, "done");
    assert.strictEqual(snapshot.sessions.find((s) => s.id === "done-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "done-local");
  });

  it("applies session aliases to displayTitle without mutating raw session fields", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      getSessionAliases: () => ({
        "local|claude-code|claude-local": { title: "Claude review", updatedAt: 100 },
        "local|codex|codex-local": { title: "Codex follow-up", updatedAt: 100 },
      }),
    }));
    api.sessions.set("claude-local", rawSession("working", {
      updatedAt: 2000,
      cwd: "D:\\animation",
      agentId: "claude-code",
      sessionTitle: "Agent title",
    }));
    api.sessions.set("codex-local", rawSession("thinking", {
      updatedAt: 1000,
      cwd: "d:/animation/",
      agentId: "codex",
    }));

    const snapshot = api.buildSessionSnapshot();
    const claude = snapshot.sessions.find((s) => s.id === "claude-local");
    const codex = snapshot.sessions.find((s) => s.id === "codex-local");

    assert.strictEqual(claude.displayTitle, "Claude review");
    assert.strictEqual(claude.sessionTitle, "Agent title");
    assert.strictEqual(claude.cwd, "D:\\animation");
    assert.strictEqual(codex.displayTitle, "Codex follow-up");
    assert.strictEqual(codex.cwd, "d:/animation/");
    assert.strictEqual(snapshot.hudLastTitle, "Claude review");
  });

  it("uses Codex thread_name from session_index.jsonl for local session displayTitle", () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-index-"));
    fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), [
      JSON.stringify({
        id: "019d23d4-f1a9-7633-b9c7-758327137228",
        thread_name: "요구사항개선",
      }),
    ].join("\n") + "\n", "utf8");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexDir;
    try {
      api.sessions.set("codex:019d23d4-f1a9-7633-b9c7-758327137228", rawSession("thinking", {
        updatedAt: 1000,
        cwd: "D:\\repository\\spms",
        agentId: "codex",
        sessionTitle: "Auto Summary",
      }));

      const snapshot = api.buildSessionSnapshot();
      assert.strictEqual(snapshot.sessions[0].sessionTitle, "요구사항개선");
      assert.strictEqual(snapshot.sessions[0].displayTitle, "요구사항개선");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      fs.rmSync(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps session aliases scoped by host, agent, and session id", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      getSessionAliases: () => ({
        "remote-box|codex|remote": { title: "Remote Codex", updatedAt: 100 },
        "local|claude-code|local": { title: "Local Claude", updatedAt: 100 },
      }),
    }));
    api.sessions.set("local", rawSession("working", {
      updatedAt: 1000,
      cwd: "/home/me/project",
      host: null,
      agentId: "claude-code",
    }));
    api.sessions.set("remote", rawSession("working", {
      updatedAt: 2000,
      cwd: "/home/me/project",
      host: "remote-box",
      agentId: "codex",
    }));
    api.sessions.set("remote-other-agent", rawSession("working", {
      updatedAt: 3000,
      cwd: "/home/me/project",
      host: "remote-box",
      agentId: "claude-code",
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(
      snapshot.sessions.find((s) => s.id === "local").displayTitle,
      "Local Claude"
    );
    assert.strictEqual(
      snapshot.sessions.find((s) => s.id === "remote").displayTitle,
      "Remote Codex"
    );
    assert.strictEqual(
      snapshot.sessions.find((s) => s.id === "remote-other-agent").displayTitle,
      "project"
    );
  });

  it("scopes Kiro default-session aliases by cwd", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      getSessionAliases: () => ({
        "local|kiro-cli|default|cwd:%2Frepo%2Fa": { title: "Kiro repo A", updatedAt: 100 },
      }),
    }));
    api.sessions.set("default", rawSession("working", {
      updatedAt: 1000,
      cwd: "/repo/b",
      agentId: "kiro-cli",
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions[0].displayTitle, "b");
  });

  it("falls back to legacy Kiro default-session aliases when no cwd-scoped alias exists", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      getSessionAliases: () => ({
        "local|kiro-cli|default": { title: "Legacy Kiro", updatedAt: 100 },
      }),
    }));
    api.sessions.set("default", rawSession("working", {
      updatedAt: 1000,
      cwd: "/repo/a",
      agentId: "kiro-cli",
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions[0].displayTitle, "Legacy Kiro");
  });

  it("prefers cwd-scoped Kiro default-session aliases over legacy aliases", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      getSessionAliases: () => ({
        "local|kiro-cli|default": { title: "Legacy Kiro", updatedAt: 100 },
        "local|kiro-cli|default|cwd:%2Frepo%2Fa": { title: "Kiro repo A", updatedAt: 200 },
      }),
    }));
    api.sessions.set("default", rawSession("working", {
      updatedAt: 1000,
      cwd: "/repo/a",
      agentId: "kiro-cli",
    }));

    const snapshot = api.buildSessionSnapshot();
    assert.strictEqual(snapshot.sessions[0].displayTitle, "Kiro repo A");
  });

  it("returns active session alias keys for all sessions including idle and headless", () => {
    api.cleanup();
    api = require("../src/state")(makeCtx());
    api.sessions.set("idle-session", rawSession("idle", {
      agentId: "codex",
      host: null,
    }));
    api.sessions.set("headless-session", rawSession("working", {
      agentId: "claude-code",
      host: "remote-box",
      headless: true,
    }));
    api.sessions.set("default", rawSession("working", {
      agentId: "kiro-cli",
      cwd: "/repo/a",
    }));

    assert.deepStrictEqual(
      Array.from(api.getActiveSessionAliasKeys()).sort(),
      [
        "local|codex|idle-session",
        "local|kiro-cli|default|cwd:%2Frepo%2Fa",
        "remote-box|claude-code|headless-session",
      ]
    );
  });
});

describe("emitSessionSnapshot diff", () => {
  let api, broadcasts;

  beforeEach(() => {
    broadcasts = [];
    api = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => broadcasts.push(snapshot),
    }));
  });
  afterEach(() => api.cleanup());

  it("does not broadcast when only a single session updatedAt changes", () => {
    api.sessions.set("s1", rawSession("working", {
      updatedAt: 1000,
      cwd: "/tmp/one",
      agentId: "claude-code",
      recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
    }));

    assert.strictEqual(api.emitSessionSnapshot().changed, true);
    assert.strictEqual(broadcasts.length, 1);

    api.sessions.get("s1").updatedAt = 2000;
    assert.strictEqual(api.emitSessionSnapshot().changed, false);
    assert.strictEqual(broadcasts.length, 1);
  });

  it("broadcasts when updatedAt changes dashboard order and last session", () => {
    api.sessions.set("s1", rawSession("working", {
      updatedAt: 1000,
      cwd: "/tmp/one",
      agentId: "claude-code",
    }));
    api.sessions.set("s2", rawSession("working", {
      updatedAt: 2000,
      cwd: "/tmp/two",
      agentId: "codex",
    }));

    assert.strictEqual(api.emitSessionSnapshot().changed, true);
    assert.deepStrictEqual(broadcasts[broadcasts.length - 1].orderedIds, ["s2", "s1"]);

    api.sessions.get("s1").updatedAt = 3000;
    assert.strictEqual(api.emitSessionSnapshot().changed, true);
    assert.deepStrictEqual(broadcasts[broadcasts.length - 1].orderedIds, ["s1", "s2"]);
    assert.strictEqual(broadcasts[broadcasts.length - 1].lastSessionId, "s1");
  });

  it("broadcasts when visible fields change, including cwd and agentId", () => {
    api.sessions.set("s1", rawSession("idle", {
      updatedAt: 1000,
      cwd: "/tmp/one",
      agentId: "claude-code",
      recentEvents: [{ event: "SessionStart", state: "idle", at: 900 }],
    }));

    assert.strictEqual(api.emitSessionSnapshot().changed, true);

    api.sessions.get("s1").cwd = "/tmp/two";
    assert.strictEqual(api.emitSessionSnapshot().changed, true);

    api.sessions.get("s1").agentId = "codex";
    assert.strictEqual(api.emitSessionSnapshot().changed, true);

    api.sessions.get("s1").recentEvents.push({ event: "SessionStart", state: "idle", at: 1200 });
    assert.strictEqual(api.emitSessionSnapshot().changed, true);

    assert.strictEqual(broadcasts.length, 4);
  });
});

describe("Stop completion gate (#406)", () => {
  let api, ctx, soundsPlayed, stateChanges, savedDebounceEnv;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    // The product default is now 0 (opt-in); this describe exercises the
    // debounce, so turn it on explicitly.
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
    soundsPlayed = [];
    stateChanges = [];
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, ...args) => {
        if (channel === "state-change") stateChanges.push(args[0]);
      },
    });
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("background_tasks without final assistant text hold the Claude Stop as working — no celebrate, badge stays running", () => {
    update(api, { id: "s1", state: "attention", event: "Stop", backgroundTasksCount: 2 });
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    mock.timers.tick(5000); // no debounce scheduled for hard live work — nothing promotes
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"), "completion sound must not play");
  });

  it("exact typed background subagents hard-hold even with final assistant text (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response finished.",
    });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "working");
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    mock.timers.tick(5000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("direct completion promotion refuses typed markers but preserves legacy tracker-only completion (#952)", () => {
    update(api, {
      id: "typed",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    const typedBroadcastsBefore = api.getLastSessionSnapshot();
    assert.strictEqual(api.promoteCompletion("typed"), false);
    assert.strictEqual(api.sessions.get("typed").state, "working");
    assert.ok(Number.isFinite(api.sessions.get("typed").claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.getLastSessionSnapshot(), typedBroadcastsBefore);

    update(api, { id: "tracked", state: "working", event: "PreToolUse" });
    update(api, {
      id: "tracked",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    assert.strictEqual(api.promoteCompletion("tracked"), true);
    assert.strictEqual(api.sessions.get("tracked").state, "idle");
    assert.strictEqual(api.sessions.get("tracked").subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("tracked")), "done");
  });

  it("reports successful completion when a confirmed permission lock suppresses only the visual", () => {
    api.cleanup();
    ctx = makeCtx({
      processKill: () => true,
      isAgentPermissionsEnabled: () => true,
      showKimiNotifyBubble: () => {},
      clearKimiNotifyBubbles: () => {},
    });
    api = require("../src/state")(ctx);
    update(api, {
      id: "kimi-permission",
      state: "notification",
      event: "PermissionRequest",
      agentId: "kimi-cli",
    });
    update(api, { id: "completed", state: "working", event: "PreToolUse" });

    assert.strictEqual(api.promoteCompletion("completed"), true);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("completed")), "done");
  });

  it("identity-backed typed background work remains juggling past the quiet window (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    mock.timers.tick(5000);
    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "juggling");
    assert.strictEqual(session.subagentTracker.confirmedIds.has("child-a"), true);
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("disabling completion debounce cannot release a typed background subagent (#952)", () => {
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    mock.timers.tick(5000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    assert.ok(!soundsPlayed.includes("complete"));
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
  });

  it("an absent typed snapshot inherits the private hold instead of completing (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Intermediate parent response.",
    });
    const holdAt = api.sessions.get("s1").claudeBackgroundSubagentHoldAt;

    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      assistantLastOutput: "Later Stop without a task snapshot.",
    });
    mock.timers.tick(5000);

    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, holdAt);
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("ordinary parent progress and notifications neither clear nor idle a typed hold (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    const holdAt = api.sessions.get("s1").claudeBackgroundSubagentHoldAt;
    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit" });
    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, holdAt);
    update(api, { id: "s1", state: "notification", event: "PermissionRequest" });
    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, holdAt);
    update(api, { id: "s1", state: "notification", event: "Notification" });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, holdAt);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("authoritative typed zero releases the marker before normal Stop debounce (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response while child runs.",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
      assistantLastOutput: "Final response after child exit.",
    });

    assert.strictEqual(api.sessions.get("s1").claudeBackgroundSubagentHoldAt, null);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    mock.timers.tick(1000);
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
    assert.ok(soundsPlayed.includes("complete"));
  });

  it("an absent typed snapshot preserves legacy tracker-only completion (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      assistantLastOutput: "Parent finished while child remains.",
    });
    mock.timers.tick(5000);

    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(session.subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(api.deriveSessionBadge(session), "done");
    assert.ok(soundsPlayed.includes("complete"));
  });

  it("authoritative typed zero releases tracker evidence before debounced completion (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
      assistantLastOutput: "Final response after the authoritative snapshot.",
    });
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.size, 0);
    mock.timers.tick(1000);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
  });

  it("SubagentStop known-zero clears the typed marker only after the tracker empties and never completes (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    for (const child of ["child-a", "child-b"]) {
      update(api, {
        id: "s1",
        state: "juggling",
        event: "SubagentStart",
        subagentId: child,
      });
    }
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 2,
      assistantLastOutput: "Parent response.",
    });

    update(api, {
      id: "s1",
      state: "working",
      event: "SubagentStop",
      subagentId: "child-a",
      backgroundSubagentsCount: 1,
    });
    assert.ok(Number.isFinite(api.sessions.get("s1").claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.size, 1);

    update(api, {
      id: "s1",
      state: "working",
      event: "SubagentStop",
      subagentId: "child-b",
      backgroundSubagentsCount: 0,
    });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, null);
    assert.strictEqual(session.subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("keeps a typed-only session when SubagentStop has no resume state but still reports live work (#952)", () => {
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    update(api, {
      id: "s1",
      state: "working",
      event: "SubagentStop",
      subagentId: "child-a",
      backgroundSubagentsCount: 1,
    });

    const session = api.sessions.get("s1");
    assert.ok(session);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.subagentTracker.confirmedIds.size, 0);
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("subagent-scoped SessionEnd known-zero clears the typed marker after the tracker empties (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    update(api, {
      id: "s1",
      state: "sleeping",
      event: "SessionEnd",
      subagentId: "child-a",
      backgroundSubagentsCount: 0,
    });

    const session = api.sessions.get("s1");
    assert.ok(session);
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, null);
    assert.strictEqual(session.subagentTracker.confirmedIds.size, 0);
  });

  it("typed holds keep aggregate work live while still presenting terminal errors", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    stateChanges.length = 0;
    update(api, { id: "s1", state: "error", event: "ApiError" });

    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "working");
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    mock.timers.tick(1000);
    assert.ok(stateChanges.includes("error"));
  });

  it("SubagentStop followed by an older typed Stop can only become sticky-working, never prematurely complete (#952)", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-a",
    });
    update(api, {
      id: "s1",
      state: "working",
      event: "SubagentStop",
      subagentId: "child-a",
      backgroundSubagentsCount: 0,
    });
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Late older Stop.",
    });
    mock.timers.tick(5000);
    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "working");
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("SessionEnd and explicit dismissal remove typed holds instead of persisting them", () => {
    update(api, {
      id: "ended",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    update(api, { id: "ended", state: "sleeping", event: "SessionEnd" });
    assert.strictEqual(api.sessions.has("ended"), false);

    update(api, {
      id: "dismissed",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent response.",
    });
    assert.strictEqual(api.dismissSession("dismissed"), true);
    assert.strictEqual(api.sessions.has("dismissed"), false);
  });

  it("a duplicate typed Stop cannot reopen a completed row or leave a hidden marker (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
    });
    mock.timers.tick(1000);
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");

    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Late duplicate payload.",
    });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(api.deriveSessionBadge(session), "done");
    assert.strictEqual(session.claudeBackgroundSubagentHoldAt, null);
  });

  it("a reordered typed Stop supersedes a pending plain-Stop completion without racing the timer (#952)", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      assistantLastOutput: "Tentative parent answer.",
    });
    mock.timers.tick(500);
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent answer while delayed child evidence arrives.",
    });
    mock.timers.tick(5000);

    const session = api.sessions.get("s1");
    assert.strictEqual(session.state, "working");
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("background_tasks with final assistant text debounce, then celebrate on a quiet window", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      assistantLastOutput: "Done.",
    });
    assert.strictEqual(api.sessions.get("s1").state, "working", "held during the bg-only quiet window");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    assert.deepStrictEqual(soundsPlayed, [], "no completion sound before the quiet window elapses");
    mock.timers.tick(1000);
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"), "bg-only completion with final text celebrates");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
  });

  it("background_tasks with final assistant text cancel when work resumes inside the window", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      assistantLastOutput: "Intermediate result.",
    });
    mock.timers.tick(500);
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    mock.timers.tick(2000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"), "resumed work cancels the bg-only completion");
  });

  it("session_crons hold the Claude Stop as working", () => {
    update(api, { id: "s1", state: "attention", event: "Stop", sessionCronsCount: 1 });
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("session_crons still hard-hold even when final assistant text exists", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      sessionCronsCount: 1,
      assistantLastOutput: "Done.",
    });
    mock.timers.tick(5000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("stop_hook_active (continuation) holds the Claude Stop as working", () => {
    update(api, { id: "s1", state: "attention", event: "Stop", stopHookActive: true });
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("stop_hook_active still hard-holds even when final assistant text exists", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      stopHookActive: true,
      assistantLastOutput: "Done.",
    });
    mock.timers.tick(5000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("session_crons dominate bg-only assistant text and keep the Stop hard-held", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      sessionCronsCount: 1,
      assistantLastOutput: "Done.",
    });
    mock.timers.tick(5000);
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("debounce: a Stop followed by PreToolUse within the window never celebrates", () => {
    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
    });
    assert.strictEqual(api.sessions.get("s1").state, "working", "held working during the window");
    mock.timers.tick(500); // still within the 1000ms window
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    mock.timers.tick(2000); // past the original window
    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"), "a vetoed/continued Stop must not celebrate");
  });

  it("debounce: a quiet Stop celebrates after the window and marks the session done", () => {
    update(api, { id: "s1", state: "attention", event: "Stop" });
    assert.deepStrictEqual(soundsPlayed, [], "no celebration before the window elapses");
    mock.timers.tick(1000); // window elapses with no forward progress
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"), "a real completion celebrates");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
  });

  it("debounce: dismissSession cancels a pending completion before same-id lease restore", () => {
    const rawSessionId = "debounce-dismiss-restore";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      assistantLastOutput: "OLD DEBOUNCED OUTPUT",
    });
    mock.timers.tick(500);
    assert.strictEqual(api.dismissSession(sessionId), true);
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: "/tmp",
    }), true);

    mock.timers.tick(1000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("debounce: background-task final-text quiet window is cancelled before same-id lease restore", () => {
    const rawSessionId = "debounce-bg-final-dismiss-restore";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      assistantLastOutput: "OLD BG-FINAL OUTPUT",
    });
    mock.timers.tick(500);
    assert.strictEqual(api.dismissSession(sessionId), true);
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: "/tmp",
    }), true);

    mock.timers.tick(1000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("debounce: clearSessionsByAgent cancels a pending completion before same-id lease restore", () => {
    const rawSessionId = "debounce-clear-restore";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      assistantLastOutput: "OLD DEBOUNCED OUTPUT",
    });
    mock.timers.tick(500);
    assert.strictEqual(api.clearSessionsByAgent("claude-code"), 1);
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: "/tmp",
    }), true);

    mock.timers.tick(1000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("debounce: stale-delete cancels a pending completion before same-id lease restore", () => {
    api.cleanup();
    ctx = makeCtx({
      processKill: makePidKill(new Set()),
      playSound: (name) => soundsPlayed.push(name),
      sendToRenderer: (channel, ...args) => {
        if (channel === "state-change") stateChanges.push(args[0]);
      },
    });
    api = require("../src/state")(ctx);
    const rawSessionId = "debounce-stale-delete-restore";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      assistantLastOutput: "OLD STALE-DELETED OUTPUT",
      agentPid: 12345,
    });
    const pending = api.sessions.get(sessionId);
    pending.pidReachable = true;
    pending.agentPid = 12345;
    mock.timers.tick(500);
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.has(sessionId), false);
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: "/tmp",
    }), true);

    mock.timers.tick(1000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("debounce: MAX_SESSIONS eviction cancels a pending completion before same-id lease restore", () => {
    const rawSessionId = "debounce-evict-restore";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      assistantLastOutput: "OLD EVICTED OUTPUT",
    });
    api.sessions.get(sessionId).updatedAt = Date.now();
    mock.timers.tick(500);
    for (let i = 0; i < 19; i++) {
      api.sessions.set(`evict-filler-${i}`, rawSession("idle", {
        agentId: "codex",
        host: "ssh:example.com",
        updatedAt: Date.now() + i + 1,
      }));
    }

    update(api, {
      id: "eviction-trigger",
      state: "working",
      event: "PreToolUse",
      agentId: "claude-code",
    });
    assert.strictEqual(api.sessions.has(sessionId), false, "pending completion owner should be evicted");
    assert.strictEqual(api.dismissSession("eviction-trigger"), true, "make room for the restored lease");
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: "/tmp",
    }), true);

    mock.timers.tick(1000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("debounce: a duplicate Stop after auto-return does not replay completion", () => {
    update(api, { id: "s1", state: "attention", event: "Stop" });
    mock.timers.tick(1000);
    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 1);
    mock.timers.tick(4000);
    assert.strictEqual(api.getCurrentState(), "idle");

    soundsPlayed.length = 0;
    stateChanges.length = 0;
    update(api, { id: "s1", state: "attention", event: "Stop" });

    assert.strictEqual(api.sessions.get("s1").state, "idle");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
    mock.timers.tick(5000);
    assert.strictEqual(soundsPlayed.filter((name) => name === "complete").length, 0);
    assert.ok(!stateChanges.includes("working"), "duplicate Stop must not reopen a running state");
    assert.ok(!stateChanges.includes("attention"), "duplicate Stop must not replay attention");
  });

  it("does not debounce non-Claude agents — a Codex Stop celebrates immediately", () => {
    update(api, { id: "cx", state: "attention", event: "Stop", agentId: "codex" });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"));
  });

  it("CLAWD_COMPLETION_DEBOUNCE_MS=0 disables the debounce (immediate celebration)", () => {
    const saved = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    try {
      update(api, { id: "s1", state: "attention", event: "Stop" });
      assert.strictEqual(api.getCurrentState(), "attention");
      assert.ok(soundsPlayed.includes("complete"));
    } finally {
      if (saved === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
      else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = saved;
    }
  });

  it("CLAWD_COMPLETION_DEBOUNCE_MS=0 also disables the bg-only assistant-text quiet window", () => {
    const saved = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    try {
      update(api, {
        id: "s1",
        state: "attention",
        event: "Stop",
        backgroundTasksCount: 1,
        assistantLastOutput: "Done.",
      });
      assert.strictEqual(api.getCurrentState(), "attention");
      assert.strictEqual(api.sessions.get("s1").state, "idle");
      assert.ok(soundsPlayed.includes("complete"));
      assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "done");
    } finally {
      if (saved === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
      else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = saved;
    }
  });

  it("Stop then Notification within the window still records completion (badge done) (#406 regression)", () => {
    update(api, { id: "s1", state: "attention", event: "Stop" });
    assert.strictEqual(api.sessions.get("s1").state, "working", "held during the window");
    mock.timers.tick(400); // within the 1000ms window
    update(api, { id: "s1", state: "notification", event: "Notification" }); // wait-for-input ping
    mock.timers.tick(5000); // window elapses → promote replays the Stop
    const s = api.sessions.get("s1");
    assert.strictEqual(s.state, "idle");
    // The Notification no longer buries the Stop tail: badge → done, so the HUD
    // and the Telegram completion still fire. (The celebration is visual-only
    // and intentionally yields to the wait-for-input visual by priority.)
    assert.strictEqual(api.deriveSessionBadge(s), "done");
  });

  it("authoritative completion clears stale subagent evidence before the next turn", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    update(api, {
      id: "s1",
      state: "juggling",
      event: "SubagentStart",
      subagentId: "child-with-missed-stop",
      subagentLifecycleSource: "native",
    });
    assert.strictEqual(api.sessions.get("s1").subagentTracker.confirmedIds.size, 1);

    update(api, {
      id: "s1",
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 0,
    });
    assert.strictEqual(api.sessions.get("s1").state, "working", "authoritative zero releases the stale tracker during debounce");
    mock.timers.tick(1000);

    const completed = api.sessions.get("s1");
    assert.strictEqual(completed.state, "idle");
    assert.strictEqual(completed.subagentTracker.confirmedIds.size, 0);
    assert.strictEqual(completed.subagentTracker.legacyFloor, false);
    assert.strictEqual(completed.subagentTracker.recoveredFloor, false);

    update(api, { id: "s1", state: "working", event: "UserPromptSubmit" });
    assert.strictEqual(
      api.sessions.get("s1").state,
      "working",
      "the next turn must not be pinned in juggling by a child whose Stop was lost"
    );
  });

  it("hard liveWork-held Stop does not become a false 'done' after stale cleanup (#406 regression)", () => {
    update(api, { id: "s1", state: "attention", event: "Stop", backgroundTasksCount: 1, agentPid: 1000, sourcePid: 2000 });
    const held = api.sessions.get("s1");
    assert.strictEqual(held.state, "working");
    assert.strictEqual(api.deriveSessionBadge(held), "running");
    mock.timers.tick(310000); // age the session past WORKING_STALE_MS
    api.cleanStaleSessions();
    const after = api.sessions.get("s1");
    assert.ok(after, "stale working downgrades, not deletes (pids alive)");
    assert.strictEqual(after.state, "idle");
    assert.strictEqual(api.deriveSessionBadge(after), "idle", "a held Stop must NOT resurface as done after stale cleanup");
  });

  it("mini mode: a debounced Stop promotes to mini-happy after the window", () => {
    ctx.miniMode = true;
    api = require("../src/state")(ctx);
    update(api, { id: "s1", state: "attention", event: "Stop" });
    stateChanges.length = 0;
    soundsPlayed.length = 0;
    mock.timers.tick(1000); // quiet window elapses → celebrate
    assert.ok(stateChanges.includes("mini-happy"), "mini completion celebration must fire");
    assert.ok(soundsPlayed.includes("complete"), "completion sound must play in mini mode");
  });

  it("promoteCompletion does not swallow another session's queued high-priority visual (#406 regression)", () => {
    // Short debounce so A promotes WHILE B's queued error is still pending behind
    // the held "working" min-display (1000ms in the clawd theme).
    const saved = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "100";
    try {
      update(api, { id: "A", state: "attention", event: "Stop" }); // held working at t0 (min-display 1000)
      update(api, { id: "B", state: "error", event: "StopFailure" }); // error(8) queues behind working's min-display
      stateChanges.length = 0;
      mock.timers.tick(1200); // A promotes at t=100; B's error must still apply at t=1000
      assert.ok(
        stateChanges.includes("error"),
        "A's completion must not clear the global pending queue and drop B's error"
      );
      assert.strictEqual(api.deriveSessionBadge(api.sessions.get("A")), "done", "A still completes");
    } finally {
      if (saved === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
      else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = saved;
    }
  });

  it("Claude AskUserQuestion PostToolUse falls back to transcript completion when Stop is missed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const rawSessionId = "claude-probe-hit";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Allow" }] } }),
    ].join("\n") + "\n");

    update(api, {
      id: sessionId,
      state: "working",
      event: "PostToolUse",
      rawSessionId,
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });

    mock.timers.tick(1999);
    assert.strictEqual(api.sessions.get(sessionId).state, "working");
    assert.deepStrictEqual(soundsPlayed, []);

    fs.appendFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: { content: "Final answer from Claude Desktop." },
    }) + "\n");
    mock.timers.tick(1);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "idle");
    assert.strictEqual(session.assistantLastOutput, "Final answer from Claude Desktop.");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "done");
  });

  it("Claude transcript completion cannot promote through a typed background-subagent hold (#952)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const rawSessionId = "claude-probe-background-subagent";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Allow" }] } }),
      JSON.stringify({ type: "assistant", message: { content: "Parent answer while child runs." } }),
    ].join("\n") + "\n");

    update(api, {
      id: sessionId,
      rawSessionId,
      state: "attention",
      event: "Stop",
      backgroundSubagentsCount: 1,
      assistantLastOutput: "Parent answer while child runs.",
    });
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "working",
      event: "PostToolUse",
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });

    mock.timers.tick(10000);
    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.ok(Number.isFinite(session.claudeBackgroundSubagentHoldAt));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
    assert.ok(!soundsPlayed.includes("complete"));
  });

  it("Claude transcript fallback documents raw transcript sessionId mismatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const rawSessionId = "claude-probe-raw-mismatch";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", sessionId: rawSessionId, message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", sessionId: rawSessionId, message: { content: [{ type: "tool_result", content: "Allow" }] } }),
      JSON.stringify({ type: "assistant", sessionId: rawSessionId, message: { content: "Final answer from raw transcript." } }),
    ].join("\n") + "\n");

    update(api, {
      id: sessionId,
      state: "working",
      event: "PostToolUse",
      rawSessionId,
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });
    mock.timers.tick(10000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("Claude transcript completion fallback is cancelled before restoring the same raw session id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const rawSessionId = "claude-probe-restore-race";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Allow" }] } }),
      JSON.stringify({ type: "assistant", message: { content: "OLD TRANSCRIPT FINAL" } }),
    ].join("\n") + "\n");

    update(api, {
      id: sessionId,
      state: "working",
      event: "PostToolUse",
      rawSessionId,
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });
    assert.strictEqual(api.dismissSession(sessionId), true);
    assert.strictEqual(api.restoreSessionFromLease({
      sessionId: rawSessionId,
      agentId: "claude-code",
      active: true,
      eventAt: 1,
      validUntil: null,
      state: "working",
      pid: 12345,
      cwd: dir,
    }), true);

    mock.timers.tick(2000);

    const session = api.sessions.get(sessionId);
    assert.strictEqual(session.state, "working");
    assert.strictEqual(session.assistantLastOutput, null);
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(session), "running");
  });

  it("Claude transcript completion fallback is limited to AskUserQuestion tool results", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "user", sessionId: "s1", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { content: "Intermediate explanation." } }),
    ].join("\n") + "\n");

    update(api, {
      id: "s1",
      state: "working",
      event: "PostToolUse",
      toolName: "Read",
      transcriptPath: transcript,
    });
    mock.timers.tick(10000);

    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
  });

  it("Claude transcript completion fallback cancels when work resumes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-stop-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", sessionId: "s1", message: { content: [{ type: "tool_result", content: "Allow" }] } }),
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { content: "Continuing after answer." } }),
    ].join("\n") + "\n");

    update(api, {
      id: "s1",
      state: "working",
      event: "PostToolUse",
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });
    mock.timers.tick(500);
    update(api, { id: "s1", state: "working", event: "PreToolUse" });
    mock.timers.tick(10000);

    assert.strictEqual(api.sessions.get("s1").state, "working");
    assert.ok(!soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("s1")), "running");
  });
});

describe("Headless Stop debounce default (#449)", () => {
  let api, ctx, soundsPlayed, savedDebounceEnv;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    // This group exercises the built-in defaults — make sure no env override
    // from the host shell leaks in.
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    soundsPlayed = [];
    ctx = makeCtx({
      processKill: () => true,
      playSound: (name) => soundsPlayed.push(name),
    });
    api = require("../src/state")(ctx);
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("headless Stop is held; the orchestrator's next prompt suppresses the celebration", () => {
    update(api, { id: "h1", state: "attention", event: "Stop", headless: true });
    assert.strictEqual(api.sessions.get("h1").state, "working", "held during the window");
    assert.deepStrictEqual(soundsPlayed, [], "no celebration on the mid-task Stop");
    mock.timers.tick(500); // Claudian-style continuation lands inside the window
    update(api, { id: "h1", state: "thinking", event: "UserPromptSubmit", headless: true });
    mock.timers.tick(5000); // well past the original window
    assert.strictEqual(api.sessions.get("h1").state, "thinking");
    assert.ok(!soundsPlayed.includes("complete"), "a continued Stop must not celebrate");
  });

  it("headless Stop with a quiet window celebrates after the 2s default", () => {
    update(api, { id: "h1", state: "attention", event: "Stop", headless: true });
    mock.timers.tick(1999);
    assert.deepStrictEqual(soundsPlayed, [], "still inside the default window");
    mock.timers.tick(1); // 2000ms — the turn really ended
    assert.strictEqual(api.sessions.get("h1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"), "a real headless completion celebrates");
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("h1")), "done");
  });

  it("interactive (non-headless) Stop still celebrates immediately by default", () => {
    update(api, { id: "i1", state: "attention", event: "Stop" });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"));
  });

  it("interactive bg-only Stop with final assistant text waits 2s by default, then celebrates", () => {
    update(api, {
      id: "i1",
      state: "attention",
      event: "Stop",
      backgroundTasksCount: 1,
      assistantLastOutput: "Done from Claude Desktop.",
    });
    mock.timers.tick(1999);
    assert.deepStrictEqual(soundsPlayed, [], "still waiting for a quiet bg-only window");
    mock.timers.tick(1);
    assert.strictEqual(api.sessions.get("i1").state, "idle");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"));
    assert.strictEqual(api.deriveSessionBadge(api.sessions.get("i1")), "done");
  });

  it("the headless flag persists — a later Stop without the flag still debounces", () => {
    update(api, { id: "h1", state: "thinking", event: "UserPromptSubmit", headless: true });
    update(api, { id: "h1", state: "attention", event: "Stop" }); // flag omitted on this event
    assert.strictEqual(api.sessions.get("h1").state, "working", "held via persisted headless flag");
    mock.timers.tick(2000);
    assert.ok(soundsPlayed.includes("complete"), "quiet window still promotes");
  });

  it("CLAWD_COMPLETION_DEBOUNCE_MS=0 disables the headless default too", () => {
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    update(api, { id: "h1", state: "attention", event: "Stop", headless: true });
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.ok(soundsPlayed.includes("complete"), "explicit 0 keeps the old immediate behavior");
  });

  it("an explicit CLAWD_COMPLETION_DEBOUNCE_MS overrides the headless default window", () => {
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "100";
    update(api, { id: "h1", state: "attention", event: "Stop", headless: true });
    mock.timers.tick(99);
    assert.deepStrictEqual(soundsPlayed, [], "inside the overridden window");
    mock.timers.tick(1);
    assert.ok(soundsPlayed.includes("complete"), "overridden window promotes, not the 2s default");
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

  it("returns 'idle' for PostCompact in recentEvents (compaction is not completion, #406)", () => {
    const s = { state: "idle", recentEvents: [{ event: "PostCompact" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "idle");
  });

  it("returns 'idle' when idle with Gemini AfterAgent in recentEvents", () => {
    const s = { state: "idle", recentEvents: [{ event: "AfterAgent" }] };
    assert.strictEqual(api.deriveSessionBadge(s), "idle");
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

  it("enableDoNotDisturb uses theme-specific direct sleep transition art when provided", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.dndSleepTransitionSvg = "custom-idle-to-sleeping.svg";
    theme.timings.dndSleepTransitionDuration = 4800;
    api.cleanup();
    ctx = makeCtx({ theme });
    api = require("../src/state")(ctx);

    api.enableDoNotDisturb();

    assert.strictEqual(api.getCurrentState(), "collapsing");
    assert.strictEqual(api.getCurrentSvg(), "custom-idle-to-sleeping.svg");
    mock.timers.tick(4799);
    assert.strictEqual(api.getCurrentState(), "collapsing");
    mock.timers.tick(1);
    assert.strictEqual(api.getCurrentState(), "sleeping");
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

  it("DND dismisses pending permissions without resolving deny", () => {
    const resolved = [];
    const dismissed = [];
    ctx.resolvePermissionEntry = (perm, action) => resolved.push({ perm, action });
    ctx.dismissPermissionsForDnd = () => {
      dismissed.push([...ctx.pendingPermissions]);
      ctx.pendingPermissions.length = 0;
      return 2;
    };
    ctx.pendingPermissions = ["p1", "p2"];
    api.enableDoNotDisturb();
    assert.deepStrictEqual(dismissed, [["p1", "p2"]]);
    assert.deepStrictEqual(resolved, []);
    assert.deepStrictEqual(ctx.pendingPermissions, []);
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

  it("DND preserves pending completion arbitration and records it without sound", () => {
    const { createMemoryRecapSink } = require("../src/recap-sink");
    const recapSink = createMemoryRecapSink();
    const sounds = [];
    api.cleanup();
    ctx = makeCtx({ recapSink, playSound: (name) => sounds.push(name) });
    api = require("../src/state")(ctx);

    update(api, { event: "UserPromptSubmit", state: "thinking", headless: true });
    recapSink.clear();
    update(api, {
      event: "Stop",
      state: "attention",
      headless: true,
      assistantLastOutput: "done",
      recapOccurredAt: 123456,
    });
    assert.deepStrictEqual(recapSink.snapshot(), []);

    api.enableDoNotDisturb();
    mock.timers.tick(2000);

    assert.deepStrictEqual(recapSink.snapshot().map((event) => event.metrics), [
      ["activity", "turn-complete"],
    ]);
    assert.strictEqual(recapSink.snapshot()[0].occurredAt, 123456);
    assert.notStrictEqual(api.getLastSessionSnapshot().sessions[0].lastEvent.at, 123456);
    assert.deepStrictEqual(sounds, []);
    assert.strictEqual(ctx.doNotDisturb, true);
    assert.strictEqual(api.getCurrentState(), "yawning");
  });

  it("DND preserves Claude transcript completion fallback and records it without sound", () => {
    const { createMemoryRecapSink } = require("../src/recap-sink");
    const recapSink = createMemoryRecapSink();
    const sounds = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-dnd-fallback-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const rawSessionId = "claude-dnd-probe-hit";
    const sessionId = resolveSessionIdentity(rawSessionId, "local").sessionId;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Allow" }] } }),
    ].join("\n") + "\n");

    api.cleanup();
    ctx = makeCtx({ recapSink, playSound: (name) => sounds.push(name) });
    api = require("../src/state")(ctx);
    update(api, {
      id: sessionId,
      rawSessionId,
      state: "working",
      event: "PostToolUse",
      toolName: "AskUserQuestion",
      transcriptPath: transcript,
    });
    recapSink.clear();
    api.enableDoNotDisturb();
    fs.appendFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: { content: "Final answer while DND is enabled." },
    }) + "\n");

    mock.timers.tick(2000);

    assert.strictEqual(api.deriveSessionBadge(api.sessions.get(sessionId)), "done");
    assert.deepStrictEqual(recapSink.snapshot().map((event) => event.metrics), [
      ["activity", "turn-complete"],
    ]);
    assert.deepStrictEqual(sounds, []);
    assert.strictEqual(ctx.doNotDisturb, true);
    assert.strictEqual(api.getCurrentState(), "yawning");
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

// ═════════════════════════════════════════════════════════════════════════════
// Group: requiresCompletionAck lifecycle (PR2, issue #308)
// ═════════════════════════════════════════════════════════════════════════════

describe("requiresCompletionAck lifecycle", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  it("remote Codex Stop sets requiresCompletionAck=true (via finally reconciler)", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    assert.strictEqual(session && session.requiresCompletionAck, true);
  });

  it("remote Codex JSONL task_complete also sets requiresCompletionAck=true", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    assert.strictEqual(session && session.requiresCompletionAck, true);
  });

  it("remote Codex task_complete after Stop preserves the ack flag", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);
  });

  it("remote Codex stale-cleanup preserves an unacknowledged completion", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    update(api, { id: "s1", state: "sleeping", event: "stale-cleanup", agentId: "codex", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.requiresCompletionAck, true);
    assert.strictEqual(session.recentEvents.at(-1).event, "stale-cleanup");
    const entry = api.buildSessionSnapshot().sessions.find((s) => s.id === "s1");
    assert.strictEqual(entry.badge, "done");
    assert.strictEqual(entry.requiresCompletionAck, true);
  });

  it("remote Codex housekeeping preserves an unacknowledged completion", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    api.updateSession("s1", "idle", "event_msg:token_count", {
      agentId: "codex",
      host: "ssh:example.com",
      preserveState: true,
      contextUsage: { used: 100, limit: 1000, percent: 10, source: "codex" },
    });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    api.updateSession("s1", "notification", "Notification", {
      agentId: "codex",
      host: "ssh:example.com",
    });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);
  });

  it("#414: unacknowledged remote completion is deleted by the session timeout (no 24h hold)", () => {
    // End-to-end: completion sets the flag, stale-cleanup keeps the `done`
    // badge, but once the configured idle timeout elapses the session is
    // removed like any other unreachable remote session — it is NOT held for
    // 24h waiting on a manual ack.
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    update(api, { id: "s1", state: "sleeping", event: "stale-cleanup", agentId: "codex", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    assert.strictEqual(session.requiresCompletionAck, true);
    assert.strictEqual(api.buildSessionSnapshot().sessions.find((s) => s.id === "s1").badge, "done");

    // Simulate the default sessionStaleMs (600000ms) elapsing since the last update.
    session.updatedAt = Date.now() - 700000;
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.has("s1"), false);
  });

  it("#414: ack resets the idle window via ackedAt; deletion waits for a fresh timeout", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    // Completion is already old, but the user acks now → ackedAt is fresh.
    api.sessions.get("s1").updatedAt = Date.now() - 700000;
    assert.strictEqual(api.ackSessionCompletion("s1"), true);

    // referenceTs = max(updatedAt, ackedAt) = the fresh ack → still in window.
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.has("s1"), true);

    // Advance past the window from the ack instant → now it deletes.
    api.sessions.get("s1").ackedAt = Date.now() - 700000;
    api.cleanStaleSessions();
    assert.strictEqual(api.sessions.has("s1"), false);
  });

  it("remote Codex stale-cleanup alone does not create an ack requirement", () => {
    update(api, { id: "s1", state: "sleeping", event: "stale-cleanup", agentId: "codex", host: "ssh:example.com" });
    assert.notStrictEqual(api.sessions.get("s1").requiresCompletionAck, true);
  });

  it("remote Codex activity after stale-cleanup clears the previous ack requirement", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    update(api, { id: "s1", state: "sleeping", event: "stale-cleanup", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    update(api, { id: "s1", state: "thinking", event: "UserPromptSubmit", agentId: "codex", host: "ssh:example.com" });
    assert.notStrictEqual(api.sessions.get("s1").requiresCompletionAck, true);
  });

  it("ackSessionCompletion works after remote Codex stale-cleanup", () => {
    update(api, { id: "s1", state: "attention", event: "event_msg:task_complete", agentId: "codex", host: "ssh:example.com" });
    update(api, { id: "s1", state: "sleeping", event: "stale-cleanup", agentId: "codex", host: "ssh:example.com" });

    assert.strictEqual(api.ackSessionCompletion("s1"), true);
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, false);
  });

  it("LOCAL Codex Stop does NOT set the flag (host=null)", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: null });
    const session = api.sessions.get("s1");
    assert.notStrictEqual(session && session.requiresCompletionAck, true);
  });

  it("non-codex Stop on a remote session does NOT set the flag", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "claude-code", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    assert.notStrictEqual(session && session.requiresCompletionAck, true);
  });

  it("subsequent non-Stop event clears the flag without touching ackedAt", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    update(api, { id: "s1", state: "working", event: "UserPromptSubmit", agentId: "codex", host: "ssh:example.com" });
    const session = api.sessions.get("s1");
    // "cleared" = not true. When sessions.set rebuilds the entry the flag
    // simply isn't carried over (undefined); when the entry is mutated
    // in place (Object.assign / juggling-hold paths) the reconciler sets
    // it to false. Both render identically as `!!flag === false` in
    // snapshot payloads.
    assert.notStrictEqual(session.requiresCompletionAck, true);
    assert.strictEqual(session.ackedAt, undefined);
  });

  it("event === null on a flagged session clears the flag (locked semantics)", () => {
    // §3.11: null/undefined event = state-derived refresh with no carry;
    // must NOT preserve the flag. This test lives so any future refactor
    // that wants to preserve the flag on null events has to update it
    // consciously. Calls updateSession directly because the `update()`
    // helper's `o.event || "PreToolUse"` clobbers null.
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    api.updateSession("s1", "idle", null, {
      agentId: "codex",
      host: "ssh:example.com",
    });
    assert.notStrictEqual(api.sessions.get("s1").requiresCompletionAck, true);
  });

  it("Kimi PermissionRequest early-return still reconciles the flag", () => {
    // §3.11 test #38: state.js:750-813 PermissionRequest path takes an
    // early return — must still go through the finally reconciler.
    // Pre-seed a flagged remote codex session, then deliver a Kimi
    // PermissionRequest gated off — flag MUST clear.
    api.sessions.set("s1", rawSession("idle", {
      agentId: "codex",
      host: "ssh:example.com",
      updatedAt: Date.now(),
    }));
    api.sessions.get("s1").requiresCompletionAck = true;

    const ctxNoKimi = makeCtx({ isAgentPermissionsEnabled: () => false });
    const api2 = require("../src/state")(ctxNoKimi);
    api2.sessions.set("s1", rawSession("idle", {
      agentId: "codex",
      host: "ssh:example.com",
      updatedAt: Date.now(),
    }));
    api2.sessions.get("s1").requiresCompletionAck = true;
    update(api2, { id: "s1", state: "notification", event: "PermissionRequest", agentId: "kimi-cli" });
    // The Kimi gate early-returns, but flag should be cleared via finally.
    assert.strictEqual(api2.sessions.get("s1").requiresCompletionAck, false);
    api2.cleanup();
  });

  it("Object.assign ONESHOT path still reconciles the flag on non-Stop events", () => {
    // §3.11 test #39: ONESHOT_STATES branch at state.js:910-916 mutates
    // the existing entry in place via Object.assign; flag survival across
    // that mutation must be governed by the reconciler.
    api.sessions.set("s1", rawSession("idle", {
      agentId: "codex",
      host: "ssh:example.com",
      updatedAt: Date.now(),
    }));
    api.sessions.get("s1").requiresCompletionAck = true;
    // sweeping is a ONESHOT state — triggers Object.assign(existing, base).
    update(api, { id: "s1", state: "sweeping", event: "UserPromptSubmit", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, false);
  });

  it("ackSessionCompletion: clears flag, sets ackedAt, returns true, forces snapshot", () => {
    update(api, { id: "s1", state: "idle", event: "Stop", agentId: "codex", host: "ssh:example.com" });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, true);

    const before = Date.now();
    const result = api.ackSessionCompletion("s1");
    assert.strictEqual(result, true);
    const session = api.sessions.get("s1");
    assert.strictEqual(session.requiresCompletionAck, false);
    assert.ok(session.ackedAt >= before, "ackedAt should be set to the ack timestamp");
  });

  it("ackSessionCompletion on a missing session returns false silently", () => {
    assert.strictEqual(api.ackSessionCompletion("does-not-exist"), false);
  });

  it("ackSessionCompletion on an unflagged session is an idempotent no-op", () => {
    update(api, { id: "s1", state: "working", event: "PreToolUse", agentId: "codex", host: null });
    assert.strictEqual(api.sessions.get("s1").requiresCompletionAck, undefined);
    const result = api.ackSessionCompletion("s1");
    assert.strictEqual(result, false);
    assert.strictEqual(api.sessions.get("s1").ackedAt, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Group: two-phase MAX_SESSIONS evictor (PR2)
// ═════════════════════════════════════════════════════════════════════════════

describe("evictOldestSessionIfNeeded two-phase", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  function seed(api, count, ackedIndices = new Set()) {
    // Helper: seed N sessions with distinct, RECENT updatedAt values so the
    // "oldest" candidate is deterministic and none of them trip the 24h
    // ack-pending cap when cleanStaleSessions sweeps after the eviction.
    const baseTime = Date.now() - 10_000; // ~10 s ago, well within all caps
    for (let i = 0; i < count; i++) {
      const id = `s${i}`;
      api.sessions.set(id, rawSession("idle", {
        agentId: "codex",
        host: "ssh:example.com",
        updatedAt: baseTime + i, // s0 oldest, sN-1 newest
      }));
      if (ackedIndices.has(i)) {
        api.sessions.get(id).requiresCompletionAck = true;
      }
    }
  }

  it("prefers the oldest non-ack session when capacity is hit", () => {
    // 19 ack-pending + 1 non-ack. Adding the 21st (capacity = 20) must
    // evict the non-ack oldest, not any of the ack-pending sessions.
    seed(api, 20, new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
    // s19 is non-ack and oldest of the non-ack group (only one).
    update(api, { id: "s-new", state: "working", event: "PreToolUse", agentId: "claude-code" });
    assert.strictEqual(api.sessions.has("s19"), false, "s19 (non-ack) should have been evicted");
    // All 19 ack-pending entries survived
    for (let i = 0; i <= 18; i++) {
      assert.strictEqual(api.sessions.has(`s${i}`), true, `s${i} ack-pending should survive`);
    }
  });

  it("evicts the oldest ack-pending session only when every entry is ack-pending", () => {
    seed(api, 20, new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
    update(api, { id: "s-new", state: "working", event: "PreToolUse", agentId: "claude-code" });
    // s0 is oldest ack-pending (smallest updatedAt) — must be the victim.
    assert.strictEqual(api.sessions.has("s0"), false, "oldest ack-pending should be evicted as fallback");
    for (let i = 1; i <= 19; i++) {
      assert.strictEqual(api.sessions.has(`s${i}`), true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Qwen Code 0.16.1 self-submit filter — qwen's agentic loop fires a synthetic
// UserPromptSubmit ~900-1000ms after PostToolUse to feed the tool result back
// to the model. Without filtering this flashes "thinking" between working and
// idle. Measured twice in dogfood (908ms non-interactive, 945ms interactive).
// Window = 2000ms default, overridable via CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS.
// Two timestamps: lastToolBoundaryAt (PostToolUse / PostToolUseFailure) and
// lastStopAt (Stop). Filter only fires while a recent tool boundary has NOT
// yet been followed by Stop. See project_qwen_0_16_1_event_semantics canary.
// ═════════════════════════════════════════════════════════════════════════════

describe("qwen-code self-submit filter", () => {
  let api, ctx;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    ctx = makeCtx();
    api = require("../src/state")(ctx);
    delete process.env.CLAWD_QWEN_SELF_SUBMIT_FILTER;
    delete process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS;
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
    delete process.env.CLAWD_QWEN_SELF_SUBMIT_FILTER;
    delete process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS;
  });

  function bootQwenAfterPostToolUse() {
    update(api, { id: "qsid", state: "working", event: "PreToolUse", agentId: "qwen-code" });
    update(api, { id: "qsid", state: "working", event: "PostToolUse", agentId: "qwen-code" });
    const entry = api.sessions.get("qsid");
    assert.ok(entry, "qwen session should exist after PostToolUse");
    assert.ok(Number.isFinite(entry.lastToolBoundaryAt), "PostToolUse should bump lastToolBoundaryAt");
    return entry;
  }

  it("PostToolUse within window → UserPromptSubmit dropped (state/updatedAt/recentEvents untouched)", () => {
    const before = bootQwenAfterPostToolUse();
    const snapshot = {
      state: before.state,
      updatedAt: before.updatedAt,
      recentEvents: [...(before.recentEvents || [])],
      lastToolBoundaryAt: before.lastToolBoundaryAt,
    };

    mock.timers.tick(1500); // within 2000ms
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, snapshot.state, "state must not change");
    assert.strictEqual(after.updatedAt, snapshot.updatedAt, "updatedAt must not bump");
    assert.deepStrictEqual(after.recentEvents, snapshot.recentEvents, "recentEvents must not append");
    assert.strictEqual(after.lastToolBoundaryAt, snapshot.lastToolBoundaryAt, "lastToolBoundaryAt must not change");
  });

  it("UserPromptSubmit after window passes through → state switches to thinking", () => {
    bootQwenAfterPostToolUse();
    mock.timers.tick(2500); // outside 2000ms
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "thinking", "real human input must reach state");
  });

  it("PostToolUseFailure also acts as a tool boundary (defensive — qwen 0.16.1 does not emit it, but other agents do)", () => {
    update(api, { id: "qsid", state: "working", event: "PreToolUse", agentId: "qwen-code" });
    update(api, { id: "qsid", state: "working", event: "PostToolUseFailure", agentId: "qwen-code" });
    const before = api.sessions.get("qsid");
    assert.ok(Number.isFinite(before.lastToolBoundaryAt), "PostToolUseFailure should bump lastToolBoundaryAt");

    mock.timers.tick(1500);
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "working", "self-submit dropped after PostToolUseFailure");
  });

  it("Stop after tool boundary → next UserPromptSubmit passes through even within window", () => {
    // Codex review caught this: end-of-turn must reset the self-submit window,
    // otherwise a user typing "继续" within 2s of Stop would be eaten as a
    // false self-submit. Stop bumps lastStopAt, which beats lastToolBoundaryAt.
    bootQwenAfterPostToolUse();
    mock.timers.tick(800); // simulate qwen Stop landing after the loop settles
    update(api, { id: "qsid", state: "attention", event: "Stop", agentId: "qwen-code" });
    const afterStop = api.sessions.get("qsid");
    assert.ok(Number.isFinite(afterStop.lastStopAt), "Stop should bump lastStopAt");
    assert.ok(afterStop.lastStopAt >= afterStop.lastToolBoundaryAt, "Stop must land after tool boundary");

    mock.timers.tick(500); // user types fast — 500ms after Stop, still inside the tool-boundary window
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "thinking", "real input after Stop must reach state");
  });

  it("non-qwen agents are not filtered", () => {
    update(api, { id: "csid", state: "working", event: "PreToolUse", agentId: "claude-code" });
    update(api, { id: "csid", state: "working", event: "PostToolUse", agentId: "claude-code" });
    mock.timers.tick(500); // well within the qwen window
    update(api, { id: "csid", state: "thinking", event: "UserPromptSubmit", agentId: "claude-code" });

    const after = api.sessions.get("csid");
    assert.strictEqual(after.state, "thinking", "claude-code must pass through normally");
  });

  it("kill switch CLAWD_QWEN_SELF_SUBMIT_FILTER=0 disables the filter", () => {
    process.env.CLAWD_QWEN_SELF_SUBMIT_FILTER = "0";
    bootQwenAfterPostToolUse();
    mock.timers.tick(500);
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "thinking", "filter disabled — UserPromptSubmit must take effect");
  });

  it("UserPromptSubmit with no prior boundary passes through (cold session)", () => {
    // Brand new qwen session, no PostToolUse yet — first UserPromptSubmit is
    // always real human input, must reach state.
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });
    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "thinking", "no boundary → cannot be a self-submit");
  });

  it("CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS override widens the window", () => {
    process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS = "5000";
    bootQwenAfterPostToolUse();
    mock.timers.tick(3500); // would pass with default 2000 window, but env override extends to 5000
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "working", "extended window must still drop self-submit");
  });

  it("CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS invalid value falls back to default 2000ms", () => {
    process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS = "not-a-number";
    bootQwenAfterPostToolUse();
    mock.timers.tick(1500); // within default 2000ms
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "working", "invalid env must fall back to default and still drop");
  });

  it("CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS out-of-range value falls back to default", () => {
    process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS = "999999"; // above max 10000
    bootQwenAfterPostToolUse();
    mock.timers.tick(3000); // outside default 2000ms window
    update(api, { id: "qsid", state: "thinking", event: "UserPromptSubmit", agentId: "qwen-code" });

    const after = api.sessions.get("qsid");
    assert.strictEqual(after.state, "thinking", "out-of-range env must fall back to default 2000ms (not honored)");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Antigravity 1.0.6 can emit a trailing PostToolUse after Stop. Once Stop has
// marked the session awaiting input, that stale tool boundary must not resurrect
// the mascot into a stuck typing/working state.
// ═════════════════════════════════════════════════════════════════════════════

describe("antigravity trailing PostToolUse filter", () => {
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

  function finishAntigravityTurn() {
    update(api, { id: "agid", state: "thinking", event: "UserPromptSubmit", agentId: "antigravity-cli" });
    mock.timers.tick(100);
    update(api, { id: "agid", state: "working", event: "PostToolUse", agentId: "antigravity-cli" });
    mock.timers.tick(100);
    update(api, { id: "agid", state: "idle", event: "AfterAgent", agentId: "antigravity-cli" });
    mock.timers.tick(100);
    update(api, { id: "agid", state: "attention", event: "Stop", agentId: "antigravity-cli" });
    const afterStop = api.sessions.get("agid");
    assert.ok(afterStop, "Antigravity session should exist after Stop");
    assert.strictEqual(afterStop.state, "idle");
    assert.strictEqual(afterStop.awaitingInputSinceStop, true);
    assert.ok(Number.isFinite(afterStop.lastStopAt), "Stop should bump lastStopAt");
    return afterStop;
  }

  it("drops PostToolUse that arrives after a fully-idle Stop", () => {
    const before = finishAntigravityTurn();
    const snapshot = {
      state: before.state,
      updatedAt: before.updatedAt,
      recentEvents: [...(before.recentEvents || [])],
      lastToolBoundaryAt: before.lastToolBoundaryAt,
      lastStopAt: before.lastStopAt,
    };

    mock.timers.tick(1200);
    update(api, { id: "agid", state: "working", event: "PostToolUse", agentId: "antigravity-cli" });

    const after = api.sessions.get("agid");
    assert.strictEqual(after.state, "idle", "stale PostToolUse must not resurrect working");
    assert.strictEqual(after.updatedAt, snapshot.updatedAt, "dropped event must not bump updatedAt");
    assert.deepStrictEqual(after.recentEvents, snapshot.recentEvents, "dropped event must not append history");
    assert.strictEqual(after.lastToolBoundaryAt, snapshot.lastToolBoundaryAt, "dropped event must not refresh tool boundary");
    assert.strictEqual(after.lastStopAt, snapshot.lastStopAt, "dropped event must preserve Stop timestamp");
  });

  it("allows PostToolUse after a new user prompt starts the next turn", () => {
    finishAntigravityTurn();

    mock.timers.tick(500);
    update(api, { id: "agid", state: "thinking", event: "UserPromptSubmit", agentId: "antigravity-cli" });
    mock.timers.tick(100);
    update(api, { id: "agid", state: "working", event: "PostToolUse", agentId: "antigravity-cli" });

    const after = api.sessions.get("agid");
    assert.strictEqual(after.state, "working");
    assert.strictEqual(after.awaitingInputSinceStop, false);
    assert.ok(after.lastToolBoundaryAt > after.lastStopAt, "new turn should refresh tool boundary after Stop");
  });
});
