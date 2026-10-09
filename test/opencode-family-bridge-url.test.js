"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOpencodeFamilyBridgeUrl,
  isValidOpencodeFamilyBridgeToken,
} = require("../src/opencode-family-bridge-url");

test("opencode-family bridge accepts only an explicit IPv4 loopback HTTP origin", () => {
  assert.strictEqual(
    normalizeOpencodeFamilyBridgeUrl("http://127.0.0.1:43123/"),
    "http://127.0.0.1:43123",
  );
  for (const value of [
    "http://127.0.0.1",
    "https://127.0.0.1:43123",
    "http://localhost:43123",
    "http://[::1]:43123",
    "http://127.0.0.2:43123",
    "http://127.0.0.1:43123/reply",
    "http://127.0.0.1:43123/?redirect=http://example.com",
    "http://user:pass@127.0.0.1:43123",
    "http://example.com:43123",
    "not-a-url",
  ]) {
    assert.strictEqual(normalizeOpencodeFamilyBridgeUrl(value), null, value);
  }
});

test("opencode-family bridge token accepts bounded URL-safe opaque values", () => {
  assert.strictEqual(isValidOpencodeFamilyBridgeToken("a".repeat(64)), true);
  assert.strictEqual(isValidOpencodeFamilyBridgeToken("legacy_token-1"), true);
  for (const value of ["", "space token", "line\nbreak", "colon:value", "a".repeat(129), null]) {
    assert.strictEqual(isValidOpencodeFamilyBridgeToken(value), false, String(value));
  }
});
