"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Duplex } = require("node:stream");
const WebSocket = require("ws");
const { initMobilePreviewServer } = require("../src/network/mobile-preview-server");
const { atomicWrite, hash } = require("../src/network/mobile-device-store");

const LEGACY = "a".repeat(32);
const PREVIOUS = "b".repeat(32);
const cid = (n = 1) => "c_" + String(n).padStart(22, "0");

class Socket extends EventEmitter {
  constructor() { super(); this.messages = []; this.readyState = 1; this.pongs = 0; }
  send(data) { this.messages.push(JSON.parse(data)); }
  close(code, reason) { this.code = code; this.reason = reason; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(1006); }
  ping() { this.pongs++; this.emit("pong"); }
  rotation() { return this.messages.findLast((msg) => msg.type === "token_rotate"); }
}

async function fixture(t, options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), "clawd-device-test-"));
  const tokenPath = path.join(dir, "mobile-token.json");
  const devicesPath = path.join(dir, "mobile-devices.json");
  if (!options.dir && !options.missingToken) atomicWrite(tokenPath, { token: LEGACY, previous: options.previous || null, graceUntil: options.graceUntil || null });
  let time = options.time || 1000000;
  let failDevices = false;
  let failToken = false;
  let socketServer;
  let socketServerOptions;
  let serve;
  const logs = [];
  const server = initMobilePreviewServer({
    tokenPath, devicesPath, sessions: new Map(), now: () => time, rotationMs: 1000, heartbeatMs: 100,
    permissionObservation: options.permissionObservation,
    pairTimeoutMs: options.pairTimeoutMs || 60000,
    log: (line) => logs.push(line),
    writeDeviceState(file, value) { if (failDevices || options.failDevices) return false; return atomicWrite(file, value); },
    writeTokenState(file, value) { if (failToken) return false; return atomicWrite(file, value); },
    ...options.ctx,
    createHttpServer(handler) {
      serve = handler;
      const http = new EventEmitter();
      http.listen = () => { http.listening = true; queueMicrotask(() => http.emit("listening")); };
      http.close = (cb) => { http.listening = false; if (cb) cb(); };
      return http;
    },
    createWebSocketServer(wsOptions) {
      socketServerOptions = wsOptions;
      socketServer = new EventEmitter();
      socketServer.close = (cb) => cb && cb();
      return socketServer;
    },
  });
  await server.start();
  t.after(async () => { await server.cleanup(); if (!options.dir) fs.rmSync(dir, { recursive: true, force: true }); });
  function connect(params, ip = "127.0.0.1", socket = new Socket()) {
    socketServer.emit("connection", socket, { url: "/ws?" + new URLSearchParams(params), headers: { "user-agent": "iPhone Safari/17" }, socket: { remoteAddress: ip } });
    return socket;
  }
  return {
    server, dir, tokenPath, devicesPath, logs, connect, socketServerOptions,
    read: () => JSON.parse(fs.readFileSync(devicesPath, "utf8")),
    time: (value) => { time = value; },
    failDevices: (value) => { failDevices = value; },
    failToken: (value) => { failToken = value; },
    legacy: (n = 1) => connect({ token: LEGACY, proto: "2", cid: cid(n) }),
    pair(code = server.getConnectionInfo().pairCode, n = 1) { return connect({ pair: code, proto: "2", cid: cid(n) }); },
    device(token, proto = "2") { return connect({ token, proto, cid: cid() }); },
    staticResponse(route) {
      return new Promise((resolve) => {
        let status;
        serve({ url: route }, {
          writeHead(code) { status = code; },
          end(body) { resolve({ status, body: String(body) }); },
        });
      });
    },
    publicInfo() {
      let body;
      serve({ url: "/api/connection-info" }, { writeHead() {}, end(value) { body = value; } });
      return JSON.parse(body);
    },
  };
}

function sameRotation(actual, expected) {
  assert.deepEqual({ ...actual, timestamp: 0 }, { ...expected, timestamp: 0 });
}

function checkSnapshot(socket) {
  assert.equal(socket.code, undefined);
  assert.deepEqual(socket.messages.slice(0, 2).map((m) => m.type), ["snapshot", "permission_snapshot"]);
}

function fillDevices(f) {
  for (let n = 1; n <= 20; n++) {
    const connection = f.legacy(n);
    assert.ok(connection.rotation());
    connection.close(1000);
  }
}

test("device list exposes only display fields and reads lastSeenAt without persisting", async (t) => {
  const f = await fixture(t);
  const rotation = f.pair().rotation();
  const pending = f.read().devices[0];
  assert.deepEqual(f.server.listDevices(), [{
    id: pending.id,
    name: "iPhone · Safari",
    origin: "pair",
    state: "pending",
    createdAt: 1000000,
    lastSeenAt: 1000000,
    currentIssuedAt: null,
  }]);
  const active = f.device(rotation.newToken);
  const before = fs.readFileSync(f.devicesPath, "utf8");
  f.time(1000100);
  active.emit("pong");
  const devices = f.server.listDevices();
  assert.deepEqual(devices, [{
    id: pending.id,
    name: "iPhone · Safari",
    origin: "pair",
    state: "active",
    createdAt: 1000000,
    lastSeenAt: 1000100,
    currentIssuedAt: 1000000,
  }]);
  assert.deepEqual(Object.keys(devices[0]).sort(),
    ["id", "name", "origin", "state", "createdAt", "lastSeenAt", "currentIssuedAt"].sort());
  assert.equal(fs.readFileSync(f.devicesPath, "utf8"), before);
  devices[0].name = "changed by caller";
  devices.pop();
  assert.equal(f.server.listDevices()[0].name, pending.name);
});

test("legacy activity is false on fresh install, true on upgrade, false after revocation", async (t) => {
  const fresh = await fixture(t, { missingToken: true });
  assert.equal(fresh.server.isLegacyActive(), false);
  const upgrade = await fixture(t, { previous: PREVIOUS, graceUntil: 1000001 });
  assert.equal(upgrade.server.isLegacyActive(), true);
  upgrade.server.revokeLegacy();
  assert.equal(upgrade.server.isLegacyActive(), false);
  await upgrade.server.cleanup();
  const restarted = await fixture(t, { dir: upgrade.dir });
  assert.equal(restarted.server.isLegacyActive(), false);
});

test("legacy clients never rotate on connect, heartbeat, promotion or restart", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = await fixture(t);
  const old = f.connect({ token: LEGACY });
  const invalidCid = f.connect({ token: LEGACY, proto: "2", cid: "bad" });
  const missingCid = f.connect({ token: LEGACY, proto: "2" });
  const migrated = f.legacy();
  const b = migrated.rotation();
  assert.equal(b.gen, 1);
  assert.equal(b.expiresAt, undefined);
  const deviceOld = f.device(b.newToken, "");
  const deviceNew = f.device(b.newToken);
  f.time(1002000); t.mock.timers.tick(100);
  const c = deviceNew.rotation();
  assert.equal(c.gen, 2);
  assert.equal(deviceOld.rotation(), undefined);
  checkSnapshot(f.device(c.newToken));
  assert.equal(deviceNew.code, 4002);
  for (const client of [old, invalidCid, missingCid, deviceOld]) {
    assert.equal(client.code, undefined); assert.equal(client.rotation(), undefined);
  }
  assert.equal(old.rotation(), undefined);
  await f.server.cleanup();
  const restarted = await fixture(t, { dir: f.dir });
  checkSnapshot(restarted.connect({ token: LEGACY }));
  const oldDevice = restarted.device(c.newToken, "");
  restarted.time(2000000); t.mock.timers.tick(500);
  assert.equal(oldDevice.code, undefined); assert.equal(oldDevice.rotation(), undefined);
});

test("same device connections coexist; promotion closes only proto2 connections on the old device token", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = await fixture(t);
  const migration = f.legacy();
  const a = migration.rotation();
  const x = f.device(a.newToken);
  const y = f.device(a.newToken);
  const oldJs = f.device(a.newToken, "");
  t.mock.timers.tick(600000);
  assert.equal(x.code, undefined); assert.equal(y.code, undefined);
  f.time(1002000); t.mock.timers.tick(100);
  const b = x.rotation();
  sameRotation(y.rotation(), b);
  t.mock.timers.tick(1000);
  assert.equal(x.messages.filter((m) => m.type === "token_rotate").length, 1);
  x.emit("message", JSON.stringify({ type: "token_rotate_ack" }));
  assert.equal(f.read().devices[0].currentGen, 1);
  f.time(2000000);
  const promoted = f.device(b.newToken);
  assert.equal(x.code, 4002); assert.equal(y.code, 4002);
  assert.equal(oldJs.code, undefined); assert.equal(migration.code, undefined);
  assert.equal(promoted.rotation(), undefined);
  assert.equal(f.read().devices[0].currentIssuedAt, 2000000);
  assert.equal(f.read().devices[0].currentGen, 2);
  assert.equal(f.device(a.newToken).code, 1008);
});

test("invalid token (including absent token with pending devices) is 1008", async (t) => {
  const f = await fixture(t); f.legacy().close(1000);
  for (const params of [{}, { token: "invalid" }]) {
    const socket = f.connect(params); assert.equal(socket.code, 1008); assert.equal(socket.reason, "invalid-token");
  }
});

test("missing token file creates an unheld, invalid legacy placeholder", async (t) => {
  const f = await fixture(t, { missingToken: true });
  assert.equal(f.device(JSON.parse(fs.readFileSync(f.tokenPath, "utf8")).token).code, 1008);
  assert.equal(f.read().legacy.deadTokenHash, hash(JSON.parse(fs.readFileSync(f.tokenPath, "utf8")).token));
});

test("staged creation and promotion fail without changing credentials or disconnecting current clients", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = await fixture(t);
  const a = f.legacy().rotation();
  const x = f.device(a.newToken);
  f.time(1002000); f.failDevices(true); t.mock.timers.tick(100);
  assert.equal(x.rotation(), undefined); checkSnapshot(x);
  assert.equal(f.read().devices[0].staged, null);
  f.failDevices(false); t.mock.timers.tick(100);
  const b = x.rotation();
  f.failDevices(true);
  assert.equal(f.device(b.newToken).code, 4003);
  assert.equal(x.code, undefined);
  assert.equal(f.read().devices[0].currentHash, hash(a.newToken));
  f.failDevices(false);
  checkSnapshot(f.device(b.newToken));
  assert.equal(x.code, 4002);
});

test("migration retries the same pending token, then sends nothing for an active cid", async (t) => {
  const f = await fixture(t);
  const a = f.legacy().rotation();
  sameRotation(f.legacy().rotation(), a);
  checkSnapshot(f.device(a.newToken));
  const active = f.legacy(); checkSnapshot(active); assert.equal(active.rotation(), undefined);
  assert.equal(f.read().devices.length, 1);
});

test("migration on full device table or write failure keeps its snapshots and socket", async (t) => {
  const f = await fixture(t);
  f.failDevices(true);
  const failure = f.legacy(); checkSnapshot(failure); assert.equal(failure.rotation(), undefined);
  assert.equal(f.read().devices.length, 0); failure.close(1000);
  f.failDevices(false); fillDevices(f);
  const full = f.legacy(21); checkSnapshot(full); assert.equal(full.rotation(), undefined);
});

test("pair requires proto2 and a valid cid", async (t) => {
  const f = await fixture(t);
  for (const extra of [{}, { proto: "2" }, { cid: cid() }, { proto: "2", cid: "bad" }]) {
    assert.equal(f.connect({ pair: f.server.getConnectionInfo().pairCode, ...extra }).code, 4004);
  }
});

test("pair claims are atomic and repeatable across expiry, display refresh and desktop restart", async (t) => {
  const f = await fixture(t);
  const info = f.server.getConnectionInfo();
  f.failDevices(true);
  assert.equal(f.pair(info.pairCode).code, 4003);
  assert.equal(f.read().devices.length, 0);
  assert.equal(f.server.getConnectionInfo().pairCode, info.pairCode);
  f.failDevices(false);
  const first = f.pair(info.pairCode);
  const a = first.rotation();
  assert.deepEqual(first.messages.map((m) => m.type), ["token_rotate"]);
  assert.notEqual(f.server.getConnectionInfo().pairCode, info.pairCode);
  assert.equal(f.pair(info.pairCode, 2).code, 4004);
  f.time(2000000);
  f.server.refreshPairCode();
  const retry = f.pair(info.pairCode); sameRotation(retry.rotation(), a);
  const display = f.server.getConnectionInfo();
  assert.deepEqual(f.server.getConnectionInfo(), display);
  await f.server.cleanup();
  const restarted = await fixture(t, { dir: f.dir, time: 2000000 });
  assert.equal(restarted.server.getConnectionInfo().pairCode, display.pairCode);
  const resend = restarted.pair(info.pairCode);
  assert.deepEqual(resend.rotation(), { ...a, timestamp: resend.rotation().timestamp });
  checkSnapshot(restarted.device(a.newToken));
  assert.equal(restarted.pair(info.pairCode).code, 4004);
});

test("pending devices never expire and same cid active pairing creates another device", async (t) => {
  const f = await fixture(t);
  const a = f.pair().rotation(); f.device(a.newToken).close(1000);
  f.pair().close(1000);
  f.time(1000000000000);
  assert.equal(f.read().devices.length, 2);
  await f.server.cleanup();
  const again = await fixture(t, { dir: f.dir, time: 1000000000000 });
  assert.equal(again.read().devices.length, 2);
});

test("pair capacity, no snapshots or broadcasts, timeout frees its separate four slots", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let emit;
  const f = await fixture(t, { permissionObservation: { subscribe(listener) { emit = listener; return () => {}; }, snapshot: () => ({}) } });
  const code = f.server.getConnectionInfo().pairCode;
  const pending = Array.from({ length: 4 }, () => f.pair(code));
  assert.equal(f.pair(code).code, 4003);
  emit({ type: "replace", feature: { supported: true, enabled: true }, records: [{ secret: "hidden" }] });
  for (const socket of pending) assert.deepEqual(socket.messages.map((m) => m.type), ["token_rotate"]);
  t.mock.timers.tick(60000);
  for (const socket of pending) assert.equal(socket.code, 1000);
  assert.ok(f.pair(code).rotation());
});

test("full table reclaims its bound pair before checking capacity; new code is not consumed", async (t) => {
  const f = await fixture(t);
  const code = f.server.getConnectionInfo().pairCode;
  const a = f.pair(code).rotation();
  for (let n = 2; n <= 20; n++) f.legacy(n).close(1000);
  sameRotation(f.pair(code).rotation(), a);
  const display = f.server.getConnectionInfo().pairCode;
  assert.equal(f.pair(display, 21).code, 4005);
  assert.equal(f.server.getConnectionInfo().pairCode, display);
});

test("pair limits failures by IP before checking the 21st code; expiry rejects without consuming", async (t) => {
  const f = await fixture(t);
  const code = f.server.getConnectionInfo().pairCode;
  f.time(2000000);
  assert.equal(f.pair(code).code, 4004);
  const fresh = f.server.getConnectionInfo().pairCode;
  for (let n = 1; n < 20; n++) assert.equal(f.pair("INVALID!").code, 4004);
  assert.equal(f.pair(fresh).code, 4003);
  assert.ok(f.connect({ pair: fresh, proto: "2", cid: cid() }, "192.0.2.1").rotation());
  f.time(3000000);
  assert.ok(f.pair().rotation());
});

test("ten ponging data connections retain capacity; pairing is separate and one close frees a slot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = await fixture(t);
  const sockets = Array.from({ length: 10 }, () => f.connect({ token: LEGACY }));
  for (let n = 0; n < 3; n++) {
    t.mock.timers.tick(1000);
    assert.equal(f.connect({ token: LEGACY }).code, 1013);
  }
  assert.ok(sockets.every((s) => s.pongs > 0 && s.code === undefined));
  assert.ok(f.pair().rotation());
  sockets[0].close(1000);
  checkSnapshot(f.connect({ token: LEGACY }));
});

test("the WebSocket server caps client messages at 4096 bytes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.socketServerOptions.maxPayload, 4096);
  assert.equal(f.socketServerOptions.path, "/ws");
});

// A rejected connection never gets the per-client listeners, yet ws can still
// emit "error" on it when a late frame is invalid or over maxPayload.
for (const [name, reject] of [
  ["an invalid token", (f) => f.connect({ token: "invalid" })],
  ["a rejected pairing", (f) => f.connect({ pair: f.server.getConnectionInfo().pairCode })],
  ["a full server", (f) => {
    for (let n = 0; n < 10; n++) f.connect({ token: LEGACY });
    return f.connect({ token: LEGACY });
  }],
  ["a closed server", async (f) => {
    await f.server.cleanup();
    return f.connect({ token: LEGACY });
  }],
]) {
  test(`a connection rejected for ${name} survives a late socket error`, async (t) => {
    const f = await fixture(t);
    const socket = await reject(f);
    assert.notEqual(socket.code, undefined);
    assert.doesNotThrow(() => socket.emit("error", new RangeError("Max payload size exceeded")));
  });
}

// A masked client frame, as a browser writes it.
function clientFrame(opcode, payload) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const size = payload.length < 126 ? [0x80 | payload.length] : [0x80 | 126, payload.length >> 8, payload.length & 0xff];
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([Buffer.from([0x80 | opcode, ...size, ...mask]), masked]);
}

// Replaces the test runner's uncaughtException handlers until the test ends, so
// an escaped error is an assertion here instead of a runner-level failure.
function collectUncaught(t) {
  const uncaught = [];
  const runnerHandlers = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (error) => uncaught.push(error));
  t.after(() => {
    process.removeAllListeners("uncaughtException");
    for (const handler of runnerHandlers) process.on("uncaughtException", handler);
  });
  return uncaught;
}

for (const [name, frame] of [
  ["a reserved opcode", clientFrame(3, Buffer.from("x"))],
  ["a frame over maxPayload", clientFrame(2, Buffer.alloc(5000))],
]) {
  test(`a real ws connection rejected for its token survives ${name} while it closes`, async (t) => {
    const f = await fixture(t);
    const uncaught = collectUncaught(t);
    // Server-side ws over an in-memory duplex: no port and no HTTP upgrade.
    const wire = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const ws = new WebSocket(null, undefined, {});
    ws.setSocket(wire, Buffer.alloc(0), {
      allowSynchronousEvents: true,
      maxBufferedChunks: 1024 * 1024,
      maxFragments: 128 * 1024,
      maxPayload: f.socketServerOptions.maxPayload,
      skipUTF8Validation: false,
    });
    t.after(() => wire.destroy());

    f.connect({ token: "invalid" }, "127.0.0.1", ws);
    assert.equal(ws.readyState, WebSocket.CLOSING);
    wire.push(frame);
    for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(uncaught.map(String), []);
    // ws handled the bad frame (it ended its side of the connection).
    assert.equal(wire.writableEnded, true);
  });
}

test("messages over 60 per window close 4003; ACK does not promote or revoke", async (t) => {
  const f = await fixture(t); const x = f.legacy();
  for (let n = 0; n < 60; n++) x.emit("message", JSON.stringify({ type: "token_rotate_ack" }));
  assert.equal(x.code, undefined); assert.equal(f.read().devices[0].state, "pending");
  x.emit("message", "{}"); assert.equal(x.code, 4003); assert.equal(x.reason, "rate-limit");
});

test("revokeDevice persists before closing device and bound pairing connections", async (t) => {
  const f = await fixture(t);
  const legacy = f.legacy(); const a = legacy.rotation();
  const x = f.device(a.newToken);
  f.failDevices(true);
  assert.throws(() => f.server.revokeDevice(a.deviceId), (e) => e.legacyRevoked === false);
  assert.equal(x.code, undefined); assert.equal(f.read().devices.length, 1);
  f.failDevices(false);
  assert.deepEqual(f.server.revokeDevice(a.deviceId), { mayHoldLegacy: true });
  assert.equal(x.code, 1008); assert.equal(legacy.code, undefined);
  assert.equal(f.device(a.newToken).code, 1008);
  const code = f.server.getConnectionInfo().pairCode;
  const pending = f.pair(code); const b = pending.rotation();
  assert.deepEqual(f.server.revokeDevice(b.deviceId), { mayHoldLegacy: false });
  assert.equal(pending.code, 1008);
  await f.server.cleanup();
  const again = await fixture(t, { dir: f.dir });
  assert.equal(again.device(a.newToken).code, 1008);
  checkSnapshot(again.connect({ token: LEGACY }));
});

for (const reset of [false, true]) {
  for (const failure of ["token", "devices", "none"]) {
    test(`${reset ? "reset" : "revokeLegacy"}: ${failure} write failure, live connections and reconstructed state`, async (t) => {
      const f = await fixture(t);
      const migrating = f.legacy(); const a = migrating.rotation(); const x = f.device(a.newToken);
      const pending = f.pair(); const b = pending.rotation();
      f.failToken(failure === "token"); f.failDevices(failure === "devices");
      const run = () => reset ? f.server.resetMobileAccess() : f.server.revokeLegacy();
      if (failure !== "none") assert.throws(run, (err) => err.legacyRevoked === (failure === "devices")); else run();
      assert.equal(migrating.code, failure === "token" ? undefined : 1008);
      assert.equal(x.code, reset && failure === "none" ? 1008 : undefined);
      assert.equal(pending.code, reset && failure === "none" ? 1008 : undefined);
      if (failure !== "token") assert.equal(f.device(JSON.parse(fs.readFileSync(f.tokenPath, "utf8")).token).code, 1008);
      assert.equal(f.device(LEGACY).code, failure === "token" ? undefined : 1008);
      await f.server.cleanup();
      const again = await fixture(t, { dir: f.dir });
      assert.equal(again.device(LEGACY).code, failure === "token" ? undefined : 1008);
      assert.equal(again.device(a.newToken).code, reset && failure === "none" ? 1008 : undefined);
      assert.equal(again.device(b.newToken).code, reset && failure === "none" ? 1008 : undefined);
    });
  }
}

test("grace is persisted indefinitely, retries after failure, and survives partial reset followed by downgrade", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let fail = true;
  const f = await fixture(t, { previous: PREVIOUS, graceUntil: 1001000, ctx: {
    writeDeviceState(file, state) { if (fail) return false; return atomicWrite(file, state); },
  } });
  checkSnapshot(f.device(PREVIOUS, ""));
  fail = false; t.mock.timers.tick(60000);
  assert.deepEqual(f.read().legacy.graceHashes, [hash(PREVIOUS)]);
  await f.server.cleanup();
  const afterGrace = await fixture(t, { dir: f.dir, time: 2000000 });
  checkSnapshot(afterGrace.device(PREVIOUS, ""));
  const a = afterGrace.legacy().rotation(); afterGrace.device(a.newToken);
  afterGrace.failDevices(true);
  assert.throws(() => afterGrace.server.resetMobileAccess(), (e) => e.legacyRevoked);
  await afterGrace.server.cleanup();
  const partial = await fixture(t, { dir: f.dir, time: 2000000 });
  assert.equal(partial.device(LEGACY).code, 1008); assert.equal(partial.device(PREVIOUS).code, 1008);
  checkSnapshot(partial.device(a.newToken));
  await partial.server.cleanup();
  atomicWrite(f.tokenPath, { token: "c".repeat(32), previous: "d".repeat(32), graceUntil: 4000000 });
  const upgraded = await fixture(t, { dir: f.dir, time: 3000000 });
  checkSnapshot(upgraded.device("c".repeat(32), "")); checkSnapshot(upgraded.device("d".repeat(32), ""));
  assert.equal(upgraded.device(LEGACY).code, 1008);
});

test("grace never persisted before restart expires at its original deadline", async (t) => {
  const f = await fixture(t, { previous: PREVIOUS, graceUntil: 1001000, failDevices: true });
  checkSnapshot(f.device(PREVIOUS, "")); await f.server.cleanup();
  const again = await fixture(t, { dir: f.dir, time: 2000000 });
  assert.equal(again.device(PREVIOUS).code, 1008); checkSnapshot(again.device(LEGACY, ""));
});

test("corrupt and unknown-version files are preserved byte for byte without authorizing devices", async (t) => {
  for (const bytes of ["{broken", '{"version":99}']) {
    const f = await fixture(t);
    const a = f.legacy().rotation(); await f.server.cleanup();
    fs.writeFileSync(f.devicesPath, bytes);
    const again = await fixture(t, { dir: f.dir });
    assert.equal(fs.readFileSync(f.devicesPath + ".corrupt-1000000", "utf8"), bytes);
    assert.deepEqual(again.read().devices, []);
    assert.equal(again.device(a.newToken).code, 1008); checkSnapshot(again.device(LEGACY, ""));
    await again.server.cleanup();
  }
});

test("failed corrupt-file rename preserves original, pauses device writes, keeps legacy data", async (t) => {
  const f = await fixture(t); await f.server.cleanup();
  fs.writeFileSync(f.devicesPath, "broken");
  const io = Object.create(fs);
  io.renameSync = (from, to) => { if (from === f.devicesPath) throw new Error("denied"); fs.renameSync(from, to); };
  const again = await fixture(t, { dir: f.dir, ctx: { fs: io } });
  const legacy = again.legacy(); checkSnapshot(legacy); assert.equal(legacy.rotation(), undefined);
  assert.equal(again.pair().code, 4003);
  assert.equal(fs.readFileSync(f.devicesPath, "utf8"), "broken");
});

test("private atomic files fsync before rename; failed write removes unique temp files", async (t) => {
  const f = await fixture(t);
  if (process.platform !== "win32") {
    fs.chmodSync(f.tokenPath, 0o644);
    await f.server.cleanup(); const again = await fixture(t, { dir: f.dir });
    assert.equal(fs.statSync(f.tokenPath).mode & 0o777, 0o600);
    again.server.resetMobileAccess();
    for (const file of [f.tokenPath, f.devicesPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const calls = [];
  const io = Object.create(fs);
  io.openSync = (file, flags, mode) => { calls.push(["open", file, mode]); return fs.openSync(file, flags, mode); };
  io.fsyncSync = (fd) => { calls.push(["fsync"]); fs.fsyncSync(fd); };
  io.renameSync = (from, to) => { calls.push(["rename"]); fs.renameSync(from, to); };
  const file = path.join(f.dir, "atomic.json");
  atomicWrite(file, {}, io); atomicWrite(file, {}, io);
  assert.deepEqual(calls.map((c) => c[0]), ["open", "fsync", "rename", "open", "fsync", "rename"]);
  assert.notEqual(calls[0][1], calls[3][1]); assert.equal(calls[0][2], 0o600);
  io.renameSync = () => { throw new Error("denied"); };
  assert.throws(() => atomicWrite(file, { changed: true }, io), /denied/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
  assert.equal(fs.readdirSync(f.dir).some((entry) => entry.endsWith(".tmp")), false);
});

test("connection info is private to desktop; logs omit credentials, staged, pairing code and cid", async (t) => {
  const f = await fixture(t); const info = f.server.getConnectionInfo(); const x = f.pair();
  x.close(1000); f.device(x.rotation().newToken);
  f.legacy().emit("message", JSON.stringify({ type: "token_rotate_ack" }));
  assert.deepEqual(Object.keys(f.publicInfo()).sort(), ["lanIp", "port", "status"]);
  assert.equal(info.token, undefined); assert.ok(info.pairUrl.includes("?pair="));
  for (const secret of [LEGACY, x.rotation().newToken, info.pairCode, cid()]) assert.equal(f.logs.join("\n").includes(secret), false);
});

test("migration prefers a pending pair for the cid even when an older device is active", async (t) => {
  const f = await fixture(t);
  const first = f.pair().rotation(); f.device(first.newToken).close(1000);
  const pending = f.pair().rotation();
  sameRotation(f.legacy().rotation(), pending);
  assert.equal(f.read().devices.length, 2);
});

test("staged device token is replayed unchanged on reconnect and restart; revocation removes A and B", async (t) => {
  const f = await fixture(t);
  const a = f.legacy().rotation(); f.device(a.newToken).close(1000);
  f.time(1002000); const b = f.device(a.newToken).rotation();
  sameRotation(f.device(a.newToken).rotation(), b);
  await f.server.cleanup();
  const again = await fixture(t, { dir: f.dir, time: 9000000 });
  sameRotation(again.device(a.newToken).rotation(), b);
  again.server.revokeDevice(a.deviceId);
  assert.equal(again.device(a.newToken).code, 1008); assert.equal(again.device(b.newToken).code, 1008);
});

test("lowercase/hyphenated pairing input normalizes without changing the bound token", async (t) => {
  const f = await fixture(t);
  const code = f.server.getConnectionInfo().pairCode.toLowerCase();
  const a = f.pair(code.slice(0, 4) + "-" + code.slice(4)).rotation();
  sameRotation(f.pair(code).rotation(), a);
});

test("lastSeen remains in memory and flushes at most once per ten minutes with another device write", async (t) => {
  const f = await fixture(t);
  const a = f.legacy().rotation(); f.device(a.newToken).close(1000);
  f.time(1001000); f.device(a.newToken).close(1000); f.server.refreshPairCode();
  assert.equal(f.read().devices[0].lastSeenAt, 1000000);
  f.time(1601000); f.device(a.newToken).close(1000); f.server.refreshPairCode();
  assert.equal(f.read().devices[0].lastSeenAt, 1601000);
  f.time(1602000); f.device(a.newToken).close(1000); f.server.refreshPairCode();
  assert.equal(f.read().devices[0].lastSeenAt, 1601000);
});

test("startup reads both files before repairing corruption or merging state", async (t) => {
  const f = await fixture(t); await f.server.cleanup(); fs.writeFileSync(f.devicesPath, "broken");
  const events = [], io = Object.create(fs);
  io.readFileSync = (file, ...args) => { events.push(["read", file]); return fs.readFileSync(file, ...args); };
  io.renameSync = (from, to) => { events.push(["rename", from]); fs.renameSync(from, to); };
  await fixture(t, { dir: f.dir, ctx: { fs: io } });
  assert.deepEqual(events.slice(0, 3), [["read", f.devicesPath], ["read", f.tokenPath], ["rename", f.devicesPath]]);
});

test("pair ACK is informational and pairing sockets use the same 4003 message limit", async (t) => {
  const f = await fixture(t); const pair = f.pair(); const before = f.read();
  for (let n = 0; n < 60; n++) pair.emit("message", JSON.stringify({ type: "token_rotate_ack" }));
  assert.equal(pair.code, undefined); assert.deepEqual(f.read(), before);
  assert.ok(f.logs.some((line) => line.includes("token_rotate_ack")));
  pair.emit("message", "{}"); assert.equal(pair.code, 4003); assert.equal(pair.reason, "rate-limit");
});


test("revoking a pending migration keeps its legacy-authenticated socket usable", async (t) => {
  const f = await fixture(t);
  const legacy = f.legacy();
  const pending = legacy.rotation();
  f.server.revokeDevice(pending.deviceId);
  assert.equal(legacy.code, undefined);
  assert.equal(legacy.readyState, 1);
  checkSnapshot(f.device(LEGACY, ""));
  assert.equal(f.device(pending.newToken).code, 1008);
  f.server.revokeLegacy();
  assert.equal(legacy.code, 1008);
  assert.equal(legacy.reason, "legacy-revoked");
});

test("index responses substitute the package version while other assets stay byte-identical", async (t) => {
  const f = await fixture(t);
  const version = require("../package.json").version;
  const template = fs.readFileSync(path.join(__dirname, "../pwa/index.html"), "utf8");
  assert.ok(template.includes("?v=__CLAWD_APP_VERSION__"));
  for (const route of ["/mobile/", "/mobile", "/mobile/index.html"]) {
    const result = await f.staticResponse(route);
    assert.equal(result.status, 200);
    assert.equal(result.body.includes("__CLAWD_APP_VERSION__"), false);
    for (const asset of ["app.js", "icons.js", "style.css"]) assert.ok(result.body.includes(`/mobile/${asset}?v=${version}`));
  }
  const js = await f.staticResponse("/mobile/app.js?v=ignored");
  assert.equal(js.body, fs.readFileSync(path.join(__dirname, "../pwa/app.js"), "utf8"));
});

test("mobile server and device store expose no plaintext-token getter", async (t) => {
  const f = await fixture(t);
  assert.equal("getToken" in f.server, false);
  const { createMobileDeviceStore } = require("../src/network/mobile-device-store");
  const store = createMobileDeviceStore({ tokenPath: f.tokenPath, now: () => 1000000, log() {} });
  assert.equal("getLegacyToken" in store, false);
});


for (const field of ["legacy", "pairing", "device", "duplicate"]) {
  test(`startup rejects invalid ${field} state while retaining legacy access`, async (t) => {
    const f = await fixture(t);
    const token = f.legacy().rotation().newToken;
    f.device(token).close(1000);
    await f.server.cleanup();
    const state = f.read();
    if (field === "legacy") state.legacy.graceHashes = ["invalid"];
    else if (field === "pairing") state.pairing.code = "IIIIIIII";
    else if (field === "device") state.devices[0].currentGen = 0;
    else state.devices.push({ ...state.devices[0] });
    fs.writeFileSync(f.devicesPath, JSON.stringify(state));
    const again = await fixture(t, { dir: f.dir });
    assert.deepEqual(again.read().devices, []);
    assert.equal(again.device(token).code, 1008);
    checkSnapshot(again.device(LEGACY, ""));
  });
}
