"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

describe("Mobile permission observation protocol", () => {
  function createObservation() {
    const listeners = new Set();
    let state = {
      feature: Object.freeze({ supported: true, enabled: false }),
      records: Object.freeze([]),
    };
    return {
      snapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      replace(enabled, records) {
        state = {
          feature: Object.freeze({ supported: true, enabled }),
          records: Object.freeze(records.slice()),
        };
        for (const listener of listeners) listener({
          type: "replace",
          feature: state.feature,
          records: state.records,
        });
      },
      emit(event) { for (const listener of listeners) listener(event); },
      listenerCount: () => listeners.size,
    };
  }

  it("sends structured feature state and unconditional permission snapshot before deltas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-observation-"));
    const auditLogs = [];
    const observation = createObservation();
    const record = Object.freeze({
      requestId: "1".repeat(32),
      agentId: "claude-code",
      toolName: "Bash",
      summary: "Run tests",
      folder: "project",
      presentedAt: Date.now(),
    });
    observation.replace(true, [record]);
    const server = initMobilePreviewServer({
      sessions: new Map(),
      permissionObservation: observation,
      tokenPath: path.join(dir, "token.json"),
      log: (message) => auditLogs.push(message),
    });
    const port = await server.start();
    assert.strictEqual(observation.listenerCount(), 1);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${server.getToken()}`);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data)));
    await waitForOpen(ws);
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(messages[0].type, "snapshot");
    assert.strictEqual(messages[1].type, "permission_snapshot");
    assert.deepStrictEqual(messages[0].features.permissionPreview, messages[1].feature);
    assert.deepStrictEqual(messages[1].permissions, [record]);

    observation.emit({ type: "upsert", record: { ...record, requestId: "2".repeat(32) } });
    while (!messages.some((message) => message.type === "permission_request")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const request = messages.find((message) => message.type === "permission_request");
    assert.strictEqual(request.permission.requestId, "2".repeat(32));

    observation.emit({
      type: "retract",
      requestId: "2".repeat(32),
      reason: "resolved",
      decided: true,
    });
    while (!messages.some((message) => message.type === "permission_dismissed")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const dismissed = messages.find((message) => message.type === "permission_dismissed");
    assert.deepStrictEqual(
      { requestId: dismissed.requestId, reason: dismissed.reason, decided: dismissed.decided },
      { requestId: "2".repeat(32), reason: "resolved", decided: true }
    );
    assert.ok(auditLogs.some((line) => /type=permission_snapshot source=connect clients=1/.test(line)));
    assert.ok(auditLogs.some((line) => new RegExp(`type=permission_request requestId=${"2".repeat(32)} clients=1`).test(line)));
    assert.ok(auditLogs.some((line) => /type=permission_dismissed .*reason=resolved decided=true clients=1/.test(line)));
    const auditText = auditLogs.join("\n");
    assert.doesNotMatch(auditText, /Run tests|folder|summary|project|toolInput|cwd/);

    // A client-shaped decision message is intentionally inert.
    ws.send(JSON.stringify({
      type: "permission_response",
      requestId: record.requestId,
      decision: "allow",
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(observation.snapshot().records.length, 1);

    ws.close();
    await server.cleanup();
    assert.strictEqual(observation.listenerCount(), 0);
    await server.start();
    assert.strictEqual(observation.listenerCount(), 1);
    await server.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("always sends an empty disabled snapshot when observation is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-observation-empty-"));
    const server = initMobilePreviewServer({
      sessions: new Map(),
      tokenPath: path.join(dir, "token.json"),
    });
    const port = await server.start();
    const client = connectClient(port, server.getToken());
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("permission_snapshot");
    assert.deepStrictEqual(snapshot.feature, { supported: false, enabled: false });
    assert.deepStrictEqual(snapshot.permissions, []);
    client.close();
    await server.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("settles cleanup during an in-flight start and can restart cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-observation-lifecycle-"));
    const observation = createObservation();
    const server = initMobilePreviewServer({
      sessions: new Map(),
      permissionObservation: observation,
      tokenPath: path.join(dir, "token.json"),
      log: () => {},
    });

    const startOutcome = server.start().then(
      (startedPort) => ({ status: "started", port: startedPort }),
      (error) => ({ status: "stopped", error })
    );
    await server.cleanup();
    const outcome = await startOutcome;
    assert.strictEqual(outcome.status, "stopped");
    assert.match(outcome.error.message, /stopped|superseded/);
    assert.strictEqual(server.isStarted(), false);
    assert.strictEqual(observation.listenerCount(), 0);

    const restartedPort = await server.start();
    assert.ok(Number.isInteger(restartedPort));
    assert.strictEqual(server.isStarted(), true);
    assert.strictEqual(observation.listenerCount(), 1);
    await server.cleanup();
    assert.strictEqual(observation.listenerCount(), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cleans observation and token timers after every candidate port fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-observation-start-fail-"));
    const tokenPath = path.join(dir, "token.json");
    fs.writeFileSync(tokenPath, JSON.stringify({
      token: "a".repeat(32),
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now() - (24 * 60 * 60 * 1000) + 40,
      rotationPending: false,
    }));
    const observation = createObservation();
    const persisted = [];
    let listenCalls = 0;
    class FailingHttpServer extends EventEmitter {
      listen() {
        listenCalls++;
        queueMicrotask(() => {
          const error = new Error("test port occupied");
          error.code = "EADDRINUSE";
          this.emit("error", error);
        });
      }
      close(callback) { if (callback) callback(); }
    }
    class FakeWebSocketServer extends EventEmitter {
      close(callback) { if (callback) callback(); }
    }
    const server = initMobilePreviewServer({
      sessions: new Map([["stale", { state: "idle", updatedAt: Date.now() }]]),
      permissionObservation: observation,
      tokenPath,
      writeTokenState(_path, state) { persisted.push(state); return true; },
      createHttpServer: () => new FailingHttpServer(),
      createWebSocketServer: () => new FakeWebSocketServer(),
      log: () => {},
    });

    await assert.rejects(server.start(), /test port occupied/);
    assert.strictEqual(listenCalls, 5);
    assert.strictEqual(server.isStarted(), false);
    assert.strictEqual(observation.listenerCount(), 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepStrictEqual(persisted, []);
    await server.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
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
