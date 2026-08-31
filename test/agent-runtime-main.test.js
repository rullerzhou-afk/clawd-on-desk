"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createAgentRuntimeMain = require("../src/agent-runtime-main");
const CodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const { resolveCodexOfficialHookState } = require("../src/server-codex-official-turns");
const { makeSessionKey } = require("../src/session-key");
const { digestCodexTurnId } = require("../src/codex-turn-id");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS } = require("../src/state-stale-cleanup");
const themeLoader = require("../src/theme-loader");

const SRC_DIR = path.join(__dirname, "..", "src");
const localSessionKey = (rawSessionId) => makeSessionKey({
  profileId: "local",
  rawSessionId,
});

function makeFakeMonitorClass(instances) {
  return class FakeCodexLogMonitor {
    constructor(agent, callback, options) {
      this.agent = agent;
      this.callback = callback;
      this.options = options;
      this.started = 0;
      this.stopped = 0;
      instances.push(this);
    }

    start() {
      this.started += 1;
    }

    stop() {
      this.stopped += 1;
    }

    emit(sessionId, state, event, extra) {
      return this.callback(sessionId, state, event, extra);
    }
  };
}

function makeRealStateHarness() {
  themeLoader.init(SRC_DIR);
  const theme = JSON.parse(JSON.stringify(themeLoader.loadTheme("clawd")));
  // Composition tests assert lifecycle effects synchronously; animation hold
  // timers are state presentation policy and are covered in state.test.js.
  theme.timings.minDisplay = {};
  theme.timings.autoReturn = {};
  const sounds = [];
  const stateChanges = [];
  const noop = () => {};
  const state = require("../src/state")({
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
    miniSleepPeeked: false,
    playSound: (name) => sounds.push(name),
    sendToRenderer: (channel, stateName) => {
      if (channel === "state-change") stateChanges.push(stateName);
    },
    syncHitWin: noop,
    sendToHitWin: noop,
    miniPeekIn: noop,
    miniPeekOut: noop,
    buildContextMenu: noop,
    buildTrayMenu: noop,
    pendingPermissions: [],
    resolvePermissionEntry: noop,
    dismissPermissionsForDnd: noop,
    focusTerminalWindow: noop,
    focusHostPlatform: "win32",
    processKill: () => true,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    t: (key) => key,
  });
  return { state, sounds, stateChanges };
}

describe("agent-runtime-main", () => {
  it("keeps Codex monitor ownership and agent deferred wrappers out of main", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.match(mainSource, /createAgentRuntimeMain/);
    assert.ok(!mainSource.includes("_codexMonitor"));
    assert.ok(!mainSource.includes("CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS"));
    assert.ok(!mainSource.includes("function _deferredStartMonitorForAgent"));
    assert.ok(!mainSource.includes("function _deferredDismissPermissionsByAgent"));
  });

  it("marks official Codex sessions and suppresses covered JSONL events until the TTL expires", () => {
    let currentTime = 1000;
    const updates = [];
    const runtime = createAgentRuntimeMain({
      now: () => currentTime,
      updateSession: (...args) => updates.push(args),
      codexSubagentClassifier: {},
    });

    runtime.updateSessionFromServer("codex-1", "working", "event_msg:task_started", {
      agentId: "codex",
      hookSource: "codex-official",
    });

    assert.deepStrictEqual(updates, [[
      "codex-1",
      "working",
      "event_msg:task_started",
      { agentId: "codex", hookSource: "codex-official" },
    ]]);
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:guardian_assessment"),
      true
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:context_compacted"),
      false
    );

    currentTime += createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS + 1;
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:guardian_assessment"),
      false
    );
  });

  it("records privacy-safe local cross-channel turn identity diagnostics", () => {
    const instances = [];
    const debugLines = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: () => true,
      updateSession: () => {},
      debugLog: (line) => debugLines.push(line),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();
    const sessionId = localSessionKey("codex:abc");
    const turnId = "019fffff-1111-7777-8888-123456789abc";

    runtime.updateSessionFromServer(sessionId, "thinking", "UserPromptSubmit", {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      turnId,
    });
    monitor.emit("codex:abc", "thinking", "event_msg:task_started", { turnId });
    runtime.updateSessionFromServer(sessionId, "idle", "Stop", {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "remote-box",
      turnId: "must-not-log",
    });

    const digest = digestCodexTurnId(turnId);
    assert.deepStrictEqual(debugLines, [
      `codex-turn-id sid=${sessionId} source=official event=UserPromptSubmit turn=${digest}`,
      `codex-turn-id sid=${sessionId} source=jsonl event=event_msg:task_started turn=${digest}`,
    ]);
    assert.strictEqual(debugLines.some((line) => line.includes(turnId)), false);
  });

  it("routes suppressed JSONL context through no-lifecycle session metadata", () => {
    let currentTime = 1000;
    const instances = [];
    const calls = [];
    const metadataCalls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      now: () => currentTime,
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      getStateRuntime: () => ({
        updateSessionMetadata: (...args) => metadataCalls.push(args),
      }),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();

    runtime.updateSessionFromServer(localSessionKey("codex:abc"), "working", "UserPromptSubmit", {
      agentId: "codex",
      hookSource: "codex-official",
    });

    monitor.emit("codex:abc", "idle", "event_msg:task_complete", {
      cwd: "D:\\repo",
      contextUsage: {
        used: 49961,
        limit: 258400,
        percent: 19,
        source: "codex",
      },
    });

    assert.deepStrictEqual(calls, [
      ["update", localSessionKey("codex:abc"), "working", "UserPromptSubmit", {
        agentId: "codex",
        hookSource: "codex-official",
      }],
    ]);
    assert.deepStrictEqual(metadataCalls, [[
      localSessionKey("codex:abc"),
      {
        contextUsage: {
          used: 49961,
          limit: 258400,
          percent: 19,
          source: "codex",
        },
      },
    ]]);
  });

  it("routes Codex user-input monitor callbacks to a passive card and transient state", () => {
    const instances = [];
    const calls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: () => true,
      codexSubagentClassifier: {},
      getStateRuntime: () => ({
        touchSessionActivity: (...args) => {
          calls.push(["touch", ...args]);
          return true;
        },
      }),
      updateSession: (...args) => calls.push(["update", ...args]),
      showCodexUserInputBubble: (input) => { calls.push(["show", input]); return true; },
      clearCodexUserInputBubbles: (...args) => calls.push(["clear", ...args]),
    });
    const monitor = runtime.startCodexLogMonitor();
    const request = {
      callId: "call_1",
      questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }],
      autoResolutionMs: null,
    };
    const extra = {
      cwd: "/repo",
      sourcePid: 42,
      agentPid: 42,
      headless: false,
      contextUsage: { used: 10, limit: 100, percent: 10, source: "codex" },
    };

    monitor.options.onUserInputRequest("codex:s1", request, extra);
    monitor.options.onUserInputResolved("codex:s1", "call_1");

    const expectedTouch = [
      "touch",
      localSessionKey("codex:s1"),
      {
        agentId: "codex",
        profileId: "local",
        localOnly: true,
        reviveIdle: true,
      },
    ];
    assert.deepStrictEqual(calls[0], expectedTouch);
    assert.deepStrictEqual(calls[1], ["show", {
      sessionId: localSessionKey("codex:s1"),
      callId: "call_1",
      questions: request.questions,
      autoResolutionMs: null,
      ...extra,
    }]);
    assert.strictEqual(calls[2][0], "update");
    assert.strictEqual(calls[2][2], "notification");
    assert.strictEqual(calls[2][3], "CodexUserInputRequest");
    assert.strictEqual(calls[2][4].profileId, "local");
    assert.strictEqual(calls[2][4].rawSessionId, "codex:s1");
    assert.strictEqual(calls[2][4].transientPermissionEvent, true);
    assert.strictEqual(calls[2][4].recapSuppressed, true);
    assert.deepStrictEqual(calls[3], expectedTouch);
    assert.deepStrictEqual(calls[4], [
      "clear",
      localSessionKey("codex:s1"),
      "call_1",
      "codex-user-input-resolved",
    ]);

    // turn_aborted/task_complete use the same card callback for passive
    // cleanup, but must not refresh or revive lifecycle activity.
    monitor.options.onUserInputResolved("codex:s1", "call_2", {
      source: "turn-terminal",
      reason: "turn-aborted",
    });
    assert.deepStrictEqual(calls[5], [
      "clear",
      localSessionKey("codex:s1"),
      "call_2",
      "codex-user-input-resolved",
    ]);
  });

  it("handles JSONL token_count as metadata without clearing bubbles or changing state", () => {
    const instances = [];
    const calls = [];
    const metadataCalls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      getStateRuntime: () => ({
        updateSessionMetadata: (...args) => metadataCalls.push(args),
      }),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();

    monitor.emit("codex:abc", "working", "event_msg:token_count", {
      cwd: "D:\\repo",
      contextUsage: {
        used: 23959,
        limit: 258400,
        percent: 9,
        source: "codex",
      },
    });

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(metadataCalls, [[
      localSessionKey("codex:abc"),
      {
        contextUsage: {
          used: 23959,
          limit: 258400,
          percent: 9,
          source: "codex",
        },
      },
    ]]);
  });

  it("routes JSONL generic and Spark quota to the account store, never updateSession opts", () => {
    const instances = [];
    const calls = [];
    const quotaCalls = [];
    const metadataCalls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
      getStateRuntime: () => ({
        updateAccountQuota: (...args) => quotaCalls.push(args),
        updateSessionMetadata: (...args) => metadataCalls.push(args),
      }),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();

    const codexQuota = {
      codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
      codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
    };
    const codexSparkQuota = {
      codexWeekly: { usedPercent: 7, resetAt: 1784256370000 },
    };
    monitor.emit("codex:abc", "working", "event_msg:token_count", {
      cwd: "D:\\repo",
      contextUsage: { used: 23959, limit: 258400, percent: 9, source: "codex" },
      codexQuota,
      codexSparkQuota,
    });
    // Quota-only refresh (no contextUsage): must not enter the updateSession
    // lifecycle machine at all, only feed the store.
    monitor.emit("codex:abc", "working", "event_msg:token_count", { codexSparkQuota });

    // updateSession must never see account quota in its opts.
    for (const call of calls) {
      if (call[0] !== "update") continue;
      assert.strictEqual(Object.prototype.hasOwnProperty.call(call[4], "codexQuota"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(call[4], "codexSparkQuota"), false);
    }
    assert.strictEqual(calls.filter((c) => c[0] === "update").length, 0);
    assert.deepStrictEqual(metadataCalls, [[
      localSessionKey("codex:abc"),
      { contextUsage: { used: 23959, limit: 258400, percent: 9, source: "codex" } },
    ]]);
    // Local monitor reports as the local source (null host).
    assert.deepStrictEqual(quotaCalls, [
      [null, { codexQuota, codexSparkQuota }],
      [null, { codexSparkQuota }],
    ]);
  });

  it("captures Ghostty terminal id for foreground session-start events", () => {
    const updates = [];
    const focusUpdates = [];
    const captures = [];
    const runtime = createAgentRuntimeMain({
      updateSession: (...args) => updates.push(args),
      getStateRuntime: () => ({
        updateSessionFocusMetadata: (...args) => focusUpdates.push(args),
      }),
      captureGhosttyTerminalId: (request, callback) => {
        captures.push(request);
        callback("ghostty-term-42");
        return true;
      },
      codexSubagentClassifier: {},
    });

    runtime.updateSessionFromServer("sid", "thinking", "UserPromptSubmit", {
      agentId: "claude-code",
      sourcePid: 1234,
      cwd: "/repo",
    });
    runtime.updateSessionFromServer("remote", "thinking", "UserPromptSubmit", {
      agentId: "claude-code",
      sourcePid: 1235,
      host: "remote-box",
    });
    runtime.updateSessionFromServer("tool", "working", "PreToolUse", {
      agentId: "claude-code",
      sourcePid: 1236,
    });

    assert.deepStrictEqual(updates.map((call) => call[0]), ["sid", "remote", "tool"]);
    assert.deepStrictEqual(captures, [{ sourcePid: 1234, cwd: "/repo" }]);
    assert.deepStrictEqual(focusUpdates, [["sid", {
      sourcePid: 1234,
      ghosttyTerminalId: "ghostty-term-42",
    }]]);
  });

  it("maps Codex JSONL monitor state callbacks through the main runtime effects", () => {
    const instances = [];
    const calls = [];
    const classifier = { classify: () => null };
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: classifier,
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
    });

    const monitor = runtime.startCodexLogMonitor();

    assert.equal(monitor, instances[0]);
    assert.equal(monitor.started, 1);
    assert.deepStrictEqual(monitor.agent, { id: "codex" });
    assert.notEqual(monitor.options.classifier, classifier);

    monitor.emit("sid", "working", "response_item:web_search_call", {
      cwd: "D:\\repo",
      sessionTitle: "Run tests",
      headless: true,
    });

    assert.deepStrictEqual(calls, [
      ["clear", localSessionKey("sid"), "codex-state-transition:working"],
      ["update", localSessionKey("sid"), "working", "response_item:web_search_call", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: "Run tests",
        recapIsSubagent: true,
        recapSuppressed: true,
        headless: true,
        profileId: "local",
        rawSessionId: "sid",
      }],
    ]);
  });

  it("records late WebSearch boundaries without reviving an officially completed turn", () => {
    const instances = [];
    const updates = [];
    const recapOnly = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: (agentId) => agentId === "codex",
      getStateRuntime: () => ({
        recordRecapEventOnly: (input) => { recapOnly.push(input); return true; },
      }),
      updateSession: (...args) => updates.push(args),
    });
    const monitor = runtime.startCodexLogMonitor();
    const sessionId = localSessionKey("sid");
    const officialOptions = {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      rawSessionId: "sid",
      turnId: "turn-web",
    };
    runtime.updateSessionFromServer(sessionId, "thinking", "UserPromptSubmit", officialOptions);
    runtime.updateSessionFromServer(sessionId, "attention", "Stop", officialOptions);

    monitor.emit("sid", "working", "response_item:function_call", {
      turnId: "turn-web",
      recapOccurredAt: 1234,
      recapIsWebSearch: true,
      toolUseId: "search-1",
    });
    monitor.emit("sid", "working", "response_item:web_search_call", {
      turnId: "turn-web",
      recapOccurredAt: 1235,
      toolUseId: "search-1",
    });
    monitor.emit("sid", "working", "response_item:function_call", {
      turnId: "turn-web",
      recapOccurredAt: 1236,
      toolUseId: "shell-1",
    });

    const idlessSessionId = localSessionKey("sid-idless");
    const idlessOfficialOptions = {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      rawSessionId: "sid-idless",
      turnId: null,
    };
    runtime.updateSessionFromServer(
      idlessSessionId,
      "thinking",
      "UserPromptSubmit",
      idlessOfficialOptions
    );
    runtime.updateSessionFromServer(
      idlessSessionId,
      "attention",
      "Stop",
      idlessOfficialOptions
    );
    monitor.emit("sid-idless", "working", "response_item:function_call", {
      recapOccurredAt: 2234,
      recapIsWebSearch: true,
      toolUseId: "search-idless",
    });
    monitor.emit("sid-idless", "working", "response_item:web_search_call", {
      recapOccurredAt: 2235,
      toolUseId: "search-idless",
    });

    assert.deepStrictEqual(updates.map((call) => call[2]), [
      "UserPromptSubmit",
      "Stop",
      "UserPromptSubmit",
      "Stop",
    ]);
    assert.deepStrictEqual(recapOnly.map((input) => [input.event, input.toolUseId]), [
      ["response_item:function_call", "search-1"],
      ["response_item:web_search_call", "search-1"],
      ["response_item:function_call", "search-idless"],
      ["response_item:web_search_call", "search-idless"],
    ]);
    assert.ok(recapOnly.every((input) => !Object.hasOwn(input, "recapIsWebSearch")));
  });

  it("shares canonical classifier identity from local JSONL to official hooks without leaking to remote profiles", () => {
    const instances = [];
    const classifier = new CodexSubagentClassifier();
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: classifier,
      isAgentEnabled: () => false,
    });
    const monitor = runtime.startCodexLogMonitor();
    const rawSessionId = "codex:shared";
    const localId = localSessionKey(rawSessionId);
    const remoteId = makeSessionKey({ profileId: "profile-a", rawSessionId });

    assert.strictEqual(monitor.options.classifier.registerSession(rawSessionId, {
      sessionMeta: { source: { subagent: { thread_spawn: { agent_role: "explorer" } } } },
    }), "subagent");
    assert.strictEqual(classifier.classify(localId), "subagent");

    const payload = {
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: rawSessionId,
    };
    assert.deepStrictEqual(
      resolveCodexOfficialHookState(payload, "idle", new Map(), classifier, localId),
      { state: "idle", drop: false, headless: true }
    );
    assert.deepStrictEqual(
      resolveCodexOfficialHookState(payload, "idle", new Map(), classifier, remoteId),
      { state: "idle", drop: false }
    );
  });

  it("starts and stops the Codex monitor through agent gate hooks and cleanup", () => {
    const instances = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => false,
    });

    const monitor = runtime.startCodexLogMonitor();

    assert.equal(monitor.started, 0);
    runtime.startMonitorForAgent("claude-code");
    runtime.stopMonitorForAgent("claude-code");
    assert.equal(monitor.started, 0);
    assert.equal(monitor.stopped, 0);

    runtime.startMonitorForAgent("codex");
    runtime.stopMonitorForAgent("codex");
    runtime.cleanup();

    assert.equal(monitor.started, 1);
    assert.equal(monitor.stopped, 2);
  });

  it("delegates integration repair and sync calls to the server when available", () => {
    const calls = [];
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getServer: () => ({
        syncIntegrationForAgent: (agentId) => {
          calls.push(["sync", agentId]);
          return "synced";
        },
        repairIntegrationForAgent: (agentId, options) => {
          calls.push(["repair", agentId, options]);
          return "repaired";
        },
        stopIntegrationForAgent: (agentId) => {
          calls.push(["stop", agentId]);
          return "stopped";
        },
      }),
    });
    const missingServerRuntime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getServer: () => null,
    });

    assert.equal(runtime.syncIntegrationForAgent("codex"), "synced");
    assert.equal(runtime.repairIntegrationForAgent("codex", { force: true }), "repaired");
    assert.equal(runtime.stopIntegrationForAgent("codex"), "stopped");
    assert.deepStrictEqual(calls, [
      ["sync", "codex"],
      ["repair", "codex", { force: true }],
      ["stop", "codex"],
    ]);
    assert.equal(missingServerRuntime.syncIntegrationForAgent("codex"), false);
    assert.equal(missingServerRuntime.repairIntegrationForAgent("codex"), false);
    assert.equal(missingServerRuntime.stopIntegrationForAgent("codex"), false);
  });

  it("clears sessions and releases Kimi permission state when an agent is disabled", () => {
    const calls = [];
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getPermissionRuntime: () => ({
        dismissPermissionsByAgent: (agentId) => {
          calls.push(["dismiss", agentId]);
          return 3;
        },
      }),
      getStateRuntime: () => ({
        clearSessionsByAgent: (agentId) => {
          calls.push(["clear", agentId]);
          return 2;
        },
        disposeAllKimiPermissionState: () => {
          calls.push(["disposeKimi"]);
          return true;
        },
        resolveDisplayState: () => {
          calls.push(["resolve"]);
          return "idle";
        },
        getSvgOverride: (state) => `svg:${state}`,
        setState: (state, svg) => calls.push(["setState", state, svg]),
      }),
    });

    assert.equal(runtime.clearSessionsByAgent("kimi-cli"), 2);
    assert.equal(runtime.dismissPermissionsByAgent("kimi-cli"), 3);
    assert.deepStrictEqual(calls, [
      ["clear", "kimi-cli"],
      ["dismiss", "kimi-cli"],
      ["disposeKimi"],
      ["resolve"],
      ["setState", "idle", "svg:idle"],
    ]);
  });

  it("rescues a stuck local Codex turn with JSONL task_complete while suppressing other covered events", () => {
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
    });

    // Official hooks were active this turn, but the official Stop never arrived,
    // so the session is still shown as working-like.
    runtime.markCodexOfficialHookSession(localSessionKey("codex:s1"));
    sessions.set(localSessionKey("codex:s1"), { agentId: "codex", state: "working" });

    // task_complete from JSONL is allowed through to close the turn (attention
    // when the turn used tools, idle when it did not).
    assert.equal(
      runtime.shouldSuppressCodexLogEvent(localSessionKey("codex:s1"), "attention", "event_msg:task_complete"),
      false
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent(localSessionKey("codex:s1"), "idle", "event_msg:task_complete"),
      false
    );

    // Every other covered JSONL event stays suppressed under recent official hooks.
    assert.equal(
      runtime.shouldSuppressCodexLogEvent(localSessionKey("codex:s1"), "working", "event_msg:task_started"),
      true
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent(localSessionKey("codex:s1"), "attention", "event_msg:exec_command_end"),
      true
    );
  });

  it("treats every working-like state as a rescuable local Codex turn", () => {
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
    });
    runtime.markCodexOfficialHookSession("codex:s1");

    for (const workingLike of ["working", "thinking", "juggling"]) {
      sessions.set("codex:s1", { agentId: "codex", state: workingLike });
      assert.equal(
        runtime.shouldSuppressCodexLogEvent("codex:s1", "idle", "event_msg:task_complete"),
        false,
        `expected ${workingLike} session to allow the JSONL completion fallback`
      );
    }
  });

  it("keeps suppressing JSONL task_complete once the official Stop has idled the session", () => {
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
    });
    runtime.markCodexOfficialHookSession("codex:s1");

    // Official Stop already closed the turn → no longer working-like.
    sessions.set(localSessionKey("codex:s1"), { agentId: "codex", state: "idle" });
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "attention", "event_msg:task_complete"),
      true
    );

    // A session that has moved on to a fresh non-working state is not rescued either.
    sessions.set("codex:s1", { agentId: "codex", state: "attention" });
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "idle", "event_msg:task_complete"),
      true
    );
  });

  it("does not apply the JSONL completion fallback to remote or headless Codex sessions", () => {
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
    });
    runtime.markCodexOfficialHookSession("codex:remote");
    runtime.markCodexOfficialHookSession("codex:headless");

    sessions.set("codex:remote", { agentId: "codex", state: "working", host: "ssh:example" });
    sessions.set("codex:headless", { agentId: "codex", state: "working", headless: true });

    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:remote", "idle", "event_msg:task_complete"),
      true
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:headless", "attention", "event_msg:task_complete"),
      true
    );
  });

  it("only rescues known local Codex sessions, and never suppresses without recent official hooks", () => {
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
    });
    runtime.markCodexOfficialHookSession("codex:s1");

    // Recent official hook, but the state runtime has no entry for the session.
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "idle", "event_msg:task_complete"),
      true
    );

    // Recent official hook, but the session belongs to a different agent.
    sessions.set("codex:s1", { agentId: "claude-code", state: "working" });
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "idle", "event_msg:task_complete"),
      true
    );

    // No official hook seen for this session: JSONL is the only completion source,
    // so it must not be suppressed regardless of working-like state.
    sessions.set("codex:s2", { agentId: "codex", state: "working" });
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s2", "idle", "event_msg:task_complete"),
      false
    );
  });

  it("lets the JSONL monitor close a stuck local Codex turn, then suppresses the duplicate", () => {
    const instances = [];
    const calls = [];
    const sessions = new Map();
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: (agentId) => agentId === "codex",
      getStateRuntime: () => ({ sessions }),
      updateSession: (...args) => calls.push(["update", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
    });

    const monitor = runtime.startCodexLogMonitor();

    // Recent official hook activity + a still-working local Codex session whose
    // official Stop never arrived.
    runtime.markCodexOfficialHookSession(localSessionKey("codex:s1"));
    sessions.set(localSessionKey("codex:s1"), { agentId: "codex", state: "working" });

    monitor.emit("codex:s1", "idle", "event_msg:task_complete", {
      cwd: "D:\\repo",
      sessionTitle: "Codex turn",
    });

    assert.deepStrictEqual(calls, [
      ["clear", localSessionKey("codex:s1"), "codex-state-transition:idle"],
      ["update", localSessionKey("codex:s1"), "idle", "event_msg:task_complete", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: "Codex turn",
        recapSuppressed: true,
        headless: false,
        profileId: "local",
        rawSessionId: "codex:s1",
      }],
    ]);

    // The fallback idled the turn; a duplicate JSONL task_complete is now dropped
    // so there is no double done/celebration.
    calls.length = 0;
    sessions.set(localSessionKey("codex:s1"), { agentId: "codex", state: "idle" });
    monitor.emit("codex:s1", "idle", "event_msg:task_complete", {
      cwd: "D:\\repo",
      sessionTitle: "Codex turn",
    });
    assert.deepStrictEqual(calls, []);
  });

  it("fences a late official tail after a JSONL terminal and immediately admits turn B", () => {
    const instances = [];
    const updates = [];
    const clears = [];
    const sessions = new Map();
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => true,
      getStateRuntime: () => ({ sessions }),
      updateSession: (...args) => updates.push(args),
      clearCodexNotifyBubbles: (...args) => clears.push(args),
    });
    const monitor = runtime.startCodexLogMonitor();
    const sessionId = localSessionKey("codex:s1");
    const official = (state, event, turnId) => runtime.updateSessionFromServer(sessionId, state, event, {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      rawSessionId: "codex:s1",
      turnId,
    });

    official("thinking", "UserPromptSubmit", "A");
    monitor.emit("codex:s1", "idle", "event_msg:turn_aborted", { turnId: "A" });
    assert.strictEqual(official("working", "PostToolUse", "A"), false);
    assert.deepStrictEqual(updates.map((call) => [call[1], call[2]]), [
      ["thinking", "UserPromptSubmit"],
      ["idle", "event_msg:turn_aborted"],
    ]);

    assert.notStrictEqual(official("thinking", "UserPromptSubmit", "B"), false);
    assert.notStrictEqual(official("working", "PreToolUse", "B"), false);
    assert.deepStrictEqual(updates.slice(-2).map((call) => [call[1], call[2]]), [
      ["thinking", "UserPromptSubmit"],
      ["working", "PreToolUse"],
    ]);

    // A fenced JSONL tail is rejected before notification bubbles are cleared.
    const clearCount = clears.length;
    monitor.emit("codex:s1", "working", "response_item:function_call", { turnId: "A" });
    assert.strictEqual(clears.length, clearCount);
  });

  it("applies one completion for official Stop plus duplicate JSONL terminal", () => {
    const instances = [];
    const updates = [];
    const sessions = new Map();
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => true,
      getStateRuntime: () => ({ sessions }),
      updateSession: (...args) => updates.push(args),
    });
    const monitor = runtime.startCodexLogMonitor();
    const sessionId = localSessionKey("codex:s1");
    const opts = {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      turnId: "A",
    };
    runtime.updateSessionFromServer(sessionId, "thinking", "UserPromptSubmit", opts);
    runtime.updateSessionFromServer(sessionId, "attention", "Stop", opts);
    sessions.set(sessionId, { agentId: "codex", state: "attention" });
    monitor.emit("codex:s1", "attention", "event_msg:task_complete", { turnId: "A" });

    assert.deepStrictEqual(updates.map((call) => call[2]), ["UserPromptSubmit", "Stop"]);
  });

  it("produces one real state completion for official Stop plus duplicate JSONL terminal", () => {
    const instances = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const harness = makeRealStateHarness();
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => true,
      getStateRuntime: () => harness.state,
      updateSession: (...args) => harness.state.updateSession(...args),
    });
    try {
      const monitor = runtime.startCodexLogMonitor();
      const rawSessionId = "codex:real-state-completion";
      const sessionId = localSessionKey(rawSessionId);
      const opts = {
        agentId: "codex",
        hookSource: "codex-official",
        profileId: "local",
        rawSessionId,
        sourcePid: 42,
        turnId: "A",
      };

      runtime.updateSessionFromServer(sessionId, "thinking", "UserPromptSubmit", opts);
      runtime.updateSessionFromServer(sessionId, "attention", "Stop", opts);
      monitor.emit(rawSessionId, "attention", "event_msg:task_complete", { turnId: "A" });

      const session = harness.state.sessions.get(sessionId);
      assert.ok(session);
      assert.strictEqual(harness.sounds.filter((name) => name === "complete").length, 1);
      assert.strictEqual(harness.stateChanges.filter((name) => name === "attention").length, 1);
      assert.strictEqual(
        session.recentEvents.filter((entry) => entry.event === "Stop" || entry.event === "event_msg:task_complete").length,
        1
      );
      assert.strictEqual(session.state, "idle");
    } finally {
      runtime.cleanup();
      harness.state.cleanup();
    }
  });

  it("upgrades an ID-less idle terminal to one real completion when the ID-bearing Stop arrives", () => {
    const harness = makeRealStateHarness();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => harness.state,
      updateSession: (...args) => harness.state.updateSession(...args),
    });
    try {
      const rawSessionId = "codex:idless-completion-upgrade";
      const sessionId = localSessionKey(rawSessionId);
      const base = {
        agentId: "codex",
        hookSource: "codex-official",
        profileId: "local",
        rawSessionId,
        sourcePid: 42,
      };

      runtime.updateSessionFromServer(sessionId, "thinking", "UserPromptSubmit", {
        ...base,
        turnId: "B",
      });
      assert.notStrictEqual(
        runtime.updateSessionFromServer(sessionId, "idle", "Stop", { ...base, turnId: null }),
        false
      );
      assert.notStrictEqual(
        runtime.updateSessionFromServer(sessionId, "attention", "Stop", { ...base, turnId: "B" }),
        false
      );
      assert.strictEqual(
        runtime.updateSessionFromServer(sessionId, "attention", "Stop", { ...base, turnId: "B" }),
        false
      );

      const session = harness.state.sessions.get(sessionId);
      const completionEvents = session.recentEvents.filter((entry) => entry.event === "Stop");
      assert.strictEqual(harness.sounds.filter((name) => name === "complete").length, 1);
      assert.strictEqual(harness.stateChanges.filter((name) => name === "attention").length, 1);
      assert.strictEqual(completionEvents.length, 1);
      assert.strictEqual(completionEvents[0].state, "attention");
      assert.deepStrictEqual(runtime.getCodexTurnFenceSnapshot(sessionId).closedTurnIds, ["B"]);
    } finally {
      runtime.cleanup();
      harness.state.cleanup();
    }
  });

  it("keeps token telemetry outside liveness and restores stale-idled work on the next lifecycle event", () => {
    const instances = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const harness = makeRealStateHarness();
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => true,
      getStateRuntime: () => harness.state,
      updateSession: (...args) => harness.state.updateSession(...args),
    });
    try {
      const monitor = runtime.startCodexLogMonitor();
      const rawSessionId = "codex:real-state-metadata";
      const sessionId = localSessionKey(rawSessionId);
      const lifecycleOpts = {
        agentId: "codex",
        hookSource: "codex-official",
        profileId: "local",
        rawSessionId,
        sourcePid: 42,
        cwd: "D:\\repo",
        sessionTitle: "Lifecycle title",
        codexOriginator: "codex_work_desktop",
        turnId: "A",
      };

      runtime.updateSessionFromServer(sessionId, "working", "UserPromptSubmit", lifecycleOpts);
      const staleUpdatedAt = Date.now() - CODEX_LOCAL_WORKING_STALE_FLOOR_MS - 1_000;
      const before = harness.state.sessions.get(sessionId);
      before.updatedAt = staleUpdatedAt;
      assert.strictEqual(before.pidReachable, true);

      monitor.emit(rawSessionId, "working", "event_msg:token_count", {
        contextUsage: { used: 123, limit: 1_000, percent: 12, source: "codex" },
        // Metadata-only traffic must not gain lifecycle ownership of these.
        cwd: "D:\\wrong",
        sessionTitle: "Wrong title",
        codexOriginator: "codex_exec",
        sourcePid: 999,
        turnId: "A",
      });

      const afterMetadata = harness.state.sessions.get(sessionId);
      assert.strictEqual(afterMetadata.updatedAt, staleUpdatedAt);
      assert.ok(afterMetadata.metadataUpdatedAt > staleUpdatedAt);
      assert.deepStrictEqual(afterMetadata.contextUsage, {
        used: 123,
        limit: 1_000,
        percent: 12,
        source: "codex",
      });
      assert.strictEqual(afterMetadata.cwd, "D:\\repo");
      assert.strictEqual(afterMetadata.sessionTitle, "Lifecycle title");
      assert.strictEqual(afterMetadata.codexOriginator, "codex_work_desktop");
      assert.strictEqual(afterMetadata.sourcePid, 42);

      harness.state.cleanStaleSessions();
      const afterStaleSweep = harness.state.sessions.get(sessionId);
      assert.strictEqual(afterStaleSweep.state, "idle");
      assert.ok(afterStaleSweep.updatedAt > staleUpdatedAt);

      runtime.updateSessionFromServer(sessionId, "working", "UserPromptSubmit", {
        ...lifecycleOpts,
        turnId: "B",
      });
      const restored = harness.state.sessions.get(sessionId);
      assert.strictEqual(restored.state, "working");
      assert.ok(restored.updatedAt > staleUpdatedAt);
      assert.strictEqual(restored.codexOriginator, "codex_work_desktop");
    } finally {
      runtime.cleanup();
      harness.state.cleanup();
    }
  });

  it("keeps official suppression turn-aware while retaining ID-less compatibility", () => {
    const runtime = createAgentRuntimeMain({ codexSubagentClassifier: {} });
    runtime.markCodexOfficialHookSession("codex:s1", "A");
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "working", "response_item:function_call", "A"),
      true
    );
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "working", "response_item:function_call", "B"),
      false
    );
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "working", "response_item:function_call", null),
      true
    );
    runtime.markCodexOfficialHookSession("codex:s1", null);
    assert.strictEqual(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "working", "response_item:function_call", "B"),
      true
    );
  });

  it("keeps exact JSONL completion rescue and distinct-turn fallback working", () => {
    const instances = [];
    const updates = [];
    const sessions = new Map();
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => true,
      getStateRuntime: () => ({ sessions }),
      updateSession: (...args) => updates.push(args),
    });
    const monitor = runtime.startCodexLogMonitor();
    const sessionId = localSessionKey("codex:s1");
    const official = (state, event, turnId) => runtime.updateSessionFromServer(sessionId, state, event, {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "local",
      turnId,
    });

    official("thinking", "UserPromptSubmit", "A");
    sessions.set(sessionId, { agentId: "codex", state: "working", host: null, headless: false });
    monitor.emit("codex:s1", "attention", "event_msg:task_complete", { turnId: "A" });
    assert.deepStrictEqual(updates.map((call) => call[2]), ["UserPromptSubmit", "event_msg:task_complete"]);

    // A late official tail refreshes only A's exact suppression mark. B's
    // fallback start and work remain visible if its official hooks are absent.
    official("working", "PostToolUse", "A");
    monitor.emit("codex:s1", "thinking", "event_msg:task_started", { turnId: "B" });
    monitor.emit("codex:s1", "working", "response_item:function_call", { turnId: "B" });
    assert.deepStrictEqual(updates.slice(-2).map((call) => call[2]), [
      "event_msg:task_started",
      "response_item:function_call",
    ]);
  });

  it("bypasses the local fence for remote official hooks and resets tracking on Codex clear", () => {
    const updates = [];
    const clearCalls = [];
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      updateSession: (...args) => updates.push(args),
      getStateRuntime: () => ({
        clearSessionsByAgent: (...args) => { clearCalls.push(args); return 1; },
      }),
    });

    const remoteOpts = {
      agentId: "codex",
      hookSource: "codex-official",
      profileId: "remote-box",
      turnId: "A",
    };
    runtime.updateSessionFromServer("remote-session", "idle", "Stop", remoteOpts);
    runtime.updateSessionFromServer("remote-session", "working", "PostToolUse", remoteOpts);
    assert.deepStrictEqual(updates.map((call) => call[2]), ["Stop", "PostToolUse"]);

    const localOpts = { ...remoteOpts, profileId: "local" };
    runtime.updateSessionFromServer("local-session", "idle", "Stop", localOpts);
    assert.ok(runtime.getCodexTurnFenceSnapshot("local-session"));
    assert.ok(runtime.getCodexOfficialActivitySnapshot("local-session"));
    assert.strictEqual(runtime.clearSessionsByAgent("codex"), 1);
    assert.strictEqual(runtime.getCodexTurnFenceSnapshot("local-session"), null);
    assert.strictEqual(runtime.getCodexOfficialActivitySnapshot("local-session"), null);
    assert.deepStrictEqual(clearCalls, [["codex"]]);
  });
});
