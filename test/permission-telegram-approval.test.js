"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");

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
  return {
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
}

describe("permission telegram remote approval", () => {
  it("sends a conservative payload and resolves allow without a message", async () => {
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
    assert.equal(requests[0].payload.detail.includes("npm test"), false);
    assert.equal(requests[0].payload.detail.includes("sk-1234567890123456"), false);
    assert.equal(requests[0].payload.detail.includes("987654321"), false);
    assert.equal(requests[0].payload.detail.includes("telegram:123456789"), false);

    resolveApproval("allow");
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "allow" });
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
      makePermEntry({ isElicitation: true }),
      makePermEntry({ isCodexNotify: true }),
      makePermEntry({ isKimiNotify: true }),
      makePermEntry({ isOpencode: true }),
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

  it("does not send a Telegram card when the tool input lacks a description/summary/reason", () => {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return Promise.resolve("allow");
      },
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    // Bare Bash payload — only `command`. Local bubble shows the full command
    // but Telegram would only get "Tool input hidden by Clawd.", so the guard
    // must refuse to send.
    const entry = makePermEntry({
      toolInput: { command: "rm -rf /tmp/scratch" },
    });
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(requests, []);
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
});
