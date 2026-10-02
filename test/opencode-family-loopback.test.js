"use strict";

// issue #1065: under `opencode serve` / `web` the host client's baseUrl is the
// listening address. A wildcard bind (0.0.0.0 / [::]) is a listen address, not
// a destination: when the host process sets HTTP_PROXY, Bun hands those
// requests to the proxy, so the plugin rewrites the host to loopback per call.
// This suite covers the address rewrite, the bridge reply target/error
// reporting, and the three context SDK call sites (provider.list /
// session.messages / session.list).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { pathToFileURL } = require("node:url");

// The core module resolves ~/.clawd at evaluation time; keep every write inside
// this temporary HOME and never touch the user's real Clawd state.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-loopback-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const RUNTIME_CONFIG_PATH = path.join(TMP_HOME, ".clawd", "runtime.json");

function writeLiveRuntimeIdentity() {
  fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify({
    app: "clawd-on-desk",
    port: 23333,
    ownerPid: process.pid,
  }), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(RUNTIME_CONFIG_PATH, 0o600);
}

let core;
let createOpencodeFamilyPlugin;
const fetchCalls = [];
let bridgePortCounter = 45000;

before(async () => {
  writeLiveRuntimeIdentity();
  // Every POST to Clawd is answered as a recognized, metadata-accepted server so
  // the plugin's port discovery settles immediately.
  globalThis.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    fetchCalls.push({ url: String(url), body });
    const metadata = body && body.metadata_only === true;
    const headers = {
      "x-clawd-server": "clawd-on-desk",
      "x-clawd-metadata-accepted": "1",
    };
    return {
      status: metadata ? 204 : 200,
      headers: { get: (name) => headers[String(name).toLowerCase()] || null },
      text: async () => "",
    };
  };
  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  core = await import(pathToFileURL(modulePath).href);
  createOpencodeFamilyPlugin = core.createOpencodeFamilyPlugin;
});

after(() => {
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

async function flush(times = 30) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const OC = Object.freeze({
  agentId: "opencode", hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log", sessionIdPrefix: "opencode:",
});

function clientWithConfig({ baseUrl, getConfig } = {}) {
  return {
    _client: {
      getConfig: getConfig || (() => ({ baseUrl })),
      post: async () => ({ data: {} }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    session: {
      list: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  };
}

async function initInstance({ baseUrl, postResult, client } = {}) {
  const captured = { fetch: null };
  globalThis.Bun = {
    serve(opts) {
      captured.fetch = opts.fetch;
      return { port: ++bridgePortCounter };
    },
  };
  const sdkCalls = [];
  const resolvedClient = client || {
    _client: {
      getConfig: () => ({ baseUrl }),
      post: async (args) => {
        sdkCalls.push(args);
        if (typeof postResult === "function") return postResult(args);
        return { data: {} };
      },
    },
  };
  const plugin = createOpencodeFamilyPlugin(OC);
  const hooks = await plugin({ serverUrl: "http://127.0.0.1:1/", directory: "/tmp/proj", client: resolvedClient });
  return { plugin, hooks, captured, sdkCalls };
}

function bridgeRequest(plugin, { token, method = "POST", pathName = "/reply", body } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`${plugin.__test._bridgeUrl}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

async function emitPermission(instance, requestId, sessionID = "ses_loopback") {
  await instance.hooks.event({
    event: {
      type: "permission.asked",
      properties: { id: requestId, sessionID, permission: "bash", metadata: { command: "echo" } },
    },
  });
}

describe("issue #1065: loopback baseUrl rewrite", () => {
  function clientFor(baseUrl) {
    return { _client: { getConfig: () => ({ baseUrl }) } };
  }

  it("rewrites a wildcard IPv4 listen address to 127.0.0.1", () => {
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("http://0.0.0.0:4096")),
      "http://127.0.0.1:4096"
    );
  });

  it("rewrites a wildcard IPv6 listen address to [::1]", () => {
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("http://[::]:4096")),
      "http://[::1]:4096"
    );
  });

  it("preserves protocol, port and path and never returns a trailing slash", () => {
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("https://0.0.0.0:8443/prefix")),
      "https://127.0.0.1:8443/prefix"
    );
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("http://0.0.0.0:4096/")),
      "http://127.0.0.1:4096"
    );
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("http://0.0.0.0:4096/prefix/")),
      "http://127.0.0.1:4096/prefix"
    );
    assert.strictEqual(
      core.resolveLoopbackBaseUrl(clientFor("http://[::]:4096")),
      "http://[::1]:4096"
    );
  });

  it("leaves every non-wildcard host untouched", () => {
    const untouched = [
      "http://127.0.0.1:4096",
      "http://localhost:4096",
      "http://192.168.1.5:4096",
      "https://example.com",
      "http://[::1]:4096",
    ];
    for (const baseUrl of untouched) {
      assert.strictEqual(core.resolveLoopbackBaseUrl(clientFor(baseUrl)), null, baseUrl);
    }
  });

  it("returns null when the client or its configuration is unavailable", () => {
    assert.strictEqual(core.resolveLoopbackBaseUrl(null), null);
    assert.strictEqual(core.resolveLoopbackBaseUrl({}), null);
    assert.strictEqual(core.resolveLoopbackBaseUrl({ _client: {} }), null);
    assert.strictEqual(core.resolveLoopbackBaseUrl({ _client: { getConfig: () => null } }), null);
    assert.strictEqual(core.resolveLoopbackBaseUrl({ _client: { getConfig: () => ({}) } }), null);
  });

  it("returns null when getConfig throws and never surfaces the error", () => {
    const client = { _client: { getConfig: () => { throw new Error("boom"); } } };
    assert.strictEqual(core.resolveLoopbackBaseUrl(client), null);
  });

  it("returns null when baseUrl is not a legal URL", () => {
    assert.strictEqual(core.resolveLoopbackBaseUrl(clientFor("not a url")), null);
  });
});

describe("issue #1065: bridge reply target", () => {
  it("passes a loopback baseUrl override when the host listens on 0.0.0.0", async () => {
    const instance = await initInstance({ baseUrl: "http://0.0.0.0:4096" });
    await emitPermission(instance, "per_wild");
    const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
      token: instance.plugin.__test._bridgeTokenHex,
      body: { request_id: "per_wild", reply: "once" },
    }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(instance.sdkCalls.length, 1);
    assert.strictEqual(instance.sdkCalls[0].baseUrl, "http://127.0.0.1:4096");
  });

  for (const baseUrl of ["http://127.0.0.1:4096", "http://localhost:4096"]) {
    it(`does not pass baseUrl when the host listens on ${baseUrl}`, async () => {
      const instance = await initInstance({ baseUrl });
      await emitPermission(instance, "per_local");
      const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
        token: instance.plugin.__test._bridgeTokenHex,
        body: { request_id: "per_local", reply: "once" },
      }));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(instance.sdkCalls.length, 1);
      assert.strictEqual(Object.hasOwn(instance.sdkCalls[0], "baseUrl"), false);
    });
  }

  it("logs only the target origin and its rewrite source, never the full URL", async () => {
    const instance = await initInstance({ baseUrl: "http://0.0.0.0:4096/secret-path?token=abc" });
    await emitPermission(instance, "per_origin");
    await instance.captured.fetch(bridgeRequest(instance.plugin, {
      token: instance.plugin.__test._bridgeTokenHex,
      body: { request_id: "per_origin", reply: "once" },
    }));
    await instance.plugin.__test.flushDebugLog();
    const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
    assert.match(log, /BRIDGE reply target=http:\/\/127\.0\.0\.1:4096 \(rewritten from http:\/\/0\.0\.0\.0:4096\)/);
    assert.doesNotMatch(log, /secret-path|token=abc/);
  });
});

describe("issue #1065: bridge reply failure reporting", () => {
  async function bridgeReply({ result, requestId = "per_err" } = {}) {
    const instance = await initInstance({
      baseUrl: "http://0.0.0.0:4096",
      postResult: typeof result === "function" ? result : () => result,
    });
    await emitPermission(instance, requestId);
    const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
      token: instance.plugin.__test._bridgeTokenHex,
      body: { request_id: requestId, reply: "once" },
    }));
    await instance.plugin.__test.flushDebugLog();
    return { instance, status: res.status, body: await res.json() };
  }

  async function replyWith(result) {
    return (await bridgeReply({ result })).body;
  }

  it("reports the upstream status and a readable message for an empty 401 body", async () => {
    const body = await replyWith({ error: {}, response: { status: 401, statusText: "Unauthorized" } });
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.status, 401);
    assert.strictEqual(body.error, "HTTP 401 Unauthorized: empty response body");
  });

  it("reports an empty 502 body", async () => {
    const body = await replyWith({ error: {}, response: { status: 502 } });
    assert.strictEqual(body.status, 502);
    assert.strictEqual(body.error, "HTTP 502: empty response body");
  });

  it("prefers data.message for a JSON error body", async () => {
    const body = await replyWith({
      error: { data: { message: "permission request not found" }, _tag: "PermissionNotFoundError" },
      response: { status: 404, statusText: "Not Found" },
    });
    assert.strictEqual(body.status, 404);
    assert.strictEqual(body.error, "HTTP 404 Not Found: permission request not found");
    assert.doesNotMatch(body.error, /\[object Object\]/);
  });

  it("uses the top-level message when data has none, then _tag", async () => {
    assert.strictEqual(
      (await replyWith({ error: { _tag: "PermissionNotFoundError", message: "gone" }, response: { status: 404 } })).error,
      "HTTP 404: gone"
    );
    assert.strictEqual(
      (await replyWith({ error: { _tag: "PermissionNotFoundError" }, response: { status: 404 } })).error,
      "HTTP 404: PermissionNotFoundError"
    );
  });

  it("uses a text body verbatim", async () => {
    const body = await replyWith({
      error: "gateway said no",
      response: { status: 502, statusText: "Bad Gateway" },
    });
    assert.strictEqual(body.status, 502);
    assert.strictEqual(body.error, "HTTP 502 Bad Gateway: gateway said no");
  });

  it("bounds an over-long body to roughly 300 characters", async () => {
    const body = await replyWith({
      error: `${"x".repeat(1000)} ${"y".repeat(1000)}`,
      response: { status: 500 },
    });
    assert.strictEqual(body.status, 500);
    assert.ok(body.error.length <= 300, `expected <= 300 chars, got ${body.error.length}`);
    assert.ok(body.error.startsWith("HTTP 500: "));
    assert.ok(body.error.endsWith("…"));
  });

  it("marks a truncated body even when the cut drops all of it", async () => {
    const body = await replyWith({ error: "x".repeat(2000), response: { status: 500 } });
    assert.strictEqual(body.status, 500);
    assert.strictEqual(body.error, "HTTP 500: [truncated]");
  });

  it("flattens control characters into a single line", async () => {
    const body = await replyWith({
      error: "bad\u0000\u001bthing\nline\there",
      response: { status: 400, statusText: "Bad Request" },
    });
    assert.strictEqual(body.error, "HTTP 400 Bad Request: bad thing line here");
    assert.doesNotMatch(body.error, /[\u0000-\u001F\u007F-\u009F]/);
  });

  it("uses status 0 when the upstream response carries no status", async () => {
    const body = await replyWith({ error: "no response object" });
    assert.strictEqual(body.status, 0);
    assert.strictEqual(body.error, "HTTP 0: no response object");
  });

  describe("redacts secrets before the text is logged or returned", () => {
    async function assertNotLeaked(result, originals, expected) {
      const { instance, body } = await bridgeReply({ result });
      const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
      for (const original of originals) {
        assert.ok(!body.error.includes(original), `response leaked: ${original}`);
        assert.ok(!log.includes(original), `log leaked: ${original}`);
      }
      assert.doesNotMatch(body.error, /\[object Object\]/);
      if (expected !== undefined) assert.strictEqual(body.error, expected);
      return body;
    }

    it("redacts an Authorization scheme credential", async () => {
      await assertNotLeaked(
        { error: "Authorization: Basic b3BlbmNvZGU6cHc=", response: { status: 401 } },
        ["Basic b3BlbmNvZGU6cHc=", "b3BlbmNvZGU6cHc="],
        "HTTP 401: Authorization: [redacted]"
      );
    });

    it("redacts the bridge token even when echoed after a scheme", async () => {
      const holder = { token: "" };
      const instance = await initInstance({
        baseUrl: "http://0.0.0.0:4096",
        postResult: () => ({ error: `upstream echo Bearer ${holder.token}`, response: { status: 502 } }),
      });
      holder.token = instance.plugin.__test._bridgeTokenHex;
      await emitPermission(instance, "per_token");
      const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
        token: holder.token,
        body: { request_id: "per_token", reply: "once" },
      }));
      const body = await res.json();
      await instance.plugin.__test.flushDebugLog();
      assert.strictEqual(body.error, "HTTP 502: upstream echo Bearer [redacted]");
      assert.ok(!body.error.includes(holder.token));
      const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
      assert.ok(!log.includes(holder.token));
    });

    it("redacts the bridge token when it appears as plain text", async () => {
      const holder = { token: "" };
      const instance = await initInstance({
        baseUrl: "http://0.0.0.0:4096",
        postResult: () => ({ error: `echo ${holder.token} end`, response: { status: 502 } }),
      });
      holder.token = instance.plugin.__test._bridgeTokenHex;
      await emitPermission(instance, "per_token_plain");
      const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
        token: holder.token,
        body: { request_id: "per_token_plain", reply: "once" },
      }));
      const body = await res.json();
      await instance.plugin.__test.flushDebugLog();
      assert.strictEqual(body.error, "HTTP 502: echo [redacted] end");
      assert.ok(!body.error.includes(holder.token));
      const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
      assert.ok(!log.includes(holder.token));
    });

    it("redacts a URL query string", async () => {
      await assertNotLeaked(
        {
          error: "http://0.0.0.0:4096/permission/x/reply?directory=C%3A%5Cproj",
          response: { status: 401 },
        },
        ["?directory=C%3A%5Cproj"],
        "HTTP 401: http://0.0.0.0:4096/permission/x/reply?[redacted]"
      );
    });

    it("keeps a plain question mark that is not a query string", async () => {
      await assertNotLeaked(
        { error: "is the host up? retry later", response: { status: 502 } },
        [],
        "HTTP 502: is the host up? retry later"
      );
    });

    it("keeps ordinary scheme words in prose", async () => {
      await assertNotLeaked(
        { error: "basic auth failed", response: { status: 401 } },
        [],
        "HTTP 401: basic auth failed"
      );
    });

    it("summarizes an unrecognized object without exposing its values", async () => {
      const body = await assertNotLeaked(
        { error: { authorization: "SecretValue123", extra: 1 }, response: { status: 502 } },
        ["SecretValue123"],
        "HTTP 502: unrecognized error body (keys: authorization, extra)"
      );
      assert.doesNotMatch(body.error, /\[object Object\]/);
    });

    it("redacts a JSON text body with a quoted authorization key", async () => {
      await assertNotLeaked(
        { error: '{"authorization":"SecretValue123"}', response: { status: 502 } },
        ["SecretValue123"]
      );
    });

    it("redacts an escaped quoted authorization key", async () => {
      await assertNotLeaked(
        { error: '\\"authorization\\":\\"SecretValue123\\"', response: { status: 502 } },
        ["SecretValue123"]
      );
    });

    it("redacts URL userinfo", async () => {
      await assertNotLeaked(
        { error: "http://user:pass@proxy.local/", response: { status: 502 } },
        ["user:pass"],
        "HTTP 502: http://[redacted]@proxy.local/"
      );
    });

    it("redacts a Cookie header value", async () => {
      await assertNotLeaked(
        { error: "Cookie: sid=abc", response: { status: 400 } },
        ["sid=abc"],
        "HTTP 400: Cookie: [redacted]"
      );
    });
  });

  it("survives a throwing getter on result.error and still returns the structured 502 body", async () => {
    const bomb = {};
    Object.defineProperty(bomb, "message", { get() { throw new Error("getter bomb"); }, enumerable: true });
    Object.defineProperty(bomb, "name", { get() { throw new Error("getter bomb"); }, enumerable: true });
    const { status, body } = await bridgeReply({ result: { error: bomb, response: { status: 502 } } });
    assert.strictEqual(status, 502);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.status, 502);
    assert.strictEqual(body.error, "HTTP 502: unrecognized error body (keys: message, name)");
  });

  it("survives a throwing getter on the thrown error and returns status 0", async () => {
    const bomb = {};
    Object.defineProperty(bomb, "message", { get() { throw new Error("getter bomb"); } });
    Object.defineProperty(bomb, "name", { get() { throw new Error("getter bomb"); } });
    Object.defineProperty(bomb, "code", { get() { throw new Error("getter bomb"); } });
    const { status, body } = await bridgeReply({ result: () => { throw bomb; } });
    assert.strictEqual(status, 502);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.status, 0);
    assert.ok(body.error.startsWith("request failed"), body.error);
  });

  it("returns the fixed fallback when a thrown error property cannot be stringified", async () => {
    const bomb = {};
    const toStringBomb = { toString() { throw new Error("stringify bomb"); } };
    Object.defineProperty(bomb, "name", { get: () => toStringBomb, enumerable: true });
    const { status, body } = await bridgeReply({ result: () => { throw bomb; } });
    assert.strictEqual(status, 502);
    assert.strictEqual(body.status, 0);
    assert.strictEqual(body.error, "request failed: unreadable error");
  });

  it("falls back to a serializable label for a circular error object", async () => {
    const circular = { some: "detail" };
    circular.self = circular;
    const { body } = await bridgeReply({ result: { error: circular, response: { status: 502 } } });
    assert.strictEqual(body.status, 502);
    assert.strictEqual(body.error, "HTTP 502: unrecognized error body (keys: some, self)");
  });

  it("falls back to a serializable label when Object.keys throws", async () => {
    const proxy = new Proxy({}, { ownKeys() { throw new Error("keys bomb"); } });
    const { status, body } = await bridgeReply({ result: { error: proxy, response: { status: 502 } } });
    assert.strictEqual(status, 502);
    assert.strictEqual(body.status, 502);
    assert.strictEqual(body.error, "HTTP 502: unserializable error body");
  });

  for (const [label, unit] of [["question marks", "?"], ["host-like fragments", "a."]]) {
    it(`handles 200k ${label} within the time budget`, async () => {
      const text = unit.repeat(200000);
      const instance = await initInstance({
        baseUrl: "http://0.0.0.0:4096",
        postResult: () => ({ error: text, response: { status: 502 } }),
      });
      await emitPermission(instance, "per_perf");
      // Time only the bridge handler: plugin init (which can snapshot processes
      // on Windows) and the log flush are unrelated to redaction cost.
      const started = Date.now();
      const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
        token: instance.plugin.__test._bridgeTokenHex,
        body: { request_id: "per_perf", reply: "once" },
      }));
      const elapsed = Date.now() - started;
      const body = await res.json();
      assert.strictEqual(res.status, 502);
      assert.strictEqual(body.status, 502);
      assert.ok(body.error.length <= 300, `error body too long: ${body.error.length}`);
      assert.ok(elapsed < 1500, `redaction took too long: ${elapsed}ms`);
    });
  }

  it("drops the incomplete trailing segment when the text is truncated", async () => {
    const holder = { token: "" };
    const instance = await initInstance({
      baseUrl: "http://0.0.0.0:4096",
      postResult: () => {
        const prefix = `?k=${"v".repeat(900)} `;
        const before = "z".repeat(Math.max(0, 1000 - prefix.length));
        return { error: `${prefix}${before}${holder.token} tail`, response: { status: 502 } };
      },
    });
    holder.token = instance.plugin.__test._bridgeTokenHex;
    await emitPermission(instance, "per_boundary");
    const res = await instance.captured.fetch(bridgeRequest(instance.plugin, {
      token: holder.token,
      body: { request_id: "per_boundary", reply: "once" },
    }));
    const body = await res.json();
    await instance.plugin.__test.flushDebugLog();
    const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
    const fragment = holder.token.slice(0, 6);
    assert.ok(!body.error.includes(fragment), `response leaked a token fragment: ${fragment}`);
    // The startup record intentionally logs the first 8 token chars, so check the
    // error record itself rather than the whole log.
    const errorRecords = log.split("\n").filter((line) => line.includes("BRIDGE reply done"));
    assert.ok(errorRecords.length >= 1, "no BRIDGE reply done record in the log");
    for (const line of errorRecords) {
      assert.ok(!line.includes(fragment), `log leaked a token fragment: ${fragment}`);
    }
  });

  it("logs a single bounded THROW line for a long multiline error", async () => {
    const message = `first line\n${"x".repeat(1000)}`;
    const { instance, status, body } = await bridgeReply({
      result: () => { throw new Error(message); },
    });
    assert.strictEqual(status, 502);
    assert.strictEqual(body.status, 0);
    assert.ok(!body.error.includes("\n"), "response error must be single-line");
    const log = fs.readFileSync(instance.plugin.__test._debugLogPath, "utf8");
    const start = log.indexOf("BRIDGE reply THROW");
    assert.ok(start >= 0, "no THROW record in the log");
    // Each debugLog record is prefixed with a timestamp, so a multiline message
    // would leave a continuation line before the next "[timestamp]" record.
    const nextRecord = log.indexOf("\n[", start);
    let record = log.slice(start, nextRecord === -1 ? undefined : nextRecord);
    if (record.endsWith("\n")) record = record.slice(0, -1);
    assert.ok(!record.includes("\n"), `THROW record spans multiple lines: ${JSON.stringify(record.slice(0, 80))}`);
    assert.ok(record.length <= 400, `THROW record too long: ${record.length}`);
  });
});

describe("issue #1065: context SDK calls use loopback for wildcard hosts", () => {
  async function contextInstance(baseUrl) {
    const providerCalls = [];
    const listCalls = [];
    const messagesCalls = [];
    const client = {
      _client: { getConfig: () => ({ baseUrl }), post: async () => ({ data: {} }) },
      provider: { list: async (...args) => { providerCalls.push(args); return { data: { all: [] } }; } },
      session: {
        list: async (...args) => { listCalls.push(args); return { data: [] }; },
        messages: async (...args) => { messagesCalls.push(args); return { data: [] }; },
      },
    };
    const instance = await initInstance({ client });
    return { ...instance, providerCalls, listCalls, messagesCalls };
  }

  it("passes baseUrl to session.list and session.messages for 0.0.0.0", async () => {
    const h = await contextInstance("http://0.0.0.0:4096");
    await flush(5); // bootstrapContextUsage runs on a microtask after init

    assert.ok(h.listCalls.length >= 1, "session.list was not called during bootstrap");
    assert.strictEqual(h.listCalls[0][0].baseUrl, "http://127.0.0.1:4096");

    await h.hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_ctx", status: { type: "busy" } } },
    });
    await flush();

    assert.ok(h.messagesCalls.length >= 1, "session.messages was not called during hydration");
    assert.strictEqual(h.messagesCalls[0][0].baseUrl, "http://127.0.0.1:4096");
  });

  it("passes baseUrl to provider.list for 0.0.0.0", async () => {
    const h = await contextInstance("http://0.0.0.0:4096");
    await flush(5);
    const client = {
      _client: { getConfig: () => ({ baseUrl: "http://0.0.0.0:4096" }) },
      provider: { list: async (...args) => { h.providerCalls.push(args); return { data: { all: [] } }; } },
    };
    await h.plugin.__test.resolveContextLimit("openai", "model", client);
    assert.strictEqual(h.providerCalls.length, 1);
    assert.strictEqual(h.providerCalls[0][0].baseUrl, "http://127.0.0.1:4096");
  });

  it("keeps the call shape unchanged for a non-wildcard host", async () => {
    const h = await contextInstance("http://127.0.0.1:4096");
    await flush(5);

    assert.ok(h.listCalls.length >= 1);
    assert.strictEqual(Object.hasOwn(h.listCalls[0][0], "baseUrl"), false);

    await h.hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_ctx2", status: { type: "busy" } } },
    });
    await flush();
    assert.ok(h.messagesCalls.length >= 1);
    assert.strictEqual(Object.hasOwn(h.messagesCalls[0][0], "baseUrl"), false);

    const client = {
      _client: { getConfig: () => ({ baseUrl: "http://127.0.0.1:4096" }) },
      provider: { list: async (...args) => { h.providerCalls.push(args); return { data: { all: [] } }; } },
    };
    await h.plugin.__test.resolveContextLimit("openai", "model", client);
    assert.strictEqual(h.providerCalls.length, 1);
    assert.strictEqual(h.providerCalls[0].length, 0, "non-wildcard provider.list must be called with no arguments");
  });
});
