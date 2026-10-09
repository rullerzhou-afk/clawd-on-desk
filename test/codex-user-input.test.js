"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  LIMITS,
  normalizeCodexUserInputWire,
  parseCodexUserInputRecord,
} = require("../hooks/codex-user-input");

describe("Codex request_user_input transcript parsing", () => {
  it("normalizes a request and its matching output record", () => {
    const request = parseCodexUserInputRecord({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_123",
        arguments: JSON.stringify({
          questions: [{
            id: "scope",
            header: "Scope",
            question: "Which scope should I use?",
            options: [
              { label: "Focused", description: "Only this module" },
              { label: "Broad", description: "All integrations" },
            ],
          }],
          autoResolutionMs: 60_000,
        }),
      },
    });

    assert.deepStrictEqual(request, {
      phase: "request",
      callId: "call_123",
      questions: [{
        id: "scope",
        header: "Scope",
        question: "Which scope should I use?",
        options: [
          { label: "Focused", description: "Only this module" },
          { label: "Broad", description: "All integrations" },
        ],
        isOther: false,
        isSecret: false,
      }],
      autoResolutionMs: 60_000,
    });
    assert.deepStrictEqual(parseCodexUserInputRecord({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_123", output: "{}" },
    }), { phase: "resolved", callId: "call_123" });
  });

  it("rejects malformed records and clamps untrusted wire fields", () => {
    assert.strictEqual(parseCodexUserInputRecord({
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input", call_id: "x", arguments: "{" },
    }), null);
    assert.strictEqual(parseCodexUserInputRecord({
      type: "response_item",
      payload: { type: "function_call", name: "unrelated", call_id: "x", arguments: "{}" },
    }), null);

    const wire = normalizeCodexUserInputWire({
      phase: "request",
      call_id: "c".repeat(500),
      questions: Array.from({ length: 8 }, (_, index) => ({
        id: `q${index}`,
        header: "h".repeat(100),
        question: "q".repeat(500),
        options: Array.from({ length: 8 }, () => ({ label: "l".repeat(100), description: "d".repeat(300) })),
      })),
      auto_resolution_ms: 999_999,
    });
    assert.strictEqual(wire.callId.length, LIMITS.callId);
    assert.strictEqual(wire.questions.length, LIMITS.questions);
    assert.strictEqual(wire.questions[0].options.length, LIMITS.options);
    assert.strictEqual(wire.questions[0].question.length, LIMITS.question);
    assert.strictEqual(wire.autoResolutionMs, LIMITS.autoResolutionMs);
  });
});
