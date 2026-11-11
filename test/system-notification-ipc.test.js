"use strict";

// Settings → Notifications "Send test notification" channel, plus the
// persisted switches behind the feature.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerSystemNotificationIpc } = require("../src/system-notification-ipc");
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");

const CHANNEL = "settings:system-test-notification";
const KEYS = ["systemNotifyEnabled", "systemNotifyOnDone", "systemNotifyOnError", "systemNotifyOnPermission"];

function harness(testNotification = async () => true, { supported = true } = {}) {
  const handlers = new Map();
  let destroyed = false, unreadable = false;
  const contents = {
    mainFrame: { url: pathToFileURL(path.join(__dirname, "../src/settings.html")).href },
    isDestroyed: () => destroyed,
  };
  const win = { webContents: contents, isDestroyed: () => destroyed };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const ipc = registerSystemNotificationIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    getSettingsWindow: () => win,
    testNotification,
    isSupported: () => supported,
    settingsController: { hasReadFailure: () => unreadable },
  });
  return {
    ipc, event, contents, handlers,
    run: (sender = event) => handlers.get(CHANNEL)(sender),
    destroy: () => { destroyed = true; },
    unreadable: () => { unreadable = true; },
  };
}

test("only the current Settings main frame can send a test toast", async () => {
  let sends = 0;
  for (const make of [
    (h) => ({ ...h.event, sender: {} }),
    (h) => ({ ...h.event, senderFrame: { ...h.contents.mainFrame } }),
    (h) => { h.contents.mainFrame.url = "https://example.com"; return h.event; },
  ]) {
    const h = harness(async () => { sends++; return true; });
    assert.equal((await h.run(make(h))).code, "UNTRUSTED_SENDER");
    h.ipc.dispose();
  }
  assert.equal(sends, 0);
});

test("reports the real outcome: shown, not shown, unsupported platform", async () => {
  assert.deepEqual(await harness(async () => true).run(), { ok: true });
  assert.deepEqual(await harness(async () => false).run(), { ok: false });
  assert.deepEqual(await harness(async () => "yes").run(), { ok: false }, "only a literal true counts as shown");
  assert.deepEqual(await harness(async () => { throw new Error("native"); }).run(), { ok: false });

  let sends = 0;
  const unsupported = harness(async () => { sends++; return true; }, { supported: false });
  assert.deepEqual(await unsupported.run(), { ok: false, code: "UNSUPPORTED_PLATFORM" });
  assert.equal(sends, 0);
});

test("is single-flight and rechecks window ownership after native delivery", async () => {
  let finish, sends = 0;
  const h = harness(() => { sends++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = h.run();
  assert.equal((await h.run()).code, "BUSY");
  finish(true);
  assert.deepEqual(await pending, { ok: true });
  const second = h.run();
  h.destroy();
  finish(true);
  assert.equal((await second).code, "UNTRUSTED_SENDER");
  assert.equal(sends, 2);
  h.ipc.dispose();
});

test("unreadable preferences and disposal return safely", async () => {
  let sends = 0;
  const h = harness(async () => { sends++; return true; });
  h.unreadable();
  assert.equal((await h.run()).code, "SETTINGS_UNAVAILABLE");
  assert.equal(sends, 0);
  const saved = h.handlers.get(CHANNEL);
  h.ipc.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal((await saved(h.event)).code, "UNTRUSTED_SENDER");
});

test("the settings preload exposes the test channel under the name the page calls", () => {
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload-settings.js"), "utf8");
  assert.match(preload, /testSystemNotification: \(\) => ipcRenderer\.invoke\("settings:system-test-notification"\)/);
  const page = fs.readFileSync(path.join(__dirname, "../src/settings-tab-notifications.js"), "utf8");
  assert.match(page, /window\.settingsAPI\.testSystemNotification\(\)/);
});

test("the switches persist with opt-in defaults", () => {
  const defaults = prefs.getDefaults();
  assert.equal(defaults.systemNotifyEnabled, false, "a new outbound notification channel is opt-in");
  assert.equal(defaults.systemNotifyOnDone, true);
  assert.equal(defaults.systemNotifyOnError, true);
  assert.equal(defaults.systemNotifyOnPermission, true);

  // An older prefs file without the keys picks the defaults up.
  const upgraded = prefs.validate({ version: 1, lang: "en" });
  for (const key of KEYS) assert.equal(upgraded[key], defaults[key], key);

  // Stored choices survive, junk falls back to the default.
  const stored = prefs.validate({
    ...defaults,
    systemNotifyEnabled: true,
    systemNotifyOnDone: false,
    systemNotifyOnError: "yes",
    systemNotifyOnPermission: null,
  });
  assert.equal(stored.systemNotifyEnabled, true);
  assert.equal(stored.systemNotifyOnDone, false);
  assert.equal(stored.systemNotifyOnError, true);
  assert.equal(stored.systemNotifyOnPermission, true);
});

test("the switches only accept booleans", () => {
  for (const key of KEYS) {
    const validate = updateRegistry[key];
    assert.equal(typeof validate, "function", key);
    assert.equal(validate(true).status, "ok", key);
    assert.equal(validate(false).status, "ok", key);
    for (const bad of ["true", 1, null, undefined, {}]) {
      assert.equal(validate(bad).status, "error", `${key} <- ${JSON.stringify(bad)}`);
    }
  }
});
