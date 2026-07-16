"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redactSecrets } = require("../src/secret-redact");

test("redactSecrets masks high-confidence secret shapes", () => {
  const sk = redactSecrets("rotate sk-abcdefghijklmnop1234 now");
  assert.match(sk, /<redacted:token>/);
  assert.doesNotMatch(sk, /sk-abcdefghijklmnop1234/);

  assert.match(redactSecrets("bot 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"), /<redacted:telegram-token>/);
  assert.match(redactSecrets("chat 1234567890"), /<redacted:id>/);

  // Provider token prefixes (high confidence).
  assert.match(redactSecrets("gh github_pat_11ABCDEFG0abcdefghijklmn"), /<redacted:token>/);
  assert.match(redactSecrets("key AIzaSyABCDEFGHIJKLMNOPQRSTUVWX1234567"), /<redacted:token>/);
  assert.match(redactSecrets("aws AKIAIOSFODNN7EXAMPLE"), /<redacted:token>/);
});

test("redactSecrets masks env-var, JSON-quoted, single-quoted, and Authorization secrets", () => {
  const cases = [
    "ANTHROPIC_API_KEY=supersecretvalue1234",
    "AWS_SECRET_ACCESS_KEY=supersecretvalue1234",
    "OPENAI_API_KEY=supersecretvalue1234",
    "GITHUB_TOKEN=supersecretvalue1234",
    "ANTHROPIC_API_KEY='shh-value1234'",           // single-quoted value
    '"api_key": "supersecretvalue1234"',            // JSON double-quoted
    "password: hunter2secretpass",
    "client_secret=supersecretvalue1234",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",    // scheme redacted only inside the header
    "Authorization: Bearer abcdef1234567890token",
    'Authorization: Digest username="Mufasa", realm="r", response="RESPSECRET1234"', // multi-param header
    '{"api_key":"abc\\"TAILSECRET1234"}',           // JSON value with an escaped quote
  ];
  for (const c of cases) {
    const r = redactSecrets(c);
    assert.doesNotMatch(
      r,
      /supersecretvalue1234|hunter2secretpass|shh-value1234|dXNlcjpwYXNzd29yZA|abcdef1234567890token|RESPSECRET1234|TAILSECRET1234/,
      `leaked: ${c} -> ${r}`,
    );
    assert.match(r, /redacted/i, `not redacted: ${c} -> ${r}`);
  }
});

test("redactSecrets does not over-redact ordinary prose or key=value text", () => {
  // There is NO bare Bearer/Basic rule (only inside an Authorization header), so
  // ordinary prose containing those words must survive verbatim.
  assert.equal(redactSecrets("Use basic authentication for the API"), "Use basic authentication for the API");
  assert.equal(redactSecrets("The bearer carries documents"), "The bearer carries documents");
  // Non-secret keys survive so summaries stay legible — including keys that only
  // *end* with a secret-ish word (no arbitrary-prefix redaction).
  assert.equal(redactSecrets("favorite_cookie=chocolate-chip"), "favorite_cookie=chocolate-chip");
  assert.equal(redactSecrets("my_token=some-config-value"), "my_token=some-config-value");
  assert.equal(redactSecrets("width=120"), "width=120");
  assert.equal(redactSecrets("timeout=30 retries=3"), "timeout=30 retries=3");
  assert.equal(redactSecrets("mode=intercept"), "mode=intercept");
  assert.equal(redactSecrets("Token Ring network"), "Token Ring network");
  assert.equal(redactSecrets("Run the test suite in ./src"), "Run the test suite in ./src");
});

test("redactSecrets coerces non-strings safely", () => {
  assert.equal(redactSecrets(null), "");
  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(42), "42");
});
