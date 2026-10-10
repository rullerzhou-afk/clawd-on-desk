"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { prepareQuestionRequest, validateQuestionAnswers, supportedVersion } = require("../src/agent-question-wire");

function request() {
  return { id: "que_test", sessionID: "ses_test", tool: { messageID: "msg_test", callID: "call_test" },
    questions: [
      { question: "Pick", header: "Choice", options: [{ label: "A, B", description: "One label" }, { label: "C", description: "Second" }], multiple: true, custom: false },
      { question: "Explain", header: "Text", options: [], custom: true },
    ] };
}

test("preserves comma-containing labels, ordered multiple answers and free text", () => {
  const wire = request();
  const prepared = prepareQuestionRequest(wire);
  assert.equal(prepared.displayInput.questions[0].allowOther, false);
  assert.equal(prepared.displayInput.questions[0].multiSelect, true);
  assert.deepEqual(validateQuestionAnswers(wire, { 0: ["A, B", "C"], 1: ["My answer"] }), [["A, B", "C"], ["My answer"]]);
});

test("rejects partial, extra, forged, blank, duplicate and ambiguous answer forms", () => {
  const wire = request();
  for (const answers of [{ 0: ["C"] }, { 0: ["C"], 1: ["yes"], 2: ["extra"] },
    { 0: "A, B, C", 1: ["yes"] }, { 0: ["forged"], 1: ["yes"] },
    { 0: ["C", "C"], 1: ["yes"] }, { 0: ["C"], 1: [" "] },
    { 0: ["C"], 1: ["one", "two"] }]) assert.equal(validateQuestionAnswers(wire, answers), null);
});

test("unsupported or identity-less native shapes remain native", () => {
  for (const mutate of [wire => delete wire.tool, wire => wire.id = "../other", wire => wire.sessionID = "",
    wire => wire.questions[0].multiple = "true", wire => wire.questions[0].custom = "false",
    wire => wire.questions[0].key = "plan_exit", wire => wire.questions[0].options.push(wire.questions[0].options[0]),
    wire => wire.questions = new Array(6).fill(wire.questions[0])]) {
    const wire = request(); mutate(wire); assert.equal(prepareQuestionRequest(wire), null);
  }
});

test("only reviewed v1 generations are version eligible", () => {
  assert.equal(supportedVersion("opencode", "1.18.31"), true);
  assert.equal(supportedVersion("mimocode", "0.1.15"), true);
  for (const [agent, version] of [["opencode", "1.18.30"], ["opencode", "2.0.15"],
    ["mimocode", "0.1.14"], ["mimocode", "0.2.0"], ["qwen-code", "1.18.31"], ["opencode", "1.18.31-dev"],
    ["opencode", "01.018.0031"], ["mimocode", "0.01.15"],
    ["opencode", "1.9007199254740992.31"], ["opencode", `1.${"9".repeat(400)}.31`]]) {
    assert.equal(supportedVersion(agent, version), false);
  }
});
