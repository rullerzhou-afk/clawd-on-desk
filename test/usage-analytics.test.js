"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createUsageAnalytics,
  localDayKey,
  normalizeTokenUsage,
} = require("../src/usage-analytics");

describe("normalizeTokenUsage", () => {
  it("accepts explicit input and output token fields", () => {
    assert.deepStrictEqual(normalizeTokenUsage({ input: 10, output: 5 }), {
      input: 10,
      output: 5,
      total: 15,
      hasInputOutput: true,
    });
    assert.deepStrictEqual(normalizeTokenUsage({ prompt_tokens: 7, completion_tokens: 8 }), {
      input: 7,
      output: 8,
      total: 15,
      hasInputOutput: true,
    });
    assert.deepStrictEqual(normalizeTokenUsage({ tokens: { input: 3, output: 4 } }), {
      input: 3,
      output: 4,
      total: 7,
      hasInputOutput: true,
    });
    assert.deepStrictEqual(normalizeTokenUsage({ usage: { input_tokens: 12, output_tokens: 9 } }), {
      input: 12,
      output: 9,
      total: 21,
      hasInputOutput: true,
    });
  });

  it("accepts total-only usage without inventing input and output", () => {
    assert.deepStrictEqual(normalizeTokenUsage({ total: 99 }), {
      input: null,
      output: null,
      total: 99,
      hasInputOutput: false,
    });
    assert.deepStrictEqual(normalizeTokenUsage({ usage: { total_tokens: 40 } }), {
      input: null,
      output: null,
      total: 40,
      hasInputOutput: false,
    });
  });

  it("rejects malformed, negative, fractional, and text-only values", () => {
    assert.strictEqual(normalizeTokenUsage(null), null);
    assert.strictEqual(normalizeTokenUsage({ text: "hello world" }), null);
    assert.strictEqual(normalizeTokenUsage({ input: 1.5, output: 2 }), null);
    assert.strictEqual(normalizeTokenUsage({ input: -1, output: 2 }), null);
    assert.strictEqual(normalizeTokenUsage({ total: Number.MAX_SAFE_INTEGER + 1 }), null);
  });

  it("uses a valid explicit total when provided beside input and output", () => {
    assert.deepStrictEqual(normalizeTokenUsage({ input: 3, output: 4, total: 10 }), {
      input: 3,
      output: 4,
      total: 10,
      hasInputOutput: true,
    });
  });
});

describe("localDayKey", () => {
  it("formats local calendar days", () => {
    assert.match(localDayKey(Date.parse("2026-05-28T10:00:00")), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("createUsageAnalytics", () => {
  it("deduplicates token usage by usageEventId", () => {
    const usage = createUsageAnalytics({ now: () => Date.parse("2026-05-28T10:00:00") });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "codex",
      sessionId: "s1",
      usageEventId: "u1",
      tokenUsage: { input: 10, output: 5 },
    });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:01"),
      agentId: "codex",
      sessionId: "s1",
      usageEventId: "u1",
      tokenUsage: { input: 10, output: 5 },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:00:02"), days: 1 });

    assert.strictEqual(snap.today.totals.tokens, 15);
    assert.strictEqual(snap.today.totals.input, 10);
    assert.strictEqual(snap.today.totals.output, 5);
    assert.strictEqual(snap.today.agents[0].agentId, "codex");
    assert.strictEqual(snap.today.agents[0].tokens, 15);
  });

  it("tracks session and active time for live sessions", () => {
    const usage = createUsageAnalytics();
    usage.recordState({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "claude-code",
      sessionId: "s1",
      state: "thinking",
    });
    usage.recordState({
      at: Date.parse("2026-05-28T10:10:00"),
      agentId: "claude-code",
      sessionId: "s1",
      state: "idle",
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:20:00"), days: 1 });

    assert.strictEqual(snap.today.totals.sessionMs, 20 * 60 * 1000);
    assert.strictEqual(snap.today.totals.activeMs, 10 * 60 * 1000);
  });

  it("splits session and active time across local days", () => {
    const usage = createUsageAnalytics();
    usage.recordState({
      at: Date.parse("2026-05-28T23:50:00"),
      agentId: "codex",
      sessionId: "s1",
      state: "working",
    });
    usage.recordState({
      at: Date.parse("2026-05-29T00:10:00"),
      agentId: "codex",
      sessionId: "s1",
      state: "sleeping",
      event: "SessionEnd",
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-29T00:10:00"), days: 2 });
    const first = snap.days[0];
    const second = snap.days[1];

    assert.strictEqual(first.totals.sessionMs, 10 * 60 * 1000);
    assert.strictEqual(second.totals.sessionMs, 10 * 60 * 1000);
    assert.strictEqual(first.totals.activeMs, 10 * 60 * 1000);
    assert.strictEqual(second.totals.activeMs, 10 * 60 * 1000);
  });

  it("rebuilds daily aggregates from ledger entries", () => {
    const usage = createUsageAnalytics();
    usage.loadLedgerLines([
      JSON.stringify({
        type: "token",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        usageEventId: "u1",
        tokenUsage: { input: 2, output: 3 },
      }),
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "working",
      }),
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:05:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "sleeping",
        event: "SessionEnd",
      }),
    ]);

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:05:00"), days: 1 });

    assert.strictEqual(snap.today.totals.tokens, 5);
    assert.strictEqual(snap.today.totals.sessionMs, 5 * 60 * 1000);
  });

  it("can rebuild ledger history without projecting restored open sessions", () => {
    const usage = createUsageAnalytics();
    usage.loadLedgerLines([
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "working",
      }),
    ], { keepOpenSessions: false });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T11:00:00"), days: 1 });

    assert.strictEqual(snap.today.totals.sessionMs, 0);
    assert.strictEqual(snap.today.totals.activeMs, 0);
  });
});
