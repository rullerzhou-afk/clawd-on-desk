"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const initServer = require("../src/server");
const config = require("../hooks/server-config");
const { checkLocalServer } = require("../src/doctor-detectors/local-server");

function setup({ errors = {}, throws = [], candidates = config.SERVER_PORTS, hint = null,
  publish = true, runtime = 45001 } = {}) {
  const calls = [], writes = [], hints = [], syncs = [];
  const server = new EventEmitter();
  let port = null;
  server.listen = (candidate) => {
    calls.push(candidate);
    const error = errors[candidate];
    if (error && throws.includes(candidate)) throw Object.assign(new Error(error), { code: error });
    process.nextTick(() => {
      if (error) return server.emit("error", Object.assign(new Error(error), { code: error }));
      port = candidate || 45000;
      server.listening = true;
      server.emit("listening");
    });
  };
  server.address = () => server.listening ? { port } : null;
  server.close = () => { server.listening = false; };
  const api = initServer({
    createHttpServer: () => server, getPortCandidates: () => candidates,
    setImmediate: (fn) => syncs.push(fn), readRuntimePort: () => runtime,
    readRuntimeIdentity: () => ({ ok: true, port: runtime, ownerPid: process.pid }),
    clearRuntimeConfig: () => true, isProcessAlive: () => true,
    writeRuntimeConfig: (p) => { writes.push(p); runtime = publish ? p : runtime; return publish; },
    readLocalServerPortHint: () => hint,
    writeLocalServerPortHint: (p) => { hints.push(p); return true; },
  });
  return { api, server, calls, writes, hints, syncs };
}

for (const code of ["EACCES", "EADDRINUSE"]) {
  test(`${code}: all legacy ports unavailable uses the actual system port`, async (t) => {
    const h = setup({ errors: Object.fromEntries(config.SERVER_PORTS.map(p => [p, code])) });
    assert.equal(await h.api.startHttpServer(), 45000);
    assert.deepEqual(h.calls, [...config.SERVER_PORTS, 0]);
    assert.deepEqual(h.writes, [45000]);
    assert.deepEqual(h.hints, [45000]);
    assert.equal(h.api.getHookServerPort(), 45000);
    assert.equal(checkLocalServer(h.api).status, "pass");
    const log = t.mock.method(console, "error", () => {});
    const lateError = Object.assign(new Error(code), { code });
    h.server.emit("error", lateError);
    assert.equal(h.calls.length, 6, "late errors cannot restart binding");
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [["HTTP server error:", lateError]]);
  });
}

test("synchronous failures on initial and subsequent ports use the same retry path", async () => {
  const h = setup({ errors: {23333:"EACCES",23334:"EADDRINUSE"}, throws:[23333,23334] });
  assert.equal(await h.api.startHttpServer(), 23335);
});

test("persistent hint survives runtime cleanup and falls back if occupied", async () => {
  const errors = Object.fromEntries(config.SERVER_PORTS.map(p => [p, "EACCES"]));
  const first = setup({ errors, hint:45002, runtime:null });
  assert.equal(await first.api.startHttpServer(), 45002);
  first.api.cleanup();
  assert.equal(first.api.getHookServerPort(), 23333);
  const next = setup({ errors:{...errors,45002:"EADDRINUSE"}, hint:first.hints[0], runtime:null });
  assert.equal(await next.api.startHttpServer(), 45000);
  assert.deepEqual(next.calls, [...config.SERVER_PORTS,45002,0]);
});

test("unpublished dynamic listener closes without syncing or exposing stale runtime", async () => {
  const h = setup({ candidates:[0], publish:false });
  assert.equal(h.api.getHookServerPort(), 23333);
  assert.equal(await h.api.startHttpServer(), null);
  assert.equal(h.server.listening, false);
  assert.deepEqual(h.hints, []);
  assert.deepEqual(h.syncs, []);
  assert.equal(h.api.getHookServerPort(), 23333);
  assert.equal(checkLocalServer(h.api).runtime.startupFailure.stage, "runtime");
});

test("terminal bind failure records bounded diagnostics and does not sync", async () => {
  const h = setup({ candidates:[23333], errors:{23333:"EACCES",0:"EACCES"} });
  assert.equal(await h.api.startHttpServer(), null);
  const result = checkLocalServer(h.api);
  assert.match(result.detail, /EACCES/);
  assert.match(result.textHint, /reserved|reservation/i);
  assert.deepEqual(h.syncs, []);
});

test("dynamic URLs are owned only with the exact local marker; remote remains fixed", () => {
  const url = "http://127.0.0.1:45000/permission/clawd-on-desk";
  assert.equal(config.buildPermissionUrl(45000), url);
  assert.equal(config.isManagedPermissionUrl(url), true);
  for (const foreign of [url+"/",url+"?x=1",url+"#x",url+"\n",url+"\r",url.replace("/clawd", "/./clawd"),
    url.replace("/clawd", "//clawd"), "http://127.0.0.1:45000/permission"]) {
    assert.equal(config.isManagedPermissionUrl(foreign), false, foreign);
  }
  assert.equal(config.buildPermissionUrl(45000, "a".repeat(32)),
    "http://127.0.0.1:23333/permission/"+"a".repeat(32));
});
