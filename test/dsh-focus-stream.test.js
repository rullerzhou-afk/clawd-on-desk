"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const {
  createDshFocusStream,
  REPLAY_WINDOW_MS,
  MAX_ID_CHARS,
} = require("../src/dsh-focus-stream");

// A real HTTP server, because the contract under test is the wire: EventSource
// in the DSH page only sees status, headers, and `event:`/`data:` frames.
function listen(stream, handler = stream.handle) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function subscribe(port, origin) {
  const headers = origin === undefined ? {} : { origin };
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: "127.0.0.1", path: "/dsh/focus-stream", headers }, (res) => {
      resolve({ req, res });
    });
    req.on("error", reject);
    req.end();
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("dsh focus stream", () => {
  it("pushes a published session id to a loopback subscriber", async () => {
    const stream = createDshFocusStream();
    const { port, close } = await listen(stream);
    try {
      const { req, res } = await subscribe(port, "http://127.0.0.1:8307");
      const received = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => received.push(chunk));
      await waitFor(() => stream.subscriberCount() === 1);
      assert.strictEqual(stream.publish("session-abc"), true);
      await waitFor(() => received.join("").includes("event: focus"));
      assert.match(received.join(""), /data: \{"sessionId":"session-abc"\}/);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://127.0.0.1:8307");
      req.destroy();
    } finally {
      await close();
    }
  });

  it("accepts the desktop app's dsh-app://app origin", async () => {
    const stream = createDshFocusStream();
    const { port, close } = await listen(stream);
    try {
      const { req, res } = await subscribe(port, "dsh-app://app");
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers["access-control-allow-origin"], "dsh-app://app");
      assert.strictEqual(stream.subscriberCount(), 1);
      req.destroy();
    } finally {
      await close();
    }
  });

  it("refuses a non-loopback origin without granting CORS", async () => {
    const stream = createDshFocusStream();
    const { port, close } = await listen(stream);
    try {
      const { req, res } = await subscribe(port, "http://evil.example");
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.headers["access-control-allow-origin"], undefined);
      assert.strictEqual(stream.subscriberCount(), 0);
      req.destroy();
    } finally {
      await close();
    }
  });

  it("replays a recent click once and drops a stale one", async () => {
    let clock = 1000;
    const stream = createDshFocusStream({ now: () => clock });
    const { port, close } = await listen(stream);
    try {
      stream.publish("session-fresh");
      const first = await subscribe(port, "http://localhost:8307");
      const firstBody = [];
      first.res.setEncoding("utf8");
      first.res.on("data", (chunk) => firstBody.push(chunk));
      await waitFor(() => firstBody.join("").includes("session-fresh"));
      first.req.destroy();

      clock += REPLAY_WINDOW_MS + 1;
      stream.publish("session-stale");
      clock += REPLAY_WINDOW_MS + 1;
      const second = await subscribe(port, "http://localhost:8307");
      const secondBody = [];
      second.res.setEncoding("utf8");
      second.res.on("data", (chunk) => secondBody.push(chunk));
      await waitFor(() => secondBody.join("").includes(": clawd dsh focus"));
      // The open comment frame arrives; the expired click must not.
      assert.doesNotMatch(secondBody.join(""), /session-stale/);
      second.req.destroy();
    } finally {
      await close();
    }
  });

  it("rejects empty, oversized, and control-character ids", () => {
    const stream = createDshFocusStream();
    assert.strictEqual(stream.publish(""), false);
    assert.strictEqual(stream.publish("   "), false);
    assert.strictEqual(stream.publish("x".repeat(MAX_ID_CHARS + 1)), false);
    assert.strictEqual(stream.publish("session-\u0000bad"), false);
    assert.strictEqual(stream.publish("session-ok"), true);
  });

  it("drops a subscriber that closed", async () => {
    const stream = createDshFocusStream();
    const { port, close } = await listen(stream);
    try {
      const { req } = await subscribe(port, "http://127.0.0.1:8307");
      await waitFor(() => stream.subscriberCount() === 1);
      req.destroy();
      await waitFor(() => stream.subscriberCount() === 0);
    } finally {
      await close();
    }
  });
});
