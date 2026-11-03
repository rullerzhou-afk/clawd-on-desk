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
  initMobilePreviewServer: createServer,
  isRetryablePortError,
  PROTOCOL_VERSION,
} = require("../src/network/mobile-preview-server");

function initMobilePreviewServer(options) {
  if (!fs.existsSync(options.tokenPath)) {
    fs.writeFileSync(options.tokenPath, JSON.stringify({ token: "a".repeat(32) }), { mode: 0o600 });
  }
  return createServer(options);
}

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
    token = "a".repeat(32);
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

  it("exposes the pair QR SVG only to Settings, never on the public endpoint", async () => {
    const info = server.getConnectionInfo();
    assert.strictEqual(info.status, "ok");
    assert.ok(typeof info.pairUrl === "string" && info.pairUrl.startsWith("http://"));
    assert.strictEqual(info.pairQrSvg, require("../src/mobile-pair-qr").buildPairQrSvg(info.pairUrl));
    assert.ok(info.pairQrSvg.startsWith("<svg"));

    const res = await httpGet(port, "/api/connection-info");
    const publicInfo = JSON.parse(res.body);
    assert.ok(!("pairQrSvg" in publicInfo));
    assert.ok(!("pairCode" in publicInfo));
    assert.ok(!("pairUrl" in publicInfo));
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${"a".repeat(32)}`);
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
    const client = connectClient(port, "a".repeat(32));
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
    assert.match(outcome.error.message, /stopped|superseded|cancelled/);
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
