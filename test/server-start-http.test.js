"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");

// Fake HTTP server whose listen() emits 'listening' asynchronously (like the
// real net.Server) unless the requested port is in `occupied`, in which case it
// emits an async EADDRINUSE 'error'. This drives startHttpServer()'s
// port-candidate retry loop so we can assert the returned Promise resolves with
// the port that was ACTUALLY bound — the value remote-ssh connect-on-launch
// reads (via getHookServerPort) to build its SSH reverse tunnel.
function makeFakeServerFactory({ occupied = [] } = {}) {
  const listenCalls = [];
  function createHttpServer() {
    const server = new EventEmitter();
    server.listening = false;
    server.listen = function listen(port) {
      listenCalls.push(port);
      if (occupied.includes(port)) {
        process.nextTick(() => {
          const err = new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
          err.code = "EADDRINUSE";
          server.emit("error", err);
        });
        return;
      }
      process.nextTick(() => {
        server.listening = true;
        server.emit("listening");
      });
    };
    server.close = function close() { server.listening = false; };
    server.address = function address() {
      return server.listening
        ? { address: "127.0.0.1", port: listenCalls[listenCalls.length - 1] }
        : null;
    };
    return server;
  }
  return { createHttpServer, listenCalls };
}

function makeApi({ occupied = [], candidates = [23333, 23334, 23335], runtimePort = null } = {}) {
  const { createHttpServer, listenCalls } = makeFakeServerFactory({ occupied });
  const api = initServer({
    createHttpServer,
    // Skip the post-listening integration sync — not under test, and it would
    // otherwise touch real agent config files.
    setImmediate: () => {},
    getPortCandidates: () => candidates.slice(),
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => runtimePort,
  });
  return { api, listenCalls };
}

test("startHttpServer resolves the bound port once the server is listening", async () => {
  const { api, listenCalls } = makeApi({ occupied: [] });
  const port = await api.startHttpServer();
  assert.strictEqual(port, 23333);
  assert.strictEqual(api.getHookServerPort(), 23333);
  assert.deepStrictEqual(listenCalls, [23333]);
});

test("startHttpServer resolves the actually-bound port when the first candidate is occupied", async () => {
  // The connect-on-launch port-drift hazard: a synchronous (pre-listening)
  // sweep would have read the stale fallback 23333, but the server actually
  // bound 23334. Awaiting startHttpServer() guarantees the port the sweep sees
  // is the real one, so the reverse tunnel targets the live local server.
  const { api, listenCalls } = makeApi({ occupied: [23333] });
  const port = await api.startHttpServer();
  assert.strictEqual(port, 23334);
  assert.strictEqual(api.getHookServerPort(), 23334);
  assert.deepStrictEqual(listenCalls, [23333, 23334]);
});

test("startHttpServer resolves null when every candidate port is occupied", async () => {
  const { api, listenCalls } = makeApi({ occupied: [23333, 23334, 23335] });
  const port = await api.startHttpServer();
  assert.strictEqual(port, null);
  assert.deepStrictEqual(listenCalls, [23333, 23334, 23335]);
});

test("startHttpServer resolves null when listen() throws synchronously", async () => {
  // Defends the "resolves, never rejects" contract: a synchronous throw from
  // listen() (bad args, certain Windows conditions) must resolve null — not
  // reject and surface as an unhandled rejection in a caller that forgot to
  // .catch() the returned Promise.
  function createHttpServer() {
    const server = new EventEmitter();
    server.listen = function listen() { throw new Error("EINVAL: invalid listen args"); };
    server.close = function close() {};
    server.address = function address() { return null; };
    return server;
  }
  const api = initServer({
    createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
  });
  const port = await api.startHttpServer();
  assert.strictEqual(port, null);
});
