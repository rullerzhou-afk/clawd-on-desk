"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
const createSettingsEffectRouter = require("../src/settings-effect-router");
test("result cards default off, reject invalid values, persist independently of all bubble categories", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-results-prefs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefsPath = path.join(root, "prefs.json");
  assert.equal(prefs.getDefaults().sessionResultCardsEnabled, false);
  assert.equal(prefs.validate({ sessionResultCardsEnabled: "yes" }).sessionResultCardsEnabled, false);
  const ctrl = createSettingsController({ prefsPath });
  assert.equal((await ctrl.applyUpdate("sessionResultCardsEnabled", "true")).status, "error");
  assert.equal((await ctrl.applyUpdate("sessionResultCardsEnabled", true)).status, "ok");
  await ctrl.applyCommand("setAllBubblesHidden", { hidden: true });
  assert.equal(ctrl.get("hideBubbles"), true);
  assert.equal(ctrl.get("sessionResultCardsEnabled"), true);
  const restored = createSettingsController({ prefsPath });
  assert.equal(restored.get("sessionResultCardsEnabled"), true);
  assert.equal(restored.get("hideBubbles"), true);
  t.mock.method(prefs, "save", () => { throw new Error("simulated write failure"); });
  t.mock.method(console, "warn", () => {});
  assert.equal((await ctrl.applyUpdate("sessionResultCardsEnabled", false)).status, "error");
  assert.equal(ctrl.get("sessionResultCardsEnabled"), true);
});
test("committed preference, agent gate and language changes synchronize results after mirrors", () => {
  let subscriber;
  const calls = [];
  const controller = {
    getSnapshot: () => ({ shortcuts: {} }),
    subscribe: callback => { subscriber = callback; return () => {}; },
    subscribeKey: () => () => {},
  };
  const router = createSettingsEffectRouter({
    settingsController: controller,
    updateMirrors: () => calls.push("mirrors"),
    syncSessionResultSettings: () => calls.push("results"),
  });
  router.start();
  for (const changes of [{ sessionResultCardsEnabled: true }, { agents: {} }, { lang: "zh" }]) {
    calls.length = 0;
    subscriber({ changes, snapshot: { shortcuts: {}, ...changes } });
    assert.deepEqual(calls, ["mirrors", "results"]);
  }
  calls.length = 0;
  subscriber({ changes: { hideBubbles: true }, snapshot: { shortcuts: {}, hideBubbles: true } });
  assert.deepEqual(calls, ["mirrors"]);
  router.dispose();
});
