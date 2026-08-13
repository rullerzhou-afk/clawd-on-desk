"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PRELOAD = path.join(__dirname, "..", "src", "preload-roam-fence-picker.js");

test("roam fence picker preload exposes only scoped ready/result/state operations", () => {
  const calls = [];
  const listeners = new Map();
  let exposed = null;
  const ipcRenderer = {
    send: (channel, payload) => calls.push([channel, payload]),
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const context = {
    require(name) {
      if (name === "electron") {
        return {
          contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
          ipcRenderer,
        };
      }
      throw new Error(`unexpected preload dependency ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(PRELOAD, "utf8"), context, { filename: PRELOAD });

  assert.deepStrictEqual(Object.keys(exposed).sort(), ["applied", "cancel", "confirm", "onState", "ready"]);
  const received = [];
  const unsubscribe = exposed.onState((payload) => received.push(payload));
  const stateListener = listeners.get("roam-fence-picker:state");
  stateListener({}, { lang: "zh" });
  assert.deepStrictEqual(received, [{ lang: "zh" }]);
  unsubscribe();
  assert.strictEqual(listeners.has("roam-fence-picker:state"), false);

  exposed.ready();
  exposed.applied();
  exposed.confirm({ x: 1, y: 2, width: 3, height: 4 });
  exposed.cancel();
  assert.strictEqual(calls[0][0], "roam-fence-picker:ready");
  assert.strictEqual(calls[0][1], undefined);
  assert.strictEqual(calls[1][0], "roam-fence-picker:state-applied");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.slice(2))), [
    ["roam-fence-picker:result", {
      action: "confirm",
      selection: { x: 1, y: 2, width: 3, height: 4 },
    }],
    ["roam-fence-picker:result", { action: "cancel" }],
  ]);
});
