const { describe, it } = require("node:test");
const assert = require("node:assert");

const permission = require("../src/permission");
const { buildElicitationUpdatedInput } = permission.__test;

describe("elicitation updatedInput builder", () => {
  it("echoes original questions and attaches normalized answers", () => {
    const input = {
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
        },
        {
          question: "Which platforms?",
          header: "Platforms",
          multiSelect: true,
          options: [{ label: "macOS" }, { label: "Linux" }],
        },
      ],
      extraField: "keep-me",
    };

    const updated = buildElicitationUpdatedInput(input, {
      "Which framework?": " React ",
      "Which platforms?": "macOS, Linux",
    });

    assert.deepStrictEqual(updated, {
      questions: input.questions,
      extraField: "keep-me",
      answers: {
        "Which framework?": "React",
        "Which platforms?": "macOS, Linux",
      },
    });
  });

  it("drops unknown or blank answers", () => {
    const input = {
      questions: [
        { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
      ],
      mode: "prompt",
    };

    const updated = buildElicitationUpdatedInput(input, {
      "Proceed?": "   ",
      "Unexpected question": "Yes",
    });

    assert.deepStrictEqual(updated, {
      questions: input.questions,
      mode: "prompt",
      answers: {},
    });
  });
});
