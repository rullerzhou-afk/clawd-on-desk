"use strict";

const { describe, it, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createQuotaAlerts, normalizeQuotaAlertThresholds, QUOTA_ALERT_MAX_AGE_MS, MAX_HISTORY_RECORDS,
} = require("../src/quota-alerts");
const { createAccountQuotaStore } = require("../src/state-account-quota");

const START = 1_800_000_001_000;
const MINUTE = 60_000;
const RESET = START + 60 * MINUTE;
const CONFIG = { enabled: true, thresholds: [20, 10], recoveryEnabled: true };
function deferredNotificationHarness(options = {}) {
  const sends = [];
  const h = harness({ ...options, notify: event => new Promise((resolve, reject) => sends.push({ event, resolve, reject })) });
  return { ...h, sends };
}
const settleNotifications = () => new Promise(resolve => setImmediate(resolve));
test("async notification acknowledgements persist only after show and deduplicate while pending", async t => {
  const historyPath = historyFixture(t), h = deferredNotificationHarness({ historyPath });
  h.observe(9); h.observe(9);
  assert.equal(h.sends.length, 1);
  h.alerts.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(historyPath, "utf8")).records[0].notified, []);
  h.sends[0].resolve(true); await settleNotifications();
  assert.deepEqual(JSON.parse(fs.readFileSync(historyPath, "utf8")).records[0].notified, [20, 10]);
  h.observe(9); assert.equal(h.sends.length, 1); h.alerts.dispose();
});
test("failed or rejected async sends retry without consuming the threshold", async () => {
  const h = deferredNotificationHarness();
  h.observe(9); h.sends[0].resolve(false); await settleNotifications();
  h.observe(9); h.sends[1].reject(new Error("native failure")); await settleNotifications();
  h.observe(9); assert.equal(h.sends.length, 3);
  h.sends[2].resolve(true); await settleNotifications();
  h.observe(9); assert.equal(h.sends.length, 3); h.alerts.dispose();
});
test("old-window async acknowledgements cannot consume a new window or mutate shutdown history", async t => {
  const historyPath = historyFixture(t), h = deferredNotificationHarness({ historyPath });
  h.observe(9); h.observe(9, CONFIG, { resetAt: RESET + MINUTE });
  h.sends[0].resolve(true); await settleNotifications();
  h.observe(9, CONFIG, { resetAt: RESET + MINUTE }); assert.equal(h.sends.length, 2);
  h.alerts.dispose(); const saved = fs.readFileSync(historyPath, "utf8");
  h.sends[1].resolve(true); await settleNotifications(); assert.equal(fs.readFileSync(historyPath, "utf8"), saved);
});
test("recovery async sends retry and acknowledge once independently of low sends", async () => {
  const h = deferredNotificationHarness();
  h.observe(9); h.sends[0].resolve(true); await settleNotifications();
  h.observe(50); h.observe(50); assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].event.type, "recovered");
  h.sends[1].resolve(false); await settleNotifications();
  h.observe(50); h.sends[2].resolve(true); await settleNotifications();
  h.observe(50); assert.equal(h.sends.length, 3); h.alerts.dispose();
});

function snapshot(remainingPercent, observedAt, overrides = {}) {
  const bucket = {
    usedPercent: 100 - remainingPercent, lastSeenAt: observedAt,
    resetAt: RESET, windowMinutes: 300, ...overrides,
  };
  return [{ sourceKey: "", host: null, codexQuota: { group: { codexFiveHour: bucket },
    updatedAt: observedAt, lastSeenAt: observedAt } }];
}

function harness(options = {}) {
  let nowMs = options.startAt ?? START;
  const events = [];
  const alerts = createQuotaAlerts({ now: () => nowMs, historyPath: null,
    notify: (event) => { events.push(event); return true; }, ...options });
  return { alerts, events, setNow(value) { nowMs = value; },
    observe(remaining, config = CONFIG, overrides = {}) {
      nowMs += MINUTE;
      return alerts.observe(snapshot(remaining, nowMs, overrides), config);
    } };
}

function historyFixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, "clawd-quota-alert-"));
  t.after(() => {
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith("clawd-quota-alert-"));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return path.join(dir, "quota-alert-history.json");
}

describe("quota alerts", () => {
  it("is disabled unless explicitly enabled", () => {
    const h = harness();
    h.observe(9, {});
    h.observe(9, { enabled: "true" });
    assert.deepEqual(h.events, []);
    h.observe(9);
    assert.equal(h.events.length, 1);
  });

  it("normalizes the shared preferences threshold shape without coercion", () => {
    assert.deepEqual(normalizeQuotaAlertThresholds(), [20, 10]);
    assert.deepEqual(normalizeQuotaAlertThresholds([10, 20, 10, "5", 0, 100, 101, 3.5, NaN]), [20, 10]);
    assert.deepEqual(normalizeQuotaAlertThresholds([]), [20, 10]);
    assert.equal(normalizeQuotaAlertThresholds(Array.from({ length: 100 }, (_, i) => i + 1)).length, 5);
  });

  it("emits inclusive 20% then 10% thresholds only once per window", () => {
    const h = harness();
    h.observe(21);
    h.observe(20);
    h.observe(18);
    h.observe(10);
    h.observe(0);
    assert.deepEqual(h.events.map((event) => event.threshold), [20, 10]);
    assert.equal(h.events[0].remainingPercent, 20);
    assert.equal(h.events[0].windowMinutes, 300);
    assert.equal(h.events[0].providerKey, "codexQuota");
  });

  it("a jump to 9% emits 10% and also consumes the less urgent candidate", () => {
    const h = harness();
    h.observe(9);
    h.observe(18);
    h.observe(9);
    assert.deepEqual(h.events.map((event) => event.threshold), [10]);
  });

  it("ignores startup cache even if a provider timestamp advances", () => {
    const h = harness();
    h.setNow(START + MINUTE);
    const input = snapshot(9, START - 1000);
    input[0].codexQuota.updatedAt = START + MINUTE;
    input[0].codexQuota.lastSeenAt = START + MINUTE;
    h.alerts.observe(input, CONFIG);
    assert.deepEqual(h.events, []);
  });

  it("uses real per-bucket confirmation from the account store after the next minute", () => {
    let nowMs = START;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, { codexQuota: { codexFiveHour: { usedPercent: 91, resetAt: RESET, windowMinutes: 300 } } });
    const events = [];
    const alerts = createQuotaAlerts({ now: () => nowMs, notify: (event) => { events.push(event); return true; } });
    alerts.observe(store.snapshot({ mergeSources: false }), CONFIG);
    nowMs += 1000;
    store.update(null, { codexQuota: { codexFiveHour: { usedPercent: 91, resetAt: RESET, windowMinutes: 300 } } });
    alerts.observe(store.snapshot({ mergeSources: false }), CONFIG);
    assert.equal(events.length, 0, "same-minute confirmation remains conservatively ambiguous");
    nowMs += MINUTE;
    store.update(null, { codexQuota: { codexFiveHour: { usedPercent: 91, resetAt: RESET, windowMinutes: 300 } } });
    alerts.observe(store.snapshot({ mergeSources: false }), CONFIG);
    assert.equal(events.length, 1);
    alerts.dispose();
  });

  it("does not borrow a fresh sibling's confirmation for an old window", () => {
    const h = harness();
    h.setNow(START + MINUTE);
    const input = snapshot(9, START);
    input[0].codexQuota.group.codexWeekly = {
      usedPercent: 10, lastSeenAt: START + MINUTE, resetAt: RESET, windowMinutes: 10080,
    };
    input[0].codexQuota.lastSeenAt = START + MINUTE;
    h.alerts.observe(input, CONFIG);
    assert.deepEqual(h.events, []);
  });

  it("rejects missing, stale, future, expired and malformed bucket values", () => {
    const h = harness();
    const at = START + 20 * MINUTE;
    h.setNow(at);
    const bad = [
      { lastSeenAt: undefined }, { lastSeenAt: null }, { lastSeenAt: at + 1 },
      { lastSeenAt: at - QUOTA_ALERT_MAX_AGE_MS - 1 },
      { resetAt: undefined }, { resetAt: null }, { resetAt: at }, { resetAt: at + 46 * 24 * 60 * MINUTE },
      { expired: true }, { usedPercent: null }, { usedPercent: "91" }, { usedPercent: NaN },
      { usedPercent: -1 }, { usedPercent: 101 }, { cached: true }, { fromCache: true }, { stale: true }, { fresh: false },
    ];
    for (const overrides of bad) h.alerts.observe(snapshot(9, at, overrides), CONFIG);
    assert.deepEqual(h.events, []);
  });

  it("rejects explicit cached sources/providers and synthetic merged sources", () => {
    const h = harness();
    const at = START + MINUTE;
    h.setNow(at);
    for (const mutation of [
      (source) => { source.cached = true; },
      (source) => { source.codexQuota.fromCache = true; },
      (source) => { source.sourceKey = null; },
      (source) => { delete source.sourceKey; },
    ]) {
      const input = snapshot(9, at);
      mutation(input[0]);
      h.alerts.observe(input, CONFIG);
    }
    assert.deepEqual(h.events, []);
  });

  it("separates profiles with identical display hosts, providers and windows", () => {
    const h = harness();
    const at = START + MINUTE;
    h.setNow(at);
    const a = snapshot(9, at)[0];
    a.sourceKey = "remote:one";
    a.host = "shared.host";
    a.codexSparkQuota = structuredClone(a.codexQuota);
    a.codexQuota.group.codexWeekly = { ...a.codexQuota.group.codexFiveHour, windowMinutes: 10080 };
    const b = structuredClone(a);
    b.sourceKey = "remote:two";
    h.alerts.observe([a, b], CONFIG);
    h.alerts.observe([a, b], CONFIG);
    assert.equal(h.events.length, 6);
    assert.deepEqual(new Set(h.events.map((event) => event.sourceKey)), new Set(["remote:one", "remote:two"]));
  });

  it("returns unknown duration as null instead of inventing a five-hour label", () => {
    const h = harness();
    h.observe(9, CONFIG, { windowMinutes: undefined });
    assert.equal(h.events[0].windowMinutes, null);
  });

  it("suppression does not consume low or recovery candidates", () => {
    const h = harness();
    h.observe(9, { ...CONFIG, suppressed: true });
    h.observe(9);
    h.observe(80, { ...CONFIG, suppressed: true });
    h.observe(80);
    assert.deepEqual(h.events.map((event) => event.type), ["low", "recovered"]);
  });

  it("notify false and exceptions leave a low candidate retryable", () => {
    let attempt = 0;
    const accepted = [];
    const h = harness({ notify: (event) => {
      attempt += 1;
      if (attempt === 1) return false;
      if (attempt === 2) throw new Error("not available");
      accepted.push(event);
      return true;
    } });
    h.observe(9);
    h.observe(9);
    h.observe(9);
    h.observe(9);
    assert.equal(attempt, 3);
    assert.equal(accepted[0].threshold, 10);
  });

  it("only literal true acknowledges a notification", () => {
    let attempt = 0;
    const h = harness({ notify: () => { attempt += 1; return "true"; } });
    h.observe(9);
    h.observe(9);
    assert.equal(attempt, 2);
  });

  it("requires a later actual observation to recover in the same window", () => {
    const h = harness();
    h.observe(9);
    const at = START + MINUTE;
    h.alerts.observe(snapshot(80, at), CONFIG);
    assert.equal(h.events.length, 1, "changed values with the same quantized timestamp cannot prove recovery");
    h.observe(80);
    h.observe(80);
    h.observe(9);
    h.observe(80);
    assert.deepEqual(h.events.map((event) => event.type), ["low", "recovered"]);
  });

  it("failed recovery delivery remains retryable", () => {
    let recoveryAttempts = 0;
    const accepted = [];
    const h = harness({ notify: (event) => {
      if (event.type === "recovered" && ++recoveryAttempts === 1) return false;
      accepted.push(event);
      return true;
    } });
    h.observe(9);
    h.observe(80);
    h.observe(80);
    assert.equal(recoveryAttempts, 2);
    assert.deepEqual(accepted.map((event) => event.type), ["low", "recovered"]);
  });

  it("does not infer recovery from a reset timer, missing values or stale data", () => {
    const h = harness();
    h.observe(9);
    h.setNow(RESET + MINUTE);
    h.alerts.observe(snapshot(80, START + MINUTE, { resetAt: RESET + 60 * MINUTE }), CONFIG);
    h.alerts.observe(snapshot(80, RESET + MINUTE, { usedPercent: undefined, resetAt: RESET + 60 * MINUTE }), CONFIG);
    h.alerts.observe([], CONFIG);
    h.alerts.flush();
    assert.deepEqual(h.events.map((event) => event.type), ["low"]);
  });

  it("recovers on a fresh new window and rearms thresholds for that new window", () => {
    const h = harness();
    h.observe(9);
    h.setNow(RESET + MINUTE);
    const newReset = RESET + 60 * MINUTE;
    h.alerts.observe(snapshot(80, RESET + MINUTE, { resetAt: newReset }), CONFIG);
    h.setNow(RESET + 2 * MINUTE);
    h.alerts.observe(snapshot(9, RESET + 2 * MINUTE, { resetAt: newReset }), CONFIG);
    assert.deepEqual(h.events.map((event) => event.type), ["low", "recovered", "low"]);
  });

  it("does not call a live window's reset-time correction a recovery", () => {
    const h = harness();
    h.observe(9);
    h.observe(80, CONFIG, { resetAt: RESET + MINUTE });
    assert.deepEqual(h.events.map((event) => event.type), ["low"]);
  });

  it("rejects out-of-order observations and older window replay", () => {
    const h = harness();
    h.observe(9);
    h.setNow(START + 3 * MINUTE);
    h.alerts.observe(snapshot(80, START + 500), CONFIG);
    h.alerts.observe(snapshot(9, START + 3 * MINUTE, { resetAt: RESET - MINUTE }), CONFIG);
    assert.equal(h.events.length, 1);
  });

  it("honors recovery opt-out and rejects unrelated provider/window shapes", () => {
    const h = harness();
    h.observe(9);
    h.observe(80, { ...CONFIG, recoveryEnabled: false });
    const at = START + 3 * MINUTE;
    h.setNow(at);
    const input = snapshot(9, at);
    input[0].unexpectedQuota = input[0].codexQuota;
    input[0].codexQuota.group = { unexpectedWindow: input[0].codexQuota.group.codexFiveHour };
    h.alerts.observe(input, CONFIG);
    assert.equal(h.events.length, 1);
  });

  it("persists dedup across restart and never stores raw labels or payloads", (t) => {
    const historyPath = historyFixture(t);
    let nowMs = START;
    const events = [];
    const options = { historyPath, now: () => nowMs, notify: (event) => { events.push(event); return true; } };
    const first = createQuotaAlerts(options);
    nowMs += MINUTE;
    const input = snapshot(9, nowMs);
    input[0].sourceKey = "remote:private-profile";
    input[0].host = "private-host";
    input[0].token = "SECRET-TOKEN";
    input[0].sessionContent = "SECRET-CONTENT";
    first.observe(input, CONFIG);
    first.dispose();
    const body = fs.readFileSync(historyPath, "utf8");
    assert.doesNotMatch(body, /private-profile|private-host|SECRET|sessionContent|token/);
    const second = createQuotaAlerts(options);
    nowMs += MINUTE;
    input[0].codexQuota.group.codexFiveHour.lastSeenAt = nowMs;
    second.observe(input, CONFIG);
    assert.equal(events.length, 1);
    nowMs += MINUTE;
    input[0].codexQuota.group.codexFiveHour.lastSeenAt = nowMs;
    input[0].codexQuota.group.codexFiveHour.usedPercent = 20;
    second.observe(input, CONFIG);
    assert.deepEqual(events.map((event) => event.type), ["low", "recovered"]);
    second.dispose();
    const third = createQuotaAlerts(options);
    nowMs += MINUTE;
    input[0].codexQuota.group.codexFiveHour.lastSeenAt = nowMs;
    third.observe(input, CONFIG);
    assert.equal(events.length, 2);
    third.dispose();
  });

  it("recovers from corrupt history and reads BOM-safe valid history", (t) => {
    const historyPath = historyFixture(t);
    fs.writeFileSync(historyPath, "broken JSON");
    const first = harness({ historyPath });
    first.observe(9);
    first.alerts.dispose();
    fs.writeFileSync(historyPath, "\uFEFF" + fs.readFileSync(historyPath, "utf8"));
    const second = harness({ historyPath, startAt: START + MINUTE });
    second.setNow(START + 2 * MINUTE);
    second.alerts.observe(snapshot(9, START + 2 * MINUTE), CONFIG);
    assert.deepEqual(second.events, []);
    second.alerts.dispose();
  });

  it("ignores malformed or future history records", (t) => {
    const historyPath = historyFixture(t);
    fs.writeFileSync(historyPath, JSON.stringify({ version: 1, records: [
      { key: "not a digest", resetAt: RESET, observedAt: START, remainingPercent: 9, notified: [10, 20] },
      { key: "a".repeat(64), resetAt: RESET, observedAt: START + MINUTE, remainingPercent: 9, notified: [10, 20] },
    ] }));
    const h = harness({ historyPath });
    h.observe(9);
    assert.equal(h.events.length, 1);
    h.alerts.dispose();
  });

  it("keeps history bounded while provider/source digests change", (t) => {
    const historyPath = historyFixture(t);
    const h = harness({ historyPath });
    for (let i = 0; i < MAX_HISTORY_RECORDS + 30; i++) {
      const at = START + MINUTE + i;
      h.setNow(at);
      const input = snapshot(50, at);
      input[0].sourceKey = `remote:${i}`;
      h.alerts.observe(input, CONFIG);
    }
    assert.equal(h.alerts.flush(), true);
    const body = fs.readFileSync(historyPath, "utf8");
    assert.equal(JSON.parse(body).records.length, MAX_HISTORY_RECORDS);
    assert.ok(Buffer.byteLength(body) < 256 * 1024);
    h.alerts.dispose();
  });

  it("atomic write failure preserves the previous file and flush can retry", (t) => {
    const historyPath = historyFixture(t);
    fs.writeFileSync(historyPath, "previous file");
    let failRename = true;
    const injectedFs = { ...fs, renameSync(from, to) {
      if (failRename) throw Object.assign(new Error("simulated"), { code: "EACCES" });
      fs.renameSync(from, to);
    } };
    const h = harness({ historyPath, fs: injectedFs });
    h.observe(9);
    assert.equal(fs.readFileSync(historyPath, "utf8"), "previous file");
    assert.deepEqual(fs.readdirSync(path.dirname(historyPath)), ["quota-alert-history.json"]);
    failRename = false;
    assert.equal(h.alerts.flush(), true);
    assert.equal(JSON.parse(fs.readFileSync(historyPath, "utf8")).records.length, 1);
    h.alerts.dispose();
  });

  it("guards notification reentrancy and stops observing after dispose", () => {
    let alerts;
    let attempts = 0;
    let nowMs = START;
    alerts = createQuotaAlerts({ now: () => nowMs, notify: () => {
      attempts += 1;
      alerts.observe(snapshot(9, nowMs), CONFIG);
      return true;
    } });
    nowMs += MINUTE;
    alerts.observe(snapshot(9, nowMs), CONFIG);
    alerts.dispose();
    nowMs += MINUTE;
    alerts.observe(snapshot(9, nowMs, { resetAt: RESET + MINUTE }), CONFIG);
    alerts.dispose();
    assert.equal(attempts, 1);
  });
});
