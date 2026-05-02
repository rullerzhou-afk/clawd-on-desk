const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

function functionBody(name) {
  const start = bubbleHtml.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const next = bubbleHtml.indexOf("\nfunction ", start + 1);
  return next === -1 ? bubbleHtml.slice(start) : bubbleHtml.slice(start, next);
}

describe("AskUserQuestion bubble overflow", () => {
  it("documents applyElicitationViewport as a no-op until the overflow redesign lands", () => {
    const body = functionBody("applyElicitationViewport");

    assert.match(body, /Intentionally a no-op/);
    assert.match(body, /The correct approach: let the form grow to its natural height/);
    assert.match(body, /permission\.js clampBubbleHeight\(\) already caps the window/);
  });

  it("reports natural content height before calling the no-op viewport hook", () => {
    assert.match(bubbleHtml, /function measureNaturalBubbleHeight\(\)/);
    assert.match(bubbleHtml, /card\.classList\.remove\("elicitation-scrollable"\);/);
    assert.match(bubbleHtml, /elicitationForm\.style\.maxHeight = "";/);
    assert.match(
      bubbleHtml,
      /window\.bubbleAPI\.reportHeight\(measureNaturalBubbleHeight\(\)\);[\s\S]*applyElicitationViewport\(\);/
    );
    assert.doesNotMatch(bubbleHtml, /max-height:\s*calc\(100vh/);
  });

  it("does not make the no-op viewport hook add internal scrolling or a max-height clamp", () => {
    const body = functionBody("applyElicitationViewport");

    // Long-prompt overflow remains deferred to the #222 redesign; this guard only
    // prevents tests from implying the current no-op provides runtime scrolling.
    assert.doesNotMatch(body, /card\.classList\.(?:add|toggle)\("elicitation-scrollable"/);
    assert.doesNotMatch(body, /elicitationForm\.style\.maxHeight\s*=/);
  });
});
