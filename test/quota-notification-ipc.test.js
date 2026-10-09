"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerQuotaNotificationIpc } = require("../src/quota-notification-ipc");
function harness(testNotification = async () => true) {
  const handlers = new Map();
  let destroyed = false, unreadable = false;
  const contents = { mainFrame: { url: pathToFileURL(path.join(__dirname, "../src/settings.html")).href },
    isDestroyed: () => destroyed };
  const win = { webContents: contents, isDestroyed: () => destroyed };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const ipc = registerQuotaNotificationIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    getSettingsWindow: () => win, testNotification,
    settingsController: { hasReadFailure: () => unreadable },
  });
  return { ipc, event, contents, handlers,
    run: (sender = event) => handlers.get("settings:quota-test-notification")(sender),
    destroy: () => { destroyed = true; }, unreadable: () => { unreadable = true; } };
}
test("only the current Settings main frame can test a notification", async () => {
  let sends = 0;
  for (const make of [h => ({ ...h.event, sender: {} }),
    h => ({ ...h.event, senderFrame: { ...h.contents.mainFrame } }),
    h => { h.contents.mainFrame.url = "https://example.com"; return h.event; }]) {
    const h = harness(async () => { sends++; return true; });
    assert.equal((await h.run(make(h))).code, "UNTRUSTED_SENDER"); h.ipc.dispose();
  }
  assert.equal(sends, 0);
});
test("the test is single-flight and rechecks window ownership after native delivery", async () => {
  let finish, sends = 0;
  const h = harness(() => { sends++; return new Promise(r => { finish = r; }); });
  const pending = h.run();
  assert.equal((await h.run()).code, "BUSY");
  finish(true); assert.deepEqual(await pending, { ok: true });
  const second = h.run(); h.destroy(); finish(true);
  assert.equal((await second).code, "UNTRUSTED_SENDER"); assert.equal(sends, 2); h.ipc.dispose();
});
test("unreadable preferences, delivery failures and disposal return safely", async () => {
  let sends = 0;
  const h = harness(async () => { sends++; return true; }); h.unreadable();
  assert.equal((await h.run()).code, "SETTINGS_UNAVAILABLE"); assert.equal(sends, 0);
  h.ipc.dispose();
  const bad = harness(async () => { throw Error("native"); });
  assert.deepEqual(await bad.run(), { ok: false });
  const saved = bad.handlers.get("settings:quota-test-notification"); bad.ipc.dispose();
  assert.equal(bad.handlers.size, 0); assert.equal((await saved(bad.event)).code, "UNTRUSTED_SENDER");
});
