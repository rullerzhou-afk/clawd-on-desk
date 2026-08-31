"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_AGGREGATE_ROWS_PER_DAY,
  createRecapAggregate,
  normalizeDay,
} = require("../src/recap-aggregate");
const { createRecapJournal } = require("../src/recap-journal");
const { createRecapStore } = require("../src/recap-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-aggregate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const journal = createRecapJournal({ store, getTimeZone: () => "UTC" });
  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000 });
  aggregate.load();
  return { aggregate, journal, store };
}

function record(journal, agentId, metrics, hour, identity = {}) {
  return journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, hour),
    agentId,
    scope: identity.scope || "local",
    metrics,
  }, identity);
}

test("aggregate preserves unsupported null separately from supported zero", (t) => {
  const { aggregate, journal } = fixture(t);
  aggregate.apply(record(journal, "codex", ["activity", "tool-call"], 4));
  aggregate.apply(record(journal, "antigravity-cli", ["activity", "turn-complete"], 4));
  const day = aggregate.query("2026-08-29", "2026-08-29")[0];
  const rows = day.rows;
  assert.equal(day.hourCapacities[4], 60);
  const codex = rows.find((row) => row.agentId === "codex");
  const agy = rows.find((row) => row.agentId === "antigravity-cli");
  assert.equal(codex.metrics.toolCalls, 1);
  assert.equal(codex.metrics.turnsCompleted, 0);
  assert.equal(codex.metrics.sessionsStarted, null);
  assert.equal(agy.metrics.toolCalls, null);
  assert.equal(agy.metrics.turnsCompleted, 1);
  assert.equal(agy.hours[4], 1);
});

test("aggregate keeps same agent scopes separate and marks reusable session starts partial", (t) => {
  const { aggregate, journal } = fixture(t);
  aggregate.apply(record(journal, "claude-code", ["activity"], 1, {
    sessionId: "default",
    sessionStartPartial: true,
  }));
  aggregate.apply(record(journal, "claude-code", ["activity", "session-start"], 2, {
    scope: "remote",
    scopeId: "server-one",
    sessionId: "fresh",
  }));
  const rows = aggregate.query("2026-08-29", "2026-08-29")[0].rows;
  assert.equal(rows.length, 2);
  const local = rows.find((row) => row.scope === "local");
  const remote = rows.find((row) => row.scope === "remote");
  assert.equal(local.sessionsStartedPartial, true);
  assert.equal(local.metrics.sessionsStarted, 0);
  assert.equal(remote.sessionsStartedPartial, false);
  assert.equal(remote.metrics.sessionsStarted, 1);
});

test("retained journal dates rebuild monthly cache after an interrupted flush", (t) => {
  const { aggregate, journal, store } = fixture(t);
  const item = record(journal, "codex", ["activity", "tool-call"], 8, {
    sessionId: "s",
    dedupeId: "tool",
  });
  journal.append(item);
  aggregate.replaceDates(journal.retainedDates("2026-08-29"), journal.loadRetained("2026-08-29"));
  aggregate.flush();

  const restored = createRecapAggregate({ store, flushDelayMs: 100000 });
  restored.load();
  const row = restored.query("2026-08-29", "2026-08-29")[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.hours[8], 1);
  const disk = fs.readFileSync(store.childPath("daily-2026-08.json"), "utf8");
  assert.equal(disk.includes("scopeKeyHash"), false);
  assert.equal(disk.includes("timeZoneId"), false);
  assert.equal(disk.includes("utcOffsetMinutes"), false);
});

test("daily rows freeze their historical metric support instead of following current policy", () => {
  const hash = `hmac:${"a".repeat(43)}`;
  const day = normalizeDay("2026-08-29", {
    rows: {
      old: {
        agentId: "antigravity-cli",
        scope: "local",
        scopeKeyHash: hash,
        support: { sessionsStarted: false, turnsCompleted: true, toolCalls: true },
        metrics: { sessionsStarted: null, turnsCompleted: 2, toolCalls: 7, activityEvents: 9 },
        sessionsStartedPartial: true,
        hours: Array(24).fill(0),
      },
    },
    hourCapacities: Array(24).fill(60),
  });
  assert.ok(day);
  const row = Object.values(day.rows)[0];
  assert.equal(row.metrics.activityEvents, 9);
  assert.equal(row.metrics.toolCalls, 7);
  assert.equal(row.support.toolCalls, true);
  assert.equal(Object.hasOwn(row, "scopeKeyHash"), false);
});

test("duplicate serialized row keys merge into the broad agent scope", () => {
  const makeRow = (hash, count) => ({
    agentId: "codex",
    scope: "remote",
    scopeKeyHash: hash,
    support: { sessionsStarted: false, turnsCompleted: true, toolCalls: true },
    metrics: { sessionsStarted: null, turnsCompleted: count, toolCalls: count, activityEvents: count },
    sessionsStartedPartial: true,
    hours: Array(24).fill(count),
  });
  const day = normalizeDay("2026-08-29", {
    rows: {
      one: makeRow(`hmac:${"a".repeat(43)}`, 2),
      two: makeRow(`hmac:${"b".repeat(43)}`, 3),
    },
    hourCapacities: Array(24).fill(60),
  });
  const rows = Object.values(day.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metrics.activityEvents, 5);
  assert.equal(rows[0].metrics.toolCalls, 5);
  assert.equal(rows[0].hours[0], 5);
});

test("unreleased daily aggregate schemas are quarantined without migration", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("daily-2026-04.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    month: "2026-04",
    days: {
      "2026-04-05": {
        rows: {},
        hourKindsByTimeZone: { "Australia/Lord_Howe": Array(24).fill("normal") },
      },
    },
  }));

  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000 });
  aggregate.load();
  assert.equal(aggregate.query("2026-04-05", "2026-04-05")[0].hourCapacities[1], 0);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("daily-2026-04.json.")));
});

test("a day with mixed supported and unsupported policy segments stays honestly null", (t) => {
  const { aggregate, journal } = fixture(t);
  const historical = record(journal, "antigravity-cli", ["activity", "tool-call"], 8);
  historical.support.toolCalls = true;
  aggregate.apply(historical);
  aggregate.apply(record(journal, "antigravity-cli", ["activity"], 9));
  const row = aggregate.query("2026-08-29", "2026-08-29")[0].rows[0];
  assert.equal(row.metrics.toolCalls, null);
  assert.equal(row.metrics.activityEvents, 2);
  assert.equal(row.hours[8], 1);
  assert.equal(row.hours[9], 1);
});

test("invalid managed monthly files are recoverably quarantined", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("daily-2020-01.json");
  fs.writeFileSync(filePath, "{broken");
  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000 });
  aggregate.load();
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("daily-2020-01.json.")));
});

test("aggregate rejects bounded-size schema fan-out before normalizing rows", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("daily-2026-08.json");
  const rows = Object.fromEntries(Array.from(
    { length: MAX_AGGREGATE_ROWS_PER_DAY + 1 },
    (_, index) => [`row-${index}`, null]
  ));
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    month: "2026-08",
    days: { "2026-08-29": { rows, hourCapacities: Array(24).fill(60) } },
  }));
  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000, logWarn: () => {} });
  const started = performance.now();
  aggregate.load();
  assert.ok(performance.now() - started < 500);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("daily-2026-08.json.")));
});
