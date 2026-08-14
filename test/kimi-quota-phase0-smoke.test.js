const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");

const {
  ENDPOINT,
  USER_AGENT,
  parseArgs,
  requestUsage,
  runSmoke,
  sanitizeSuccessBody,
} = require("../scripts/manual/kimi-quota-phase0-smoke");

function createFakeRequest({
  statusCode = 200,
  headers = {},
  body = "{}",
  error = null,
  hang = false,
} = {}) {
  const calls = [];
  const request = (endpoint, options, callback) => {
    const req = new EventEmitter();
    calls.push({ endpoint, options, req });
    req.setTimeout = (timeoutMs, onTimeout) => {
      req.timeoutMs = timeoutMs;
      req.onTimeout = onTimeout;
    };
    req.destroy = (reason) => process.nextTick(() => req.emit("error", reason));
    req.end = () => process.nextTick(() => {
      if (hang) return;
      if (error) {
        req.emit("error", error);
        return;
      }
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);
    });
    return req;
  };
  return { calls, request };
}

describe("Kimi quota Phase 0 smoke helper", () => {
  it("uses the fixed endpoint, true Clawd user-agent, bearer auth, and GET", async () => {
    const fake = createFakeRequest({
      body: JSON.stringify({
        usage: { used: "1", limit: "100", resetTime: "2026-08-21T00:00:00Z" },
      }),
    });
    await requestUsage({ apiKey: "test-secret", request: fake.request });
    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].endpoint, ENDPOINT);
    assert.strictEqual(fake.calls[0].options.method, "GET");
    assert.strictEqual(fake.calls[0].options.headers.Authorization, "Bearer test-secret");
    assert.strictEqual(fake.calls[0].options.headers["User-Agent"], USER_AGENT);
    assert.strictEqual(fake.calls[0].options.headers.Accept, "application/json");
  });

  it("keeps only quota schema and never emits unknown values or wallet contents", () => {
    const secret = "sk-do-not-leak";
    const sanitized = sanitizeSuccessBody({
      usage: {
        remaining: "99",
        limit: "100",
        resetTime: "2026-03-09T11:16:04.416717Z",
        accountEmail: secret,
      },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE", identity: secret },
        detail: { used: "1", limit: "100", resetTime: "2026-08-14T16:00:00Z" },
        token: secret,
      }],
      boosterWallet: { balance: secret },
      totalQuota: secret,
      account: secret,
    });
    const output = JSON.stringify(sanitized);
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("accountEmail"));
    assert.ok(!output.includes("identity"));
    assert.ok(!output.includes("balance"));
    assert.strictEqual(sanitized.unknownTopLevelFieldCount, 1);
    assert.strictEqual(sanitized.usage.unknownFieldCount, 1);
    assert.deepStrictEqual(sanitized.boosterWallet, { present: true, type: "object" });
  });

  it("preserves used/remaining wire evidence and microsecond reset time", () => {
    const resetTime = "2026-03-09T11:16:04.416717Z";
    const sanitized = sanitizeSuccessBody({
      usage: { used: "1", remaining: "99", limit: "100", resetTime },
      limits: [],
    });
    assert.strictEqual(sanitized.usage.fields.used.value, "1");
    assert.strictEqual(sanitized.usage.fields.remaining.value, "99");
    assert.strictEqual(sanitized.usage.fields.limit.value, "100");
    assert.strictEqual(sanitized.usage.fields.resetTime.value, resetTime);
    assert.ok(Number.isFinite(sanitized.usage.fields.resetTime.epochMs));
  });

  it("caps response bodies before any raw response can enter evidence", async () => {
    const fake = createFakeRequest({ body: "x".repeat(128) });
    await assert.rejects(
      requestUsage({ apiKey: "test-secret", request: fake.request, maxBodyBytes: 32 }),
      (error) => error && error.code === "ERR_BODY_TOO_LARGE",
    );
  });

  it("does not follow redirects or expose their response body", async () => {
    const secret = "sk-redirect-body-secret";
    const fake = createFakeRequest({
      statusCode: 302,
      headers: { location: "https://evil.invalid/collect" },
      body: JSON.stringify({ message: secret }),
    });
    const report = await runSmoke({
      apiKey: "test-secret",
      samples: 1,
      intervalMs: 5_000,
      request: fake.request,
    });
    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].endpoint, ENDPOINT);
    assert.strictEqual(report.samples[0].statusCode, 302);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.strictEqual(report.samples[0].error, null);
  });

  it("destroys a hung request at the bounded timeout", async () => {
    const fake = createFakeRequest({ hang: true });
    const pending = requestUsage({ apiKey: "test-secret", request: fake.request });
    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].req.timeoutMs, 8_000);
    fake.calls[0].req.onTimeout();
    await assert.rejects(pending, (error) => error && error.code === "ETIMEDOUT");
  });

  it("sanitizes non-2xx bodies to a bounded error code", async () => {
    const secret = "sk-response-secret";
    const fake = createFakeRequest({
      statusCode: 429,
      headers: { "retry-after": "120", "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: { code: "rate_limit", message: secret }, token: secret }),
    });
    const report = await runSmoke({
      apiKey: "test-secret",
      samples: 1,
      intervalMs: 5_000,
      request: fake.request,
    });
    const output = JSON.stringify(report);
    assert.ok(!output.includes(secret));
    assert.strictEqual(report.samples[0].statusCode, 429);
    assert.deepStrictEqual(report.samples[0].retryAfter, {
      present: true,
      value: "120",
      kind: "delta-seconds",
    });
    assert.deepStrictEqual(report.samples[0].error, { code: "rate_limit" });
  });

  it("does not echo a reflected credential from response headers or error code", async () => {
    const secret = "sk-reflected-secret";
    const fake = createFakeRequest({
      statusCode: 401,
      headers: {
        "retry-after": secret,
        "content-type": `application/${secret}`,
      },
      body: JSON.stringify({ error: { code: secret, message: secret } }),
    });
    const report = await runSmoke({
      apiKey: secret,
      samples: 1,
      intervalMs: 5_000,
      request: fake.request,
    });
    const output = JSON.stringify(report);
    assert.ok(!output.includes(secret));
    assert.deepStrictEqual(report.samples[0].retryAfter, {
      present: true,
      valid: false,
      length: secret.length,
    });
    assert.strictEqual(report.samples[0].contentType, "other");
    assert.strictEqual(report.samples[0].error, null);
  });

  it("requires bounded samples and intervals and exposes no key argument", () => {
    assert.deepStrictEqual(parseArgs([
      "--key-stdin",
      "--quiet-window-confirmed",
      "--samples", "2",
      "--interval-seconds", "30",
    ]), {
      keyStdin: true,
      quietWindowConfirmed: true,
      samples: 2,
      intervalSeconds: 30,
      outputPath: "",
      help: false,
    });
    assert.throws(() => parseArgs(["--key", "secret"]), /Unknown option/);
    assert.throws(() => parseArgs(["--endpoint", "https:\/\/evil.invalid"]), /Unknown option/);
    assert.throws(() => parseArgs(["--samples", "4"]), /1 to 3/);
    assert.throws(() => parseArgs(["--interval-seconds", "1"]), /5 to 600/);
  });
});
