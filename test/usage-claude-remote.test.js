"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  REMOTE_CLAUDE_USAGE_JS,
  buildRemoteClaudeUsageCommand,
  fetchRemoteClaudeUsage,
} = require("../src/usage-claude-remote");

const PROFILE = { id: "ssh-a", host: "test-host" };

// Minimal fake child that mirrors the parts fetchRemoteClaudeUsage uses:
// stdout data events, then "exit" (code cached) and "close" (final).
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  return child;
}

function makeSpawn(child) {
  return () => child;
}

const USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 3.0, resets_at: "2026-05-30T05:00:00.000Z" },
  seven_day: { utilization: 14.0, resets_at: "2026-06-05T00:00:00.000Z" },
  seven_day_sonnet: { utilization: 0.0, resets_at: "2026-06-05T00:00:00.000Z" },
});

test("buildRemoteClaudeUsageCommand quotes a non-default node bin and embeds the snippet", () => {
  assert.ok(buildRemoteClaudeUsageCommand("node").startsWith("node -e "));
  const custom = buildRemoteClaudeUsageCommand("/opt/n/bin/node");
  assert.ok(custom.startsWith("'/opt/n/bin/node' -e "));
  // The verified snippet must hit the real usage endpoint with OAuth headers.
  assert.ok(REMOTE_CLAUDE_USAGE_JS.includes("api.anthropic.com/api/oauth/usage"));
  assert.ok(REMOTE_CLAUDE_USAGE_JS.includes("anthropic-beta"));
  // write-then-exit-in-flush-callback truncate guard.
  assert.ok(REMOTE_CLAUDE_USAGE_JS.includes("()=>process.exit(0)"));
});

test("fetchRemoteClaudeUsage parses remote usage body and stamps capturedAtMs", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(
    PROFILE,
    { spawn: makeSpawn(child), now: () => 1717000000000 }
  );
  child.stdout.emit("data", Buffer.from(USAGE_BODY));
  child.emit("exit", 0);
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.provider, "claude");
  assert.strictEqual(result.source.kind, "remote");
  assert.strictEqual(result.source.profileId, "ssh-a");
  assert.strictEqual(result.capturedAtMs, 1717000000000);
  assert.deepStrictEqual(result.limits.map((l) => l.id), [
    "claude.five_hour",
    "claude.seven_day",
    "claude.seven_day_sonnet",
  ]);
});

test("fetchRemoteClaudeUsage waits for close even when exit fires before stdout drains", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(PROFILE, { spawn: makeSpawn(child) });
  // exit arrives first, then the (large) stdout, then close.
  child.emit("exit", 0);
  child.stdout.emit("data", Buffer.from(USAGE_BODY.slice(0, 20)));
  child.stdout.emit("data", Buffer.from(USAGE_BODY.slice(20)));
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.limits.length, 3);
});

test("fetchRemoteClaudeUsage returns empty limits when remote emits an error JSON", async () => {
  const child = fakeChild();
  const promise = fetchRemoteClaudeUsage(PROFILE, { spawn: makeSpawn(child) });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ error: "no-token" })));
  child.emit("close", 0);

  const result = await promise;
  assert.deepStrictEqual(result, { provider: "claude", limits: [] });
});

test("fetchRemoteClaudeUsage returns empty limits on non-zero exit / unparseable / spawn failure", async () => {
  const nonZero = fakeChild();
  const p1 = fetchRemoteClaudeUsage(PROFILE, { spawn: makeSpawn(nonZero) });
  nonZero.emit("exit", 255);
  nonZero.emit("close", 255);
  assert.deepStrictEqual(await p1, { provider: "claude", limits: [] });

  const garbage = fakeChild();
  const p2 = fetchRemoteClaudeUsage(PROFILE, { spawn: makeSpawn(garbage) });
  garbage.stdout.emit("data", Buffer.from("not json"));
  garbage.emit("close", 0);
  assert.deepStrictEqual(await p2, { provider: "claude", limits: [] });

  const throwingSpawn = () => { throw new Error("spawn ENOENT"); };
  const p3 = fetchRemoteClaudeUsage(PROFILE, { spawn: throwingSpawn });
  assert.deepStrictEqual(await p3, { provider: "claude", limits: [] });
});

test("fetchRemoteClaudeUsage registers and unregisters the child with the runtime", async () => {
  const child = fakeChild();
  const registered = [];
  const unregistered = [];
  const runtime = {
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const promise = fetchRemoteClaudeUsage(
    PROFILE,
    { spawn: makeSpawn(child), runtime }
  );
  child.stdout.emit("data", Buffer.from(USAGE_BODY));
  child.emit("close", 0);
  await promise;
  assert.strictEqual(registered[0], child);
  assert.strictEqual(unregistered[0], child);
});

test("fetchRemoteClaudeUsage resolves empty on timeout", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => { killed = true; };
  // Never emit close; rely on the (short) timeout.
  const result = await fetchRemoteClaudeUsage(
    PROFILE,
    { spawn: makeSpawn(child), timeoutMs: 5 }
  );
  assert.deepStrictEqual(result, { provider: "claude", limits: [] });
  assert.strictEqual(killed, true);
});
