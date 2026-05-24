"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

describe("permission bubble HTML assets", () => {
  it("loads external bubble CSS and renderer scripts under CSP", () => {
    assert.match(bubbleHtml, /style-src 'self' 'unsafe-inline'; script-src 'self'/);
    assert.ok(bubbleHtml.includes('<link rel="stylesheet" href="bubble.css">'));
    assert.ok(bubbleHtml.includes('<script src="bubble-format.js"></script>'));
    assert.ok(bubbleHtml.includes('<script src="bubble-renderer.js"></script>'));
    assert.ok(!bubbleHtml.includes("<style>"));
    assert.doesNotMatch(bubbleHtml, /<script(?!\s+src=)[^>]*>/);
    assert.ok(bubbleHtml.indexOf('<link rel="stylesheet" href="bubble.css">') < bubbleHtml.indexOf('<script src="bubble-renderer.js"></script>'));
    // bubble-renderer.js destructures window.ClawdBubbleFormat at module top,
    // so bubble-format.js must be loaded first or the renderer throws on startup.
    assert.ok(bubbleHtml.indexOf('<script src="bubble-format.js"></script>') < bubbleHtml.indexOf('<script src="bubble-renderer.js"></script>'));
  });
});
