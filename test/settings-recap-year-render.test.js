"use strict";

// Structural performance contract for the Recap year sub-page.
//
// The year grid renders 12 x 31 = 372 cells and is rebuilt on every live data
// refresh, so the render path must not pay Intl formatter construction or a
// per-cell highlight/selection sweep per build. These checks are deliberately
// structural (counts) instead of timing-based so they stay stable on CI.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "settings-tab-recap.js"), "utf8");

const STRINGS = {
  recapTitle: "Footprints", recapSubtitle: "Look back on your work trail.", recapPeriodLabel: "Period",
  recapPeriod_today: "Today", recapPeriod_week: "Week", recapPeriod_month: "Month", recapPeriod_year: "Year",
  recapTimelineLabel: "Timeline", recapTimelineDays: "days", recapTimelineHours: "hours",
  recapTimelineTodayBars: "bars", recapGridInstructions: "grid",
  recapHeadline: "You worked with {count} agents", recapInteractionHint: "hint",
  recapRecordingSince: "Since {date}", recapAgentHighlightAria: "Highlight {agent}",
  recapMetricTurns: "Turns completed", recapMetricTools: "Tool calls", recapMetricSignals: "Activity signals",
  recapMetricUnavailable: "-", recapMetricUnavailableReason: "unavailable",
  recapCellActivity: "{when}: {count} signals", recapDayCovered: "{date}: covered",
  recapDayPartial: "{date}: partial", recapDayUncovered: "{date}: uncovered",
  recapCellFuture: "{when}: future", recapCellNotStarted: "{when}: not started",
  recapCellGap: "{when}: gap", recapCellFold: "folded", recapTooltipTotal: "{count} signals",
  recapStatusCovered: "covered", recapStatusPartial: "partial", recapStatusUncovered: "uncovered",
  recapStatusFuture: "future", recapStatusNotStarted: "not started", recapStatusGap: "gap",
  recapTooltipAgent: "{count} ({percent}%)", recapLookingAt: "Looking at {agent}: {count} {unit}",
  recapCellUnitHour: "hours", recapCellUnitDay: "days", recapEmptyBody: "empty",
  recapRecordingLabel: "Record", recapRecordingDesc: "desc", recapRecordingPaused: "paused",
  recapClearLabel: "Clear", recapClearDesc: "clear desc", recapClearAction: "Clear", recapClearing: "Clearing",
  recapPrivacyTitle: "Privacy", recapLoading: "Loading", recapRetry: "Retry",
  recapUnavailable: "unavailable", recapLoadFailed: "failed",
};

class ClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean)); }
  write(values) { this.element.className = [...values].join(" "); }
  add(...names) { markTouched(this.element); const values = this.values(); for (const name of names) values.add(name); this.write(values); }
  remove(...names) { markTouched(this.element); const values = this.values(); for (const name of names) values.delete(name); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    markTouched(this.element);
    const values = this.values();
    const on = force === undefined ? !values.has(name) : !!force;
    if (on) values.add(name); else values.delete(name);
    this.write(values);
    return on;
  }
}

let touchedCells = null;
function markTouched(element) {
  if (touchedCells && typeof element.className === "string" && element.className.includes("recap-cell")) {
    touchedCells.add(element);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.eventListeners = {};
    this.className = "";
    this._textContent = "";
    this.parentNode = null;
    this.hidden = false;
    this.inert = false;
    this.tabIndex = undefined;
    this.id = undefined;
    this.style = {
      values: {},
      setProperty(name, value) { this.values[name] = String(value); },
      removeProperty(name) { delete this.values[name]; },
      getPropertyValue(name) { return this.values[name] || ""; },
    };
    this.classList = new ClassList(this);
  }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._textContent = value == null ? "" : String(value); this.children = []; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index !== -1) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "id") this.id = String(value);
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(callback);
  }
  removeEventListener(type, callback) {
    const listeners = this.eventListeners[type];
    if (!listeners) return;
    const index = listeners.indexOf(callback);
    if (index !== -1) listeners.splice(index, 1);
  }
  dispatchEvent(event) {
    if (!event.type) throw new Error("dispatchEvent requires a type");
    if (!event.target) event.target = this;
    let node = this;
    while (node) {
      event.currentTarget = node;
      for (const listener of [...(node.eventListeners[event.type] || [])]) listener(event);
      if (event.bubbles === false || event.cancelBubble) break;
      node = node.parentNode;
    }
    return !event.defaultPrevented;
  }
  querySelectorAll(selector) {
    const matches = [];
    walk(this, (element) => {
      if (element !== this && element._matches(selector)) matches.push(element);
    });
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  focus() {}
  matches() { return false; }
}

function walk(root, callback) {
  callback(root);
  for (const child of root.children) walk(child, callback);
}

function makeIntlCounter() {
  const counts = { dateTimeFormat: 0, numberFormat: 0 };
  class DateTimeFormat extends Intl.DateTimeFormat {
    constructor(...args) { super(...args); counts.dateTimeFormat += 1; }
  }
  class NumberFormat extends Intl.NumberFormat {
    constructor(...args) { super(...args); counts.numberFormat += 1; }
  }
  return { counts, value: { DateTimeFormat, NumberFormat } };
}

function sampleDay(localDate) {
  const coverageMinutes = Array(24).fill(0);
  coverageMinutes[9] = 60;
  const hourCapacities = Array(24).fill(60);
  const hours = Array(24).fill(0);
  hours[9] = 3;
  return {
    localDate,
    coverage: { coverageMinutes, hourCapacities },
    hourCapacities,
    rows: [{
      agentId: "codex",
      scope: "local",
      scopeInstance: "local-1",
      metrics: { sessionsStarted: 1, turnsCompleted: 2, toolCalls: 2, activityEvents: 3 },
      sessionsStartedPartial: false,
      hours,
    }],
  };
}

function sampleView() {
  return {
    schemaVersion: 1,
    status: "ready",
    period: "year",
    anchorDate: "2026-08-29",
    startDate: "2026-01-01",
    endDate: "2026-08-29",
    currentLocalHour: 10,
    recordingStartedDate: "2026-01-01",
    recordingStartedLocalHour: 9,
    recordingEnabled: true,
    days: [sampleDay("2026-08-29")],
  };
}

function createDocument() {
  const body = new FakeElement("body");
  // The Settings pane scroller: the tab binds one passive scroll listener to it
  // so live refreshes and hover hints can yield to an active scroll.
  const pane = new FakeElement("main");
  pane.className = "content";
  const documentValue = {
    body,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => (id === "content" ? pane : null),
    addEventListener() {},
  };
  return { document: documentValue, body, pane };
}

function mountRecapTab({ queryRecap }) {
  const { document, body, pane } = createDocument();
  const intl = makeIntlCounter();
  const context = {
    console,
    document,
    Intl: intl.value,
    setTimeout,
    clearTimeout,
    window: null,
    globalThis: null,
    settingsAPI: { queryRecap, update: async () => ({ status: "ok" }), clearRecap: async () => ({ status: "ok" }) },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  let periodChange = null;
  const makeElement = (tagName) => new FakeElement(tagName);
  const helpers = {
    t: (key) => STRINGS[key] || key,
    buildSegmentedRadio: (config) => {
      const element = makeElement("div");
      for (const option of config.options) {
        const button = makeElement("button");
        button.setAttribute("data-value", option.value);
        button.addEventListener("click", () => config.onChange(option.value));
        element.appendChild(button);
      }
      periodChange = config.onChange;
      return { element, setValue() {} };
    },
    createSubpageHost: () => ({
      render(panel, renderBody) { panel.children = []; renderBody(panel); return true; },
      dispose() {},
    }),
    buildSwitch: () => ({ element: makeElement("button"), setState() {}, setOnToggle() {}, dispose() {} }),
    buildSection: (title, rows) => {
      const section = makeElement("section");
      section.setAttribute("aria-label", String(title));
      for (const row of rows) section.appendChild(row);
      return section;
    },
    showSettingsConfirmModal: async () => "cancel",
  };
  const core = {
    state: { activeTab: "recap", snapshot: { lang: "en", recapEnabled: true } },
    runtime: { agentMetadata: [{ id: "codex", name: "Codex" }] },
    helpers,
    ops: { requestRender() {}, showToast() {} },
    tabs: {},
  };
  context.ClawdSettingsTabRecap.init(core);
  const content = makeElement("main");
  body.appendChild(content);
  core.tabs.recap.render(content);
  return {
    body,
    content,
    core,
    pane,
    counts: intl.counts,
    setPeriod(period) { periodChange(period); },
    async settle() {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    },
  };
}

function yearCard(harness) {
  const cards = harness.content.querySelectorAll(".recap-card");
  assert.equal(cards.length, 1, "one recap card is mounted");
  return cards[0];
}

test("year render constructs a bounded number of Intl formatters and reuses them across refreshes", async () => {
  let payload = sampleView();
  const harness = mountRecapTab({ queryRecap: async () => payload });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  yearCard(harness);

  const cells = harness.content.querySelectorAll(".recap-cell");
  assert.equal(cells.length, 372, "the year grid keeps 12 rows x 31 columns");
  const firstBuild = { ...harness.counts };
  assert.ok(firstBuild.dateTimeFormat <= 12,
    `year render must not build one DateTimeFormat per cell (got ${firstBuild.dateTimeFormat})`);
  assert.ok(firstBuild.numberFormat <= 6,
    `year render must not build one NumberFormat per cell (got ${firstBuild.numberFormat})`);

  payload = sampleView();
  payload.days[0].rows[0].metrics.activityEvents += 5;
  harness.core.tabs.recap.applyDataChanged();
  await harness.settle();
  yearCard(harness);
  assert.deepEqual(harness.counts, firstBuild,
    "a live data refresh reuses the cached formatters instead of rebuilding them");
});

test("year cells delegate mousedown to the grid instead of subscribing one listener per cell", async () => {
  const harness = mountRecapTab({ queryRecap: async () => sampleView() });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  const grid = harness.content.querySelector(".recap-grid");
  const cells = harness.content.querySelectorAll(".recap-cell");
  assert.equal(cells.length, 372);
  assert.equal(grid.eventListeners.mousedown.length, 1, "the grid owns the delegated mousedown handler");
  for (const cell of cells) {
    assert.equal(cell.eventListeners.mousedown, undefined,
      "a year cell must not own a mousedown listener");
    if (cell.classList.contains("recap-cell-blank")) {
      assert.deepEqual(Object.keys(cell.eventListeners), [],
        "placeholder cells stay inert");
      continue;
    }
    assert.equal(cell.eventListeners.mouseenter.length, 1);
    assert.equal(cell.eventListeners.mouseleave.length, 1);
  }

  // Event delegation resolves the owning cell from the bubbled event target,
  // and all 365 cells share one mouseenter/mouseleave function reference.
  const gridcells = cells.filter((cell) => cell.getAttribute("role") === "gridcell");
  assert.equal(gridcells.length, 365);
  assert.equal(new Set(gridcells.map((cell) => cell.eventListeners.mouseenter[0])).size, 1,
    "all year gridcells share one mouseenter handler instead of 365 closures");
  assert.equal(new Set(gridcells.map((cell) => cell.eventListeners.mouseleave[0])).size, 1,
    "all year gridcells share one mouseleave handler instead of 365 closures");
  gridcells[60].dispatchEvent({ type: "mousedown", bubbles: true });
  assert.equal(grid.getAttribute("aria-activedescendant"), gridcells[60].id);
  assert.equal(gridcells[60].classList.contains("recap-cell-keyboard"), true);
  gridcells[300].dispatchEvent({ type: "mousedown", bubbles: true });
  assert.equal(grid.getAttribute("aria-activedescendant"), gridcells[300].id);
  assert.equal(gridcells[60].classList.contains("recap-cell-keyboard"), false);
  assert.equal(gridcells[300].classList.contains("recap-cell-keyboard"), true);
});

test("agent hover only rewrites the cells that actually match", async () => {
  const harness = mountRecapTab({ queryRecap: async () => sampleView() });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  const rows = harness.content.querySelectorAll(".recap-agent-row");
  assert.equal(rows.length, 1);
  const activityCells = harness.content.querySelectorAll(".recap-cell-activity");
  assert.equal(activityCells.length, 1);

  touchedCells = new Set();
  try {
    rows[0].dispatchEvent({ type: "mouseenter" });
    assert.ok(touchedCells.size <= activityCells.length + 2,
      `hover must touch only matching cells (touched ${touchedCells.size} of 372)`);
    assert.equal(activityCells[0].classList.contains("recap-cell-hit"), true);
    assert.equal(harness.content.querySelector(".recap-grid").classList.contains("recap-grid-dim"), true);

    touchedCells = new Set();
    rows[0].dispatchEvent({ type: "mouseleave" });
    assert.ok(touchedCells.size <= activityCells.length + 2,
      `unhover must restore only the highlighted cells (touched ${touchedCells.size} of 372)`);
    assert.equal(activityCells[0].classList.contains("recap-cell-hit"), false);
    assert.equal(harness.content.querySelector(".recap-grid").classList.contains("recap-grid-dim"), false);
  } finally {
    touchedCells = null;
  }
});

test("a live data refresh waits for the settings pane to stop scrolling", async () => {
  let payload = sampleView();
  let queries = 0;
  const harness = mountRecapTab({
    queryRecap: async () => {
      queries += 1;
      return payload;
    },
  });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  const queriesAfterLoad = queries;

  harness.pane.dispatchEvent({ type: "scroll" });
  for (let index = 0; index < 5; index += 1) harness.core.tabs.recap.applyDataChanged();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(queries, queriesAfterLoad,
    "no background rebuild starts while the pane is scrolling");

  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(queries, queriesAfterLoad + 1,
    "exactly one coalesced refresh runs once the scroll settles");
});

test("cell hover hints are suppressed while the settings pane scrolls", async () => {
  const harness = mountRecapTab({ queryRecap: async () => sampleView() });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  const cell = harness.content.querySelectorAll(".recap-cell-activity")
    .find((node) => node.getAttribute("role") === "gridcell");
  assert.ok(cell, "the year grid renders at least one cell with per-agent counts");

  harness.pane.dispatchEvent({ type: "scroll" });
  cell.dispatchEvent({ type: "mouseenter" });
  assert.equal(cell.querySelectorAll(".recap-cell-segments").length, 0,
    "content streaming under the pointer must not build hint overlays");

  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(cell.querySelectorAll(".recap-cell-segments").length, 1,
    "a cell hovered when scrolling stops reveals its hint once the scroll settles");
  cell.dispatchEvent({ type: "mouseleave" });
});

test("a live data refresh on the year view patches only the changed day cell in place", async () => {
  let payload = sampleView();
  const harness = mountRecapTab({ queryRecap: async () => payload });
  await harness.settle();
  harness.setPeriod("year");
  await harness.settle();
  const initialCard = yearCard(harness);
  const initialCells = harness.content.querySelectorAll(".recap-cell");
  assert.equal(initialCells.length, 372);
  const activeCell = initialCells.find((node) => node.dataset.cellKey === "2026-08-29");
  activeCell.dispatchEvent({ type: "mouseenter" });
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(harness.content.querySelectorAll(".recap-cell-popover").length, 1,
    "hovering the cell opens its preview popover before the live refresh");
  assert.match(harness.content.querySelector(".recap-cell-popover").textContent, /3 signals.*3 \(100%\)/,
    "popover initially shows the pre-refresh activity count");

  payload = sampleView();
  payload.days[0].rows[0].metrics.activityEvents = 12;
  payload.days[0].rows[0].metrics.toolCalls = 7;
  harness.core.tabs.recap.applyDataChanged();
  await harness.settle();

  assert.equal(yearCard(harness), initialCard,
    "live refresh patches the mounted year card in place without tearing down 372 DOM nodes");
  const afterCells = harness.content.querySelectorAll(".recap-cell");
  assert.deepEqual(afterCells, initialCells, "all 372 cell DOM nodes are preserved");
  assert.equal(activeCell.classList.contains("recap-depth-2"), true,
    "the changed day cell updates its depth class in place");
  assert.equal(activeCell.querySelector(".recap-cell-segments").querySelectorAll("i")[0].style.flex, "12 1 0%",
    "open preview segments refresh to the updated count");
  assert.match(harness.content.querySelector(".recap-cell-popover").textContent, /12 signals.*12 \(100%\)/,
    "open preview popover refreshes immediately to the updated count");
  const rowMetrics = harness.content.querySelector(".recap-agent-row").querySelectorAll("dd");
  assert.deepEqual(rowMetrics.map((dd) => dd.textContent), ["2", "7", "12"],
    "agent row metrics update in place");
  activeCell.dispatchEvent({ type: "mouseleave" });
});
