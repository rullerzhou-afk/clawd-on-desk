"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../hooks/claude-statusline");
const { buildStatusLineText, buildStateBody, main } = __test;

describe("Claude Code statusline adapter", () => {
  it("builds status text from model, context percent, and weekly quota", () => {
    const text = buildStatusLineText(
      { context_window: { used_percentage: 8.4 } },
      { claudeWeekly: { usedPercent: 41 } },
      "Claude Sonnet 5"
    );
    assert.strictEqual(text, "Claude Sonnet 5 · 8% ctx · 41% weekly");
  });

  it("returns empty text when nothing is known", () => {
    assert.strictEqual(buildStatusLineText({}, null, null), "");
  });

  it("builds a metadata_only body carrying claude_quota, no event field", () => {
    const body = buildStateBody(
      { session_id: "abc123", workspace: { current_dir: "/work" } },
      { claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 } }
    );
    assert.deepStrictEqual(body, {
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "abc123",
      agent_id: "claude-code",
      claude_quota: { claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 } },
      cwd: "/work",
    });
  });

  it("returns null when there is no session id or no quota (nothing worth posting)", () => {
    assert.strictEqual(buildStateBody({}, { claudeWeekly: { usedPercent: 1 } }), null);
    assert.strictEqual(buildStateBody({ session_id: "abc" }, null), null);
  });

  it("main() posts state and always writes a stdout line", async () => {
    const writes = [];
    const posted = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        payload: {
          session_id: "abc123",
          model: { display_name: "Claude Sonnet 5" },
          context_window: { used_percentage: 8 },
          rate_limits: {
            five_hour: { used_percentage: 24, resets_at: 1738425600 },
            seven_day: { used_percentage: 41 },
          },
        },
        postState: (body, options, callback) => { posted.push(JSON.parse(body)); callback(false); },
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "Claude Sonnet 5 · 8% ctx · 41% weekly\n");
    assert.deepStrictEqual(posted[0].claude_quota, {
      claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
      claudeWeekly: { usedPercent: 41 },
    });
  });

  it("main() posts nothing (but still writes stdout) when rate_limits is absent", async () => {
    const writes = [];
    let postCalled = false;
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        payload: { session_id: "abc123", model: { display_name: "Claude Sonnet 5" } },
        postState: (body, options, callback) => { postCalled = true; callback(true); },
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(postCalled, false);
    assert.strictEqual(writes[0], "Claude Sonnet 5\n");
  });

  it("main() never throws and still writes stdout when stdin JSON read fails", async () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(chunk); return true; };
    try {
      await main({
        readStdinJson: () => Promise.reject(new Error("boom")),
        postState: (body, options, callback) => callback(true),
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], "\n");
  });
});
