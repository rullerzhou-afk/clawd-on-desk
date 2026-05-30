"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  normalizeStatuslineSnapshot,
  windowToRaw,
  readStatuslineUsage,
  DEFAULT_FRESHNESS_MS,
} = require("../src/usage-statusline");

const NOW = 1778950000000;

function freshSnapshot(updatedAtMs = NOW) {
  return {
    updated_at: new Date(updatedAtMs).toISOString(),
    five_hour: { used_percentage: 21, resets_at: 1778959800 },
    seven_day: { used_percentage: 9, resets_at: 1779127200 },
  };
}

test("windowToRaw maps used_percentage onto used_percent for makeLimit", () => {
  assert.deepStrictEqual(windowToRaw({ used_percentage: 21, resets_at: 5 }), {
    used_percent: 21,
    resets_at: 5,
  });
  assert.strictEqual(windowToRaw({ resets_at: 5 }), null);
  assert.strictEqual(windowToRaw(null), null);
});

test("normalizeStatuslineSnapshot returns claude limits for a fresh snapshot", () => {
  const result = normalizeStatuslineSnapshot(freshSnapshot(), { now: NOW + 1000 });
  assert.strictEqual(result.provider, "claude");
  assert.strictEqual(result.source.kind, "statusline");
  assert.strictEqual(result.capturedAtMs, NOW);
  assert.deepStrictEqual(result.limits.map((l) => l.id), ["claude.five_hour", "claude.seven_day"]);
  assert.strictEqual(result.limits[0].usedPercent, 21);
  assert.strictEqual(result.limits[0].resetsAtMs, 1778959800 * 1000);
  assert.strictEqual(result.limits[1].usedPercent, 9);
});

test("normalizeStatuslineSnapshot returns null when stale beyond freshnessMs", () => {
  const stale = freshSnapshot(NOW - DEFAULT_FRESHNESS_MS - 1);
  assert.strictEqual(normalizeStatuslineSnapshot(stale, { now: NOW }), null);
  // still fresh at exactly the boundary
  const edge = freshSnapshot(NOW - DEFAULT_FRESHNESS_MS);
  assert.ok(normalizeStatuslineSnapshot(edge, { now: NOW }));
});

test("normalizeStatuslineSnapshot returns null for missing/invalid updated_at", () => {
  assert.strictEqual(normalizeStatuslineSnapshot({ five_hour: { used_percentage: 1 } }, { now: NOW }), null);
  assert.strictEqual(
    normalizeStatuslineSnapshot({ updated_at: "not-a-date", five_hour: { used_percentage: 1 } }, { now: NOW }),
    null
  );
});

test("normalizeStatuslineSnapshot returns null when no usable windows", () => {
  const snap = { updated_at: new Date(NOW).toISOString(), five_hour: { resets_at: 1 } };
  assert.strictEqual(normalizeStatuslineSnapshot(snap, { now: NOW }), null);
  assert.strictEqual(normalizeStatuslineSnapshot(null, { now: NOW }), null);
});

test("readStatuslineUsage parses an injected file and applies freshness", () => {
  const json = JSON.stringify(freshSnapshot());
  const result = readStatuslineUsage({
    snapshotPath: "/fake/statusline.json",
    readFileSync: () => json,
    now: NOW + 1000,
  });
  assert.strictEqual(result.provider, "claude");
  assert.strictEqual(result.limits.length, 2);
  assert.strictEqual(result.source.path, "/fake/statusline.json");
});

test("readStatuslineUsage returns null on missing file or bad JSON", () => {
  assert.strictEqual(
    readStatuslineUsage({ snapshotPath: "/x", readFileSync: () => { throw new Error("ENOENT"); }, now: NOW }),
    null
  );
  assert.strictEqual(
    readStatuslineUsage({ snapshotPath: "/x", readFileSync: () => "{bad json", now: NOW }),
    null
  );
});
