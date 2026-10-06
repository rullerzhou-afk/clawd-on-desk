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
