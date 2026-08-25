const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  truncateDeep,
  DETAIL_TEXT_MAX_BYTES,
  clampUtf8Text,
  preparePermissionDetail,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  prepareElicitationToolInput,
  normalizeHookToolUseId,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
} = require("../src/server-permission-utils");

describe("permission input normalization", () => {
  it("truncates deeply nested preview values without mutating the source", () => {
    const source = {
      command: "x".repeat(600),
      nested: { message: "y".repeat(600) },
    };

    const normalized = truncateDeep(source);

    assert.strictEqual(normalized.command.length, 501);
    assert.strictEqual(normalized.command.endsWith("…"), true);
    assert.strictEqual(normalized.nested.message.length, 501);
    assert.strictEqual(source.command.length, 600);
  });

  it("caps suggestions at 20 and preserves a merged addRules entry", () => {
    const rawSuggestions = [
      ...Array.from({ length: 24 }, (_, index) => ({ type: "setMode", mode: `mode-${index}` })),
      { type: "addRules", destination: "localSettings", behavior: "allow", toolName: "Read", ruleContent: "src/**" },
      { type: "addRules", destination: "localSettings", behavior: "allow", toolName: "Edit", ruleContent: "docs/**" },
    ];

    const normalized = normalizePermissionSuggestions(rawSuggestions);

    assert.strictEqual(normalized.length, 20);
    assert.strictEqual(normalized[normalized.length - 1].type, "addRules");
    assert.deepStrictEqual(normalized[normalized.length - 1].rules, [
      { toolName: "Read", ruleContent: "src/**" },
      { toolName: "Edit", ruleContent: "docs/**" },
    ]);
  });

  it("refuses oversized elicitation instead of showing a partial choice set", () => {
    const prepared = prepareElicitationToolInput({
      mode: "prompt",
      questions: Array.from({ length: 7 }, (_, questionIndex) => ({
        header: `Header ${questionIndex} ${"h".repeat(80)}`,
        question: `Question ${questionIndex} ${"q".repeat(260)}`,
        options: Array.from({ length: 7 }, (_, optionIndex) => ({
          label: `Option ${optionIndex} ${"l".repeat(100)}`,
          description: `Description ${optionIndex} ${"d".repeat(200)}`,
        })),
      })),
    });

    assert.strictEqual(prepared.canAnswer, false);
    assert.strictEqual(prepared.reason, "too-many-questions");
    assert.deepStrictEqual(prepared.displayInput, { questions: [] });
  });

  it("keeps exact wire answer keys separate from bounded display copy", () => {
    const rawQuestion = `  ${"q".repeat(260)}  `;
    const rawInput = {
      mode: "prompt",
      questions: [{
        header: `Header ${"h".repeat(80)}`,
        question: rawQuestion,
        options: [{
          label: "Option A",
          description: `Description ${"d".repeat(200)}`,
        }],
      }],
    };
    const prepared = prepareElicitationToolInput(rawInput);

    assert.strictEqual(prepared.canAnswer, true);
    assert.strictEqual(prepared.wireInput, rawInput);
    assert.strictEqual(prepared.displayInput.questions[0].id, "0");
    assert.strictEqual(prepared.displayInput.questions[0].question.length, 240);
    assert.strictEqual(prepared.displayInput.questions[0].question.endsWith("…"), true);
    assert.notStrictEqual(prepared.displayInput.questions[0].question, rawQuestion);
    assert.strictEqual(prepared.displayInput.questions[0].options[0].label, "Option A");
    assert.strictEqual(prepared.displayInput.questions[0].options[0].description.length, 160);
    assert.strictEqual(prepared.detailDisplayInput.questions[0].question, rawQuestion.trim());
    assert.strictEqual(
      prepared.detailDisplayInput.questions[0].options[0].description,
      rawInput.questions[0].options[0].description
    );
    assert.strictEqual(prepared.detailDisplayInput.questions[0].detailTruncated, false);
    assert.deepStrictEqual(normalizeElicitationToolInput(rawInput), prepared.displayInput);
  });

  it("marks an Ask detail when the expanded question itself exceeds its local budget", () => {
    const prepared = prepareElicitationToolInput({
      questions: [{
        question: "q".repeat(140 * 1024),
        header: "Long prompt",
        options: [{ label: "Continue", description: "Proceed" }],
      }],
    });
    assert.strictEqual(prepared.canAnswer, true);
    assert.strictEqual(prepared.detailTruncated, true);
    assert.strictEqual(prepared.detailDisplayInput.questions[0].detailTruncated, true);
  });

  it("keeps preview truncation separate from the bounded local detail text", () => {
    const command = `${"x".repeat(2000)}END_MARKER`;
    const rawInput = { command };
    const preview = truncateDeep(rawInput);
    const detail = preparePermissionDetail("Bash", rawInput);

    assert.strictEqual(preview.command.endsWith("…"), true);
    assert.strictEqual(preview.command.includes("END_MARKER"), false);
    assert.strictEqual(detail.detailText, command);
    assert.strictEqual(detail.detailText.endsWith("END_MARKER"), true);
    assert.strictEqual(detail.detailTruncated, false);
  });

  it("marks truncation only when the selected detail text exceeds the byte budget", () => {
    const selected = preparePermissionDetail("Bash", {
      command: "echo complete",
      unrelated: "x".repeat(DETAIL_TEXT_MAX_BYTES + 100),
    });
    assert.strictEqual(selected.detailText, "echo complete");
    assert.strictEqual(selected.detailTruncated, false);

    const oversized = preparePermissionDetail("Bash", {
      command: "猫".repeat(DETAIL_TEXT_MAX_BYTES),
    });
    assert.strictEqual(oversized.detailTruncated, true);
    assert.ok(Buffer.byteLength(oversized.detailText, "utf8") <= DETAIL_TEXT_MAX_BYTES);
    assert.strictEqual(oversized.detailText.endsWith("…"), true);
  });

  it("bounds structural depth and key counts only for an unknown tool's displayed JSON", () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`key-${index}`, index])
    );
    const unknown = preparePermissionDetail("custom_tool", { manyKeys });
    assert.strictEqual(unknown.detailTruncated, true);
    assert.strictEqual(Object.keys(JSON.parse(unknown.detailText).manyKeys).length, 64);

    const known = preparePermissionDetail("Bash", {
      command: "echo complete",
      manyKeys,
    });
    assert.strictEqual(known.detailText, "echo complete");
    assert.strictEqual(known.detailTruncated, false);
  });

  it("clamps UTF-8 text without splitting a surrogate pair", () => {
    const bounded = clampUtf8Text("abc😀def", 8);
    assert.strictEqual(bounded.truncated, true);
    assert.strictEqual(bounded.text.includes("�"), false);
    assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 8);
  });

  it("refuses duplicate raw answer keys because indexed answers cannot map unambiguously", () => {
    const prepared = prepareElicitationToolInput({
      questions: [
        { question: "same", options: [] },
        { question: "same", options: [] },
      ],
    });

    assert.strictEqual(prepared.canAnswer, false);
    assert.strictEqual(prepared.reason, "duplicate-answer-key");
  });

  it("falls back when option display normalization would corrupt the answer value", () => {
    for (const [label, reason] of [
      ["", "missing-option-label"],
      [" padded ", "unsafe-option-label-preview"],
      ["x".repeat(81), "unsafe-option-label-preview"],
    ]) {
      const prepared = prepareElicitationToolInput({
        questions: [{ question: "Pick", options: [{ label }] }],
      });
      assert.strictEqual(prepared.canAnswer, false, label);
      assert.strictEqual(prepared.reason, reason, label);
    }
  });

  it("falls back when distinct wire questions collapse to the same display text", () => {
    const common = "q".repeat(240);
    const prepared = prepareElicitationToolInput({
      questions: [
        { question: `${common}a`, options: [] },
        { question: `${common}b`, options: [] },
      ],
    });

    assert.strictEqual(prepared.canAnswer, false);
    assert.strictEqual(prepared.reason, "duplicate-display-question");
  });

  it("normalizes hook tool_use_id values", () => {
    assert.strictEqual(normalizeHookToolUseId("  toolu_123  "), "toolu_123");
    assert.strictEqual(normalizeHookToolUseId("   "), null);
    assert.strictEqual(normalizeHookToolUseId(123), null);
  });

  it("normalizes Codex permission tool input with optional description", () => {
    assert.deepStrictEqual(
      normalizeCodexPermissionToolInput({ command: "npm test" }, "  Run tests  "),
      { command: "npm test", description: "Run tests" }
    );
    assert.deepStrictEqual(normalizeCodexPermissionToolInput(null, "Describe only"), {
      description: "Describe only",
    });
    assert.deepStrictEqual(normalizeCodexPermissionToolInput({ command: "npm test" }, "   "), {
      command: "npm test",
    });
  });
});

describe("normalizeToolMatchValue boundaries", () => {
  it("truncates strings longer than 240 chars with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = normalizeToolMatchValue(long);
    // impl keeps 239 chars + ellipsis (TOOL_MATCH_STRING_MAX - 1)
    assert.strictEqual(out.length, 240);
    assert.strictEqual(out.endsWith("…"), true);
  });

  it("keeps strings at or below the 240 char limit untouched", () => {
    const exact = "x".repeat(240);
    assert.strictEqual(normalizeToolMatchValue(exact), exact);
  });

  it("caps arrays at 16 entries and normalizes the kept ones", () => {
    const arr = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const out = normalizeToolMatchValue(arr);
    assert.strictEqual(out.length, 16);
    assert.strictEqual(out[0], "v0");
    assert.strictEqual(out[15], "v15");
  });

  it("caps objects at 32 sorted keys", () => {
    const obj = {};
    // Insert keys in reverse alphabetical order to confirm sort() before slice
    for (let i = 99; i >= 0; i--) obj[`k${String(i).padStart(3, "0")}`] = i;
    const out = normalizeToolMatchValue(obj);
    const keys = Object.keys(out);
    assert.strictEqual(keys.length, 32);
    // Sorted ascending: k000..k031
    assert.strictEqual(keys[0], "k000");
    assert.strictEqual(keys[31], "k031");
  });

  it("returns null once recursion depth passes the 6-level cap", () => {
    // Build an object 10 levels deep; inner-most value should be null
    const deep = { level: 0 };
    let cur = deep;
    for (let i = 1; i <= 10; i++) {
      cur.child = { level: i };
      cur = cur.child;
    }
    const out = normalizeToolMatchValue(deep);
    // Walk into the normalized structure to find where truncation hits
    let node = out;
    let lastNonNullDepth = 0;
    while (node && typeof node === "object" && node.child !== undefined) {
      if (node.child === null) break;
      lastNonNullDepth += 1;
      node = node.child;
    }
    // depth=0 is the top level; children start at depth=1. Cap is > 6, so
    // depth 7 recursion returns null. lastNonNullDepth counts the number of
    // child hops we can take before hitting null.
    assert.ok(lastNonNullDepth <= 6, `expected depth <= 6, got ${lastNonNullDepth}`);
  });

  it("produces the same fingerprint for inputs that differ only past the truncation boundary", () => {
    const base = "x".repeat(240);
    const a = { command: base + "aaaaa" };
    const b = { command: base + "bbbbb" };
    assert.strictEqual(buildToolInputFingerprint(a), buildToolInputFingerprint(b));
  });

  it("produces different fingerprints for inputs that differ inside the truncation boundary", () => {
    const a = { command: "git status" };
    const b = { command: "git commit" };
    assert.notStrictEqual(buildToolInputFingerprint(a), buildToolInputFingerprint(b));
  });
});
