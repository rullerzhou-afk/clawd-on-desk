"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");
const createSettingsEffectRouter = require("../src/settings-effect-router");

function controller(snapshot) {
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    subscribeKey() { return () => {}; },
    emit(payload) { for (const listener of listeners) listener(payload); },
  };
}

test("recap is enabled by default and v18 upgrades opt in locally", () => {
  assert.equal(prefs.CURRENT_VERSION, 19);
  assert.equal(prefs.getDefaults().recapEnabled, true);
  const upgraded = prefs.migrate({ version: 18 });
  assert.equal(upgraded.recapEnabled, true);
  assert.equal(upgraded.version, 19);
  assert.deepEqual(updateRegistry.recapEnabled(false), { status: "ok" });
  assert.equal(updateRegistry.recapEnabled("false").status, "error");
});

test("settings effect router applies recap toggle after the preference commit", () => {
  const settingsController = controller(prefs.getDefaults());
  const values = [];
  const router = createSettingsEffectRouter({
    settingsController,
    setRecapEnabled: (value) => values.push(value),
  });
  router.start();
  settingsController.emit({ changes: { recapEnabled: false } });
  settingsController.emit({ changes: { recapEnabled: true } });
  assert.deepEqual(values, [false, true]);
  router.dispose();
});

test("main owns recap runtime lifecycle and wires it to state and Settings IPC", () => {
  const source = require("node:fs").readFileSync(require.resolve("../src/main"), "utf8");
  assert.match(source, /const recapRuntime = createRecapRuntime\(/);
  assert.match(source, /recapSink: recapRuntime/);
  assert.match(source, /registerSettingsIpc\(\{[\s\S]*?settingsController: _settingsController,\s*recapRuntime,/);
  assert.match(source, /createWindow\(\);\s*try \{ recapRuntime\.start\(\); \}/);
  assert.match(source, /try \{ recapRuntime\.dispose\(\); \} catch \{}\s*_state\.cleanup\(\);/);
  assert.match(source, /getEnabled: \(\) => !_recapStartupAuthorityLost/);
  assert.match(source, /onRecorded: \(\) => settingsWindowRuntime\.notifyRecapChanged\(\)/);
});
