"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { formatLocalTimestamp } = require("../src/log-timestamp");

describe("formatLocalTimestamp", () => {
  it("formats an east-of-UTC timezone", () => {
    assert.equal(
      formatLocalTimestamp(new Date("2026-06-23T12:38:52.164Z"), 8 * 60),
      "2026-06-23T20:38:52.164+08:00"
    );
  });

  it("formats a negative timezone across a date boundary", () => {
    assert.equal(
      formatLocalTimestamp(new Date("2026-01-01T02:00:00.000Z"), -5 * 60),
      "2025-12-31T21:00:00.000-05:00"
    );
  });

  it("formats half-hour timezone offsets", () => {
    assert.equal(
      formatLocalTimestamp(new Date("2026-06-23T12:00:00.000Z"), 5 * 60 + 30),
      "2026-06-23T17:30:00.000+05:30"
    );
  });

  it("uses the system offset by default", () => {
    assert.match(
      formatLocalTimestamp(new Date("2026-06-23T12:00:00.000Z")),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/
    );
  });

  it("changes only session-debug logging to local time", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(
      main,
      /function sessionLog\(msg\) \{[\s\S]*?\[\$\{formatLocalTimestamp\(\)\}\]/
    );
    assert.match(
      main,
      /function updateLog\(msg\) \{[\s\S]*?\[\$\{new Date\(\)\.toISOString\(\)\}\]/
    );
  });
});
