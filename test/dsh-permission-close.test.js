"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initPermission = require("../src/permission");
const { handlePermissionPost } = require("../src/server-route-permission");

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");

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
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.writes = 0;
  res.writeHead = function writeHead(code, headers) {
    this.statusCode = code;
    this.headersSent = true;
    if (headers) this.headers = headers;
  };
  res.end = function end(data) {
    this.writes += 1;
    if (data) this.body += String(data);
    this.writableFinished = true;
  };
  res.destroy = function destroy() {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

// One real permission instance, shared by every request posted to this ctx, so
// the DSH branch's abortHandler and resolvePermissionEntry behave as in
// production. The resolve wrapper records every call the branch makes.
function makeDshSession() {
  const ctx = {
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    permLog() {},
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    updateSession() {},
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    getPermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {},
    reapplyMacVisibility() {},
    repositionUpdateBubble() {},
    subscribeShortcuts: () => () => {},
    reportShortcutFailure() {},
    clearShortcutFailure() {},
    maybeStartRemoteApproval: () => false,
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
  };
  const permission = initPermission(ctx);
  const resolveCalls = [];
  const realResolve = permission.resolvePermissionEntry;
  Object.assign(ctx, {
    pendingPermissions: permission.pendingPermissions,
    PASSTHROUGH_TOOLS: permission.PASSTHROUGH_TOOLS,
    addPendingPermission: permission.addPendingPermission,
    removePendingPermission: permission.removePendingPermission,
    showPermissionBubble() {},
    resolvePermissionEntry(entry, behavior, message) {
      resolveCalls.push({ behavior, message });
      return realResolve(entry, behavior, message);
    },
    sendPermissionResponse: permission.sendPermissionResponse,
    syncPermissionShortcuts: permission.syncPermissionShortcuts,
  });
  return { ctx, permission, resolveCalls };
}

function postDsh(ctx, rawSessionId, toolUseId = "call-1") {
  return new Promise((resolve) => {
    const res = makeRes();
    handlePermissionPost(makeReq(JSON.stringify({
      agent_id: "deepseek-harness",
      hook_source: "dsh-plugin",
      session_id: rawSessionId,
      tool_name: "execute_shell",
      tool_use_id: toolUseId,
      reason: "run a generated command",
    })), res, {
      ctx,
      createRequestHookRecorder: () => ({
        accepted() {},
        droppedByDisabled() {},
        droppedByDnd() {},
        droppedUnsupported() {},
        droppedInvalidAgent() {},
      }),
    });
    setImmediate(() => {
      setImmediate(() => resolve(res));
    });
  });
}

describe("DeepSeek Harness approval close handling", () => {
  it("resolves no-decision without writing a decision when the client closes early", async () => {
    const { ctx, permission, resolveCalls } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:close-early");
    assert.strictEqual(permission.pendingPermissions.length, 1);
    const entry = permission.pendingPermissions[0];

    res.emit("close");

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(res.writableFinished, true);
    assert.strictEqual(res.body, "", "no decision body is written");
    assert.deepStrictEqual(permission.pendingPermissions, []);
    assert.deepStrictEqual(resolveCalls, [{ behavior: "no-decision", message: "Client disconnected" }]);

    // The request is gone; a late bubble decision must not write a second time.
    ctx.resolvePermissionEntry(entry, "allow");
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(res.writes, 1);
  });

  it("does not revoke an allow decision when the connection closes afterwards", async () => {
    const { ctx, permission, resolveCalls } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:allow-then-close");
    const entry = permission.pendingPermissions[0];

    ctx.resolvePermissionEntry(entry, "allow");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, JSON.stringify({ decision: "allow" }));
    assert.deepStrictEqual(permission.pendingPermissions, []);
    assert.deepStrictEqual(resolveCalls, [{ behavior: "allow", message: undefined }]);
    const allowBody = res.body;
    const allowWrites = res.writes;

    res.emit("close");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, allowBody);
    assert.strictEqual(res.writes, allowWrites, "the close must not write again");
    assert.deepStrictEqual(resolveCalls, [{ behavior: "allow", message: undefined }]);
  });

  it("does not revoke a deny decision when the connection closes afterwards", async () => {
    const { ctx, permission, resolveCalls } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:deny-then-close");
    const entry = permission.pendingPermissions[0];

    ctx.resolvePermissionEntry(entry, "deny");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, JSON.stringify({ decision: "deny" }));
    assert.deepStrictEqual(resolveCalls, [{ behavior: "deny", message: undefined }]);
    const denyBody = res.body;
    const denyWrites = res.writes;

    res.emit("close");

    assert.strictEqual(res.body, denyBody);
    assert.strictEqual(res.writes, denyWrites);
    assert.deepStrictEqual(resolveCalls, [{ behavior: "deny", message: undefined }]);
  });

  it("leaves an already-finished response untouched when close fires", async () => {
    const { ctx, permission, resolveCalls } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:finished-then-close");
    const entry = permission.pendingPermissions[0];

    // A response that already finished must not be turned into a no-decision by
    // a close that races the decision write.
    res.writableFinished = true;
    entry.abortHandler();

    assert.deepStrictEqual(resolveCalls, []);
    assert.deepStrictEqual(permission.pendingPermissions, [entry]);
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.body, "");
  });

  it("ignores a late decision after the request was already closed", async () => {
    const { ctx, permission } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:late-after-close");
    const entry = permission.pendingPermissions[0];

    res.emit("close");
    assert.strictEqual(res.statusCode, 204);
    const closedWrites = res.writes;

    assert.doesNotThrow(() => ctx.resolvePermissionEntry(entry, "allow"));
    assert.doesNotThrow(() => ctx.resolvePermissionEntry(entry, "deny"));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(res.writes, closedWrites);
  });

  it("ignores a late decision after the request was already allowed", async () => {
    const { ctx, permission } = makeDshSession();
    const res = await postDsh(ctx, "deepseek-harness:late-after-allow");
    const entry = permission.pendingPermissions[0];

    ctx.resolvePermissionEntry(entry, "allow");
    const allowBody = res.body;
    const allowWrites = res.writes;

    assert.doesNotThrow(() => ctx.resolvePermissionEntry(entry, "deny"));
    assert.doesNotThrow(() => ctx.resolvePermissionEntry(entry, "no-decision"));
    assert.strictEqual(res.body, allowBody);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.writes, allowWrites);
  });

  it("does not disturb another pending request when a late decision arrives", async () => {
    const { ctx, permission } = makeDshSession();
    await postDsh(ctx, "deepseek-harness:late-a", "call-a");
    await postDsh(ctx, "deepseek-harness:late-b", "call-b");
    assert.strictEqual(permission.pendingPermissions.length, 2);
    const [first, second] = permission.pendingPermissions;

    ctx.resolvePermissionEntry(first, "allow");
    assert.deepStrictEqual(permission.pendingPermissions, [second]);

    // A second decision for the already-resolved request must be a no-op.
    ctx.resolvePermissionEntry(first, "deny");
    assert.deepStrictEqual(permission.pendingPermissions, [second]);
  });
});
