"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  STDIO_HEARTBEAT_STREAM,
  STDIO_READY_STREAM,
  STDIO_SHUTDOWN_STREAM,
  createRemoteSshStdioTransport,
} = require("../src/remote-ssh-stdio-transport");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdin.write = () => true;
  child.stdin.destroy = () => {};
  child.stdout = new EventEmitter();
  child.stdout.pipe = (destination) => destination;
  child.stdout.destroy = () => {};
  child.stderr = new EventEmitter();
  child.stderr.destroy = () => {};
  return child;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function reservePort() {
  const server = net.createServer();
  return listen(server).then((port) => closeServer(server).then(() => port));
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function makeFakeMux() {
  const mux = new EventEmitter();
  mux.destroyed = false;
  mux.pipe = (destination) => destination;
  mux.end = () => {};
  mux.destroy = () => { mux.destroyed = true; };
  mux.createStream = () => new PassThrough();
  return mux;
}

test("stdio transport proxies streams to the profile ingress and acknowledges readiness", () => {
  const child = makeFakeChild();
  const localSockets = [];
  let readyCalls = 0;
  let streamHandler = null;
  let fakeMux = null;

  const transport = createRemoteSshStdioTransport({
    child,
    localPort: 23456,
    challenge: "a".repeat(32),
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    connect(options) {
      assert.deepEqual(options, { host: "127.0.0.1", port: 23456 });
      const socket = new PassThrough();
      socket.setNoDelay = () => {};
      localSockets.push(socket);
      return socket;
    },
    createMultiplex(options, handler) {
      assert.deepEqual(options, { chunked: true, halfOpen: true });
      streamHandler = handler;
      fakeMux = makeFakeMux();
      return fakeMux;
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    onReady() {
      readyCalls += 1;
    },
  });

  const readyStream = new PassThrough();
  streamHandler(readyStream, STDIO_READY_STREAM);
  readyStream.write("a".repeat(32));
  assert.equal(readyCalls, 1);

  const hookStream = new PassThrough();
  streamHandler(hookStream, "1");
  assert.equal(localSockets.length, 1);
  assert.equal(transport.isReady(), true);

  transport.close();
  assert.equal(transport.getStatus().closed, true);
  assert.equal(fakeMux.destroyed, false);
  fakeMux.destroy();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
});

test("stdio transport sends heartbeat and shutdown control streams", async () => {
  const child = makeFakeChild();
  const controls = [];
  let tick = null;
  let cleared = null;
  const transport = createRemoteSshStdioTransport({
    child,
    localPort: 23456,
    challenge: "b".repeat(32),
    heartbeatIntervalMs: 8000,
    createMultiplex() {
      const mux = new PassThrough();
      mux.destroyed = false;
      mux.createStream = (id) => {
        const stream = new PassThrough();
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk).toString()));
        stream.on("finish", () => controls.push({ id, value: chunks.join("") }));
        return stream;
      };
      return mux;
    },
    setIntervalFn(fn) {
      tick = fn;
      return { unref() {} };
    },
    clearIntervalFn(timer) {
      cleared = timer;
    },
  });

  tick();
  transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared !== null, true);
  assert.deepEqual(
    controls.map((entry) => entry.id),
    [STDIO_HEARTBEAT_STREAM, STDIO_SHUTDOWN_STREAM],
  );
  assert.ok(controls.every((entry) => entry.value === "b".repeat(32)));
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
});

test("bundled bridge multiplexes concurrent HTTP requests over stdio", async () => {
  const localServer = http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method}:${req.url}:${bytes}`);
    });
  });
  const localPort = await listen(localServer);
  const bridgePort = await reservePort();
  const challenge = "c".repeat(32);
  const child = childProcess.spawn(process.execPath, [
    path.join(__dirname, "..", "hooks", "remote-ssh-stdio-bridge.js"),
    String(bridgePort),
    challenge,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const transport = createRemoteSshStdioTransport({
    child,
    localPort,
    challenge,
    heartbeatIntervalMs: 1000,
    onReady: resolveReady,
  });
  let readyTimer = null;
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error("bridge ready timeout")), 3000);
    }),
  ]);
  clearTimeout(readyTimer);

  const body = "x".repeat(32768);
  const requests = Array.from({ length: 8 }, (_unused, index) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: bridgePort,
      path: `/state?i=${index}`,
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let value = "";
      res.on("data", (chunk) => {
        value += chunk;
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        value,
        expected: `POST:/state?i=${index}:32768`,
      }));
    });
    req.on("error", reject);
    req.end(body);
  }));

  const results = await Promise.all(requests);
  assert.ok(results.every((entry) =>
    entry.status === 200 && entry.value === entry.expected));

  const conflictingBridge = childProcess.spawn(process.execPath, [
    path.join(__dirname, "..", "hooks", "remote-ssh-stdio-bridge.js"),
    String(bridgePort),
    "d".repeat(32),
  ], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.equal(await waitForExit(conflictingBridge), 98);

  transport.close({ cooperative: true });
  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 0);
  await closeServer(localServer);
});
