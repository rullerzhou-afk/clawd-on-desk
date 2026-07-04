"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_TARGET_BYTES,
  truncateToUtf8Bytes,
  fitStateBodyToByteBudget,
} = require("../hooks/state-payload-size");

describe("state-payload-size truncateToUtf8Bytes", () => {
  it("returns the string unchanged when already within budget", () => {
    assert.strictEqual(truncateToUtf8Bytes("hello", 100), "hello");
  });

  it("never splits a multi-byte character", () => {
    const s = "你好世界".repeat(10); // 40 chars, 120 bytes
    const out = truncateToUtf8Bytes(s, 50);
    assert.ok(Buffer.byteLength(out, "utf8") <= 50);
    assert.ok(!out.includes("�")); // no replacement char from a split codepoint
    assert.ok([...out].every((ch) => "你好世界".includes(ch)));
  });

  it("cuts exactly on a character boundary", () => {
    assert.strictEqual(truncateToUtf8Bytes("ab你", 2), "ab"); // 你 starts at byte 2
    assert.strictEqual(truncateToUtf8Bytes("ab你", 4), "ab"); // 你 needs bytes 2..4
    assert.strictEqual(truncateToUtf8Bytes("ab你", 5), "ab你");
  });

  it("returns empty for a non-positive budget or non-string", () => {
    assert.strictEqual(truncateToUtf8Bytes("你好", 0), "");
    assert.strictEqual(truncateToUtf8Bytes("你好", -5), "");
    assert.strictEqual(truncateToUtf8Bytes(null, 10), "");
  });

  it("truncates 4-byte emoji on a codepoint boundary", () => {
    const s = "😀".repeat(10); // each 😀 is 4 UTF-8 bytes (40 bytes total)
    const out = truncateToUtf8Bytes(s, 10); // room for 2 whole emoji (8 bytes)
    assert.ok(Buffer.byteLength(out, "utf8") <= 10);
    assert.ok(!out.includes("�"));
    assert.ok([...out].every((ch) => ch === "😀"));
    assert.strictEqual([...out].length, 2);
  });
});

describe("state-payload-size fitStateBodyToByteBudget", () => {
  it("passes a small body through untouched (same reference)", () => {
    const body = { state: "attention", session_id: "sid", event: "Stop", assistant_last_output: "Done." };
    const r = fitStateBodyToByteBudget(body);
    assert.strictEqual(r.fitted, true);
    assert.strictEqual(r.assistantTruncated, false);
    assert.strictEqual(r.assistantDropped, false);
    assert.strictEqual(r.body, body);
  });

  it("does NOT trim a normal 2200-char CJK reply (fits under the default budget)", () => {
    const body = {
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: "字".repeat(2200), // 6600 bytes < 14336
    };
    const r = fitStateBodyToByteBudget(body);
    assert.strictEqual(r.fitted, true);
    assert.strictEqual(r.assistantTruncated, false);
    assert.strictEqual(r.assistantDropped, false);
    assert.ok(r.bytes <= DEFAULT_TARGET_BYTES);
  });

  it("truncates an oversized CJK reply and stays fitted, keeping completion fields", () => {
    const body = {
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: "字".repeat(20000), // 60000 bytes >> budget
    };
    const r = fitStateBodyToByteBudget(body);
    assert.strictEqual(r.fitted, true);
    assert.strictEqual(r.assistantTruncated, true);
    assert.strictEqual(r.assistantDropped, false);
    assert.ok(r.bytes <= DEFAULT_TARGET_BYTES);
    assert.strictEqual(r.body.assistant_last_output_truncated, true);
    assert.strictEqual(r.body.state, "attention");
    assert.strictEqual(r.body.session_id, "sid");
    assert.strictEqual(r.body.event, "Stop");
    assert.strictEqual(body.assistant_last_output.length, 20000); // input not mutated
  });

  it("drops assistant_last_output when there is no room, preserving completion + gate fields", () => {
    const body = {
      state: "attention",
      session_id: "sid",
      event: "Stop",
      background_tasks_count: 2,
      session_crons_count: 1,
      stop_hook_active: true,
      assistant_last_output: "字".repeat(50),
    };
    // Tight budget: the gate/completion fields alone nearly fill it, leaving no
    // usable room for any assistant text → drop it but keep everything else.
    const r = fitStateBodyToByteBudget(body, { targetBytes: 150 });
    assert.strictEqual(r.assistantDropped, true);
    assert.strictEqual(r.fitted, true);
    assert.strictEqual(r.body.assistant_last_output, undefined);
    assert.strictEqual(r.body.assistant_last_output_truncated, undefined);
    assert.strictEqual(r.body.state, "attention");
    assert.strictEqual(r.body.event, "Stop");
    assert.strictEqual(r.body.background_tasks_count, 2);
    assert.strictEqual(r.body.session_crons_count, 1);
    assert.strictEqual(r.body.stop_hook_active, true);
  });

  it("respects a custom targetBytes", () => {
    const body = {
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: "字".repeat(500),
    };
    const r = fitStateBodyToByteBudget(body, { targetBytes: 200 });
    assert.ok(r.bytes <= 200);
    assert.ok(r.assistantTruncated || r.assistantDropped);
  });

  it("treats a body exactly at the budget as fitted and untouched", () => {
    const body = { state: "x" };
    const exact = Buffer.byteLength(JSON.stringify(body), "utf8");
    const r = fitStateBodyToByteBudget(body, { targetBytes: exact });
    assert.strictEqual(r.fitted, true);
    assert.strictEqual(r.bytes, exact);
    assert.strictEqual(r.body, body);
  });

  it("ships an oversized body unchanged when there is no assistant_last_output to trim", () => {
    const body = { state: "working", session_id: "sid", session_title: "t".repeat(500) };
    const r = fitStateBodyToByteBudget(body, { targetBytes: 100 });
    assert.strictEqual(r.fitted, false);
    assert.strictEqual(r.assistantTruncated, false);
    assert.strictEqual(r.assistantDropped, false);
    assert.strictEqual(r.body, body); // structural fields are never trimmed
    assert.ok(r.bytes > 100);
  });

  it("drops assistant_last_output when JSON escaping inflates a trimmed copy back over budget", () => {
    // Every char is a double-quote: 1 raw byte, but 2 bytes once JSON-escaped (\").
    // There IS raw-byte room to trim into, yet escaping pushes the trimmed copy
    // back over budget — the helper must fall back to dropping, not ship oversized.
    const body = {
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: '"'.repeat(5000),
    };
    const r = fitStateBodyToByteBudget(body, { targetBytes: 250 });
    assert.strictEqual(r.assistantDropped, true);
    assert.strictEqual(r.fitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(r.body), "utf8") <= 250);
  });
});

describe("state-payload-size stdin_diag interaction (#583)", () => {
  it("preserves stdin_diag when an oversized assistant_last_output is truncated", () => {
    const body = {
      state: "attention",
      session_id: "default",
      event: "Stop",
      stdin_diag: { bytes: 0, timed_out: true, duration_ms: 2001 },
      assistant_last_output: "y".repeat(20 * 1024),
    };
    const fitted = fitStateBodyToByteBudget(body);
    assert.ok(fitted.bytes <= DEFAULT_TARGET_BYTES);
    assert.ok(fitted.assistantTruncated || fitted.assistantDropped);
    assert.deepStrictEqual(fitted.body.stdin_diag, { bytes: 0, timed_out: true, duration_ms: 2001 });
  });
});
