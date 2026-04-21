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
});
