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
const PRELOAD_SETTINGS = path.join(SRC_DIR, "preload-settings.js");
const MAIN_PROCESS = path.join(SRC_DIR, "main.js");
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
      "settings-agent-order.js",
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
    const agentOrderSource = fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8");

    assert.ok(rendererSource.includes("globalThis.ClawdSettingsCore"));
    assert.ok(coreSource.includes("ClawdSettingsSizeSlider"));
    assert.ok(i18nSource.includes("globalThis"));
    assert.ok(agentOrderSource.includes("globalThis"));
    assert.ok(agentOrderSource.includes("module.exports"));

    for (const source of [rendererSource, coreSource, i18nSource]) {
      assert.ok(!source.includes("require("));
      assert.ok(!source.includes("module.exports"));
    }
    assert.ok(!agentOrderSource.includes("require("));

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

  it("exposes split bubble controls in the General tab without reviving hide-all UI", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(generalSource.includes("buildBubblePolicyRow()"));
    assert.ok(generalSource.includes("setBubbleCategoryEnabled"));
    assert.ok(generalSource.includes("confirmDisableUpdateBubbles"));
    assert.ok(generalSource.includes("category === \"update\" && next === 0"));
    assert.ok(generalSource.includes("notificationBubbleAutoCloseSeconds"));
    assert.ok(generalSource.includes("updateBubbleAutoCloseSeconds"));
    assert.ok(generalSource.includes("bubble-policy-prefix"));
    assert.ok(generalSource.includes('input.type = "text"'));
    assert.ok(generalSource.includes("input.maxLength = 4"));
    assert.ok(generalSource.includes('input.pattern = "[0-9]*"'));
    assert.ok(generalSource.includes('input.value.replace(/\\D+/g, "").slice(0, 4)'));
    assert.ok(generalSource.includes("showSettingsConfirmModal"));
    assert.ok(generalSource.includes("updateBubbleDisableConfirmTitle"));
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*width:\s*42px;/.test(html));
    assert.ok(/\.bubble-policy-seconds\s*\{[\s\S]*box-sizing:\s*border-box;[\s\S]*text-align:\s*center;[\s\S]*padding:\s*0 3px;/.test(html));
    assert.ok(!generalSource.includes("rowHideBubbles"));
    assert.ok(i18nSource.includes("rowBubblePolicy"));
    assert.ok(i18nSource.includes("bubbleUpdateWarning"));
    assert.ok(i18nSource.includes("bubbleSecondsPrefix"));
  });

  it("keeps update bubble disable confirmation inside the Settings renderer", () => {
    const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
    const mainSource = fs.readFileSync(MAIN_PROCESS, "utf8");
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(generalSource.includes("settings-confirm-modal"));
    assert.ok(generalSource.includes("updateBubbleDisableConfirmAction"));
    assert.ok(html.includes(".settings-confirm-modal"));
    assert.ok(html.includes(".settings-confirm-backdrop"));
    assert.ok(!preloadSource.includes("confirmDisableUpdateBubbles"));
    assert.ok(!preloadSource.includes("settings:confirm-disable-update-bubbles"));
    assert.ok(!mainSource.includes("UPDATE_BUBBLE_DIALOG_STRINGS"));
    assert.ok(!mainSource.includes('ipcMain.handle("settings:confirm-disable-update-bubbles"'));
    assert.ok(i18nSource.includes("Hide update bubbles"));
    assert.ok(i18nSource.includes("隐藏更新气泡"));
  });

  it("provides a persisted collapsible Settings group helper with smart default collapse", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(coreSource.includes("COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("function buildCollapsibleGroup("));
    assert.ok(coreSource.includes("localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)"));
    assert.ok(coreSource.includes("localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY"));
    assert.ok(coreSource.includes("defaultCollapsed = false"));
    assert.ok(coreSource.includes('header.setAttribute("aria-expanded"'));
    assert.ok(coreSource.includes("collapsibleSummary"));
    assert.ok(html.includes(".collapsible-group-header"));
    assert.ok(html.includes(".collapsible-group-chevron"));
    assert.ok(i18nSource.includes("collapsibleExpand"));
    assert.ok(i18nSource.includes("collapsibleCollapse"));
  });

  it("animates collapsible Settings groups with measured height instead of instant hidden jumps", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(coreSource.includes("function measureCollapsibleBodyHeight("));
    assert.ok(coreSource.includes('body.style.setProperty("--collapsible-body-height"'));
    assert.ok(coreSource.includes("requestAnimationFrame(() => {"));
    assert.ok(coreSource.includes("collapsing"));
    assert.ok(coreSource.includes("expanding"));
    assert.ok(coreSource.includes("function setBodyInteractivity(isCollapsed)"));
    assert.ok(coreSource.includes('body.setAttribute("aria-hidden"'));
    assert.ok(coreSource.includes("body.inert = isCollapsed"));
    assert.ok(!coreSource.includes("body.hidden = collapsed;"));
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*max-height:\s*var\(--collapsible-body-height,\s*0px\);/.test(html));
    assert.ok(/\.collapsible-group-body\s*\{[\s\S]*transition:\s*max-height 0\.22s cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\),\s*opacity 0\.16s ease,\s*transform 0\.18s ease,\s*padding 0\.18s ease,\s*border-color 0\.18s ease;/.test(html));
    assert.ok(/\.collapsible-group\.collapsed\s+\.collapsible-group-body\s*\{[\s\S]*opacity:\s*0;[\s\S]*transform:\s*translateY\(-4px\);/.test(html));
    assert.ok(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.collapsible-group-body/.test(html));
  });

  it("collapses only the detailed bubble policy controls while keeping primary bubble rows visible", () => {
    const generalSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-general.js"), "utf8");
    const i18nSource = fs.readFileSync(SETTINGS_I18N, "utf8");
    assert.ok(generalSource.includes("buildBubblePolicySummary"));
    assert.ok(generalSource.includes("helpers.buildCollapsibleGroup({"));
    assert.ok(generalSource.includes('id: "general:bubble-policy"'));
    assert.ok(generalSource.includes("defaultCollapsed: true"));
    assert.ok(generalSource.includes('title: t("rowBubblePolicy")'));
    assert.ok(generalSource.includes("summary: buildBubblePolicySummary()"));
    assert.ok(generalSource.includes("children: [buildBubblePolicyList()]"));
    assert.ok(generalSource.includes('key: "bubbleFollowPet"'));
    assert.ok(!generalSource.includes('key: "showSessionId"'));
    assert.ok(!generalSource.includes('key: "hideBubbles"'));
    assert.ok(i18nSource.includes("bubblePolicySummaryPermission"));
    assert.ok(i18nSource.includes("bubblePolicySummaryNotification"));
    assert.ok(i18nSource.includes("bubblePolicySummaryUpdate"));
  });

  it("renders Agent management as collapsed per-agent groups with master switches always visible", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    assert.ok(agentsSource.includes("function buildAgentGroup(agent)"));
    assert.ok(agentsSource.includes("const masterRow = buildAgentMasterRow(agent);"));
    assert.ok(agentsSource.includes("const detailRows = buildAgentDetailRows(agent);"));
    assert.ok(agentsSource.includes('id: `agents:${agent.id}`'));
    assert.ok(agentsSource.includes("defaultCollapsed: true"));
    assert.ok(agentsSource.includes("headerContent: masterRow"));
    assert.ok(agentsSource.includes("children: detailRows"));
    assert.ok(agentsSource.includes("ev.stopPropagation();"));
    assert.ok(agentsSource.includes("agent-subgroup"));
  });

  it("uses a dedicated Settings agent ordering helper before rendering Agent management groups", () => {
    const agentsSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-agents.js"), "utf8");
    const agentOrderSource = fs.readFileSync(path.join(SRC_DIR, "settings-agent-order.js"), "utf8");
    assert.ok(agentOrderSource.includes("function isAgentCollapsible("));
    assert.ok(agentOrderSource.includes("function sortAgentMetadataForSettings("));
    assert.ok(agentOrderSource.includes("COLLAPSIBLE_AGENT_PRIORITY"));
    assert.ok(agentOrderSource.includes("NON_COLLAPSIBLE_AGENT_PRIORITY"));
    assert.ok(agentsSource.includes("ClawdSettingsAgentOrder"));
    assert.ok(agentsSource.includes("sortAgentMetadataForSettings(runtime.agentMetadata"));
  });

  it("keeps stale sound override prefs resettable from the settings UI", () => {
    const overridesSource = fs.readFileSync(path.join(SRC_DIR, "settings-tab-anim-overrides.js"), "utf8");
    assert.ok(
      overridesSource.includes("resetBtn.disabled = !slot.hasStoredOverride;"),
      "sound override row reset must stay enabled when prefs still contain a stale sound override entry"
    );
  });

  it("counts sound overrides in the theme-overrides reset gate", () => {
    const coreSource = fs.readFileSync(SETTINGS_UI_CORE, "utf8");
    assert.ok(
      coreSource.includes("function hasAnyThemeOverride(themeId)"),
      "settings-ui-core.js should expose a helper for any stored theme override"
    );
    assert.ok(
      coreSource.includes("...(map.sounds ? Object.keys(map.sounds) : []),"),
      "sound overrides must participate in the global reset-all gate"
    );
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
