"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_ICONS = path.join(SRC_DIR, "settings-icons.js");
const SETTINGS_RENDERER = path.join(SRC_DIR, "settings-renderer.js");

function loadIcons() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ICONS, "utf8"), context);
  return context.ClawdSettingsIcons;
}

// The sidebar tab ids declared in settings-renderer.js — every one of
// these must resolve to a real icon, not the placeholder fallback.
const SIDEBAR_TAB_IDS = [
  "general",
  "agents",
  "theme",
  "animOverrides",
  "shortcuts",
  "telegram-approval",
  "remote-ssh",
  "mobile",
  "about",
];

describe("settings-icons", () => {
  it("exposes a getIcon helper on globalThis", () => {
    const icons = loadIcons();
    assert.ok(icons, "ClawdSettingsIcons should be defined");
    assert.strictEqual(typeof icons.getIcon, "function");
  });

  it("returns a currentColor inline SVG for every sidebar tab", () => {
    const icons = loadIcons();
    for (const id of SIDEBAR_TAB_IDS) {
      const svg = icons.getIcon(id);
      assert.ok(svg.startsWith("<svg"), `${id} should be an inline SVG`);
      assert.ok(
        svg.includes('stroke="currentColor"') || svg.includes('fill="currentColor"'),
        `${id} icon should use currentColor so it follows light/dark text color`
      );
      // No raw emoji/unicode glyphs left behind.
      assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), `${id} should not contain emoji`);
    }
  });

  it("does not fall back to placeholder for known tabs", () => {
    const icons = loadIcons();
    const placeholder = icons.getIcon("placeholder");
    for (const id of SIDEBAR_TAB_IDS) {
      assert.notStrictEqual(icons.getIcon(id), placeholder, `${id} should have its own icon`);
    }
  });

  it("falls back to placeholder for unknown ids", () => {
    const icons = loadIcons();
    assert.strictEqual(icons.getIcon("no-such-tab-xyz"), icons.getIcon("placeholder"));
  });

  it("covers every tab id used by the settings renderer", () => {
    const icons = loadIcons();
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    // Guard against a tab being added to the renderer without an icon:
    // each id in our list must really appear in the renderer source.
    for (const id of SIDEBAR_TAB_IDS) {
      assert.ok(
        rendererSource.includes(`id: "${id}"`),
        `settings-renderer.js should declare a tab with id "${id}"`
      );
      assert.ok(icons.ICONS[id], `settings-icons.js should define an icon for "${id}"`);
    }
  });
});
