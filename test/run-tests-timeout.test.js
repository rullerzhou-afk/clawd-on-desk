"use strict";

// A hung test is not a failure unless the runner imposes a per-test timeout:
// `node --test` waits forever, the remaining files never run, and no summary is
// printed. Verified once by hand — a deliberately hanging test turned the run
// from an indefinite stall into "✖ deliberately hangs" with exit code 1.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  DEFAULT_TEST_TIMEOUT_MS,
  resolveTimeoutArgs,
  resolveTestRunnerInvocation,
} = require("./run-tests");

test("the runner always passes a per-test timeout by default", () => {
  assert.deepStrictEqual(resolveTimeoutArgs({}), [`--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`]);
  assert.ok(DEFAULT_TEST_TIMEOUT_MS >= 60000, "the ceiling must be generous enough for slow suites");
});

test("CLAWD_TEST_TIMEOUT_MS overrides it, and 0 disables it", () => {
  assert.deepStrictEqual(resolveTimeoutArgs({ CLAWD_TEST_TIMEOUT_MS: "5000" }), ["--test-timeout=5000"]);
  assert.deepStrictEqual(resolveTimeoutArgs({ CLAWD_TEST_TIMEOUT_MS: "0" }), []);
});

test("a malformed override falls back to the default rather than disabling the timeout", () => {
  for (const value of ["", "abc", "-1", "NaN", undefined]) {
    assert.deepStrictEqual(
      resolveTimeoutArgs({ CLAWD_TEST_TIMEOUT_MS: value }),
      [`--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`],
      `CLAWD_TEST_TIMEOUT_MS=${JSON.stringify(value)} must not silently remove the timeout`,
    );
  }
});

test("full-suite runner uses one top-level glob instead of a Windows-long filename argv", () => {
  const invocation = resolveTestRunnerInvocation({ CLAWD_TEST_TIMEOUT_MS: "5000" });
  assert.deepStrictEqual(invocation.args, [
    "--test",
    "--test-timeout=5000",
    "test/*.test.js",
  ]);
  assert.strictEqual(invocation.cwd, path.join(__dirname, ".."));
  assert.ok(invocation.args.join(" ").length < 1024);
});
