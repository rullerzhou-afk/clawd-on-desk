"use strict";

// #1326: Claude Desktop's end-of-turn question box (mcp__ccd_turn__wrap_up)
// surfaced as a read-only native-question card.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  CLAUDE_WRAP_UP_TOOL_NAME,
  normalizeClaudeTurnAsk,
  createClaudeTurnAskTracker,
  MAX_ASK_CHARS,
  MAX_ACTIONS,
} = require("../src/claude-turn-ask");
const { buildStateBody, buildClaudeTurnAsk } = require("../hooks/clawd-hook");
const { handleStatePost } = require("../src/server-route-state");
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
  it("keeps the ask, recap and labelled actions", () => {
    assert.deepStrictEqual(normalizeClaudeTurnAsk(WRAP_UP_INPUT), WRAP_UP_INPUT);
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
    assert.strictEqual(result.recap, "");
    // The cap applies to the raw list, so the malformed entries count toward it.
    assert.ok(result.actions.length <= MAX_ACTIONS);
    assert.ok(result.actions.every((action) => typeof action.label === "string" && action.label));
  });
});

describe("createClaudeTurnAskTracker", () => {
  const decide = (tracker, event, extra = {}) => tracker.decide({ sessionId: "s1", event, ...extra });

  it("shows on a wrap_up with an ask and keeps it through the turn's Stop", () => {
    const tracker = createClaudeTurnAskTracker();
    assert.strictEqual(decide(tracker, "UserPromptSubmit"), "clear");
    assert.strictEqual(
      decide(tracker, "PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true }),
      "show"
    );
    assert.strictEqual(decide(tracker, "Stop"), "ignore", "Stop must never dismiss the card");
  });

  it("clears when Claude moves on, on a recap-only wrap_up, on the next prompt and on SessionEnd", () => {
    const tracker = createClaudeTurnAskTracker();
    assert.strictEqual(decide(tracker, "PreToolUse", { toolName: "Bash" }), "clear");
    assert.strictEqual(
      decide(tracker, "PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: false }),
      "clear"
    );
    assert.strictEqual(decide(tracker, "UserPromptSubmit"), "clear");
    assert.strictEqual(decide(tracker, "SessionEnd"), "clear");
  });

  it("ignores every PreToolUse after Stop until the next prompt (prompt-suggestion phantoms)", () => {
    const tracker = createClaudeTurnAskTracker();
    decide(tracker, "UserPromptSubmit");
    decide(tracker, "PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true });
    decide(tracker, "Stop");
    assert.strictEqual(decide(tracker, "PreToolUse", { toolName: "AskUserQuestion" }), "ignore");
    assert.strictEqual(
      decide(tracker, "PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true }),
      "ignore"
    );
    assert.strictEqual(decide(tracker, "UserPromptSubmit"), "clear");
    assert.strictEqual(
      decide(tracker, "PreToolUse", { toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true }),
      "show",
      "a new turn shows again"
    );
  });

  it("keeps sessions independent and ignores events without a session", () => {
    const tracker = createClaudeTurnAskTracker();
    tracker.decide({ sessionId: "a", event: "Stop" });
    assert.strictEqual(
      tracker.decide({ sessionId: "b", event: "PreToolUse", toolName: CLAUDE_WRAP_UP_TOOL_NAME, hasAsk: true }),
      "show"
    );
    assert.strictEqual(tracker.decide({ sessionId: "", event: "PreToolUse" }), "ignore");
    assert.strictEqual(tracker.decide({ sessionId: "a", event: "PostToolUse" }), "ignore");
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
    assert.deepStrictEqual(body.claude_turn_ask, WRAP_UP_INPUT);
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
    assert.ok(result.ask.length <= 300);
    assert.ok(result.recap.length <= 400);
    assert.ok(result.actions.length <= 4);
    assert.ok(result.actions.every((action) => action.label.length <= 60 && action.message.length <= 200));
  });
});

// One ctx shared across requests, like the real server, so the per-session
// tracker state carries from one hook event to the next.
function createRouteHarness() {
  const calls = { shown: [], cleared: [] };
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
  };
  const recorder = {
    acceptedUnlessDnd() {}, droppedByDisabled() {}, droppedByDnd() {},
    droppedInvalidAgent() {}, droppedUnsupported() {},
  };
  function post(event, payload = {}) {
    const body = buildStateBody(event, { session_id: "desk-1", ...payload }, () => ({ pid: null }));
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
  return { calls, post };
}

const WRAP_UP_PRE = {
  tool_name: CLAUDE_WRAP_UP_TOOL_NAME,
  tool_use_id: "toolu_wrap_1",
  tool_input: WRAP_UP_INPUT,
};
const SID = makeSessionKey({ profileId: "local", rawSessionId: "desk-1" });

describe("/state route surfaces Claude Desktop's wrap_up question", () => {
  it("shows the card from a real hook body and keeps it through Stop and post-Stop phantoms", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit", { prompt: "review the parser" });
    await post("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", tool_input: { command: "npm test" } });
    const clearsBeforeAsk = calls.cleared.length;

    await post("PreToolUse", WRAP_UP_PRE);
    assert.strictEqual(calls.shown.length, 1);
    assert.deepStrictEqual(calls.shown[0], {
      sessionId: SID,
      toolUseId: "toolu_wrap_1",
      ask: WRAP_UP_INPUT.ask,
      recap: WRAP_UP_INPUT.recap,
      actions: WRAP_UP_INPUT.actions,
      sourcePid: calls.shown[0].sourcePid,
      agentPid: calls.shown[0].agentPid,
      cwd: calls.shown[0].cwd,
      host: calls.shown[0].host,
    });

    await post("Stop", { last_assistant_message: "Two tests fail in the parser." });
    // A prompt-suggestion fork fires PreToolUse for calls that never run.
    await post("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_phantom" });
    await post("PreToolUse", { ...WRAP_UP_PRE, tool_use_id: "toolu_phantom_wrap" });
    assert.strictEqual(calls.cleared.length, clearsBeforeAsk, "Stop and post-Stop phantoms must not dismiss the card");
    assert.strictEqual(calls.shown.length, 1, "post-Stop phantoms must not re-show the card");

    await post("UserPromptSubmit", { prompt: "Fix the two failing parser tests." });
    assert.strictEqual(calls.cleared.length, clearsBeforeAsk + 1);
    assert.strictEqual(calls.cleared.at(-1)[0], SID);
  });

  it("clears when Claude moves on to another tool in the same turn", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", WRAP_UP_PRE);
    const before = calls.cleared.length;
    await post("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read" });
    assert.strictEqual(calls.cleared.length, before + 1);
  });

  it("clears on a recap-only wrap_up and on SessionEnd", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", WRAP_UP_PRE);
    let before = calls.cleared.length;
    await post("PreToolUse", { tool_name: CLAUDE_WRAP_UP_TOOL_NAME, tool_use_id: "toolu_recap", tool_input: { recap: "done" } });
    assert.strictEqual(calls.cleared.length, before + 1);
    assert.strictEqual(calls.shown.length, 1);
    before = calls.cleared.length;
    await post("SessionEnd", { reason: "other" });
    assert.strictEqual(calls.cleared.length, before + 1);
  });

  it("ignores wrap_up from a subagent", async () => {
    const { calls, post } = createRouteHarness();
    await post("UserPromptSubmit");
    await post("PreToolUse", { ...WRAP_UP_PRE, agent_id: "sub-1", agent_type: "general-purpose" });
    assert.strictEqual(calls.shown.length, 0);
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
      const petBefore = state.resolveDisplayState();
      assert.notEqual(entry().pendingAttention, true);

      pending.push({ sessionId: id, agentId: "claude-code", res: null, isClaudeTurnAskNotify: true });
      assert.equal(entry().pendingAttention, true, "the HUD row shows the same needs-input state as a Codex question");
      assert.equal(entry().effectiveState, "notification");
      assert.equal(state.resolveDisplayState(), petBefore, "pet projection stays Codex-only");

      pending.length = 0;
      assert.notEqual(entry().pendingAttention, true, "answered → the row returns to normal");
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
