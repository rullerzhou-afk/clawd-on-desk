"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  REMOTE_CODEX_USAGE_JS,
  buildRemoteCodexUsageCommand,
  fetchRemoteCodexUsage,
} = require("../src/usage-codex-remote");

const PROFILE = { id: "ssh-a", host: "test-host" };

// Minimal fake child that mirrors the parts fetchRemoteCodexUsage uses:
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

// One Codex rollout JSONL line carrying primary + secondary rate_limits.
const USAGE_JSONL = JSON.stringify({
  timestamp: "2026-05-29T03:04:05.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1800000000 },
      secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1800600000 },
    },
  },
});

test("buildRemoteCodexUsageCommand quotes a non-default node bin and embeds the snippet", () => {
  assert.ok(buildRemoteCodexUsageCommand("node").startsWith("node -e "));
  const custom = buildRemoteCodexUsageCommand("/opt/n/bin/node");
  assert.ok(custom.startsWith("'/opt/n/bin/node' -e "));
  // The verified snippet must read the remote ~/.codex/sessions rollout JSONL.
  assert.ok(REMOTE_CODEX_USAGE_JS.includes(".codex"));
  assert.ok(REMOTE_CODEX_USAGE_JS.includes("rollout-"));
  // write-then-exit-in-flush-callback truncate guard.
  assert.ok(REMOTE_CODEX_USAGE_JS.includes("()=>process.exit(0)"));
});

test("fetchRemoteCodexUsage parses remote rollout JSONL into rate limits", async () => {
  const child = fakeChild();
  const promise = fetchRemoteCodexUsage(PROFILE, { spawn: makeSpawn(child) });
  child.stdout.emit("data", Buffer.from(USAGE_JSONL));
  child.emit("exit", 0);
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.provider, "codex");
  assert.strictEqual(result.source.kind, "remote");
  assert.strictEqual(result.source.profileId, "ssh-a");
  // capturedAtMs comes from the JSONL timestamp inside the parser.
  assert.strictEqual(result.capturedAtMs, Date.parse("2026-05-29T03:04:05.000Z"));
  assert.deepStrictEqual(result.limits.map((l) => l.id), [
    "codex.primary",
    "codex.secondary",
  ]);
});

test("fetchRemoteCodexUsage waits for close even when exit fires before stdout drains", async () => {
  const child = fakeChild();
  const promise = fetchRemoteCodexUsage(PROFILE, { spawn: makeSpawn(child) });
  // exit arrives first, then the (large) stdout in chunks, then close.
  child.emit("exit", 0);
  child.stdout.emit("data", Buffer.from(USAGE_JSONL.slice(0, 30)));
  child.stdout.emit("data", Buffer.from(USAGE_JSONL.slice(30)));
  child.emit("close", 0);

  const result = await promise;
  assert.strictEqual(result.limits.length, 2);
});

test("fetchRemoteCodexUsage returns empty limits on garbage / non-zero exit / spawn failure", async () => {
  // Garbage stdout on a clean (exit 0) close: the JSONL parser yields no limits
  // but still returns its empty-with-null-capturedAtMs shape, which the fetcher
  // tags with source. This mirrors the original (pre-refactor) behavior.
  const garbage = fakeChild();
  const p1 = fetchRemoteCodexUsage(PROFILE, { spawn: makeSpawn(garbage) });
  garbage.stdout.emit("data", Buffer.from("{bad json\nnot jsonl"));
  garbage.emit("close", 0);
  const r1 = await p1;
  assert.strictEqual(r1.provider, "codex");
  assert.deepStrictEqual(r1.limits, []);
  assert.strictEqual(r1.capturedAtMs, null);

  // Non-zero remote exit short-circuits to the bare empty result (no source).
  const nonZero = fakeChild();
  const p2 = fetchRemoteCodexUsage(PROFILE, { spawn: makeSpawn(nonZero) });
  nonZero.stdout.emit("data", Buffer.from(USAGE_JSONL));
  nonZero.emit("exit", 255);
  nonZero.emit("close", 255);
  assert.deepStrictEqual(await p2, { provider: "codex", limits: [] });

  const throwingSpawn = () => { throw new Error("spawn ENOENT"); };
  const p3 = fetchRemoteCodexUsage(PROFILE, { spawn: throwingSpawn });
  assert.deepStrictEqual(await p3, { provider: "codex", limits: [] });
});

test("fetchRemoteCodexUsage registers and unregisters the child with the runtime", async () => {
  const child = fakeChild();
  const registered = [];
  const unregistered = [];
  const runtime = {
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const promise = fetchRemoteCodexUsage(
    PROFILE,
    { spawn: makeSpawn(child), runtime }
  );
  child.stdout.emit("data", Buffer.from(USAGE_JSONL));
  child.emit("close", 0);
  await promise;
  assert.strictEqual(registered[0], child);
  assert.strictEqual(unregistered[0], child);
});

test("fetchRemoteCodexUsage resolves empty on timeout", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => { killed = true; };
  // Never emit close; rely on the (short) timeout.
  const result = await fetchRemoteCodexUsage(
    PROFILE,
    { spawn: makeSpawn(child), timeoutMs: 5 }
  );
  assert.deepStrictEqual(result, { provider: "codex", limits: [] });
  assert.strictEqual(killed, true);
});
