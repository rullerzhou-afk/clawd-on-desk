"use strict";

// #913: native OpenCode-family replies are lifecycle cleanup, never a second
// decision. These tests combine the real /permission route with the real
// permission runtime and separately lock the teardown/identity contract.

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { makeSessionKey } = require("../src/session-key");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const tempLogPaths = new Set();

afterEach(() => {
  for (const logPath of tempLogPaths) {
    try { fs.unlinkSync(logPath); } catch {}
  }
  tempLogPaths.clear();
});

function loadPermissionWithElectron(fakeElectron) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function makeFakeElectron(shortcutCalls) {
  return {
    BrowserWindow: Object.assign(class {}, {
      fromWebContents(sender) { return sender && sender.__window ? sender.__window : null; },
    }),
    globalShortcut: {
      register(accelerator) { shortcutCalls.push(["register", accelerator]); return true; },
      unregister(accelerator) { shortcutCalls.push(["unregister", accelerator]); },
      isRegistered() { return false; },
    },
  };
}

function makeBubble(onHide) {
  const bubble = {
    hidden: false,
    destroyed: false,
    webContents: {
      send(eventName) {
        if (eventName === "permission-hide") {
          bubble.hidden = true;
          if (onHide) onHide();
        }
      },
      isDestroyed() { return false; },
    },
    isDestroyed() { return this.destroyed; },
    isVisible() { return !this.destroyed; },
    destroy() { this.destroyed = true; },
  };
  return bubble;
}

function makeRuntimeHarness() {
  const shortcutCalls = [];
  const resolved = [];
  const changed = [];
  const layout = { update: 0, hud: 0 };
  const sessionTrustCancels = [];
  const logs = [];
  const permDebugLog = path.join(
    os.tmpdir(),
    `clawd-family-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`
  );
  tempLogPaths.add(permDebugLog);
  const initPermission = loadPermissionWithElectron(makeFakeElectron(shortcutCalls));
  const ctx = {
    sessions: new Map(),
    hideBubbles: false,
    petHidden: false,
    win: null,
    lang: "en",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    focusTerminalForSession() {},
    onPermissionsChanged: (reason) => changed.push(reason),
    onPermissionResolved: (entry, meta) => resolved.push({ entry, meta }),
    cancelSessionTrustCandidate: (entry, meta) => sessionTrustCancels.push({ entry, meta }),
    repositionUpdateBubble: () => { layout.update += 1; },
    repositionSessionHud: () => { layout.hud += 1; },
    permDebugLog,
  };
  const api = initPermission(ctx);
  return { api, ctx, shortcutCalls, resolved, changed, layout, sessionTrustCancels, logs, permDebugLog };
}

function readPermissionDebugLog(harness) {
  try {
    return fs.readFileSync(harness.permDebugLog, "utf8");
  } catch {
    return "";
  }
}

function assertSecretAbsentFromLifecycleLogs(harness, secret) {
  assert.strictEqual(harness.logs.join("\n").includes(secret), false);
  assert.strictEqual(readPermissionDebugLog(harness).includes(secret), false);
}

function familyEntry(overrides = {}) {
  return {
    res: null,
    abortHandler: null,
    suggestions: [],
    sessionId: makeSessionKey({ profileId: "local", rawSessionId: "opencode:ses-life" }),
    bubble: null,
    hideTimer: null,
    toolName: "bash",
    toolInput: { command: "echo life" },
    resolvedSuggestion: null,
    createdAt: Date.now(),
    agentId: "opencode",
    familyRequestId: "per-life",
    familyBridgeUrl: "http://127.0.0.1:43210",
    familyBridgeToken: "token_life",
    familyAlwaysCandidates: [],
    familyPatterns: [],
    ...overrides,
  };
}

function makeReq(body) {
  const req = new EventEmitter();
  req.headers = {};
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.writeHead = function writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headersSent = true;
    if (headers) this.headers = headers;
  };
  res.end = function end(body) {
    if (body) this.body += String(body);
    this.writableFinished = true;
  };
  res.destroy = function destroy() {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

function postPermission(ctx, body) {
  const { handlePermissionPost } = require("../src/server-route-permission");
  const res = makeRes();
  const recorder = [];
  handlePermissionPost(makeReq(body), res, {
    ctx,
    createRequestHookRecorder(identity, data, route) {
      recorder.push({ identity, data, route });
      return {
        accepted: () => recorder.push({ outcome: "accepted" }),
        droppedByDisabled: () => recorder.push({ outcome: "disabled" }),
        droppedByDnd: () => recorder.push({ outcome: "dnd" }),
        droppedInvalidAgent: () => recorder.push({ outcome: "invalid-agent" }),
        droppedUnsupported: () => recorder.push({ outcome: "unsupported" }),
      };
    },
  });
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => resolve({ res, recorder })));
  });
}

async function waitFor(predicate, message, timeout = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeRouteRuntimeHarness(overrides = {}) {
  const harness = makeRuntimeHarness();
  const calls = {
    updateSession: [],
    showPermissionBubble: [],
    replyOpencodeFamilyPermission: [],
    maybeStartRemoteApproval: [],
  };
  Object.assign(harness.ctx, {
    doNotDisturb: false,
    pendingPermissions: harness.api.pendingPermissions,
    PASSTHROUGH_TOOLS: harness.api.PASSTHROUGH_TOOLS,
    permLog: (message) => harness.logs.push(message),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getCustomAgentIds: () => [],
    addPendingPermission: harness.api.addPendingPermission,
    removePendingPermission: harness.api.removePendingPermission,
    dismissOpencodeFamilyPermissionResolvedExternally:
      harness.api.dismissOpencodeFamilyPermissionResolvedExternally,
    updateSession: (...args) => calls.updateSession.push(args),
    showPermissionBubble: (entry) => {
      calls.showPermissionBubble.push(entry);
      entry.bubble = makeBubble();
    },
    replyOpencodeFamilyPermission: (payload) => calls.replyOpencodeFamilyPermission.push(payload),
    maybeStartRemoteApproval: (entry) => calls.maybeStartRemoteApproval.push(entry),
    syncPermissionShortcuts: harness.api.syncPermissionShortcuts,
    ...overrides,
  });
  harness.calls = calls;
  return harness;
}

describe("opencode-family external lifecycle runtime", () => {
  it("removes every exact duplicate before teardown, clears timers/notifications, and emits zero reverse traffic", async () => {
    const harness = makeRuntimeHarness();
    const { api } = harness;
    let timerFires = 0;
    let remoteAborts = 0;
    let allExactWereDeadAtHide = false;
    const exactA = familyEntry();
    const exactB = familyEntry({
      bubble: makeBubble(() => {
        allExactWereDeadAtHide = !api.pendingPermissions.includes(exactA)
          && !api.pendingPermissions.includes(exactB);
      }),
      _delayTimer: setTimeout(() => { timerFires += 1; }, 40),
      autoCloseTimer: setTimeout(() => { timerFires += 1; }, 40),
      autoExpireTimer: setTimeout(() => { timerFires += 1; }, 40),
      remoteApprovalAbortController: { abort: () => { remoteAborts += 1; } },
      sessionTrustCandidate: { mode: "always" },
    });
    exactA.bubble = makeBubble();
    const sameSessionOtherRequest = familyEntry({ familyRequestId: "per-other" });
    const otherAgent = familyEntry({ agentId: "mimocode" });
    api.pendingPermissions.push(exactA, sameSessionOtherRequest, exactB, otherAgent);

    let reverseRequests = 0;
    const originalRequest = http.request;
    http.request = function forbiddenReverseRequest() {
      reverseRequests += 1;
      throw new Error("external lifecycle attempted a reverse decision");
    };
    try {
      const removed = api.dismissOpencodeFamilyPermissionResolvedExternally({
        agentId: "opencode",
        requestId: "per-life",
        sessionId: exactA.sessionId,
        bridgeUrl: "http://127.0.0.1:43210/",
        bridgeToken: "token_life",
      });
      assert.strictEqual(removed, 2);
    } finally {
      http.request = originalRequest;
    }

    assertSecretAbsentFromLifecycleLogs(harness, "token_life");

    assert.deepStrictEqual(api.pendingPermissions, [sameSessionOtherRequest, otherAgent]);
    assert.strictEqual(allExactWereDeadAtHide, true, "all exact entries must be non-live before renderer teardown");
    assert.strictEqual(exactA.bubble.hidden, true);
    assert.strictEqual(exactB.bubble.hidden, true);
    assert.strictEqual(exactB._delayTimer, null);
    assert.strictEqual(exactB.autoCloseTimer, null);
    assert.strictEqual(exactB.autoExpireTimer, null);
    assert.strictEqual(remoteAborts, 1);
    assert.strictEqual(harness.sessionTrustCancels.length, 1);
    assert.strictEqual(reverseRequests, 0);
    assert.deepStrictEqual(harness.changed, ["resolved-externally"]);
    assert.strictEqual(harness.resolved.length, 2);
    assert.ok(harness.resolved.every(({ meta }) => (
      meta.reason === "resolved-externally" && meta.hasPendingForSession === true
    )));

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(timerFires, 0, "cleared timers must not resolve a second time");
    api.cleanup();
  });

  it("requires the full agent/request/session/url/token identity and treats malformed values as no-op", () => {
    const harness = makeRuntimeHarness();
    const entry = familyEntry();
    harness.api.pendingPermissions.push(entry);
    const base = {
      agentId: entry.agentId,
      requestId: entry.familyRequestId,
      sessionId: entry.sessionId,
      bridgeUrl: entry.familyBridgeUrl,
      bridgeToken: entry.familyBridgeToken,
    };
    const bad = [
      { agentId: "mimocode" },
      { requestId: "per-other" },
      { sessionId: `${entry.sessionId}-other` },
      { bridgeUrl: "http://127.0.0.1:43211" },
      { bridgeUrl: "http://localhost:43210" },
      { bridgeUrl: 42 },
      { bridgeToken: "token_other" },
      { bridgeToken: "x".repeat(129) },
      { bridgeToken: { value: "token_life" } },
    ];
    for (const delta of bad) {
      assert.doesNotThrow(() => {
        assert.strictEqual(
          harness.api.dismissOpencodeFamilyPermissionResolvedExternally({ ...base, ...delta }),
          0,
          JSON.stringify(delta)
        );
      });
      assert.strictEqual(harness.api.pendingPermissions.includes(entry), true);
    }
    assertSecretAbsentFromLifecycleLogs(harness, "token_life");
    assertSecretAbsentFromLifecycleLogs(harness, "token_other");
    harness.api.cleanup();
  });
});

describe("opencode-family lifecycle route → real runtime", () => {
  for (const exitCode of [0, 1]) {
    it(`does not create a stale v1 card when native replied during review (exit ${exitCode})`, async () => {
      const startedPath = path.join(
        os.tmpdir(),
        `clawd-opencode-review-${process.pid}-${Date.now()}-${exitCode}.started`
      );
      tempLogPaths.add(startedPath);
      const harness = makeRouteRuntimeHarness({
        getPermissionAutomationMode: () => "auto-tools",
        getPermissionReviewConfig: () => ({
          command: [
            process.execPath,
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(startedPath)}, "started");setTimeout(() => process.exit(${exitCode}), 250);`,
          ],
          timeoutMs: 5000,
        }),
      });
      const requested = {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        session_id: "opencode:ses-review-race",
        tool_name: "bash",
        tool_input: { command: "echo review-race" },
        request_id: "per-review-race",
        bridge_url: "http://127.0.0.1:43210",
        bridge_token: "token-review-race",
      };

      const requestPromise = postPermission(harness.ctx, requested);
      await waitFor(() => fs.existsSync(startedPath), "v1 review command did not start");
      const lifecycle = await postPermission(harness.ctx, {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        permission_event: "replied",
        session_id: "ses-review-race",
        request_id: "per-review-race",
        lifecycle_bridge_url: "http://127.0.0.1:43210/",
        lifecycle_bridge_token: "token-review-race",
      });
      assert.strictEqual(lifecycle.res.statusCode, 200);
      await requestPromise;
      await waitFor(
        () => harness.logs.some((line) => line.includes("skipping stale bubble")),
        "v1 review did not finish after native reply"
      );
      assert.deepStrictEqual(harness.api.pendingPermissions, []);
      assert.deepStrictEqual(harness.calls.showPermissionBubble, []);
      harness.api.cleanup();
    });
  }

  it("requires every v1 lifecycle identity field before marking an in-flight review", async () => {
    const startedPath = path.join(
      os.tmpdir(),
      `clawd-opencode-review-identity-${process.pid}-${Date.now()}.started`
    );
    tempLogPaths.add(startedPath);
    const harness = makeRouteRuntimeHarness({
      getPermissionAutomationMode: () => "auto-tools",
      getPermissionReviewConfig: () => ({
        command: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(startedPath)}, "started");setTimeout(() => process.exit(0), 350);`,
        ],
        timeoutMs: 5000,
      }),
    });
    const requested = {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      session_id: "opencode:ses-review-identity",
      tool_name: "bash",
      tool_input: { command: "echo identity" },
      request_id: "per-review-identity",
      bridge_url: "http://127.0.0.1:43210",
      bridge_token: "token-review-identity",
    };
    const requestPromise = postPermission(harness.ctx, requested);
    await waitFor(() => fs.existsSync(startedPath), "v1 identity review command did not start");

    const identity = {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      permission_event: "replied",
      session_id: "ses-review-identity",
      request_id: "per-review-identity",
      lifecycle_bridge_url: "http://127.0.0.1:43210/",
      lifecycle_bridge_token: "token-review-identity",
    };
    for (const delta of [
      { agent_id: "mimocode" },
      { request_id: "per-other" },
      { session_id: "ses-other" },
      { lifecycle_bridge_url: "http://127.0.0.1:43211" },
      { lifecycle_bridge_token: "token-other" },
    ]) {
      await postPermission(harness.ctx, { ...identity, ...delta });
      assert.deepStrictEqual(harness.api.pendingPermissions, [], JSON.stringify(delta));
      assert.strictEqual(
        harness.logs.some((line) => line.includes("during external review")),
        false,
        JSON.stringify(delta)
      );
    }

    await postPermission(harness.ctx, identity);
    await requestPromise;
    await waitFor(
      () => harness.logs.some((line) => line.includes("skipping stale bubble")),
      "matching lifecycle did not suppress the stale card"
    );
    assert.deepStrictEqual(harness.api.pendingPermissions, []);
    assert.deepStrictEqual(harness.calls.showPermissionBubble, []);
    harness.api.cleanup();
  });

  it("unregisters a v1 review after normal completion before a matching lifecycle reply", async () => {
    const startedPath = path.join(
      os.tmpdir(),
      `clawd-opencode-review-unregister-normal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.started`
    );
    const finishedPath = startedPath.replace(/\.started$/, ".finished");
    tempLogPaths.add(startedPath);
    tempLogPaths.add(finishedPath);
    const requestId = `per-review-unregister-normal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rawSessionId = `opencode:ses-review-unregister-normal-${Date.now()}`;
    const harness = makeRouteRuntimeHarness({
      getPermissionAutomationMode: () => "auto-tools",
      getPermissionReviewConfig: () => ({
        command: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(startedPath)}, "started");setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(finishedPath)}, "finished"); process.exit(0); }, 180);`,
        ],
        timeoutMs: 5000,
      }),
    });
    try {
      const requestPromise = postPermission(harness.ctx, {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        session_id: rawSessionId,
        tool_name: "bash",
        tool_input: { command: "echo unregister-normal" },
        request_id: requestId,
        bridge_url: "http://127.0.0.1:43210",
        bridge_token: "token-review-unregister-normal",
      });
      await waitFor(() => fs.existsSync(startedPath), "normal unregister review did not start");
      await waitFor(() => fs.existsSync(finishedPath), "normal unregister review did not finish");
      await waitFor(
        () => harness.logs.some((line) => line.includes("showing bubble")),
        "normal unregister review did not settle"
      );
      await requestPromise;
      const lifecycleIdentity = {
        agentId: "opencode",
        requestId,
        sessionId: rawSessionId.slice("opencode:".length),
        bridgeUrl: "http://127.0.0.1:43210/",
        bridgeToken: "token-review-unregister-normal",
      };
      if (harness.api.pendingPermissions.length > 0) {
        // The harness's bubble stub does not run auto-approval; clear the
        // normal-completion card so the lifecycle route exercises the
        // in-flight-review registry rather than dismissing the card first.
        for (const entry of [...harness.api.pendingPermissions]) {
          assert.strictEqual(harness.api.removePendingPermission(entry, "test-card-cleanup"), true);
        }
      }
      assert.deepStrictEqual(harness.api.pendingPermissions, []);

      const before = harness.logs.filter((line) => line.includes("during external review")).length;
      const lifecycle = await postPermission(harness.ctx, {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        permission_event: "replied",
        session_id: lifecycleIdentity.sessionId,
        request_id: lifecycleIdentity.requestId,
        lifecycle_bridge_url: lifecycleIdentity.bridgeUrl,
        lifecycle_bridge_token: lifecycleIdentity.bridgeToken,
      });
      assert.strictEqual(lifecycle.res.statusCode, 200);
      assert.strictEqual(
        harness.logs.filter((line) => line.includes("during external review")).length,
        before
      );
    } finally {
      harness.api.cleanup();
    }
  });

  it("unregisters a v1 review after cancellation before a matching lifecycle reply", async () => {
    let permissionsEnabled = true;
    const startedPath = path.join(
      os.tmpdir(),
      `clawd-opencode-review-unregister-cancel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.started`
    );
    const finishedPath = startedPath.replace(/\.started$/, ".finished");
    tempLogPaths.add(startedPath);
    tempLogPaths.add(finishedPath);
    const requestId = `per-review-unregister-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rawSessionId = `opencode:ses-review-unregister-cancel-${Date.now()}`;
    const harness = makeRouteRuntimeHarness({
      getPermissionAutomationMode: () => "auto-tools",
      getPermissionReviewConfig: () => ({
        command: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(startedPath)}, "started");setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(finishedPath)}, "finished"); process.exit(0); }, 180);`,
        ],
        timeoutMs: 5000,
      }),
      isAgentPermissionsEnabled: () => permissionsEnabled,
    });
    try {
      const requestPromise = postPermission(harness.ctx, {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        session_id: rawSessionId,
        tool_name: "bash",
        tool_input: { command: "echo unregister-cancel" },
        request_id: requestId,
        bridge_url: "http://127.0.0.1:43210",
        bridge_token: "token-review-unregister-cancel",
      });
      await waitFor(() => fs.existsSync(startedPath), "cancel unregister review did not start");
      permissionsEnabled = false;
      await waitFor(() => fs.existsSync(finishedPath), "cancel unregister review did not finish");
      await waitFor(
        () => harness.logs.some((line) => line.includes("family-bubbles-disabled")),
        "cancel unregister review did not settle"
      );
      await requestPromise;
      assert.deepStrictEqual(harness.api.pendingPermissions, []);

      const before = harness.logs.filter((line) => line.includes("during external review")).length;
      const lifecycle = await postPermission(harness.ctx, {
        agent_id: "opencode",
        hook_source: "opencode-plugin",
        permission_event: "replied",
        session_id: rawSessionId.slice("opencode:".length),
        request_id: requestId,
        lifecycle_bridge_url: "http://127.0.0.1:43210/",
        lifecycle_bridge_token: "token-review-unregister-cancel",
      });
      assert.strictEqual(lifecycle.res.statusCode, 200);
      assert.strictEqual(
        harness.logs.filter((line) => line.includes("during external review")).length,
        before
      );
    } finally {
      harness.api.cleanup();
    }
  });

  it("canonicalizes raw/prefixed family sessions and clears only the exact pending request", async () => {
    const harness = makeRouteRuntimeHarness({
      doNotDisturb: true,
      isAgentEnabled: () => false,
      isAgentPermissionsEnabled: () => false,
    });
    // Create while gates are enabled, then flip every creation gate before the
    // lifecycle to prove cleanup is not blocked by current policy.
    harness.ctx.doNotDisturb = false;
    harness.ctx.isAgentEnabled = () => true;
    harness.ctx.isAgentPermissionsEnabled = () => true;
    const asked = {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      session_id: "opencode:ses-route",
      tool_name: "bash",
      tool_input: { command: "echo route" },
      request_id: "per-route",
      bridge_url: "http://127.0.0.1:43210",
      bridge_token: "token_route",
    };
    const askedResult = await postPermission(harness.ctx, asked);
    assert.strictEqual(askedResult.res.statusCode, 200);
    assert.strictEqual(harness.api.pendingPermissions.length, 1);
    const entry = harness.api.pendingPermissions[0];

    const unknownLifecycleResult = await postPermission(harness.ctx, {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      permission_event: "resolved-someday",
      session_id: "ses-route",
      request_id: "per-route",
      lifecycle_bridge_url: "http://127.0.0.1:43210/",
      lifecycle_bridge_token: "token_route",
    });
    assert.strictEqual(unknownLifecycleResult.res.statusCode, 200);
    assert.strictEqual(harness.api.pendingPermissions.length, 1, "unknown lifecycle must not clean a live entry");

    harness.ctx.doNotDisturb = true;
    harness.ctx.isAgentEnabled = () => false;
    harness.ctx.isAgentPermissionsEnabled = () => false;
    const lifecycleResult = await postPermission(harness.ctx, {
      agent_id: "opencode",
      hook_source: "opencode-plugin",
      permission_event: "replied",
      session_id: "ses-route",
      request_id: "per-route",
      lifecycle_bridge_url: "http://127.0.0.1:43210/",
      lifecycle_bridge_token: "token_route",
    });

    assert.strictEqual(lifecycleResult.res.statusCode, 200);
    assert.strictEqual(lifecycleResult.res.headers["x-clawd-server"], "clawd-on-desk");
    assert.deepStrictEqual(lifecycleResult.recorder, []);
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(entry.bubble.hidden, true);
    assert.strictEqual(harness.calls.updateSession.length, 1, "lifecycle must not publish another PermissionRequest");
    assert.strictEqual(harness.calls.showPermissionBubble.length, 1);
    assert.deepStrictEqual(harness.calls.replyOpencodeFamilyPermission, []);
    assert.deepStrictEqual(harness.calls.maybeStartRemoteApproval, []);
    assert.deepStrictEqual(harness.resolved.map(({ meta }) => meta), [{
      reason: "resolved-externally",
      hasPendingForSession: false,
    }]);
    assertSecretAbsentFromLifecycleLogs(harness, "token_route");
    harness.api.cleanup();
  });

  it("keeps new lifecycle credentials fail-safe for an old creator that only understands bridge_url/token", () => {
    const lifecycleBody = {
      agent_id: "opencode",
      permission_event: "replied",
      session_id: "opencode:legacy",
      request_id: "per-legacy",
      lifecycle_bridge_url: "http://127.0.0.1:43210",
      lifecycle_bridge_token: "token_legacy",
    };
    assert.strictEqual(Object.hasOwn(lifecycleBody, "bridge_url"), false);
    assert.strictEqual(Object.hasOwn(lifecycleBody, "bridge_token"), false);

    const legacyPending = [];
    const legacyCreate = (body) => {
      if (!body.request_id || !body.bridge_url || !body.bridge_token) return false;
      legacyPending.push(body);
      return true;
    };
    assert.strictEqual(legacyCreate(lifecycleBody), false);
    assert.deepStrictEqual(legacyPending, []);
  });

  it("clears all exact duplicate entries, stays cross-agent isolated, and makes repeats a no-op", async () => {
    const harness = makeRouteRuntimeHarness();
    const common = {
      tool_name: "bash",
      request_id: "per-duplicates",
      bridge_url: "http://127.0.0.1:43210",
      bridge_token: "token_duplicates",
    };
    await postPermission(harness.ctx, { agent_id: "opencode", session_id: "opencode:ses-duplicates", ...common });
    await postPermission(harness.ctx, { agent_id: "opencode", session_id: "opencode:ses-duplicates", ...common });
    await postPermission(harness.ctx, { agent_id: "mimocode", session_id: "mimocode:ses-duplicates", ...common });
    assert.strictEqual(harness.api.pendingPermissions.length, 3);

    await postPermission(harness.ctx, {
      agent_id: "opencode",
      permission_event: "replied",
      session_id: "opencode:ses-duplicates",
      request_id: "per-duplicates",
      lifecycle_bridge_url: "http://127.0.0.1:43210",
      lifecycle_bridge_token: "wrong_token",
    });
    assert.strictEqual(harness.api.pendingPermissions.length, 3, "wrong generation token cannot clean anything");

    const opencodeCompletion = {
      agent_id: "opencode",
      permission_event: "replied",
      session_id: "ses-duplicates",
      request_id: "per-duplicates",
      lifecycle_bridge_url: "http://127.0.0.1:43210/",
      lifecycle_bridge_token: "token_duplicates",
    };
    await postPermission(harness.ctx, opencodeCompletion);
    assert.strictEqual(harness.api.pendingPermissions.length, 1);
    assert.strictEqual(harness.api.pendingPermissions[0].agentId, "mimocode");

    await postPermission(harness.ctx, opencodeCompletion);
    assert.strictEqual(harness.api.pendingPermissions.length, 1, "duplicate lifecycle is idempotent");

    await postPermission(harness.ctx, {
      ...opencodeCompletion,
      agent_id: "mimocode",
      session_id: "mimocode:ses-duplicates",
    });
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.deepStrictEqual(harness.calls.replyOpencodeFamilyPermission, []);
    harness.api.cleanup();
  });
});
