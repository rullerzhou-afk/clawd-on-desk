"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const http = require("http");
const { initMobilePreviewServer, PROTOCOL_VERSION } = require("../src/network/mobile-preview-server");

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on("message", handler);
  });
}

function connectClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    } catch {}
  });
  return {
    ws,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    close() { ws.close(); },
  };
}

function waitForOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("Timeout waiting for open")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
  });
}

function waitForPort(getPortFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const p = getPortFn();
      if (typeof p === "number" && p > 0) { resolve(p); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error("Timeout waiting for port")); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

describe("Mobile Preview Server", () => {
  let server;
  let port;
  let token;
  const sessions = new Map();
  let pendingPermissions = [];

  function createSession(sid, state, agentId) {
    sessions.set(sid, {
      state,
      agentId,
      cwd: "/home/user/project",
      sessionTitle: `Session ${sid}`,
      updatedAt: Date.now(),
      recentEvents: [],
    });
  }

  before(async () => {
    server = initMobilePreviewServer({
      sessions,
      getPendingPermissions: () => pendingPermissions,
    });
    port = await server.start();
    token = server.getToken();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    pendingPermissions = [];
  });

  it("protocol version is v1", () => {
    assert.strictEqual(PROTOCOL_VERSION, "v1");
    assert.strictEqual(server.PROTOCOL_VERSION, "v1");
  });

  it("starts and listens on a port", () => {
    assert.ok(typeof port === "number" && port >= 23334);
  });

  it("serves PWA static files", async () => {
    const res = await httpGet(port, "/mobile/");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("Clawd Mobile"));
    assert.ok(res.headers["content-type"].includes("text/html"));
  });

  it("serves public connection info without exposing the token", async () => {
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(res.status, 200);
    const info = JSON.parse(res.body);
    assert.strictEqual(info.status, "ok");
    assert.strictEqual(info.port, port);
    assert.strictEqual(typeof info.lanIp, "string");
    assert.ok(!("token" in info));
  });

  it("returns 404 for non-mobile paths", async () => {
    const res = await httpGet(port, "/other");
    assert.strictEqual(res.status, 404);
  });

  it("rejects path traversal attempts instead of serving files outside the PWA directory", async () => {
    const dotDot = await httpGet(port, "/mobile/%2e%2e/package.json");
    assert.notStrictEqual(dotDot.status, 200);

    const encodedSlash = await httpGet(port, "/mobile/%2e%2e%2fpackage.json");
    assert.notStrictEqual(encodedSlash.status, 200);
  });

  it("rejects WebSocket with invalid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad`);
    const code = await new Promise((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("open", () => {});
    });
    assert.strictEqual(code, 1008);
  });

  it("connects with valid token and receives snapshot", async () => {
    createSession("s1", "working", "claude-code");
    server.onSnapshot(); // Prime cache before connecting

    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");

    assert.strictEqual(snapshot.version, "v1");
    assert.ok(snapshot.timestamp > 0);
    assert.ok(snapshot.sessions.s1);
    assert.strictEqual(snapshot.sessions.s1.state, "working");
    assert.strictEqual(snapshot.sessions.s1.title, "Session s1");
    assert.strictEqual(snapshot.sessions.s1.basename, "project");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts state changes", async () => {
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Change session state
    sessions.get("s1").state = "thinking";
    sessions.get("s1").updatedAt = Date.now();
    server.onSnapshot();

    const stateMsg = await client.waitFor("state");
    assert.strictEqual(stateMsg.version, "v1");
    assert.strictEqual(stateMsg.sessionId, "s1");
    assert.strictEqual(stateMsg.data.state, "thinking");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts session deletions", async () => {
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    sessions.delete("s1");
    server.onSnapshot();

    const delMsg = await client.waitFor("session_deleted");
    assert.strictEqual(delMsg.version, "v1");
    assert.strictEqual(delMsg.sessionId, "s1");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});
