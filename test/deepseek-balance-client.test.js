"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");
const { createDeepseekBalanceClient } = require("../src/deepseek-balance-client");

function mockRequest(route) {
  const calls = [];
  return {
    calls,
    request(endpoint, options, callback) {
      const req = new EventEmitter();
      calls.push({ endpoint, options, req });
      req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeout = fn; };
      req.destroy = () => { req.destroyed = true; };
      req.end = () => process.nextTick(() => {
        if (route.hang) return;
        if (route.error) return req.emit("error", new Error("sk-private-reflected"));
        const res = Readable.from([Buffer.from(route.body ?? "{}")]);
        res.statusCode = route.statusCode ?? 200;
        callback(res);
      });
      return req;
    },
  };
}

test("DeepSeek client uses the official fixed endpoint without redirects", async () => {
  const m = mockRequest({ body: '{"is_available":true,"balance_infos":[]}' });
  const client = createDeepseekBalanceClient({ request: m.request });
  assert.equal((await client.fetchBalance("sk-private")).kind, "success");
  assert.equal(m.calls[0].endpoint, "https://api.deepseek.com/user/balance");
  assert.equal(m.calls[0].options.method, "GET");
  assert.equal(m.calls[0].options.headers.Authorization, "Bearer sk-private");
  assert.equal(m.calls[0].options.headers.Accept, "application/json");
  const redirect = mockRequest({ statusCode: 302 });
  assert.equal((await createDeepseekBalanceClient({ request: redirect.request })
    .fetchBalance("key")).kind, "http-error");
  assert.equal(redirect.calls.length, 1);
});

for (const [statusCode, kind] of [[401, "credential-rejected"], [402, "payment-required"],
  [429, "rate-limited"], [500, "server-error"], [503, "server-error"]]) {
  test(`DeepSeek client classifies HTTP ${statusCode} without response secrets`, async () => {
    const m = mockRequest({ statusCode, body: "sk-private-reflected" });
    const result = await createDeepseekBalanceClient({ request: m.request }).fetchBalance("sk-private");
    assert.equal(result.kind, kind);
    assert.doesNotMatch(JSON.stringify(result), /sk-private/);
  });
}

test("DeepSeek client bounds time and response size and sanitizes network failures", async () => {
  const m = mockRequest({ hang: true });
  const pending = createDeepseekBalanceClient({ request: m.request }).fetchBalance("key");
  assert.equal(m.calls[0].req.timeoutMs, 8000);
  m.calls[0].req.timeout();
  assert.equal((await pending).kind, "timeout");
  const big = mockRequest({ body: "x".repeat(65537) });
  assert.equal((await createDeepseekBalanceClient({ request: big.request })
    .fetchBalance("key")).kind, "response-too-large");
  for (const route of [{ body: "not JSON" }, { body: "[]" }, { error: true }]) {
    const result = await createDeepseekBalanceClient({ request: mockRequest(route).request }).fetchBalance("key");
    assert.equal(result.kind, route.error ? "network-error" : "malformed-response");
    assert.doesNotMatch(JSON.stringify(result), /sk-private/);
  }
});

test("DeepSeek client aborts and rejects header injection before making a request", async () => {
  const m = mockRequest({ hang: true });
  const client = createDeepseekBalanceClient({ request: m.request });
  const controller = new AbortController();
  const pending = client.fetchBalance("key", { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).kind, "aborted");
  assert.equal(m.calls[0].req.destroyed, true);
  assert.equal((await client.fetchBalance("key\r\nheader")).kind, "invalid-credential-input");
  assert.equal(m.calls.length, 1);
});
