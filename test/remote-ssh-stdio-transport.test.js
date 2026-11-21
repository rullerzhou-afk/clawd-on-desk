"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { Duplex, PassThrough } = require("node:stream");
const vm = require("node:vm");
const multiplex = require("multiplex");

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
  child.stdout = new PassThrough();
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

// This checks multiplex 6.7.0's internal channel tables; recheck when upgrading multiplex.
function assertMuxChannelsReleased(mux) {
  assert.equal(mux._local.filter(Boolean).length, 0);
  assert.equal(mux._remote.filter(Boolean).length, 0);
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

test("PR #1366 follow-up: stdio transport sends heartbeat data and one shutdown control stream", async () => {
  const child = makeFakeChild();
  const controls = [];
  let tick = null;
  let cleared = null;
  let streamHandler;
  let muxEnds = 0;
  const transport = createRemoteSshStdioTransport({
    child,
    localPort: 23456,
    challenge: "b".repeat(32),
    heartbeatIntervalMs: 8000,
    createMultiplex(_options, handler) {
      streamHandler = handler;
      const mux = new PassThrough();
      mux.destroyed = false;
      const end = mux.end.bind(mux);
      mux.end = () => { muxEnds++; return end(); };
      mux.createStream = (id) => {
        const stream = new PassThrough();
        const chunks = [];
        stream.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
          controls.push({ id, value: Buffer.concat(chunks) });
        });
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

  assert.equal(tick, null);
  const ready = new PassThrough();
  streamHandler(ready, STDIO_READY_STREAM);
  ready.end("b".repeat(32));
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  transport.close();
  transport.close();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared !== null, true);
  assert.deepEqual(
    controls.map((entry) => entry.id),
    [STDIO_HEARTBEAT_STREAM, STDIO_SHUTDOWN_STREAM],
  );
  assert.deepEqual(controls[0].value, Buffer.from([0]));
  assert.equal(controls[1].value.toString(), "b".repeat(32));
  assert.equal(muxEnds, 1);
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
});

test("PR #1366 follow-up: bundled bridge rejects invalid challenges before writing stdout", () => {
  for (const challenge of ["", "A".repeat(32), "a".repeat(31)]) {
    const result = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, "..", "hooks", "remote-ssh-stdio-bridge.js"),
      "45001", challenge,
    ], { timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 64, `challenge: ${JSON.stringify(challenge)}`);
    assert.equal(result.stdout.length, 0, `challenge: ${JSON.stringify(challenge)}`);
  }
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

test("PR #1366 follow-up: challenge rejects wrong, fragmented and oversized values and becomes ready once", () => {
  for (const chunks of [["d".repeat(32)], ["c".repeat(16)], ["x".repeat(257), "c".repeat(32)], ["c".repeat(16), "c".repeat(16), "c".repeat(32)]]) {
    const child = makeFakeChild();
    let streamHandler;
    let calls = 0;
    const mux = new PassThrough();
    mux.createStream = () => new PassThrough();
    const transport = createRemoteSshStdioTransport({
      child, localPort: 45001, challenge: "c".repeat(32),
      createMultiplex(_options, handler) { streamHandler = handler; return mux; },
      onReady() { calls++; }, setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {},
    });
    const stream = new PassThrough();
    streamHandler(stream, STDIO_READY_STREAM);
    for (let i = 0; i < chunks.length; i++) {
      stream.write(chunks[i]);
      if (i === 0 && chunks[i].length === 16) assert.equal(calls, 0);
    }
    assert.equal(calls, chunks[0] === "c".repeat(16) && chunks.length > 1 ? 1 : 0);
    transport.close({ cooperative: false });
  }
});

test("PR #1366 follow-up: bundled bridge skips startup banners and proxies HTTP once ready", async (t) => {
  const localServer = http.createServer((req, res) => {
    res.end(`received:${req.url}`);
  });
  const localPort = await listen(localServer);
  t.after(() => closeServer(localServer));
  const bridgePort = await reservePort();
  const challenge = "e".repeat(32);
  const child = childProcess.spawn(process.execPath, [
    path.join(__dirname, "fixtures", "remote-ssh-stdio-startup-banner.js"),
    String(bridgePort), challenge,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let readyCalls = 0;
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error("bridge ready timeout")), 3000);
    child.once("error", reject);
    const transport = createRemoteSshStdioTransport({
      child, localPort, challenge,
      onReady() { readyCalls++; resolve(transport); },
      onError: reject,
    });
    t.after(() => transport.close({ cooperative: false }));
  });
  t.after(() => clearTimeout(readyTimer));
  const transport = await ready;
  clearTimeout(readyTimer);
  const response = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: bridgePort, path: "/state", agent: false }, (res) => {
      let value = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { value += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, value }));
    });
    req.on("error", reject);
  });
  assert.deepEqual(response, { status: 200, value: "received:/state" });
  assert.equal(readyCalls, 1);
  assert.ok(transport.getStatus().skippedStartupBytes > 0);
  assert.equal(transport.getStatus().startupBufferedBytes, 0);
  transport.close();
  assert.equal(await waitForExit(child), 0);
});

function startupMarker(challenge) {
  return Buffer.from(`\n__clawd_stdio_begin__:${challenge}\n`);
}

async function encodeRemoteFrames(challenge, payload) {
  const remote = multiplex({ chunked: true, halfOpen: true });
  const chunks = [];
  remote.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  remote.createStream(STDIO_READY_STREAM).end(challenge);
  remote.createStream("hook").end(payload);
  await new Promise((resolve) => setImmediate(resolve));
  const frames = Buffer.concat(chunks);
  remote.destroy();
  return frames;
}

for (const layout of ["bytewise", "single chunk", "marker tail with frames then another chunk", "partial prefix", "marker in payload"]) {
  test(`PR #1366 follow-up: startup scanner preserves real multiplex frames (${layout})`, async (t) => {
    const child = makeFakeChild();
    const challenge = "1".repeat(32);
    const marker = startupMarker(challenge);
    const banner = Buffer.concat([
      Buffer.from("banner:你好\n"), Buffer.from([0xff, 0x80]), startupMarker("2".repeat(32)),
    ]);
    const payload = Buffer.concat([
      Buffer.from("POST /state\r\n\r\nbefore"),
      layout === "marker in payload" ? marker : Buffer.alloc(0),
      Buffer.from([0xff, 0, 0x80]), Buffer.from("after"),
    ]);
    const frames = await encodeRemoteFrames(challenge, payload);
    const received = [];
    const errors = [];
    let readyCalls = 0;
    let connections = 0;
    let localMux;
    const transport = createRemoteSshStdioTransport({
      child, localPort: 45001, challenge,
      createMultiplex(options, handler) { localMux = multiplex(options, handler); return localMux; },
      connect(options) {
        assert.deepEqual(options, { host: "127.0.0.1", port: 45001 });
        connections++;
        return new Duplex({
          read() {},
          write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); },
        });
      },
      onReady() { readyCalls++; }, onError: (err) => errors.push(err),
      setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {},
    });
    t.after(() => transport.close({ cooperative: false }));
    const prefix = layout === "partial prefix" ? marker.subarray(0, 17) : Buffer.alloc(0);
    const beforeMarker = Buffer.concat([banner, prefix]);
    const all = Buffer.concat([beforeMarker, marker, frames]);
    if (layout === "bytewise") {
      for (const byte of all) child.stdout.write(Buffer.from([byte]));
    } else if (layout === "marker tail with frames then another chunk") {
      const split = beforeMarker.length + marker.length - 5;
      child.stdout.write(all.subarray(0, split));
      child.stdout.write(all.subarray(split, split + 5 + 10));
      child.stdout.write(all.subarray(split + 5 + 10));
    } else {
      child.stdout.write(all);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.equal(readyCalls, 1);
    assert.equal(connections, 1);
    assert.deepEqual(Buffer.concat(received), payload);
    assert.equal(transport.getStatus().startupBufferedBytes, 0);
    assert.equal(transport.getStatus().skippedStartupBytes, beforeMarker.length);
    // After handoff only the pipe listener may consume future stdout chunks.
    assert.equal(child.stdout.listenerCount("data"), 1);
    transport.close({ cooperative: false });
    await new Promise((resolve) => setImmediate(resolve));
    assertMuxChannelsReleased(localMux);
  });
}

test("PR #1366 follow-up: startup scanner retains only a marker-sized tail without a marker", () => {
  const child = makeFakeChild();
  const challenge = "3".repeat(32);
  const mux = new PassThrough();
  mux.createStream = () => assert.fail("no control stream before ready");
  const frames = [];
  mux.on("data", (chunk) => frames.push(chunk));
  const transport = createRemoteSshStdioTransport({
    child, localPort: 45001, challenge, createMultiplex: () => mux,
    onReady: () => assert.fail("startup text is not ready"),
    setIntervalFn: () => assert.fail("no timer before ready"),
  });
  const text = Buffer.alloc(1024 * 1024, 0x78);
  child.stdout.write(text);
  const status = transport.getStatus();
  const retained = startupMarker(challenge).length - 1;
  assert.equal(status.ready, false);
  assert.equal(status.startupBufferedBytes, retained);
  assert.equal(status.skippedStartupBytes, text.length - retained);
  assert.equal(frames.length, 0);
  transport.close({ cooperative: false });
});

for (const cooperative of [true, false]) {
  test(`PR #1366 follow-up: close before the startup marker prevents any later mux input (cooperative=${cooperative})`, () => {
    const child = makeFakeChild();
    const challenge = "4".repeat(32);
    const mux = new PassThrough();
    const writes = [];
    const controls = [];
    let pipes = 0;
    const pipe = child.stdout.pipe.bind(child.stdout);
    child.stdout.pipe = (destination) => { pipes++; return pipe(destination); };
    mux.on("data", (chunk) => writes.push(chunk));
    mux.createStream = (id) => ({ end: (value) => controls.push({ id, value }) });
    const transport = createRemoteSshStdioTransport({
      child, localPort: 45001, challenge, createMultiplex: () => mux,
      setIntervalFn: () => assert.fail("no timer before ready"),
    });
    child.stdout.write(startupMarker(challenge).subarray(0, 12));
    transport.close({ cooperative });
    transport.close();
    child.stdout.write(Buffer.concat([startupMarker(challenge), Buffer.from("late data")]));
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(transport.getStatus().startupBufferedBytes, 0);
    assert.equal(pipes, 0);
    assert.deepEqual(writes, []);
    assert.deepEqual(controls, cooperative ? [{ id: STDIO_SHUTDOWN_STREAM, value: challenge }] : []);
  });
}

test("PR #1366 follow-up: heartbeat waits for ready, reuses one channel and bounds pending writes", () => {
  const child = makeFakeChild();
  const created = [];
  const writes = [];
  let callback;
  let hold = false;
  let tick;
  let streamHandler;
  let cleared = 0;
  const heartbeat = new EventEmitter();
  heartbeat.write = (chunk, done) => {
    writes.push(Buffer.from(chunk));
    if (hold) callback = done;
    else done();
    return !hold;
  };
  heartbeat.end = () => assert.fail("heartbeat must be closed by mux.end");
  const mux = makeFakeMux();
  mux.createStream = (id) => {
    created.push(id);
    assert.equal(id, STDIO_HEARTBEAT_STREAM);
    return heartbeat;
  };
  const timer = { unref() {} };
  const transport = createRemoteSshStdioTransport({
    child, localPort: 45001, challenge: "5".repeat(32),
    createMultiplex(_options, handler) { streamHandler = handler; return mux; },
    setIntervalFn(fn, ms) { assert.equal(ms, 8000); tick = fn; return timer; },
    clearIntervalFn(value) { assert.equal(value, timer); cleared++; },
  });
  for (let i = 0; i < 10; i++) tick?.();
  assert.equal(tick, undefined);
  assert.deepEqual(created, []);
  assert.deepEqual(writes, []);
  const ready = new PassThrough();
  streamHandler(ready, STDIO_READY_STREAM);
  ready.write("5".repeat(32));
  assert.deepEqual(created, [STDIO_HEARTBEAT_STREAM]);
  for (let i = 0; i < 1000; i++) tick();
  assert.equal(writes.length, 1000);
  assert.equal(Buffer.concat(writes).length, 1000);
  assert.equal(heartbeat.listenerCount("error"), 1);
  assert.equal(heartbeat.listenerCount("drain"), 0);
  hold = true;
  tick();
  for (let i = 0; i < 1000; i++) tick();
  assert.equal(writes.length, 1001);
  callback();
  tick();
  assert.equal(writes.length, 1002);
  assert.deepEqual(created, [STDIO_HEARTBEAT_STREAM]);
  assert.equal(heartbeat.listenerCount("error"), 1);
  transport.close({ cooperative: false });
  transport.close();
  callback();
  tick();
  assert.equal(cleared, 1);
  assert.equal(writes.length, 1002);
});

for (const cooperative of [true, false]) {
  test(`PR #1366 follow-up: real multiplex close releases control channels (cooperative=${cooperative})`, async () => {
    const child = makeFakeChild();
    child.stdin = new PassThrough();
    const challenge = "6".repeat(32);
    const controls = [];
    let tick;
    let cleared = 0;
    let localMux;
    const remote = multiplex({ chunked: true, halfOpen: true }, (stream, id) => {
      const entry = { id, bytes: 0, value: "" };
      controls.push(entry);
      stream.on("data", (chunk) => { entry.bytes += chunk.length; entry.value += chunk; });
      stream.on("error", () => {});
    });
    remote.pipe(child.stdout);
    child.stdin.pipe(remote);
    const transport = createRemoteSshStdioTransport({
      child, localPort: 45001, challenge,
      createMultiplex(options, handler) { localMux = multiplex(options, handler); return localMux; },
      setIntervalFn(fn) { tick = fn; return { unref() {} }; },
      clearIntervalFn() { cleared++; },
    });
    child.stdout.write(startupMarker(challenge));
    remote.createStream(STDIO_READY_STREAM).end(challenge);
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    transport.close({ cooperative });
    transport.close();
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 1);
    assert.equal(controls.filter((entry) => entry.id === STDIO_HEARTBEAT_STREAM).length, 1);
    assert.equal(controls.find((entry) => entry.id === STDIO_HEARTBEAT_STREAM).bytes, 2);
    const shutdowns = controls.filter((entry) => entry.id === STDIO_SHUTDOWN_STREAM);
    assert.equal(shutdowns.length, cooperative ? 1 : 0);
    if (cooperative) assert.equal(shutdowns[0].value, challenge);
    for (const mux of [localMux, remote]) {
      assertMuxChannelsReleased(mux);
    }
  });
}

test("PR #1366 follow-up: onReady can close synchronously without restoring the stdout pipe", () => {
  const child = makeFakeChild();
  const challenge = "7".repeat(32);
  const frames = Buffer.from("ready and business frames");
  let tick;
  let clears = 0;
  const transport = createRemoteSshStdioTransport({
    child, localPort: 45001, challenge,
    connect: () => assert.fail("closed transport must not connect"),
    createMultiplex(_options, handler) {
      const mux = makeFakeMux();
      mux.write = (chunk) => {
        assert.deepEqual(chunk, frames);
        const ready = new PassThrough();
        handler(ready, STDIO_READY_STREAM);
        ready.write(challenge);
        handler(new PassThrough(), "hook");
        return true;
      };
      return mux;
    },
    onReady() { transport.close({ cooperative: false }); },
    setIntervalFn(fn) { tick = fn; return { unref() {} }; },
    clearIntervalFn() { clears++; },
  });
  child.stdout.write(Buffer.concat([startupMarker(challenge), frames]));
  tick();
  assert.equal(transport.getStatus().closed, true);
  assert.equal(clears, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
});

function runBridgeWithClock() {
  let now = 0;
  const timers = new Set();
  const exits = [];
  const challenge = "8".repeat(32);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    assert.equal(port, 45001);
    assert.equal(host, "127.0.0.1");
    callback();
  };
  server.close = () => {};
  const fakeProcess = {
    argv: ["node", "bridge", "45001", challenge], stdin, stdout,
    exitCode: undefined, exit: (code) => exits.push(code),
  };
  function schedule(fn, delay, repeat = false) {
    const timer = { fn, due: now + delay, delay, repeat };
    timers.add(timer);
    return timer;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "remote-ssh-stdio-bridge-entry.js"), "utf8"), {
    require(id) {
      if (id === "net") return { createServer: () => server };
      if (id === "multiplex") return multiplex;
      throw new Error(`Unexpected bridge dependency: ${id}`);
    },
    process: fakeProcess,
    Date: { now: () => now },
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: (timer) => timers.delete(timer),
    setTimeout: (fn, delay) => schedule(fn, delay),
  });
  return {
    challenge, stdin, stdout, output, exits, fakeProcess,
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a.due - b.due)[0];
        if (!next || next.due > target) break;
        now = next.due;
        if (next.repeat) next.due += next.delay;
        else timers.delete(next);
        next.fn();
      }
      now = target;
    },
  };
}

test("PR #1366 follow-up: bridge heartbeat data keeps one channel alive and silence still times out", async () => {
  const bridge = runBridgeWithClock();
  const local = multiplex({ chunked: true, halfOpen: true });
  local.pipe(bridge.stdin);
  const heartbeat = local.createStream(STDIO_HEARTBEAT_STREAM);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Buffer.concat(bridge.output).subarray(0, startupMarker(bridge.challenge).length).equals(startupMarker(bridge.challenge)));
  for (let seconds = 5; seconds <= 40; seconds += 5) {
    bridge.advance(5000);
    heartbeat.write(Buffer.from([0]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.fakeProcess.exitCode, undefined, `bridge alive at ${seconds}s`);
    assert.deepEqual(bridge.exits, []);
  }
  bridge.advance(30000);
  assert.deepEqual(bridge.exits, []);
  bridge.advance(5050);
  assert.equal(bridge.fakeProcess.exitCode, 0);
  assert.deepEqual(bridge.exits, [0]);
  local.destroy();
});

test("PR #1366 follow-up: bridge stdout errors shut down with exit code 74", () => {
  const bridge = runBridgeWithClock();
  bridge.stdout.emit("error", new Error("broken stdout"));
  bridge.advance(50);
  assert.equal(bridge.fakeProcess.exitCode, 74);
  assert.deepEqual(bridge.exits, [74]);
});

test("PR #1366 follow-up: bundled bridge matches the shared esbuild configuration", async () => {
  const { buildRemoteSshBridge } = require("../scripts/build-remote-ssh-stdio-bridge");
  const output = await buildRemoteSshBridge({ write: false, logLevel: "silent" });
  const actual = fs.readFileSync(path.join(__dirname, "..", "hooks", "remote-ssh-stdio-bridge.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const expected = output.text.replace(/\r\n/g, "\n");
  assert.equal(actual, expected);
});
