"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  createUsageGaugeRuntime,
  pickFreshestCodexUsage,
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
