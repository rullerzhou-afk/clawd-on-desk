"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let clientPromise;
function client() {
  clientPromise ||= import(pathToFileURL(path.join(__dirname, "..", "hooks", "dsh-clawd-bridge", "lib", "clawd-client.js")).href);
  return clientPromise;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("DSH client accepts only a positively identified Clawd health endpoint", async (t) => {
  const { __test } = await client();
  const good = await listen((_req, res) => {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk", "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
  });
  const wrong = await listen((_req, res) => {
    res.writeHead(200, { "x-clawd-server": "other-app" });
    res.end(JSON.stringify({ ok: true, app: "clawd-on-desk" }));
  });
  t.after(async () => { await close(good); await close(wrong); });
  assert.strictEqual(await __test.probe(good.address().port), true);
  assert.strictEqual(await __test.probe(wrong.address().port), false);
});

test("DSH client bounds response bodies and supports request abort", async (t) => {
  const { __test } = await client();
  const server = await listen((_req, res) => {
    res.writeHead(200, { "x-clawd-server": "clawd-on-desk" });
    res.end("x".repeat(2048));
  });
  t.after(async () => { await close(server); });
  const oversized = await __test.request(server.address().port, "GET", "/state", undefined, {
    maxResponseBytes: 128,
    timeoutMs: 1000,
  });
  assert.strictEqual(oversized.ok, false);
  assert.strictEqual(oversized.reason, "response-too-large");

  const controller = new AbortController();
  controller.abort();
  const aborted = await __test.request(server.address().port, "GET", "/state", undefined, {
    signal: controller.signal,
  });
  assert.strictEqual(aborted.aborted, true);
  assert.strictEqual(aborted.reason, "aborted");
});

test("DSH permission parser recognizes only allow/deny and treats 204 as next()", async () => {
  const { parsePermissionResult } = await client();
  assert.deepStrictEqual(parsePermissionResult({ ok: true, statusCode: 200, body: '{"decision":"allow"}' }), {
    kind: "decision",
    decision: "allow",
  });
  assert.deepStrictEqual(parsePermissionResult({ ok: true, statusCode: 200, body: '{"decision":"deny"}' }), {
    kind: "decision",
    decision: "deny",
  });
  for (const result of [
    { ok: true, statusCode: 204, body: "" },
    { ok: true, statusCode: 200, body: '{"decision":"always"}' },
    { ok: true, statusCode: 200, body: "not-json" },
    { ok: false, reason: "wrong-server" },
  ]) {
    assert.deepStrictEqual(parsePermissionResult(result), { kind: "no-decision" });
  }
  assert.deepStrictEqual(parsePermissionResult({ ok: false, aborted: true }), { kind: "cancelled" });
});

test("DSH discovery contract is loopback-only and fixed to the Clawd port range", async () => {
  const { __test } = await client();
  assert.deepStrictEqual([...__test.ports], [23333, 23334, 23335, 23336, 23337]);
  assert.strictEqual(__test.validPort(23333), true);
  assert.strictEqual(__test.validPort(8080), false);
  assert.match(__test.runtimePath.replace(/\\/g, "/"), /\/\.clawd\/runtime\.json$/);
});

test("one caller aborting a shared discovery wait does not cancel another caller", async () => {
  const { __test } = await client();
  let settle;
  const shared = new Promise((resolve) => { settle = resolve; });
  const first = new AbortController();
  const second = new AbortController();
  const firstWait = __test.waitForDiscovery(shared, first.signal);
  const secondWait = __test.waitForDiscovery(shared, second.signal);
  first.abort();
  assert.strictEqual(await firstWait, null);
  settle(23335);
  assert.strictEqual(await secondWait, 23335);
});
