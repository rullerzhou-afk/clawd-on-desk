const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHudHtml = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.html"), "utf8");

describe("session HUD visual shell", () => {
  it("adds asymmetric body padding so the shadow has more room below than above", () => {
    assert.match(sessionHudHtml, /body\s*\{[\s\S]*padding:\s*2px 3px 8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*240px;[\s\S]*\}/);
  });

  it("keeps the rounded card while switching to a bottom-biased shadow", () => {
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*border-radius:\s*8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 8px 18px -12px var\(--shadow\),\s*0 2px 4px rgba\(0,\s*0,\s*0,\s*0\.10\);[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 4px 14px var\(--shadow\);[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*background:\s*var\(--hud-bg\);[\s\S]*\}/);
  });
});
