"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

function loadI18n() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-i18n.js"), "utf8"), context);
  return context.ClawdSettingsI18n;
}

test("recap tab is loaded before the Settings renderer and sits directly above About", () => {
  const html = fs.readFileSync(path.join(SRC, "settings.html"), "utf8");
  const renderer = fs.readFileSync(path.join(SRC, "settings-renderer.js"), "utf8");
  assert.ok(html.indexOf('settings-tab-recap.js') < html.indexOf('settings-renderer.js'));
  assert.match(renderer, /\{ id: "recap"[\s\S]*\{ id: "about"/);
});

test("the user guide names Footprints and documents Today bars", () => {
  const guide = fs.readFileSync(path.join(__dirname, "..", "docs", "guides", "recap.md"), "utf8");
  assert.match(guide, /Settings → Footprints/);
  assert.match(guide, /Open Footprints/);
  assert.match(guide, /\*\*Today\*\*: 24 local-hour bars/);
  assert.match(guide, /newly accepted activity refreshes the visible range automatically/);
  assert.doesNotMatch(guide, /Settings → Recap|Open Recap|Record recap|Clear recap data/);
  assert.doesNotMatch(guide, /\| Active days \|/);
});

test("every supported Settings locale has the complete recap key set", () => {
  const i18n = loadI18n();
  const englishKeys = Object.keys(i18n.STRINGS.en).filter((key) => key === "sidebarRecap" || key.startsWith("recap"));
  const removedKeys = ["recapActiveDays", "recapDayActivity", "recapCoverageFootnote", "recapPausedFootnote"];
  assert.ok(englishKeys.length > 30);
  for (const lang of ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]) {
    for (const key of englishKeys) {
      assert.equal(typeof i18n.STRINGS[lang][key], "string", `${lang}.${key}`);
      assert.notEqual(i18n.STRINGS[lang][key], "", `${lang}.${key}`);
    }
    for (const key of removedKeys) assert.equal(Object.hasOwn(i18n.STRINGS[lang], key), false, `${lang}.${key}`);
  }
  assert.equal(i18n.STRINGS.zh.sidebarRecap, "足迹");
  assert.equal(i18n.STRINGS.zh.recapTitle, "足迹");
  assert.equal(i18n.STRINGS.zh.recapSubtitle, "回顾你的工作足迹。");
});

test("recap tab stays browser-only and aggregates scope rows without turning null into zero", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const core = {
    state: { snapshot: { lang: "en" }, activeTab: "recap" },
    runtime: { agentMetadata: [{ id: "codex", name: "Codex" }] },
    helpers: { t: (key) => key },
    ops: { requestRender() {}, showToast() {} },
    tabs: {},
  };
  context.ClawdSettingsTabRecap.init(core);
  assert.equal(typeof core.tabs.recap.render, "function");
  const summary = context.ClawdSettingsTabRecap.__test.summarize({
    days: [{
      rows: [
        {
          agentId: "codex",
          scope: "local",
          scopeInstance: "local-1",
          metrics: { sessionsStarted: null, turnsCompleted: 2, toolCalls: 3, activityEvents: 4 },
          sessionsStartedPartial: true,
        },
        {
          agentId: "codex",
          scope: "remote",
          scopeInstance: "remote-1",
          metrics: { sessionsStarted: 1, turnsCompleted: 1, toolCalls: 1, activityEvents: 2 },
          sessionsStartedPartial: false,
        },
      ],
    }],
  });
  assert.equal(summary.agentCount, 1);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.find((row) => row.scope === "local").sessionsStarted, null);
  assert.equal(summary.rows.find((row) => row.scope === "remote").sessionsStarted, 1);
});

test("recap card keeps day grids square, makes only today a bar chart, and exposes no export surface", () => {
  const css = fs.readFileSync(path.join(SRC, "settings.css"), "utf8");
  const preload = fs.readFileSync(path.join(SRC, "preload-settings.js"), "utf8");
  const renderer = fs.readFileSync(path.join(SRC, "settings-renderer.js"), "utf8");
  const tab = fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8");
  assert.match(css, /\.recap-cell\s*\{[\s\S]*?aspect-ratio:\s*1/);
  assert.match(css, /\.recap-grid-today \.recap-cell\s*\{[\s\S]*?aspect-ratio:\s*auto/);
  assert.match(css, /\.recap-bar-fill\s*\{[\s\S]*?height:\s*calc\(var\(--recap-bar-ratio, 0\) \* 100%\)/);
  assert.doesNotMatch(css, /\.recap-grid-today \.recap-cell-activity \.recap-bar-fill\s*\{[^}]*min-height/);
  assert.match(css, /\.recap-grid-today \.recap-cell-fold::after\s*\{[\s\S]*?bottom:\s*max\(3px, calc\(var\(--recap-bar-ratio, 0\) \* 100% - 2px\)\)/);
  assert.match(css, /\.recap-month-row[\s\S]*grid-template-columns:\s*repeat\(7/);
  assert.match(css, /\.recap-grid-dim \.recap-cell\s*\{\s*opacity:\s*0\.13/);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.recap-page-header\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(max-width:\s*780px\)[\s\S]*\.recap-agent-row\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.recap-cell-popover/);
  assert.match(preload, /queryRecap:\s*\(period\)/);
  assert.match(preload, /onRecapChanged:\s*\(cb\)/);
  assert.match(renderer, /onRecapChanged\(\(\) =>[\s\S]*?tab\.applyDataChanged\(\)/);
  assert.match(tab, /function applyDataChanged\(\)[\s\S]*?view\.refreshQueued = true;[\s\S]*?refreshIfNeeded\(\)/);
  const liveRefreshHandler = tab.match(/function applyDataChanged\(\) \{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(liveRefreshHandler, /resetInteraction\(\)/);
  assert.ok(!preload.includes("exportRecap"));
  assert.ok(!preload.includes("shareRecap"));
});

test("today bar ratios use one honest linear scale", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const ratio = context.ClawdSettingsTabRecap.__test.barRatio;
  assert.equal(ratio(0, 20), 0);
  assert.equal(ratio(5, 20), 0.25);
  assert.equal(ratio(20, 20), 1);
  assert.equal(ratio(30, 20), 1);
});

test("recap timeline models have the fixed four geometries", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const model = context.ClawdSettingsTabRecap.__test.buildTimelineModel;
  const base = {
    anchorDate: "2026-08-29",
    startDate: "2026-08-29",
    endDate: "2026-08-29",
    currentLocalHour: 23,
    recordingStartedDate: "2025-05-12",
    recordingStartedLocalHour: 9,
    days: [],
  };
  assert.equal(model(base, "today").cells.length, 24);
  assert.deepEqual(
    [model({ ...base, startDate: "2026-08-24" }, "week").rows, model({ ...base, startDate: "2026-08-24" }, "week").columns],
    [7, 24]
  );
  assert.equal(model({ ...base, startDate: "2026-08-01" }, "month").columns, 7);
  assert.equal(model({ ...base, startDate: "2026-01-01" }, "year").cells.length, 372);
  assert.deepEqual(
    [model({ ...base, startDate: "2026-01-01" }, "year").rows, model({ ...base, startDate: "2026-01-01" }, "year").columns],
    [12, 31]
  );
});

test("recap timeline separates activity, coverage, future, not-started, gap, and fold", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const model = context.ClawdSettingsTabRecap.__test.buildTimelineModel;
  const normalKinds = Array(24).fill("normal");
  normalKinds[1] = "fold";
  normalKinds[2] = "gap";
  const coverageMinutes = Array(24).fill(0);
  coverageMinutes[1] = 120;
  coverageMinutes[8] = 30;
  const hourCapacities = Array(24).fill(60);
  hourCapacities[1] = 120;
  hourCapacities[2] = 0;
  const hours = Array(24).fill(0);
  hours[9] = 3;
  const data = {
    anchorDate: "2026-08-29",
    startDate: "2026-08-29",
    endDate: "2026-08-29",
    currentLocalHour: 10,
    recordingStartedDate: "2026-08-29",
    recordingStartedLocalHour: 0,
    days: [{
      localDate: "2026-08-29",
      coverage: { coverageMinutes, hourCapacities },
      hourCapacities,
      rows: [{
        agentId: "codex",
        scope: "local",
        scopeInstance: "local-1",
        metrics: { sessionsStarted: null, turnsCompleted: 1, toolCalls: 2, activityEvents: 3 },
        hours,
      }],
    }],
  };
  const cells = model(data, "today").cells;
  assert.equal(cells[1].state, "covered");
  assert.equal(cells[1].kind, "fold");
  assert.equal(cells[2].state, "gap");
  assert.equal(cells[8].state, "partial");
  assert.equal(cells[9].state, "activity");
  assert.equal(cells[9].counts[0].count, 3);
  assert.equal(cells[10].state, "uncovered");
  assert.equal(cells[11].state, "future");

  const sameHourWindow = model({
    ...data,
    currentLocalHour: 10,
    currentLocalMinute: 45,
    currentHourElapsedMinutes: 45,
    recordingStartedLocalHour: 10,
    recordingStartedLocalMinute: 30,
    recordingStartedHourElapsedMinutes: 30,
    days: [{
      ...data.days[0],
      coverage: {
        coverageMinutes: coverageMinutes.map((value, hour) => hour === 10 ? 15 : value),
        hourCapacities,
      },
    }],
  }, "today").cells;
  assert.equal(sameHourWindow[10].state, "covered");

  const foldedSameHourWindow = model({
    ...data,
    currentLocalHour: 1,
    currentLocalMinute: 30,
    currentHourElapsedMinutes: 90,
    recordingStartedLocalHour: 1,
    recordingStartedLocalMinute: 30,
    recordingStartedHourElapsedMinutes: 30,
    days: [{
      ...data.days[0],
      coverage: {
        coverageMinutes: coverageMinutes.map((value, hour) => hour === 1 ? 60 : value),
        hourCapacities,
      },
      rows: [],
    }],
  }, "today").cells;
  assert.equal(foldedSameHourWindow[1].state, "covered");

  const partialGapCapacities = hourCapacities.slice();
  partialGapCapacities[2] = 30;
  const partialGapHours = hours.slice();
  partialGapHours[2] = 1;
  const partialGap = model({
    ...data,
    days: [{
      ...data.days[0],
      hourCapacities: partialGapCapacities,
      coverage: { coverageMinutes, hourCapacities: partialGapCapacities },
      rows: [{ ...data.days[0].rows[0], hours: partialGapHours }],
    }],
  }, "today").cells;
  assert.equal(partialGap[2].kind, "gap");
  assert.equal(partialGap[2].state, "activity", "a partial DST gap still contains real time");

  const startedLate = model({ ...data, recordingStartedLocalHour: 8 }, "today").cells;
  assert.equal(startedLate[2].state, "gap");
  assert.equal(startedLate[2].kind, "gap");
  assert.equal(startedLate[7].state, "not-started");
  assert.equal(startedLate[8].state, "partial");

  const dateline = model({
    ...data,
    anchorDate: "2026-08-29",
    recordingStartedDate: "2026-08-30",
  }, "today").cells;
  assert.equal(dateline[8].state, "partial", "real coverage must override a later frozen start date");
});

test("month and year models reserve blank and future cells without inventing activity", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const model = context.ClawdSettingsTabRecap.__test.buildTimelineModel;
  const base = {
    anchorDate: "2026-08-29",
    currentLocalHour: 12,
    recordingStartedDate: "2026-05-12",
    recordingStartedLocalHour: 9,
    days: [],
  };
  const month = model({ ...base, startDate: "2026-08-01", endDate: "2026-08-29" }, "month");
  assert.equal(month.cells.filter((cell) => cell.state === "blank").length, 5);
  assert.equal(new Set(month.cells.map((cell) => cell.key)).size, month.cells.length);
  assert.equal(month.cells.find((cell) => cell.localDate === "2026-08-30").state, "future");
  const year = model({ ...base, startDate: "2026-01-01", endDate: "2026-08-29" }, "year");
  assert.equal(year.cells[(2 - 1) * 31 + 30 - 1].state, "blank");
  assert.equal(year.cells[0].state, "not-started");
  assert.equal(year.cells[(9 - 1) * 31].state, "future");
});

test("known agent colors match the approved palette and fallbacks are deterministic", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const color = context.ClawdSettingsTabRecap.__test.agentColorToken;
  assert.equal(color("claude-code"), "var(--recap-agent-claude)");
  assert.equal(color("codex"), "var(--recap-agent-codex)");
  assert.equal(color("gemini-cli"), "var(--recap-agent-gemini)");
  assert.equal(color("reasonix"), color("reasonix"));
  assert.match(color("reasonix"), /^var\(--recap-agent-fallback-\d+\)$/);
});
