"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  createSpawnedHookHarness,
  runSpawnedHook,
} = require("./helpers/spawned-hook");

const FIXTURE = path.join(__dirname, "fixtures", "spawned-hook", "http-contract.js");

describe("spawned-hook test harness", () => {
  it("preloads the recorder and permits an expected blocked HTTP attempt", () => {
    const result = runSpawnedHook({
      script: FIXTURE,
      args: ["attempt"],
      httpContract: "expect-attempt",
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.preloads.some((preload) => preload.endsWith("hook-post-recorder.js")));
    assert.strictEqual(result.attempts[0].port, 23333);
    assert.strictEqual(result.attempts[0].path, "/state");
  });

  it("distinguishes business logic that must make no HTTP attempt", () => {
    const result = runSpawnedHook({
      script: FIXTURE,
      args: ["none"],
      httpContract: "expect-none",
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(result.attempts, []);
  });

  it("isolates HOME, USERPROFILE, and userData for every child", () => {
    const harness = createSpawnedHookHarness({ prefix: "spawned-hook-env-" });
    try {
      const result = harness.run({
        script: FIXTURE,
        args: ["none"],
        httpContract: "expect-none",
      });
      const env = JSON.parse(result.stdout);
      assert.strictEqual(env.home, harness.home);
      assert.strictEqual(env.userProfile, harness.home);
      assert.strictEqual(env.userData, harness.userData);
      assert.ok(env.appData.startsWith(harness.home));
      assert.strictEqual(env.codexHome, null);
      assert.strictEqual(env.nodeOptions, null);
    } finally {
      harness.cleanup();
    }
  });

  it("combines process-spawn probing with an independent HTTP assertion contract", () => {
    const result = runSpawnedHook({
      script: FIXTURE,
      args: ["attempt"],
      httpContract: "expect-attempt",
      probeProcessSpawns: true,
    });
    assert.deepStrictEqual(result.spawns, []);
    assert.ok(result.attempts.length > 0);
  });
});
