const { describe, it } = require("node:test");
const assert = require("node:assert");
const registry = require("../agents/registry");

describe("Agent Registry (Kimi extension)", () => {
  it("includes kimi-cli in getAllAgents", () => {
    const ids = registry.getAllAgents().map((a) => a.id);
    assert.ok(ids.includes("kimi-cli"));
  });

  it("resolves kimi-cli by id", () => {
    const kimi = registry.getAgent("kimi-cli");
    assert.ok(kimi);
    assert.strictEqual(kimi.id, "kimi-cli");
    assert.strictEqual(kimi.eventSource, "hook");
  });

  it("shares its process names with the hook instead of keeping a copy", () => {
    const kimi = registry.getAgent("kimi-cli");
    const hookNames = require("../hooks/kimi-process-names");
    assert.strictEqual(kimi.processNames, hookNames.KIMI_PROCESS_NAMES);
    assert.strictEqual(kimi.startupRecoveryProcessNames, hookNames.KIMI_STARTUP_RECOVERY_PROCESS_NAMES);
  });
});
