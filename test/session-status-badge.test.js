"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const geometry = require("../src/session-status-badge-geometry");

describe("persistent status badge geometry", () => {
  it("uses a stable expanded and collapsed footprint", () => {
    assert.deepStrictEqual(geometry.computeStatusBadgeContentSize(false), {
      width: geometry.constants.STATUS_BADGE_WIDTH,
      height: geometry.constants.STATUS_BADGE_HEIGHT,
    });
    assert.deepStrictEqual(geometry.computeStatusBadgeContentSize(true), {
      width: geometry.constants.STATUS_BADGE_COLLAPSED_WIDTH,
      height: geometry.constants.STATUS_BADGE_HEIGHT,
    });
  });

  it("anchors the expanded badge at the pet's lower right", () => {
    const result = geometry.computeStatusBadgeBounds({
      hitRect: { left: 40, top: 80, right: 140, bottom: 180 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      collapsed: false,
    });
    assert.strictEqual(result.side, "right");
    assert.deepStrictEqual(result.contentBounds, {
      x: 140 + geometry.constants.STATUS_BADGE_PET_GAP,
      y: 180 - geometry.constants.STATUS_BADGE_HEIGHT,
      width: geometry.constants.STATUS_BADGE_WIDTH,
      height: geometry.constants.STATUS_BADGE_HEIGHT,
    });
  });

  it("uses the stable theme anchor instead of a larger dynamic hitbox", () => {
    const result = geometry.computeStatusBadgeBounds({
      hitRect: { left: 10, top: 40, right: 180, bottom: 220 },
      anchorRect: { left: 70, top: 90, right: 130, bottom: 170 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    });
    assert.strictEqual(result.contentBounds.x, 137);
    assert.strictEqual(result.contentBounds.y, 142);
  });

  it("keeps the collapsed working count aligned to the same lower-right edge", () => {
    const result = geometry.computeStatusBadgeBounds({
      hitRect: { left: 40, top: 80, right: 140, bottom: 180 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      collapsed: true,
    });
    assert.strictEqual(result.side, "right");
    assert.strictEqual(result.contentBounds.x, 147);
    assert.strictEqual(result.contentBounds.width, geometry.constants.STATUS_BADGE_COLLAPSED_WIDTH);
    assert.strictEqual(result.contentBounds.y, 152);
  });

  it("flips left only when the right edge cannot fit", () => {
    const result = geometry.computeStatusBadgeBounds({
      hitRect: { left: 690, top: 80, right: 770, bottom: 180 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      collapsed: false,
    });
    assert.strictEqual(result.side, "left");
    assert.strictEqual(
      result.contentBounds.x,
      690 - geometry.constants.STATUS_BADGE_PET_GAP - geometry.constants.STATUS_BADGE_WIDTH
    );
  });

  it("scales the content and shell together", () => {
    const scale = 1.6;
    const result = geometry.computeStatusBadgeBounds({
      hitRect: { left: 100, top: 100, right: 180, bottom: 220 },
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
      collapsed: false,
      scale,
    });
    assert.strictEqual(result.contentBounds.width, Math.round(geometry.constants.STATUS_BADGE_WIDTH * scale));
    assert.strictEqual(result.contentBounds.height, Math.round(geometry.constants.STATUS_BADGE_HEIGHT * scale));
  });
});

describe("persistent status badge renderer contract", () => {
  const root = path.join(__dirname, "..", "src");
  const renderer = fs.readFileSync(path.join(root, "session-status-badge-renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "session-status-badge.html"), "utf8");
  const hud = fs.readFileSync(path.join(root, "session-hud.js"), "utf8");

  it("renders working, done, and needs-input counts in one badge", () => {
    assert.match(renderer, /createMetric\("working"/);
    assert.match(renderer, /createMetric\("done"/);
    assert.match(renderer, /createMetric\("attention"/);
    assert.match(html, /\.metric-working/);
    assert.match(html, /\.metric-done/);
    assert.match(html, /\.metric-attention/);
  });

  it("collapses locally to the working metric through main-owned state", () => {
    assert.match(renderer, /sessionStatusBadgeAPI\.toggleCollapsed\(\)/);
    assert.match(html, /\.status-badge\.is-collapsed \.metric:not\(\.metric-working\)/);
    assert.match(hud, /statusBadgeCollapsed = !statusBadgeCollapsed/);
  });

  it("keeps the badge independent from the click-revealed legacy list", () => {
    assert.match(hud, /function syncStatusBadge\(/);
    assert.match(hud, /function statusBadgeEligible\(/);
    assert.match(hud, /enabled: ctx\.sessionStatusBadgeEnabled/);
    assert.doesNotMatch(
      hud.match(/function statusBadgeEligible\([\s\S]*?\n  \}/)[0],
      /ctx\.sessionHudEnabled/
    );
    assert.match(hud, /syncStatusBadge\(snapshot, scale, statusBadgeComputed, options\)/);
    assert.match(hud, /session-status-badge\.html/);
  });

  it("wires the independent preference through preferences, settings, and main", () => {
    const prefs = fs.readFileSync(path.join(root, "prefs.js"), "utf8");
    const sessions = fs.readFileSync(path.join(root, "settings-tab-sessions.js"), "utf8");
    const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
    assert.match(prefs, /sessionStatusBadgeEnabled: \{ type: "boolean", default: false \}/);
    assert.match(sessions, /key: "sessionStatusBadgeEnabled"/);
    assert.match(main, /let sessionStatusBadgeEnabled = _settingsController\.get\("sessionStatusBadgeEnabled"\)/);
    assert.match(main, /get sessionStatusBadgeEnabled\(\) \{ return sessionStatusBadgeEnabled; \}/);
    assert.match(main, /sessionStatusBadgeEnabled: \(v\) => \{ sessionStatusBadgeEnabled = v; \}/);
  });
});
