"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { exposeNiriInspectBridge } = require("../src/niri-inspect-preload");

function createDomHarness() {
  const windowListeners = new Map();
  const rootListeners = new Map();
  const sent = [];
  const created = [];
  const documentValue = {
    readyState: "complete",
    documentElement: {
      addEventListener: (event, callback) => rootListeners.set(event, callback),
    },
    createElement(tag) {
      const listeners = new Map();
      const element = {
        tag,
        addEventListener: (event, callback) => listeners.set(event, callback),
        setAttribute: () => {},
        emit: (event) => listeners.get(event)?.(),
      };
      created.push(element);
      return element;
    },
    head: {
      appendChild(element) {
        if (element.tag === "link") element.emit("load");
      },
    },
    body: { appendChild: () => {} },
  };
  const windowValue = {
    addEventListener: (event, callback) => windowListeners.set(event, callback),
    requestAnimationFrame: (callback) => callback(),
  };
  const ipcRenderer = { send: (...args) => sent.push(args) };
  return {
    created,
    documentValue,
    ipcRenderer,
    rootListeners,
    sent,
    windowListeners,
    windowValue,
  };
}

describe("niri inspect preload", () => {
  it("does absolutely nothing without an injected role argument", () => {
    assert.equal(exposeNiriInspectBridge(null, null, ["electron", "app.js"], {
      get window() { throw new Error("window must not be read"); },
      get document() { throw new Error("document must not be read"); },
    }), false);
  });

  it("installs the marker only for the last injected role and reports trusted pointer samples", () => {
    const harness = createDomHarness();
    assert.equal(exposeNiriInspectBridge(null, harness.ipcRenderer, [
      "--niri-inspect-role=hit",
      "--niri-inspect-role=render",
      "--niri-inspect-corner=bottom-right",
    ], {
      window: harness.windowValue,
      document: harness.documentValue,
    }), true);

    const marker = harness.created.find((entry) => entry.tag === "div");
    assert.match(marker.className, /niri-inspect-marker--render/);
    assert.match(marker.className, /niri-inspect-marker--bottom-right/);
    assert.deepStrictEqual(harness.sent[0], ["niri-inspect-renderer-ready", { role: "render" }]);

    assert.equal(harness.windowListeners.has("pointerenter"), false);
    harness.rootListeners.get("pointerenter")({ relatedTarget: null, screenX: 12, screenY: 34 });
    assert.deepStrictEqual(harness.sent[1], ["niri-inspect-render-pointer", {
      role: "render",
      inside: true,
      screenX: 12,
      screenY: 34,
    }]);

    harness.rootListeners.get("pointerleave")({
      relatedTarget: {},
      screenX: 56,
      screenY: 78,
    });
    assert.equal(harness.sent.length, 2, "descendant boundary changes must stay internal");

    harness.rootListeners.get("pointerleave")({
      relatedTarget: null,
      screenX: 56,
      screenY: 78,
    });
    assert.deepStrictEqual(harness.sent[2], ["niri-inspect-render-pointer", {
      role: "render",
      inside: false,
      screenX: 56,
      screenY: 78,
    }]);
  });
});
