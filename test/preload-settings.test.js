"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PRELOAD_SETTINGS = path.join(__dirname, "..", "src", "preload-settings.js");

function loadPreload() {
  const ipcHandlers = new Map();
  const exposed = new Map();
  const ipcRenderer = {
    invoke: () => Promise.resolve(),
    send: () => {},
    on(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
    removeListener: () => {},
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed.set(name, value);
    },
  };
  const context = {
    console,
    process: { argv: [] },
    require(name) {
      if (name === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(PRELOAD_SETTINGS, "utf8"), context, {
    filename: PRELOAD_SETTINGS,
  });
  return { exposed, ipcHandlers };
}

test("settings preload forwards Telegram status revisions and unsubscribe is exact", () => {
  const { exposed, ipcHandlers } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  const forward = ipcHandlers.get("remoteApproval:status-changed");
  const received = [];
  const payload = { channel: "telegram", revision: 7 };

  assert.equal(typeof settingsAPI.onRemoteApprovalStatusChanged, "function");
  assert.equal(typeof forward, "function");

  const unsubscribe = settingsAPI.onRemoteApprovalStatusChanged((value) => {
    received.push(value);
  });
  assert.equal(typeof unsubscribe, "function");

  forward({}, payload);
  assert.equal(received.length, 1);
  assert.equal(received[0], payload, "the channel-scoped payload must pass through unchanged");

  unsubscribe();
  forward({}, { channel: "telegram", revision: 8 });
  assert.equal(received.length, 1, "unsubscribe must remove only the registered callback");
});
