"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "..", "src", "renderer.js");
const PRELOAD = path.join(__dirname, "..", "src", "preload.js");
const MAIN = path.join(__dirname, "..", "src", "main.js");

function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function matchSource(source, pattern, message) {
  const match = source.match(pattern);
  assert.ok(match, message || `missing pattern ${pattern}`);
  return match;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.isConnected = false;
    this.className = "";
    this.id = "";
    this.data = "";
    this.src = "";
    this.contentDocument = null;
    this.contentWindow = {};
    this.listeners = new Map();
  }

  get offsetHeight() {
    return 1;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "data") this.data = String(value);
    if (name === "src") this.src = String(value);
  }

  getAttribute(name) {
    if (name === "data") return this.data || this.attributes.get(name) || "";
    if (name === "src") return this.src || this.attributes.get(name) || "";
    return this.attributes.get(name) || "";
  }

  appendChild(child) {
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove() {
    this.isConnected = false;
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  addEventListener(event, callback) {
    this.listeners.set(event, callback);
  }

  querySelectorAll() {
    return this.children.filter((child) => (
      child.tagName === "OBJECT"
      || (child.tagName === "IMG" && String(child.className).split(/\s+/).includes("clawd-img"))
    ));
  }
}

function createRendererHarness() {
  const timers = [];
  const container = new FakeElement("div");
  container.id = "pet-container";
  container.isConnected = true;
  const clawd = new FakeElement("object");
  clawd.id = "clawd";
  clawd.data = "../assets/svg/current.svg";
  clawd.style.opacity = "0";
  container.appendChild(clawd);

  const document = {
    getElementById(id) {
      if (id === "pet-container") return container;
      if (id === "clawd") return clawd;
      return null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
  const electronAPI = new Proxy({}, {
    get() {
      return () => {};
    },
  });
  const context = {
    document,
    window: {
      themeConfig: {
        assetsPath: "../assets/svg",
        eyeTracking: { states: ["idle"] },
      },
      electronAPI,
      getComputedStyle: (el) => ({ opacity: el.style.opacity || "1" }),
    },
    console: { warn() {} },
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    requestAnimationFrame(callback) {
      return context.setTimeout(callback, 16);
    },
    cancelAnimationFrame(timer) {
      context.clearTimeout(timer);
    },
    Audio: function FakeAudio() {
      return { play: () => Promise.resolve(), volume: 1, currentTime: 0 };
    },
  };
  context.globalThis = context;

  const source = `${readNormalized(RENDERER)}
globalThis.__rendererTest = {
  swapToFile,
  getPetMediaElements,
  get pendingNext() { return pendingNext; },
  get pendingSvgFile() { return pendingSvgFile; },
  get activeSwapToken() { return activeSwapToken; },
  get clawdEl() { return clawdEl; },
};`;
  vm.runInNewContext(source, context);

  return {
    context,
    container,
    clawd,
    timers,
    api: context.__rendererTest,
    activeTimers: () => timers.filter((timer) => !timer.cleared),
  };
}

describe("renderer low-power idle mode", () => {
  it("waits for an animation boundary before pausing the current SVG", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function getLowPowerAnimationBoundaryDelayMs(root)"));
    assert.ok(source.includes("root.getAnimations({ subtree: true })"));
    assert.ok(source.includes("pauseCurrentSvgForLowPower({ waitForBoundary: true })"));
    assert.ok(source.includes("LOW_POWER_BOUNDARY_EPSILON_MS"));
  });

  it("keeps the disabled-mode eye-move path cheap", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("if (!lowPowerIdleMode && !lowPowerSvgPaused) return;"));
  });

  it("does not treat passive eye or pointer tracking as low-power activity", () => {
    const source = readNormalized(RENDERER);
    const eyeHandler = matchSource(
      source,
      /window\.electronAPI\.onEyeMove\(\(dx, dy\) => \{([\s\S]*?)\n\}\);/,
      "missing eye-move handler"
    )[1];
    const pointerHandler = matchSource(
      source,
      /window\.electronAPI\.onCloudlingPointer\(\(payload\) => \{([\s\S]*?)\n\s+\}\);/,
      "missing Cloudling pointer handler"
    )[1];

    assert.ok(!eyeHandler.includes("noteLowPowerActivity()"));
    assert.ok(!pointerHandler.includes("noteLowPowerActivity()"));
  });

  it("suppresses passive tracking while low-power paused and cancels layered RAF", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function shouldSuppressPassiveTrackingForLowPower()"));
    assert.ok(source.includes("return lowPowerIdleMode && lowPowerSvgPaused && shouldPauseForLowPower();"));
    assert.ok(source.includes("function _cancelLayerAnimLoop()"));
    assert.ok(source.includes("if (next) _cancelLayerAnimLoop();"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) { _layerAnimFrame = null; return; }"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) {\n    _cancelLayerAnimLoop();\n    return;\n  }"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) return;\n  if (!shouldUseCloudlingPointerBridge"));
  });

  it("notifies main only when the low-power paused state changes", () => {
    const source = readNormalized(RENDERER);
    const preload = readNormalized(PRELOAD);

    assert.ok(source.includes("function setLowPowerSvgPaused(paused)"));
    assert.ok(source.includes("if (lowPowerSvgPaused === next) return;"));
    assert.ok(source.includes("window.electronAPI.setLowPowerIdlePaused(next);"));
    assert.ok(preload.includes('setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused)'));
  });

  it("resets main's paused mirror on renderer reload/crash and boosts eye resend on resume", () => {
    const source = readNormalized(MAIN);

    assert.ok(source.includes("function setLowPowerIdlePaused(value)"));
    assert.ok(source.includes("if (!next) setForceEyeResend(true);"));
    assert.ok(source.includes('win.webContents.on("did-start-loading", () => {'));
    assert.ok(source.includes('win.webContents.on("render-process-gone", (_event, details) => {'));
    assert.ok(source.includes("setLowPowerIdlePaused(false);"));
  });
});

describe("renderer object-channel selection", () => {
  it("allows built-in trusted scripted SVG files to use <object>", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("_trustedScriptedSvgFiles = new Set"));
    assert.ok(source.includes("_forceSvgObjectChannel"));
    assert.ok(source.includes("return _forceSvgObjectChannel || needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);"));
  });

  it("keeps eye-tracking attachment state-based only", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.match(source, /if \(state && needsEyeTracking\(state\)\) {\r?\n\s+attachEyeTracking\(next\);/);
  });

  it("does not hard-code click or drag reactions to the img channel", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("swapToFile(svgFile, null);"));
    assert.ok(source.includes("swapToFile(_dragSvg, null);"));
    assert.ok(!source.includes("swapToFile(svgFile, null, false);"));
    assert.ok(!source.includes("swapToFile(_dragSvg, null, false);"));
  });

  it("uses a monotonic cache-bust counter for remaining img-channel SVG swaps", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("let _imgCacheBustSeq = 0;"));
    assert.ok(source.includes("++_imgCacheBustSeq"));
    assert.ok(source.includes("const cacheBust = `${Date.now()}-${++_imgCacheBustSeq}`;"));
    assert.ok(!source.includes("_t=${Date.now()}"));
  });

  it("deduplicates displayed files by resolved asset URL, not filename alone", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("let currentDisplayedAssetUrl = null;"));
    assert.ok(source.includes("let pendingAssetUrl = null;"));
    assert.ok(source.includes("const desiredAssetUrl = getAssetUrl(svg);"));
    assert.ok(source.includes("currentDisplayedAssetUrl === desiredAssetUrl"));
    assert.ok(source.includes("pendingAssetUrl === desiredAssetUrl"));
  });

  it("rescues an invisible object-channel pending swap by reloading through the img channel", () => {
    const harness = createRendererHarness();

    harness.api.swapToFile("next.svg", "idle", true);
    const rescue = harness.activeTimers().find((timer) => timer.ms === 3750);
    rescue.callback();

    assert.strictEqual(harness.api.pendingNext.tagName, "IMG");
    assert.strictEqual(harness.api.pendingSvgFile, "next.svg");
    assert.strictEqual(
      harness.container.querySelectorAll().some((el) => el.tagName === "OBJECT" && el !== harness.clawd),
      false
    );
  });

  it("ignores stale rescue timers after a newer swap starts", () => {
    const harness = createRendererHarness();

    harness.api.swapToFile("old.svg", "idle", true);
    const staleRescue = harness.activeTimers().find((timer) => timer.ms === 3750);
    harness.api.swapToFile("new.svg", "idle", true);
    staleRescue.callback();

    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "new.svg");
  });

  it("does not rescue over an already visible pet element", () => {
    const harness = createRendererHarness();
    harness.clawd.style.opacity = "1";

    harness.api.swapToFile("next.svg", "idle", true);
    const rescue = harness.activeTimers().find((timer) => timer.ms === 3750);
    rescue.callback();

    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "next.svg");
  });
});

describe("renderer Cloudling pointer bridge", () => {
  it("bridges only selected Cloudling pointer states through the exporter API", () => {
    const source = fs.readFileSync(RENDERER, "utf8");
    const preload = fs.readFileSync(PRELOAD, "utf8");

    assert.ok(source.includes('const CLOUDLING_POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);'));
    assert.ok(source.includes('typeof svgWindow.__cloudlingSetPointer === "function"'));
    assert.ok(source.includes('svgWindow.__cloudlingSetPointer(payload);'));
    assert.ok(source.includes('window.electronAPI.onCloudlingPointer((payload) => {'));
    assert.ok(preload.includes('onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload))'));
  });
});

describe("renderer glyph flip compensation", () => {
  it("flips reverse-drawn mini crabwalk assets during pre-entry without entering mini layout", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("let _miniPreEntryMode = false;"));
    assert.ok(source.includes("_miniPreEntryMode = !!enabled && preEntry;"));
    assert.ok(source.includes("_miniPreEntryMode && state === \"mini-crabwalk\""));
    assert.ok(source.includes("_inMiniMode = !!enabled && !preEntry;"));
    assert.ok(source.includes("applyMiniFlip(next, state);"));
  });

  it("notifies object-channel SVGs when mini-left glyph compensation changes", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("typeof svgWindow.__clawdSetGlyphFlipCompensation === \"function\""));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(true);"));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(false);"));
  });
});
