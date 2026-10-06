"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const { handleStatePost } = require("../src/server-route-state");
const { makeSessionKey } = require("../src/session-key");
const createGrokTurnFence = require("../src/grok-turn-fence");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");

const RAW_SID = "grok-build:s1";
const SID = makeSessionKey({ profileId: "local", rawSessionId: RAW_SID });

// Every initState() runtime arms state timers; clean them up unconditionally so
// the node --test process exits naturally after the last assertion.
const createdRuntimes = [];

afterEach(() => {
  while (createdRuntimes.length) {
    const runtime = createdRuntimes.pop();
    try {
      if (runtime && runtime.api && typeof runtime.api.cleanup === "function") {
        runtime.api.cleanup();
      }
    } catch {
      // Cleanup is best-effort; a failure here must not mask the test result.
    }
  }
});

function makeReq(body) {
  const req = new EventEmitter();
  req.headers = {};
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = headers;
    },
    end(data) {
      if (data) this.body += String(data);
      if (this.resolve) this.resolve(this);
    },
  };
}

function makeRuntime() {
  const setStates = [];
  const ctx = {
    lang: "en",
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    processKill: () => { const err = new Error("dead"); err.code = "ESRCH"; throw err; },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    setState: (...args) => setStates.push(args),
    isAgentNotificationHookEnabled: () => true,
  };
  const api = initState(ctx);
  const stateCalls = [];
  const updateSession = (sessionId, state, event, opts) => {
    stateCalls.push({ sessionId, state, event, opts });
    return api.updateSession(sessionId, state, event, opts);
  };
  const runtime = { api, ctx, setStates, setState: ctx.setState, stateCalls, updateSession };
  createdRuntimes.push(runtime);
  return runtime;
}

function post(body, fence, runtime) {
  return new Promise((resolve) => {
    const res = makeRes();
    res.resolve = resolve;
    const ctx = {
      STATE_SVGS: {
        idle: "x.svg", thinking: "x.svg", working: "x.svg", juggling: "x.svg",
        error: "x.svg", attention: "x.svg", notification: "x.svg", sleeping: "x.svg",
        sweeping: "x.svg",
      },
      pendingPermissions: [],
      sessions: runtime.api.sessions,
      isAgentEnabled: () => true,
      setState: (...args) => runtime.setState(...args),
      updateSession: runtime.updateSession,
      updateAccountQuota: () => {},
      resolvePermissionEntry: () => {},
      permLog: () => {},
      handleTestResult: () => {},
    };
    handleStatePost(makeReq(typeof body === "string" ? body : JSON.stringify(body)), res, {
      ctx,
      createRequestHookRecorder: () => ({
        acceptedUnlessDnd: () => {},
        droppedByDisabled: () => {},
        droppedByDnd: () => {},
        droppedInvalidAgent: () => {},
        droppedUnsupported: () => {},
      }),
      shouldDropForDnd: () => false,
      codexOfficialTurns: new Map(),
      grokTurnFence: fence,
    });
  });
}

function grokBody(state, event, extra = {}) {
  const body = { agent_id: "grok-build", session_id: RAW_SID, state, ...extra };
  if (event !== undefined) body.event = event;
  return body;
}

function session(runtime) {
  return runtime.api.sessions.get(SID);
}

function latestEvent(record) {
  const events = Array.isArray(record && record.recentEvents) ? record.recentEvents : [];
  return events.length ? events[events.length - 1] : null;
}

describe("Grok /state route integration", () => {
  it("drops a late terminal for an older turn without touching state", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;

    const dropped = await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(dropped.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).state, "thinking");
  });

  it("drops a duplicate terminal", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const first = await post(grokBody("attention", "Stop", { prompt_id: "B" }), fence, runtime);
    const second = await post(grokBody("attention", "Stop", { prompt_id: "B" }), fence, runtime);
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(second.statusCode, 204);
  });

  it("settles an unseen terminal", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    const res = await post(grokBody("attention", "Stop", { prompt_id: "interrupted" }), fence, runtime);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(session(runtime).state, "idle");
    assert.strictEqual(latestEvent(session(runtime)).event, "Stop");
  });

  it("keeps a continuation Stop non-terminal and does not suppress the next notification", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const continuation = await post(grokBody("working", undefined, { prompt_id: "B" }), fence, runtime);
    assert.strictEqual(continuation.statusCode, 200);
    let record = session(runtime);
    assert.strictEqual(record.state, "working");
    assert.strictEqual(record.awaitingInputSinceStop, false);
    assert.ok(!record.recentEvents.some((entry) => entry.event === "Stop"));

    runtime.ctx.miniMode = true;
    await post(grokBody("notification", "Notification"), fence, runtime);
    // Allow the current (working) minimum-display window to elapse so the
    // notification one-shot is actually applied. Mini mode maps the one-shot to
    // mini-alert; the point is that it is not suppressed.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(runtime.api.getCurrentState(), "mini-alert");
  });

  it("corrects a same-turn Stop with StopCancelled", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    await post(grokBody("attention", "Stop", { prompt_id: "B" }), fence, runtime);
    let record = session(runtime);
    assert.strictEqual(record.state, "idle");
    assert.strictEqual(record.awaitingInputSinceStop, true);
    assert.strictEqual(latestEvent(record).event, "Stop");

    const correction = await post(grokBody("idle", "StopCancelled", { prompt_id: "B" }), fence, runtime);
    assert.strictEqual(correction.statusCode, 200);
    record = session(runtime);
    assert.strictEqual(record.state, "idle");
    assert.strictEqual(record.awaitingInputSinceStop, false);
    assert.strictEqual(latestEvent(record).event, "StopCancelled");
  });

  it("plays an idle_prompt one-shot but leaves the session idle and settles the fence", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const res = await post(grokBody("notification", "Notification", { notification_type: "idle_prompt" }), fence, runtime);
    assert.strictEqual(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(runtime.api.getCurrentState(), "notification");
    const record = session(runtime);
    assert.strictEqual(record.state, "idle");
    assert.strictEqual(record.awaitingInputSinceStop, false);
    assert.strictEqual(latestEvent(record).event, "Notification");
    const snapshot = fence.getSnapshot(SID);
    assert.strictEqual(snapshot.currentTurnId, null);
    assert.strictEqual(snapshot.tombstones.find((entry) => entry.turnId === "B").terminalEvent, "Notification");
  });

  it("clears the fence on SessionEnd", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    assert.ok(fence.getSnapshot(SID));
    const res = await post(grokBody("sleeping", "SessionEnd"), fence, runtime);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fence.getSnapshot(SID), null);
  });

  it("drops late failure work and failure terminals for a superseded turn", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;

    const failureWork = await post(
      grokBody("error", "PostToolUseFailure", { prompt_id: "A" }),
      fence,
      runtime
    );
    assert.strictEqual(failureWork.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);

    const lateFailureTerminal = await post(
      grokBody("error", "StopFailure", { prompt_id: "A" }),
      fence,
      runtime
    );
    assert.strictEqual(lateFailureTerminal.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);

    // Complete B, then replay the late A terminal: still dropped.
    await post(grokBody("attention", "Stop", { prompt_id: "B" }), fence, runtime);
    const callsAfterB = runtime.stateCalls.length;
    const replay = await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(replay.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsAfterB);
    assert.strictEqual(session(runtime).state, "idle");
  });

  it("does not let StopCancelled correct a StopFailure or a superseded turn", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("error", "StopFailure", { prompt_id: "A" }), fence, runtime);
    const afterFailure = runtime.stateCalls.length;
    const correction = await post(grokBody("idle", "StopCancelled", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(correction.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, afterFailure);
  });

  it("drops a late StopCancelled A after B started without clearing B", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;

    const late = await post(grokBody("idle", "StopCancelled", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(late.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).state, "thinking");
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");
  });

  it("keeps the legitimate same-turn Stop -> StopCancelled correction", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    const correction = await post(grokBody("idle", "StopCancelled", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(correction.statusCode, 200);
    assert.strictEqual(latestEvent(session(runtime)).event, "StopCancelled");
  });

  it("passes PreCompact/PostCompact to state without touching the fence while B is live", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const before = fence.getSnapshot(SID);

    // No promptId on any of these; they are visual-only.
    assert.strictEqual((await post(grokBody("sweeping", "PreCompact"), fence, runtime)).statusCode, 200);
    assert.strictEqual((await post(grokBody("thinking", "PostCompact", { source: "auto" }), fence, runtime)).statusCode, 200);
    assert.strictEqual((await post(grokBody("idle", "PostCompact", { source: "manual" }), fence, runtime)).statusCode, 200);

    const after = fence.getSnapshot(SID);
    assert.strictEqual(after.currentTurnId, "B");
    assert.strictEqual(after.terminalLatch, before.terminalLatch);
    assert.strictEqual(after.correctableTurnId, before.correctableTurnId);
    assert.deepStrictEqual(after.tombstones, before.tombstones);
    assert.strictEqual(latestEvent(session(runtime)).event, "PostCompact");
    assert.strictEqual(session(runtime).state, "idle");
  });

  it("does not clear a live turn for a no-id start and still settles the original", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;
    const eventsBefore = session(runtime).recentEvents.length;

    const noIdStart = await post(grokBody("thinking", "UserPromptSubmit"), fence, runtime);
    assert.strictEqual(noIdStart.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).recentEvents.length, eventsBefore);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");

    const lateStop = await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    assert.strictEqual(lateStop.statusCode, 200);
    assert.strictEqual(session(runtime).state, "idle");
  });

  it("accepts prompt-less tool work on the active turn but drops no-id continuation", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);

    // Prompt-less PreToolUse/PostToolUse/PostToolUseFailure: bound to A.
    for (const [state, event] of [
      ["working", "PreToolUse"],
      ["working", "PostToolUse"],
      ["error", "PostToolUseFailure"],
    ]) {
      const accepted = await post(grokBody(state, event), fence, runtime);
      assert.strictEqual(accepted.statusCode, 200, event);
    }
    assert.ok(session(runtime).recentEvents.some((entry) => entry.event === "PreToolUse"));
    assert.ok(session(runtime).recentEvents.some((entry) => entry.event === "PostToolUse"));
    assert.ok(session(runtime).recentEvents.some((entry) => entry.event === "PostToolUseFailure"));
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");

    // A prompt-less continuation Stop is still turn-scoped and rejected.
    const callsBefore = runtime.stateCalls.length;
    const eventsBefore = session(runtime).recentEvents.length;
    const dropped = await post(grokBody("working", undefined), fence, runtime);
    assert.strictEqual(dropped.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).recentEvents.length, eventsBefore);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");
  });

  it("rejects prompt-less tool work when no active turn exists", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    const callsBefore = runtime.stateCalls.length;
    for (const [state, event] of [["working", "PreToolUse"], ["error", "PostToolUseFailure"]]) {
      const dropped = await post(grokBody(state, event), fence, runtime);
      assert.strictEqual(dropped.statusCode, 204, event);
    }
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(fence.getSnapshot(SID), null);
  });

  it("drops a late prompt-less PostToolUse after the turn closed", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("working", "PreToolUse"), fence, runtime);
    await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;

    const late = await post(grokBody("working", "PostToolUse"), fence, runtime);
    assert.strictEqual(late.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, null);
  });

  it("drops a turn-terminal report that carries no promptId while a turn is active", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "B" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;
    for (const [state, event] of [["attention", "Stop"], ["error", "StopFailure"], ["idle", "StopCancelled"]]) {
      const dropped = await post(grokBody(state, event), fence, runtime);
      assert.strictEqual(dropped.statusCode, 204, event);
    }
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).state, "thinking");
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "B");
  });

  it("drops a late Windows SessionStart without regressing the active turn", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    // Real Windows 1.0.30 order: UserPromptSubmit -> SessionStart (~11ms later).
    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    const callsBefore = runtime.stateCalls.length;
    const eventsBefore = session(runtime).recentEvents.length;

    const late = await post(grokBody("idle", "SessionStart"), fence, runtime);
    assert.strictEqual(late.statusCode, 204);
    assert.strictEqual(runtime.stateCalls.length, callsBefore);
    assert.strictEqual(session(runtime).recentEvents.length, eventsBefore);
    assert.strictEqual(session(runtime).state, "thinking");
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");

    // The prompt-less PreToolUse that follows is still accepted and moves to working.
    const pre = await post(grokBody("working", "PreToolUse"), fence, runtime);
    assert.strictEqual(pre.statusCode, 200);
    assert.strictEqual(session(runtime).state, "working");
    assert.ok(session(runtime).recentEvents.some((entry) => entry.event === "PreToolUse"));
    assert.strictEqual(fence.getSnapshot(SID).currentTurnId, "A");
  });

  it("accepts a normal SessionStart before any turn and a fresh one after SessionEnd", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();

    const beforeTurn = await post(grokBody("idle", "SessionStart"), fence, runtime);
    assert.strictEqual(beforeTurn.statusCode, 200);
    assert.strictEqual(session(runtime).state, "idle");
    assert.strictEqual(fence.getSnapshot(SID), null);

    await post(grokBody("thinking", "UserPromptSubmit", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("attention", "Stop", { prompt_id: "A" }), fence, runtime);
    await post(grokBody("sleeping", "SessionEnd"), fence, runtime);
    assert.strictEqual(fence.getSnapshot(SID), null);

    const restart = await post(grokBody("idle", "SessionStart"), fence, runtime);
    assert.strictEqual(restart.statusCode, 200);
    assert.strictEqual(session(runtime).state, "idle");
  });

  it("does not apply the Grok fence to other agents", async () => {
    const fence = createGrokTurnFence();
    const runtime = makeRuntime();
    const res = await new Promise((resolve) => {
      const resObj = makeRes();
      resObj.resolve = resolve;
      handleStatePost(makeReq(JSON.stringify({
        agent_id: "claude-code",
        session_id: "grok-build:s1",
        state: "attention",
        event: "Stop",
        prompt_id: "A",
      })), resObj, {
        ctx: {
          STATE_SVGS: { attention: "x.svg" },
          pendingPermissions: [],
          sessions: runtime.api.sessions,
          isAgentEnabled: () => true,
          setState: () => {},
          updateSession: runtime.updateSession,
          updateAccountQuota: () => {},
          resolvePermissionEntry: () => {},
          permLog: () => {},
          handleTestResult: () => {},
        },
        createRequestHookRecorder: () => ({
          acceptedUnlessDnd: () => {},
          droppedByDisabled: () => {},
          droppedByDnd: () => {},
          droppedInvalidAgent: () => {},
          droppedUnsupported: () => {},
        }),
        shouldDropForDnd: () => false,
        codexOfficialTurns: new Map(),
        grokTurnFence: fence,
      });
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fence.getSnapshot(SID), null);
  });
});
