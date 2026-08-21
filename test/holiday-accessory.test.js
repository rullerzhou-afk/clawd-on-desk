"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const {
  HOLIDAY_ACCESSORY_WINDOWS,
  MAX_REFRESH_INTERVAL_MS,
  getHolidayAccessoryForDate,
  isHolidayAccessoryEnabledForTheme,
  getEffectivePetAccessoryIdForTheme,
  getNextHolidayRefreshDelay,
  createHolidayAccessoryRuntime,
} = require("../src/holiday-accessory");

function localDate(month, day, hour = 12, year = 2026) {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

describe("holiday accessory date rules", () => {
  it("keeps the accepted holiday windows immutable and catalog-backed", () => {
    assert.deepStrictEqual(
      HOLIDAY_ACCESSORY_WINDOWS.map(({ id, accessoryId }) => ({ id, accessoryId })),
      [
        { id: "halloween", accessoryId: "pumpkin-hat" },
        { id: "christmas", accessoryId: "santa-hat" },
        { id: "new-year", accessoryId: "party-hat" },
      ]
    );
    assert.ok(Object.isFrozen(HOLIDAY_ACCESSORY_WINDOWS));
    assert.ok(HOLIDAY_ACCESSORY_WINDOWS.every((entry) => (
      Object.isFrozen(entry)
      && Object.isFrozen(entry.ranges)
      && entry.ranges.every(Object.isFrozen)
    )));
  });

  it("uses short inclusive local-date windows and restores outside them", () => {
    const cases = [
      [10, 27, null],
      [10, 28, "pumpkin-hat"],
      [10, 31, "pumpkin-hat"],
      [11, 1, "pumpkin-hat"],
      [11, 2, null],
      [12, 21, null],
      [12, 22, "santa-hat"],
      [12, 27, "santa-hat"],
      [12, 28, null],
      [12, 30, null],
      [12, 31, "party-hat"],
      [1, 1, "party-hat"],
      [1, 2, "party-hat"],
      [1, 3, null],
    ];
    for (const [month, day, expected] of cases) {
      const resolved = getHolidayAccessoryForDate(localDate(month, day));
      assert.strictEqual(resolved && resolved.accessoryId, expected, `${month}/${day}`);
    }
  });

  it("is year-independent and fails closed for invalid dates", () => {
    assert.strictEqual(
      getHolidayAccessoryForDate(localDate(2, 29, 12, 2028)),
      null
    );
    assert.strictEqual(
      getHolidayAccessoryForDate(localDate(12, 31, 12, 2035)).accessoryId,
      "party-hat"
    );
    assert.strictEqual(getHolidayAccessoryForDate(new Date(NaN)), null);
    assert.strictEqual(getHolidayAccessoryForDate("2026-12-24"), null);
  });

  it("uses the user's UTC+14 local date at a holiday boundary", () => {
    const modulePath = path.join(__dirname, "..", "src", "holiday-accessory.js");
    const script = [
      `const { getHolidayAccessoryForDate } = require(${JSON.stringify(modulePath)});`,
      "const result = getHolidayAccessoryForDate(new Date('2026-12-21T10:30:00.000Z'));",
      "process.stdout.write(result ? result.accessoryId : 'none');",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: "Pacific/Kiritimati" },
      encoding: "utf8",
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "santa-hat");
  });

  it("keeps the checkbox independent from the saved manual accessory", () => {
    const manual = { clawd: "wizard-hat", cloudling: "halo" };
    assert.strictEqual(isHolidayAccessoryEnabledForTheme({ clawd: true }, "clawd"), true);
    assert.strictEqual(isHolidayAccessoryEnabledForTheme({ clawd: false }, "clawd"), false);
    assert.strictEqual(isHolidayAccessoryEnabledForTheme("true", "clawd"), false);

    assert.strictEqual(getEffectivePetAccessoryIdForTheme({
      petAccessory: manual,
      holidayAccessoryEnabled: {},
      themeId: "clawd",
      date: localDate(12, 24),
    }), "wizard-hat");
    assert.strictEqual(getEffectivePetAccessoryIdForTheme({
      petAccessory: manual,
      holidayAccessoryEnabled: { clawd: true },
      themeId: "clawd",
      date: localDate(12, 24),
    }), "santa-hat");
    assert.strictEqual(getEffectivePetAccessoryIdForTheme({
      petAccessory: manual,
      holidayAccessoryEnabled: { clawd: true },
      themeId: "clawd",
      date: localDate(12, 28),
    }), "wizard-hat");
    assert.strictEqual(getEffectivePetAccessoryIdForTheme({
      petAccessory: {},
      holidayAccessoryEnabled: { clawd: true },
      themeId: "clawd",
      date: localDate(10, 31),
    }), "pumpkin-hat");
  });

  it("refreshes no later than the next local midnight or one hour", () => {
    const nearMidnight = new Date(2026, 9, 27, 23, 59, 30, 0);
    assert.strictEqual(getNextHolidayRefreshDelay(nearMidnight), 31_000);
    assert.strictEqual(
      getNextHolidayRefreshDelay(new Date(2026, 9, 27, 12, 0, 0, 0)),
      MAX_REFRESH_INTERVAL_MS
    );
    assert.strictEqual(getNextHolidayRefreshDelay(new Date(NaN)), MAX_REFRESH_INTERVAL_MS);
  });
});

describe("holiday accessory runtime", () => {
  function createHarness() {
    const powerMonitor = new EventEmitter();
    const calls = [];
    const hitboxPayloads = [];
    const timers = [];
    let currentDate = localDate(12, 24);
    let snapshot = {
      petAccessory: { clawd: "wizard-hat" },
      holidayAccessoryEnabled: { clawd: true },
    };
    const theme = {
      _id: "clawd",
      _builtin: true,
      _capabilities: { accessories: true },
    };
    const runtime = createHolidayAccessoryRuntime({
      powerMonitor,
      getSettingsSnapshot: () => snapshot,
      getActiveTheme: () => theme,
      sendToRenderer: (...args) => calls.push(args),
      onAccessoryChange: (payload) => hitboxPayloads.push(payload),
      now: () => currentDate,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cleared = true; },
      logWarn: () => {},
    });
    return {
      runtime,
      powerMonitor,
      calls,
      hitboxPayloads,
      timers,
      setDate: (value) => { currentDate = value; },
      setSnapshot: (value) => { snapshot = value; },
    };
  }

  it("starts, deduplicates, crosses date windows, and supports forced sync", () => {
    const harness = createHarness();
    harness.runtime.start();
    assert.strictEqual(harness.calls.length, 1);
    assert.strictEqual(harness.calls[0][0], "pet-accessory-change");
    assert.strictEqual(harness.calls[0][1].id, "santa-hat");
    assert.strictEqual(harness.hitboxPayloads[0].id, "santa-hat");
    assert.strictEqual(harness.timers.length, 1);

    assert.strictEqual(harness.runtime.refresh(), false);
    assert.strictEqual(harness.calls.length, 1);
    assert.strictEqual(harness.runtime.refresh({ force: true }), true);
    assert.strictEqual(harness.calls.length, 2);

    harness.setDate(localDate(12, 28));
    harness.timers[0].callback();
    assert.strictEqual(harness.calls.at(-1)[1].id, "wizard-hat");
    assert.strictEqual(harness.hitboxPayloads.at(-1).id, "wizard-hat");
    assert.strictEqual(harness.timers.length, 2);
  });

  it("refreshes and reschedules on wake, then removes listeners and timers", () => {
    const harness = createHarness();
    harness.runtime.start();
    const firstTimer = harness.timers[0];
    harness.setDate(localDate(1, 1));
    harness.powerMonitor.emit("resume");
    assert.strictEqual(harness.calls.at(-1)[1].id, "party-hat");
    assert.strictEqual(firstTimer.cleared, true);
    assert.strictEqual(harness.timers.length, 2);

    const secondTimer = harness.timers[1];
    harness.runtime.dispose();
    assert.strictEqual(secondTimer.cleared, true);
    assert.strictEqual(harness.powerMonitor.listenerCount("resume"), 0);
    assert.strictEqual(harness.powerMonitor.listenerCount("unlock-screen"), 0);
  });

  it("honors settings changes without mutating the saved manual choice", () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.setSnapshot({
      petAccessory: { clawd: "halo" },
      holidayAccessoryEnabled: {},
    });
    harness.runtime.refresh({ force: true });
    assert.strictEqual(harness.calls.at(-1)[1].id, "halo");
  });
});
