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
  readRuntimeIdentity = () => identity,
  isProcessAlive = () => true,
  addressPort = 23333,
  runtimeConfigPath = undefined,
  // Production's listen() emits 'listening' from a LATER tick. The synchronous
  // mock below is close enough for the boolean-contract tests, but not for the
  // throw ones: a sync emit still runs inside httpServer.listen()'s own
  // try/catch, which converts a stranded promise into settle(null). Only the
  // async form reproduces a throw with nothing above it.
  asyncListen = false,
} = {}) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));

  function createHttpServer() {
    const server = new EventEmitter();
    server.listening = true;
    server.listen = asyncListen
      ? function () { setImmediate(() => this.emit("listening")); }
      : function () { this.emit("listening"); };
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
    readRuntimeIdentity,
    isProcessAlive,
    runtimeConfigPath,
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

  // The regression itself. What catches it here is the port assertion, not the
  // timeout: under this file's synchronous listen() mock an unguarded throw is
  // still caught by httpServer.listen()'s try/catch, which settles null. The
  // 2s race is not decoration either — it is what would catch a settle() that
  // is never called at all. The async-listen block below covers the shape this
  // mock cannot reach.
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

// The same hazard one layer out, and the reason the guard above is not enough on
// its own. Guarding writeRuntimeConfig leaves everything BETWEEN it and settle()
// unguarded, and the warning branch it enables used to call getRuntimeStatus()
// purely to read a path — reaching three more ctx seams (readRuntimePort,
// readRuntimeIdentity, isProcessAlive) to build fields it then discarded. Two of
// those three are seams #681 itself introduced.
//
// Nothing here is reachable in today's production: src/main.js injects none of
// the three, and the real implementations catch internally. This pins the shape
// so that adding an injection later — which #681 just did twice — cannot arm it.
describe("#681 — the warning branch must not reach the runtime file to log its path", () => {
  const SEAMS = [
    ["readRuntimePort", { readRuntimePort: () => { throw new Error("EACCES: readRuntimePort"); } }],
    ["readRuntimeIdentity", { readRuntimeIdentity: () => { throw new Error("EACCES: readRuntimeIdentity"); } }],
    ["isProcessAlive", { isProcessAlive: () => { throw new Error("EPERM: isProcessAlive"); } }],
  ];

  // The control. Three "settles fine" results below mean nothing unless the same
  // async mock is known to settle at all.
  it("the async listen mock settles normally with no seam throwing", async () => {
    const h = makeServer({ asyncListen: true, writeRuntimeConfig: () => false });
    try {
      assert.strictEqual(await h.api.startHttpServer(), 23333);
    } finally { h.restore(); }
  });

  for (const [name, seam] of SEAMS) {
    it(`settles with the bound port when the write fails and ${name} throws`, async () => {
      const h = makeServer({ writeRuntimeConfig: () => false, asyncListen: true, ...seam });
      try {
        const port = await Promise.race([
          h.api.startHttpServer(),
          new Promise((r) => setTimeout(() => r("TIMED-OUT"), 2000)),
        ]);
        assert.strictEqual(port, 23333,
          `logging a failed runtime write must not depend on ${name}: it sits above settle(), `
          + "and in Electron main a throw from this handler has no uncaughtException handler to catch it");
      } finally { h.restore(); }
    });
  }

  it("still names the runtime path it could not write", async () => {
    // The path must survive the refactor: it is the one field the warning
    // actually wanted from getRuntimeStatus(), and it is a pure expression —
    // derivable without reading anything, which is the entire point.
    const h = makeServer({
      writeRuntimeConfig: () => false,
      asyncListen: true,
      runtimeConfigPath: "D:/fake-home/.clawd/runtime.json",
      readRuntimePort: () => { throw new Error("EACCES: readRuntimePort"); },
    });
    try {
      await h.api.startHttpServer();
      const hits = h.warnings.filter((w) => /runtime file was not written/i.test(w));
      assert.strictEqual(hits.length, 1);
      assert.match(hits[0], /D:\/fake-home\/\.clawd\/runtime\.json/,
        "the warning is useless without the path, so the cheap derivation must produce the same one");
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
