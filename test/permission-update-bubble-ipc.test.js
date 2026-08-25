"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const UPDATE_BUBBLE_MODULE_PATH = require.resolve("../src/update-bubble");

class FakeIpcMain {
  constructor() {
    this.listeners = new Map();
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function loadModuleWithElectron(modulePath, fakeElectron) {
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("permission IPC registers owned channels, delegates, and disposes", () => {
  const initPermission = loadModuleWithElectron(PERMISSION_MODULE_PATH, {
    BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  });
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const runtime = initPermission.registerPermissionIpc({
    ipcMain,
    permission: {
      handleBubbleHeight: (event, height) => calls.push(["height", event.sender, height]),
      handleDecide: (event, behavior) => calls.push(["decide", event.sender, behavior]),
      handleBubbleExpanded: (event, expanded) => calls.push(["expanded", event.sender, expanded]),
      handleCompositionActive: (event, active) => calls.push(["composition", event.sender, active]),
    },
  });

  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "bubble-composition-active",
    "bubble-height",
    "permission-decide",
    "permission-set-expanded",
  ]);

  ipcMain.send("bubble-height", 240);
  ipcMain.send("permission-decide", "deny-and-focus");
  ipcMain.send("permission-set-expanded", true);
  ipcMain.send("bubble-composition-active", true);

  assert.deepStrictEqual(calls, [
    ["height", "sender-web-contents", 240],
    ["decide", "sender-web-contents", "deny-and-focus"],
    ["expanded", "sender-web-contents", true],
    ["composition", "sender-web-contents", true],
  ]);

  runtime.dispose();
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("update bubble IPC registers owned channels, delegates, and disposes", () => {
  const initUpdateBubble = loadModuleWithElectron(UPDATE_BUBBLE_MODULE_PATH, {
    BrowserWindow: class {},
  });
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const runtime = initUpdateBubble.registerUpdateBubbleIpc({
    ipcMain,
    updateBubble: {
      handleUpdateBubbleHeight: (event, height) => calls.push(["height", event.sender, height]),
      handleUpdateBubbleAction: (event, actionId) => calls.push(["action", event.sender, actionId]),
    },
  });

  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "update-bubble-action",
    "update-bubble-height",
  ]);

  ipcMain.send("update-bubble-height", 180);
  ipcMain.send("update-bubble-action", "download");

  assert.deepStrictEqual(calls, [
    ["height", "sender-web-contents", 180],
    ["action", "sender-web-contents", "download"],
  ]);

  runtime.dispose();
  assert.strictEqual(ipcMain.listeners.size, 0);
});
