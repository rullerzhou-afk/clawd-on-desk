"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { CREDENTIAL_SOURCES, getCredentialSources } = require("../src/credential-sources");

const EXPECTED_IDS = ["claude-code", "codex", "gemini-cli", "qwen-code", "openclaw", "opencode", "hermes"];

test("covers exactly the 7 plaintext-token platforms", () => {
  assert.deepStrictEqual(CREDENTIAL_SOURCES.map((s) => s.agentId), EXPECTED_IDS);
});

test("every candidate has a format and a path resolver", () => {
  for (const src of CREDENTIAL_SOURCES) {
    assert.ok(src.candidates.length >= 1, `${src.agentId} has candidates`);
    for (const c of src.candidates) {
      assert.ok(typeof c.format === "string", `${src.agentId} candidate has format`);
      const hasPath = Array.isArray(c.segments) || typeof c.resolve === "function";
      assert.ok(hasPath, `${src.agentId} candidate has segments or resolve`);
    }
  }
});

test("claude-code reads settings.json env token keys", () => {
  const claude = CREDENTIAL_SOURCES.find((s) => s.agentId === "claude-code");
  const c = claude.candidates[0];
  assert.deepStrictEqual(c.segments, [".claude", "settings.json"]);
  assert.strictEqual(c.format, "json-env");
  assert.deepStrictEqual(c.tokenKeys, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.strictEqual(c.baseUrlKey, "ANTHROPIC_BASE_URL");
});

test("getCredentialSources returns a mutable copy, not the frozen source", () => {
  const copy = getCredentialSources();
  assert.notStrictEqual(copy, CREDENTIAL_SOURCES);
  copy.push({});
  assert.strictEqual(CREDENTIAL_SOURCES.length, EXPECTED_IDS.length);
});

test("claude/codex/gemini candidates carry a modelKey", () => {
  const byId = (id) => CREDENTIAL_SOURCES.find((s) => s.agentId === id);
  assert.strictEqual(byId("claude-code").candidates[0].modelKey, "ANTHROPIC_MODEL");
  assert.strictEqual(byId("codex").candidates[1].modelKey, "model");
  assert.strictEqual(byId("gemini-cli").candidates[0].modelKey, "GEMINI_MODEL");
});
