const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

describe("AskUserQuestion bubble Other option", () => {
  it("defines Other copy and textarea placeholders for all supported bubble locales", () => {
    assert.match(bubbleHtml, /other: "Other",/);
    assert.match(bubbleHtml, /otherPlaceholder: "Type your answer…",/);
    assert.match(bubbleHtml, /other: "\\u5176\\u4ED6",/);
    assert.match(bubbleHtml, /otherPlaceholder: "\\u8F93\\u5165\\u4F60\\u7684\\u56DE\\u7B54\\u2026",/);
    assert.match(bubbleHtml, /other: "\\uAE30\\uD0C0",/);
    assert.match(bubbleHtml, /otherPlaceholder: "\\uC9C1\\uC811 \\uC785\\uB825\\u2026",/);
  });

  it("renders a client-side Other option with a folding textarea", () => {
    assert.match(bubbleHtml, /\.option-item-other \{ align-items: center; \}/);
    assert.match(bubbleHtml, /\.option-item-textarea \{/);
    assert.match(bubbleHtml, /const otherInput = document\.createElement\("input"\);/);
    assert.match(bubbleHtml, /otherInput\.setAttribute\("data-other", "true"\);/);
    assert.match(bubbleHtml, /const otherTextarea = document\.createElement\("textarea"\);/);
    assert.match(bubbleHtml, /otherTextarea\.setAttribute\("data-other-textarea", "true"\);/);
    assert.match(bubbleHtml, /otherTextarea\.addEventListener\("input", updateElicitationSubmitState\);/);
  });

  it("requires non-empty custom text when Other is selected and disables textareas during submit", () => {
    assert.match(bubbleHtml, /if \(!checked\.some\(input => input\.dataset\.other === "true"\)\) return true;/);
    assert.match(bubbleHtml, /return !!\(textarea && textarea\.value\.trim\(\)\);/);
    assert.match(bubbleHtml, /if \(!otherText\) return null;/);
    assert.match(bubbleHtml, /for \(const el of elicitationForm\.querySelectorAll\("input, textarea"\)\) el\.disabled = true;/);
    assert.match(bubbleHtml, /for \(const el of elicitationForm\.querySelectorAll\("input, textarea"\)\) el\.disabled = false;/);
  });
});
