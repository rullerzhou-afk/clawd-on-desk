"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { app, BrowserWindow } = require("electron");

const SRC = path.resolve(__dirname, "../../src");
const css = fs.readFileSync(path.join(SRC, "settings.css"), "utf8");

// Group labels and row names come from the shipped dictionary.
const i18n = {};
i18n.globalThis = i18n;
vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-i18n.js"), "utf8"), i18n);
const STRINGS = i18n.ClawdSettingsI18n.STRINGS;

// The group order and rows of a connected card (see buildAgentDetailRows).
const GROUPS = [
  ["agentGroupApproval", ["rowAgentPermissions", "rowAgentSubagentPermissions"]],
  ["agentGroupAlerts", ["rowAgentIdleAlerts"]],
  ["agentGroupConnection", ["rowManageClaudeHooks", "rowStartWithClaude"]],
  ["agentGroupWsl", ["rowAgentIdleAlerts"]],
  ["agentGroupQuota", ["rowClaudeQuotaCollection"]],
  ["agentGroupInfo", ["customToolAgentId"]],
];
const LANGS = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];
// The CJK labels that fit the 58px column; Japanese "クォータ" may be wider.
const NARROW_LANGS = ["zh", "zh-TW", "ko"];
const CONTENT_WIDTH = 600;
const TOLERANCE = 0.5;

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function row(text) {
  return `<div class="row row-sub"><div class="row-text"><span class="row-label">${esc(text)}</span></div>`
    + `<div class="row-control"><span style="display:block;width:36px;height:20px;border-radius:10px;background:#999"></span></div></div>`;
}

function card(lang) {
  const strings = STRINGS[lang];
  const groups = GROUPS.map(([labelKey, rowKeys]) => (
    `<div class="agent-detail-group"><div class="agent-detail-group-label">${esc(strings[labelKey])}</div>`
    + `<div class="agent-detail-group-rows">${rowKeys.map((key) => row(strings[key])).join("")}</div></div>`
  )).join("");
  const disconnect = esc(strings.agentDisconnectLink.replace("{agent}", "Claude Code"));
  return `<div class="row collapsible-group agent-subgroup settings-disclosure" data-lang="${lang}">`
    + `<div class="collapsible-group-body settings-disclosure-body"><div class="collapsible-group-body-inner settings-disclosure-body-inner">`
    + `<div class="agent-detail-groups">${groups}</div>`
    + `<div class="agent-disconnect"><div class="agent-disconnect-row"><button class="agent-disconnect-link">${disconnect}</button></div></div>`
    + `</div></div></div>`;
}

// An IM channel card group, which shares part of the agent group's CSS.
const CHANNEL_GROUP = `<div class="settings-detail-group"><div class="settings-detail-group-label">Telegram</div>`
  + `<div class="settings-detail-group-rows">${row("Bot token")}</div></div>`;

// settings.html is lang="en" whatever the UI language, which also picks the CJK fallback fonts.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body>`
  + `<div id="stage" style="width:${CONTENT_WIDTH}px"><div class="section"><div class="section-rows">`
  + `${LANGS.map(card).join("")}${CHANNEL_GROUP}</div></div></div></body></html>`;

const MEASURE = `(() => {
  const textBox = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  };
  return {
    viewportWidth: innerWidth,
    cards: [...document.querySelectorAll("[data-lang]")].map((card) => ({
      lang: card.dataset.lang,
      groups: [...card.querySelectorAll(".agent-detail-group")].map((group) => {
        const label = group.querySelector(".agent-detail-group-label");
        const rows = group.querySelector(".agent-detail-group-rows");
        const labelBox = label.getBoundingClientRect();
        return {
          label: label.textContent,
          labelWidth: labelBox.width,
          labelBottom: labelBox.bottom,
          labelTextRight: textBox(label).right,
          firstRowTextLeft: textBox(group.querySelector(".row-label")).left,
          groupLeft: group.getBoundingClientRect().left,
          rowsLeft: rows.getBoundingClientRect().left,
          rowsTop: rows.getBoundingClientRect().top,
        };
      }),
    })),
    channelColumns: getComputedStyle(document.querySelector(".settings-detail-group")).gridTemplateColumns,
  };
})()`;

async function measure(win) {
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  return win.webContents.executeJavaScript(MEASURE);
}

function assertWide(layout) {
  assert.ok(layout.viewportWidth > 720, `fixture must be wider than the single-column breakpoint: ${layout.viewportWidth}`);
  for (const { lang, groups } of layout.cards) {
    assert.equal(groups.length, GROUPS.length, lang);
    for (const group of groups) {
      const detail = `${lang} / ${group.label}: ${JSON.stringify(group)}`;
      assert.ok(group.labelTextRight < group.firstRowTextLeft, `label overlaps the row text; ${detail}`);
      assert.ok(group.firstRowTextLeft - group.labelTextRight >= 7.5, `label touches the row text; ${detail}`);
      assert.ok(Math.abs(group.rowsLeft - groups[0].rowsLeft) <= TOLERANCE, `rows start on different lines; ${detail}`);
      assert.ok(Math.abs(group.labelWidth - groups[0].labelWidth) <= TOLERANCE, `groups use different label columns; ${detail}`);
    }
  }
  assert.deepEqual(layout.cards.map((entry) => entry.lang), LANGS);
  const byLang = Object.fromEntries(layout.cards.map((entry) => [entry.lang, entry.groups]));
  for (const lang of NARROW_LANGS) {
    for (const group of byLang[lang]) {
      assert.ok(Math.abs(group.labelWidth - 58) <= TOLERANCE, `${lang} label column must stay 58px: ${JSON.stringify(group)}`);
    }
  }
  for (const lang of ["es", "pt-BR"]) {
    assert.ok(byLang[lang][0].labelWidth > 58 + TOLERANCE, `${lang} should widen the label column: ${byLang[lang][0].labelWidth}`);
  }
  assert.equal(layout.channelColumns.split(" ")[0], "120px", `channel group columns changed: ${layout.channelColumns}`);
}

function assertSingleColumn(layout) {
  assert.ok(layout.viewportWidth < 720, `fixture must be narrower than the breakpoint: ${layout.viewportWidth}`);
  for (const { lang, groups } of layout.cards) {
    for (const group of groups) {
      const detail = `${lang} / ${group.label}: ${JSON.stringify(group)}`;
      assert.ok(Math.abs(group.rowsLeft - group.groupLeft) <= TOLERANCE, `narrow windows stack the rows under the label; ${detail}`);
      assert.ok(group.labelBottom <= group.rowsTop + TOLERANCE, `label must sit above the rows; ${detail}`);
    }
  }
}

async function main() {
  const profile = process.env.CLAWD_AGENT_GROUP_LAYOUT_PROFILE;
  assert.ok(profile && path.isAbsolute(profile), "the test runner must supply an isolated profile");
  app.setPath("userData", profile);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 900, height: 700, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    assertWide(await measure(win));
    win.setContentSize(680, 700);
    assertSingleColumn(await measure(win));
    console.log("PASS: agent card group labels clear their rows in all seven languages; narrow windows stay single column");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
