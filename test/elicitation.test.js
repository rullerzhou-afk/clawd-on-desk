const { describe, it } = require("node:test");
const assert = require("node:assert");

const permission = require("../src/permission");
const {
  buildElicitationUpdatedInput,
  remapIndexedElicitationAnswers,
  validateAndRemapIndexedElicitationAnswers,
} = permission.__test;

describe("elicitation updated input builder", () => {
  it("echoes original questions and attaches normalized answers", () => {
    const input = {
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "Use React components" },
            { label: "Vue", description: "Use Vue components" },
          ],
        },
        {
          question: "Which platforms?",
          header: "Platforms",
          multiSelect: true,
          options: [
            { label: "macOS", description: "Desktop app support" },
            { label: "Linux", description: "Server support" },
          ],
        },
      ],
      extraField: "keep-me",
    };

    const updatedInput = buildElicitationUpdatedInput(input, {
      "Which framework?": " React ",
      "Which platforms?": "macOS, Linux",
    });

    assert.deepStrictEqual(updatedInput, {
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

    const updatedInput = buildElicitationUpdatedInput(input, {
      "Proceed?": "   ",
      "Unexpected question": "Yes",
    });

    assert.deepStrictEqual(updatedInput, {
      questions: input.questions,
      mode: "prompt",
      answers: {},
    });
  });
});

describe("indexed elicitation answer remapping", () => {
  it("maps remote index keys back to original question text, including clamp-hostile text", () => {
    const longQuestion = `Which one? ${"x".repeat(300)}`;
    const crlfQuestion = "Line one\r\nLine two  ";
    const input = {
      questions: [
        { question: longQuestion, options: [{ label: "A" }] },
        { question: crlfQuestion, options: [{ label: "B" }] },
      ],
    };

    assert.deepStrictEqual(remapIndexedElicitationAnswers(input, { "0": "A", "1": "B" }), {
      [longQuestion]: "A",
      [crlfQuestion]: "B",
    });
  });

  it("skips indices without answers, invalid questions, and non-object answer maps", () => {
    const input = {
      questions: [
        { question: "First?" },
        { header: "no question text" },
        { question: "Third?" },
      ],
    };

    assert.deepStrictEqual(remapIndexedElicitationAnswers(input, { "1": "lost", "2": "kept" }), {
      "Third?": "kept",
    });
    assert.deepStrictEqual(remapIndexedElicitationAnswers(input, null), {});
    assert.deepStrictEqual(remapIndexedElicitationAnswers(input, ["array", "not", "map"]), {});
    assert.deepStrictEqual(remapIndexedElicitationAnswers(null, { "0": "A" }), {});
  });

  it("round-trips through buildElicitationUpdatedInput without losing answers", () => {
    const longQuestion = `Deploy where? ${"y".repeat(280)}`;
    const input = { questions: [{ question: longQuestion, options: [{ label: "prod" }] }] };

    const updatedInput = buildElicitationUpdatedInput(
      input,
      remapIndexedElicitationAnswers(input, { "0": " prod " })
    );

    assert.deepStrictEqual(updatedInput.answers, { [longQuestion]: "prod" });
  });

  it("accepts only a complete, exact, non-empty answer map", () => {
    const input = {
      questions: [
        { question: "First?" },
        { question: "Second?" },
      ],
    };
    assert.deepStrictEqual(
      validateAndRemapIndexedElicitationAnswers(input, {
        "0": " yes ",
        "1": "no",
      }),
      {
        ok: true,
        answers: {
          "First?": "yes",
          "Second?": "no",
        },
      }
    );

    for (const invalid of [
      { "0": "yes" },
      { "0": "yes", "1": " " },
      { "0": "yes", "1": "no", "2": "extra" },
      ["yes", "no"],
      null,
    ]) {
      assert.strictEqual(
        validateAndRemapIndexedElicitationAnswers(input, invalid).ok,
        false
      );
    }
  });

  it("rejects duplicate upstream question keys instead of overwriting an answer", () => {
    const result = validateAndRemapIndexedElicitationAnswers(
      { questions: [{ question: "Same?" }, { question: "Same?" }] },
      { "0": "A", "1": "B" }
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /duplicate/);
  });
});
