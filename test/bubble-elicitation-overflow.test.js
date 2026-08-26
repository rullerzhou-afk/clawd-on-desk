const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleCss = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.css"), "utf8");
const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");
const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

function functionBody(name) {
  const start = bubbleRenderer.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const next = bubbleRenderer.indexOf("\nfunction ", start + 1);
  return next === -1 ? bubbleRenderer.slice(start) : bubbleRenderer.slice(start, next);
}

describe("AskUserQuestion bubble overflow", () => {
  it("keeps the legacy elicitation viewport hook inert", () => {
    const body = functionBody("applyElicitationViewport");

    assert.match(body, /Intentionally a no-op/);
    assert.match(body, /one outer detail scroller/);
    assert.match(body, /caps the BrowserWindow against its target work area/);
  });

  it("reports state-owned natural height before calling the legacy viewport hook", () => {
    assert.match(bubbleRenderer, /function measureNaturalBubbleHeight\(\)/);
    assert.match(bubbleRenderer, /card\.classList\.remove\("elicitation-scrollable"\);/);
    assert.match(bubbleRenderer, /elicitationForm\.style\.maxHeight = "";/);
    assert.match(
      bubbleRenderer,
      /const height = measureNaturalBubbleHeight\(\);[\s\S]*window\.bubbleAPI\.reportHeight\(\{[\s\S]*state: currentExpanded \? "expanded" : "compact"[\s\S]*measurementEpoch[\s\S]*applyElicitationViewport\(\);/
    );
    assert.doesNotMatch(bubbleCss, /max-height:\s*calc\(100vh/);
    assert.doesNotMatch(bubbleRenderer, /max-height:\s*calc\(100vh/);
  });

  it("uses one expanded detail scroller instead of nesting scroll inside the form", () => {
    const body = functionBody("applyElicitationViewport");

    assert.doesNotMatch(body, /card\.classList\.(?:add|toggle)\("elicitation-scrollable"/);
    assert.doesNotMatch(body, /elicitationForm\.style\.maxHeight\s*=/);
    assert.match(bubbleCss, /\.detail-scroll\s*\{[\s\S]*overflow-y:\s*auto/);
    assert.match(
      bubbleCss,
      /\.elicitation-form\s*\{[^}]*flex:\s*0\s+0\s+auto\s*;/,
      "the form must retain its intrinsic height so only the outer detail scroller overflows"
    );
  });

  it("keeps permission quick actions outside the detail-only scroller", () => {
    const detailStart = bubbleHtml.indexOf('id="detailScroll"');
    const detailEnd = bubbleHtml.indexOf('id="btnExpand"');
    const suggestions = bubbleHtml.indexOf('id="suggestions"');

    assert.ok(detailStart >= 0 && detailEnd > detailStart);
    assert.ok(suggestions > detailEnd, "suggestions must remain visible when compact detail is hidden");
    assert.match(bubbleCss, /\.footer-secondary\.visible\s*\{\s*display:\s*flex;/);
    assert.doesNotMatch(bubbleCss, /\.card\.expanded\s+\.footer-secondary\.visible/);
  });

  it("keeps the truncation warning before and outside the detail scroller", () => {
    const detailStart = bubbleHtml.indexOf('id="detailScroll"');
    const detailEnd = bubbleHtml.indexOf('id="btnExpand"');
    const truncation = bubbleHtml.indexOf('id="detailTruncation"');

    assert.ok(detailStart >= 0 && detailEnd > detailStart);
    assert.ok(
      truncation >= 0 && truncation < detailStart,
      "the warning must be visible before the user starts scrolling detail"
    );
    assert.ok(
      !(truncation > detailStart && truncation < detailEnd),
      "the warning must not scroll with the detail content"
    );
  });
});
