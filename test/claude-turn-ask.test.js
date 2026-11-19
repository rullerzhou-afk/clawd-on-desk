"use strict";

// #1326: Claude Desktop's end-of-turn question box (mcp__ccd_turn__wrap_up)
// surfaced as a read-only native-question card.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  CLAUDE_WRAP_UP_TOOL_NAME,
  normalizeClaudeTurnAsk,
  decideClaudeTurnAskAction,
  MAX_ASK_CHARS,
  MAX_ACTIONS,
  MAX_ACTION_LABEL_CHARS,
} = require("../src/claude-turn-ask");
const { buildStateBody, buildClaudeTurnAsk } = require("../hooks/clawd-hook");
const { handleStatePost } = require("../src/server-route-state");
const { isPassiveNotifyEntry, isNativeQuestionNotify } = require("../src/passive-notify-entry");
const { makeSessionKey } = require("../src/session-key");

const WRAP_UP_INPUT = {
  recap: "Ran the suite; two tests fail in the parser.",
  ask: "Fix the parser now?",
  actions: [
    { label: "Fix it", message: "Fix the two failing parser tests." },
    { label: "Not now" },
  ],
};

describe("normalizeClaudeTurnAsk", () => {
  it("keeps only the ask and labelled actions", () => {
    assert.deepStrictEqual(normalizeClaudeTurnAsk(WRAP_UP_INPUT), {
      ask: "Fix the parser now?",
      actions: [{ label: "Fix it" }, { label: "Not now" }],
    });
  });

  it("returns null without an ask (a recap-only box asks nothing)", () => {
    assert.strictEqual(normalizeClaudeTurnAsk({ recap: "done" }), null);
    assert.strictEqual(normalizeClaudeTurnAsk({ ask: "   " }), null);
    assert.strictEqual(normalizeClaudeTurnAsk(null), null);
    assert.strictEqual(normalizeClaudeTurnAsk(["ask"]), null);
  });

  it("caps untrusted fields and drops malformed actions", () => {
    const result = normalizeClaudeTurnAsk({
      ask: "q".repeat(MAX_ASK_CHARS + 50),
      actions: [
        null,
        { label: "" },
        { label: 42 },
        ...Array.from({ length: MAX_ACTIONS + 3 }, (_, i) => ({ label: `opt ${i}` })),
      ],
    });
    assert.strictEqual(result.ask.length, MAX_ASK_CHARS);
    assert.ok(result.ask.endsWith("…"));
    assert.strictEqual("recap" in result, false);
    // The cap applies to the raw list, so the malformed entries count toward it.
    assert.ok(result.actions.length <= MAX_ACTIONS);
    assert.ok(result.actions.every((action) => Object.keys(action).join() === "label" && action.label));
  });
});

describe("decideClaudeTurnAskAction", () => {
  const decide = (event, extra = {}) => decideClaudeTurnAskAction({ event, ...extra });

  it("shows on a wrap_up with an ask and ignores Stop", () => {
    assert.strictEqual(decide("UserPromptSubmit"), "clear");
    assert.strictEqual(
      decide("PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true }),
      "show"
    );
    assert.strictEqual(decide("Stop"), "ignore", "Stop must never dismiss the card");
  });

  it("clears when Claude moves on, on a recap-only wrap_up, on the next prompt and on SessionEnd", () => {
    assert.strictEqual(decide("PreToolUse", { toolName: "Bash" }), "clear");
    assert.strictEqual(
      decide("PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: false }),
      "clear"
    );
    assert.strictEqual(decide("UserPromptSubmit"), "clear");
    assert.strictEqual(decide("SessionEnd"), "clear");
  });

  it("clears a synthetic main-thread SubagentStart but ignores native and legacy shapes", () => {
    assert.strictEqual(
      decide("SubagentStart", { subagentLifecycleSource: "synthetic-tool" }),
      "clear"
    );
    assert.strictEqual(decide("SubagentStart", { subagentLifecycleSource: "native" }), "ignore");
    assert.strictEqual(decide("SubagentStart", { subagentLifecycleSource: "synthetic-task" }), "ignore");
    assert.strictEqual(decide("SubagentStart", { subagentLifecycleSource: "anonymous" }), "ignore");
    assert.strictEqual(decide("SubagentStart"), "ignore");
  });

  it("ignores unrelated events", () => {
    assert.strictEqual(decide("PostToolUse"), "ignore");
    assert.strictEqual(decide("Notification"), "ignore");
    assert.strictEqual(decide(undefined), "ignore");
  });
});

describe("clawd-hook forwards the wrap_up question", () => {
  const resolve = () => ({ pid: null });

  it("adds claude_turn_ask to a wrap_up PreToolUse body only", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s",
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME,
      tool_use_id: "toolu_wrap",
      tool_input: WRAP_UP_INPUT,
    }, resolve);
    assert.deepStrictEqual(body.claude_turn_ask, {
      ask: "Fix the parser now?",
      actions: [{ label: "Fix it" }, { label: "Not now" }],
    });
    assert.strictEqual(body.tool_name, CLAUDE_WRAP_UP_TOOL_NAME);
  });

  it("does not forward for other tools, recap-only calls, or other events", () => {
    const other = buildStateBody("PreToolUse", {
      session_id: "s", tool_name: "Bash", tool_input: { command: "ls", ask: "x" },
    }, resolve);
    assert.strictEqual(other.claude_turn_ask, undefined);
    const recapOnly = buildStateBody("PreToolUse", {
      session_id: "s", tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_input: { recap: "done" },
    }, resolve);
    assert.strictEqual(recapOnly.claude_turn_ask, undefined);
    const post = buildStateBody("PostToolUse", {
      session_id: "s", tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_input: WRAP_UP_INPUT,
    }, resolve);
    assert.strictEqual(post.claude_turn_ask, undefined);
  });

  it("caps the forwarded fields", () => {
    const result = buildClaudeTurnAsk(CLAUDE_WRAP_UP_TOOL_NAME, {
      ask: "a".repeat(1000),
      recap: "r".repeat(1000),
      actions: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`.repeat(40), message: "m".repeat(1000) })),
    });
    assert.strictEqual(result.ask.length, MAX_ASK_CHARS);
    assert.strictEqual("recap" in result, false);
    assert.ok(result.actions.length <= MAX_ACTIONS);
    assert.ok(result.actions.every((action) => action.label.length === MAX_ACTION_LABEL_CHARS
      && Object.keys(action).join() === "label"));
  });
});

const TEST_STABLE_PID = 4242;
const TEST_AGENT_PID = 4343;
const TEST_CWD = "/repo/claude-wrap-up";

// One ctx shared across requests, like the real server.
function createRouteHarness(overrides = {}) {
  const calls = { shown: [], cleared: [], tracked: [], resolved: [] };
  const ctx = {
    STATE_SVGS: {
      idle: "x.svg", thinking: "x.svg", working: "x.svg", juggling: "x.svg", error: "x.svg",
      attention: "x.svg", notification: "x.svg", sleeping: "x.svg", "mini-idle": "x.svg",
    },
    pendingPermissions: [],
    sessions: new Map(),
    isAgentEnabled: () => true,
    setState: () => {},
    updateSession: () => true,
    updateAccountQuota: () => {},
    resolvePermissionEntry: () => {},
    permLog: () => {},
    showCodexUserInputBubble: () => true,
    clearCodexUserInputBubbles: () => {},
    handleTestResult: () => {},
    showClaudeTurnAskBubble: (input) => { calls.shown.push(input); return true; },
    clearClaudeTurnAskBubbles: (...args) => calls.cleared.push(args),
    trackClaudeTurnAskReminder: (payload) => calls.tracked.push(payload),
    resolveClaudeTurnAskReminder: (sessionId) => calls.resolved.push(sessionId),
    ...overrides,
  };
  const recorder = {
    acceptedUnlessDnd() {}, droppedByDisabled() {}, droppedByDnd() {},
    droppedInvalidAgent() {}, droppedUnsupported() {},
  };
  function postBody(body) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      req.headers = {};
      setImmediate(() => {
        req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
      const res = {
        statusCode: null,
        writeHead(code) { this.statusCode = code; },
        end() { resolve(this); },
      };
      handleStatePost(req, res, {
        ctx,
        createRequestHookRecorder: () => recorder,
        shouldDropForDnd: () => false,
        codexOfficialTurns: new Map(),
      });
    });
  }
  function post(event, payload = {}) {
    return postBody(buildStateBody(event, { session_id: "desk-1", ...payload }, () => ({
      stablePid: TEST_STABLE_PID,
      agentPid: TEST_AGENT_PID,
    })));
  }
  return { calls, post, postBody };
}

const WRAP_UP_PRE = {
  tool_name: CLAUDE_WRAP_UP_TOOL_NAME,
  tool_use_id: "toolu_wrap_1",
  tool_input: WRAP_UP_INPUT,
  cwd: TEST_CWD,
};
const SID = makeSessionKey({ profileId: "local", rawSessionId: "desk-1" });

describe("/state route surfaces Claude Desktop's wrap_up question", () => {
  it("shows the card from a real hook body and keeps it through Stop and post-Stop phantoms", async () => {
    const { calls, post, postBody } = createRouteHarness();
    await post("UserPromptSubmit", { prompt: "review the parser" });
    await post("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", tool_input: { command: "npm test" } });
    const clearsBeforeAsk = calls.cleared.length;

    await post("PreToolUse", WRAP_UP_PRE);
    assert.strictEqual(calls.shown.length, 1);
    assert.deepStrictEqual(calls.shown[0], {
      sessionId: SID,
      toolUseId: "toolu_wrap_1",
      ask: WRAP_UP_INPUT.ask,
      actions: [{ label: "Fix it" }, { label: "Not now" }],
      sourcePid: TEST_STABLE_PID,
      agentPid: TEST_AGENT_PID,
      cwd: TEST_CWD,
      host: null,
    });
    assert.strictEqual(calls.tracked.length, 1, "showing the card starts the reminder");
    assert.deepStrictEqual(calls.tracked[0], calls.shown[0], "the reminder re-shows the same card");

    const resolvedBeforeQuiet = calls.resolved.length;
    await post("Stop", { last_assistant_message: "Two tests fail in the parser." });
    // A prompt-suggestion fork fires PreToolUse for calls that never run; the
    // reported phantoms carry a fresh agent_id, which the hook records as a
    // subagent and this route excludes.
    const phantomTool = buildStateBody("PreToolUse", {
      session_id: "desk-1", tool_name: "AskUserQuestion", tool_use_id: "toolu_phantom",
      agent_id: "phantom-agent",
    }, () => ({ pid: null }));
    const phantomWrap = buildStateBody("PreToolUse", {
      session_id: "desk-1", tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "toolu_phantom_wrap",
      tool_input: { ask: "Phantom question?" }, agent_id: "phantom-agent",
    }, () => ({ pid: null }));
    assert.ok(phantomTool.subagent_id);
    assert.ok(phantomWrap.subagent_id);
    await postBody(phantomTool);
    await postBody(phantomWrap);
    assert.strictEqual(calls.cleared.length, clearsBeforeAsk, "Stop and post-Stop phantoms must not dismiss the card");
    assert.strictEqual(calls.shown.length, 1, "post-Stop phantoms must not re-show the card");
    assert.strictEqual(calls.tracked.length, 1, "Stop and post-Stop phantoms must not restart the reminder");
    assert.strictEqual(calls.resolved.length, resolvedBeforeQuiet, "Stop and post-Stop phantoms must not stop the reminder");

    await post("UserPromptSubmit", { prompt: "Fix the two failing parser tests." });
    assert.strictEqual(calls.cleared.length, clearsBeforeAsk + 1);
    assert.strictEqual(calls.cleared.at(-1)[0], SID);
    assert.strictEqual(calls.resolved.length, resolvedBeforeQuiet + 1);
  });

  it("clears when Claude moves on to another tool in the same turn", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", WRAP_UP_PRE);
    assert.strictEqual(calls.tracked.length, 1);
    const before = calls.cleared.length;
    const resolvedBefore = calls.resolved.length;
    await post("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read" });
    assert.strictEqual(calls.cleared.length, before + 1);
    assert.strictEqual(calls.resolved.length, resolvedBefore + 1);
  });

  it("clears on a recap-only wrap_up and on SessionEnd", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", WRAP_UP_PRE);
    assert.strictEqual(calls.tracked.length, 1);
    let before = calls.cleared.length;
    let resolvedBefore = calls.resolved.length;
    await post("PreToolUse", { tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "toolu_recap", tool_input: { recap: "done" } });
    assert.strictEqual(calls.cleared.length, before + 1);
    assert.strictEqual(calls.resolved.length, resolvedBefore + 1);
    assert.strictEqual(calls.shown.length, 1);
    before = calls.cleared.length;
    resolvedBefore = calls.resolved.length;
    await post("SessionEnd", { reason: "other" });
    assert.strictEqual(calls.cleared.length, before + 1);
    assert.strictEqual(calls.resolved.length, resolvedBefore + 1);
  });

  it("starts the reminder countdown with the card and stops it only when the session moves on", async () => {
    const { calls, post, postBody } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", WRAP_UP_PRE);
    assert.equal(calls.tracked.length, 1);
    assert.deepStrictEqual(calls.tracked[0], calls.shown[0], "the reminder re-shows the same card");
    const resolvedBefore = calls.resolved.length;

    await post("Stop");
    assert.equal(calls.resolved.length, resolvedBefore, "Stop keeps the countdown");

    // The prompt-suggestion phantom carries a fresh agent_id, so the hook
    // records it as a subagent and the route leaves the countdown alone.
    const phantom = buildStateBody("PreToolUse", {
      session_id: "desk-1", tool_name: "AskUserQuestion", tool_use_id: "toolu_phantom",
      agent_id: "phantom-agent",
    }, () => ({ stablePid: TEST_STABLE_PID, agentPid: TEST_AGENT_PID }));
    assert.ok(phantom.subagent_id, "the hook tags the phantom as a subagent");
    await postBody(phantom);
    assert.equal(calls.tracked.length, 1, "the phantom must not restart the countdown");
    assert.equal(calls.resolved.length, resolvedBefore, "the phantom must not stop the countdown");

    await post("UserPromptSubmit", { prompt: "继续" });
    assert.deepStrictEqual(calls.resolved.slice(resolvedBefore), [SID]);
  });

  it("ignores wrap_up from a subagent", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", { ...WRAP_UP_PRE, agent_id: "sub-1", agent_type: "general-purpose" });
    assert.strictEqual(calls.shown.length, 0);
    assert.strictEqual(calls.tracked.length, 0);
    assert.deepStrictEqual(calls.resolved, [SID]);
  });
});

describe("Claude wrap_up question marks the HUD row like Codex questions", () => {
  const path = require("node:path");
  const themeLoader = require("../src/theme-loader");

  function makeState(overrides = {}) {
    themeLoader.init(path.join(__dirname, "..", "src"));
    const theme = structuredClone(themeLoader.loadTheme("clawd"));
    theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
    return require("../src/state")({ theme, lang: "en", doNotDisturb: false,
      miniMode: false, pendingPermissions: [], t: (k) => k,
      playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
      buildContextMenu() {}, buildTrayMenu() {}, processKill() { return true; },
      ...overrides,
    });
  }

  it("sets pendingAttention on that session's HUD entry while the card is up, without touching the pet", () => {
    const pending = [];
    const state = makeState({ pendingPermissions: pending });
    const id = makeSessionKey({ profileId: "local", rawSessionId: "claude-hud" });
    const entry = () => state.buildSessionSnapshot().sessions.find((session) => session.id === id);
    try {
      state.updateSession(id, "attention", "Stop", { agentId: "claude-code", profileId: "local" });
      const baseline = structuredClone(entry());
      assert.equal(Object.hasOwn(baseline, "effectiveState"), false);
      assert.equal(Object.hasOwn(baseline, "activeSubagentCount"), false);
      assert.equal(Object.hasOwn(baseline, "pendingAttention"), false);
      const petBefore = state.resolveDisplayState();

      pending.push({ sessionId: id, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true });
      assert.equal(entry().pendingAttention, true, "the HUD row shows the same needs-input state as a Codex question");
      assert.equal(entry().effectiveState, "notification");
      assert.equal(state.resolveDisplayState(), petBefore, "pet projection stays Codex-only");

      pending.length = 0;
      assert.deepStrictEqual(entry(), baseline, "without a card the row is byte-for-byte the main shape");
    } finally { state.cleanup(); }
  });

  it("ignores Claude entries that are not the wrap_up card, and remote ones", () => {
    const pending = [];
    const state = makeState({ pendingPermissions: pending });
    const id = makeSessionKey({ profileId: "local", rawSessionId: "claude-hud-2" });
    const entry = () => state.buildSessionSnapshot().sessions.find((session) => session.id === id);
    try {
      state.updateSession(id, "working", "PreToolUse", { agentId: "claude-code", profileId: "local" });
      pending.push({ sessionId: id, agentId: "claude-code", res: null, toolName: "Bash" });
      pending.push({ sessionId: id, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true, host: "box" });
      assert.notEqual(entry().pendingAttention, true);
    } finally { state.cleanup(); }
  });
});

describe("issue #1326: Claude cards stay off the pet and out of other reminders", () => {
  const path = require("node:path");
  const themeLoader = require("../src/theme-loader");

  function makeState(overrides = {}) {
    themeLoader.init(path.join(__dirname, "..", "src"));
    const theme = structuredClone(themeLoader.loadTheme("clawd"));
    theme.timings.minDisplay = {}; theme.timings.autoReturn = {};
    return require("../src/state")({ theme, lang: "en", doNotDisturb: false,
      miniMode: false, pendingPermissions: [], t: (k) => k,
      playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
      buildContextMenu() {}, buildTrayMenu() {}, processKill() { return true; },
      ...overrides,
    });
  }

  it("never changes the pet while another wait owns the pose, or when it is alone", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    const pending = [];
    const kiroPending = new Set();
    const sounds = [];
    const state = makeState({
      pendingPermissions: pending,
      playSound: (name) => sounds.push(name),
      getKiroDesktopPendingSessionIds: () => kiroPending,
    });
    const kiroId = makeSessionKey({ profileId: "local", rawSessionId: "kiro-wait" });
    const claudeId = makeSessionKey({ profileId: "local", rawSessionId: "claude-card" });
    const observed = () => ({
      state: state.getCurrentState(),
      revision: state.getDisplayRevision(),
      sounds: sounds.length,
    });
    try {
      state.updateSession(kiroId, "working", "PreToolUse", { agentId: "kiro-desktop", profileId: "local" });
      kiroPending.add(kiroId);
      state.refreshPendingAttention();
      assert.equal(state.getCurrentState(), "notification");
      let before = observed();

      const card = { sessionId: claudeId, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true, toolUseId: "u1" };
      pending.push(card);
      state.refreshPendingAttention();
      assert.deepStrictEqual(observed(), before, "adding the card changes nothing");

      card.toolUseId = "u2";
      card.toolInput = { questions: [{ question: "again" }] };
      state.refreshPendingAttention();
      assert.deepStrictEqual(observed(), before, "refreshing the card changes nothing");

      pending.length = 0;
      state.refreshPendingAttention();
      assert.deepStrictEqual(observed(), before, "clearing the card changes nothing");

      kiroPending.delete(kiroId);
      state.refreshPendingAttention();
      assert.equal(state.getCurrentState(), "working");
      before = observed();

      pending.push(card);
      state.refreshPendingAttention();
      assert.deepStrictEqual(observed(), before, "a lone Claude card does not move the pet");
      pending.length = 0;
      state.refreshPendingAttention();
      assert.deepStrictEqual(observed(), before, "clearing a lone Claude card does not move the pet");
    } finally { state.cleanup(); }
  });

  it("does not block a Kiro wait from reselecting the pet", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    const pending = [];
    const kiroPending = new Set();
    const state = makeState({
      pendingPermissions: pending,
      getKiroDesktopPendingSessionIds: () => kiroPending,
    });
    const kiroId = makeSessionKey({ profileId: "local", rawSessionId: "kiro-reselect" });
    const claudeId = makeSessionKey({ profileId: "local", rawSessionId: "claude-reselect" });
    try {
      state.updateSession(kiroId, "working", "PreToolUse", { agentId: "kiro-desktop", profileId: "local" });
      pending.push({ sessionId: claudeId, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true });

      kiroPending.add(kiroId);
      state.refreshPendingAttention();
      assert.equal(state.resolveDisplayState(), "notification");
      assert.equal(state.getCurrentState(), "notification");

      kiroPending.delete(kiroId);
      state.refreshPendingAttention();
      assert.equal(state.resolveDisplayState(), "working");
      assert.equal(state.getCurrentState(), "working", "a card without a decision channel must not pin the notification pose");
    } finally { state.cleanup(); }
  });

  it("re-shows a detached row while its card is up and hides it again after clearing", () => {
    let alive = true;
    const pending = [];
    const state = makeState({
      pendingPermissions: pending,
      sessionHudCleanupDetached: true,
      processKill() {
        if (!alive) { const error = new Error("exited"); error.code = "ESRCH"; throw error; }
      },
    });
    const id = makeSessionKey({ profileId: "local", rawSessionId: "claude-detached" });
    const entry = () => state.buildSessionSnapshot().sessions.find((session) => session.id === id);
    try {
      state.updateSession(id, "idle", "Stop", { agentId: "claude-code", profileId: "local" });
      const session = state.sessions.get(id);
      session.state = "idle";
      session.agentPid = null;
      session.sourcePid = 4242;
      session.pidReachable = true;
      alive = false;
      assert.equal(entry().hiddenFromHud, true);

      pending.push({ sessionId: id, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true });
      assert.equal(entry().pendingAttention, true);
      assert.equal(entry().hiddenFromHud, false, "pending attention wins over the detached-session cleanup");

      pending.length = 0;
      assert.equal(entry().hiddenFromHud, true);
    } finally { state.cleanup(); }
  });
});

describe("issue #1326: passive notification predicates", () => {
  it("classifies Claude cards as passive native questions without changing other entries", () => {
    const cases = [
      [{ isClaudeTurnAskNotify: true }, true, true],
      [{ isKiroDesktopNotify: true }, true, false],
      [{ isCodexUserInputNotify: true }, true, true],
      [{ isCodexNotify: true }, true, false],
      [{ isKimiNotify: true }, true, false],
      [{ agentId: "claude-code" }, false, false],
    ];
    for (const [entry, passive, native] of cases) {
      assert.equal(isPassiveNotifyEntry(entry), passive, JSON.stringify(entry));
      assert.equal(isNativeQuestionNotify(entry), native, JSON.stringify(entry));
    }
  });
});

describe("issue #1326: queued turns, same-turn continuation, and phantoms", () => {
  it("updates the card when a queued turn starts without UserPromptSubmit", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "First question?", actions: [{ label: "First" }] },
    });
    await post("Stop", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t2", prompt_id: "p2",
      tool_input: { ask: "Queued question?", actions: [{ label: "Second" }] },
    });
    assert.strictEqual(calls.shown.length, 2);
    assert.strictEqual(calls.shown.at(-1).ask, "Queued question?");
    assert.deepStrictEqual(calls.shown.at(-1).actions, [{ label: "Second" }]);
    assert.strictEqual(calls.tracked.length, 2);
    assert.deepStrictEqual(calls.tracked.at(-1), calls.shown.at(-1));
  });

  it("clears the card when a queued turn runs an ordinary tool", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "First question?" },
    });
    await post("Stop", { prompt_id: "p1" });
    const cleared = calls.cleared.length;
    const resolved = calls.resolved.length;
    await post("PreToolUse", { tool_name: "Bash", tool_use_id: "t2", prompt_id: "p2", tool_input: { command: "ls" } });
    assert.strictEqual(calls.cleared.length, cleared + 1);
    assert.strictEqual(calls.resolved.length, resolved + 1);
  });

  it("clears and re-shows within the same prompt after a vetoed Stop", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "First question?" },
    });
    assert.strictEqual(calls.tracked.length, 1);
    await post("Stop", { prompt_id: "p1" });
    const cleared = calls.cleared.length;
    const resolved = calls.resolved.length;
    await post("PreToolUse", { tool_name: "Bash", tool_use_id: "t2", prompt_id: "p1", tool_input: { command: "ls" } });
    assert.strictEqual(calls.cleared.length, cleared + 1);
    assert.strictEqual(calls.resolved.length, resolved + 1);
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t3", prompt_id: "p1",
      tool_input: { ask: "Continued question?" },
    });
    assert.strictEqual(calls.shown.at(-1).ask, "Continued question?");
    assert.strictEqual(calls.tracked.length, 2);
  });

  it("documents the known limit: a phantom without agent_id clears or replaces the card", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Real question?" },
    });
    await post("Stop", { prompt_id: "p1" });
    // Upstream anthropics/claude-code#106339 reports phantoms with a fresh
    // agent_id. If a build omits it, nothing here can tell the fork apart from
    // a real queued turn, so this documents the resulting behavior.
    const cleared = calls.cleared.length;
    const resolved = calls.resolved.length;
    await post("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "t-phantom", prompt_id: "p2" });
    assert.strictEqual(calls.cleared.length, cleared + 1);
    assert.strictEqual(calls.resolved.length, resolved + 1);
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t-phantom-wrap", prompt_id: "p2",
      tool_input: { ask: "Phantom question?" },
    });
    assert.strictEqual(calls.shown.at(-1).ask, "Phantom question?");
    assert.strictEqual(calls.tracked.length, 2);
  });

  it("does not revive a retired old tool id after Stop", async () => {
    const { createClaudeToolPhaseLedger } = require("../src/claude-tool-phase");
    const ledger = createClaudeToolPhaseLedger();
    const { calls, post } = createRouteHarness({
      observeClaudeToolPhase: (sessionId, event, opts) => ledger.observe({
        sessionId,
        event,
        toolUseId: opts.toolUseId,
        promptId: opts.claudePromptId,
        subagentId: opts.subagentId,
        subagentLifecycleSource: opts.subagentLifecycleSource,
      }),
    });
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Real question?" },
    });
    await post("Stop", { prompt_id: "p1" });
    const shown = calls.shown.length;
    const cleared = calls.cleared.length;
    const tracked = calls.tracked.length;
    const resolved = calls.resolved.length;
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Retired question?" },
    });
    assert.strictEqual(calls.shown.length, shown);
    assert.strictEqual(calls.cleared.length, cleared);
    assert.strictEqual(calls.tracked.length, tracked);
    assert.strictEqual(calls.resolved.length, resolved);
  });
});

describe("issue #1326: main-thread delegation clears the card", () => {
  for (const toolName of ["Agent", "Task"]) {
    it(`clears on a main-thread PreToolUse(${toolName})`, async () => {
      const { calls, post } = createRouteHarness();
      await post("UserPromptSubmit", { prompt_id: "p1" });
      await post("PreToolUse", {
        tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
        tool_input: { ask: "Real question?" },
      });
      const cleared = calls.cleared.length;
      const resolved = calls.resolved.length;
      const tracked = calls.tracked.length;
      await post("PreToolUse", { tool_name: toolName, tool_use_id: "agent-1", prompt_id: "p1" });
      assert.strictEqual(calls.cleared.length, cleared + 1);
      assert.strictEqual(calls.resolved.length, resolved + 1);
      assert.strictEqual(calls.tracked.length, tracked);
    });
  }

  it("keeps the card for a subagent's own synthetic Agent start", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Real question?" },
    });
    const cleared = calls.cleared.length;
    const resolved = calls.resolved.length;
    const tracked = calls.tracked.length;
    await post("PreToolUse", {
      tool_name: "Agent", tool_use_id: "agent-child", prompt_id: "p1", agent_id: "child-agent",
    });
    assert.strictEqual(calls.cleared.length, cleared);
    assert.strictEqual(calls.resolved.length, resolved);
    assert.strictEqual(calls.tracked.length, tracked);
  });

  it("keeps the card for native SubagentStart, with or without an agent_id", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Real question?" },
    });
    const cleared = calls.cleared.length;
    const resolved = calls.resolved.length;
    const tracked = calls.tracked.length;
    await post("SubagentStart", { agent_id: "child-agent", agent_type: "Explore" });
    await post("SubagentStart", { agent_type: "Explore" });
    assert.strictEqual(calls.cleared.length, cleared);
    assert.strictEqual(calls.resolved.length, resolved);
    assert.strictEqual(calls.tracked.length, tracked);
  });
});

describe("issue #1326: wrap_up forwards only the fields the card shows", () => {
  const resolve = () => ({ pid: null });

  it("drops recap and action messages from the hook body", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s", tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "toolu_wrap",
      tool_input: WRAP_UP_INPUT,
    }, resolve);
    assert.deepStrictEqual(body.claude_turn_ask, {
      ask: "Fix the parser now?",
      actions: [{ label: "Fix it" }, { label: "Not now" }],
    });
  });

  it("drops recap and action messages in the server normalizer", () => {
    assert.deepStrictEqual(normalizeClaudeTurnAsk(WRAP_UP_INPUT), {
      ask: "Fix the parser now?",
      actions: [{ label: "Fix it" }, { label: "Not now" }],
    });
  });

  it("caps ask and label independently in the hook with an ellipsis", () => {
    const result = buildClaudeTurnAsk(CLAUDE_WRAP_UP_TOOL_NAME, {
      ask: "a".repeat(1000),
      recap: "r".repeat(1000),
      actions: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`.repeat(40), message: "m".repeat(1000) })),
    });
    assert.strictEqual(result.ask.length, 300);
    assert.ok(result.ask.endsWith("…"));
    assert.deepStrictEqual(Object.keys(result).sort(), ["actions", "ask"]);
    assert.strictEqual(result.actions.length, 4);
    assert.ok(result.actions.every((action) => action.label.length === 60 && action.label.endsWith("…")));
    assert.ok(result.actions.every((action) => Object.keys(action).join() === "label"));
  });

  it("caps ask and label independently in the server normalizer with an ellipsis", () => {
    const result = normalizeClaudeTurnAsk({
      ask: "a".repeat(1000),
      recap: "r".repeat(1000),
      actions: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`.repeat(40), message: "m".repeat(1000) })),
    });
    assert.strictEqual(result.ask.length, 300);
    assert.ok(result.ask.endsWith("…"));
    assert.deepStrictEqual(Object.keys(result).sort(), ["actions", "ask"]);
    assert.strictEqual(result.actions.length, 4);
    assert.ok(result.actions.every((action) => action.label.length === 60 && action.label.endsWith("…")));
    assert.ok(result.actions.every((action) => Object.keys(action).join() === "label"));
  });

  it("does not show the card for a non-Claude wrap_up source", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt_id: "p1" });
    await post("PreToolUse", {
      tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "t1", prompt_id: "p1",
      tool_input: { ask: "Cursor question?" }, cursor_version: "1.2.3",
    });
    assert.strictEqual(calls.shown.length, 0);
  });
});
