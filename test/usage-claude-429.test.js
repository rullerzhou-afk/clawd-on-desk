"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { parseRetryAfterMs } = require("../src/usage-sources");
const { fetchRemoteClaudeUsage } = require("../src/usage-claude-remote");

const PROFILE = { id: "ssh-a", host: "test-host" };

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("parseRetryAfterMs handles delta-seconds, HTTP-date, and bogus values", () => {
  assert.strictEqual(parseRetryAfterMs("2458"), 2458 * 1000);
  assert.strictEqual(parseRetryAfterMs("0"), null);
  assert.strictEqual(parseRetryAfterMs(""), null);
  assert.strictEqual(parseRetryAfterMs(null), null);
  assert.strictEqual(parseRetryAfterMs("not-a-date"), null);

  const now = Date.parse("2026-05-30T00:00:00.000Z");
  const future = new Date(now + 60000).toUTCString();
  assert.strictEqual(parseRetryAfterMs(future, now), 60000);
  const past = new Date(now - 60000).toUTCString();
  assert.strictEqual(parseRetryAfterMs(past, now), null);
});

test("fetchRemoteClaudeUsage propagates a remote 429 with rateLimited + retryAfterMs", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(PROFILE, { spawn: () => child });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ error: "http:429", retry_after: 120 })));
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.provider, "claude");
  assert.deepStrictEqual(result.limits, []);
  assert.strictEqual(result.rateLimited, true);
  assert.strictEqual(result.retryAfterMs, 120 * 1000);
});

test("fetchRemoteClaudeUsage maps a 429 without retry_after to null retryAfterMs", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(PROFILE, { spawn: () => child });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ error: "http:429", retry_after: null })));
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.rateLimited, true);
  assert.strictEqual(result.retryAfterMs, null);
});

test("fetchRemoteClaudeUsage keeps a non-429 error as a plain empty result", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(PROFILE, { spawn: () => child });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ error: "http:500", retry_after: null })));
  child.emit("close", 0);

  const result = await promise;
  assert.deepStrictEqual(result, { provider: "claude", limits: [] });
});
