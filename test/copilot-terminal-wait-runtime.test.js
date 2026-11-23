"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { buildStateBody } = require("../hooks/copilot-hook");
const { handleStatePost } = require("../src/server-route-state");
const createAgentRuntime = require("../src/agent-runtime-main");
const themeLoader = require("../src/theme-loader");
const { resolveSessionIdentity } = require("../src/session-key");
const { buildSessionSnapshotEntry } = require("../src/state-session-snapshot");
const { MAX_PENDING_AGE_MS } = require("../src/copilot-terminal-wait");

// Exercise hook, route, runtime and display owners without opening a socket.
function harness(t, { remote = false, wsl = false, headless = false, miniMode = false } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  themeLoader.init(path.resolve(__dirname, "../src"));
  const theme = themeLoader.loadTheme("clawd");
  const renderer = [];
  const sounds = [];
  const snapshots = [];
  const kiroPending = new Set();
  let runtime;
  let alive = true;
  const noop = () => {};
  const ctx = {
    lang: "en", theme, miniMode, doNotDisturb: false, pendingPermissions: [],
    isAgentNotificationHookEnabled: () => true,
    sendToRenderer: (...args) => renderer.push(args), syncHitWin: noop, sendToHitWin: noop,
    miniPeekIn: noop, miniPeekOut: noop, buildContextMenu: noop, buildTrayMenu: noop,
    playSound: name => sounds.push(name), broadcastSessionSnapshot: value => snapshots.push(value),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), t: key => key,
    processKill() {
      if (!alive) { const error = new Error("exited"); error.code = "ESRCH"; throw error; }
    },
    getKiroDesktopPendingSessionIds: () => kiroPending,
    getCopilotTerminalWaitSessionIds: () => runtime?.getCopilotTerminalWaitSessionIds() || new Set(),
    onSessionDeleted(id) {
      runtime?.clearKiroDesktopSession(id);
      runtime?.clearCopilotTerminalWaitSession(id);
    },
  };
  const state = require("../src/state")(ctx);
  runtime = createAgentRuntime({ getStateRuntime: () => state, updateSession: (...args) => state.updateSession(...args) });
  t.after(() => { runtime.cleanup(); state.cleanup(); });
  const profileId = remote ? "ssh-box" : "local";
  const sessionId = resolveSessionIdentity("copilot-session", profileId).sessionId;
  const routeCtx = {
    STATE_SVGS: { idle: "x.svg", working: "x.svg", thinking: "x.svg", notification: "x.svg", error: "x.svg", attention: "x.svg", sleeping: "x.svg", juggling: "x.svg", sweeping: "x.svg" },
    sessions: state.sessions, pendingPermissions: ctx.pendingPermissions, isAgentEnabled: () => true,
    setState: (...args) => state.setState(...args),
    updateSession: (...args) => runtime.updateSessionFromServer(...args),
    resolvePermissionEntry: () => assert.fail("terminal wait must not decide a permission"),
  };
  function send(event, payload = {}) {
    const body = buildStateBody(event, {
      sessionId: "copilot-session", sessionTitle: "Copilot", timestamp: 100,
      notificationType: "permission_prompt", ...payload,
    }, () => ({ stablePid: 42, agentPid: 42, pidChain: [42] }));
    if (remote) body.host = "windows-box";
    if (wsl) { body.platform = "wsl"; body.wsl_distro = "Ubuntu"; }
    if (headless) body.headless = true;
    post(body);
  }
  function post(body) {
    const req = new EventEmitter();
    req.headers = {};
    let status;
    handleStatePost(req, { writeHead(code) { status = code; }, end: noop }, {
      ctx: routeCtx, shouldDropForDnd: () => ctx.doNotDisturb, codexOfficialTurns: new Map(),
      createRequestHookRecorder: () => ({ acceptedUnlessDnd: noop, droppedInvalidAgent: noop, droppedByDisabled: noop, droppedByDnd: noop, droppedUnsupported: noop }),
      ...(remote ? { remoteProfile: { profileId, displayHost: "windows-box" } } : {}),
    });
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
    assert.equal(status, 200);
  }
  return {
    state, runtime, ctx, theme, sounds, renderer, snapshots, sessionId, send, post, kiroPending,
    snapshot: () => state.buildSessionSnapshot().sessions.find(entry => entry.id === sessionId),
    waiting: () => runtime.getCopilotTerminalWaitSessionIds().has(sessionId),
    tick: ms => t.mock.timers.tick(ms),
    exit() { alive = false; },
  };
}

const pathPrompt = (name = "a.png", timestamp = 100) => ({ message: `Path permission needed: D:\\images\\${name}`, timestamp });
const viewResult = (name = "a.png", timestamp = 200) => ({ toolName: "view", toolArgs: { path: `D:\\images\\${name}` }, timestamp });

for (const event of ["postToolUse", "postToolUseFailure"]) {
  test(`copilot: unrelated tools keep waiting until matching ${event} restores working`, t => {
    const h = harness(t);
    h.send("notification", pathPrompt());
    assert.equal(h.state.getCurrentState(), "notification");
    h.tick(h.theme.timings.autoReturn.notification + 1);
    h.send("postToolUse", viewResult("other.png"));
    assert.equal(h.waiting(), true);
    assert.equal(h.snapshot().pendingAttention, true);
    assert.equal(h.state.resolveDisplayState(), "notification");
    h.renderer.length = 0;
    h.send(event, viewResult());
    assert.equal(h.waiting(), false);
    assert.equal(h.snapshot().pendingAttention, false);
    h.tick(h.theme.timings.minDisplay.notification + 1);
    assert.equal(h.state.getCurrentState(), "working");
    assert.equal(h.renderer.some(([channel, value]) => channel === "state-change" && value === "idle"), false);
    assert.equal(h.runtime.getKiroDesktopPendingSessionIds().size, 0);
  });
}

test("copilot: same-key requests resolve one at a time", t => {
  const h = harness(t);
  h.send("notification", pathPrompt("a.png", 100));
  h.send("notification", pathPrompt("a.png", 300));
  h.send("postToolUse", viewResult("a.png", 200));
  assert.equal(h.waiting(), true);
  h.send("postToolUse", viewResult("a.png", 400));
  assert.equal(h.waiting(), false);
});

test("copilot: an early completion consumes its late notification only once", t => {
  const h = harness(t);
  h.send("postToolUse", viewResult("a.png", 200));
  h.send("notification", pathPrompt("a.png", 100));
  assert.equal(h.waiting(), false);
  h.send("notification", pathPrompt("a.png", 300));
  assert.equal(h.waiting(), true);
});

test("copilot: late notices behind the latest prompt boundary cannot reopen waiting", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.send("userPromptSubmitted", { timestamp: 300 });
  h.send("notification", pathPrompt("a.png", 100));
  assert.equal(h.waiting(), false);
  assert.equal(h.snapshot().pendingAttention, false);
  h.send("notification", pathPrompt("b.png", 400));
  assert.equal(h.waiting(), true);
});

test("copilot: recoverable errors retain pending attention and the waiting pose", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.tick(h.theme.timings.autoReturn.notification + 1);
  h.send("errorOccurred");
  assert.equal(h.waiting(), true);
  assert.equal(h.snapshot().pendingAttention, true);
  assert.equal(h.state.resolveDisplayState(), "notification");
  assert.equal(h.state.getCurrentState(), "notification");
  h.tick(h.theme.timings.minDisplay.notification + 1);
  assert.equal(h.state.getCurrentState(), "notification");
});

for (const options of [{}, { remote: true }, { wsl: true }]) {
  test(`copilot: terminal wait projects a visible HUD approval for ${JSON.stringify(options)}`, t => {
    const h = harness(t, options);
    h.send("notification", { message: "Information requested", notificationType: "elicitation_dialog" });
    assert.equal(h.state.sessions.get(h.sessionId).state, "idle");
    assert.equal(h.snapshot().effectiveState, "notification");
    assert.equal(h.snapshot().pendingAttention, true);
    assert.equal(h.snapshot().hiddenFromHud, false);
    assert.equal(h.snapshot().activeSubagentCount, 0);
    assert.equal(h.state.getCurrentState(), "notification");
    h.send("postToolUse", { toolName: "ask_user", toolArgs: { answer: "yes" }, timestamp: 200 });
    assert.equal(h.snapshot().pendingAttention, false);
  });
}

test("copilot: headless sessions do not project waiting or a HUD approval", t => {
  const h = harness(t, { headless: true });
  h.send("notification", pathPrompt());
  assert.equal(h.waiting(), true);
  assert.notEqual(h.snapshot().pendingAttention, true);
  assert.notEqual(h.state.resolveDisplayState(), "notification");
});

test("copilot: remote Kiro and Codex retain local-only presentation boundaries", t => {
  const h = harness(t);
  for (const agentId of ["kiro-desktop", "codex"]) {
    const id = resolveSessionIdentity(agentId, "ssh-box").sessionId;
    const session = { agentId, host: "box", profileId: "ssh-box", state: "working", updatedAt: Date.now() };
    h.state.sessions.set(id, session);
    h.kiroPending.add(id);
    h.ctx.pendingPermissions.push({ agentId: "codex", sessionId: id, isCodexNotify: true, host: "box", profileId: "ssh-box" });
    assert.equal(h.state.resolveDisplayState(), "working");
    const entry = buildSessionSnapshotEntry(id, session, {}, {
      getSessionPresentation: () => ({ pendingAttention: true, activeSubagentCount: 5, effectiveState: "juggling" }),
    });
    assert.equal("pendingAttention" in entry, false);
    assert.equal("effectiveState" in entry, false);
    assert.equal("activeSubagentCount" in entry, false);
  }
});

test("copilot: committed notification switch hides and restores a wait without losing it to stale cleanup", async t => {
  const h = harness(t, { remote: true });
  const { createSettingsController } = require("../src/settings-controller");
  const createRouter = require("../src/settings-effect-router");
  const snapshot = require("../src/prefs").getDefaults();
  Object.assign(snapshot.agents["copilot-cli"], { enabled: true, integrationInstalled: true });
  const controller = createSettingsController({ loadResult: { snapshot, locked: false } });
  h.ctx.isAgentNotificationHookEnabled = id => controller.getSnapshot().agents[id].notificationHookEnabled;
  const router = createRouter({ settingsController: controller, refreshPendingAttention: () => h.state.refreshPendingAttention() });
  router.start();
  t.after(() => router.dispose());
  h.send("notification", pathPrompt());
  h.tick(h.theme.timings.minDisplay.notification + 1);
  await controller.applyCommand("setAgentFlag", { agentId: "copilot-cli", flag: "notificationHookEnabled", value: false });
  assert.equal(h.snapshot().pendingAttention, false);
  assert.equal(h.state.resolveDisplayState(), "idle");
  h.tick(15 * 60 * 1000);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.has(h.sessionId), true);
  assert.equal(h.waiting(), true);
  await controller.applyCommand("setAgentFlag", { agentId: "copilot-cli", flag: "notificationHookEnabled", value: true });
  assert.equal(h.snapshot().pendingAttention, true);
  assert.equal(h.state.getCurrentState(), "notification");
});

test("copilot: a notification received while alerts are disabled is recorded for restoration", t => {
  const h = harness(t);
  h.ctx.isAgentNotificationHookEnabled = () => false;
  h.send("notification", pathPrompt());
  assert.equal(h.waiting(), true);
  assert.equal(h.snapshot().pendingAttention, false);
  assert.deepEqual(h.sounds, []);
  h.ctx.isAgentNotificationHookEnabled = () => true;
  h.state.refreshPendingAttention();
  assert.equal(h.state.getCurrentState(), "notification");
  assert.deepEqual(h.sounds, []);
});

for (const miniMode of [false, true]) {
  test(`copilot: sustained waiting does not ring on animation reselection with mini mode ${miniMode}`, t => {
    const h = harness(t, { miniMode });
    h.send("notification", pathPrompt());
    const autoReturn = h.theme.timings.autoReturn[miniMode ? "mini-alert" : "notification"];
    const expectedState = miniMode ? "mini-alert" : "notification";
    assert.deepEqual(h.sounds, ["confirm"]);
    for (let i = 0; i < 3; i++) {
      h.tick(autoReturn + 1);
      assert.equal(h.state.getCurrentState(), expectedState);
      assert.deepEqual(h.sounds, ["confirm"]);
    }
    h.send("postToolUse", viewResult());
    h.tick(autoReturn + 1);
    h.send("notification", pathPrompt("b.png", 300));
    h.tick(h.theme.timings.minDisplay.working + 1);
    assert.deepEqual(h.sounds, ["confirm", "confirm"], "a fresh notification may ring again");
  });
}

for (const miniMode of [false, true]) {
  test(`copilot: DND suppresses the pose and restores waiting with mini mode ${miniMode}`, t => {
    const h = harness(t, { miniMode });
    h.send("notification", pathPrompt());
    h.state.enableDoNotDisturb();
    assert.equal(h.waiting(), true);
    assert.notEqual(h.state.getCurrentState(), miniMode ? "mini-alert" : "notification");
    h.tick(15000);
    h.state.disableDoNotDisturb();
    h.tick(h.theme.timings.wakeDuration + 1);
    assert.equal(h.state.getCurrentState(), miniMode ? "mini-alert" : "notification");
    assert.deepEqual(h.sounds, ["confirm"]);
  });
}

test("copilot: two-hour expiry resumes ordinary stale cleanup", t => {
  const h = harness(t, { remote: true });
  h.send("notification", pathPrompt());
  t.mock.timers.setTime(Date.now() + MAX_PENDING_AGE_MS);
  h.state.cleanStaleSessions();
  assert.equal(h.state.sessions.has(h.sessionId), true);
  assert.equal(h.waiting(), true);
  t.mock.timers.setTime(Date.now() + 1);
  h.state.cleanStaleSessions();
  assert.equal(h.waiting(), false);
  assert.equal(h.state.sessions.has(h.sessionId), false);
});

for (const deletion of ["process-exit", "clear-agent", "cleanup"]) {
  test(`copilot: ${deletion} clears the ledger`, t => {
    const h = harness(t);
    h.send("notification", pathPrompt());
    if (deletion === "process-exit") { h.exit(); h.state.cleanStaleSessions(); }
    if (deletion === "clear-agent") h.state.clearSessionsByAgent("copilot-cli");
    if (deletion === "cleanup") h.runtime.cleanup();
    assert.equal(h.waiting(), false);
  });
}

test("copilot: command approvals retain the one-shot notification behavior", t => {
  const h = harness(t);
  h.send("notification", { message: "Run command: sleep 3600" });
  assert.equal(h.state.getCurrentState(), "notification");
  assert.equal(h.waiting(), false);
  assert.equal(h.snapshot().pendingAttention, false);
  h.tick(h.theme.timings.autoReturn.notification + 1);
  assert.equal(h.state.getCurrentState(), "idle");
  assert.deepEqual(h.sounds, ["confirm"]);
});

test("copilot: seven-image replay retains the two unanswered paths after five sibling completions", t => {
  const h = harness(t, { remote: true });
  h.send("userPromptSubmitted", { timestamp: 1793951680000 });
  h.tick(h.theme.timings.minDisplay.thinking + 1);
  for (const name of ["six.png", "seven.png"]) h.send("notification", pathPrompt(name, 1793951681385));
  for (const name of ["one.png", "two.png", "three.png", "four.png", "five.png"]) {
    h.send("postToolUse", viewResult(name, 1793951682000));
    assert.equal(h.waiting(), true);
    assert.equal(h.snapshot().pendingAttention, true);
    assert.equal(h.state.getCurrentState(), "notification");
  }
  h.send("postToolUse", viewResult("six.png", 1793951683000));
  assert.equal(h.waiting(), true);
  h.send("postToolUse", viewResult("seven.png", 1793951684000));
  assert.equal(h.waiting(), false);
  h.tick(h.theme.timings.minDisplay.notification + 1);
  assert.equal(h.state.getCurrentState(), "working");
});

test("copilot: rejection replay keeps waiting through a silent abort until the next prompt", t => {
  const h = harness(t, { remote: true });
  h.send("notification", pathPrompt("rejected.png", 1793951681385));
  // permission.completed, tool.execution_complete, assistant.turn_end and abort
  // produce no hooks after a native rejection. Time alone must retain the wait.
  h.tick(15 * 60 * 1000);
  h.state.cleanStaleSessions();
  assert.equal(h.waiting(), true);
  assert.equal(h.state.getCurrentState(), "notification");
  assert.equal(h.snapshot().pendingAttention, true);
  h.send("userPromptSubmitted", { timestamp: 1793952581385 });
  assert.equal(h.waiting(), false);
  assert.equal(h.snapshot().pendingAttention, false);
  h.tick(h.theme.timings.minDisplay.notification + 1);
  assert.equal(h.state.getCurrentState(), "thinking");
});

test("copilot: compaction cannot replace an unresolved terminal wait", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.tick(h.theme.timings.autoReturn.notification + 1);
  h.send("preCompact");
  h.tick(h.theme.timings.minDisplay.notification + 1);
  assert.equal(h.state.getCurrentState(), "notification");
  assert.equal(h.waiting(), true);
});

test("copilot: a pending terminal wait preserves real permission notification sound", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.state.updateSession("claude-session", "notification", "PermissionRequest", { agentId: "claude-code" });
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
});

test("copilot: a pending terminal wait preserves Claude elicitation notification sound", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.state.updateSession("claude-session", "notification", "Elicitation", { agentId: "claude-code" });
  assert.equal(h.waiting(), true);
  assert.equal(h.state.getCurrentState(), "notification");
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
});

test("copilot: main forwards wait getters, combined deletion cleanup and committed refresh", () => {
  const main = require("node:fs").readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8");
  assert.match(main, /getCopilotTerminalWaitSessionIds: \(\) => agentRuntime\?\.getCopilotTerminalWaitSessionIds\(\)/);
  assert.match(main, /onSessionDeleted: \(sessionId\) => \{\s*agentRuntime\?\.clearKiroDesktopSession\(sessionId\);\s*agentRuntime\?\.clearCopilotTerminalWaitSession\(sessionId\);\s*(?:claudeTurnAskReminder\.resolve\(sessionId\);\s*)?\}/);
  assert.match(main, /refreshPendingAttention: \(\) => _state\.refreshPendingAttention\(\)/);
  assert.match(main, /hasPendingReminderAttention: \(\) => _state\.hasPendingReminderAttention\(\)/);
  assert.match(main, /getReminderReselectionOptions: \(state\) => _state\.getReminderReselectionOptions\(state\)/);
});


for (const miniMode of [false, true]) {
  for (const sameSession of [false, true]) {
    test(`copilot: another notification rings once without restarting the waiting pose with mini mode ${miniMode} and same session ${sameSession}`, t => {
      const h = harness(t, { miniMode });
      h.send("notification", pathPrompt());
      const revision = h.state.getDisplayRevision();
      h.send("notification", { ...pathPrompt("b.png", 300), ...(sameSession ? {} : { sessionId: "another-copilot" }) });
      assert.equal(h.waiting(), true);
      assert.equal(h.state.getDisplayRevision(), revision);
      assert.deepEqual(h.sounds, ["confirm", "confirm"]);
      h.tick(h.theme.timings.autoReturn[miniMode ? "mini-alert" : "notification"] + 1);
      assert.deepEqual(h.sounds, ["confirm", "confirm"]);
    });
  }
}

test("copilot: a Claude notification with SVG rings once through the state route during a terminal wait", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.post({ agent_id: "claude-code", session_id: "claude-svg", state: "notification", event: "Notification", svg: h.state.getCurrentSvg() });
  assert.equal(h.waiting(), true);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
  h.tick(h.theme.timings.autoReturn.notification + 1);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
});

test("copilot: newly pending Codex attention rings once during a terminal wait", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.ctx.pendingPermissions.push({ agentId: "codex", sessionId: "codex-session", isCodexNotify: true });
  h.state.refreshPendingAttention();
  assert.equal(h.waiting(), true);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
  h.state.refreshPendingAttention();
  h.tick(h.theme.timings.autoReturn.notification + 1);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
});

test("copilot: a quick mini-mode answer resumes working without replaying the old alert", t => {
  const h = harness(t, { miniMode: true });
  h.send("notification", pathPrompt());
  h.tick(1000);
  h.send("postToolUse", viewResult());
  assert.equal(h.waiting(), false);
  h.tick(h.theme.timings.autoReturn["mini-alert"] - 1000 + 1);
  assert.equal(h.state.getCurrentState(), "mini-working");
  assert.deepEqual(h.sounds, ["confirm"]);
  h.tick(6001);
  assert.equal(h.state.getCurrentState(), "mini-working");
  assert.deepEqual(h.sounds, ["confirm"]);
});

for (const event of ["postToolUse", "errorOccurred", "preCompact"]) {
  test(`copilot: queued notification keeps its first bell after unrelated ${event}`, t => {
    const h = harness(t);
    h.send("preToolUse");
    h.send("notification", pathPrompt());
    h.send(event, viewResult("b.png"));
    assert.deepEqual(h.sounds, []);
    h.tick(h.theme.timings.minDisplay.working + 1);
    assert.equal(h.waiting(), true);
    assert.equal(h.state.getCurrentState(), "notification");
    assert.deepEqual(h.sounds, ["confirm"]);
    h.tick(h.theme.timings.autoReturn.notification + 1);
    assert.deepEqual(h.sounds, ["confirm"]);
  });
}

test("copilot: a late old stop preserves a wait from the newer prompt", t => {
  const h = harness(t);
  h.send("userPromptSubmitted", { timestamp: 300 });
  h.send("notification", pathPrompt("new.png", 400));
  h.send("agentStop", { timestamp: 200 });
  assert.equal(h.waiting(), true);
  assert.equal(h.snapshot().pendingAttention, true);
});

test("copilot: entering and leaving mini mode restores the waiting pose without another bell", t => {
  const h = harness(t);
  const electronPath = require.resolve("electron");
  const miniPath = require.resolve("../src/mini");
  const previousElectron = require.cache[electronPath];
  const previousMini = require.cache[miniPath];
  const display = { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { screen: { getAllDisplays: () => [display] } } };
  delete require.cache[miniPath];
  const initMini = require("../src/mini");
  if (previousElectron) require.cache[electronPath] = previousElectron;
  else delete require.cache[electronPath];
  if (previousMini) require.cache[miniPath] = previousMini;
  else delete require.cache[miniPath];
  const bounds = { x: 600, y: 180, width: 120, height: 120 };
  const noop = () => {};
  const { probeAssetCycle } = require("../src/animation-cycle");
  const cycle = file => probeAssetCycle(path.resolve(__dirname, "../assets/svg", file)).ms;
  const mini = initMini({
    theme: h.theme,
    get currentState() { return h.state.getCurrentState(); },
    get doNotDisturb() { return h.ctx.doNotDisturb; },
    win: { isDestroyed: () => false },
    currentSize: "m", SIZES: { m: { width: 120, height: 120 } },
    getCurrentPixelSize: () => ({ width: 120, height: 120 }),
    getPetWindowBounds: () => ({ ...bounds }),
    applyPetWindowBounds(next) { Object.assign(bounds, next); return { ...bounds }; },
    stopWakePoll: noop, sendToRenderer: noop, sendToHitWin: noop,
    buildContextMenu: noop, buildTrayMenu: noop, syncHitWin: noop,
    getAnimationAssetCycleMs: cycle,
    resolveDisplayState: () => h.state.resolveDisplayState(),
    getSvgOverride: state => h.state.getSvgOverride(state),
    clampToScreenVisual: (x, y) => ({ x, y }),
    getNearestWorkArea: () => display.workArea,
    hasPendingReminderAttention: () => h.state.hasPendingReminderAttention?.() === true,
    getReminderReselectionOptions: state => h.state.getReminderReselectionOptions?.(state) || {},
    applyState: (...args) => h.state.applyState(...args),
  });
  Object.defineProperties(h.ctx, {
    miniMode: { get: () => mini.getMiniMode() },
    miniTransitioning: { get: () => mini.getMiniTransitioning() },
  });
  t.after(() => mini.cleanup());
  h.send("notification", pathPrompt());
  mini.enterMiniMode(display.workArea, false, "right");
  h.tick(120);
  const enterFile = h.theme.miniMode.states["mini-enter"][0];
  h.tick(cycle(enterFile) + 1);
  assert.equal(mini.getMiniTransitioning(), false);
  assert.equal(h.waiting(), true);
  assert.equal(h.state.getCurrentState(), "mini-alert");
  assert.deepEqual(h.sounds, ["confirm"]);
  h.tick(h.theme.timings.autoReturn["mini-alert"] + 1);
  assert.equal(h.state.getCurrentState(), "mini-alert");
  assert.deepEqual(h.sounds, ["confirm"]);
  mini.exitMiniMode();
  h.tick(400);
  assert.equal(mini.getMiniMode(), false);
  assert.equal(h.state.getCurrentState(), "notification");
  assert.deepEqual(h.sounds, ["confirm"]);
});


for (const miniMode of [false, true]) {
  test(`copilot: same-pose cues retain sound suppression with mini mode ${miniMode}`, t => {
    const h = harness(t, { miniMode });
    h.send("notification", pathPrompt());
    h.state.updateSession("codex-session", "notification", "PermissionRequest", { agentId: "codex", muteNotificationSound: true });
    assert.deepEqual(h.sounds, ["confirm"]);
    h.ctx.doNotDisturb = true;
    h.state.updateSession("claude-session", "notification", "Elicitation", { agentId: "claude-code" });
    assert.deepEqual(h.sounds, ["confirm"]);
    h.ctx.doNotDisturb = false;
    h.ctx.isOneshotDisabled = state => state === "notification";
    h.state.updateSession("claude-session", "notification", "Elicitation", { agentId: "claude-code" });
    assert.deepEqual(h.sounds, ["confirm"]);
  });
}

test("copilot: a Kimi heuristic promotion rings once during a terminal wait", t => {
  const previous = process.env.CLAWD_KIMI_PERMISSION_SUSPECT_MS;
  process.env.CLAWD_KIMI_PERMISSION_SUSPECT_MS = "1500";
  t.after(() => {
    if (previous === undefined) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT_MS;
    else process.env.CLAWD_KIMI_PERMISSION_SUSPECT_MS = previous;
  });
  const h = harness(t);
  h.send("notification", pathPrompt());
  h.state.updateSession("kimi-session", "working", "PreToolUse", { agentId: "kimi-cli", permissionSuspect: true });
  h.tick(1501);
  assert.equal(h.waiting(), true);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
  h.tick(h.theme.timings.autoReturn.notification + 1);
  assert.deepEqual(h.sounds, ["confirm", "confirm"]);
});


for (const miniMode of [false, true]) {
  test(`copilot: resolving a Claude permission keeps the existing wait quiet with mini mode ${miniMode}`, t => {
    const h = harness(t, { miniMode });
    h.send("notification", pathPrompt());
    h.state.updateSession("claude-session", "notification", "PermissionRequest", { agentId: "claude-code" });
    assert.deepEqual(h.sounds, ["confirm", "confirm"]);
    h.state.clearPermissionNotification("claude-session", { behavior: "deny" });
    assert.equal(h.waiting(), true);
    assert.equal(h.state.getCurrentState(), miniMode ? "mini-alert" : "notification");
    assert.deepEqual(h.sounds, ["confirm", "confirm"]);
    h.tick(h.theme.timings.autoReturn[miniMode ? "mini-alert" : "notification"] + 1);
    assert.deepEqual(h.sounds, ["confirm", "confirm"]);
  });
}

test("copilot: a Kimi cue during a terminal wait still rearms the permission animation timer", t => {
  const h = harness(t);
  h.send("notification", pathPrompt());
  for (const permissionGateId of ["gate-one", "gate-two"]) {
    h.tick(1000);
    h.state.updateSession("kimi-session", "notification", "PermissionRequest", {
      agentId: "kimi-cli", permissionGateOpen: true, permissionGateId,
    });
  }
  assert.deepEqual(h.sounds, ["confirm", "confirm", "confirm"]);
  const revision = h.state.getDisplayRevision();
  h.tick(h.theme.timings.autoReturn.notification - 1);
  assert.equal(h.state.getDisplayRevision(), revision);
  h.tick(1);
  assert.equal(h.state.getDisplayRevision(), revision + 1);
  assert.deepEqual(h.sounds, ["confirm", "confirm", "confirm"]);
});
