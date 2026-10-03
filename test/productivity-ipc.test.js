"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const { registerProductivityIpc } = require("../src/productivity-ipc");
function harness(options = {}) {
  const handlers = new Map(), calls = [];
  const bookmark = { id: "project-a", name: "Example", cwd: process.cwd(), launchMode: "folder" };
  let destroyed = false, unreadable = false, records = [bookmark];
  const contents = { mainFrame: { url: pathToFileURL(path.join(__dirname, "../src/settings.html")).href },
    isDestroyed: () => destroyed };
  const win = { webContents: contents, isDestroyed: () => destroyed };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let launch = async (value, guard) => { calls.push(value); return { ok: guard.canLaunch() }; };
  let choose = async () => ({ canceled: false, filePaths: [process.cwd()] });
  const ipc = registerProductivityIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    getSettingsWindow: () => win, dialog: { showOpenDialog: (...args) => choose(...args) },
    launcher: { launch: (...args) => launch(...args) },
    testNotification: options.testNotification,
    settingsController: { hasReadFailure: () => unreadable, get: () => records,
      applyBulk: (patch) => { calls.push(patch); return { status: "ok" }; } },
  });
  return { ipc, calls, event, contents, handlers, bookmark,
    run: (suffix, arg, sender = event) => handlers.get(`settings:productivity-${suffix}`)(sender, arg),
    destroy: () => { destroyed = true; }, unreadable: () => { unreadable = true; },
    records: (next) => { records = next; }, launch: (fn) => { launch = fn; }, choose: (fn) => { choose = fn; } };
}
test("rejects foreign contents, subframes and navigation without any effects", async () => {
  for (const make of [h => ({ ...h.event, sender: {} }), h => ({ ...h.event, senderFrame: { ...h.contents.mainFrame } }),
    h => { h.contents.mainFrame.url = "https://example.com"; return h.event; }]) {
    const h = harness(), bad = make(h);
    for (const [action, arg] of [["launch-project", "project-a"], ["choose-project-directory"],
      ["apply-bulk", { quotaAlertsEnabled: true }], ["test-notification"]]) {
      assert.equal((await h.run(action, arg, bad)).code, "UNTRUSTED_SENDER");
    }
    assert.deepEqual(h.calls, []); h.ipc.dispose();
  }
});
test("notification test is single-flight, owner-gated and does not write prefs", async () => {
  let finish, sends = 0;
  const h = harness({ testNotification: () => { sends++; return new Promise(r => { finish = r; }); } });
  const pending = h.run("test-notification");
  assert.equal((await h.run("test-notification")).code, "BUSY");
  finish(true); assert.deepEqual(await pending, { ok: true }); assert.deepEqual(h.calls, []);
  const second = h.run("test-notification"); h.destroy(); finish(true);
  assert.equal((await second).code, "UNTRUSTED_SENDER"); assert.equal(sends, 2); h.ipc.dispose();
});
test("unreadable settings prevent native effects and bulk writes", async () => {
  const h = harness(); h.unreadable();
  assert.equal((await h.run("launch-project", "project-a")).code, "SETTINGS_UNAVAILABLE");
  assert.equal((await h.run("choose-project-directory")).code, "SETTINGS_UNAVAILABLE");
  assert.equal((await h.run("apply-bulk", { quotaAlertsEnabled: true })).code, "SETTINGS_UNAVAILABLE");
  assert.deepEqual(h.calls, []); h.ipc.dispose();
});
test("bulk exposes only atomic quota fields through the controller", () => {
  const h = harness(), patch = { quotaAlertsEnabled: true, quotaAlertThresholds: [20, 10] };
  assert.equal(h.run("apply-bulk", patch).status, "ok"); assert.deepEqual(h.calls, [patch]);
  for (const bad of [null, [], {}, { quietHours: {} }, { quotaAlertsEnabled: true, soundMuted: true }]) {
    assert.equal(h.run("apply-bulk", bad).code, "INVALID_PATCH");
  }
  assert.equal(h.calls.length, 1); h.ipc.dispose();
});
test("launch accepts saved ID only; renderer cannot supply paths or commands", async () => {
  const h = harness();
  for (const bad of ["deleted", { ...h.bookmark, command: "anything" }, null, "x".repeat(100)]) {
    assert.equal((await h.run("launch-project", bad)).code, "BOOKMARK_INVALID");
  }
  assert.equal((await h.run("launch-project", "project-a")).ok, true);
  assert.deepEqual(h.calls, [h.bookmark]); h.ipc.dispose();
});
test("double click is busy and async guard rejects a changed record before launching", async () => {
  const h = harness(); let finish;
  h.launch(async (_value, guard) => { await new Promise(r => { finish = r; }); return { ok: guard.canLaunch() }; });
  const pending = h.run("launch-project", "project-a");
  assert.equal((await h.run("launch-project", "project-a")).code, "BUSY");
  h.records([]); finish(); assert.equal((await pending).ok, false); h.ipc.dispose();
});
test("valid raw records normalize consistently both before and after async launch checks", async () => {
  const h = harness(); h.records([{ ...h.bookmark, name: " Example ", cwd: process.cwd() + path.sep }]);
  assert.equal((await h.run("launch-project", "project-a")).ok, true);
  assert.equal(h.calls[0].name, "Example"); h.ipc.dispose();
});
test("directory picker is single-flight and rejects stale owner after native await", async () => {
  const h = harness(); let finish;
  h.choose(() => new Promise(r => { finish = r; }));
  const pending = h.run("choose-project-directory");
  assert.equal((await h.run("choose-project-directory")).code, "BUSY");
  h.destroy(); finish({ canceled: false, filePaths: [process.cwd()] });
  assert.equal((await pending).code, "UNTRUSTED_SENDER"); h.ipc.dispose();
});
test("picker cancellation, errors and dispose return safely", async () => {
  const h = harness(); h.choose(async () => ({ canceled: true, filePaths: [] }));
  assert.equal((await h.run("choose-project-directory")).status, "cancelled");
  h.choose(async () => { throw Error("native"); });
  assert.equal((await h.run("choose-project-directory")).code, "DIALOG_FAILED");
  const saved = h.handlers.get("settings:productivity-launch-project"); h.ipc.dispose();
  assert.equal(h.handlers.size, 0); assert.equal((await saved(h.event, "project-a")).code, "UNTRUSTED_SENDER");
});
