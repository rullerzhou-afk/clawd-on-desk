const { describe, it } = require("node:test");
const assert = require("node:assert");

const kimi = require("../agents/kimi-cli");

describe("Kimi agent config", () => {
  it("uses hook-only event source", () => {
    assert.strictEqual(kimi.eventSource, "hook");
    assert.strictEqual(kimi.capabilities.httpHook, true);
    assert.strictEqual(kimi.capabilities.permissionApproval, true);
  });

  it("does not expose log polling config", () => {
    assert.strictEqual(kimi.logConfig, undefined);
    assert.ok(kimi.eventMap && typeof kimi.eventMap === "object");
    assert.strictEqual(kimi.eventMap.Stop, "attention");
  });
});
