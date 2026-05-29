"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  createUsageGaugeRuntime,
  pickFreshestCodexUsage,
  pickFreshestUsage,
} = require("../src/usage-gauge-runtime");

function codexUsage({ usedPercent, capturedAtMs, source }) {
  return {
    provider: "codex",
    capturedAtMs,
    source,
    limits: [{
      id: "codex.primary",
      provider: "codex",
      key: "primary",
      label: "Codex 5h",
      windowLabel: "5h",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      severity: "green",
      windowMinutes: 300,
      resetsAtMs: null,
    }],
  };
}

function settings() {
  return {
    enabled: true,
    pollIntervalMs: 60000,
    providers: { codex: true, claude: false },
    alwaysOnLimitIds: ["codex.primary"],
    expandedLimitIds: [],
  };
}

function claudeUsage({ usedPercent, capturedAtMs, source }) {
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
    pollIntervalMs: 60000,
    providers: { codex: false, claude: true },
    alwaysOnLimitIds: ["claude.five_hour"],
    expandedLimitIds: [],
  };
}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for snapshot")), 1000)),
  ]);
}

test("pickFreshestCodexUsage picks the newest non-empty capturedAtMs", () => {
  const local = codexUsage({
    usedPercent: 20,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const remote = codexUsage({
    usedPercent: 80,
    capturedAtMs: Date.parse("2026-05-29T02:00:00.000Z"),
    source: { kind: "remote", profileId: "ssh-a" },
  });

  assert.strictEqual(pickFreshestCodexUsage([local, remote]), remote);
  assert.deepStrictEqual(pickFreshestCodexUsage([null, { provider: "codex", limits: [] }]), {
    provider: "codex",
    limits: [],
  });
});

test("usage gauge Codex runtime picks fresh remote over stale local", async () => {
  const local = codexUsage({
    usedPercent: 20,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const remote = codexUsage({
    usedPercent: 80,
    capturedAtMs: Date.parse("2026-05-29T02:00:00.000Z"),
    source: { kind: "remote", profileId: "ssh-a" },
  });
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: settings,
    readCodex: () => local,
    getRemoteCodexProfiles: () => [{ id: "ssh-a" }],
    readRemoteCodex: () => remote,
    readClaude: () => ({ provider: "claude", limits: [] }),
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  runtime.start();
  const snapshot = await withTimeout(snapshotPromise);
  runtime.stop();

  assert.strictEqual(snapshot.providers[0].source.kind, "remote");
  assert.strictEqual(snapshot.providers[0].limits[0].usedPercent, 80);
});

test("usage gauge Codex runtime keeps local data when a remote read throws", async () => {
  const local = codexUsage({
    usedPercent: 35,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const warnings = [];
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: settings,
    readCodex: () => local,
    getRemoteCodexProfiles: () => [{ id: "ssh-a" }],
    readRemoteCodex: () => { throw new Error("ssh failed"); },
    readClaude: () => ({ provider: "claude", limits: [] }),
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });

  runtime.start();
  const snapshot = await withTimeout(snapshotPromise);
  runtime.stop();

  assert.strictEqual(snapshot.providers[0].source.kind, "local");
  assert.strictEqual(snapshot.providers[0].limits[0].usedPercent, 35);
  assert.ok(warnings.some((args) => String(args[0]).includes("remote Codex usage failed")));
});

test("pickFreshestUsage picks the newest non-empty capturedAtMs for any provider", () => {
  const local = claudeUsage({
    usedPercent: 10,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const remote = claudeUsage({
    usedPercent: 55,
    capturedAtMs: Date.parse("2026-05-29T02:00:00.000Z"),
    source: { kind: "remote", profileId: "ssh-a" },
  });

  assert.strictEqual(pickFreshestUsage([local, remote], "claude"), remote);
  assert.deepStrictEqual(pickFreshestUsage([null, { provider: "claude", limits: [] }], "claude"), {
    provider: "claude",
    limits: [],
  });
});

test("usage gauge Claude runtime picks fresh remote over stale local", async () => {
  const local = claudeUsage({
    usedPercent: 10,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const remote = claudeUsage({
    usedPercent: 55,
    capturedAtMs: Date.parse("2026-05-29T02:00:00.000Z"),
    source: { kind: "remote", profileId: "ssh-a" },
  });
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    readClaude: () => local,
    getRemoteCodexProfiles: () => [{ id: "ssh-a" }],
    readRemoteClaude: () => remote,
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  runtime.start();
  const snapshot = await withTimeout(snapshotPromise);
  runtime.stop();

  assert.strictEqual(snapshot.providers[1].source.kind, "remote");
  assert.strictEqual(snapshot.providers[1].limits[0].usedPercent, 55);
});

test("usage gauge Claude runtime adopts remote when local token is expired (empty)", async () => {
  // Local read returns empty (expired token); remote returns fresh data.
  const remote = claudeUsage({
    usedPercent: 42,
    capturedAtMs: Date.parse("2026-05-29T02:00:00.000Z"),
    source: { kind: "remote", profileId: "ssh-a" },
  });
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    readClaude: () => ({ provider: "claude", limits: [] }),
    getRemoteClaudeProfiles: () => [{ id: "ssh-a" }],
    readRemoteClaude: () => remote,
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  runtime.start();
  const snapshot = await withTimeout(snapshotPromise);
  runtime.stop();

  assert.strictEqual(snapshot.providers[1].source.kind, "remote");
  assert.strictEqual(snapshot.providers[1].limits[0].usedPercent, 42);
});

test("usage gauge Claude runtime keeps local data when a remote read throws", async () => {
  const local = claudeUsage({
    usedPercent: 30,
    capturedAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
    source: { kind: "local" },
  });
  const warnings = [];
  let resolveSnapshot;
  const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: claudeSettings,
    readCodex: () => ({ provider: "codex", limits: [] }),
    readClaude: () => local,
    getRemoteClaudeProfiles: () => [{ id: "ssh-a" }],
    readRemoteClaude: () => { throw new Error("ssh failed"); },
    showSnapshot: resolveSnapshot,
    hide: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });

  runtime.start();
  const snapshot = await withTimeout(snapshotPromise);
  runtime.stop();

  assert.strictEqual(snapshot.providers[1].source.kind, "local");
  assert.strictEqual(snapshot.providers[1].limits[0].usedPercent, 30);
  assert.ok(warnings.some((args) => String(args[0]).includes("remote Claude usage failed")));
});

test("usage gauge Claude runtime skips remote reads when claude provider is disabled", async () => {
  let remoteCalls = 0;
  let resolveHide;
  const hidePromise = new Promise((resolve) => { resolveHide = resolve; });
  const runtime = createUsageGaugeRuntime({
    getSettings: settings, // codex:true, claude:false
    readCodex: () => ({ provider: "codex", limits: [] }),
    readClaude: () => { throw new Error("should not be called"); },
    getRemoteClaudeProfiles: () => [{ id: "ssh-a" }],
    readRemoteClaude: () => { remoteCalls += 1; return { provider: "claude", limits: [] }; },
    showSnapshot: () => {},
    hide: resolveHide,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  runtime.start();
  await withTimeout(hidePromise);
  runtime.stop();

  assert.strictEqual(remoteCalls, 0);
});
