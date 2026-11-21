"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { estimateHostBootTimeMs } = require("../src/host-boot-time");

describe("host boot time estimate", () => {
  it("derives the boot instant from the current time and uptime", () => {
    assert.equal(estimateHostBootTimeMs({ now: () => 100_000, uptime: () => 12.3456 }), 87_654);
  });

  it("returns null when uptime is unavailable", () => {
    assert.equal(estimateHostBootTimeMs({
      now: () => 1_700_000_000_000,
      uptime: () => { throw new Error("uv_uptime returned EPERM"); },
    }), null);
  });

  it("returns null when the computed boot time is not finite", () => {
    assert.equal(estimateHostBootTimeMs({ now: () => 1_700_000_000_000, uptime: () => NaN }), null);
  });

  it("wires the estimate into the local Codex monitor boundary", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
    assert.match(source, /localCodexBootTimeMs:\s*estimateHostBootTimeMs\(\),/);
  });
});
