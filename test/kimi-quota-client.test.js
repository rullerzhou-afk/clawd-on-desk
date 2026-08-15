"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");

const {
  KIMI_USAGE_ENDPOINT,
  classifyHttpResponse,
  createKimiQuotaClient,
  parseRetryAfter,
} = require("../src/kimi-quota-client");

function createRequestMock(routes) {
  const calls = [];
  const request = (endpoint, options, callback) => {
    const req = new EventEmitter();
    const route = routes.shift() || {};
    calls.push({ endpoint, options, req });
    req.setTimeout = (timeoutMs, onTimeout) => {
      req.timeoutMs = timeoutMs;
      req.onTimeout = onTimeout;
    };
    req.destroy = (error) => {
      if (error) process.nextTick(() => req.emit("error", error));
    };
    req.end = () => process.nextTick(() => {
      if (route.hang) return;
      if (route.error) {
        req.emit("error", route.error);
        return;
      }
      const res = Readable.from([Buffer.from(route.body || "")]);
      res.statusCode = route.statusCode == null ? 200 : route.statusCode;
      res.headers = route.headers || {};
      callback(res);
    });
    return req;
  };
  return { calls, request };
}

describe("Kimi quota HTTPS client", () => {
  it("uses the fixed endpoint, GET, bearer auth, and truthful Clawd UA", async () => {
    const mock = createRequestMock([{ body: "{}" }]);
    const client = createKimiQuotaClient({ request: mock.request, appVersion: "0.15.0" });
    const result = await client.fetchUsage("test-secret");
    assert.strictEqual(result.kind, "success");
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].endpoint, KIMI_USAGE_ENDPOINT);
    assert.strictEqual(mock.calls[0].options.method, "GET");
    assert.strictEqual(mock.calls[0].options.headers.Authorization, "Bearer test-secret");
    assert.strictEqual(mock.calls[0].options.headers.Accept, "application/json");
    assert.strictEqual(mock.calls[0].options.headers["User-Agent"], "Clawd/0.15.0 KimiQuota/experimental");
    assert.strictEqual(mock.calls[0].options.agent, false);
  });

  it("does not follow redirects", async () => {
    const mock = createRequestMock([{
      statusCode: 302,
      headers: { location: "https://evil.invalid/collect" },
      body: JSON.stringify({ secret: "reflected" }),
    }]);
    const result = await createKimiQuotaClient({ request: mock.request }).fetchUsage("test-secret");
    assert.deepStrictEqual(result, { kind: "http-error", statusCode: 302, retryAfter: null });
    assert.strictEqual(mock.calls.length, 1);
  });

  it("enforces the body cap and timeout", async () => {
    const oversized = createRequestMock([{ body: "x".repeat(100) }]);
    const oversizedResult = await createKimiQuotaClient({
      request: oversized.request,
      maxBodyBytes: 10,
    }).fetchUsage("test-secret");
    assert.deepStrictEqual(oversizedResult, { kind: "response-too-large", statusCode: 200 });

    const hanging = createRequestMock([{ hang: true }]);
    const pending = createKimiQuotaClient({ request: hanging.request }).fetchUsage("test-secret");
    assert.strictEqual(hanging.calls[0].req.timeoutMs, 8_000);
    hanging.calls[0].req.onTimeout();
    assert.deepStrictEqual(await pending, { kind: "timeout" });
  });

  it("aborts without returning credential or response data", async () => {
    const mock = createRequestMock([{ hang: true }]);
    const controller = new AbortController();
    const pending = createKimiQuotaClient({ request: mock.request }).fetchUsage(
      "test-secret",
      { signal: controller.signal },
    );
    controller.abort();
    assert.deepStrictEqual(await pending, { kind: "aborted" });
  });

  it("classifies documented HTTP statuses without raw messages", () => {
    const nowMs = Date.parse("2026-08-14T12:00:00Z");
    const body = Buffer.from(JSON.stringify({
      error: { code: "access_terminated", message: "sk-do-not-leak" },
    }));
    assert.deepStrictEqual(classifyHttpResponse(400, {}, body, nowMs), {
      kind: "incompatible-response", statusCode: 400, terminal: true,
    });
    assert.deepStrictEqual(classifyHttpResponse(401, {}, body, nowMs), {
      kind: "usage-credential-rejected", statusCode: 401, terminal: true,
    });
    assert.deepStrictEqual(classifyHttpResponse(402, {}, body, nowMs), {
      kind: "membership-unavailable", statusCode: 402, retryAfter: null,
    });
    assert.deepStrictEqual(classifyHttpResponse(403, {}, body, nowMs), {
      kind: "access-terminated", statusCode: 403, terminal: true,
    });
    assert.deepStrictEqual(classifyHttpResponse(404, {}, body, nowMs), {
      kind: "unsupported-or-moved", statusCode: 404, terminal: true,
    });
    assert.deepStrictEqual(classifyHttpResponse(429, {}, body, nowMs), {
      kind: "rate-limited", statusCode: 429, retryAfter: null,
    });
    assert.ok(!JSON.stringify(classifyHttpResponse(403, {}, body, nowMs)).includes("sk-do-not-leak"));
  });

  it("treats generic 403 as ambiguous and never synthesizes exhausted quota", () => {
    const result = classifyHttpResponse(
      403,
      {},
      Buffer.from(JSON.stringify({ error: { code: "quota_exhausted" } })),
      0,
    );
    assert.deepStrictEqual(result, {
      kind: "forbidden", statusCode: 403, retryAfter: null,
    });
    assert.strictEqual(result.usedPercent, undefined);
  });

  it("parses Retry-After delta seconds and HTTP dates", () => {
    const nowMs = Date.parse("2026-08-14T12:00:00Z");
    assert.deepStrictEqual(parseRetryAfter("120", nowMs), {
      kind: "delta-seconds", retryAt: nowMs + 120_000,
    });
    assert.deepStrictEqual(parseRetryAfter("Fri, 14 Aug 2026 12:05:00 GMT", nowMs), {
      kind: "http-date", retryAt: nowMs + 300_000,
    });
    assert.strictEqual(parseRetryAfter("secret-value", nowMs), null);
  });

  it("rejects malformed 2xx roots and sanitizes network errors", async () => {
    for (const body of ["not-json", "[]", "null"]) {
      const mock = createRequestMock([{ body }]);
      const result = await createKimiQuotaClient({ request: mock.request }).fetchUsage("test-secret");
      assert.deepStrictEqual(result, { kind: "malformed-response", statusCode: 200 });
    }

    const secret = "sk-network-secret";
    const mock = createRequestMock([{ error: Object.assign(new Error(secret), { code: "PRIVATE_ERROR" }) }]);
    const result = await createKimiQuotaClient({ request: mock.request }).fetchUsage(secret);
    assert.deepStrictEqual(result, { kind: "network-error", code: "NETWORK_ERROR" });
    assert.ok(!JSON.stringify(result).includes(secret));
  });

  it("rejects invalid credential input before opening a request", async () => {
    const mock = createRequestMock([]);
    const client = createKimiQuotaClient({ request: mock.request });
    assert.deepStrictEqual(await client.fetchUsage(""), {
      kind: "invalid-credential-input", terminal: true,
    });
    assert.deepStrictEqual(await client.fetchUsage("bad\nkey"), {
      kind: "invalid-credential-input", terminal: true,
    });
    assert.deepStrictEqual(await client.fetchUsage(" padded-key "), {
      kind: "invalid-credential-input", terminal: true,
    });
    assert.deepStrictEqual(await client.fetchUsage("x".repeat(2049)), {
      kind: "invalid-credential-input", terminal: true,
    });
    assert.strictEqual(mock.calls.length, 0);
  });

  it("sanitizes an unsafe app version before constructing User-Agent", () => {
    const client = createKimiQuotaClient({ appVersion: "1.0\r\nInjected: yes" });
    assert.strictEqual(client.userAgent, "Clawd/unknown KimiQuota/experimental");
  });
});
