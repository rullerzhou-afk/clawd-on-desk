"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramFetchTransport,
  resolveProxyConfig,
  sanitizeProxy,
} = require("../src/telegram-fetch-transport");

const VALID_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789";

function fakeTokenStore(token = VALID_TOKEN) {
  return { async getToken() { return token; }, async hasToken() { return !!token; } };
}

function mkResponse(body = { ok: true, result: { message_id: 1 } }, status = 200, statusText = "OK") {
  return { status, statusText, async json() { return body; } };
}

// Fake Electron Session: spies for fetch / setProxy / resolveProxy / closeAllConnections.
function makeFakeSession({ resolveProxyResult = "PROXY 127.0.0.1:7890", fetchImpl } = {}) {
  const order = [];
  const calls = { setProxy: [], close: 0, resolveProxy: [], fetch: [] };
  let setProxyError = null;
  const ses = {
    async setProxy(cfg) {
      order.push("setProxy");
      calls.setProxy.push(cfg);
      if (setProxyError) throw setProxyError;
    },
    async closeAllConnections() { order.push("close"); calls.close += 1; },
    async resolveProxy(url) { calls.resolveProxy.push(url); return resolveProxyResult; },
    async fetch(url, init) {
      calls.fetch.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : mkResponse();
    },
  };
  return { ses, calls, order, setSetProxyError(e) { setProxyError = e; } };
}

function makeLog() {
  const entries = [];
  return { log: (level, message, meta) => entries.push({ level, message, meta }), entries };
}

// ---- pure helpers ----

test("resolveProxyConfig: CLAWD_TG_PROXY precedence, default system", () => {
  assert.deepEqual(resolveProxyConfig({}), { mode: "system" });
  assert.deepEqual(resolveProxyConfig({ CLAWD_TG_PROXY: "   " }), { mode: "system" });
  assert.deepEqual(resolveProxyConfig({ CLAWD_TG_PROXY: "direct" }), { mode: "direct" });
  assert.deepEqual(resolveProxyConfig({ CLAWD_TG_PROXY: "system" }), { mode: "system" });
  assert.deepEqual(
    resolveProxyConfig({ CLAWD_TG_PROXY: "http://127.0.0.1:8080" }),
    { mode: "fixed_servers", proxyRules: "http://127.0.0.1:8080" },
  );
});

test("sanitizeProxy: keeps type token, drops host:port", () => {
  assert.equal(sanitizeProxy("DIRECT"), "DIRECT");
  assert.equal(sanitizeProxy("PROXY 127.0.0.1:7890"), "PROXY");
  assert.equal(sanitizeProxy("PROXY 1.2.3.4:8080; DIRECT"), "PROXY+DIRECT");
  assert.equal(sanitizeProxy("SOCKS5 10.0.0.1:1080"), "SOCKS5");
  assert.equal(sanitizeProxy(""), "unknown");
  assert.equal(sanitizeProxy(null), "unknown");
});

// ---- transport behavior ----

test("missing token short-circuits before session/proxy/fetch", async () => {
  const { ses, calls } = makeFakeSession();
  let created = 0;
  const transport = createTelegramFetchTransport({
    tokenStore: { async getToken() { return null; } },
    sessionFactory: () => { created += 1; return ses; },
    env: {},
  });
  const r = await transport({ method: "getMe", payload: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "TOKEN_MISSING");
  assert.equal(created, 0);
  assert.equal(calls.setProxy.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("default applies mode:system; fetch carries token; probe is tokenless; log sanitized", async () => {
  const { ses, calls } = makeFakeSession();
  const { log, entries } = makeLog();
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => ses, env: {}, log,
  });
  const r = await transport({ method: "getMe", payload: { a: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.setProxy, [{ mode: "system" }]);
  assert.equal(calls.fetch.length, 1);
  assert.match(calls.fetch[0].url, /\/bot123456789:.*\/getMe$/);
  // resolveProxy probe carries NO token
  assert.deepEqual(calls.resolveProxy, ["https://api.telegram.org/"]);
  assert.ok(!calls.resolveProxy[0].includes("bot"));
  // diagnostic log is type-only, never host:port
  const proxyLog = entries.find((e) => e.message === "telegram proxy resolved");
  assert.ok(proxyLog, "expected a proxy-resolved log line");
  assert.equal(proxyLog.meta.proxy, "PROXY");
  assert.ok(!JSON.stringify(proxyLog).includes("127.0.0.1"));
});

test("CLAWD_TG_PROXY escape hatch: direct / system / url", async () => {
  const cases = [
    ["direct", { mode: "direct" }],
    ["system", { mode: "system" }],
    ["socks5://127.0.0.1:7890", { mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:7890" }],
  ];
  for (const [val, expected] of cases) {
    const { ses, calls } = makeFakeSession();
    const transport = createTelegramFetchTransport({
      tokenStore: fakeTokenStore(), sessionFactory: () => ses, env: { CLAWD_TG_PROXY: val },
    });
    await transport({ method: "getMe", payload: {} });
    assert.deepEqual(calls.setProxy, [expected]);
  }
});

test("setProxy applied once across repeated requests (same config)", async () => {
  const { ses, calls } = makeFakeSession();
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => ses, env: {},
  });
  await transport({ method: "getMe", payload: {} });
  await transport({ method: "getMe", payload: {} });
  await transport({ method: "getUpdates", payload: {} });
  assert.equal(calls.setProxy.length, 1);
  assert.equal(calls.fetch.length, 3);
});

test("concurrent calls init session and setProxy exactly once (apply-lock)", async () => {
  const { ses, calls } = makeFakeSession();
  let created = 0;
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => { created += 1; return ses; }, env: {},
  });
  await Promise.all([
    transport({ method: "getMe", payload: {} }),
    transport({ method: "getMe", payload: {} }),
    transport({ method: "getMe", payload: {} }),
  ]);
  assert.equal(created, 1);
  assert.equal(calls.setProxy.length, 1);
  assert.equal(calls.fetch.length, 3);
});

test("setProxy failure is normalized and retryable (chain not wedged)", async () => {
  const fake = makeFakeSession();
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => fake.ses, env: {},
  });
  fake.setSetProxyError(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
  await assert.rejects(
    () => transport({ method: "getMe", payload: {} }),
    /ERR_PROXY_CONNECTION_FAILED/,
  );
  assert.equal(fake.calls.fetch.length, 0, "fetch must not run when setProxy fails");
  assert.equal(fake.calls.close, 0, "no closeAllConnections on a failed first apply");
  // recover: the chain is not permanently wedged
  fake.setSetProxyError(null);
  const r = await transport({ method: "getMe", payload: {} });
  assert.equal(r.ok, true);
  assert.equal(fake.calls.setProxy.length, 2, "setProxy retried (key never committed on failure)");
});

test("config change: setProxy precedes closeAllConnections; first apply does not close", async () => {
  const fake = makeFakeSession();
  const env = {};
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => fake.ses, env,
  });
  await transport({ method: "getMe", payload: {} });          // first apply: system
  assert.equal(fake.calls.close, 0);
  assert.deepEqual(fake.calls.setProxy, [{ mode: "system" }]);

  env.CLAWD_TG_PROXY = "direct";                              // change config
  await transport({ method: "getMe", payload: {} });
  assert.equal(fake.calls.setProxy.length, 2);
  assert.deepEqual(fake.calls.setProxy[1], { mode: "direct" });
  assert.equal(fake.calls.close, 1);
  const lastSetProxy = fake.order.lastIndexOf("setProxy");
  const lastClose = fake.order.lastIndexOf("close");
  assert.ok(lastSetProxy < lastClose, "setProxy must run before closeAllConnections");
});

test("aborted signal yields AbortError even if impl throws net::ERR_ABORTED", async () => {
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), env: {},
    fetchImpl: async () => { throw new Error("net::ERR_ABORTED"); }, // not name === AbortError
  });
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    () => transport({ method: "getMe", payload: {}, signal: c.signal }),
    (e) => e.name === "AbortError",
  );
});

test("no sessionFactory falls back to injected fetchImpl", async () => {
  let used = 0;
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), env: {},
    fetchImpl: async (url) => { used += 1; assert.match(url, /\/getMe$/); return mkResponse(); },
  });
  const r = await transport({ method: "getMe", payload: {} });
  assert.equal(r.ok, true);
  assert.equal(used, 1);
});

test("non-ok Telegram body maps to error_code/description/parameters", async () => {
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), env: {},
    fetchImpl: async () => mkResponse(
      { ok: false, error_code: 403, description: "Forbidden", parameters: { migrate_to_chat_id: 7 } },
      403, "Forbidden",
    ),
  });
  const r = await transport({ method: "sendMessage", payload: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 403);
  assert.equal(r.description, "Forbidden");
  assert.deepEqual(r.parameters, { migrate_to_chat_id: 7 });
});

test("a throwing diagnostic log does not fail the fetch (best-effort)", async () => {
  const { ses, calls } = makeFakeSession();
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => ses, env: {},
    log: () => { throw new Error("EACCES permLog"); }, // mirrors telegramApprovalLog's sync file write
  });
  const r = await transport({ method: "getMe", payload: {} });
  assert.equal(r.ok, true, "proxy is applied; a failing log must not fail the request");
  assert.equal(calls.setProxy.length, 1);
  assert.equal(calls.fetch.length, 1);
});

test("resolveProxy timeout: fetch still proceeds, no proxy log emitted", async () => {
  const { ses, calls } = makeFakeSession();
  ses.resolveProxy = () => new Promise(() => {}); // never settles → probe loses the race
  const { log, entries } = makeLog();
  const transport = createTelegramFetchTransport({
    tokenStore: fakeTokenStore(), sessionFactory: () => ses, env: {}, log, resolveTimeoutMs: 5,
  });
  const r = await transport({ method: "getMe", payload: {} });
  assert.equal(r.ok, true);
  assert.equal(calls.setProxy.length, 1);
  assert.equal(calls.fetch.length, 1);
  assert.ok(!entries.some((e) => e.message === "telegram proxy resolved"), "no proxy log on resolve timeout");
});
