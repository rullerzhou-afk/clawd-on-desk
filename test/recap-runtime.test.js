"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createRecapAggregate } = require("../src/recap-aggregate");
const { createRecapJournal } = require("../src/recap-journal");
const { getZonedDateTimeParts } = require("../src/recap-time");
const {
  createRecapRuntime,
  elapsedMinutesInCurrentLocalHour,
  MAX_FUTURE_SKEW_MS,
  rangeForPeriod,
} = require("../src/recap-runtime");
const { createRecapStore } = require("../src/recap-store");

function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-runtime-"));
  if (!options.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = options.now || Date.UTC(2026, 7, 29, 10);
  let enabled = options.enabled !== false;
  let timeZone = options.timeZone || "UTC";
  const runtime = createRecapRuntime({
    root,
    now: () => clock,
    getEnabled: () => enabled,
    getTimeZone: () => timeZone,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    onRecorded: options.onRecorded,
  });
  return {
    root,
    runtime,
    setClock(value) { clock = value; },
    setPreference(value) { enabled = value; },
    setTimeZone(value) { timeZone = value; },
  };
}

function readDailyActivityCount(store, localDate) {
  const month = localDate.slice(0, 7);
  const parsed = JSON.parse(fs.readFileSync(store.childPath(`daily-${month}.json`), "utf8"));
  return Object.values(parsed.days[localDate].rows)
    .reduce((sum, row) => sum + row.metrics.activityEvents, 0);
}

// Tool-call totals for each day that has any, keyed by local date.
function toolCallTotals(runtime, anchorDate = "2026-08-31") {
  const totals = {};
  for (const day of runtime.query("month", { anchorDate }).days) {
    const count = day.rows.reduce((sum, row) => sum + (row.metrics.toolCalls || 0), 0);
    if (count) totals[day.localDate] = count;
  }
  return totals;
}

function readMonthToolCallTotal(store, month = "2026-08") {
  const parsed = JSON.parse(fs.readFileSync(store.childPath(`daily-${month}.json`), "utf8"));
  return Object.values(parsed.days).reduce(
    (sum, day) => sum + Object.values(day.rows).reduce(
      (rowSum, row) => rowSum + (row.metrics.toolCalls || 0),
      0
    ),
    0
  );
}

function waitForChildLine(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.includes(expected)) return;
      clearTimeout(timer);
      reject(new Error(`share holder exited before ready (${code})`));
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for condition");
}

function pausedRetainedJournal(reader, yieldEvery = 1) {
  let release;
  let announce;
  let paused = false;
  const pausedAt = new Promise((resolve) => { announce = resolve; });
  return {
    pausedAt,
    release: () => release(),
    journal: {
      ...reader,
      forEachRetainedAsync(anchorDate, onRecord) {
        return reader.forEachRetainedAsync(anchorDate, onRecord, {
          yieldEvery,
          yieldToMain: () => {
            if (paused) return Promise.resolve();
            paused = true;
            return new Promise((resolve) => {
              release = resolve;
              announce();
            });
          },
        });
      },
    },
  };
}

function seedSplitAggregateJournal(store, journal, publishedCount, eventCount) {
  const published = createRecapAggregate({ store, flushDelayMs: 100000 });
  published.load();
  published.replaceDates(["2026-08-30"], Array.from({ length: publishedCount }, (_, index) => journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 30, 3 + index),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  })));
  published.flush();
  published.resetMemory();
  const events = Array.from({ length: eventCount }, (_, index) => journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 30, 3 + index),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }));
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    events.map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
}

function createManualTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeout(callback, delay) {
      const timer = {
        callback,
        delay,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      cleared.push(timer);
    },
  };
}

function createStorageRetryDependencies(initialize) {
  return {
    store: {
      initialize,
      getMeta: () => ({
        createdAt: Date.UTC(2026, 7, 29, 9),
        createdLocalTime: { timeZoneId: "UTC", localDate: "2026-08-29", localHour: 9 },
      }),
    },
    journal: {
      forEachRetainedAsync: async () => ({ dates: [], truncated: false, restoredDedupeKeys: new Map() }),
      prune() {},
      resetMemory() {},
    },
    aggregate: {
      apply() {},
      beginBatch() {},
      endBatch() {},
      flush() {},
      load() {},
      prune() {},
      query: () => [],
      replaceDays() {},
      resetMemory() {},
    },
    coverage: {
      load() {},
      prune() {},
      query: () => [],
      resetMemory() {},
      start() {},
      stop() {},
      tick() {},
    },
  };
}

test("runtime writes journal before aggregate, dedupes, and exposes no HMAC identity", async (t) => {
  const f = fixture(t);
  f.runtime.start();
  const event = {
    occurredAt: Date.UTC(2026, 7, 29, 10, 5),
    agentId: "codex",
    scope: "remote",
    metrics: ["activity", "tool-call"],
  };
  const identity = { scopeId: "private-server", sessionId: "private-session", dedupeId: "call-1" };
  assert.equal(f.runtime.record(event, identity), true);
  assert.equal(f.runtime.record(event, identity), false);
  const view = f.runtime.query("today");
  assert.equal(view.days[0].rows.length, 1);
  assert.deepEqual(view.days[0].rows[0].metrics, {
    sessionsStarted: null,
    turnsCompleted: 0,
    toolCalls: 1,
    activityEvents: 1,
  });
  assert.equal(view.days[0].rows[0].scopeInstance, "remote");
  assert.equal(view.currentLocalHour, 10);
  assert.equal(view.recordingStartedDate, "2026-08-29");
  assert.equal(view.recordingStartedLocalHour, 10);
  assert.equal(view.recordingStartedHourElapsedMinutes, 0);
  assert.equal(JSON.stringify(view).includes("hmac:"), false);
  assert.equal(JSON.stringify(view).includes("private-server"), false);
  await f.runtime.whenReady();
  assert.equal(f.runtime.query("today").days[0].rows[0].metrics.activityEvents, 1);
});

test("runtime announces only accepted durable records", (t) => {
  let announcements = 0;
  const f = fixture(t, { onRecorded: () => { announcements += 1; } });
  f.runtime.start();
  const event = {
    occurredAt: Date.UTC(2026, 7, 29, 10, 5),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  assert.equal(f.runtime.record(event, identity), true);
  assert.equal(f.runtime.record(event, identity), false);
  assert.equal(announcements, 1);
});

test("recording start keeps its original civil date after travel", (t) => {
  const f = fixture(t, {
    now: Date.UTC(2026, 7, 29, 16, 30),
    timeZone: "Asia/Singapore",
  });
  f.runtime.start();
  assert.equal(f.runtime.query("today").recordingStartedDate, "2026-08-30");
  assert.equal(f.runtime.query("today").recordingStartedLocalHour, 0);

  f.setTimeZone("America/Los_Angeles");
  const afterTravel = f.runtime.query("today", { anchorDate: "2026-08-29" });
  assert.equal(afterTravel.recordingStartedDate, "2026-08-30");
  assert.equal(afterTravel.recordingStartedLocalHour, 0);
});

test("runtime rebuilds retained aggregates from journal without double count", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = fixture(t, { root });
  first.runtime.start();
  first.runtime.record({
    occurredAt: Date.UTC(2026, 7, 29, 9),
    agentId: "claude-code",
    scope: "local",
    metrics: ["activity", "turn-complete"],
  }, { sessionId: "s", dedupeId: "turn" });
  first.runtime.dispose();

  const second = fixture(t, { root });
  second.runtime.start();
  await second.runtime.whenReady();
  const row = second.runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.turnsCompleted, 1);
  assert.equal(row.metrics.activityEvents, 1);
  second.runtime.dispose();
});

test("a stable event replayed while hydration yields is not double counted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-hydration-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const event = {
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  assert.equal(writer.append(writer.buildRecord(event, identity)), true);

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  let releaseHydration;
  let hydrationYielded;
  let paused = false;
  const hydrationPaused = new Promise((resolve) => { hydrationYielded = resolve; });
  const journal = {
    ...reader,
    forEachRetainedAsync(anchorDate, onRecord) {
      return reader.forEachRetainedAsync(anchorDate, onRecord, {
        yieldEvery: 1,
        yieldToMain: () => {
          if (paused) return Promise.resolve();
          paused = true;
          return new Promise((resolve) => {
            releaseHydration = resolve;
            hydrationYielded();
          });
        },
      });
    },
  };
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await hydrationPaused;
  assert.equal(runtime.record(event, identity), true, "the replay reaches the race window");
  releaseHydration();
  await runtime.whenReady();
  assert.equal(runtime.query("today").days[0].rows[0].metrics.toolCalls, 1);

  runtime.dispose();
  const rebuilt = fixture(t, { root, now });
  rebuilt.runtime.start();
  await rebuilt.runtime.whenReady();
  assert.equal(rebuilt.runtime.query("today").days[0].rows[0].metrics.toolCalls, 1);
});

test("hydration yields during the read without losing a later live event", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-read-yield-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const diskRecord = writer.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    Array.from({ length: 600 }, () => JSON.stringify(diskRecord)).join("\n") + "\n"
  );

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader, 100);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  assert.equal(runtime.record({
    occurredAt: now + 1,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), true);
  pause.release();
  await runtime.whenReady();

  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 601);
  runtime.dispose();
});

test("dispose during the hydration read keeps a complete aggregate on the same object", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-partial-dispose-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const journal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  seedSplitAggregateJournal(store, journal, 5, 7);

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader, 100);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  const count = () => runtime.query("today").days[0].rows.reduce(
    (sum, row) => sum + row.metrics.activityEvents,
    0
  );
  runtime.start();
  const firstReady = runtime.whenReady();
  await pause.pausedAt;
  assert.equal(runtime.record({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), true);
  runtime.dispose();
  assert.equal(count(), 6);
  assert.equal(readDailyActivityCount(store, "2026-08-30"), 6);

  assert.equal(runtime.start(), true);
  assert.equal(count(), 6);
  pause.release();
  await firstReady;
  await runtime.whenReady();
  assert.equal(count(), 8);
  runtime.dispose();
});

test("a final hydration flush failure keeps the complete in-memory projection retryable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-final-flush-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const actualStore = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  actualStore.initialize();
  let failDailyWrite = true;
  const store = {
    ...actualStore,
    writeJsonAtomic(filePath, value) {
      if (failDailyWrite && path.basename(filePath).startsWith("daily-")) {
        failDailyWrite = false;
        const error = new Error("injected daily write failure");
        error.code = "EIO";
        throw error;
      }
      return actualStore.writeJsonAtomic(filePath, value);
    },
  };
  const journal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const diskRecord = journal.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    Array.from({ length: 600 }, () => JSON.stringify(diskRecord)).join("\n") + "\n"
  );
  const warnings = [];
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });

  runtime.start();
  await runtime.whenReady();
  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 600);
  assert.ok(warnings.some((args) => args.includes("EIO")));
  assert.equal(fs.existsSync(store.childPath("daily-2026-08.json")), false);

  runtime.flush();
  assert.equal(readDailyActivityCount(store, "2026-08-30"), 600);
  runtime.dispose();
});

test("hydration overflow retries without dropping live events or a partial projection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-overflow-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const actualJournal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const diskRecord = actualJournal.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    Array.from({ length: 500 }, () => JSON.stringify(diskRecord)).join("\n") + "\n"
  );

  let loadCalls = 0;
  let releaseFirstRead;
  let announceFirstRead;
  let releaseRetryRead;
  let announceRetryRead;
  const firstReadPaused = new Promise((resolve) => { announceFirstRead = resolve; });
  const retryReadPaused = new Promise((resolve) => { announceRetryRead = resolve; });
  const journal = {
    ...actualJournal,
    forEachRetainedAsync(anchorDate, onRecord) {
      loadCalls += 1;
      const call = loadCalls;
      let paused = false;
      return actualJournal.forEachRetainedAsync(anchorDate, onRecord, {
        yieldEvery: 1,
        yieldToMain: () => {
          if (paused) return Promise.resolve();
          paused = true;
          if (call === 1) {
            return new Promise((resolve) => {
              releaseFirstRead = resolve;
              announceFirstRead();
            });
          }
          return new Promise((resolve) => {
            releaseRetryRead = resolve;
            announceRetryRead();
          });
        },
      });
    },
  };
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  const ready = runtime.whenReady();
  await firstReadPaused;
  for (let index = 0; index < 4097; index += 1) {
    assert.equal(runtime.record({
      occurredAt: now + index + 1,
      agentId: "codex",
      scope: "local",
      metrics: ["activity"],
    }), true);
  }
  releaseFirstRead();
  await retryReadPaused;

  runtime.flush();
  assert.equal(fs.existsSync(store.childPath("daily-2026-08.json")), true);
  assert.equal(readDailyActivityCount(store, "2026-08-30"), 4097);
  releaseRetryRead();
  await ready;
  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 4597);
  runtime.dispose();
});

test("issue #1141: an overflow retry that hits the bound still keeps the live events", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-overflow-bound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const actualJournal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const diskRecord = actualJournal.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    Array.from({ length: 500 }, () => JSON.stringify(diskRecord)).join("\n") + "\n"
  );

  let loadCalls = 0;
  let releaseFirstRead;
  let announceFirstRead;
  const firstReadPaused = new Promise((resolve) => { announceFirstRead = resolve; });
  const journal = {
    ...actualJournal,
    forEachRetainedAsync(anchorDate, onRecord) {
      loadCalls += 1;
      if (loadCalls === 1) {
        let paused = false;
        return actualJournal.forEachRetainedAsync(anchorDate, onRecord, {
          yieldEvery: 1,
          yieldToMain: () => {
            if (paused) return Promise.resolve();
            paused = true;
            return new Promise((resolve) => {
              releaseFirstRead = resolve;
              announceFirstRead();
            });
          },
        });
      }
      return actualJournal.forEachRetainedAsync(anchorDate, onRecord, { maxRecords: 10 });
    },
  };
  const warnings = [];
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });
  runtime.start();
  const ready = runtime.whenReady();
  await firstReadPaused;
  for (let index = 0; index < 4097; index += 1) {
    assert.equal(runtime.record({
      occurredAt: now + index + 1,
      agentId: "codex",
      scope: "local",
      metrics: ["activity"],
    }), true);
  }
  releaseFirstRead();
  await ready;

  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 4097);
  assert.equal(readDailyActivityCount(store, "2026-08-30"), 4097);
  assert.equal(
    warnings.some((args) => args.some((value) => String(value).includes("exceeded its safety bound"))),
    true
  );
  runtime.dispose();
});

test("a failed clear during hydration never overwrites the last complete aggregate", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-clear-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const actualStore = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  actualStore.initialize();
  const writer = createRecapJournal({ store: actualStore, now: () => now, getTimeZone: () => "UTC" });
  const diskRecord = writer.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  const records = Array.from({ length: 600 }, () => ({ ...diskRecord }));
  fs.writeFileSync(
    actualStore.childPath("events", "2026-08-30.jsonl"),
    records.map((recordValue) => JSON.stringify(recordValue)).join("\n") + "\n"
  );
  const published = createRecapAggregate({ store: actualStore, flushDelayMs: 100000 });
  published.load();
  published.replaceDates(["2026-08-30"], records);
  published.flush();
  published.resetMemory();
  assert.equal(readDailyActivityCount(actualStore, "2026-08-30"), 600);

  const store = {
    ...actualStore,
    clear() {
      const error = new Error("injected clear failure");
      error.code = "EACCES";
      throw error;
    },
  };
  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader, 100);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: () => {},
  });
  runtime.start();
  const ready = runtime.whenReady();
  await pause.pausedAt;
  assert.equal(runtime.clear(), false);
  pause.release();
  await ready;
  assert.equal(readDailyActivityCount(actualStore, "2026-08-30"), 600);
  runtime.dispose();
});

test("dispose aborts a yielded hydration before another file-read batch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-dispose-hydration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const record = writer.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    Array.from({ length: 600 }, () => JSON.stringify(record)).join("\n") + "\n"
  );
  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  let release;
  let announceYield;
  let yieldCalls = 0;
  const yielded = new Promise((resolve) => { announceYield = resolve; });
  const journal = {
    ...reader,
    forEachRetainedAsync(anchorDate, onRecord) {
      return reader.forEachRetainedAsync(anchorDate, onRecord, {
        yieldEvery: 100,
        yieldToMain: () => {
          yieldCalls += 1;
          if (yieldCalls > 1) return Promise.resolve();
          return new Promise((resolve) => {
            release = resolve;
            announceYield();
          });
        },
      });
    },
  };
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  const ready = runtime.whenReady();
  await yielded;
  runtime.dispose();
  release();
  await ready;
  assert.equal(yieldCalls, 1);
});

test("disable closes coverage and rejects events; clear rotates all local recap data", (t) => {
  const f = fixture(t);
  f.runtime.start();
  const event = {
    occurredAt: Date.UTC(2026, 7, 29, 10),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  };
  assert.equal(f.runtime.record(event), true);
  assert.equal(f.runtime.setEnabled(false), true);
  assert.equal(f.runtime.record({ ...event, occurredAt: event.occurredAt + 1 }), false);
  assert.equal(f.runtime.query("today").recordingEnabled, false);
  f.runtime.clear();
  assert.equal(f.runtime.query("today").days[0].rows.length, 0);
  assert.equal(f.runtime.query("today").recordingEnabled, false);
  f.runtime.setEnabled(true);
  assert.equal(f.runtime.record({ ...event, occurredAt: event.occurredAt + 2 }), true);
});

test("clear preserves an explicit in-process enable after startup authority was lost", (t) => {
  const f = fixture(t, { enabled: false });
  f.runtime.start();
  assert.equal(f.runtime.query("today").recordingEnabled, false);

  assert.equal(f.runtime.setEnabled(true), true);
  assert.equal(f.runtime.query("today").recordingEnabled, true);
  assert.equal(f.runtime.clear(), true);
  assert.equal(f.runtime.query("today").recordingEnabled, true);
});

test("period ranges are bounded to current civil period", () => {
  assert.deepEqual(rangeForPeriod("today", "2026-08-30"), {
    startDate: "2026-08-30", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("week", "2026-08-30"), {
    startDate: "2026-08-24", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("month", "2026-08-30"), {
    startDate: "2026-08-01", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("year", "2026-08-30"), {
    startDate: "2026-01-01", endDate: "2026-08-30",
  });
});

test("current-hour progress follows real elapsed minutes across full and half-hour folds", () => {
  const losAngelesNow = Date.UTC(2026, 10, 1, 9, 30); // second 01:30, PST
  const losAngelesParts = getZonedDateTimeParts(losAngelesNow, "America/Los_Angeles");
  assert.equal(elapsedMinutesInCurrentLocalHour(
    losAngelesNow,
    "America/Los_Angeles",
    losAngelesParts,
    120
  ), 90);

  const lordHoweNow = Date.UTC(2026, 3, 4, 15, 15); // second 01:45, +10:30
  const lordHoweParts = getZonedDateTimeParts(lordHoweNow, "Australia/Lord_Howe");
  assert.equal(elapsedMinutesInCurrentLocalHour(
    lordHoweNow,
    "Australia/Lord_Howe",
    lordHoweParts,
    90
  ), 75);
});

test("runtime freezes start progress on the real fold timeline", (t) => {
  const f = fixture(t, {
    now: Date.UTC(2026, 10, 1, 9, 30), // second 01:30, PST
    timeZone: "America/Los_Angeles",
  });
  f.runtime.start();
  const view = f.runtime.query("today");
  assert.equal(view.recordingStartedLocalHour, 1);
  assert.equal(view.recordingStartedLocalMinute, 30);
  assert.equal(view.recordingStartedHourElapsedMinutes, 90);
});

test("runtime fails quiet when optional storage is unavailable and can recover by explicit clear", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-unavailable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "meta.json"), "{broken");
  const f = fixture(t, { root });
  assert.doesNotThrow(() => f.runtime.start());
  assert.equal(f.runtime.query("today").status, "unavailable");
  assert.equal(f.runtime.record({
    occurredAt: Date.UTC(2026, 7, 29, 10),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), false);
  assert.equal(f.runtime.clear(), true);
  assert.equal(f.runtime.query("today").status, "ready");
  assert.equal(f.runtime.query("today").recordingEnabled, true);
});

test("runtime retries transient storage failures with bounded backoff and one live timer", () => {
  const timers = createManualTimers();
  let initializeCalls = 0;
  let changeNotifications = 0;
  const expectedDelays = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 30000];
  const transient = () => Object.assign(new Error("sharing violation"), {
    code: "RECAP_PRIVATE_ACL_FAILED",
    stage: "open",
    cause: { win32Code: 32 },
  });
  const dependencies = createStorageRetryDependencies(() => {
    initializeCalls += 1;
    if (initializeCalls < 10) throw transient();
  });
  const runtime = createRecapRuntime({
    ...dependencies,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logWarn: () => {},
    onRecorded: () => { changeNotifications += 1; },
  });

  assert.equal(runtime.query("today").status, "unavailable");
  assert.deepEqual(timers.scheduled.map((timer) => timer.delay), [100]);
  assert.equal(timers.scheduled[0].unrefCalled, true);
  assert.equal(runtime.query("today").status, "unavailable");
  assert.equal(timers.scheduled.length, 1, "an unavailable query must not double-schedule recovery");

  for (let index = 0; index < expectedDelays.length; index += 1) {
    assert.equal(timers.scheduled.length, index + 1);
    assert.equal(timers.scheduled[index].delay, expectedDelays[index]);
    assert.equal(timers.scheduled[index].unrefCalled, true);
    timers.scheduled[index].callback();
  }

  assert.deepEqual(timers.scheduled.map((timer) => timer.delay), expectedDelays);
  assert.equal(initializeCalls, 10);
  assert.equal(changeNotifications, 1);
  assert.equal(runtime.query("today").status, "ready");
});

test("runtime recovery restarts midnight coverage and hydrates retained journal records", async () => {
  const timers = createManualTimers();
  let initializeCalls = 0;
  let coverageStarts = 0;
  let hydrationLoads = 0;
  const replacedDates = [];
  const projectedRows = [];
  const retained = {
    agentId: "codex",
    scope: "local",
    localDate: "2026-08-29",
    localHour: 8,
    timeZoneId: "UTC",
    metrics: ["activity", "tool-call"],
    support: { sessionsStarted: false, turnsCompleted: true, toolCalls: true },
  };
  const dependencies = createStorageRetryDependencies(() => {
    initializeCalls += 1;
    if (initializeCalls === 1) {
      throw Object.assign(new Error("sharing violation"), {
        code: "RECAP_PRIVATE_ACL_FAILED",
        stage: "open",
        cause: { win32Code: 32 },
      });
    }
  });
  dependencies.coverage.start = () => { coverageStarts += 1; };
  dependencies.journal.forEachRetainedAsync = async (anchorDate, onRecord) => {
    hydrationLoads += 1;
    onRecord(retained);
    return { dates: ["2026-08-29"], truncated: false, restoredDedupeKeys: new Map() };
  };
  dependencies.aggregate.replaceDays = (dates, projection) => {
    replacedDates.push(...dates);
    const day = projection.getDay("2026-08-29");
    if (day) projectedRows.push(...Object.values(day.rows));
  };
  const runtime = createRecapRuntime({
    ...dependencies,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logWarn: () => {},
  });

  assert.equal(runtime.start(), false);
  assert.deepEqual(timers.scheduled.map((timer) => timer.delay), [100]);
  timers.scheduled[0].callback();
  await runtime.whenReady();

  assert.equal(initializeCalls, 2);
  assert.equal(coverageStarts, 1);
  assert.equal(hydrationLoads, 1);
  assert.deepEqual(replacedDates, ["2026-08-29"]);
  assert.equal(projectedRows.length, 1);
  assert.equal(projectedRows[0].metrics.toolCalls, 1);
  assert.equal(timers.scheduled.length, 2, "storage recovery must re-arm the midnight timer");
  assert.ok(timers.scheduled[1].delay > 1000);
  runtime.dispose();
  assert.ok(timers.cleared.includes(timers.scheduled[1]));
});

test("runtime dispose cancels storage recovery and invalidates a stale retry callback", () => {
  const timers = createManualTimers();
  let initializeCalls = 0;
  const dependencies = createStorageRetryDependencies(() => {
    initializeCalls += 1;
    throw Object.assign(new Error("lock violation"), {
      code: "RECAP_PRIVATE_ACL_FAILED",
      stage: "open",
      cause: { win32Code: 33 },
    });
  });
  const runtime = createRecapRuntime({
    ...dependencies,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logWarn: () => {},
  });

  assert.equal(runtime.query("today").status, "unavailable");
  const pending = timers.scheduled[0];
  runtime.dispose();
  assert.deepEqual(timers.cleared, [pending]);
  pending.callback();
  assert.equal(initializeCalls, 1);
  assert.equal(timers.scheduled.length, 1);
});

test("runtime automatically recovers after a transient Windows sharing violation", {
  skip: process.platform !== "win32",
  timeout: 10000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-runtime-sharing-"));
  const root = path.join(parent, "recap-v1");
  fs.mkdirSync(root);
  const fixturePath = path.join(__dirname, "fixtures", "recap-private-permissions-share-holder.js");
  const child = spawn(process.execPath, [fixturePath, root, "90"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let changeNotifications = 0;
  const runtime = createRecapRuntime({
    root,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    logWarn: () => {},
    onRecorded: () => { changeNotifications += 1; },
  });
  t.after(() => {
    runtime.dispose();
    if (child.exitCode === null) child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await waitForChildLine(child, "READY");
  const moved = path.join(parent, "moved-recap-v1");
  assert.throws(() => fs.renameSync(root, moved), (error) =>
    error && ["EBUSY", "EPERM"].includes(error.code));

  assert.equal(runtime.start(), false);
  assert.equal(runtime.query("today").status, "unavailable");
  assert.equal(runtime.query("today").reason, "RECAP_PRIVATE_ACL_FAILED");
  assert.equal(fs.existsSync(path.join(root, "meta.json")), false);
  assert.equal(fs.existsSync(path.join(root, "events")), false);
  assert.equal(changeNotifications, 0);
  assert.equal(await waitForChildExit(child), 0);
  await waitFor(() => runtime.query("today").status === "ready");
  assert.equal(runtime.query("today").recordingEnabled, true);
  assert.equal(changeNotifications, 1);

  assert.equal(runtime.record({
    occurredAt: Date.UTC(2026, 7, 29, 10),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), true);
  assert.equal(changeNotifications, 2);
  const view = runtime.query("today");
  assert.equal(view.days[0].rows[0].metrics.activityEvents, 1);
});

test("clear recovery keeps one power lifecycle wiring and restarts midnight coverage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-recovery-wiring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "meta.json"), "{broken");
  const powerMonitor = new EventEmitter();
  const runtime = createRecapRuntime({
    root,
    powerMonitor,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  assert.equal(runtime.start(), false);
  assert.equal(powerMonitor.listenerCount("suspend"), 1);
  assert.equal(runtime.clear(), true);
  assert.equal(runtime.query("today").status, "ready");
  assert.equal(powerMonitor.listenerCount("suspend"), 1);
  powerMonitor.emit("suspend");
  powerMonitor.emit("resume");
  assert.equal(powerMonitor.listenerCount("resume"), 1);
  runtime.dispose();
  assert.equal(powerMonitor.listenerCount("suspend"), 0);
});

test("runtime rejects same-day events beyond the bounded clock-skew allowance", (t) => {
  const f = fixture(t);
  f.runtime.start();
  const tooFar = Date.UTC(2026, 7, 29, 10) + MAX_FUTURE_SKEW_MS + 1;
  assert.equal(f.runtime.record({
    occurredAt: tooFar,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), false);
});

test("a non-directory recap root cannot interrupt the rest of application startup", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-root-file-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "recap-v1");
  fs.writeFileSync(root, "not-a-directory");
  const powerMonitor = new EventEmitter();
  const runtime = createRecapRuntime({
    root,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    powerMonitor,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  assert.doesNotThrow(() => runtime.start());
  assert.equal(runtime.query("today").status, "unavailable");
  assert.doesNotThrow(() => powerMonitor.emit("resume"));
  assert.doesNotThrow(() => powerMonitor.emit("unlock-screen"));
  assert.doesNotThrow(() => powerMonitor.emit("suspend"));
});

test("journal-frozen metric support survives a real restart rebuild", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-policy-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const journal = createRecapJournal({ store, getTimeZone: () => "UTC" });
  const historical = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, 8),
    agentId: "antigravity-cli",
    scope: "local",
    metrics: ["activity", "tool-call"],
  });
  // Simulate a ticket written by an older policy that had a reliable tool
  // boundary. The current policy says unsupported, but restart must preserve
  // the historical support contract frozen on the ticket.
  historical.support.toolCalls = true;
  assert.equal(journal.append(historical), true);

  const runtime = createRecapRuntime({
    root,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await runtime.whenReady();
  const row = runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.metrics.activityEvents, 1);
});

test("an overbound journal cannot postpone the aggregate privacy allowlist rewrite", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-privacy-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 29, 10);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const hash = `hmac:${"a".repeat(43)}`;
  const filePath = store.childPath("daily-2026-08.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    month: "2026-08",
    days: {
      "2026-08-29": {
        rows: {
          old: {
            agentId: "codex",
            scope: "remote",
            scopeKeyHash: hash,
            metrics: { sessionsStarted: null, turnsCompleted: 1, toolCalls: 1, activityEvents: 1 },
            support: { sessionsStarted: false, turnsCompleted: true, toolCalls: true },
            sessionsStartedPartial: true,
            hours: Array(24).fill(0),
          },
        },
        hourCapacities: Array(24).fill(60),
        timeZones: [{ id: "UTC", utcOffsetMinutes: 0 }],
      },
    },
  }));
  const actualJournal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const journal = {
    ...actualJournal,
    async forEachRetainedAsync(anchorDate) {
      return { dates: actualJournal.retainedDates(anchorDate), truncated: true };
    },
  };
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: () => {},
  });
  runtime.start();
  await runtime.whenReady();
  const disk = fs.readFileSync(filePath, "utf8");
  assert.match(disk, /"schemaVersion":2/);
  assert.equal(disk.includes("scopeKeyHash"), false);
  assert.equal(disk.includes("timeZone"), false);
});

test("issue #1141: startup reconciliation keeps working past the old line bound", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-line-bound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const journal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const recordValue = journal.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    `${JSON.stringify(recordValue)}\n${"\n".repeat(100000)}`
  );

  const warnings = [];
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });
  runtime.start();
  await runtime.whenReady();

  const row = runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.metrics.activityEvents, 1);
  assert.equal(
    warnings.some((args) => args.some((value) => String(value).includes("exceeded its safety bound"))),
    false
  );
  runtime.dispose();
});

test("issue #1141: a replayed live event defers to the disk copy during hydration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-disk-wins-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 9);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  const diskEvent = {
    occurredAt: Date.UTC(2026, 7, 30, 3),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  assert.equal(writer.append(writer.buildRecord(diskEvent, identity)), true);

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  assert.equal(runtime.record({ ...diskEvent, occurredAt: Date.UTC(2026, 7, 30, 8) }, identity), true);
  pause.release();
  await runtime.whenReady();

  const row = runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.hours[3], 1);
  assert.equal(row.hours[8], 0);
  runtime.dispose();

  const restarted = createRecapRuntime({
    root,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restarted.start();
  await restarted.whenReady();
  const after = restarted.query("today").days[0].rows[0];
  assert.equal(after.metrics.toolCalls, 1);
  assert.equal(after.hours[3], 1);
  assert.equal(after.hours[8], 0);
  restarted.dispose();
});

test("issue #1141: a live replay older than the disk copy is not counted twice", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-earlier-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 9);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  const diskEvent = {
    occurredAt: Date.UTC(2026, 7, 30, 3),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  assert.equal(writer.append(writer.buildRecord(diskEvent, identity)), true);

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  // The replay arrives on an earlier day than the disk ticket. This hydration
  // keeps the disk copy; a later restart may assign it to the earlier day
  // because that file is read first. Only the total is pinned here.
  assert.equal(runtime.record({ ...diskEvent, occurredAt: Date.UTC(2026, 7, 29, 8) }, identity), true);
  pause.release();
  await runtime.whenReady();

  const month = runtime.query("month");
  const total = month.days.reduce(
    (sum, day) => sum + day.rows.reduce((rowSum, row) => rowSum + (row.metrics.toolCalls || 0), 0),
    0
  );
  assert.equal(total, 1);
  runtime.dispose();
});

test("issue #1141: a new day recorded during hydration is counted once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-midnight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 7, 30, 23, 59, 59, 900);
  const store = createRecapStore({ root, now: () => clock, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => clock, getTimeZone: () => "UTC" });
  assert.equal(writer.append(writer.buildRecord({
    occurredAt: Date.UTC(2026, 7, 30, 12),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  })), true);

  const reader = createRecapJournal({ store, now: () => clock, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => clock,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  clock = Date.UTC(2026, 7, 31, 0, 0, 0, 100);
  assert.equal(runtime.record({
    occurredAt: clock,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), true);
  pause.release();
  await runtime.whenReady();

  const view = runtime.query("today");
  assert.equal(view.days[0].localDate, "2026-08-31");
  const activity = view.days[0].rows.reduce((sum, row) => sum + row.metrics.activityEvents, 0);
  assert.equal(activity, 1);
  runtime.dispose();
});

test("issue #1141: the previous aggregate stays visible until the projection is swapped in", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-no-half-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const journal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  seedSplitAggregateJournal(store, journal, 5, 7);

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 5);
  pause.release();
  await runtime.whenReady();
  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 7);
  runtime.dispose();
});

test("issue #1141: a failed swap rolls back to the last complete aggregate", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-swap-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 1);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const journal = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  seedSplitAggregateJournal(store, journal, 5, 7);

  const actualAggregate = createRecapAggregate({ store, flushDelayMs: 100000, logWarn: () => {} });
  actualAggregate.load();
  let failed = false;
  const aggregate = {
    ...actualAggregate,
    replaceDays(dates, projection) {
      actualAggregate.replaceDays(dates, projection);
      if (!failed) {
        failed = true;
        throw Object.assign(new Error("injected replace failure"), { code: "EIO" });
      }
    },
  };
  const warnings = [];
  const runtime = createRecapRuntime({
    store,
    journal,
    aggregate,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: (...args) => warnings.push(args),
  });
  runtime.start();
  await runtime.whenReady();

  assert.equal(runtime.query("today").days[0].rows[0].metrics.activityEvents, 5);
  assert.equal(readDailyActivityCount(store, "2026-08-30"), 5);
  assert.equal(
    warnings.some((args) => args.some((value) => String(value).includes("reconciliation failed"))),
    true
  );
  runtime.dispose();
});

test("issue #1141: a keyed replay across midnight is counted once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-keyed-midnight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 7, 30, 23, 59, 59, 900);
  const store = createRecapStore({ root, now: () => clock, getTimeZone: () => "UTC" });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => clock, getTimeZone: () => "UTC" });
  const event = {
    occurredAt: Date.UTC(2026, 7, 30, 12),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  assert.equal(writer.append(writer.buildRecord(event, identity)), true);

  const reader = createRecapJournal({ store, now: () => clock, getTimeZone: () => "UTC" });
  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => clock,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  clock = Date.UTC(2026, 7, 31, 0, 0, 0, 100);
  assert.equal(runtime.record({ ...event, occurredAt: clock }, identity), true);
  pause.release();
  await runtime.whenReady();

  assert.deepEqual(toolCallTotals(runtime), { "2026-08-30": 1 });
  assert.equal(readMonthToolCallTotal(store), 1);
  runtime.dispose();

  const restarted = createRecapRuntime({
    root,
    now: () => clock,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restarted.start();
  await restarted.whenReady();
  assert.deepEqual(toolCallTotals(restarted), { "2026-08-30": 1 });
  restarted.dispose();
});

test("issue #1141: a permanent timezone move to the previous day is counted once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-tz-back-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 0, 5);
  let timeZone = "UTC";
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => timeZone });
  store.initialize();
  const writer = createRecapJournal({ store, now: () => now, getTimeZone: () => timeZone });
  const event = {
    occurredAt: Date.UTC(2026, 7, 30, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  const diskRecord = writer.buildRecord(event, identity);
  fs.writeFileSync(store.childPath("events", "2026-08-30.jsonl"), `${JSON.stringify(diskRecord)}\n`);
  const published = createRecapAggregate({ store, flushDelayMs: 100000 });
  published.apply(diskRecord, { flush: true });
  published.resetMemory();

  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => timeZone });
  let reads = 0;
  let release;
  let announce;
  let paused = false;
  const pausedAt = new Promise((resolve) => { announce = resolve; });
  const journal = {
    ...reader,
    forEachRetainedAsync(anchorDate, onRecord) {
      reads += 1;
      return reader.forEachRetainedAsync(anchorDate, onRecord, {
        yieldEvery: 1,
        yieldToMain: () => {
          if (paused) return Promise.resolve();
          paused = true;
          return new Promise((resolve) => {
            release = resolve;
            announce();
          });
        },
      });
    },
  };
  const runtime = createRecapRuntime({
    store,
    journal,
    now: () => now,
    getTimeZone: () => timeZone,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pausedAt;
  // UTC-7/8 takes the same instant back to the previous local day.
  timeZone = "America/Los_Angeles";
  assert.equal(runtime.record({ ...event, occurredAt: now }, identity), true);
  release();
  await runtime.whenReady();

  assert.equal(reads, 1);
  assert.deepEqual(toolCallTotals(runtime, "2026-08-31"), { "2026-08-30": 1 });
  assert.equal(readMonthToolCallTotal(store), 1);
  runtime.dispose();
});

test("issue #1141: the date filter still guards a timezone flip", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-tz-flip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 10);
  let timeZone = "UTC";
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => timeZone });
  store.initialize();
  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => timeZone });
  const diskRecord = reader.buildRecord({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(store.childPath("events", "2026-08-30.jsonl"), `${JSON.stringify(diskRecord)}\n`);

  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => timeZone,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  // UTC+14 pushes the same instant into the next local day.
  timeZone = "Pacific/Kiritimati";
  assert.equal(runtime.record({
    occurredAt: now,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), true);
  timeZone = "UTC";
  pause.release();
  await runtime.whenReady();

  const nextDay = runtime.query("today", { anchorDate: "2026-08-31" }).days[0];
  const activity = nextDay.rows.reduce((sum, row) => sum + row.metrics.activityEvents, 0);
  assert.equal(activity, 1);
  runtime.dispose();
});

test("issue #1141: a live replay before its disk copy is counted once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-live-before-disk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 30, 10);
  const store = createRecapStore({ root, now: () => now, getTimeZone: () => "UTC" });
  store.initialize();
  const reader = createRecapJournal({ store, now: () => now, getTimeZone: () => "UTC" });
  const event = {
    occurredAt: Date.UTC(2026, 7, 30, 3),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  };
  const identity = { sessionId: "s", dedupeId: "tool-1" };
  const filler = reader.buildRecord({ ...event, metrics: ["activity"] });
  const keyed = reader.buildRecord(event, identity);
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    [filler, keyed].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );

  const pause = pausedRetainedJournal(reader);
  const runtime = createRecapRuntime({
    store,
    journal: pause.journal,
    now: () => now,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  await pause.pausedAt;
  assert.equal(runtime.record({ ...event, occurredAt: Date.UTC(2026, 7, 30, 8) }, identity), true);
  pause.release();
  await runtime.whenReady();

  const row = runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.activityEvents, 2);
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.hours[3], 2);
  assert.equal(row.hours[8], 0);
  assert.equal(runtime.record(event, identity), false);
  runtime.dispose();
});
