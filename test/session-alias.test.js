"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  MAX_SESSION_ALIAS_LENGTH,
  SESSION_ALIAS_TTL_MS,
  UNKNOWN_SESSION_AGENT,
  normalizeSessionAliases,
  pruneExpiredSessionAliases,
  sanitizeSessionAlias,
  sessionAliasKey,
} = require("../src/session-alias");

describe("session alias helpers", () => {
  it("routes null and local host through the same alias key", () => {
    assert.strictEqual(sessionAliasKey(null, "codex", "s1"), "local|codex|s1");
    assert.strictEqual(sessionAliasKey("local", "codex", "s1"), "local|codex|s1");
    assert.strictEqual(sessionAliasKey("", "codex", "s1"), "local|codex|s1");
  });

  it("uses an explicit unknown agent segment when agentId is missing", () => {
    assert.strictEqual(
      sessionAliasKey(null, null, "s1"),
      `local|${UNKNOWN_SESSION_AGENT}|s1`
    );
    assert.strictEqual(
      sessionAliasKey(null, "", "s1"),
      `local|${UNKNOWN_SESSION_AGENT}|s1`
    );
  });

  it("scopes keys by session id, agent id, and host", () => {
    assert.notStrictEqual(
      sessionAliasKey(null, "codex", "s1"),
      sessionAliasKey(null, "codex", "s2")
    );
    assert.notStrictEqual(
      sessionAliasKey(null, "codex", "s1"),
      sessionAliasKey(null, "claude-code", "s1")
    );
    assert.notStrictEqual(
      sessionAliasKey("remote-box", "codex", "s1"),
      sessionAliasKey("other-box", "codex", "s1")
    );
  });

  it("adds cwd scope for Kiro's reusable default session id", () => {
    assert.strictEqual(
      sessionAliasKey(null, "kiro-cli", "default", { cwd: "/repo/a" }),
      "local|kiro-cli|default|cwd:%2Frepo%2Fa"
    );
    assert.notStrictEqual(
      sessionAliasKey(null, "kiro-cli", "default", { cwd: "/repo/a" }),
      sessionAliasKey(null, "kiro-cli", "default", { cwd: "/repo/b" })
    );
    assert.strictEqual(
      sessionAliasKey(null, "codex", "default", { cwd: "/repo/a" }),
      "local|codex|default"
    );
  });

  it("returns null when session id cannot form a stable key", () => {
    assert.strictEqual(sessionAliasKey(null, "codex", ""), null);
    assert.strictEqual(sessionAliasKey(null, "codex", null), null);
    assert.strictEqual(sessionAliasKey(null, "codex", undefined), null);
  });

  it("sanitizes aliases with trim, whitespace collapse, and max length", () => {
    assert.strictEqual(sanitizeSessionAlias("  Clawd\nmain\t repo  "), "Clawd main repo");
    assert.strictEqual(sanitizeSessionAlias("   "), "");
    assert.strictEqual(sanitizeSessionAlias(null), null);
    assert.strictEqual(
      sanitizeSessionAlias("x".repeat(MAX_SESSION_ALIAS_LENGTH + 10)).length,
      MAX_SESSION_ALIAS_LENGTH
    );
  });

  it("normalizes alias maps to valid session alias entries only", () => {
    assert.deepStrictEqual(normalizeSessionAliases({
      "local|codex|s1": { title: "  Codex  ", updatedAt: 100 },
      "local|codex|empty": { title: "  ", updatedAt: 100 },
      "local|codex|bad-title": { title: 42, updatedAt: 100 },
      "local|codex|bad-time": { title: "Bad", updatedAt: -1 },
      "local|codex|missing-time": { title: "Missing", updatedAt: null },
      "": { title: "No key", updatedAt: 100 },
    }, { now: 500 }), {
      "local|codex|s1": { title: "Codex", updatedAt: 100 },
      "local|codex|missing-time": { title: "Missing", updatedAt: 500 },
    });
  });

  it("prunes expired inactive aliases while preserving active ones", () => {
    const now = 10 * SESSION_ALIAS_TTL_MS;
    const expired = now - SESSION_ALIAS_TTL_MS - 1;
    const fresh = now - SESSION_ALIAS_TTL_MS + 1;
    assert.deepStrictEqual(pruneExpiredSessionAliases({
      "local|codex|expired": { title: "Expired", updatedAt: expired },
      "local|codex|active": { title: "Active", updatedAt: expired },
      "local|codex|fresh": { title: "Fresh", updatedAt: fresh },
    }, {
      now,
      activeKeys: new Set(["local|codex|active"]),
    }), {
      "local|codex|active": { title: "Active", updatedAt: expired },
      "local|codex|fresh": { title: "Fresh", updatedAt: fresh },
    });
  });
});
