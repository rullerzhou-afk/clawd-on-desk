"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { registerSessionIpc } = require("../src/session-ipc");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
  const runtime = registerSessionIpc({
    ipcMain,
    getSessionSnapshot: overrides.getSessionSnapshot || (() => ({ sessions: [{ id: "s1" }] })),
    getI18n: overrides.getI18n || (() => ({ lang: "en", translations: { title: "Sessions" } })),
    focusSession: overrides.focusSession || ((sessionId, options) => {
      calls.push(["focusSession", sessionId, options]);
    }),
    hideSession: overrides.hideSession || ((sessionId) => {
      calls.push(["hideSession", sessionId]);
      return { status: "ok", hidden: sessionId };
    }),
    setSessionAlias: overrides.setSessionAlias || (async (payload) => {
      calls.push(["setSessionAlias", payload]);
      return { status: "ok", alias: payload.alias };
    }),
    showDashboard: overrides.showDashboard || ((options) => {
      calls.push(["showDashboard", options]);
    }),
    setSessionHudPinned: overrides.setSessionHudPinned || ((value) => {
      calls.push(["setSessionHudPinned", value]);
    }),
  });
  return { ipcMain, runtime, calls };
}

test("session IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "dashboard:get-i18n",
    "dashboard:get-snapshot",
    "dashboard:hide-session",
    "dashboard:set-session-alias",
    "session-hud:get-i18n",
  ]);
  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "dashboard:focus-session",
    "session-hud:focus-session",
    "session-hud:open-dashboard",
    "session-hud:set-pinned",
    "settings:open-dashboard",
    "show-dashboard",
  ]);

  runtime.dispose();

  assert.strictEqual(ipcMain.handlers.size, 0);
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("session IPC delegates dashboard and HUD behavior", async () => {
  const { ipcMain, calls } = createHarness();

  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-snapshot"), {
    sessions: [{ id: "s1" }],
  });
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  assert.deepStrictEqual(await ipcMain.invoke("session-hud:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  ipcMain.send("dashboard:focus-session", "dash-session");
  ipcMain.send("session-hud:focus-session", "hud-session");
  ipcMain.send("session-hud:set-pinned", true);
  ipcMain.send("session-hud:set-pinned", 0);
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:hide-session", "hidden-session"), {
    status: "ok",
    hidden: "hidden-session",
  });
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:set-session-alias", { sessionId: "s1", alias: "Frontend" }),
    { status: "ok", alias: "Frontend" }
  );

  assert.deepStrictEqual(calls, [
    ["focusSession", "dash-session", { requestSource: "dashboard" }],
    ["focusSession", "hud-session", { requestSource: "hud" }],
    ["setSessionHudPinned", true],
    ["setSessionHudPinned", false],
    ["hideSession", "hidden-session"],
    ["setSessionAlias", { sessionId: "s1", alias: "Frontend" }],
  ]);
});

test("session IPC owns dashboard open bridges", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("session-hud:open-dashboard");
  ipcMain.send("settings:open-dashboard");
  ipcMain.send("show-dashboard");

  assert.deepStrictEqual(calls, [
    ["showDashboard", { source: "hud" }],
    ["showDashboard", { source: "settings" }],
    ["showDashboard", undefined],
  ]);
});

test("main forwards dashboard open source options into session IPC", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preservesOptions = [
    /registerSessionIpc\(\{[\s\S]*?showDashboard\s*,/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\1\s*\)/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\.\.\.\s*\1\s*\)/,
  ].some((pattern) => pattern.test(mainSource));

  assert.strictEqual(
    preservesOptions,
    true,
    "main.js should preserve dashboard open options when wiring session IPC"
  );
});
