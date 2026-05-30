"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  createUsageGaugeRuntime,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
} = require("../src/usage-gauge-runtime");

function claudeResult({ usedPercent, capturedAtMs, source }) {
  return {
    provider: "claude",
    capturedAtMs,
    source,
    limits: [{
      id: "claude.five_hour",
      provider: "claude",
      key: "five_hour",
      label: "Claude 5h",
      windowLabel: "5h",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      severity: "green",
      windowMinutes: 300,
      resetsAtMs: null,
    }],
  };
}

function claudeSettings() {
  return {
    enabled: true,
    pollIntervalMs: 300000,
    providers: { codex: false, claude: true },
    alwaysOnLimitIds: ["claude.five_hour"],
    expandedLimitIds: [],
  };
}

// Let all pending microtasks/immediates settle so an un-awaited refresh()
// (the one start() fires) completes before we inspect or step again. A few
// setImmediate hops cover the nested Promise.all/.then chains in refresh().
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Drive refresh() deterministically: start() once (fires the first refresh),
// then call refresh() manually for subsequent cycles, flushing between each so
// the inFlight guard never swallows a step.
function makeRuntime(overrides) {
  let snapshot = null;
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    showSnapshot: (s) => { snapshot = s; },
    hide: () => { snapshot = null; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    ...overrides,
  });
  return { runtime, getSnapshot: () => snapshot };
}

test("hybrid fetchClaude: a fresh statusline snapshot wins and the API is NEVER called", async () => {
  let apiCalls = 0;
  let remoteCalls = 0;
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    readStatusline: () => claudeResult({ usedPercent: 21, capturedAtMs: 1778950000000, source: { kind: "statusline" } }),
    readClaude: () => { apiCalls += 1; return { provider: "claude", limits: [] }; },
    getRemoteClaudeProfiles: () => [{ id: "ssh-a" }],
    readRemoteClaude: () => { remoteCalls += 1; return { provider: "claude", limits: [] }; },
  });

  runtime.start();
  const snap = await snapshotPromise;
  runtime.stop();

  const claude = snap.providers.find((p) => p.provider === "claude");
  assert.strictEqual(claude.source.kind, "statusline");
  assert.strictEqual(claude.limits[0].usedPercent, 21);
  assert.strictEqual(apiCalls, 0);
  assert.strictEqual(remoteCalls, 0);
});

test("hybrid fetchClaude: a stale/empty snapshot falls back to the API", async () => {
  let apiCalls = 0;
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    readStatusline: () => null, // stale / missing
    readClaude: () => { apiCalls += 1; return claudeResult({ usedPercent: 42, capturedAtMs: 1778950000000, source: { kind: "local" } }); },
  });

  runtime.start();
  const snap = await snapshotPromise;
  runtime.stop();

  const claude = snap.providers.find((p) => p.provider === "claude");
  assert.strictEqual(claude.source.kind, "local");
  assert.strictEqual(claude.limits[0].usedPercent, 42);
  assert.strictEqual(apiCalls, 1);
});

test("429 backoff: after a 429 the API is skipped on the next refresh, snapshot read still runs", async () => {
  let apiCalls = 0;
  let statuslineCalls = 0;
  let nowMs = 1778950000000;
  const { runtime } = makeRuntime({
    now: () => nowMs,
    readStatusline: () => { statuslineCalls += 1; return null; },
    readClaude: () => {
      apiCalls += 1;
      return { provider: "claude", limits: [], rateLimited: true, retryAfterMs: null };
    },
  });

  runtime.start();
  await flush();
  assert.strictEqual(apiCalls, 1);
  const statuslineAfterFirst = statuslineCalls;

  // Immediately after: backoff window open -> API skipped, snapshot still read.
  await runtime.refresh();
  await flush();
  assert.strictEqual(apiCalls, 1, "API must not be called during backoff");
  assert.ok(statuslineCalls > statuslineAfterFirst, "snapshot read keeps running during backoff");

  // Advance past the default backoff -> API allowed again.
  nowMs += DEFAULT_RATE_LIMIT_BACKOFF_MS + 1;
  await runtime.refresh();
  await flush();
  assert.strictEqual(apiCalls, 2, "API resumes after backoff expires");

  runtime.stop();
});

test("429 backoff: a positive Retry-After is honored over the default", async () => {
  let apiCalls = 0;
  let nowMs = 1778950000000;
  const RETRY_AFTER_MS = 90 * 1000; // shorter than the 30-min default
  const { runtime } = makeRuntime({
    now: () => nowMs,
    readStatusline: () => null,
    readClaude: () => {
      apiCalls += 1;
      return { provider: "claude", limits: [], rateLimited: true, retryAfterMs: RETRY_AFTER_MS };
    },
  });

  runtime.start();
  await flush();
  assert.strictEqual(apiCalls, 1); // backoff armed for 90s

  // Before Retry-After elapses: still blocked.
  nowMs += RETRY_AFTER_MS - 1000;
  await runtime.refresh();
  await flush();
  assert.strictEqual(apiCalls, 1);

  // After Retry-After elapses (well before the 30-min default): unblocked.
  nowMs += 2000;
  await runtime.refresh();
  await flush();
  assert.strictEqual(apiCalls, 2);

  runtime.stop();
});

test("stale-keep: a transient empty API result keeps the last good value visible", async () => {
  let nowMs = 1778950000000;
  let mode = "good";
  const { runtime, getSnapshot } = makeRuntime({
    now: () => nowMs,
    readStatusline: () => null,
    readClaude: () => {
      if (mode === "good") return claudeResult({ usedPercent: 33, capturedAtMs: nowMs, source: { kind: "local" } });
      return { provider: "claude", limits: [] }; // expired token / transient failure
    },
  });

  runtime.start();
  await flush();
  let claude = getSnapshot().providers.find((p) => p.provider === "claude");
  assert.strictEqual(claude.limits[0].usedPercent, 33);

  // Now the API returns empty; the gauge should keep showing the cached value.
  mode = "fail";
  nowMs += 60000;
  await runtime.refresh();
  await flush();
  claude = getSnapshot().providers.find((p) => p.provider === "claude");
  assert.strictEqual(claude.limits[0].usedPercent, 33, "last good value is retained");

  runtime.stop();
});
