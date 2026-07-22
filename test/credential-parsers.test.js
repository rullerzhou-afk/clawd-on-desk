"use strict";
const test = require("node:test");
const assert = require("node:assert");
const p = require("../src/credential-parsers");

test("parseDotenv handles quotes, export, comments, spacing", () => {
  const env = p.parseDotenv([
    "# comment",
    "export GEMINI_API_KEY = 'abc123'",
    'GOOGLE_GEMINI_BASE_URL="https://x/"',
    "EMPTY=",
    "BARE=plainvalue",
  ].join("\n"));
  assert.strictEqual(env.GEMINI_API_KEY, "abc123");
  assert.strictEqual(env.GOOGLE_GEMINI_BASE_URL, "https://x/");
  assert.strictEqual(env.EMPTY, "");
  assert.strictEqual(env.BARE, "plainvalue");
});

test("firstNonEmpty skips present-but-empty and missing keys", () => {
  const obj = { A: "  ", B: "", C: "val", D: "other" };
  assert.strictEqual(p.firstNonEmpty(obj, ["A", "B", "C", "D"]), "val");
  assert.strictEqual(p.firstNonEmpty(obj, ["A", "B"]), null);
  assert.strictEqual(p.firstNonEmpty({}, ["X"]), null);
});

test("extractTomlScalar reads first base_url, quoted or bare", () => {
  const toml = [
    "model = \"gpt-4o\"",
    "[model_providers.custom]",
    'base_url = "https://api.example/v1"',
  ].join("\n");
  assert.strictEqual(p.extractTomlScalar(toml, "base_url"), "https://api.example/v1");
  assert.strictEqual(p.extractTomlScalar("base_url = bare.host", "base_url"), "bare.host");
  assert.strictEqual(p.extractTomlScalar("model = \"x\"", "base_url"), null);
});

test("extractYamlScalar reads top-level scalar only", () => {
  const yaml = [
    "api_key: sk-hermes-123",
    'base_url: "https://hermes/v1"',
    "nested:",
    "  api_key: should-not-match",
  ].join("\n");
  assert.strictEqual(p.extractYamlScalar(yaml, "api_key"), "sk-hermes-123");
  assert.strictEqual(p.extractYamlScalar(yaml, "base_url"), "https://hermes/v1");
});

test("extractFromProviderJson finds first provider with an apiKey", () => {
  const obj = { provider: {
    empty: { options: { apiKey: "" } },
    real: { options: { apiKey: "sk-oc-9", baseURL: "https://oc/v1" } },
  } };
  assert.deepStrictEqual(
    p.extractFromProviderJson(obj, {}),
    { token: "sk-oc-9", baseUrl: "https://oc/v1" }
  );
  assert.deepStrictEqual(p.extractFromProviderJson({}, {}), { token: null, baseUrl: null });
});

test("resolveEnvRef resolves {env:NAME}", () => {
  assert.strictEqual(p.resolveEnvRef("{env:FOO}", { FOO: "bar" }), "bar");
  assert.strictEqual(p.resolveEnvRef("{env:MISSING}", {}), "");
  assert.strictEqual(p.resolveEnvRef("literal", {}), "literal");
});

test("normalizeBaseUrl strips trailing slash and blanks", () => {
  assert.strictEqual(p.normalizeBaseUrl("https://x/v1/"), "https://x/v1");
  assert.strictEqual(p.normalizeBaseUrl("  "), null);
  assert.strictEqual(p.normalizeBaseUrl(null), null);
});

test("parseDotenv strips an inline comment on an unquoted value", () => {
  const env = p.parseDotenv([
    "GEMINI_API_KEY=sk-real # personal key",
    'QUOTED="sk-with # hash"',
    "TRAIL=sk-tight#nospace",
  ].join("\n"));
  assert.strictEqual(env.GEMINI_API_KEY, "sk-real");
  assert.strictEqual(env.QUOTED, "sk-with # hash");
  assert.strictEqual(env.TRAIL, "sk-tight#nospace");
});

test("maskToken masks short and long tokens", () => {
  assert.strictEqual(p.maskToken(null), null);
  assert.strictEqual(p.maskToken("short"), "••••••");
  assert.strictEqual(p.maskToken("sk-ant-abcdef123456"), "sk-a…3456");
});
