"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_HTML = path.join(SRC_DIR, "settings.html");
const SETTINGS_RENDERER = path.join(SRC_DIR, "settings-renderer.js");
const SETTINGS_UI_CORE = path.join(SRC_DIR, "settings-ui-core.js");
const SETTINGS_I18N = path.join(SRC_DIR, "settings-i18n.js");
const TAB_MODULES = [
  path.join(SRC_DIR, "settings-tab-general.js"),
  path.join(SRC_DIR, "settings-tab-agents.js"),
  path.join(SRC_DIR, "settings-tab-theme.js"),
  path.join(SRC_DIR, "settings-tab-anim-map.js"),
  path.join(SRC_DIR, "settings-tab-anim-overrides.js"),
  path.join(SRC_DIR, "settings-tab-shortcuts.js"),
  path.join(SRC_DIR, "settings-tab-about.js"),
];

describe("settings renderer browser environment", () => {
  it("loads browser scripts in dependency order and keeps CommonJS helpers out of settings.html", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const scriptOrder = [
      "shortcut-actions.js",
      "settings-size-slider.js",
      "settings-i18n.js",
      "settings-ui-core.js",
      "settings-tab-general.js",
      "settings-tab-agents.js",
      "settings-tab-theme.js",
      "settings-tab-anim-map.js",
      "settings-tab-anim-overrides.js",
      "settings-tab-shortcuts.js",
      "settings-tab-about.js",
      "settings-renderer.js",
    ];

    let previousIndex = -1;
    for (const scriptName of scriptOrder) {
      const marker = `<script src="${scriptName}"></script>`;
      const nextIndex = html.indexOf(marker);
      assert.notStrictEqual(nextIndex, -1, `settings.html should load ${scriptName}`);
      assert.ok(nextIndex > previousIndex, `${scriptName} should load after the previous dependency`);
      previousIndex = nextIndex;
    }

    assert.ok(
      !html.includes('<script src="settings-size-preview-session.js"></script>'),
      "settings.html must not load the main-process size preview helper"
    );
  });

  it("uses browser globals instead of CommonJS in settings renderer modules", () => {
    const rendererSource = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");

    assert.ok(rendererSource.includes("globalThis.ClawdSettingsCore"));
    assert.ok(coreSource.includes("ClawdSettingsSizeSlider"));
    assert.ok(i18nSource.includes("globalThis"));

    for (const source of [rendererSource, coreSource, i18nSource]) {
      assert.ok(!source.includes("require("));
      assert.ok(!source.includes("module.exports"));
    }

    for (const file of TAB_MODULES) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!source.includes("require("), `${path.basename(file)} must stay browser-script friendly`);
      assert.ok(!source.includes("module.exports"), `${path.basename(file)} must not use CommonJS exports`);
      assert.ok(!source.includes("settingsAPI.onChanged"), `${path.basename(file)} must not subscribe to settingsAPI.onChanged`);
      assert.ok(!source.includes("settingsAPI.onShortcutRecordKey"), `${path.basename(file)} must not subscribe to settingsAPI.onShortcutRecordKey`);
      assert.ok(!source.includes("settingsAPI.onShortcutFailuresChanged"), `${path.basename(file)} must not subscribe to settingsAPI.onShortcutFailuresChanged`);
    }
  });

  it("does not animate the size bubble's horizontal position", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const match = html.match(/\.size-bubble\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "settings.html should define a .size-bubble rule");
    assert.ok(!/transition:\s*left\b/.test(match[1]));
    assert.ok(/transition:\s*transform 0\.14s ease,\s*box-shadow 0\.18s ease;/.test(match[1]));
  });

  it("renders the size bubble tail as a separated double-layer callout instead of overlapping the pill", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(/--size-bubble-tail-size:\s*4px;/.test(html));
    assert.ok(/--size-bubble-tail-inner-size:\s*3px;/.test(html));
    assert.ok(/--size-bubble-tail-gap:\s*1px;/.test(html));
    assert.ok(/padding-top:\s*29px;/.test(html));
    assert.ok(/\.size-bubble\s*\{[\s\S]*top:\s*6px;[\s\S]*border-radius:\s*9px;[\s\S]*padding:\s*0 7px;[\s\S]*line-height:\s*1\.2;[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::before,\s*\.size-bubble::after\s*\{/.test(html));
    assert.ok(/\.size-bubble::before\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-size\)\s+solid\s+var\(--accent\);[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::after\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-inner-size\)\s+solid\s+var\(--panel-bg\);[\s\S]*\}/.test(html));
    assert.ok(!/\.size-bubble::after\s*\{[\s\S]*margin-top:\s*-1px;/.test(html));
  });
});

describe("macOS platform detection (Settings shortcut labels)", () => {
  const isMac = (platform) => (platform || "").startsWith("Mac");

  it("keeps the unified (navigator.platform startsWith 'Mac') check in settings-ui-core.js", () => {
    const source = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(
      source.includes('(navigator.platform || "").startsWith("Mac")'),
      "settings-ui-core.js must use startsWith('Mac'); word-boundary regex caused #135"
    );
  });

  it("detects every known macOS navigator.platform value", () => {
    assert.strictEqual(isMac("MacIntel"), true);
    assert.strictEqual(isMac("MacPPC"), true);
    assert.strictEqual(isMac("Mac68K"), true);
    assert.strictEqual(isMac("MacARM64"), true);
  });

  it("returns false for non-macOS platforms and degenerate values", () => {
    assert.strictEqual(isMac("Win32"), false);
    assert.strictEqual(isMac("Linux x86_64"), false);
    assert.strictEqual(isMac("iPhone"), false);
    assert.strictEqual(isMac(""), false);
    assert.strictEqual(isMac(undefined), false);
    assert.strictEqual(isMac(null), false);
  });
});
