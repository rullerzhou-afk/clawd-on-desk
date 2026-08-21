"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sanitizeTelegramApprovalLogMeta,
} = require("../src/telegram-approval-log-meta");
const {
  sanitizeProxy,
} = require("../src/telegram-fetch-transport");

test("keeps only stable terminal and proxy diagnostics", () => {
  assert.deepEqual(sanitizeTelegramApprovalLogMeta({
    outcome: "failed",
    mode: "fixed_servers",
    proxy: "SOCKS5",
  }), {
    outcome: "failed",
    mode: "fixed_servers",
    proxy: "SOCKS5",
  });
});

test("accepts the real compound output produced by sanitizeProxy", () => {
  for (const [resolved, expected] of [
    ["PROXY 127.0.0.1:7890; DIRECT", "PROXY+DIRECT"],
    ["SOCKS5 127.0.0.1:1080; DIRECT", "SOCKS5+DIRECT"],
    ["DIRECT", "DIRECT"],
    ["", "UNKNOWN"],
  ]) {
    const producerOutput = sanitizeProxy(resolved);
    assert.equal(
      sanitizeTelegramApprovalLogMeta({ proxy: producerOutput }).proxy,
      expected,
    );
  }
});

test("drops proxy addresses and arbitrary terminal metadata", () => {
  const safe = sanitizeTelegramApprovalLogMeta({
    outcome: "token=secret",
    mode: "http://user:password@127.0.0.1:8080",
    proxy: "PROXY 127.0.0.1:8080",
  });
  assert.deepEqual(safe, { outcome: "", mode: "", proxy: "" });
  assert.doesNotMatch(JSON.stringify(safe), /secret|password|127\.0\.0\.1/);
  for (const proxy of ["EVIL+DIRECT", "PROXY+127.0.0.1:8080", "http://u:p@h:1"]) {
    assert.equal(sanitizeTelegramApprovalLogMeta({ proxy }).proxy, "");
  }
});
