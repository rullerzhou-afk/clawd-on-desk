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
          model: "claude-opus-4-5",
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

  it("uses a 1M limit for models with a 1M context window by default", () => {
    // Claude Opus 4.6+, Sonnet 4.6+/5, Fable 5, and Mythos ship 1M context
    // as the model default (no beta header, no "[1m]" marker in transcripts).
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8-20250929",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-mythos-preview",
    ]) {
      assert.strictEqual(resolveClaudeContextLimit(model), 1000000, model);
    }

    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
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

  it("keeps the 200k limit for models without a 1M context window", () => {
    for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"]) {
      assert.strictEqual(resolveClaudeContextLimit(model), 200000, model);
    }
  });

  it("falls back to the [1m] marker for models not in the table (legacy 1M beta, proxy echoes)", () => {
    // claude-opus-4-5 defaults to 200k and isn't in CLAUDE_1M_CONTEXT_MODEL_TOKENS,
    // but the request-side model id (echoed back by some API proxies, or present
    // pre-table on legacy transcripts) still carries the beta marker.
    assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-5[1m]"), 1000000);
    // Table match and marker match agree for models that are in both.
    assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-8[1m]"), 1000000);
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

  it("skips sidechain sub-agent usage and falls back to the main-chain entry", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 150000 } },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 12000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 150000,
      limit: 200000,
      percent: 75,
      source: "claude",
    });
  });

  it("ignores usage from a different session", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        sessionId: "sess-1",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 90000 } },
      },
      {
        type: "assistant",
        sessionId: "other",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 90000,
      limit: 200000,
      percent: 45,
      source: "claude",
    });
  });

  it("skips API-error entries that carry a usage object", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50000 } },
      },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 50000,
      limit: 200000,
      percent: 25,
      source: "claude",
    });
  });

  it("counts entries without a sessionId field even when a session is given", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 8000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 8000,
      limit: 200000,
      percent: 4,
      source: "claude",
    });
  });

  it("skips non-assistant entries that carry a usage object", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50000 } },
      },
      {
        type: "summary",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 50000,
      limit: 200000,
      percent: 25,
      source: "claude",
    });
  });

  it("still counts a real-session entry when no session id is provided", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        sessionId: "real-uuid",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 2000 } },
      },
    ], null);

    assert.deepStrictEqual(usage, {
      used: 2000,
      limit: 200000,
      percent: 1,
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
