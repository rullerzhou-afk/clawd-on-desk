"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const initPermission = require("../src/permission");
const { handlePermissionPost } = require("../src/server-route-permission");
const { stopActivePermissionReviews } = require("../src/permission-review-command");
const { makeSessionKey } = require("../src/session-key");
const { waitUntil } = require("./helpers/permission-ingress-harness");

const RAW_SESSION_ID = "codex:01a119d3-1893-7f42-aadc-fa33ca4166a8";

function createReviewHarness(t) {
  const notices = [];
  const logs = [];
  const ctx = {
    lang: "en",
    win: null,
    sessions: new Map(),
    doNotDisturb: false,
    hideBubbles: false,
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    getCodexPermissionMode: () => "auto",
    getEffectivePermissionAutomationMode: () => "auto-tools",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPermissionReviewConfig: () => ({
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
      timeoutMs: 60000,
    }),
    updateSession() {},
    permLog: (message) => logs.push(message),
    notifyCodexRemoteFallback: (payload) => {
      notices.push(payload);
      return true;
    },
  };
  const permission = initPermission(ctx);
  Object.assign(ctx, {
    pendingPermissions: permission.pendingPermissions,
    queueCodexRemoteFallbackForEntry: permission.queueCodexRemoteFallbackForEntry,
  });
  t.after(() => {
    stopActivePermissionReviews();
    permission.cleanup();
  });

  const req = new EventEmitter();
  req.headers = {};
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: null,
    headersSent: false,
    destroyed: false,
    writableFinished: false,
    body: "",
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(data) {
      if (data) this.body += String(data);
      this.writableFinished = true;
    },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  handlePermissionPost(req, res, {
    ctx,
    remoteProfile: { profileId: "win-box", displayHost: "ruller-win" },
    createRequestHookRecorder: () => ({
      accepted() {},
      droppedByDisabled() {},
      droppedByDnd() {},
      droppedInvalidAgent() {},
      droppedUnsupported() {},
    }),
  });
  req.emit("data", Buffer.from(JSON.stringify({
    agent_id: "codex",
    hook_source: "codex-official",
    session_id: RAW_SESSION_ID,
    host: "reported-host",
    turn_id: "01a119d7-24b5-7010-9da2-d8791ff8a1d1",
    tool_name: "mcp__playwright__browser_navigate",
    tool_input: { url: "https://example.com" },
  })));
  req.emit("end");
  assert.equal(res.listenerCount("close"), 1, `the review must be waiting for cancellation: ${logs.join("\n")}`);
  return { permission, res, notices, logs };
}

test("Codex remote MCP: a cancelled review queues through the real Codex entry gate", async (t) => {
  const h = createReviewHarness(t);
  stopActivePermissionReviews();
  await waitUntil(() => h.res.writableFinished, "cancelled review did not return no-decision");

  assert.ok(h.logs.some((message) => message.includes("request no longer actionable (app-quitting)")));
  assert.equal(h.res.statusCode, 204);
  assert.equal(h.res.body, "");
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].sessionId, makeSessionKey({ profileId: "win-box", rawSessionId: RAW_SESSION_ID }));
  assert.equal(h.notices[0].profileId, "win-box");
  assert.equal(h.notices[0].host, "ruller-win");
  assert.equal(h.notices[0].toolName, "mcp__playwright__browser_navigate");
});

test("Codex remote MCP: client-disconnected review skips the notice with an undestroyed response", async (t) => {
  const h = createReviewHarness(t);
  assert.equal(h.res.headersSent, false);
  assert.equal(h.res.destroyed, false);
  // Keep the response open so the cancellation reason is the only guard that
  // can prevent a notice; a destroyed socket would mask that decision.
  h.res.emit("close");
  await waitUntil(() => h.res.writableFinished, "disconnected review did not return no-decision");

  assert.ok(h.logs.some((message) => message.includes("request no longer actionable (client-disconnected)")));
  assert.equal(h.res.destroyed, false);
  assert.equal(h.res.statusCode, 204);
  assert.equal(h.res.body, "");
  assert.equal(h.permission.pendingPermissions.length, 0);
  assert.equal(h.notices.length, 0);
});
