const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runSpawnedHook } = require("./helpers/spawned-hook");

function runReasonixHook(payload) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "reasonix-hook.js");
  return runSpawnedHook({
    script: scriptPath,
    payload,
    httpContract: "block",
  });
}

describe("Reasonix hook script", () => {
  it("keeps PreCompact stdout empty so Reasonix does not inject summary guidance", () => {
    const result = runReasonixHook({ event: "PreCompact", cwd: "/tmp" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });

  it("stays silent for regular state-only events too", () => {
    const result = runReasonixHook({
      event: "PreToolUse",
      cwd: "/tmp",
      toolName: "bash",
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });
});
