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
    this.classList = {
      toggle: () => {},
      contains: () => false,
      add: () => {},
      remove: () => {},
    };
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

function createRendererHarness(options = {}) {
  const timers = [];
  const audioInstances = [];
  const electronCalls = [];
  const electronHandlers = {};
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
    get(_target, prop) {
      const name = String(prop);
      if (name.startsWith("on")) {
        return (callback) => { electronHandlers[name] = callback; };
      }
      return (...args) => { electronCalls.push({ name, args }); };
    },
  });
  const context = {
    document,
    window: {
      themeConfig: {
        assetsPath: "../assets/svg",
        eyeTracking: { states: ["idle"] },
        ...(options.themeConfig || {}),
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
    Audio: function FakeAudio(url) {
      this.url = url;
      this.volume = 1;
      this.currentTime = 0;
      this.loadCalls = 0;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.load = () => { this.loadCalls++; };
      this.play = () => { this.playCalls++; return Promise.resolve(); };
      this.pause = () => { this.pauseCalls++; };
      audioInstances.push(this);
    },
  };
  context.globalThis = context;

  const source = `${readNormalized(RENDERER)}
globalThis.__rendererTest = {
  swapToFile,
  pauseCurrentSvgForLowPower,
  recoverFromSystemWake,
  attachEyeTracking,
  isEyeTrackingReady,
  setLowPowerIdleMode,
  setCurrentState(value) { currentState = value; },
  setLayeredTrackingForTest(document) {
    _trackingLayers = { test: { wrappers: [], maxOffset: 1, ease: 1, x: 0, y: 0 } };
    _layeredTrackingObj = clawdEl;
    _layeredTrackingDocument = document;
  },
  getPetMediaElements,
  get pendingNext() { return pendingNext; },
  get pendingSvgFile() { return pendingSvgFile; },
  get activeSwapToken() { return activeSwapToken; },
  get clawdEl() { return clawdEl; },
  get lowPowerSvgPaused() { return lowPowerSvgPaused; },
  get eyeTarget() { return eyeTarget; },
};`;
  vm.runInNewContext(source, context);

  return {
    context,
    container,
    clawd,
    timers,
    audioInstances,
    electronCalls,
    electronHandlers,
    api: context.__rendererTest,
    activeTimers: () => timers.filter((timer) => !timer.cleared),
  };
}

function drainActiveTimers(harness, predicate, limit = 100) {
  let count = 0;
  while (count < limit) {
    const timer = harness.activeTimers().find(predicate);
    if (!timer) return count;
    timer.cleared = true;
    timer.callback();
    count++;
  }
  return count;
}

function attachFakeSvgDocument(objectEl, { withEyes = false } = {}) {
  const root = new FakeElement("svg");
  const elements = new Map();
  const svgDoc = {
    defaultView: {},
    documentElement: root,
    createElementNS(_namespace, tagName) {
      const element = new FakeElement(tagName);
      element.ownerDocument = svgDoc;
      return element;
    },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      return root.children.find((child) => child.id === id) || null;
    },
  };
  root.ownerDocument = svgDoc;
  root.pauseCalls = 0;
  root.unpauseCalls = 0;
  root.pauseAnimations = () => { root.pauseCalls++; };
  root.unpauseAnimations = () => { root.unpauseCalls++; };
  if (withEyes) {
    const eyes = new FakeElement("g");
    eyes.id = "eyes-js";
    eyes.ownerDocument = svgDoc;
    elements.set("eyes-js", eyes);
  }
  objectEl.contentDocument = svgDoc;
  return { root, svgDoc, elements };
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

  it("resumes a low-power-paused eye target when the mouse moves", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);
    harness.api.attachEyeTracking(harness.clawd);
    harness.api.pauseCurrentSvgForLowPower();
    assert.equal(harness.api.lowPowerSvgPaused, true);

    harness.electronHandlers.onEyeMove(2, -1);

    assert.equal(harness.api.lowPowerSvgPaused, false);
    assert.equal(harness.api.eyeTarget.getAttribute("transform"), "translate(2, -1)");
    const firstActivityTimer = harness.activeTimers().find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(firstActivityTimer);

    harness.electronHandlers.onEyeMove(3, -1);

    assert.equal(firstActivityTimer.cleared, true);
    assert.ok(harness.activeTimers().some((timer) => timer.ms === 5000 && !timer.cleared));
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

  it("relays low-power pauses to trusted scripted SVG runtimes", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function setCurrentScriptedSvgLowPowerPaused(paused)"));
    assert.ok(source.includes("target.contentWindow.__clawdSetLowPowerPaused"));
    assert.ok(source.includes("setCurrentScriptedSvgLowPowerPaused(true);"));
    assert.ok(source.includes("setCurrentScriptedSvgLowPowerPaused(false);"));
  });

  it("resets main's paused mirror on renderer reload/crash and boosts eye resend on resume", () => {
    const source = readNormalized(MAIN);

    assert.ok(source.includes("function setLowPowerIdlePaused(value)"));
    assert.ok(source.includes("if (!next) setForceEyeResend(true);"));
    assert.ok(source.includes('win.webContents.on("did-start-loading", () => {'));
    assert.ok(source.includes('win.webContents.on("render-process-gone", (_event, details) => {'));
    assert.ok(source.includes("setLowPowerIdlePaused(false);"));
  });

  it("unpauses the current SVG and reattaches eye tracking after system wake", () => {
    const harness = createRendererHarness();
    const svg = attachFakeSvgDocument(harness.clawd, { withEyes: true });
    const scriptedPauseCalls = [];
    harness.clawd.contentWindow.__clawdSetLowPowerPaused = (paused) => scriptedPauseCalls.push(paused);
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);
    harness.api.pauseCurrentSvgForLowPower();

    assert.equal(harness.api.lowPowerSvgPaused, true);
    assert.ok(svg.svgDoc.getElementById("clawd-low-power-pause-svg"));

    harness.electronHandlers.onSystemWake({ id: "wake-test-1", trigger: "resume", attempt: 0 });
    const replacementObject = harness.api.pendingNext;
    assert.ok(replacementObject);
    attachFakeSvgDocument(replacementObject, { withEyes: true });
    replacementObject.listeners.get("load")();

    assert.equal(harness.api.lowPowerSvgPaused, false);
    assert.equal(svg.svgDoc.getElementById("clawd-low-power-pause-svg"), null);
    assert.equal(svg.root.unpauseCalls, 1);
    assert.deepEqual(scriptedPauseCalls, [true, false]);
    assert.ok(harness.api.eyeTarget);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.deepEqual(report.args[0], {
      id: "wake-test-1",
      result: "resumed",
      lowPowerWasPaused: true,
      pauseStyleRemoved: true,
      eyeTrackingReady: true,
      eyeTargetWasCurrentDocument: false,
      objectReloaded: true,
      eyeTargetRebound: true,
    });
  });

  it("waits for async eye attach before reporting wake recovery", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-async-1", trigger: "resume", attempt: 0 });
    const replacementObject = harness.api.pendingNext;
    assert.ok(replacementObject);

    replacementObject.listeners.get("load")();
    assert.equal(
      harness.electronCalls.filter((call) => call.name === "reportSystemWakeStatus").length,
      0
    );

    const freshSvg = attachFakeSvgDocument(replacementObject, { withEyes: true });
    drainActiveTimers(harness, (timer) => timer.ms === 16 && !timer.cleared);

    assert.strictEqual(harness.api.eyeTarget.ownerDocument, freshSvg.svgDoc);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.deepEqual(report.args[0], {
      id: "wake-async-1",
      result: "resumed",
      lowPowerWasPaused: false,
      pauseStyleRemoved: true,
      eyeTrackingReady: true,
      eyeTargetWasCurrentDocument: false,
      objectReloaded: true,
      eyeTargetRebound: true,
    });
  });

  it("removes a residual pause style even when the renderer mirror is already false", () => {
    const harness = createRendererHarness();
    const svg = attachFakeSvgDocument(harness.clawd);
    const style = svg.svgDoc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.id = "clawd-low-power-pause-svg";
    svg.root.appendChild(style);

    assert.equal(harness.api.lowPowerSvgPaused, false);
    harness.electronHandlers.onSystemWake({ id: "wake-test-2", trigger: "resume", attempt: 0 });

    assert.equal(svg.svgDoc.getElementById("clawd-low-power-pause-svg"), null);
    assert.equal(svg.root.unpauseCalls, 1);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].lowPowerWasPaused, true);
    assert.equal(report.args[0].pauseStyleRemoved, true);
  });

  it("replies to duplicate wake ids without running recovery twice", () => {
    const harness = createRendererHarness();
    const svg = attachFakeSvgDocument(harness.clawd, { withEyes: true });
    const payload = { id: "wake-test-3", trigger: "resume", attempt: 0 };
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake(payload);
    const replacementObject = harness.api.pendingNext;
    const swapToken = harness.api.activeSwapToken;
    harness.electronHandlers.onSystemWake({ ...payload, attempt: 1 });

    assert.equal(svg.root.unpauseCalls, 1);
    assert.strictEqual(harness.api.pendingNext, replacementObject);
    assert.equal(harness.api.activeSwapToken, swapToken);
    assert.equal(
      harness.electronCalls.filter((call) => call.name === "reportSystemWakeStatus").length,
      0
    );

    attachFakeSvgDocument(replacementObject, { withEyes: true });
    replacementObject.listeners.get("load")();
    harness.electronHandlers.onSystemWake({ ...payload, attempt: 2 });
    assert.equal(
      harness.electronCalls.filter((call) => call.name === "reportSystemWakeStatus").length,
      2
    );
  });

  it("replays only the latest wake id after an object reload finishes", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-first", trigger: "resume", attempt: 0 });
    const firstObject = harness.api.pendingNext;
    const firstSwapToken = harness.api.activeSwapToken;

    harness.electronHandlers.onSystemWake({ id: "wake-second", trigger: "unlock-screen", attempt: 0 });
    harness.electronHandlers.onSystemWake({ id: "wake-third", trigger: "resume", attempt: 0 });
    assert.strictEqual(harness.api.pendingNext, firstObject);
    assert.equal(harness.api.activeSwapToken, firstSwapToken);

    attachFakeSvgDocument(firstObject, { withEyes: true });
    firstObject.listeners.get("load")();
    const replayTimer = harness.activeTimers().find((timer) => timer.ms === 0);
    assert.ok(replayTimer, "latest queued wake should be replayed after cleanup");
    replayTimer.callback();

    assert.notStrictEqual(harness.api.pendingNext, firstObject);
    assert.equal(harness.api.activeSwapToken, firstSwapToken + 1);
    const replayObject = harness.api.pendingNext;
    attachFakeSvgDocument(replayObject, { withEyes: true });
    replayObject.listeners.get("load")();

    const reportedIds = harness.electronCalls
      .filter((call) => call.name === "reportSystemWakeStatus")
      .map((call) => call.args[0].id);
    assert.deepEqual(reportedIds, ["wake-first", "wake-third"]);
  });

  it("settles an in-flight wake when a state change supersedes its object reload", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-state-1", trigger: "resume", attempt: 0 });
    const wakeObject = harness.api.pendingNext;
    harness.electronHandlers.onStateChange("working", "working.svg");

    assert.equal(wakeObject.isConnected, false);
    const firstReport = harness.electronCalls.find((call) => (
      call.name === "reportSystemWakeStatus" && call.args[0].id === "wake-state-1"
    ));
    assert.ok(firstReport, "superseded wake must report instead of timing out");

    harness.electronHandlers.onSystemWake({ id: "wake-state-2", trigger: "resume", attempt: 0 });
    const secondReport = harness.electronCalls.find((call) => (
      call.name === "reportSystemWakeStatus" && call.args[0].id === "wake-state-2"
    ));
    assert.ok(secondReport, "a superseded wake must not block later wake ids");
  });

  it("rebuilds a stale eye-tracking object whose old document still looks alive", () => {
    const harness = createRendererHarness();
    const originalSvg = attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);
    harness.api.attachEyeTracking(harness.clawd);
    assert.strictEqual(harness.api.eyeTarget.ownerDocument, originalSvg.svgDoc);

    const replacementDocument = attachFakeSvgDocument(harness.clawd, { withEyes: true });
    assert.notStrictEqual(harness.api.eyeTarget.ownerDocument, replacementDocument.svgDoc);
    assert.ok(harness.api.eyeTarget.ownerDocument.defaultView, "old document still passes the legacy ready check");

    harness.electronHandlers.onSystemWake({ id: "wake-stale-2", trigger: "resume", attempt: 0 });
    const replacementObject = harness.api.pendingNext;
    assert.ok(replacementObject, "wake should start a fresh object-channel swap");
    assert.equal(replacementObject.tagName, "OBJECT");
    assert.match(replacementObject.data, /[?&]_t=\d+-\d+$/);

    const freshSvg = attachFakeSvgDocument(replacementObject, { withEyes: true });
    replacementObject.listeners.get("load")();

    assert.strictEqual(harness.api.clawdEl, replacementObject);
    assert.strictEqual(harness.api.eyeTarget.ownerDocument, freshSvg.svgDoc);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].eyeTargetWasCurrentDocument, false);
    assert.equal(report.args[0].objectReloaded, true);
    assert.equal(report.args[0].eyeTargetRebound, true);
  });

  it("retries a wake object reload once before reporting success", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-retry-1", trigger: "resume", attempt: 0 });
    const firstObject = harness.api.pendingNext;
    const firstSwapToken = harness.api.activeSwapToken;
    drainActiveTimers(harness, (timer) => timer.ms === 3000 && !timer.cleared, 1);

    assert.equal(firstObject.isConnected, false);
    assert.equal(
      harness.electronCalls.filter((call) => call.name === "reportSystemWakeStatus").length,
      0
    );
    const retryObject = harness.api.pendingNext;
    assert.ok(retryObject);
    assert.notStrictEqual(retryObject, firstObject);
    assert.equal(harness.api.activeSwapToken, firstSwapToken + 1);
    assert.equal(harness.container.children.some((element) => element.tagName === "IMG"), false);

    attachFakeSvgDocument(retryObject, { withEyes: true });
    retryObject.listeners.get("load")();

    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].result, "resumed");
    assert.equal(report.args[0].objectReloaded, true);
    assert.equal(report.args[0].eyeTrackingReady, true);
  });

  it("keeps the old object and reports an error after the wake reload retry cannot load", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-fail-1", trigger: "resume", attempt: 0 });
    const failedObject = harness.api.pendingNext;
    drainActiveTimers(harness, (timer) => timer.ms === 3000 && !timer.cleared, 1);
    const retryObject = harness.api.pendingNext;
    assert.ok(retryObject);
    assert.notStrictEqual(retryObject, failedObject);
    drainActiveTimers(harness, (timer) => timer.ms === 3000 && !timer.cleared, 1);

    assert.strictEqual(harness.api.clawdEl, harness.clawd);
    assert.equal(harness.api.pendingNext, null);
    assert.equal(harness.container.children.some((element) => element.tagName === "IMG"), false);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].result, "error");
    assert.equal(report.args[0].objectReloaded, false);
    assert.equal(report.args[0].eyeTrackingReady, true);
    assert.strictEqual(harness.api.eyeTarget.ownerDocument, harness.clawd.contentDocument);
    assert.equal(failedObject.isConnected, false);
    assert.equal(retryObject.isConnected, false);
  });

  it("does not rebuild an eye object when low-power mode is disabled", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.setCurrentState("idle");
    harness.api.attachEyeTracking(harness.clawd);

    harness.electronHandlers.onSystemWake({ id: "wake-disabled-1", trigger: "resume", attempt: 0 });

    assert.equal(harness.api.pendingNext, null);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].objectReloaded, false);
    assert.equal(report.args[0].eyeTrackingReady, true);
  });

  it("does not rebuild the object for a non-eye state", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd);
    harness.api.setCurrentState("sleeping");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-sleeping-1", trigger: "resume", attempt: 0 });

    assert.equal(harness.api.pendingNext, null);
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.equal(report.args[0].objectReloaded, false);
    assert.equal(report.args[0].eyeTrackingReady, true);
  });

  it("invalidates layered tracking when the object document changes", () => {
    const harness = createRendererHarness();
    const originalSvg = attachFakeSvgDocument(harness.clawd);
    harness.api.setLayeredTrackingForTest(originalSvg.svgDoc);
    assert.equal(harness.api.isEyeTrackingReady(), true);

    attachFakeSvgDocument(harness.clawd);

    assert.equal(harness.api.isEyeTrackingReady(), false);
  });

  it("reattaches a stale single eye target before applying the next eye move", () => {
    const harness = createRendererHarness();
    attachFakeSvgDocument(harness.clawd, { withEyes: true });
    harness.api.attachEyeTracking(harness.clawd);
    const replacementSvg = attachFakeSvgDocument(harness.clawd, { withEyes: true });

    harness.electronHandlers.onEyeMove(2, -1);

    assert.strictEqual(harness.api.eyeTarget.ownerDocument, replacementSvg.svgDoc);
    assert.equal(harness.api.eyeTarget.getAttribute("transform"), "translate(2, -1)");
  });

  it("exposes the bounded wake IPC bridge through preload", () => {
    const preload = readNormalized(PRELOAD);
    assert.ok(preload.includes('onSystemWake: (cb) => ipcRenderer.on("system-wake"'));
    assert.ok(preload.includes('reportSystemWakeStatus: (payload) => ipcRenderer.send("system-wake-status", payload)'));
  });
});

describe("renderer object-channel selection", () => {
  it("allows built-in trusted scripted SVG files to use <object>", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("_trustedScriptedSvgFiles = new Set"));
    assert.ok(source.includes("_forceSvgObjectChannel"));
    assert.ok(source.includes("return _forceSvgObjectChannel || needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);"));
  });

  it("uses state-specific static image overrides only while low-power mode is enabled", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function resolveLowPowerStaticImageOverride(state, file)"));
    assert.ok(source.includes("if (!lowPowerIdleMode) return null;"));
    assert.ok(source.includes("const lowPowerStaticImageOverride = resolveLowPowerStaticImageOverride(state, requestedSvg);"));
    assert.ok(source.includes("const effectiveSvg = lowPowerStaticImageOverride || requestedSvg;"));
    assert.ok(source.includes("const desiredObjectChannel = lowPowerStaticImageOverride ? false : needsObjectChannel(state, effectiveSvg);"));
    assert.ok(source.includes("swapToFile(effectiveSvg, state, lowPowerStaticImageOverride ? false : undefined);"));
  });

  it("refreshes the current sleeping media when low-power static image mode changes", () => {
    const harness = createRendererHarness({
      themeConfig: {
        trustedScriptedSvgFiles: ["sleep.svg"],
        rendering: {
          lowPowerStaticImageOverrides: {
            sleeping: { from: "sleep.svg", to: "sleep-static.png" },
          },
        },
      },
    });

    harness.electronHandlers.onStateChange("sleeping", "sleep.svg");
    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep.svg");

    harness.electronHandlers.onLowPowerIdleModeChange(true);
    assert.strictEqual(harness.api.pendingNext.tagName, "IMG");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep-static.png");

    harness.electronHandlers.onLowPowerIdleModeChange(false);
    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep.svg");
  });

  it("keeps eye-tracking attachment state-based only", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.match(source, /if \(state && needsEyeTracking\(state\)\) {\r?\n\s+attachEyeTracking\(next\);/);
  });

  it("does not hard-code click or drag reactions to the img channel", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("swapToFile(svgFile, null);"));
    assert.ok(source.includes("swapToFile(dragSvg, null);"));
    assert.ok(!source.includes("swapToFile(svgFile, null, false);"));
    assert.ok(!source.includes("swapToFile(dragSvg, null, false);"));
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
    assert.ok(source.includes("const desiredAssetUrl = getAssetUrl(effectiveSvg);"));
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

describe("renderer sound preload and warmup", () => {
  it("preloads sound files without playing a primer", () => {
    const harness = createRendererHarness();
    const preload = harness.electronHandlers.onPreloadSounds;

    assert.strictEqual(typeof preload, "function");
    preload({ urls: ["file:///complete.mp3"] });

    assert.strictEqual(harness.audioInstances.length, 1);
    assert.strictEqual(harness.audioInstances[0].url, "file:///complete.mp3");
    assert.strictEqual(harness.audioInstances[0].loadCalls, 1);
    assert.strictEqual(harness.audioInstances[0].playCalls, 0);
  });

  it("does not reload a cached sound object on playback", () => {
    const harness = createRendererHarness();
    const preload = harness.electronHandlers.onPreloadSounds;
    const playSound = harness.electronHandlers.onPlaySound;

    preload({ urls: ["file:///complete.mp3"] });
    const cached = harness.audioInstances[0];
    playSound({ url: "file:///complete.mp3", volume: 1 });

    assert.strictEqual(cached.loadCalls, 1);
    assert.strictEqual(harness.audioInstances.length, 2);
    assert.strictEqual(harness.audioInstances[1].url, "file:///complete.mp3");
    assert.strictEqual(harness.audioInstances[1].playCalls, 1);
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
