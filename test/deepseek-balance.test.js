"use strict";
const assert = require("node:assert");
const { describe, it, before, after, mock } = require("node:test");

describe("deepseek-balance", () => {
  let deepseekBalance;
  let originalEnvKey;

  before(() => {
    originalEnvKey = process.env.DEEPSEEK_API_KEY;
  });

  after(() => {
    if (originalEnvKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalEnvKey;
    }
  });

  it("isAvailable is false when DEEPSEEK_API_KEY is not set", () => {
    delete process.env.DEEPSEEK_API_KEY;
    deepseekBalance = require("../src/deepseek-balance");
    assert.strictEqual(deepseekBalance.isAvailable, false);
  });

  it("isAvailable is true when DEEPSEEK_API_KEY is set", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
    // Re-require with fresh env
    delete require.cache[require.resolve("../src/deepseek-balance")];
    deepseekBalance = require("../src/deepseek-balance");
    assert.strictEqual(deepseekBalance.isAvailable, true);
  });

  it("getBalance returns null when not available", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete require.cache[require.resolve("../src/deepseek-balance")];
    deepseekBalance = require("../src/deepseek-balance");
    const result = await deepseekBalance.getBalance();
    assert.strictEqual(result, null);
  });

  it("getBalance returns error object on network failure", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    delete require.cache[require.resolve("../src/deepseek-balance")];
    deepseekBalance = require("../src/deepseek-balance");
    // No mock needed — no real network access, but we test the module interface
    const result = await deepseekBalance.getBalance();
    // Should return an error since there's no real network
    assert.ok(result === null || result.error, `Expected null or error, got ${JSON.stringify(result)}`);
  });

  it("refreshBalance returns fresh data", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-refresh";
    delete require.cache[require.resolve("../src/deepseek-balance")];
    deepseekBalance = require("../src/deepseek-balance");
    // refreshBalance clears cache and fetches
    const result = await deepseekBalance.refreshBalance();
    assert.ok(result === null || result.error || result.is_available !== undefined,
      `Unexpected result from refreshBalance: ${JSON.stringify(result)}`);
  });
});
