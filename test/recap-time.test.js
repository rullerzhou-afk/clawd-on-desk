"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addLocalDays,
  describeLocalDay,
  freezeLocalTime,
  isValidTimeZone,
} = require("../src/recap-time");

test("freezeLocalTime freezes civil date, hour and non-whole-hour offset", () => {
  const instant = Date.UTC(2026, 7, 29, 18, 30, 0);
  assert.deepEqual(freezeLocalTime(instant, "Asia/Singapore"), {
    occurredAt: instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
    localDate: "2026-08-30",
    localHour: 2,
  });
  assert.equal(freezeLocalTime(instant, "Asia/Kathmandu").utcOffsetMinutes, 345);
});

test("describeLocalDay preserves fixed 24 cells across DST gap and fold", () => {
  const spring = describeLocalDay("2026-03-08", "America/Los_Angeles");
  assert.equal(spring.length, 24);
  assert.equal(spring[2].kind, "gap");
  assert.deepEqual(spring[2].offsets, []);

  const fall = describeLocalDay("2026-11-01", "America/Los_Angeles");
  assert.equal(fall.length, 24);
  assert.equal(fall[1].kind, "fold");
  assert.equal(fall[1].offsets.length, 2);

  const lordHoweSpring = describeLocalDay("2026-10-04", "Australia/Lord_Howe");
  assert.equal(lordHoweSpring[2].kind, "gap");
  assert.equal(lordHoweSpring[2].minutes, 30);
  const lordHoweFall = describeLocalDay("2026-04-05", "Australia/Lord_Howe");
  assert.equal(lordHoweFall[1].kind, "fold");
  assert.equal(lordHoweFall[1].minutes, 90);
});

test("local date helpers use civil calendar math instead of host DST", () => {
  assert.equal(addLocalDays("2026-03-08", -1), "2026-03-07");
  assert.equal(addLocalDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addLocalDays("2024-02-28", 1), "2024-02-29");
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
});

test("fourteen uncached day shapes stay within a bounded synchronous startup budget", () => {
  const started = process.hrtime.bigint();
  for (let index = 0; index < 14; index += 1) {
    describeLocalDay(addLocalDays("2031-01-01", index), "Pacific/Chatham");
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `14 day-shapes took ${elapsedMs.toFixed(1)}ms`);
});
