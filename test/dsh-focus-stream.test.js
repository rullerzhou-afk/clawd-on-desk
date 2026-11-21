"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createDshFocusStream,
  REPLAY_WINDOW_MS,
  MAX_ID_CHARS,
} = require("../src/dsh-focus-stream");

// Exercise real status, headers and SSE framing on an ephemeral test port.
async function listen(t, stream) {
  const server = http.createServer(stream.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const requests = [];
  t.after(async () => {
    for (const req of requests) req.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return async (origin = "dsh-app://app", host) => {
    const headers = origin === null ? {} : { origin };
    if (host !== undefined) headers.host = host;
    return new Promise((resolve, reject) => {
      const req = http.request({
        port: server.address().port, host: "127.0.0.1", path: "/dsh/focus-stream", headers,
      }, (res) => {
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
        resolve({ req, res, body: () => chunks.join("") });
      });
      requests.push(req);
      req.on("error", reject);
      req.end();
    });
  };
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

function frames(connection) {
  return connection.body().split("\n\n")
    .filter((frame) => frame.startsWith("event: focus\ndata: "))
    .map((frame) => JSON.parse(frame.slice("event: focus\ndata: ".length)));
}

async function waitForFrames(connection, count) {
  await waitFor(() => frames(connection).length === count);
  return frames(connection);
}

describe("dsh focus stream", () => {
  it("pushes desktop clicks with unique ids and grants only the desktop origin", async (t) => {
    const stream = createDshFocusStream();
    const subscribe = await listen(t, stream);
    const connection = await subscribe();
    assert.equal(connection.res.statusCode, 200);
    assert.equal(connection.res.headers["access-control-allow-origin"], "dsh-app://app");
    assert.equal(stream.subscriberCount(), 1);
    assert.equal(stream.publish("session-abc"), true);
    const [first] = await waitForFrames(connection, 1);
    assert.equal(first.sessionId, "session-abc");
    assert.match(first.clickId, /^[0-9a-f-]{36}:1$/);
    assert.equal(stream.publish("session-abc"), true);
    const [, second] = await waitForFrames(connection, 2);
    assert.equal(second.sessionId, "session-abc");
    assert.match(second.clickId, /^[0-9a-f-]{36}:2$/);
    assert.notEqual(first.clickId, second.clickId);
  });

  for (const origin of ["http://127.0.0.1:8307", "http://localhost:8307", "dsh-app://shell",
    "http://evil.example", "dsh-app://app/", "null", null]) {
    it(`refuses ${origin === null ? "a missing Origin" : origin} without CORS or a subscriber`, async (t) => {
      const stream = createDshFocusStream();
      const subscribe = await listen(t, stream);
      const { res } = await subscribe(origin);
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal(stream.subscriberCount(), 0);
    });
  }

  for (const host of ["example.test:23333", "127.0.0.1:70000", "127.0.0.1:0",
    "localhost:65536", "localhost:abc", "[::1]:70000", "127.0.0.1.evil.test"]) {
    it(`refuses invalid Host ${JSON.stringify(host)} without granting CORS`, async (t) => {
      const stream = createDshFocusStream();
      const subscribe = await listen(t, stream);
      const { res } = await subscribe("dsh-app://app", host);
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal(stream.subscriberCount(), 0);
    });
  }

  it("refuses an empty or missing Host without granting CORS or subscribing", () => {
    // Node fills an empty outgoing Host, so exercise the handler directly.
    for (const headers of [
      { origin: "dsh-app://app", host: "" },
      { origin: "dsh-app://app" },
    ]) {
      const stream = createDshFocusStream();
      const res = {
        writeHead(status, responseHeaders) {
          this.statusCode = status;
          this.headers = responseHeaders;
        },
        end() {},
      };
      stream.handle({ headers }, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
      assert.equal(stream.subscriberCount(), 0);
    }
  });

  it("accepts loopback Host names and valid port boundaries", async (t) => {
    const stream = createDshFocusStream();
    const subscribe = await listen(t, stream);
    for (const host of ["127.0.0.1", "localhost:1", "[::1]:65535", "LOCALHOST"]) {
      const { res } = await subscribe("dsh-app://app", host);
      assert.equal(res.statusCode, 200, host);
      assert.equal(res.headers["access-control-allow-origin"], "dsh-app://app");
    }
    assert.equal(stream.subscriberCount(), 4);
  });

  it("gives a new stream instance a distinct click id after a restart", async (t) => {
    const clicks = [];
    for (let boot = 0; boot < 2; boot += 1) {
      const stream = createDshFocusStream();
      stream.publish("session-restart");
      const subscribe = await listen(t, stream);
      const connection = await subscribe();
      clicks.push((await waitForFrames(connection, 1))[0].clickId);
    }
    assert.notEqual(clicks[0], clicks[1]);
  });

  it("replays the same click to every new subscriber within thirty seconds", async (t) => {
    let clock = 1000;
    const stream = createDshFocusStream({ now: () => clock });
    stream.publish("session-fresh");
    const subscribe = await listen(t, stream);
    const first = await subscribe();
    const [click] = await waitForFrames(first, 1);
    clock += 29999;
    const second = await subscribe();
    assert.deepEqual(await waitForFrames(second, 1), [click]);
    const third = await subscribe();
    assert.deepEqual(await waitForFrames(third, 1), [click]);
  });

  it("keeps a delivered click available for another page to replay", async (t) => {
    const stream = createDshFocusStream();
    const subscribe = await listen(t, stream);
    const first = await subscribe();
    stream.publish("session-delivered");
    const [click] = await waitForFrames(first, 1);
    const second = await subscribe();
    assert.deepEqual(await waitForFrames(second, 1), [click]);
  });

  it("does not replay a click older than thirty seconds", async (t) => {
    assert.equal(REPLAY_WINDOW_MS, 30000);
    let clock = 1000;
    const stream = createDshFocusStream({ now: () => clock });
    stream.publish("session-stale");
    clock += 30001;
    const subscribe = await listen(t, stream);
    const connection = await subscribe();
    await waitFor(() => connection.body().includes(": clawd dsh focus\n\n"));
    assert.deepEqual(frames(connection), []);
  });

  it("rejects empty, oversized, and control-character ids", () => {
    const stream = createDshFocusStream();
    assert.equal(stream.publish(""), false);
    assert.equal(stream.publish("   "), false);
    assert.equal(stream.publish("x".repeat(MAX_ID_CHARS + 1)), false);
    assert.equal(stream.publish("session-\u0000bad"), false);
    assert.equal(stream.publish("session-ok"), true);
  });

  it("drops a subscriber that closed", async (t) => {
    const stream = createDshFocusStream();
    const subscribe = await listen(t, stream);
    const { req } = await subscribe();
    assert.equal(stream.subscriberCount(), 1);
    req.destroy();
    await waitFor(() => stream.subscriberCount() === 0);
  });
});
