"use strict";

// OpenCode Desktop runs its sidecar in an Electron utilityProcess under Node,
// so Bun.serve is absent. These tests exercise the real node:http listener on
// loopback instead of a fake Bun server.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { pathToFileURL } = require("node:url");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-node-bridge-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const runtimeDir = path.join(TMP_HOME, ".clawd");
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const runtimePath = path.join(runtimeDir, "runtime.json");
fs.writeFileSync(runtimePath, JSON.stringify({
  app: "clawd-on-desk",
  port: 23333,
  ownerPid: process.pid,
}), { mode: 0o600 });
if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o600);

let createOpencodeFamilyPlugin;
const fetchCalls = [];
let clawdResponseRecognized = false;

before(async () => {
  delete globalThis.Bun;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({
      url: String(url),
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    });
    return {
      status: 200,
      headers: {
        get: (name) => clawdResponseRecognized && String(name).toLowerCase() === "x-clawd-server"
          ? "clawd-on-desk"
          : null,
      },
      text: async () => "",
    };
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

after(() => {
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const OC = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

function createContext(directory, sdkCalls) {
  return {
    serverUrl: "http://127.0.0.1:1/",
    directory,
    client: {
      _client: {
        post: async (args) => {
          sdkCalls.push(args);
          return { data: {} };
        },
      },
    },
  };
}

async function initNodeInstance({ plugin = createOpencodeFamilyPlugin(OC), directory = "/tmp/node-project" } = {}) {
  const sdkCalls = [];
  const hooks = await plugin(createContext(directory, sdkCalls));
  return { plugin, hooks, sdkCalls, directory };
}

async function emitPermission(instance, requestId, sessionID = "ses_node") {
  await instance.hooks.event({
    event: {
      type: "permission.asked",
      properties: {
        id: requestId,
        sessionID,
        permission: "bash",
        metadata: { command: "pwd" },
      },
    },
  });
}

async function emitPermissionReplied(instance, requestId, sessionID = "ses_node") {
  await instance.hooks.event({
    event: {
      type: "permission.replied",
      properties: { requestID: requestId, sessionID, reply: "once" },
    },
  });
  const tail = instance.plugin.__test._permissionPostTailByRequestId.get(requestId);
  if (tail) await tail;
}

function requestBridge(url, { token, body, rawBody, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === undefined ? JSON.stringify(body) : rawBody;
    const target = new URL("/reply", url);
    const headers = {
      "Content-Type": "application/json",
    };
    if (chunked) headers["Transfer-Encoding"] = "chunked";
    else headers["Content-Length"] = Buffer.byteLength(payload);
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const req = http.request(target, { method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (!chunked) {
      req.end(payload);
      return;
    }
    const midpoint = Math.floor(payload.length / 2);
    req.write(payload.slice(0, midpoint));
    req.end(payload.slice(midpoint));
  });
}

describe("opencode-family Node reverse bridge", () => {
  it("listens on loopback and forwards an authenticated permission reply", async (t) => {
    const instance = await initNodeInstance();
    t.after(() => instance.plugin.__test.closeBridgeForTest());

    assert.strictEqual(instance.plugin.__test._bridgeRuntime, "node");
    assert.match(instance.plugin.__test._bridgeUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(instance.plugin.__test._bridgeTokenHex, /^[a-f0-9]{64}$/);
    const address = instance.plugin.__test._bridgeAddress;
    assert.ok(address && typeof address === "object", "node bridge must expose its bound address");
    assert.strictEqual(address.address, "127.0.0.1");
    assert.strictEqual(address.port, Number(new URL(instance.plugin.__test._bridgeUrl).port));
    assert.ok(instance.plugin.__test._bridgeErrorListenerCount > 0,
      "node bridge must retain an error listener after binding");

    fetchCalls.length = 0;
    await emitPermission(instance, "per_node_once");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const forwarded = fetchCalls.find((call) => call.url.endsWith("/permission"));
    assert.ok(forwarded, "permission was not forwarded to Clawd");
    assert.strictEqual(forwarded.body.bridge_url, instance.plugin.__test._bridgeUrl);
    assert.strictEqual(forwarded.body.bridge_token, instance.plugin.__test._bridgeTokenHex);

    const unauthorized = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token: "ff".repeat(32),
      body: { request_id: "per_node_once", reply: "once" },
    });
    assert.strictEqual(unauthorized.status, 401);
    assert.strictEqual(instance.sdkCalls.length, 0);

    const accepted = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token: instance.plugin.__test._bridgeTokenHex,
      body: { request_id: "per_node_once", reply: "once" },
    });
    assert.strictEqual(accepted.status, 200);
    assert.deepStrictEqual(JSON.parse(accepted.body), { ok: true });
    assert.deepStrictEqual(instance.sdkCalls, [{
      url: "/permission/per_node_once/reply",
      query: { directory: "/tmp/node-project" },
      body: { reply: "once" },
      headers: { "Content-Type": "application/json" },
    }]);
  });

  it("rejects malformed and oversized bodies without poisoning the listener", async (t) => {
    const instance = await initNodeInstance();
    t.after(() => instance.plugin.__test.closeBridgeForTest());
    const token = instance.plugin.__test._bridgeTokenHex;

    const malformed = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token,
      rawBody: "{not json",
    });
    assert.strictEqual(malformed.status, 400);

    const oversized = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token,
      rawBody: "x".repeat(64 * 1024 + 1),
    });
    assert.strictEqual(oversized.status, 413);

    const streamedOversized = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token,
      rawBody: "x".repeat(64 * 1024 + 1),
      chunked: true,
    });
    assert.strictEqual(streamedOversized.status, 413);

    await emitPermission(instance, "per_after_bad_body");
    const accepted = await requestBridge(instance.plugin.__test._bridgeUrl, {
      token,
      body: { request_id: "per_after_bad_body", reply: "reject" },
    });
    assert.strictEqual(accepted.status, 200);
    assert.strictEqual(instance.sdkCalls.length, 1);
  });

  it("serializes concurrent directory initialization and preserves request ownership", async (t) => {
    const plugin = createOpencodeFamilyPlugin(OC);
    const callsA = [];
    const callsB = [];
    const [hooksA, hooksB] = await Promise.all([
      plugin(createContext("/tmp/project-a", callsA)),
      plugin(createContext("/tmp/project-b", callsB)),
    ]);
    t.after(() => plugin.__test.closeBridgeForTest());

    assert.strictEqual(plugin.__test._bridgeRuntime, "node");
    const instanceA = { plugin, hooks: hooksA, sdkCalls: callsA };
    await emitPermission(instanceA, "per_project_a", "ses_a");
    const response = await requestBridge(plugin.__test._bridgeUrl, {
      token: plugin.__test._bridgeTokenHex,
      body: { request_id: "per_project_a", reply: "always" },
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(callsA.length, 1);
    assert.strictEqual(callsB.length, 0);
    assert.deepStrictEqual(callsA[0].query, { directory: "/tmp/project-a" });
  });

  it("forwards the same strict completion lifecycle from the Node Desktop host path", async (t) => {
    clawdResponseRecognized = true;
    const instance = await initNodeInstance();
    t.after(() => instance.plugin.__test.closeBridgeForTest());
    try {
      await emitPermission(instance, "per_node_lifecycle", "ses_node_lifecycle");
      const askedTail = instance.plugin.__test._permissionPostTailByRequestId.get("per_node_lifecycle");
      if (askedTail) await askedTail;
      fetchCalls.length = 0;

      await emitPermissionReplied(instance, "per_node_lifecycle", "ses_node_lifecycle");

      assert.strictEqual(fetchCalls.length, 1);
      const body = fetchCalls[0].body;
      assert.strictEqual(body.permission_event, "replied");
      assert.strictEqual(body.request_id, "per_node_lifecycle");
      assert.strictEqual(body.session_id, "opencode:ses_node_lifecycle");
      assert.strictEqual(body.lifecycle_bridge_url, instance.plugin.__test._bridgeUrl);
      assert.strictEqual(body.lifecycle_bridge_token, instance.plugin.__test._bridgeTokenHex);
      assert.strictEqual(Object.hasOwn(body, "bridge_url"), false);
      assert.strictEqual(Object.hasOwn(body, "bridge_token"), false);
    } finally {
      clawdResponseRecognized = false;
    }
  });

  it("returns a structured 502 when the host SDK throws an unreadable error", async (t) => {
    const plugin = createOpencodeFamilyPlugin(OC);
    const hooks = await plugin({
      serverUrl: "http://127.0.0.1:1/",
      directory: "/tmp/node-throw",
      client: {
        _client: {
          post: () => {
            const bomb = {};
            Object.defineProperty(bomb, "message", { get() { throw new Error("getter bomb"); } });
            throw bomb;
          },
        },
      },
    });
    t.after(() => plugin.__test.closeBridgeForTest());
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: { id: "per_node_throw", sessionID: "ses_node", permission: "bash", metadata: { command: "pwd" } },
      },
    });
    const response = await requestBridge(plugin.__test._bridgeUrl, {
      token: plugin.__test._bridgeTokenHex,
      body: { request_id: "per_node_throw", reply: "once" },
    });
    assert.strictEqual(response.status, 502);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.status, 0);
    assert.strictEqual(typeof body.error, "string");
  });
});
