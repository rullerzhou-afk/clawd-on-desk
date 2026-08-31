"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapJournal } = require("../src/recap-journal");
const { createRecapStore } = require("../src/recap-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const warnings = [];
  const journal = createRecapJournal({
    store,
    getTimeZone: () => "Asia/Singapore",
    logWarn: (...args) => warnings.push(args),
  });
  return { journal, root, store, warnings };
}

test("journal stores only frozen allowlisted data and irreversible identity keys", (t) => {
  const { journal, store } = fixture(t);
  const occurredAt = Date.UTC(2026, 7, 29, 18, 30);
  const record = journal.buildRecord({
    occurredAt,
    agentId: "codex",
    scope: "remote",
    metrics: ["activity", "tool-call"],
  }, {
    scopeId: "private-profile",
    sessionId: "private-session",
    dedupeId: "private-tool-id",
  });
  assert.equal(journal.append(record), true);
  assert.equal(record.localDate, "2026-08-30");
  assert.equal(record.localHour, 2);
  const disk = fs.readFileSync(store.childPath("events", "2026-08-30.jsonl"), "utf8");
  for (const secret of ["private-profile", "private-session", "private-tool-id"]) {
    assert.doesNotMatch(disk, new RegExp(secret));
  }
  for (const forbidden of ["prompt", "command", "cwd", "toolName", "eventName"]) {
    assert.equal(Object.hasOwn(record, forbidden), false);
  }
});

test("journal dedupes stable upstream identities and survives a corrupt tail", (t) => {
  const { journal, store, warnings } = fixture(t);
  const event = {
    occurredAt: Date.UTC(2026, 7, 30, 1),
    agentId: "claude-code",
    scope: "local",
    metrics: ["activity", "turn-complete"],
  };
  const identity = { sessionId: "s1", dedupeId: "turn-1" };
  const first = journal.buildRecord(event, identity);
  assert.equal(journal.append(first), true);
  assert.equal(journal.append(first), false);

  const filePath = store.childPath("events", first.localDate + ".jsonl");
  fs.appendFileSync(filePath, "{broken-tail");
  const second = journal.buildRecord({ ...event, occurredAt: event.occurredAt + 60000 }, {
    sessionId: "s1",
    dedupeId: "turn-2",
  });
  assert.equal(journal.append(second), true);
  const loaded = journal.readDate(first.localDate);
  assert.equal(loaded.length, 2);
  assert.ok(warnings.length >= 1);
});

test("journal keeps current day plus the previous thirteen local dates", (t) => {
  const { journal, store } = fixture(t);
  for (const date of ["2026-08-15", "2026-08-16", "2026-08-29"]) {
    fs.writeFileSync(store.childPath("events", `${date}.jsonl`), "");
  }
  journal.prune("2026-08-29");
  assert.equal(fs.existsSync(store.childPath("events", "2026-08-15.jsonl")), false);
  assert.equal(fs.existsSync(store.childPath("events", "2026-08-16.jsonl")), true);
  assert.equal(journal.retainedDates("2026-08-29").length, 14);
  assert.equal(journal.retainedDates("2026-08-29")[0], "2026-08-16");
});

test("journal prunes in-memory dedupe keys with the same fourteen-day window", (t) => {
  const { journal } = fixture(t);
  const identity = { sessionId: "stable-session", dedupeId: "reused-upstream-id" };
  const old = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 1, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, identity);
  const retained = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 3, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, { sessionId: "other-session", dedupeId: "still-retained" });
  assert.equal(journal.append(old), true);
  assert.equal(journal.append(retained), true);
  assert.equal(journal.append(old), false);

  journal.prune("2026-08-15");
  const reused = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 15, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, identity);
  assert.equal(journal.append(reused), true);
  assert.equal(journal.append(retained), false, "a retained dedupe key must remain live");
});

test("async retained restore snapshots files and yields between bounded record batches", async (t) => {
  const { journal, store } = fixture(t);
  const localDate = "2026-08-30";
  const record = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, 18),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", `${localDate}.jsonl`),
    Array.from({ length: 1200 }, () => JSON.stringify(record)).join("\n") + "\n"
  );
  let yields = 0;
  const restored = await journal.loadRetainedAsync(localDate, {
    yieldEvery: 100,
    yieldToMain: async () => { yields += 1; },
  });
  assert.equal(restored.records.length, 1200);
  assert.ok(yields >= 12);
});

test("hydration never ages a newer live dedupe key back to an older disk date", async (t) => {
  const { journal, store } = fixture(t);
  const identity = { sessionId: "stable-session", dedupeId: "stable-tool" };
  const old = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 1, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, identity);
  fs.writeFileSync(store.childPath("events", "2026-08-01.jsonl"), `${JSON.stringify(old)}\n`);

  let release;
  let announceYield;
  let paused = false;
  const yielded = new Promise((resolve) => { announceYield = resolve; });
  const loading = journal.loadRetainedAsync("2026-08-14", {
    yieldToMain: () => {
      if (paused) return Promise.resolve();
      paused = true;
      return new Promise((resolve) => {
        release = resolve;
        announceYield();
      });
    },
  });
  await yielded;
  const live = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 14, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, identity);
  assert.equal(journal.append(live), true);
  release();
  await loading;

  journal.prune("2026-08-15");
  const replay = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 15, 0),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, identity);
  assert.equal(journal.append(replay), false);
});

test("async retained restore refuses an unbounded in-memory rebuild", async (t) => {
  const { journal, store } = fixture(t);
  fs.writeFileSync(store.childPath("events", "2026-08-30.jsonl"), "x".repeat(256));
  const restored = await journal.loadRetainedAsync("2026-08-30", { maxBytes: 128 });
  assert.equal(restored.truncated, true);
  assert.deepStrictEqual(restored.records, []);
});

test("retained restore dedupes a replayed stable identity on disk", async (t) => {
  const { journal, store } = fixture(t);
  const record = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, 18),
    agentId: "codex",
    scope: "local",
    metrics: ["activity", "tool-call"],
  }, { sessionId: "s", dedupeId: "tool-1" });
  fs.writeFileSync(
    store.childPath("events", "2026-08-30.jsonl"),
    `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`
  );
  const restored = await journal.loadRetainedAsync("2026-08-30");
  assert.equal(restored.records.length, 1);
  assert.equal(journal.readDate("2026-08-30").length, 1);
});

test("retained restore bounds invalid input lines and warning volume", async (t) => {
  const { root, store } = fixture(t);
  const warnings = [];
  const journal = createRecapJournal({
    store,
    getTimeZone: () => "UTC",
    logWarn: (...args) => warnings.push(args),
  });
  fs.writeFileSync(store.childPath("events", "2026-08-30.jsonl"), "x\n".repeat(200));
  const restored = await journal.loadRetainedAsync("2026-08-30", {
    maxRecords: 100,
    yieldEvery: 10,
    yieldToMain: async () => {},
  });
  assert.equal(restored.truncated, true);
  assert.deepStrictEqual(restored.records, []);
  assert.ok(warnings.length <= 1);
  assert.ok(fs.existsSync(root));
});

test("retained restore also bounds blank-line floods", async (t) => {
  const { journal, store } = fixture(t);
  fs.writeFileSync(store.childPath("events", "2026-08-30.jsonl"), "\n".repeat(200));
  const restored = await journal.loadRetainedAsync("2026-08-30", {
    maxRecords: 100,
    yieldEvery: 10,
    yieldToMain: async () => {},
  });
  assert.equal(restored.truncated, true);
});

test("retained restore holds no file handle across a yield and aborts after reset", async (t) => {
  const { journal, store } = fixture(t);
  const localDate = "2026-08-30";
  const record = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, 18),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  });
  fs.writeFileSync(
    store.childPath("events", `${localDate}.jsonl`),
    Array.from({ length: 600 }, () => JSON.stringify(record)).join("\n") + "\n"
  );
  let release;
  let announceYield;
  let paused = false;
  const yielded = new Promise((resolve) => { announceYield = resolve; });
  const loading = journal.loadRetainedAsync(localDate, {
    yieldEvery: 100,
    yieldToMain: () => {
      if (paused) return Promise.resolve();
      paused = true;
      return new Promise((resolve) => {
        release = resolve;
        announceYield();
      });
    },
  });
  await yielded;
  journal.resetMemory();
  assert.doesNotThrow(() => store.clear());
  release();
  const result = await loading;
  assert.equal(result.aborted, true);
});
