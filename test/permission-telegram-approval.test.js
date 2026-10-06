"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");
const { FeishuApprovalClient } = require("../src/feishu-approval-client");
const { prepareElicitationToolInput } = require("../src/server-permission-utils");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: "",
    ended: false,
    destroyCalls: 0,
    listeners: {},
  };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status, headers) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body += String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    destroy() {
      captured.destroyCalls += 1;
      this.destroyed = true;
    },
    on(evt, fn) {
      (captured.listeners[evt] = captured.listeners[evt] || []).push(fn);
    },
    removeListener(evt, fn) {
      const listeners = captured.listeners[evt] || [];
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map([["sid", { cwd: "D:\\work\\project-alpha" }]]),
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    ...overrides,
  };
}

function makePermEntry(overrides = {}) {
  const entry = {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "sid",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    // Default fixture carries a description so behaviour tests can exercise
    // the remote-approval lifecycle. Cases that want to prove the no-summary
    // guard explicitly clear toolInput.description.
    toolInput: {
      command: "npm test -- --token sk-1234567890123456",
      description: "Run project tests",
    },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
  entry.interaction = entry.interaction || classifyPermissionInteraction({
    agentId: entry.agentId,
    eventKind: entry.isCodexNotify || entry.isKimiNotify ? "notification" : "permission",
    toolName: entry.toolName,
  });
  return entry;
}

describe("permission telegram remote approval", () => {
  it("sends a conservative payload and resolves allow without a message", async () => {
    let resolveApproval;
    const requests = [];
    const resolved = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload, options) => {
        requests.push({ payload, options });
        return new Promise((resolve) => { resolveApproval = resolve; });
      },
    };
    const perm = initPermission(makeCtx({
      getTelegramApprovalClient: () => client,
      onPermissionResolved: (entry, meta) => resolved.push({ entry, meta }),
    }));
    const entry = makePermEntry({
      toolInput: {
        command: "npm test -- --token sk-1234567890123456",
        description: "Run project tests for chat 987654321 and telegram:123456789",
      },
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].payload.title, /claude-code requests Bash/);
    assert.match(requests[0].payload.detail, /Agent: claude-code/);
    assert.match(requests[0].payload.detail, /Tool: Bash/);
    assert.match(requests[0].payload.detail, /Folder: project-alpha/);
    assert.match(requests[0].payload.detail, /Summary: Run project tests/);
    assert.deepEqual(requests[0].payload.fields, [
      { label: "Agent", value: "claude-code" },
      { label: "Tool", value: "Bash" },
      { label: "Folder", value: "project-alpha" },
      { label: "Summary", value: "Run project tests for chat <redacted:id> and <redacted:id>" },
    ]);
    assert.equal(requests[0].payload.detail.includes("npm test"), false);
    assert.equal(requests[0].payload.detail.includes("sk-1234567890123456"), false);
    assert.equal(requests[0].payload.detail.includes("987654321"), false);
    assert.equal(requests[0].payload.detail.includes("telegram:123456789"), false);
    assert.equal(JSON.stringify(requests[0].payload.fields).includes("sk-1234567890123456"), false);

    resolveApproval("allow");
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].entry, entry);
    assert.deepEqual(resolved[0].meta, {
      reason: "resolved",
      hasPendingForSession: false,
    });
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "allow" });
  });

  it("turns Telegram suggestion decisions into updatedPermissions for rich agents", async () => {
    let resolveApproval;
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload, options) => {
        requests.push({ payload, options });
        return new Promise((resolve) => { resolveApproval = resolve; });
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const suggestion = {
      type: "addRules",
      destination: "localSettings",
      behavior: "allow",
      rules: [{ toolName: "Bash", ruleContent: "npm test" }],
    };
    const entry = makePermEntry({
      suggestions: [
        suggestion,
        { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
      ],
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].payload.suggestions, [
      { index: 0, label: "Always Bash" },
      { index: 1, label: "Auto edits" },
    ]);

    resolveApproval({ action: "suggestion", index: 0 });
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, {
      behavior: "allow",
      updatedPermissions: [suggestion],
    });
  });

  it("keeps legacy remote deny strings working", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve("deny"),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "deny" });
  });

  it("leaves the local permission pending on remote timeout or errors", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve(null),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(entry.res.captured.ended, false);
  });

  it("does not expose or accept rich suggestions for unsupported agents", async () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return Promise.resolve({ action: "suggestion", index: 0 });
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry({
      agentId: "codex",
      isCodex: true,
      suggestions: [{ type: "setMode", mode: "default", destination: "localSettings" }],
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(Object.prototype.hasOwnProperty.call(requests[0], "suggestions"), false);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(entry.res.captured.ended, false);
  });

  it("ignores stale Telegram decisions after the local permission resolves first", async () => {
    let resolveApproval;
    const client = {
      isEnabled: () => true,
      requestApproval: () => new Promise((resolve) => { resolveApproval = resolve; }),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry({
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "localSettings" }],
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    perm.resolvePermissionEntry(entry, "deny");
    const bodyBeforeRemote = entry.res.captured.body;

    resolveApproval({ action: "suggestion", index: 0 });
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(entry.res.captured.body, bodyBeforeRemote);
    assert.deepEqual(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision, { behavior: "deny" });
  });

  it("ignores invalid Telegram suggestion indexes for rich agents without resolving locally", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve({ action: "suggestion", index: 9 }),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry({
      agentId: "codebuddy",
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "localSettings" }],
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(entry.res.captured.ended, false);
    assert.equal(entry.resolvedSuggestion, null);
  });

  it("aborts the remote request when the local permission resolves first", async () => {
    let signal;
    const client = {
      isEnabled: () => true,
      requestApproval: (_payload, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(signal.aborted, false);

    perm.resolvePermissionEntry(entry, "deny");

    assert.equal(signal.aborted, true);
    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "deny" });
  });

  it("does not start remote approval for non-actionable entries", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return Promise.resolve("allow");
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entries = [
      makePermEntry({ isElicitation: true, toolName: "AskUserQuestion" }),
      makePermEntry({ isCodexNotify: true }),
      makePermEntry({ isKimiNotify: true }),
      makePermEntry({ agentId: "opencode" }),
      makePermEntry({ isAntigravity: true, agentId: "antigravity-cli" }),
      makePermEntry({ toolName: "ExitPlanMode" }),
      makePermEntry({ toolName: "AskUserQuestion" }),
      makePermEntry({ toolName: "TaskList" }),
    ];

    for (const entry of entries) {
      assert.equal(perm.maybeStartRemoteApproval(entry), false, entry.toolName);
    }
    assert.deepEqual(requests, []);
  });

  it("starts Feishu elicitation and submits returned answers to Claude Code", async () => {
    let resolveElicitation;
    const requests = [];
    const feishuClient = {
      isEnabled: () => true,
      requestApproval: () => {
        throw new Error("normal approval should not be used for elicitation");
      },
      requestElicitation: (payload, options) => {
        requests.push({ payload, options });
        return new Promise((resolve) => { resolveElicitation = resolve; });
      },
    };
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [{ name: "feishu", client: feishuClient }] }));
    const entry = makePermEntry({
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          header: "当前任务",
          question: "您当前正在进行什么类型的工作？",
          options: [{ label: "开发新功能", description: "正在开发新的业务功能或模块" }],
        }],
      },
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.questions[0].question, "您当前正在进行什么类型的工作？");

    // Remote clients key submitted answers by the question's index in
    // toolInput.questions (their display text is clamped and can't round-trip);
    // the hook response must still carry original-text keys for the agent.
    resolveElicitation({
      type: "elicitation-submit",
      answers: {
        "0": "开发新功能\n正在开发新的业务功能或模块",
      },
    });
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, {
      behavior: "allow",
      updatedInput: {
        questions: entry.toolInput.questions,
        answers: {
          "您当前正在进行什么类型的工作？": "开发新功能\n正在开发新的业务功能或模块",
        },
      },
    });
  });

  it("maps indexed remote answers back to server-normalized question keys", async () => {
    let resolveElicitation;
    const requests = [];
    const remoteClient = {
      isEnabled: () => true,
      requestApproval: () => {
        throw new Error("normal approval should not be used for elicitation");
      },
      requestElicitation: (payload, options) => {
        requests.push({ payload, options });
        return new Promise((resolve) => { resolveElicitation = resolve; });
      },
    };
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client: remoteClient }] }));
    // Exercise the same normalization performed by /permission before the
    // request reaches permission.js. Q1 is clamped server-side; Q2 keeps its
    // internal CRLF/line-end spaces there, while Telegram rewrites both for
    // display. Index keys must survive either transformation.
    const rawLongQuestion = `请从以下部署方案中选择一个：${"细".repeat(300)}`;
    const rawCrlfQuestion = "第一行  \r\n第二行  ";
    const rawInput = {
      questions: [
        { question: rawLongQuestion, options: [{ label: "方案A" }] },
        { question: rawCrlfQuestion, options: [{ label: "继续" }] },
      ],
    };
    const prepared = prepareElicitationToolInput(rawInput);
    const displayInput = prepared.displayInput;
    assert.equal(prepared.canAnswer, true);
    assert.notEqual(displayInput.questions[0].question, rawLongQuestion);
    assert.equal(displayInput.questions[0].question.length, 240);
    assert.equal(displayInput.questions[1].question, "第一行  \r\n第二行");
    const entry = makePermEntry({
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: displayInput,
      elicitationWireInput: prepared.wireInput,
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);

    resolveElicitation({
      type: "elicitation-submit",
      answers: { "0": "方案A", "1": "继续" },
    });
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, {
      behavior: "allow",
      updatedInput: {
        questions: rawInput.questions,
        answers: {
          [rawLongQuestion]: "方案A",
          [rawCrlfQuestion]: "继续",
        },
      },
    });
  });

  it("routes Hermes elicitation go-to-terminal to the native no-decision fallback", async () => {
    let resolveElicitation;
    const focusCalls = [];
    const feishuClient = {
      isEnabled: () => true,
      requestApproval: () => {
        throw new Error("normal approval should not be used for elicitation");
      },
      requestElicitation: () => new Promise((resolve) => { resolveElicitation = resolve; }),
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client: feishuClient }],
      focusTerminalForSession: (sessionId) => focusCalls.push(sessionId),
    }));
    const entry = makePermEntry({
      isElicitation: true,
      isHermes: true,
      agentId: "hermes",
      toolName: "clarify",
      toolInput: { questions: [{ question: "Which environment?" }] },
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    resolveElicitation("terminal");
    await flush();
    await flush();

    // Hermes must get a 204 (fall back to its native terminal prompt), not an
    // explicit deny, which it treats as "clarification cancelled".
    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(entry.res.captured.statusCode, 204);
    assert.equal(entry.res.captured.body, "");
    assert.deepEqual(focusCalls, ["sid"]);
  });

  it("keeps deny semantics for Claude elicitation go-to-terminal", async () => {
    let resolveElicitation;
    const feishuClient = {
      isEnabled: () => true,
      requestApproval: () => {
        throw new Error("normal approval should not be used for elicitation");
      },
      requestElicitation: () => new Promise((resolve) => { resolveElicitation = resolve; }),
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client: feishuClient }],
    }));
    const entry = makePermEntry({
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Continue?" }] },
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    resolveElicitation("terminal");
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
  });

  it("updates Feishu card when desktop resolves the permission first", async () => {
    let feishuSignal;
    const updates = [];
    const feishuClient = {
      isEnabled: () => true,
      requestApproval: (_payload, options) => {
        feishuSignal = options.signal;
        return new Promise(() => {});
      },
      resolveApprovalExternally: (signal, outcome) => {
        updates.push({ signal, outcome });
        return true;
      },
    };
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [{ name: "feishu", client: feishuClient }] }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(feishuSignal.aborted, false);

    perm.resolvePermissionEntry(entry, "deny");

    assert.equal(feishuSignal.aborted, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].signal, feishuSignal);
    assert.deepEqual(updates[0].outcome, {
      decision: "deny",
      actionLabel: "拒绝",
      source: "desktop",
    });
  });

  it("keeps the desktop decision and restores the terminal card after a stale Lark click", async () => {
    const sent = [];
    const patches = [];
    let resolveFirstPatch;
    const feishuClient = new FeishuApprovalClient({
      appId: "cli_123",
      appSecret: "secret",
      approverId: "ou_1",
      idType: "open_id",
      terminalCardReplayDelayMs: 0,
      larkClient: {
        im: { v1: { message: {
          create: async (payload) => {
            sent.push(payload);
            return { data: { message_id: "om_permission_race" } };
          },
          patch: async (payload) => {
            patches.push(payload);
            if (patches.length === 1) {
              return new Promise((resolve) => { resolveFirstPatch = resolve; });
            }
            return { data: {} };
          },
        } } },
      },
    });
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client: feishuClient }],
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    const card = JSON.parse(sent[0].data.content);
    const requestId = card.elements[1].actions[2].value.requestId;

    perm.resolvePermissionEntry(entry, "allow");
    assert.equal(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision.behavior, "allow");
    await flush();
    assert.equal(patches.length, 1, "the desktop terminal patch starts first");
    assert.equal(feishuClient.handleCardAction({
      operator: { open_id: "ou_1" },
      action: { value: { requestId, decision: "deny" } },
    }), false, "the late Lark click must not become a second decision");

    resolveFirstPatch({ data: {} });
    await feishuClient.close();
    assert.equal(patches.length, 2, "the stale action queues one terminal replay");
    assert.deepEqual(patches[1], patches[0], "the replay preserves the desktop allow outcome");
  });

  it("sends an approvalSummaryUnavailable card when the tool input lacks a description/summary/reason and no fallback field", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    // Bare Bash payload — only `command`, which is deliberately excluded from
    // the fallback-detail fields (it can carry secrets a generic sanitizer
    // can't reliably catch). With no description/summary/reason and no usable
    // fallback field, the card still goes out, just with an explicit
    // "no description" notice instead of a black-box "Tool input hidden".
    const entry = makePermEntry({
      toolInput: { command: "rm -rf /tmp/scratch" },
    });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].detail, /No description available/);
  });

  it("falls back to no-decision when a remote-only entry's requests all settle without a decision", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.reject(new Error("telegram send failed")),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const res = createMockResponse();
    // bubble === null + remoteOnly: the tryRemoteOnlyApproval shape — no
    // desktop UI exists to answer this entry if Telegram never comes back.
    const entry = makePermEntry({ res, bubble: null, remoteOnly: true });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    // The entry must not linger holding the hook connection open...
    assert.equal(perm.pendingPermissions.length, 0);
    // ...and the fallback is a dropped socket (the agent re-prompts in its
    // own UI), never an explicit deny answered on the user's behalf.
    assert.equal(res.destroyed, true);
    assert.equal(res.captured.statusCode, null);
    assert.equal(res.captured.body, "");
  });

  it("leaves entries with a desktop bubble pending when remote requests settle without a decision", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.reject(new Error("telegram send failed")),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const res = createMockResponse();
    // A visible bubble is still on screen — a Telegram send failure must not
    // tear it down; the user answers on the desktop.
    const entry = makePermEntry({ res, bubble: { isDestroyed: () => true } });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(res.destroyed, false);
  });

  it("treats an unusable suggestion decision as settled-without-decision for remote-only entries", async () => {
    // "suggestion:9" passes the isRemoteApprovalDecision shape check, but the
    // entry has no suggestion at that index — handleRemoteApprovalDecision
    // can't apply it. For a remote-only entry that must still count toward the
    // fallback, or the hook connection would hang until its own timeout.
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve("suggestion:9"),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const res = createMockResponse();
    const entry = makePermEntry({ res, bubble: null, remoteOnly: true, suggestions: [] });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(res.destroyed, true);
    assert.equal(res.captured.body, "");
  });

  it("keeps bubble-having entries pending on an unusable suggestion decision", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve("suggestion:9"),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const res = createMockResponse();
    const entry = makePermEntry({ res, bubble: { isDestroyed: () => true }, suggestions: [] });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(res.destroyed, false);
  });

  it("does not send a Telegram card for headless sessions", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return Promise.resolve("allow");
      },
    };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => client,
      sessions: new Map([["sid", { cwd: "D:\\work\\project-alpha", headless: true }]]),
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(requests, []);
  });

  it("keeps remote approval actionable for audited interactive Codex Agent threads", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => client,
      sessions: new Map([["sid", { cwd: "D:\\work\\project-alpha", headless: true }]]),
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      agentId: "codex",
      isCodex: true,
      codexSessionRole: "subagent",
      codexInteractiveSubagent: true,
      subagentId: "sid",
      headless: false,
    });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);

    entry.headless = true;
    const explicitHeadless = makePermEntry({ ...entry, _remoteApprovalStarted: false });
    perm.pendingPermissions.push(explicitHeadless);
    assert.equal(perm.maybeStartRemoteApproval(explicitHeadless), false);
    assert.equal(requests.length, 1);
  });

  it("aborts the remote request when the user picks deny-and-focus (go to terminal)", () => {
    let signal;
    const client = {
      isEnabled: () => true,
      requestApproval: (_payload, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(signal.aborted, false);

    // deny-and-focus removes the entry from pendingPermissions without writing
    // an HTTP response — historically it left the remote prompt to TTL out.
    perm.dismissPermissionForTerminal(entry);

    assert.equal(signal.aborted, true);
    assert.equal(perm.pendingPermissions.indexOf(entry), -1);
  });

  it("destroys the socket instead of hanging when a remote-only entry goes to terminal", async () => {
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve("terminal"),
    };
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [{ name: "feishu", client }] }));
    // remoteOnly: true means there is no desktop bubble for the user to act
    // on locally (server-route-permission.js's tryRemoteOnlyApproval sets
    // this when bubbles are disabled) — dismissPermissionForTerminal's usual
    // "leave res unanswered, the agent's own disconnect drives cleanup"
    // assumption only holds when a desktop bubble is actually showing.
    const entry = makePermEntry({ remoteOnly: true });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.indexOf(entry), -1);
    assert.equal(entry.res.destroyed, true);
  });

  it("routes a remote session-trust decision to the main coordinator with an opaque client handle", async () => {
    const cardHandle = Object.freeze({});
    const calls = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        calls.push(["payload", payload]);
        return Promise.resolve({ action: "session-trust", cardHandle });
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
      canOfferRemoteSessionTrust: () => true,
      requestRemoteSessionTrust: (entry, remote) => {
        calls.push(["coordinator", entry, remote]);
        return Promise.resolve({ status: "applied" });
      },
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();

    assert.equal(calls[0][1].canOfferSessionTrust, true);
    assert.equal(calls[1][0], "coordinator");
    assert.equal(calls[1][1], entry);
    assert.equal(calls[1][2].clientName, "telegram");
    assert.equal(calls[1][2].client, client);
    assert.equal(calls[1][2].cardHandle, cardHandle);
    assert.equal(perm.pendingPermissions.includes(entry), true,
      "only the coordinator may commit and resolve after the preparing edit");
  });

  it("does not advertise session trust when the aggregate remote capability gate is closed", async () => {
    const payloads = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        payloads.push(payload);
        return Promise.resolve(null);
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client }],
      canOfferRemoteSessionTrust: () => false,
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].canOfferSessionTrust, false);
  });

  it("falls back instead of hanging when remote-only session trust cannot commit", async () => {
    const cardHandle = Object.freeze({});
    const discarded = [];
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve({ action: "session-trust", cardHandle }),
      discardSessionTrustCardHandle: (handle, options) => {
        discarded.push([handle, options]);
        return true;
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
      canOfferRemoteSessionTrust: () => true,
      requestRemoteSessionTrust: () => Promise.resolve({ status: "full" }),
    }));
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.includes(entry), false);
    assert.equal(entry.res.destroyed, true);
    assert.equal(entry.res.captured.body, "");
    assert.deepStrictEqual(discarded, [[cardHandle, {
      reason: "session-trust-unavailable",
    }]]);
  });

  it("releases an unconsumed session-trust card handle when another source wins first", async () => {
    const cardHandle = Object.freeze({});
    const discarded = [];
    const client = {
      isEnabled: () => true,
      requestApproval: () => Promise.resolve({ action: "session-trust", cardHandle }),
      discardSessionTrustCardHandle: (handle, options) => {
        discarded.push([handle, options]);
        return true;
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [{ name: "feishu", client }],
      canOfferRemoteSessionTrust: () => true,
      requestRemoteSessionTrust: () => {
        throw new Error("the coordinator must not run after the entry is resolved");
      },
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    perm.resolvePermissionEntry(entry, "deny");
    await flush();

    assert.deepStrictEqual(discarded, [[cardHandle, {
      reason: "permission-resolved",
    }]]);
  });

  it("cancels an entry-local remote candidate before ordinary resolution aborts siblings", () => {
    const calls = [];
    const perm = initPermission(makeCtx({
      cancelSessionTrustCandidate: (entry, options) => calls.push([entry, options]),
    }));
    const entry = makePermEntry({ sessionTrustCandidate: { grantId: "candidate" } });
    perm.pendingPermissions.push(entry);

    perm.resolvePermissionEntry(entry, "deny");

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], entry);
    assert.equal(calls[0][1].reason, "permission-resolved");
  });
});
