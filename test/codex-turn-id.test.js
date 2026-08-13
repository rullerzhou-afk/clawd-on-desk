"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_CODEX_TURN_ID_LENGTH,
  normalizeCodexTurnId,
  digestCodexTurnId,
} = require("../src/codex-turn-id");

describe("codex turn identity", () => {
  it("normalizes opaque bounded string IDs without interpreting their format", () => {
    assert.strictEqual(normalizeCodexTurnId("  turn-A  "), "turn-A");
    assert.strictEqual(normalizeCodexTurnId("x".repeat(MAX_CODEX_TURN_ID_LENGTH)), "x".repeat(MAX_CODEX_TURN_ID_LENGTH));
    assert.strictEqual(normalizeCodexTurnId(""), null);
    assert.strictEqual(normalizeCodexTurnId("   "), null);
    assert.strictEqual(normalizeCodexTurnId(123), null);
    assert.strictEqual(normalizeCodexTurnId("x".repeat(MAX_CODEX_TURN_ID_LENGTH + 1)), null);
  });

  it("uses a deterministic privacy-safe digest for diagnostics", () => {
    const digest = digestCodexTurnId("  turn-A  ");
    assert.match(digest, /^[a-f0-9]{16}$/);
    assert.strictEqual(digest, digestCodexTurnId("turn-A"));
    assert.notStrictEqual(digest, digestCodexTurnId("turn-B"));
    assert.strictEqual(digestCodexTurnId(null), null);
  });
});
