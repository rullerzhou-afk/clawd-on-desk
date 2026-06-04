"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  extractClaudeContextUsageFromEntries,
  resolveClaudeContextLimit,
} = require("../hooks/context-usage");

describe("Claude context usage parser", () => {
  it("extracts the latest assistant input usage with cache tokens", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 400,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 4400,
      limit: 200000,
      percent: 2,
      source: "claude",
    });
  });

  it("excludes assistant output tokens to match Claude /context", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-opus-4.7",
          usage: {
            input_tokens: 76578,
            output_tokens: 837,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 76578,
      limit: 200000,
      percent: 38,
      source: "claude",
    });
  });

  it("uses a 1M limit for Claude models marked with 1m context", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8[1m]",
          usage: {
            input_tokens: 250000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 250000,
      limit: 1000000,
      percent: 25,
      source: "claude",
    });
  });

  it("uses the latest usage entry from a transcript tail", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1000 },
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 2000, cache_read_input_tokens: 1000 },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 3000,
      limit: 200000,
      percent: 2,
      source: "claude",
    });
  });

  it("ignores entries without usage", () => {
    assert.strictEqual(extractClaudeContextUsageFromEntries([{ type: "user" }]), null);
  });

  it("returns raw used without percent for unknown model limits", () => {
    assert.strictEqual(resolveClaudeContextLimit("mystery-model"), null);
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "mystery-model",
          usage: { input_tokens: 123 },
        },
      },
    ]);

    assert.deepStrictEqual(usage, { used: 123, source: "claude" });
  });
});
