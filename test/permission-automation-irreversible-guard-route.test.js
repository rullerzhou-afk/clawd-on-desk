"use strict";

// End-to-end (in-process) reproduction of the "real device" check for the
// irreversible guard: a Claude-Code-shaped PermissionRequest enters the HTTP
// route (src/server.js → server-route-permission.js), flows into the REAL
// permission module (src/permission.js) with global automation set to
// "unattended", and we observe what actually goes back on the wire.
//
// No Electron, no real socket: the HTTP server is faked the same way
// test/server-codex-permission.test.js does, and the bubble constructor throw
// (no BrowserWindow) is the signal that automation did NOT short-circuit.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const initPermission = require("../src/permission");
const { SUPPORTED_LANGS } = require("../src/i18n");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

function makeFakeHttp() {
  let capturedHandler = null;
  return {
    createHttpServer(handler) {
      capturedHandler = handler;
      const server = new EventEmitter();
      server.listen = function () { this.emit("listening"); };
      server.close = function () {};
      return server;
    },
    getHandler: () => capturedHandler,
  };
}

function makeReq(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = "/permission";
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
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.headersSent = false;
  res.writeHead = function (code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    this.headersSent = true;
  };
  res.end = function (data) {
    if (data) this.body += String(data);
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("close");
  };
  res.destroy = function () {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One ctx shared by the server route and the permission module, wired the way
// main.js wires them: the route calls ctx.showPermissionBubble, which is the
// real permission.js chokepoint (maybeAutoApprovePermission runs first).
function startRuntime({ mode = "unattended", lang = "ko" } = {}) {
  const http = makeFakeHttp();
  const bubbleAttempts = [];
  const log = [];
  const ctx = {
    // server
    createHttpServer: http.createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    syncClawdHooksImpl: () => {},
    syncGeminiHooksImpl: () => {},
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncQwenHooksImpl: () => {},
    syncCodexHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},
    updateLog: () => {},
    // shared
    permLog: (line) => log.push(String(line)),
    doNotDisturb: false,
    hideBubbles: false,
    petHidden: false,
    sessions: new Map(),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPermissionAutomationMode: () => mode,
    getSettingsSnapshot: () => ({}),
    updateSession: () => {},
    // permission window plumbing (never reached when automation allows)
    focusTerminalForSession() {},
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    permDebugLog: null,
    win: null,
    bubbleFollowPet: false,
    STATE_SVGS: {},
    setState: () => {},
    lang,
  };
  const perm = initPermission(ctx);
  ctx.pendingPermissions = perm.pendingPermissions;
  ctx.PASSTHROUGH_TOOLS = perm.PASSTHROUGH_TOOLS;
  ctx.sendPermissionResponse = perm.sendPermissionResponse;
  ctx.resolvePermissionEntry = perm.resolvePermissionEntry;
  ctx.addPendingPermission = perm.addPendingPermission;
  ctx.removePendingPermission = perm.removePendingPermission;
  ctx.showPermissionBubble = (entry) => {
    try {
      perm.showPermissionBubble(entry);
      bubbleAttempts.push({ entry, threw: null });
    } catch (err) {
      // No BrowserWindow in plain Node: reaching the constructor proves the
      // manual path was taken. Record it instead of failing the route.
      bubbleAttempts.push({ entry, threw: err });
    }
  };
  const api = initServer(ctx);
  api.startHttpServer();
  return { handler: http.getHandler(), perm, ctx, bubbleAttempts, log };
}

async function post(handler, body) {
  const res = makeRes();
  handler(makeReq(body), res);
  await wait(20);
  return res;
}

function claudeRequest(command, overrides = {}) {
  return {
    hook_event_name: "PermissionRequest",
    session_id: "cc-session-1",
    tool_name: "Bash",
    tool_input: { command },
    permission_suggestions: [],
    ...overrides,
  };
}

describe("irreversible guard — route → permission.js (unattended)", () => {
  it("git push --force stays pending on the wire and the bubble payload carries the hold", async () => {
    const rt = startRuntime({ mode: "unattended", lang: "ko" });
    const res = await post(rt.handler, claudeRequest("git push --force origin main"));

    assert.strictEqual(res.writableEnded, false, "no HTTP decision may be written");
    assert.strictEqual(res.destroyed, false, "connection must stay open for the human");
    assert.strictEqual(rt.perm.pendingPermissions.length, 1, "request is pending for a human");
    const entry = rt.perm.pendingPermissions[0];
    assert.strictEqual(entry.res, res);
    assert.deepStrictEqual(entry.automationHold, { reason: "irreversible", tag: "force-push" });
    assert.strictEqual(rt.bubbleAttempts.filter((a) => a.threw).length, 1, "manual bubble path was taken (window constructor reached)");

    // What the renderer will receive.
    const payload = rt.perm.buildPermissionBubblePayload(entry);
    assert.deepStrictEqual(payload.automationHold, { reason: "irreversible", tag: "force-push" });
    assert.strictEqual(payload.lang, "ko");
    // And the exact badge string the ko renderer will append.
    const ko = bubbleRenderer.match(/irreversibleAutoHold: "([^"]+)"/g) || [];
    assert.strictEqual(ko.length, SUPPORTED_LANGS.length);
    assert.ok(bubbleRenderer.includes('irreversibleAutoHold: "자동 승인 보류 — 직접 확인해 주세요"'));

    // The human can still decide: Allow once resolves it with a real allow.
    rt.perm.resolvePermissionEntry(entry, "allow");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
  });

  it("npm test on the same runtime is auto-allowed immediately (guard is narrow)", async () => {
    const rt = startRuntime({ mode: "unattended" });
    const res = await post(rt.handler, claudeRequest("npm test"));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
    assert.strictEqual(rt.perm.pendingPermissions.length, 0);
    assert.strictEqual(rt.bubbleAttempts.filter((a) => a.threw).length, 0, "no window attempt for an ordinary auto-allowed request");
  });

  it("auto-tools behaves the same for rm -rf", async () => {
    const rt = startRuntime({ mode: "auto-tools" });
    const res = await post(rt.handler, claudeRequest("rm -rf build/"));
    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(rt.perm.pendingPermissions.length, 1);
    assert.deepStrictEqual(rt.perm.pendingPermissions[0].automationHold, { reason: "irreversible", tag: "file-delete" });
  });

  it("mode off never stamps a hold (no automation was refused)", async () => {
    const rt = startRuntime({ mode: "off" });
    await post(rt.handler, claudeRequest("git push --force origin main"));
    assert.strictEqual(rt.perm.pendingPermissions.length, 1);
    assert.strictEqual(rt.perm.pendingPermissions[0].automationHold, undefined);
  });

  it("PASSTHROUGH_TOOLS still short-circuit before the guard (documented ordering)", async () => {
    const rt = startRuntime({ mode: "off" });
    const res = await post(rt.handler, claudeRequest(null, { tool_name: "TaskList", tool_input: {} }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
  });
});

describe("irreversible guard — Codex official /permission shapes (unattended)", () => {
  function codexRequest(toolInput) {
    return {
      agent_id: "codex",
      session_id: "codex:s1",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_input: toolInput,
    };
  }

  it("string command is held", async () => {
    const rt = startRuntime({ mode: "unattended" });
    const res = await post(rt.handler, codexRequest({ command: "git push --force origin main", description: "push" }));
    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(rt.perm.pendingPermissions.length, 1);
    assert.deepStrictEqual(rt.perm.pendingPermissions[0].automationHold, { reason: "irreversible", tag: "force-push" });
  });

  it("argv-array command (legacy shell tool) is held too", async () => {
    const rt = startRuntime({ mode: "unattended" });
    const res = await post(rt.handler, codexRequest({ command: ["bash", "-lc", "git push --force origin main"] }));
    assert.strictEqual(res.writableEnded, false, "argv payloads must not slip past the guard");
    assert.strictEqual(rt.perm.pendingPermissions.length, 1);
    assert.deepStrictEqual(rt.perm.pendingPermissions[0].automationHold, { reason: "irreversible", tag: "force-push" });
  });

  it("argv-array benign command is still auto-allowed", async () => {
    const rt = startRuntime({ mode: "unattended" });
    const res = await post(rt.handler, codexRequest({ command: ["npm", "test"] }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
  });
});
