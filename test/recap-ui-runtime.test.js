"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRecapRuntime } = require("../src/recap-runtime");
const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
const createRouter = require("../src/settings-effect-router");
const SOURCE = fs.readFileSync(path.join(__dirname, "../src/settings-tab-recap.js"), "utf8");

function runtimeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-ui-"));
  const runtime = createRecapRuntime({ root: path.join(root, "recap"),
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, ...options });
  t.after(() => { runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runtime };
}

for (const withActivity of [false, true]) {
  test(`persisted ${withActivity ? "activity" : "coverage only"} stays visible after a westward timezone change`, async t => {
    let clock = Date.UTC(2026, 8, 3, 2);
    let zone = "Asia/Singapore";
    const { runtime } = runtimeFixture(t, { now: () => clock, getTimeZone: () => zone });
    const context = {};
    vm.runInNewContext(SOURCE, context);
    const model = context.ClawdSettingsTabRecap.__test.buildTimelineModel;
    runtime.start(); await runtime.whenReady();
    if (withActivity) assert.equal(runtime.record({ occurredAt: clock, agentId: "codex",
      scope: "local", metrics: ["activity", "tool-call"] },
    { sessionId: "synthetic", dedupeId: "synthetic-tool" }), true);
    clock += 10 * 60000;
    runtime.flush();
    zone = "UTC";
    runtime.flush();
    for (const period of ["today", "week"]) {
      const data = runtime.query(period);
      const day = data.days.find(item => item.localDate === "2026-09-03");
      assert.equal(day.coverage.coverageMinutes[10], 10);
      const cells = model(data, period).cells;
      const cell = cells.find(item => item.localDate === "2026-09-03" && item.hour === 10);
      assert.equal(cell.state, withActivity ? "activity" : "partial");
      assert.equal(cell.total, withActivity ? 1 : 0);
      assert.equal(cells.find(item => item.localDate === "2026-09-03" && item.hour === 11).state, "future");
    }
  });
}

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
}

for (const mode of ["malformed", "locked", "future", "normal", "off", "unavailable"]) {
  test(`recording controls expose the actual runtime state for ${mode} preferences`, async t => {
    const { root, runtime } = runtimeFixture(t, { getEnabled: () => authoritative && controller.get("recapEnabled") !== false });
    const prefPath = path.join(root, "prefs.json");
    if (mode === "malformed") fs.writeFileSync(prefPath, "{\"invalid\":");
    else if (mode === "locked") fs.mkdirSync(prefPath);
    else fs.writeFileSync(prefPath, JSON.stringify({ version: mode === "future" ? 999 : prefs.CURRENT_VERSION,
      recapEnabled: mode !== "off" }));
    const loaded = prefs.load(prefPath);
    const snapshot = loaded.snapshot;
    const authoritative = !loaded.locked && !loaded.recovered && !loaded.recoveryBackupFailed;
    const controller = createSettingsController({ prefsPath: prefPath, loadResult: loaded });
    const router = createRouter({ settingsController: controller, setRecapEnabled: value => runtime.setEnabled(value) });
    router.start();
    t.after(() => { router.dispose(); controller.dispose(); });
    runtime.start(); await runtime.whenReady();
    const data = mode === "unavailable" ? { status: "unavailable" } : runtime.query("today");
    const document = { createElement: tag => new Element(tag), addEventListener() {} };
    const context = { document };
    // Expose private controls only inside this test's isolated renderer realm.
    vm.runInNewContext(SOURCE.replace("      agentColorToken,",
      "      buildRecordingControls, view,\n      agentColorToken,"), context);
    let switchOn;
    const tab = context.ClawdSettingsTabRecap;
    tab.init({ state: { snapshot, activeTab: "recap" }, runtime: {}, tabs: {},
      ops: { requestRender() {}, showToast() {} }, helpers: { t: key => key,
        setSwitchVisual: (_sw, value) => { switchOn = value; }, buildSection: (_title, rows) => rows } });
    Object.assign(tab.__test.view, { status: data.status, data });
    const row = tab.__test.buildRecordingControls()[0];
    const desc = row.children[0].children[1];
    const paused = ["malformed", "locked", "future"].includes(mode);
    assert.equal(switchOn, mode !== "off");
    assert.equal(desc.textContent, paused ? "recapRecordingPaused" : "recapRecordingDesc");
    if (paused) {
      assert.equal(data.recordingEnabled, false);
      assert.equal(desc.attrs.role, "status");
      assert.equal(runtime.record({ occurredAt: Date.now(), agentId: "codex", scope: "local", metrics: ["activity"] }), false);
      const off = await controller.applyUpdate("recapEnabled", false);
      const on = await controller.applyUpdate("recapEnabled", true);
      const resumed = runtime.query("today");
      if (mode === "locked") {
        assert.equal(off.code, "prefs-read-failure");
        assert.equal(on.noop, true);
        assert.equal(resumed.recordingEnabled, false);
        assert.equal(controller.get("recapEnabled"), true);
        return;
      }
      assert.equal(off.status, "ok");
      assert.equal(on.status, "ok");
      assert.equal(resumed.recordingEnabled, true);
      Object.assign(tab.__test.view, { data: resumed });
      assert.equal(tab.__test.buildRecordingControls()[0].children[0].children[1].textContent, "recapRecordingDesc");
    }
  });
}
