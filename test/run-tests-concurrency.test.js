"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveConcurrencyArgs } = require("./run-tests");

test("Windows worker fan-out is bounded without changing other platform defaults", () => {
  assert.deepEqual(resolveConcurrencyArgs({}, "win32"), ["--test-concurrency=2"]);
  assert.deepEqual(resolveConcurrencyArgs({}, "linux"), []);
  assert.deepEqual(resolveConcurrencyArgs({}, "darwin"), []);
});

test("a worker override must be a bounded positive integer", () => {
  assert.deepEqual(resolveConcurrencyArgs({ CLAWD_TEST_CONCURRENCY: "4" }, "win32"), ["--test-concurrency=4"]);
  for (const value of ["", "0", "-1", "1.5", "NaN", "257", "Infinity"]) {
    assert.deepEqual(resolveConcurrencyArgs({ CLAWD_TEST_CONCURRENCY: value }, "win32"), ["--test-concurrency=2"]);
  }
});
