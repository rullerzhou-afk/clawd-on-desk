const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
} = require("../src/server").__test;

describe("permission input normalization", () => {
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

  it("caps elicitation questions/options and truncates displayed copy", () => {
    const normalized = normalizeElicitationToolInput({
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

    assert.strictEqual(normalized.questions.length, 5);
    assert.strictEqual(normalized.questions[0].options.length, 5);
    assert.strictEqual(normalized.questions[0].header.endsWith("…"), true);
    assert.strictEqual(normalized.questions[0].question.endsWith("…"), true);
    assert.strictEqual(normalized.questions[0].options[0].label.length, 80);
    assert.strictEqual(normalized.questions[0].options[0].description.length, 160);
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
