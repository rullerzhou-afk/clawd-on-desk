const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const { checkLocalServer } = require("../src/doctor-detectors/local-server");

// #681: identity defaults to a valid file owned by this (alive) process, so the
// pre-existing port cases below keep testing the PORT branch. Injected rather
// than read — a Doctor test must not depend on the developer's real
// ~/.clawd/runtime.json, nor on whether their Clawd is running right now.
function makeServer({
  runtimePort = 23333,
  addressPort = 23333,
  listening = true,
  identity = { ok: true, reason: null, port: 23333, ownerPid: process.pid },
  isProcessAlive = () => true,
} = {}) {
  function createHttpServer() {
    const server = new EventEmitter();
    server.listening = listening;
    server.listen = function (_port, _host) { this.emit("listening"); };
    server.close = function () {};
    server.address = function () {
      return this.listening ? { address: "127.0.0.1", port: addressPort } : null;
    };
    return server;
  }

  const api = initServer({
    createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [addressPort],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => runtimePort,
    readRuntimeIdentity: () => identity,
    isProcessAlive,
  });
  return api;
}

describe("checkLocalServer", () => {
  it("passes when server and runtime file port match", () => {
    const api = makeServer();
    api.startHttpServer();

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.runtime.runtimeMatches, true);
  });

  it("warns when runtime port is missing or stale", () => {
    const api = makeServer({ runtimePort: 23334, addressPort: 23333 });
    api.startHttpServer();

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.level, "warning");
    assert.deepStrictEqual(result.fixAction, { type: "local-server" });
  });

  it("is critical before the server starts listening and surfaces a restart action", () => {
    const api = makeServer({ runtimePort: null });

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.level, "critical");
    // Critical fail can't be repaired by repairRuntimeStatus (httpServer is
    // already non-null but not listening), so surface a restart-clawd action
    // instead of a misleading Fix button.
    assert.deepStrictEqual(result.fixAction, { type: "restart-clawd" });
  });

  // ── #681: runtime IDENTITY, not just the port ─────────────────────────────
  // A listening server whose runtime file has no usable ownerPid (or names a
  // dead one) is invisible to hooks: they gate their process snapshot on it and
  // fail closed, so terminal focus silently stops working for new sessions.
  // Same warning branch, same Fix — this must not be a separate Doctor check.

  it("warns when the runtime file carries no ownerPid, even with a matching port", () => {
    const api = makeServer({
      identity: { ok: false, reason: "runtime-owner-invalid", port: 23333, ownerPid: null },
    });
    api.startHttpServer();

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.level, "warning");
    assert.deepStrictEqual(result.fixAction, { type: "local-server" });
    assert.strictEqual(result.runtime.runtimeIdentityValid, false);
    assert.strictEqual(result.runtime.runtimeOwnerAlive, false);
    assert.match(result.detail, /runtime owner is missing/);
    assert.match(result.detail, /omit process metadata/);
  });

  it("warns when the runtime file names a dead owner (crashed instance's leftover)", () => {
    const api = makeServer({
      identity: { ok: true, reason: null, port: 23333, ownerPid: 4242 },
      isProcessAlive: (pid) => pid !== 4242,
    });
    api.startHttpServer();

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.level, "warning");
    assert.strictEqual(result.runtime.runtimeOwnerPid, 4242);
    assert.strictEqual(result.runtime.runtimeOwnerAlive, false);
    assert.strictEqual(result.runtime.runtimeIdentityValid, true, "the FILE is well-formed; its owner is just gone");
    assert.match(result.detail, /4242 \(not running\)/);
  });

  it("passes when port matches AND the identity names a live owner", () => {
    const api = makeServer();
    api.startHttpServer();

    const result = checkLocalServer(api);
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.runtime.runtimeIdentityValid, true);
    assert.strictEqual(result.runtime.runtimeOwnerAlive, true);
    assert.strictEqual(result.runtime.runtimeOwnerPid, process.pid);
  });
});
