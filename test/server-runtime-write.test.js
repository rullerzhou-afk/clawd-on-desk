// test/server-runtime-write.test.js — #681 Slice A1, runtime write robustness.
//
// src/server.js calls writeRuntimeConfig inside the 'listening' handler, and
// settle() — the thing that resolves startHttpServer's promise with the bound
// port — is BELOW that call. writeRuntimeConfig's mkdirSync used to sit outside
// its own try, so an EACCES on ~/.clawd escaped as an exception, the handler
// unwound before settle(), and the promise never resolved. Every caller that
// awaits the bound port (remote-ssh connect-on-launch builds its reverse tunnel
// off it) waits forever, for a failure that should have been a warning.
//
// Two independent guards, so neither alone is load-bearing:
//   1. writeRuntimeConfig honors its boolean contract (test/server-config.test.js).
//   2. src/server.js does not trust that (here) — a throw is caught and reported.

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const { checkLocalServer } = require("../src/doctor-detectors/local-server");

function makeServer({
  writeRuntimeConfig = () => true,
  readRuntimePort = () => 23333,
  identity = { ok: true, reason: null, port: 23333, ownerPid: process.pid },
  addressPort = 23333,
} = {}) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));

  function createHttpServer() {
    const server = new EventEmitter();
    server.listening = true;
    server.listen = function () { this.emit("listening"); };
    server.close = function () {};
    server.address = function () { return { address: "127.0.0.1", port: addressPort }; };
    return server;
  }

  const api = initServer({
    createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [addressPort],
    clearRuntimeConfig: () => true,
    writeRuntimeConfig,
    readRuntimePort,
    readRuntimeIdentity: () => identity,
    isProcessAlive: () => true,
  });
  return { api, warnings, restore: () => { console.warn = origWarn; } };
}

describe("#681 — startHttpServer always settles, however the runtime write goes", () => {
  it("settles with the bound port on a successful write", async () => {
    const h = makeServer();
    try {
      assert.strictEqual(await h.api.startHttpServer(), 23333);
    } finally { h.restore(); }
  });

  it("settles with the bound port when writeRuntimeConfig returns false", async () => {
    const h = makeServer({ writeRuntimeConfig: () => false });
    try {
      assert.strictEqual(await h.api.startHttpServer(), 23333,
        "a failed runtime write must not deprive callers of the port they are awaiting");
    } finally { h.restore(); }
  });

  // The actual regression. Pre-#681 this awaited forever.
  it("settles with the bound port even when writeRuntimeConfig THROWS", async () => {
    const h = makeServer({
      writeRuntimeConfig: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
    });
    try {
      const port = await Promise.race([
        h.api.startHttpServer(),
        new Promise((r) => setTimeout(() => r("TIMED-OUT"), 2000)),
      ]);
      assert.strictEqual(port, 23333,
        "a throwing writeRuntimeConfig must not strand startHttpServer's promise — settle() is below it");
    } finally { h.restore(); }
  });

  it("a throw is reported, not swallowed silently", async () => {
    const h = makeServer({
      writeRuntimeConfig: () => { throw new Error("EACCES: permission denied"); },
    });
    try {
      await h.api.startHttpServer();
      const joined = h.warnings.join("\n");
      assert.match(joined, /EACCES: permission denied/, "the underlying cause must reach the log");
      assert.match(joined, /runtime file was not written/i);
      assert.match(joined, /process metadata will be omitted/i,
        "the log must say what the user actually loses, not just that a write failed");
    } finally { h.restore(); }
  });

  it("a false return warns exactly once, and explains the consequence", async () => {
    const h = makeServer({ writeRuntimeConfig: () => false });
    try {
      await h.api.startHttpServer();
      const hits = h.warnings.filter((w) => /runtime file was not written/i.test(w));
      assert.strictEqual(hits.length, 1, "one warning per start — not per event, not zero");
      assert.match(hits[0], /Doctor/, "point the user at where the repair lives");
    } finally { h.restore(); }
  });

  it("a successful write says nothing", async () => {
    const h = makeServer();
    try {
      await h.api.startHttpServer();
      assert.deepStrictEqual(h.warnings.filter((w) => /runtime file/i.test(w)), []);
    } finally { h.restore(); }
  });
});

describe("#681 — a server listening with an unwritten runtime file is a Doctor warning", () => {
  it("surfaces as the existing local-server warning with its existing Fix", async () => {
    // The runtime file never landed: the port reads back missing AND the
    // identity is unreadable. Doctor must show this — silently losing terminal
    // focus for every new session is the whole failure mode.
    const h = makeServer({
      writeRuntimeConfig: () => false,
      readRuntimePort: () => null,
      identity: { ok: false, reason: "runtime-missing", port: null, ownerPid: null },
    });
    try {
      await h.api.startHttpServer();
      const result = checkLocalServer(h.api);
      assert.strictEqual(result.status, "fail");
      assert.strictEqual(result.level, "warning", "the server IS serving — this is not critical");
      assert.deepStrictEqual(result.fixAction, { type: "local-server" }, "reuse the existing Fix, do not invent a new check");
      assert.strictEqual(result.runtime.runtimeFileExists, false);
      assert.strictEqual(result.runtime.runtimeIdentityValid, false);
    } finally { h.restore(); }
  });

  it("repairRuntimeStatus reports the failure instead of claiming success", async () => {
    const h = makeServer({ writeRuntimeConfig: () => false, readRuntimePort: () => null });
    try {
      await h.api.startHttpServer();
      assert.notStrictEqual(h.api.repairRuntimeStatus().status, "ok",
        "Fix must not report ok when the write it just attempted failed");
    } finally { h.restore(); }
  });
});
