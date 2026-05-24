"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  TelegramApprovalClient,
  normalizeApprovalPayload,
  parseDecision,
  normalizeEndpoint,
} = require("../src/telegram-approval-client");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  const address = await listen(server);
  try {
    return await fn(address);
  } finally {
    await close(server);
  }
}

test("telegram approval client sends bearer JSON and maps allow", async () => {
  let seen = null;
  await withServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(body),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  }, async (address) => {
    const client = new TelegramApprovalClient({ listen: `127.0.0.1:${address.port}`, token: "secret-token" });
    const decision = await client.requestApproval({
      title: "Run command",
      detail: "npm test",
      ignored: "must not be sent",
    });
    assert.equal(decision, "allow");
  });

  assert.deepEqual(seen, {
    method: "POST",
    url: "/approval/request",
    auth: "Bearer secret-token",
    body: { title: "Run command", detail: "npm test" },
  });
});

test("telegram approval client maps timeout and HTTP errors to no-op", async () => {
  await withServer((req, res) => {
    if (req.url === "/timeout") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: "timeout" }));
      return;
    }
    res.writeHead(500);
    res.end("nope");
  }, async (address) => {
    const client = new TelegramApprovalClient({ listen: `127.0.0.1:${address.port}`, token: "secret-token" });
    assert.equal(await client.requestApproval({ title: "x" }), null);

    const timeoutClient = new TelegramApprovalClient({ listen: `127.0.0.1:${address.port}`, token: "secret-token" }, {
      httpRequest: (options, cb) => {
        options.path = "/timeout";
        return http.request(options, cb);
      },
    });
    assert.equal(await timeoutClient.requestApproval({ title: "x" }), null);
  });
});

test("telegram approval client abort destroys the in-flight request", async () => {
  let requestClosed = false;
  let gotRequestResolve;
  let requestClosedResolve;
  const gotRequest = new Promise((resolve) => { gotRequestResolve = resolve; });
  const requestClosedPromise = new Promise((resolve) => { requestClosedResolve = resolve; });

  await withServer((req, res) => {
    req.on("close", () => {
      requestClosed = true;
      requestClosedResolve();
    });
    gotRequestResolve();
    // Hold the response open until the client aborts.
    void res;
  }, async (address) => {
    const client = new TelegramApprovalClient({ listen: `127.0.0.1:${address.port}`, token: "secret-token" });
    const ac = new AbortController();
    const promise = client.requestApproval({ title: "x" }, { signal: ac.signal });
    await gotRequest;
    ac.abort();
    assert.equal(await promise, null);
    await Promise.race([
      requestClosedPromise,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
  });

  assert.equal(requestClosed, true);
});

test("telegram approval client handles connection errors as no-op", async () => {
  const client = new TelegramApprovalClient({ listen: "127.0.0.1:9", token: "secret-token" }, { requestTimeoutMs: 50 });
  assert.equal(await client.requestApproval({ title: "x" }), null);
});

test("telegram approval client pure helpers validate payloads and endpoints", () => {
  assert.deepEqual(normalizeApprovalPayload({ title: "  hi ", detail: 42, extra: true }), {
    title: "hi",
    detail: "42",
  });
  assert.throws(() => normalizeApprovalPayload({ title: "" }), /title/);
  assert.throws(() => normalizeEndpoint({ listen: "0.0.0.0:1", token: "x" }), /127\.0\.0\.1/);
  assert.equal(parseDecision(JSON.stringify({ decision: "deny" })), "deny");
  assert.equal(parseDecision(JSON.stringify({ decision: "timeout" })), null);
  assert.equal(parseDecision("not json"), null);
});
