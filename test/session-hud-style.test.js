const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHudHtml = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.html"), "utf8");
const sessionHudRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");

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

  it("reserves row-level space for the auto-hide pin button", () => {
    assert.match(sessionHudHtml, /\.hud\.has-pin\s+\.row\s*\{[\s\S]*padding-right:\s*28px;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\.has-pin\s+\.row\s+\.right\s*\{[\s\S]*padding-right:/);
  });

  it("marks non-focusable HUD sessions without attempting terminal focus", () => {
    assert.match(sessionHudHtml, /\.row-unfocusable\s*\{[\s\S]*cursor:\s*default;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.focus-unavailable\s*\{[\s\S]*width:\s*13px;[\s\S]*\}/);
    assert.match(sessionHudRenderer, /session\.canFocus\s*===\s*true/);
    assert.match(sessionHudRenderer, /row\.classList\.add\("row-unfocusable"\)/);
    assert.match(sessionHudRenderer, /if \(canFocus\) window\.sessionHudAPI\.focusSession\(session\.id\);/);
  });

  it("renders state labels without replacing unread completed-session bells", () => {
    assert.match(sessionHudHtml, /\.state-chip\s*\{/);
    assert.match(sessionHudHtml, /\.chip-working\s*\{/);
    assert.match(sessionHudHtml, /\.chip-worktree\s*\{/);
    assert.match(sessionHudHtml, /\.completion-bell\s*\{/);
    assert.match(sessionHudRenderer, /const STATE_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /const EVENT_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /PermissionRequest:\s*\{ key: "sessionNotification"/);
    assert.match(sessionHudRenderer, /PreCompact:\s*\{ key: "sessionSweeping"/);
    assert.match(sessionHudRenderer, /WorktreeCreate:\s*\{ key: "sessionWorktree"/);
    assert.match(sessionHudRenderer, /session\.badge === "done" && unreadSessions\.has\(session\.id\)/);
    assert.match(sessionHudRenderer, /bell\.className = "completion-bell unread-bell"/);
    assert.match(sessionHudRenderer, /RECENT_DONE_UNREAD_MS\s*=\s*60 \* 1000/);
    assert.match(sessionHudRenderer, /prev === undefined[\s\S]{0,180}unreadSessions\.add\(session\.id\)/);
    assert.doesNotMatch(sessionHudRenderer, /sessionBadgeDone[\s\S]{0,80}chip-done/);
    assert.doesNotMatch(sessionHudRenderer, /sessionCarrying/);
  });

  it("uses a compact HUD-only title without mutating the full session title", () => {
    assert.match(sessionHudRenderer, /HUD_TITLE_MAX_UNITS\s*=\s*15/);
    assert.match(sessionHudRenderer, /function shortenHudTitle\(value\)/);
    assert.match(sessionHudRenderer, /title\.textContent = shortTitle/);
    assert.match(sessionHudRenderer, /title\.title = fullTitle/);
  });

  it("updates elapsed labels without rebuilding animated rows every second", () => {
    assert.match(sessionHudRenderer, /function updateElapsedLabels\(\)/);
    assert.match(sessionHudRenderer, /elapsed\.className = "elapsed"/);
    assert.match(sessionHudRenderer, /setInterval\(updateElapsedLabels, 1000\)/);
    assert.doesNotMatch(sessionHudRenderer, /setInterval\(render, 1000\)/);
  });

  it("honors reduced motion for HUD animations", () => {
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.dot-running\s*\{[\s\S]*animation:\s*none;/);
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.unread-bell svg\s*\{[\s\S]*animation:\s*none;/);
  });
});
