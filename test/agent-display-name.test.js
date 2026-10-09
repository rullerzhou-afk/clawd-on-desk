"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveAgentDisplayName } = require("../src/agent-display-name");

test("resolveAgentDisplayName prefers the built-in registry name", () => {
  assert.strictEqual(
    resolveAgentDisplayName("claude-code", [{ id: "claude-code", name: "Spoofed Claude" }]),
    "Claude Code"
  );
});

test("resolveAgentDisplayName reads registered custom application names", () => {
  assert.strictEqual(
    resolveAgentDisplayName("custom-nova-0123456789ab", [
      { id: "custom-nova-0123456789ab", name: "Nova AI" },
    ]),
    "Nova AI"
  );
});

test("resolveAgentDisplayName falls back to the raw id", () => {
  assert.strictEqual(resolveAgentDisplayName("future-agent", []), "future-agent");
  assert.strictEqual(resolveAgentDisplayName(null, []), "");
});
