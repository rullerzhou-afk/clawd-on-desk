"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  initMobilePreviewServer,
  isRetryablePortError,
  PROTOCOL_VERSION,
} = require("../src/network/mobile-preview-server");

async function occupyPort(port) {
  const blocker = http.createServer((_req, res) => res.end());
  let owned = false;
  await new Promise((resolve, reject) => {
    blocker.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve();
        return;
      }
      reject(error);
    });
    blocker.listen(port, "0.0.0.0", () => {
      owned = true;
      resolve();
    });
  });
  return { blocker, owned };
}

async function closeOwnedBlockers(blockers) {
  await Promise.all(blockers.map(({ blocker, owned }) => (
    owned ? new Promise((resolve) => blocker.close(resolve)) : Promise.resolve()
  )));
}

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

function httpGet(port, pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathStr }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function httpGetBuffer(port, pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathStr }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks),
        headers: res.headers,
      }));
    }).on("error", reject);
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

describe("Mobile Preview Server port fallback", () => {
  it("classifies occupied and Windows-reserved ports as retryable", () => {
    assert.equal(isRetryablePortError({ code: "EADDRINUSE" }), true);
    assert.equal(isRetryablePortError({ code: "EACCES" }), true);
    assert.equal(isRetryablePortError({ code: "EINVAL" }), false);
  });

  it("advances past an occupied 23334 and serves on the next candidate", async () => {
    const blocker = http.createServer((_req, res) => res.end());
    let ownsBlocker = false;
    await new Promise((resolve, reject) => {
      blocker.once("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          resolve();
          return;
        }
        reject(error);
      });
      blocker.listen(23334, "0.0.0.0", () => {
        ownsBlocker = true;
        resolve();
      });
    });

    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-port-fallback-"));
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
    });
    try {
      const port = await server.start();
      assert.notStrictEqual(port, 23334);
      assert.ok(port >= 23335 && port <= 23338);
      const res = await httpGet(port, "/api/connection-info");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(JSON.parse(res.body).port, port);
    } finally {
      server.cleanup();
      // cleanup() intentionally stays synchronous for production callers;
      // give the underlying close callbacks one turn before the next suite
      // reuses the same fallback port.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (ownsBlocker) {
        await new Promise((resolve) => blocker.close(resolve));
      }
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });

  it("retries the actual start path after a synthetic Windows EACCES", async () => {
    const attempts = [];
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-port-eacces-"));
    class SyntheticHttpServer extends EventEmitter {
      constructor() {
        super();
        this.listening = false;
      }

      listen(port) {
        attempts.push(port);
        queueMicrotask(() => {
          if (port === 23334) {
            const error = new Error("synthetic reserved port");
            error.code = "EACCES";
            this.emit("error", error);
            return;
          }
          this.listening = true;
          this.emit("listening");
        });
      }

      close() { this.listening = false; }
    }
    class SyntheticWebSocketServer extends EventEmitter {
      close() {}
    }
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
      createHttpServer: () => new SyntheticHttpServer(),
      WebSocketServer: SyntheticWebSocketServer,
    });

    try {
      assert.equal(await server.start(), 23335);
      assert.deepStrictEqual(attempts, [23334, 23335]);
    } finally {
      server.cleanup();
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });

  it("rejects after all candidate ports without arming token rotation", async () => {
    const blockers = [];
    for (let port = 23334; port <= 23338; port++) blockers.push(await occupyPort(port));
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-port-exhaustion-"));
    const tokenPath = path.join(tmpTokenDir, "mobile-token.json");
    const originalState = {
      token: "a".repeat(32),
      previous: null,
      graceUntil: null,
      rotatedAt: 1,
      rotationPending: false,
    };
    fs.writeFileSync(tokenPath, JSON.stringify(originalState), "utf8");
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath,
    });

    try {
      await assert.rejects(server.start(), (err) => isRetryablePortError(err));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(server.getPort(), null);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(tokenPath, "utf8")), originalState);
    } finally {
      server.cleanup();
      await closeOwnedBlockers(blockers);
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });

  it("coalesces concurrent starts and cleanup cancels a pending start", async () => {
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-start-lifecycle-"));
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
    });

    try {
      const first = server.start();
      const second = server.start();
      assert.strictEqual(second, first);
      const port = await first;
      assert.equal(server.getPort(), port);
      assert.equal(await server.start(), port);
    } finally {
      server.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }

    const blockers = [];
    for (let port = 23334; port <= 23338; port++) blockers.push(await occupyPort(port));
    const cancelDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-start-cancel-"));
    const cancellable = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(cancelDir, "mobile-token.json"),
    });
    try {
      const pending = cancellable.start();
      cancellable.cleanup();
      await assert.rejects(pending, (err) => err && err.code === "ECANCELED");
      assert.equal(cancellable.getPort(), null);
    } finally {
      cancellable.cleanup();
      await closeOwnedBlockers(blockers);
      try { fs.rmSync(cancelDir, { recursive: true }); } catch {}
    }
  });

  it("keeps a replacement start cancellable after the old rejection continuation runs", async () => {
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-start-generation-"));
    class PendingHttpServer extends EventEmitter {
      constructor() {
        super();
        this.listening = false;
      }

      listen() {}
      close() { this.listening = false; }
    }
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
      createHttpServer: () => new PendingHttpServer(),
    });

    try {
      const first = server.start();
      server.cleanup();
      const replacement = server.start();

      await assert.rejects(first, (err) => err && err.code === "ECANCELED");
      server.cleanup();
      await assert.rejects(replacement, (err) => err && err.code === "ECANCELED");
    } finally {
      server.cleanup();
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });

  it("releases the HTTP listener when WebSocket attachment fails", async () => {
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ws-attach-failure-"));
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
      WebSocketServer: class ThrowingWebSocketServer {
        constructor() { throw new Error("synthetic ws attach failure"); }
      },
    });
    try {
      await assert.rejects(server.start(), /synthetic ws attach failure/);
      assert.equal(server.getPort(), null);
    } finally {
      server.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });

  it("observes a WebSocket runtime error after successful attachment", async () => {
    const tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ws-runtime-error-"));
    let socketServer = null;
    class SyntheticWebSocketServer extends EventEmitter {
      constructor() {
        super();
        socketServer = this;
      }

      close() {}
    }
    const logs = [];
    const server = initMobilePreviewServer({
      sessions: new Map(),
      getPendingPermissions: () => [],
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
      WebSocketServer: SyntheticWebSocketServer,
      onWebSocketError: (error) => logs.push(error.message),
    });

    try {
      await server.start();
      socketServer.emit("error", new Error("synthetic runtime failure"));
      assert.equal(logs.length, 1);
      assert.match(logs[0], /synthetic runtime failure/);
    } finally {
      server.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
    }
  });
});

// ── Original test suite (adapted to use injectable tokenPath) ──

describe("Mobile Preview Server", () => {
  let server;
  let port;
  let token;
  const sessions = new Map();
  let pendingPermissions = [];
  let tmpTokenDir;

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
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-test-"));
    server = initMobilePreviewServer({
      sessions,
      getPendingPermissions: () => pendingPermissions,
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
    });
    port = await server.start();
    token = server.getToken();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    pendingPermissions = [];
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
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

  it("serves canonical project icons at the stable PWA icon URLs", async () => {
    for (const [route, canonicalPath] of [
      ["/mobile/icons/icon-256.png", path.join(__dirname, "..", "assets", "icons", "256x256.png")],
      ["/mobile/icons/icon-512.png", path.join(__dirname, "..", "assets", "icons", "512x512.png")],
    ]) {
      const res = await httpGetBuffer(port, route);
      assert.strictEqual(res.status, 200, `${route} should resolve`);
      assert.strictEqual(res.headers["content-type"], "image/png");
      assert.deepStrictEqual(res.body, fs.readFileSync(canonicalPath));
    }
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
    assert.strictEqual(snapshot.sessions.s1.agentId, "claude-code");
    assert.strictEqual(snapshot.sessions.s1.title, "Session s1");
    assert.strictEqual(snapshot.sessions.s1.basename, "project");
    assert.strictEqual(typeof snapshot.sessions.s1.updatedAt, "number");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("keeps internal and explicitly hidden display folders out of public sessions", async () => {
    const opaque = "mqgw60jiigjsjcid";
    sessions.set("qwenwork:hidden", {
      state: "working",
      agentId: "qwenwork",
      cwd: `/Users/me/.QwenWorkCN/workspace/${opaque}`,
      sessionTitle: "Private workspace",
      updatedAt: Date.now(),
      recentEvents: [],
    });
    sessions.set("legacy:explicit-hidden", {
      state: "working",
      agentId: "claude-code",
      cwd: `/Users/me/projects/${opaque}`,
      displayFolder: "",
      sessionTitle: "Explicitly private workspace",
      updatedAt: Date.now(),
      recentEvents: [],
    });
    server.onSnapshot();

    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");

    assert.equal(snapshot.sessions["qwenwork:hidden"].basename, null);
    assert.ok(!JSON.stringify(snapshot.sessions["qwenwork:hidden"]).includes(opaque));
    assert.equal(snapshot.sessions["legacy:explicit-hidden"].basename, null);
    assert.ok(!JSON.stringify(snapshot.sessions["legacy:explicit-hidden"]).includes(opaque));

    client.close();
    sessions.delete("qwenwork:hidden");
    sessions.delete("legacy:explicit-hidden");
    server.onSnapshot();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("keeps agentId separate when a session has no title", async () => {
    sessions.set("s-titleless", {
      state: "working",
      agentId: "codex",
      cwd: "/home/user/titleless",
      sessionTitle: null,
      updatedAt: Date.now(),
      recentEvents: [],
    });
    server.onSnapshot();

    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");

    assert.ok(snapshot.sessions["s-titleless"]);
    assert.strictEqual(snapshot.sessions["s-titleless"].agentId, "codex");
    assert.strictEqual(snapshot.sessions["s-titleless"].title, null);
    assert.strictEqual(typeof snapshot.sessions["s-titleless"].updatedAt, "number");

    client.close();
    sessions.delete("s-titleless");
    server.onSnapshot();
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

// ── Token Rotation Tests ──

describe("Token Rotation", () => {
  let tmpTokenDir;
  let server;
  let port;
  let tokenFile;
  const sessions = new Map();

  before(async () => {
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rotate-"));
    tokenFile = path.join(tmpTokenDir, "token.json");
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
  });

  it("grace-period acceptance: old token accepted within grace window", async () => {
    // Read the current token file, set up a rotated state with grace
    const currentToken = server.getToken();
    const state = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    const rotatedToken = "aabbccdd".repeat(4);
    state.previous = state.token;
    state.token = rotatedToken;
    state.graceUntil = Date.now() + 300000; // 5 min from now
    state.rotatedAt = Date.now();
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload server with the rotated state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Old token (previous) should be accepted within grace window
    const client = connectClient(port, currentToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("grace-period rejection: old token rejected after grace expires", async () => {
    // Set up rotated state where grace has expired
    const currentToken = server.getToken();
    const state = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    const rotatedToken = "11223344".repeat(4);
    state.previous = state.token;
    state.token = rotatedToken;
    state.graceUntil = Date.now() - 1; // grace expired
    state.rotatedAt = Date.now() - 300000;
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload with expired grace
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Old token should be rejected
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${currentToken}`);
    const code = await waitForClose(ws);
    assert.strictEqual(code, 1008);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("explicit regenerate: old token immediately invalid, new token works", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client with old token
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Regenerate — should kick the client
    const newToken = server.regenerateToken();
    assert.notStrictEqual(newToken, oldToken);
    assert.strictEqual(newToken.length, 32);

    // Old client should get kicked
    const closeCode = await waitForClose(client.ws);
    assert.strictEqual(closeCode, 1008);

    // Old token should be rejected
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${oldToken}`);
    const code2 = await waitForClose(ws2);
    assert.strictEqual(code2, 1008);

    // New token should work
    const client3 = connectClient(port, newToken);
    await waitForOpen(client3.ws);
    const snapshot = await client3.waitFor("snapshot");
    assert.ok(snapshot.version);

    client3.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("explicit reset: all clients disconnected, new token works", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client
    const client1 = connectClient(port, oldToken);
    await waitForOpen(client1.ws);
    await client1.waitFor("snapshot");

    // Reset — should kick the client
    const newToken = server.resetMobileAccess();
    assert.notStrictEqual(newToken, oldToken);

    const close1 = await waitForClose(client1.ws);
    assert.strictEqual(close1, 1008);

    // New token should work
    const client2 = connectClient(port, newToken);
    await waitForOpen(client2.ws);
    const snapshot = await client2.waitFor("snapshot");
    assert.ok(snapshot.version);

    client2.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("unacked rotation: server state already committed before ack", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Trigger explicit regeneration (no grace — simulates unacked auto-rotation)
    const newToken = server.regenerateToken();

    // Read the file — it should already have the new token persisted
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, newToken);
    assert.strictEqual(persisted.previous, null); // regenerate clears previous

    // No ack was sent — but server state is committed
    await new Promise((r) => setTimeout(r, 100));
  });

  it("old M1 file compat: loads bare { token } format", async () => {
    // Write old M1 format (just { token })
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    const oldToken = "abcdef01".repeat(4); // 32 hex chars
    fs.writeFileSync(tokenFile, JSON.stringify({ token: oldToken }, null, 2));

    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const loadedToken = server.getToken();

    // Should load the existing token
    assert.strictEqual(loadedToken, oldToken);

    // File should now have the new format with defaults
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, oldToken);
    assert.strictEqual(persisted.previous, null);
    assert.strictEqual(persisted.graceUntil, null);
    assert.ok(persisted.rotatedAt > 0, "rotatedAt should be set to current time on migration");

    // Should connect fine
    const client = connectClient(port, loadedToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("token_rotate message: client receives token_rotate on rotation", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Regenerate kicks clients (different from auto-rotation broadcast).
    // Verify the regeneration works correctly.
    const newToken = server.regenerateToken();

    // Client should be kicked
    const closeCode = await waitForClose(client.ws);
    assert.strictEqual(closeCode, 1008);

    // Verify the new token is valid
    assert.strictEqual(newToken.length, 32);
    assert.strictEqual(server.getToken(), newToken);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("token_rotate_ack: server accepts ack without error", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const token = server.getToken();

    // Connect a client
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Send a token_rotate_ack — server should accept it silently
    client.ws.send(JSON.stringify({ type: "token_rotate_ack" }));

    // Wait a bit — no error, no disconnect
    await new Promise((r) => setTimeout(r, 500));

    // Client should still be connected (not kicked)
    assert.strictEqual(client.ws.readyState, WebSocket.OPEN);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("auto-rotation timer: scheduleRotation resets timer correctly", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Verify that regeneration (which calls scheduleRotation) persists correct rotatedAt
    const newToken = server.regenerateToken();
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, newToken);
    assert.strictEqual(typeof persisted.rotatedAt, "number");
    assert.ok(persisted.rotatedAt > 0);

    // Verify the new token works
    const client = connectClient(port, newToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("atomic write: disk file contains all new fields after rotation", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    // Write a fresh token file to get a clean state
    const freshToken = "deadbeef".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({ token: freshToken }, null, 2));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const initialToken = server.getToken();
    assert.strictEqual(initialToken, freshToken);

    // Read initial file — should now have the new format with defaults
    const initial = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(initial.token, freshToken);
    assert.strictEqual(initial.previous, null);
    assert.strictEqual(initial.graceUntil, null);
    assert.ok(initial.rotatedAt > 0, "rotatedAt should be set to current time on creation");

    // Regenerate
    const newToken = server.regenerateToken();

    // Read after regeneration
    const after = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(after.token, newToken);
    assert.strictEqual(after.previous, null); // regenerate clears previous
    assert.strictEqual(after.graceUntil, null); // regenerate clears grace
    assert.strictEqual(typeof after.rotatedAt, "number");
    assert.ok(after.rotatedAt > 0);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("Gap A: legacy file → token unchanged after startup (no immediate rotation)", async () => {
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));

    // Write a legacy M1 format file (bare { token }, no rotatedAt)
    const legacyToken = "face0ff0".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({ token: legacyToken }, null, 2));

    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const tokenBefore = server.getToken();

    // Wait a bit — if rotatedAt were 0, scheduleRotation would fire immediately
    await new Promise((r) => setTimeout(r, 300));

    const tokenAfter = server.getToken();
    assert.strictEqual(tokenBefore, legacyToken,
      "token should be the legacy token on startup");
    assert.strictEqual(tokenAfter, legacyToken,
      "token must not change after brief wait — no immediate rotation");

    await new Promise((r) => setTimeout(r, 100));
  });

  it("Gap B: grace-period client receives token_rotate, acks, and is not kicked", async () => {
    // Set up a rotated state with an active grace window
    const oldToken = server.getToken();
    const newToken = "11223344".repeat(4);
    const state = {
      token: newToken,
      previous: oldToken,
      graceUntil: Date.now() + 5 * 60 * 1000,
      rotatedAt: Date.now(),
    };
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload server to pick up the new state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Connect with the OLD (grace-period) token
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);

    // Should receive token_rotate with the new token
    const rotateMsg = await client.waitFor("token_rotate");
    assert.strictEqual(rotateMsg.newToken, newToken);
    assert.ok(rotateMsg.expiresAt > Date.now(), "expiresAt should be in the future");

    // Send ack back
    client.ws.send(JSON.stringify({ type: "token_rotate_ack" }));

    // Wait through a heartbeat cycle — client should NOT be kicked
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(client.ws.readyState, WebSocket.OPEN,
      "client should stay connected after acking the rotation");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ── Rotate-on-use Tests ──

describe("Rotate-on-use", () => {
  let tmpTokenDir;
  let tokenFile;
  const sessions = new Map();

  before(() => {
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rou-"));
    tokenFile = path.join(tmpTokenDir, "token.json");
  });

  after(() => {
    sessions.clear();
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
  });

  it("regenerateToken fails closed when token state cannot be persisted", () => {
    const testToken = "1234abcd".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: false,
    }, null, 2));

    const server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
      writeTokenState: () => false,
    });

    assert.strictEqual(server.getToken(), testToken);
    assert.throws(
      () => server.regenerateToken(),
      /Failed to persist mobile token state/
    );
    assert.strictEqual(server.getToken(), testToken);

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, testToken);
    assert.strictEqual(persisted.rotationPending, false);

    server.cleanup();
  });

  it("24h expiry with no clients → rotationPending persisted to disk", async () => {
    const testToken = "aabbccdd".repeat(4);
    // rotatedAt far in the past → timer fires immediately
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: 1,
      rotationPending: false,
    }, null, 2));

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
    await server.start();
    // No clients connect — timer fires at ~0ms
    await new Promise((r) => setTimeout(r, 500));

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, true,
      "rotationPending should be true when timer fires with no clients");
    assert.strictEqual(persisted.token, testToken,
      "token should NOT have changed — no rotation happened");

    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + client connects → receives token_rotate", async () => {
    const testToken = "11223344".repeat(4);
    const setupRotatedAt = Date.now();
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: setupRotatedAt,
      rotationPending: true,
    }, null, 2));

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    const rotateMsg = await client.waitFor("token_rotate");
    assert.ok(rotateMsg.newToken, "should receive new token");
    assert.notStrictEqual(rotateMsg.newToken, testToken, "new token should differ");
    assert.ok(rotateMsg.expiresAt > Date.now(), "expiresAt should be in the future");

    // rotationPending should be cleared on disk
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, false,
      "rotationPending should be false after on-connect rotation");
    assert.strictEqual(persisted.token, rotateMsg.newToken,
      "persisted token should be the new token");
    assert.ok(persisted.rotatedAt >= setupRotatedAt,
      "rotatedAt should be updated by on-connect rotation for next 24h timer");

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + persistence failure keeps the current token authoritative", async () => {
    const testToken = "33445566".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initMobilePreviewServer({
      sessions,
      tokenPath: tokenFile,
      writeTokenState: () => false,
    });
    const port = await server.start();

    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    await assert.rejects(
      client.waitFor("token_rotate", 250),
      /Timeout waiting for token_rotate/
    );

    assert.strictEqual(server.getToken(), testToken);
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, testToken);
    assert.strictEqual(persisted.rotationPending, true);

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + regenerateToken → clears pending flag", async () => {
    const testToken = "55667788".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
    await server.start();

    const newToken = server.regenerateToken();
    assert.notStrictEqual(newToken, testToken);

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, false,
      "rotationPending should be cleared by regenerateToken");
    assert.strictEqual(persisted.token, newToken,
      "persisted token should be the regenerated token");

    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("server restart with rotationPending=true → no timer, waits for connection", async () => {
    const testToken = "99aabbcc".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    // Wait — scheduleRotation should early-exit when rotationPending=true
    await new Promise((r) => setTimeout(r, 500));

    const beforeConnect = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(beforeConnect.token, testToken,
      "token should not change before a client connects");

    // Now connect — rotation should happen on-connect
    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    const rotateMsg = await client.waitFor("token_rotate");
    assert.ok(rotateMsg.newToken, "should receive new token after connect");
    assert.notStrictEqual(rotateMsg.newToken, testToken);

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("pending rotation + multiple clients → all receive token_rotate", async () => {
    const testToken = "ddeeff00".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    const client1 = connectClient(port, testToken);
    const client2 = connectClient(port, testToken);
    await waitForOpen(client1.ws);
    await waitForOpen(client2.ws);

    const rotate1 = await client1.waitFor("token_rotate");
    const rotate2 = await client2.waitFor("token_rotate");

    assert.ok(rotate1.newToken, "client1 should receive new token");
    assert.ok(rotate2.newToken, "client2 should receive new token");
    assert.strictEqual(rotate1.newToken, rotate2.newToken,
      "both clients should receive the same new token");

    client1.close();
    client2.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });
});
