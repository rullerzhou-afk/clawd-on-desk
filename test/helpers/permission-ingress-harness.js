"use strict";

const http = require("node:http");
const { once } = require("node:events");
const initServer = require("../../src/server");
const initPermission = require("../../src/permission");

// Real HTTP routing and permission ownership, with no startup integration sync,
// runtime-file writes, remote clients, agent execution, or user preferences.
async function createPermissionIngressHarness({ render = false } = {}) {
  const shown = [];
  const updates = [];
  const logs = [];
  const requests = [];
  const ctx = {
    lang: "en", sessions: new Map(), doNotDisturb: false, hideBubbles: false,
    petHidden: false, win: null, bubbleFollowPet: false,
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getEffectivePermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 800, y: 700, width: 100, height: 100 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 900 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {}, reapplyMacVisibility() {}, repositionUpdateBubble() {},
    subscribeShortcuts: () => () => {},
    reportShortcutFailure() {}, clearShortcutFailure() {},
    maybeStartRemoteApproval: () => false,
    updateSession: (...args) => updates.push(args),
    permLog: (message) => logs.push(message),
  };
  const permission = initPermission(ctx);
  for (const key of ["pendingPermissions", "PASSTHROUGH_TOOLS", "addPendingPermission",
    "removePendingPermission", "resolvePermissionEntry", "sendPermissionResponse",
    "syncPermissionShortcuts"]) ctx[key] = permission[key];
  ctx.showPermissionBubble = (entry) => {
    if (render) permission.showPermissionBubble(entry);
    shown.push(entry);
  };
  let server;
  const api = initServer({
    ...ctx,
    createHttpServer(handler) {
      server = http.createServer((req, res) => {
        const observed = { method: req.method, path: req.url, origin: req.headers.origin,
          contentType: req.headers["content-type"], status: null };
        requests.push(observed);
        res.once("finish", () => { observed.status = res.statusCode; });
        handler(req, res);
      });
      return server;
    },
    getPortCandidates: () => [0],
    setImmediate() {},
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    readRuntimeIdentity: () => null,
    windowsProcessChainModes: { "claude-code": "legacy" },
  });
  await api.startHttpServer();
  const port = server.address().port;
  return {
    ctx, api, permission, shown, updates, logs, requests, port,
    async close() {
      for (const entry of [...permission.pendingPermissions]) {
        permission.resolvePermissionEntry(entry, "no-decision", "Test cleanup");
      }
      permission.cleanup();
      const closed = once(server, "close");
      api.cleanup();
      server.closeAllConnections();
      await closed;
    },
  };
}

function postPermission(port, payload, headers = {}, path = "/permission", method = "POST") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  let request;
  let settled = false;
  const response = new Promise((resolve) => {
    request = http.request({ hostname: "127.0.0.1", port, path, method, setHost: false,
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { settled = true; resolve({ status: res.statusCode, body: data, headers: res.headers }); });
    });
    request.on("error", (error) => { settled = true; resolve({ error: error.code }); });
    request.setTimeout(10000, () => request.destroy(new Error("test request timeout")));
    request.end(body);
  });
  return { request, response, get settled() { return settled; } };
}

async function waitUntil(predicate, message, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dummyPermission(label, extra = {}) {
  return { agent_id: "claude-code", session_id: "issue-976-dummy-session",
    tool_name: "Read", tool_input: { file_path: `issue-976-${label}.txt` }, ...extra };
}

module.exports = { createPermissionIngressHarness, postPermission, waitUntil, dummyPermission };
