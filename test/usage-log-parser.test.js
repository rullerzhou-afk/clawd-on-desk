"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseClaudeLine } = require("../src/usage-log-parser");

test("parses an assistant line with usage", () => {
  const obj = {
    type: "assistant",
    message: {
      id: "msg_abc",
      model: "claude-opus-4-8",
      usage: { input_tokens: 3, output_tokens: 150, cache_read_input_tokens: 5000, cache_creation_input_tokens: 10000 },
      stop_reason: "end_turn",
    },
    timestamp: "2026-04-05T12:00:00Z",
    sessionId: "session-abc",
  };
  assert.deepStrictEqual(parseClaudeLine(obj), {
    messageId: "msg_abc",
    model: "claude-opus-4-8",
    input: 3,
    output: 150,
    cacheRead: 5000,
    cacheCreation: 10000,
    stopReason: "end_turn",
    ts: "2026-04-05T12:00:00Z",
    sessionId: "session-abc",
  });
});

test("returns null for non-assistant lines", () => {
  assert.strictEqual(parseClaudeLine({ type: "user", message: {} }), null);
  assert.strictEqual(parseClaudeLine({ type: "system" }), null);
});

test("returns null when usage or message.id is missing", () => {
  assert.strictEqual(parseClaudeLine({ type: "assistant", message: { id: "x" } }), null);
  assert.strictEqual(parseClaudeLine({ type: "assistant", message: { usage: { input_tokens: 1 } } }), null);
});

test("defaults missing token fields to 0 and model to unknown", () => {
  const r = parseClaudeLine({ type: "assistant", message: { id: "m", usage: { output_tokens: 5 } } });
  assert.strictEqual(r.input, 0);
  assert.strictEqual(r.output, 5);
  assert.strictEqual(r.cacheRead, 0);
  assert.strictEqual(r.model, "unknown");
});
