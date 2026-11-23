"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

// Exercise main's broadcaster without booting Electron or the application.
function loadBroadcaster() {
  const start = source.indexOf("let lastQuotaRingProvidersWindow");
  const end = source.indexOf("function getThemeSoundPreloadUrls", start);
  assert.ok(start >= 0 && end > start, "main must own a bounded provider broadcaster");
  let currentWindow = null;
  const computations = [];
  const pushes = [];
  const context = {
    getSettingsWindow: () => currentWindow,
    quotaRingHiddenProviders: [],
    quotaRingShownProviders: null,
    _ringGeom: {
      listQuotaRingProviders(snapshot) {
        computations.push(snapshot);
        return snapshot.providers;
      },
    },
    broadcastSettingsWindow: (channel, providers) => pushes.push({ channel, providers }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {
    push: context.broadcastQuotaRingProviders,
    setWindow: value => { currentWindow = value; },
    computations,
    pushes,
  };
}

function settingsWindow() {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
}

describe("quota ring settings broadcasts", () => {
  it("does not compute providers when the settings window is unavailable", () => {
    const harness = loadBroadcaster();
    harness.push({ providers: [] });
    harness.setWindow({ isDestroyed: () => true });
    harness.push({ providers: [] });
    assert.equal(harness.computations.length, 0);
    assert.equal(harness.pushes.length, 0);
  });

  it("deduplicates provider content and sends a fresh value to a reopened window", () => {
    const harness = loadBroadcaster();
    const first = { key: "claudeQuota", shown: true, coinCount: 1, shownCoinCount: 1 };
    harness.setWindow(settingsWindow());
    harness.push({ providers: [first] });
    harness.push({ providers: [{ ...first }] });
    assert.equal(harness.pushes.length, 1);
    harness.push({ providers: [{ ...first, coinCount: 2, shownCoinCount: 2 }] });
    assert.equal(harness.pushes.length, 2, "source-count changes are visible changes");
    harness.setWindow(settingsWindow());
    harness.push({ providers: [{ ...first, coinCount: 2, shownCoinCount: 2 }] });
    assert.equal(harness.pushes.length, 3);
    assert.equal(harness.pushes[0].channel, "settings:quota-ring-providers-changed");
    assert.match(source, /broadcastSessionHudSnapshot\(snapshot\);\s*broadcastQuotaRingProviders\(snapshot\);/);
  });
});
