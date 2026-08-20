"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "..", "src", "renderer.js");
const ACCESSORY_LAYOUT = path.join(__dirname, "..", "src", "pet-accessory-layout.js");
const ACCESSORY_MIRROR = path.join(__dirname, "..", "src", "pet-accessory-mirror.js");
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

// PR #751 Codex review #12 (rework batch B-8, §6.6): loads the REAL
// src/preload.js against a minimal mocked electron module (same
// require.cache-swap technique as test/mini.test.js's loadMiniWithElectron),
// so its own onViewportOffset/onViewportOffsetX normalization can be
// exercised directly — createRendererHarness() below's electronAPI is a
// hand-written Proxy that stores the renderer's callback straight into
// electronHandlers, never touching preload.js's real ipcRenderer.on(...)
// wrapping at all, so it cannot prove anything about THIS boundary.
function loadPreloadWithElectron() {
  const electronPath = require.resolve("electron");
  const preloadPath = require.resolve("../src/preload");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousPreload = Object.prototype.hasOwnProperty.call(require.cache, preloadPath)
    ? require.cache[preloadPath]
    : null;

  const ipcListeners = new Map();
  const sentToMain = [];
  const exposed = {};

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: {
        exposeInMainWorld: (name, api) => { exposed[name] = api; },
      },
      ipcRenderer: {
        on: (event, handler) => { ipcListeners.set(event, handler); },
        send: (channel, ...args) => { sentToMain.push({ channel, args }); },
      },
    },
  };
  delete require.cache[preloadPath];
  require("../src/preload"); // runs preload.js's top-level contextBridge.exposeInMainWorld call

  return {
    electronAPI: exposed.electronAPI,
    sentToMain,
    // Simulates main.js's ipcRenderer send arriving at whatever handler
    // preload.js registered for `event` via ipcRenderer.on(event, ...).
    emitFromMain: (event, ...args) => {
      const handler = ipcListeners.get(event);
      if (handler) handler(null, ...args);
    },
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousPreload) require.cache[preloadPath] = previousPreload;
      else delete require.cache[preloadPath];
    },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] || ""; },
    };
    this.attributes = new Map();
    this.attributeSetCalls = [];
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
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.offsetWidth = 220;
    this._offsetHeight = 220;
    this.clientWidth = 220;
    this.clientHeight = 220;
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : !!force;
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return enabled;
      },
      contains: (name) => String(this.className).split(/\s+/).includes(name),
      add: (...namesToAdd) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        namesToAdd.forEach((name) => names.add(name));
        this.className = [...names].join(" ");
      },
      remove: (...namesToRemove) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        namesToRemove.forEach((name) => names.delete(name));
        this.className = [...names].join(" ");
      },
    };
  }

  get offsetHeight() {
    return this._offsetHeight;
  }

  set offsetHeight(value) {
    this._offsetHeight = value;
  }

  setAttribute(name, value) {
    this.attributeSetCalls.push([name, String(value)]);
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
    child.offsetParent = this;
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

  querySelectorAll(selector = "object, img.clawd-img") {
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants.filter((child) => {
      if (selector.includes("object.clawd-object")
          && child.tagName === "OBJECT"
          && child.classList.contains("clawd-object")) return true;
      if (selector.includes("object") && !selector.includes("object.clawd-object")
          && child.tagName === "OBJECT") return true;
      if (selector.includes("img.clawd-img")
          && child.tagName === "IMG"
          && child.classList.contains("clawd-img")) return true;
      return false;
    });
  }
}

function createRendererHarness(options = {}) {
  const timers = [];
  const audioInstances = [];
  const electronCalls = [];
  const warnings = [];
  const electronHandlers = {};
  const container = new FakeElement("div");
  container.id = "pet-container";
  container.isConnected = true;
  const facingStage = new FakeElement("div");
  facingStage.id = "pet-facing-stage";
  const motionStage = new FakeElement("div");
  motionStage.id = "pet-motion-stage";
  const assetDirectionStage = new FakeElement("div");
  assetDirectionStage.id = "pet-asset-direction-stage";
  const mediaLayer = new FakeElement("div");
  mediaLayer.id = "pet-media-layer";
  const accessoryLayer = new FakeElement("div");
  accessoryLayer.id = "pet-accessory-layer";
  const accessory = new FakeElement("img");
  accessory.id = "clawd-accessory";
  accessory.className = "clawd-accessory";
  const effectStage = new FakeElement("div");
  effectStage.id = "pet-effect-stage";
  const particleLayer = new FakeElement("div");
  particleLayer.id = "pet-particle-layer";
  const clawd = new FakeElement("object");
  clawd.id = "clawd";
  clawd.className = "clawd-object";
  clawd.offsetLeft = -99;
  clawd.offsetTop = -55;
  clawd.clientWidth = 418;
  clawd.clientHeight = 286;
  clawd.offsetWidth = 418;
  clawd.offsetHeight = 286;
  // index.html ships the object tag without data; tests that don't care get a
  // pre-displayed file so the initial-frame swap stays out of their way.
  clawd.data = Object.prototype.hasOwnProperty.call(options, "initialObjectData")
    ? options.initialObjectData
    : "../assets/svg/current.svg";
  clawd.style.opacity = "0";
  container.appendChild(facingStage);
  facingStage.appendChild(motionStage);
  motionStage.appendChild(assetDirectionStage);
  assetDirectionStage.appendChild(mediaLayer);
  assetDirectionStage.appendChild(accessoryLayer);
  mediaLayer.appendChild(clawd);
  accessoryLayer.appendChild(accessory);
  container.appendChild(effectStage);
  effectStage.appendChild(particleLayer);

  const elementsById = new Map([
    ["pet-container", container],
    ["pet-facing-stage", facingStage],
    ["pet-motion-stage", motionStage],
    ["pet-asset-direction-stage", assetDirectionStage],
    ["pet-media-layer", mediaLayer],
    ["pet-accessory-layer", accessoryLayer],
    ["pet-effect-stage", effectStage],
    ["pet-particle-layer", particleLayer],
    ["clawd", clawd],
    ["clawd-accessory", accessory],
  ]);
  const documentListeners = new Map();

  const document = {
    hidden: false,
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(event, callback) {
      documentListeners.set(event, callback);
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
  const windowListeners = new Map();
  const context = {
    document,
    window: {
      themeConfig: {
        assetsPath: "../assets/svg",
        eyeTracking: { states: ["idle"] },
        petTintSupported: true,
        // Matches the pre-displayed file above, so tests that don't care about
        // the #509 idle choice keep resting on the "follow" sprite.
        idleFollowSvg: "current.svg",
        ...(options.themeConfig || {}),
      },
      electronAPI,
      getComputedStyle: (el) => ({ opacity: el.style.opacity || "1" }),
      addEventListener(event, callback) {
        windowListeners.set(event, callback);
      },
    },
    console: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
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

  const source = `${readNormalized(ACCESSORY_LAYOUT)}
${readNormalized(ACCESSORY_MIRROR)}
${readNormalized(RENDERER)}
globalThis.__rendererTest = {
  initWithConfig,
  swapToFile,
  startDragReaction,
  endDragReaction,
  cancelReaction,
  normalizeDragDirection,
  applyDirectionalDragToObject,
  applyCodexPetVisualToObject,
  pauseCurrentSvgForLowPower,
  setLowPowerSvgPaused,
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
  normalizePetTintPayload,
  applyPetTintToAllMedia,
  normalizeAccessoryPayload,
  refreshAccessoryLayout,
  get pendingNext() { return pendingNext; },
  get pendingSvgFile() { return pendingSvgFile; },
  get activeSwapToken() { return activeSwapToken; },
  get clawdEl() { return clawdEl; },
  get currentDisplayedState() { return currentDisplayedState; },
  get currentDisplayedSvg() { return currentDisplayedSvg; },
  get currentDisplayedAssetUrl() { return currentDisplayedAssetUrl; },
  get currentDragSvg() { return currentDragSvg; },
  get currentDragDirection() { return currentDragDirection; },
  get isDragReacting() { return isDragReacting; },
  get accessoryAssetLoadTimer() { return _accessoryAssetLoadTimer; },
  get accessoryAssetSettled() { return _accessoryAssetSettled; },
  get lowPowerSvgPaused() { return lowPowerSvgPaused; },
  get eyeTarget() { return eyeTarget; },
};`;
  vm.runInNewContext(source, context);

  return {
    context,
    container,
    facingStage,
    mediaLayer,
    accessoryLayer,
    assetDirectionStage,
    accessory,
    particleLayer,
    clawd,
    timers,
    audioInstances,
    electronCalls,
    warnings,
    electronHandlers,
    api: context.__rendererTest,
    activeTimers: () => timers.filter((timer) => !timer.cleared),
    documentListeners,
    windowListeners,
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

function attachDirectionalSvgDocument(objectEl, direction = "right") {
  const attached = attachFakeSvgDocument(objectEl);
  attached.root.setAttribute("data-clawd-drag-directional", "v1");
  attached.root.setAttribute("data-clawd-drag-direction", direction);
  attached.root.attributeSetCalls.length = 0;
  return attached;
}

function attachUniversalCodexPetDocument(objectEl, visual = "idle-loop") {
  const attached = attachDirectionalSvgDocument(objectEl);
  const animation = {
    currentTime: 250,
    playCalls: 0,
    play() { this.playCalls += 1; },
  };
  attached.root.setAttribute("data-clawd-codex-pet-visuals", "v1");
  attached.root.setAttribute("data-clawd-codex-pet-visual", visual);
  attached.root.getAnimations = () => [animation];
  attached.root.attributeSetCalls.length = 0;
  return { ...attached, animation };
}

describe("renderer directional drag reactions (#620)", () => {
  function makeDirectionalHarness(overrides = {}) {
    return createRendererHarness({
      themeConfig: {
        dragSvg: "neutral.svg",
        dragSvgs: {
          left: "drag-directional.svg",
          right: "drag-directional.svg",
        },
        rendering: { svgChannel: "object" },
        ...overrides,
      },
    });
  }

  function makeUniversalCodexPetHarness(overrides = {}) {
    return createRendererHarness({
      themeConfig: {
        dragSvg: "codex-pet-running-loop.svg",
        dragSvgs: {
          left: "codex-pet-drag-directional-loop.svg",
          right: "codex-pet-drag-directional-loop.svg",
        },
        rendering: { svgChannel: "object" },
        ...overrides,
      },
    });
  }

  function commitUniversalCodexPet(harness, file, visual, state = "idle") {
    harness.api.swapToFile(file, state, true);
    const pending = harness.api.pendingNext;
    const attached = attachUniversalCodexPetDocument(pending, visual);
    pending.listeners.get("load")();
    return { objectEl: pending, ...attached };
  }

  it("keeps drag, release, and mid-drag state changes in one Codex Pet document", () => {
    const harness = makeUniversalCodexPetHarness();
    const attached = commitUniversalCodexPet(
      harness,
      "codex-pet-idle-loop.svg",
      "idle-loop"
    );
    const objectEl = attached.objectEl;
    const token = harness.api.activeSwapToken;

    harness.electronHandlers.onStartDragReaction("left");
    assert.strictEqual(harness.api.clawdEl, objectEl);
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "drag-directional");
    assert.strictEqual(attached.root.getAttribute("data-clawd-drag-direction"), "left");

    harness.electronHandlers.onStateChange("working", "codex-pet-running-loop.svg");
    assert.strictEqual(harness.api.clawdEl, objectEl);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(harness.api.isDragReacting, false);
    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "running-loop");

    harness.electronHandlers.onStartDragReaction("right");
    assert.strictEqual(harness.api.clawdEl, objectEl);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "drag-directional");
    assert.strictEqual(attached.root.getAttribute("data-clawd-drag-direction"), "right");

    harness.electronHandlers.onEndDragReaction();
    harness.electronHandlers.onStateChange("idle", "codex-pet-idle-loop.svg");
    assert.strictEqual(harness.api.clawdEl, objectEl);
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(harness.api.currentDisplayedSvg, "codex-pet-idle-loop.svg");
    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "idle-loop");
    assert.strictEqual(harness.mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img").length, 1);
  });

  it("restarts an already selected universal one-shot without replacing its object", () => {
    const harness = makeUniversalCodexPetHarness();
    const attached = commitUniversalCodexPet(
      harness,
      "codex-pet-idle-loop.svg",
      "idle-loop"
    );
    const token = harness.api.activeSwapToken;

    harness.api.swapToFile("codex-pet-waving-once.svg", null, true);
    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "waving-once");
    assert.strictEqual(attached.animation.playCalls, 0);
    attached.animation.currentTime = 640;

    harness.api.swapToFile("codex-pet-waving-once.svg", null, true);
    assert.strictEqual(harness.api.clawdEl, attached.objectEl);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(attached.animation.currentTime, 0);
    assert.strictEqual(attached.animation.playCalls, 0);
  });

  it("does not reuse a universal document after the theme asset directory changes", () => {
    const harness = makeUniversalCodexPetHarness();
    const attached = commitUniversalCodexPet(
      harness,
      "codex-pet-idle-loop.svg",
      "idle-loop"
    );
    const token = harness.api.activeSwapToken;

    harness.api.initWithConfig({
      assetsPath: "../other-theme-assets",
      dragSvg: "codex-pet-running-loop.svg",
      dragSvgs: {
        left: "codex-pet-drag-directional-loop.svg",
        right: "codex-pet-drag-directional-loop.svg",
      },
      rendering: { svgChannel: "object" },
      eyeTracking: { states: [] },
    });
    harness.api.swapToFile("codex-pet-running-loop.svg", "working", true);

    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "idle-loop");
    assert.notStrictEqual(harness.api.pendingNext, attached.objectEl);
    assert.strictEqual(harness.api.activeSwapToken, token + 1);
  });

  it("honors an explicit document reload for a universal Codex Pet wrapper", () => {
    const harness = makeUniversalCodexPetHarness();
    const attached = commitUniversalCodexPet(
      harness,
      "codex-pet-idle-loop.svg",
      "idle-loop"
    );
    const token = harness.api.activeSwapToken;

    harness.api.swapToFile("codex-pet-idle-loop.svg", "idle", true, {
      forceDocumentReload: true,
    });

    assert.strictEqual(attached.root.getAttribute("data-clawd-codex-pet-visual"), "idle-loop");
    assert.notStrictEqual(harness.api.pendingNext, attached.objectEl);
    assert.strictEqual(harness.api.activeSwapToken, token + 1);
  });

  it("warns once and falls back to a media swap when the universal marker is unavailable", () => {
    const harness = makeUniversalCodexPetHarness();
    harness.api.swapToFile("codex-pet-idle-loop.svg", "idle", true);
    const first = harness.api.pendingNext;
    attachDirectionalSvgDocument(first);
    first.listeners.get("load")();

    harness.api.swapToFile("codex-pet-running-loop.svg", "working", true);
    harness.api.cancelReaction();
    harness.api.swapToFile("codex-pet-review-loop.svg", "thinking", true);

    assert.deepStrictEqual(harness.warnings, [
      "Clawd: Codex Pet visual bridge unavailable (v1 marker missing); using a normal media swap.",
    ]);
    assert.strictEqual(harness.api.pendingSvgFile, "codex-pet-review-loop.svg");
  });

  it("commits the latest pending direction and reuses one object for later reversals", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("left");
    const pending = harness.api.pendingNext;
    const token = harness.api.activeSwapToken;
    const { root } = attachDirectionalSvgDocument(pending);

    harness.electronHandlers.onStartDragReaction("right");
    assert.strictEqual(harness.api.pendingNext, pending);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(root.getAttribute("data-clawd-drag-direction"), "right");

    pending.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl, pending);
    assert.strictEqual(harness.api.currentDragSvg, "drag-directional.svg");
    assert.strictEqual(harness.api.currentDragDirection, "right");
    const displayedUrl = harness.api.currentDisplayedAssetUrl;

    harness.electronHandlers.onStartDragReaction("left");
    assert.strictEqual(harness.api.clawdEl, pending);
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(harness.api.currentDisplayedAssetUrl, displayedUrl);
    assert.strictEqual(root.getAttribute("data-clawd-drag-direction"), "left");
    assert.strictEqual(harness.mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img").length, 1);

    const directionWrites = root.attributeSetCalls.length;
    harness.electronHandlers.onStartDragReaction("left");
    assert.strictEqual(root.attributeSetCalls.length, directionWrites);
  });

  it("keeps ordinary themes with distinct directional files on the media-swap path", () => {
    const harness = makeDirectionalHarness({
      dragSvgs: { left: "left.svg", right: "right.svg" },
    });
    harness.electronHandlers.onStartDragReaction("left");
    const first = harness.api.pendingNext;
    const firstToken = harness.api.activeSwapToken;

    harness.electronHandlers.onStartDragReaction("right");
    assert.notStrictEqual(harness.api.pendingNext, first);
    assert.strictEqual(first.isConnected, false);
    assert.strictEqual(harness.api.pendingSvgFile, "right.svg");
    assert.strictEqual(harness.api.activeSwapToken, firstToken + 1);
  });

  it("bounds marker and contentDocument failures without replacing the active object", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("right");
    const pending = harness.api.pendingNext;
    const { root } = attachFakeSvgDocument(pending);
    pending.listeners.get("load")();
    const token = harness.api.activeSwapToken;

    assert.doesNotThrow(() => harness.electronHandlers.onStartDragReaction("left"));
    assert.strictEqual(root.getAttribute("data-clawd-drag-direction"), "");
    assert.strictEqual(harness.api.clawdEl, pending);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.deepStrictEqual(harness.warnings, [
      "Clawd: directional drag bridge unavailable (v1 marker missing); keeping the fallback direction.",
    ]);

    // The same failure category is logged once per renderer lifecycle.
    harness.electronHandlers.onStartDragReaction("right");
    harness.electronHandlers.onStartDragReaction("left");
    assert.strictEqual(harness.warnings.length, 1);

    Object.defineProperty(pending, "contentDocument", {
      configurable: true,
      get() { throw new Error("cross-origin"); },
    });
    assert.doesNotThrow(() => harness.electronHandlers.onStartDragReaction("right"));
    assert.strictEqual(harness.api.clawdEl, pending);
    assert.strictEqual(harness.api.activeSwapToken, token);
    assert.strictEqual(harness.warnings.length, 2);
    assert.match(harness.warnings[1], /contentDocument access denied/);
  });

  it("warns once when a shared directional wrapper is forced onto the image channel", () => {
    const harness = makeDirectionalHarness({ rendering: { svgChannel: "auto" } });
    harness.electronHandlers.onStartDragReaction("right");
    const pending = harness.api.pendingNext;
    assert.strictEqual(pending.tagName, "IMG");
    pending.listeners.get("load")();

    harness.electronHandlers.onStartDragReaction("left");
    harness.electronHandlers.onStartDragReaction("right");

    assert.deepStrictEqual(harness.warnings, [
      "Clawd: directional drag bridge unavailable (non-object media channel); keeping the fallback direction.",
    ]);
  });

  it("clears drag identity on cancel so a restart performs a full swap", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("left");
    const first = harness.api.pendingNext;
    attachDirectionalSvgDocument(first);
    first.listeners.get("load")();
    const firstToken = harness.api.activeSwapToken;

    harness.api.cancelReaction();
    assert.strictEqual(harness.api.isDragReacting, false);
    assert.strictEqual(harness.api.currentDragSvg, null);
    assert.strictEqual(harness.api.currentDragDirection, null);

    harness.api.startDragReaction("left");
    assert.strictEqual(harness.api.isDragReacting, true);
    assert.strictEqual(harness.api.currentDragSvg, "drag-directional.svg");
    assert.strictEqual(harness.api.pendingSvgFile, "drag-directional.svg");
    assert.notStrictEqual(harness.api.pendingNext, first);
    assert.strictEqual(harness.api.activeSwapToken, firstToken + 1);
  });

  it("normalizes the directional bridge to the left/right wire enum", () => {
    const harness = makeDirectionalHarness();
    assert.strictEqual(harness.api.normalizeDragDirection("left"), "left");
    assert.strictEqual(harness.api.normalizeDragDirection("right"), "right");
    assert.strictEqual(harness.api.normalizeDragDirection("up"), null);
    assert.strictEqual(harness.api.normalizeDragDirection(null), null);
  });

  it("fully clears drag reaction state when theme config is re-initialized", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("left");
    assert.strictEqual(harness.api.isDragReacting, true);

    harness.api.initWithConfig({
      dragSvg: "new-neutral.svg",
      dragSvgs: { left: "new-left.svg", right: "new-right.svg" },
      eyeTracking: { states: [] },
    });

    assert.strictEqual(harness.api.isDragReacting, false);
    assert.strictEqual(harness.api.currentDragSvg, null);
    assert.strictEqual(harness.api.currentDragDirection, null);
  });

  it("uses one neutral-to-directional swap for a vertical drag that later moves horizontally", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction(null);
    const neutralPending = harness.api.pendingNext;
    attachFakeSvgDocument(neutralPending);
    neutralPending.listeners.get("load")();
    const neutralToken = harness.api.activeSwapToken;

    harness.electronHandlers.onStartDragReaction("right");

    assert.strictEqual(harness.api.activeSwapToken, neutralToken + 1);
    assert.strictEqual(harness.api.pendingSvgFile, "drag-directional.svg");
  });

  it("does not apply a stale drag direction when a pending object loads after cancel", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("left");
    const pending = harness.api.pendingNext;
    const { root } = attachDirectionalSvgDocument(pending);

    harness.api.cancelReaction();
    pending.listeners.get("load")();

    assert.deepStrictEqual(root.attributeSetCalls, []);
    assert.strictEqual(root.getAttribute("data-clawd-drag-direction"), "right");
  });

  it("pauses cursor polling once across repeated same-document reversals and resumes once at drag end", () => {
    const harness = makeDirectionalHarness();
    harness.electronHandlers.onStartDragReaction("right");
    const pending = harness.api.pendingNext;
    attachDirectionalSvgDocument(pending);
    pending.listeners.get("load")();

    for (let index = 0; index < 20; index += 1) {
      harness.electronHandlers.onStartDragReaction(index % 2 === 0 ? "left" : "right");
    }
    harness.electronHandlers.onEndDragReaction();

    assert.strictEqual(harness.electronCalls.filter((call) => call.name === "pauseCursorPolling").length, 1);
    assert.strictEqual(harness.electronCalls.filter((call) => call.name === "resumeFromReaction").length, 1);
  });
});

describe("renderer test-result reactions", () => {
  it("replaces pass bursts instead of accumulating confetti nodes", () => {
    const harness = createRendererHarness();

    harness.electronHandlers.onPlayTestReaction("pass");
    assert.strictEqual(harness.particleLayer.children.length, 18);
    assert.ok(harness.particleLayer.children.every((node) => node.className === "clawd-test-confetti"));
    const firstBurst = [...harness.particleLayer.children];

    harness.electronHandlers.onPlayTestReaction("pass");
    assert.strictEqual(harness.particleLayer.children.length, 18);
    assert.ok(firstBurst.every((node) => node.isConnected === false));
    assert.strictEqual(
      harness.activeTimers().filter((timer) => timer.ms >= 1500 && timer.ms <= 1700).length,
      18
    );
  });

  it("clears confetti, shakes only the facing layer, and cleans up after 650ms", () => {
    const harness = createRendererHarness();
    harness.electronHandlers.onPlayTestReaction("pass");

    harness.electronHandlers.onPlayTestReaction("fail");
    assert.strictEqual(harness.particleLayer.children.length, 0);
    assert.strictEqual(harness.facingStage.classList.contains("clawd-test-shake"), true);
    assert.strictEqual(harness.container.classList.contains("clawd-test-shake"), false);

    const shakeTimer = harness.activeTimers().find((timer) => timer.ms === 650);
    assert.ok(shakeTimer);
    shakeTimer.cleared = true;
    shakeTimer.callback();
    assert.strictEqual(harness.facingStage.classList.contains("clawd-test-shake"), false);
  });

  it("suppresses new reactions and clears an active one when DND turns on", () => {
    const harness = createRendererHarness();
    harness.electronHandlers.onPlayTestReaction("pass");
    assert.strictEqual(harness.particleLayer.children.length, 18);

    harness.electronHandlers.onDndChange(true);
    assert.strictEqual(harness.particleLayer.children.length, 0);
    harness.electronHandlers.onPlayTestReaction("fail");
    assert.strictEqual(harness.facingStage.classList.contains("clawd-test-shake"), false);
  });

  it("keeps mini mirroring and viewport translation independent from failure shake", () => {
    const css = readNormalized(path.join(__dirname, "..", "src", "styles.css"));
    assert.match(css, /#pet-facing-stage\.clawd-test-shake\s*\{[^}]*animation:/);
    assert.match(css, /@keyframes clawd-test-shake\s*\{[\s\S]*translate:[\s\S]*rotate:/);
    assert.ok(!/#pet-container\.clawd-test-shake/.test(css));
    assert.match(css, /#pet-container\.mini-left #pet-facing-stage\s*\{[^}]*scale:\s*-1 1;/);
  });

  it("preload forwards only pass/fail wire values", () => {
    const harness = loadPreloadWithElectron();
    try {
      const seen = [];
      harness.electronAPI.onPlayTestReaction((result) => seen.push(result));
      harness.emitFromMain("play-test-reaction", "pass");
      harness.emitFromMain("play-test-reaction", "unexpected");
      harness.emitFromMain("play-test-reaction", "fail");
      assert.deepStrictEqual(seen, ["pass", "fail"]);
    } finally {
      harness.restore();
    }
  });
});

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
    assert.match(
      source,
      /if \(next\) \{\s+_cancelLayerAnimLoop\(\);\s+cancelAccessoryFollow\(\);\s+\} else \{\s+refreshAccessoryLayout\(\);\s+\}/
    );
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
    assert.equal(harness.mediaLayer.children.some((element) => element.tagName === "IMG"), false);

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
    assert.equal(harness.mediaLayer.children.some((element) => element.tagName === "IMG"), false);
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
    harness.api.setCurrentState("idle");
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
    assert.ok(source.includes("|| _trustedScriptedSvgFiles.has(file)"));
    assert.ok(source.includes("|| needsAccessoryFollow;"));
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
    const filter = "grayscale(1) brightness(1.05)";
    harness.electronHandlers.onPetTintChange({ id: "mono", filter });

    harness.electronHandlers.onStateChange("sleeping", "sleep.svg");
    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep.svg");
    assert.strictEqual(harness.api.pendingNext.style.filter, filter);

    harness.electronHandlers.onLowPowerIdleModeChange(true);
    assert.strictEqual(harness.api.pendingNext.tagName, "IMG");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep-static.png");
    assert.strictEqual(harness.api.pendingNext.style.filter, filter);

    harness.electronHandlers.onLowPowerIdleModeChange(false);
    assert.strictEqual(harness.api.pendingNext.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "sleep.svg");
    assert.strictEqual(harness.api.pendingNext.style.filter, filter);
  });

  it("gates idle eye-tracking attachment on the follow-idle file", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.ok(source.includes("function tracksEyesForFile(state, file)"));
    assert.match(
      source,
      /if \(commitState && tracksEyesForFile\(commitState, file\)\) {\r?\n\s+attachEyeTracking\(next\);/
    );
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

  it("notifies main once the first pet visual is actually swapped into view", () => {
    const harness = createRendererHarness();

    harness.api.swapToFile("first.svg", "idle", false);
    harness.api.pendingNext.listeners.get("load")();
    harness.api.swapToFile("second.svg", "working", false);
    harness.api.pendingNext.listeners.get("load")();

    assert.deepStrictEqual(
      harness.electronCalls.filter((call) => call.name === "notifyPetVisualReady"),
      [{ name: "notifyPetVisualReady", args: [] }]
    );
  });
});

describe("renderer pet tint", () => {
  it("applies the stamped tint before the pre-IPC initial media load", () => {
    const filter = "sepia(0.8) saturate(2.2) hue-rotate(-18deg) brightness(1.05)";
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: {
        idleFollowSvg: "first.svg",
        petTintPayload: { id: "gold", filter },
      },
    });

    assert.ok(harness.api.pendingNext, "the initial idle visual should be loading");
    assert.strictEqual(harness.api.pendingNext.style.filter, filter);
  });

  it("applies the selected filter to current, pending, and fading media elements", () => {
    const harness = createRendererHarness({
      themeConfig: {
        transitions: {
          "current.svg": { out: 500 },
        },
      },
    });
    const setTint = harness.electronHandlers.onPetTintChange;
    const gold = {
      id: "gold",
      filter: "sepia(0.8) saturate(2.2) hue-rotate(-18deg) brightness(1.05)",
    };

    assert.strictEqual(typeof setTint, "function");
    setTint(gold);
    assert.strictEqual(harness.clawd.style.filter, gold.filter);

    harness.api.swapToFile("next.png", "working", false);
    const pending = harness.api.pendingNext;
    assert.strictEqual(pending.tagName, "IMG");
    assert.strictEqual(pending.style.filter, gold.filter);

    pending.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl, pending);
    assert.strictEqual(harness.clawd.isConnected, true, "old media should still be fading");

    const mono = { id: "mono", filter: "grayscale(1) brightness(1.05)" };
    setTint(mono);
    const filters = [...harness.api.getPetMediaElements()].map((element) => element.style.filter);
    assert.deepStrictEqual(filters, [mono.filter, mono.filter]);
  });

  it("clears invalid or custom CSS payloads instead of applying them", () => {
    const harness = createRendererHarness();
    const setTint = harness.electronHandlers.onPetTintChange;

    setTint({ id: "mono", filter: "grayscale(1) brightness(1.05)" });
    assert.strictEqual(harness.clawd.style.filter, "grayscale(1) brightness(1.05)");
    setTint({ id: "none", filter: "" });
    assert.strictEqual(harness.clawd.style.filter, "");

    setTint({ id: "custom", filter: "url(file:///secret)" });
    assert.strictEqual(harness.clawd.style.filter, "");

    setTint({ id: "none", filter: "grayscale(1)" });
    assert.strictEqual(harness.clawd.style.filter, "");

    setTint("grayscale(1)");
    assert.strictEqual(harness.clawd.style.filter, "");
  });

  it("keeps tint through same-file dedup and theme config reload", () => {
    const harness = createRendererHarness();
    const filter = "hue-rotate(265deg) saturate(1.6) contrast(1.05)";
    harness.electronHandlers.onPetTintChange({ id: "vaporwave", filter });

    harness.api.swapToFile("rest.svg", "working", false);
    harness.api.pendingNext.listeners.get("load")();
    const displayed = harness.api.clawdEl;
    assert.strictEqual(displayed.style.filter, filter);

    harness.electronHandlers.onStateChange("working", "rest.svg");
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.clawdEl, displayed);
    assert.strictEqual(displayed.style.filter, filter);

    harness.electronHandlers.onThemeConfig({
      assetsPath: "../themes/other",
      eyeTracking: { states: [] },
      idleFollowSvg: "idle.svg",
      petTintSupported: true,
    });
    assert.strictEqual(harness.api.clawdEl, displayed);
    assert.strictEqual(displayed.style.filter, filter);
  });

  it("clears a persisted tint when the active theme opts out and restores it when support returns", () => {
    const harness = createRendererHarness();
    const filter = "hue-rotate(265deg) saturate(1.6) contrast(1.05)";
    harness.electronHandlers.onPetTintChange({ id: "vaporwave", filter });
    assert.strictEqual(harness.clawd.style.filter, filter);

    harness.electronHandlers.onThemeConfig({
      assetsPath: "../themes/calico",
      eyeTracking: { states: [] },
      idleFollowSvg: "idle.png",
      petTintSupported: false,
    });
    assert.strictEqual(harness.clawd.style.filter, "");

    harness.electronHandlers.onThemeConfig({
      assetsPath: "../themes/clawd",
      eyeTracking: { states: ["idle"] },
      idleFollowSvg: "idle.svg",
      petTintSupported: true,
    });
    assert.strictEqual(harness.clawd.style.filter, filter);
  });

  it("wires an initial resolved payload and a narrow preload event channel", () => {
    const source = readNormalized(RENDERER);
    const preload = readNormalized(PRELOAD);
    const main = readNormalized(MAIN);

    assert.ok(source.includes('let _petTintPayload = { id: "none", filter: "" };'));
    assert.ok(source.includes("applyPetTintToElement(next);"));
    assert.ok(source.includes("for (const element of getPetMediaElements()) applyPetTintToElement(element);"));
    assert.ok(preload.includes(
      'onPetTintChange: (cb) => ipcRenderer.on("pet-tint-change", (_, payload) => cb(payload))'
    ));
    assert.ok(main.includes(
      "const tintId = getPetTintIdForTheme(petTint, activeTheme && activeTheme._id);"
    ));
  });
});

describe("renderer pet accessory wardrobe", () => {
  function accessoryConfig(overrides = {}) {
    return {
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      eyeTracking: { states: [] },
      idleFollowSvg: "first.svg",
      accessorySupported: true,
      accessoryPayload: {
        id: "cowboy-hat",
        assetFile: "cowboy-hat.svg",
        aspect: 16 / 7,
        widthScale: 1,
        offsetY: 0,
      },
      accessoryAttachments: {
        default: {
          staticFrame: { cx: 50, baseY: 40, width: 20 },
        },
        files: {},
      },
      ...overrides,
    };
  }

  it("primes the fixed catalog asset before the initial pet swap and reveals it after load", () => {
    const filter = "grayscale(1) brightness(1.05)";
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig({
        petTintSupported: true,
        petTintPayload: { id: "mono", filter },
      }),
    });

    assert.strictEqual(harness.accessory.src, "../assets/accessories/cowboy-hat.svg");
    assert.ok(harness.api.pendingNext, "initial media should be loading");
    assert.strictEqual(harness.api.pendingNext.style.filter, filter);

    harness.api.pendingNext.listeners.get("load")();
    assert.ok(harness.api.pendingNext, "pet commit should wait for the selected accessory asset");
    assert.strictEqual(harness.accessory.style.display, "none");
    harness.accessory.onload();

    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.accessory.style.display, "block");
    assert.strictEqual(harness.accessory.style.filter, "none");
    assert.match(harness.accessory.style.transform, /^matrix\(/);
  });

  it("keeps the old anchor through a pending swap, hides declared sleep files, and restores reactions", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig({
        accessoryAttachments: {
          default: {
            staticFrame: { cx: 50, baseY: 40, width: 20 },
          },
          files: {
            "sleep.svg": { visibility: "hidden" },
          },
        },
      }),
    });
    harness.api.pendingNext.listeners.get("load")();
    harness.accessory.onload();
    const originalTransform = harness.accessory.style.transform;

    harness.api.swapToFile("sleep.svg", "sleeping", false);
    assert.strictEqual(harness.accessory.style.display, "block");
    assert.strictEqual(harness.accessory.style.transform, originalTransform);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.accessory.style.display, "none");

    harness.api.swapToFile("reaction.svg", null, false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.accessory.style.display, "block");
  });

  it("follows an exact object target CTM and cancels that RAF on the next media commit", () => {
    const harness = createRendererHarness({
      themeConfig: accessoryConfig({
        accessoryAttachments: {
          default: {
            staticFrame: { cx: 50, baseY: 40, width: 20 },
          },
          files: {
            "dynamic.svg": {
              staticFrame: { cx: 50, baseY: 40, width: 20 },
              followTarget: {
                id: "body-js",
                frame: { cx: 8, baseY: 6, width: 4 },
              },
            },
          },
        },
      }),
    });
    harness.accessory.onload();

    let matrix = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 12 };
    harness.api.swapToFile("dynamic.svg", "working", true);
    const dynamicObject = harness.api.pendingNext;
    dynamicObject.contentDocument = {
      getElementById(id) {
        return id === "body-js" ? { getCTM: () => matrix } : null;
      },
    };
    dynamicObject.listeners.get("load")();
    const firstTransform = harness.accessory.style.transform;
    const followTimer = harness.activeTimers().find((timer) => timer.ms === 16);
    assert.ok(followTimer, "dynamic target should own one RAF");

    matrix = { ...matrix, e: 14 };
    followTimer.callback();
    assert.notStrictEqual(harness.accessory.style.transform, firstTransform);

    const nextFollowTimer = harness.activeTimers().find((timer) => timer.ms === 16 && timer !== followTimer);
    harness.api.swapToFile("static.svg", "working", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(nextFollowTimer.cleared, true);
  });

  it("switches to the object channel only while a selected accessory needs to follow the body", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig({
        eyeTrackingStates: [],
        accessoryPayload: {
          id: "none",
          assetFile: null,
          aspect: 1,
          widthScale: 1,
          offsetY: 0,
        },
        accessoryAttachments: {
          default: {
            staticFrame: { cx: 50, baseY: 40, width: 20 },
          },
          files: {
            "first.svg": {
              staticFrame: { cx: 50, baseY: 40, width: 20 },
              followTarget: {
                id: "accessory-anchor",
                frame: { cx: 8, baseY: 6, width: 4 },
              },
            },
          },
        },
      }),
    });

    const initialImage = harness.api.pendingNext;
    assert.strictEqual(initialImage.tagName, "IMG");
    initialImage.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl.tagName, "IMG");

    harness.electronHandlers.onPetAccessoryChange({
      id: "cowboy-hat",
      assetFile: "cowboy-hat.svg",
      aspect: 16 / 7,
      widthScale: 1,
      offsetY: 0,
    });

    const followingObject = harness.api.pendingNext;
    assert.strictEqual(followingObject.tagName, "OBJECT");
    followingObject.contentDocument = {
      getElementById(id) {
        return id === "accessory-anchor"
          ? {
              getCTM() {
                return { a: 2, b: 0, c: 0, d: 2, e: 10, f: 12 };
              },
            }
          : null;
      },
    };
    followingObject.listeners.get("load")();
    assert.strictEqual(harness.api.pendingNext, followingObject);
    harness.accessory.onload();

    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.clawdEl.tagName, "OBJECT");
    assert.strictEqual(harness.accessory.style.display, "block");

    harness.electronHandlers.onPetAccessoryChange({
      id: "none",
      assetFile: null,
      aspect: 1,
      widthScale: 1,
      offsetY: 0,
    });

    const restoredImage = harness.api.pendingNext;
    assert.strictEqual(restoredImage.tagName, "IMG");
    restoredImage.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl.tagName, "IMG");
    assert.strictEqual(harness.accessory.style.display, "none");
  });

  it("keeps the latest state swap pending when an accessory payload is rebroadcast", () => {
    const attachment = {
      staticFrame: { cx: 50, baseY: 40, width: 20 },
      followTarget: {
        id: "accessory-anchor",
        frame: { cx: 8, baseY: 6, width: 4 },
      },
    };
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig({
        eyeTrackingStates: [],
        accessoryPayload: {
          id: "none",
          assetFile: null,
          aspect: 1,
          widthScale: 1,
          offsetY: 0,
        },
        accessoryAttachments: {
          default: {
            staticFrame: { cx: 50, baseY: 40, width: 20 },
          },
          files: {
            "first.svg": attachment,
            "working.svg": attachment,
          },
        },
      }),
    });

    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl.tagName, "IMG");

    const payload = {
      id: "cowboy-hat",
      assetFile: "cowboy-hat.svg",
      aspect: 16 / 7,
      widthScale: 1,
      offsetY: 0,
    };
    harness.electronHandlers.onPetAccessoryChange(payload);
    harness.electronHandlers.onStateChange("working", "working.svg");

    const workingObject = harness.api.pendingNext;
    assert.strictEqual(workingObject.tagName, "OBJECT");
    assert.strictEqual(harness.api.pendingSvgFile, "working.svg");

    harness.electronHandlers.onPetAccessoryChange(payload);

    assert.strictEqual(
      harness.api.pendingNext,
      workingObject,
      "a repeated payload must not replace the latest state with the displayed file"
    );
    assert.strictEqual(harness.api.pendingSvgFile, "working.svg");
  });

  it("keeps a newly selected asset alive when an old load waiter re-enters cleanup", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig(),
    });
    const pendingPet = harness.api.pendingNext;
    pendingPet.listeners.get("load")();
    assert.ok(harness.api.pendingNext, "the initial pet swap should wait for accessory A");

    harness.electronHandlers.onPetAccessoryChange({
      id: "wizard-hat",
      assetFile: "wizard-hat.svg",
      aspect: 15 / 16,
      widthScale: 0.95,
      offsetY: 0.3,
    });

    assert.strictEqual(harness.accessory.src, "../assets/accessories/wizard-hat.svg");
    assert.strictEqual(typeof harness.accessory.onload, "function");
    harness.accessory.onload();
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.accessory.style.display, "block");
  });

  it("fails open once when an accessory asset never settles and accepts a late load", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig(),
    });
    const pendingPet = harness.api.pendingNext;
    pendingPet.listeners.get("load")();
    assert.ok(harness.api.pendingNext, "the first pet visual should briefly wait for its accessory");

    const loadTimer = harness.api.accessoryAssetLoadTimer;
    assert.ok(loadTimer, "the accessory request should own one bounded load timer");
    loadTimer.cleared = true;
    loadTimer.callback();

    assert.strictEqual(harness.api.accessoryAssetSettled, true);
    assert.strictEqual(harness.api.accessoryAssetLoadTimer, null);
    assert.strictEqual(harness.api.pendingNext, null, "timeout must release the waiting pet visual");
    assert.strictEqual(harness.accessory.style.display, "none");
    assert.strictEqual(
      harness.electronCalls.filter((call) => call.name === "notifyPetVisualReady").length,
      1,
      "the first visible pet must still notify main exactly once"
    );

    harness.accessory.onload();
    assert.strictEqual(harness.accessory.style.display, "block", "a late successful load should recover");
  });

  it("fails open when an accessory asset reports an error", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig(),
    });
    harness.api.pendingNext.listeners.get("load")();
    const loadTimer = harness.api.accessoryAssetLoadTimer;
    assert.ok(loadTimer);

    harness.accessory.onerror();

    assert.strictEqual(loadTimer.cleared, true);
    assert.strictEqual(harness.api.accessoryAssetSettled, true);
    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.accessory.style.display, "none");
    assert.strictEqual(
      harness.electronCalls.filter((call) => call.name === "notifyPetVisualReady").length,
      1
    );
  });

  it("stops dynamic accessory follow while low-power SVG animation is paused", () => {
    const harness = createRendererHarness({
      themeConfig: accessoryConfig({
        accessoryAttachments: {
          default: {
            staticFrame: { cx: 50, baseY: 40, width: 20 },
          },
          files: {
            "dynamic.svg": {
              staticFrame: { cx: 50, baseY: 40, width: 20 },
              followTarget: {
                id: "body-js",
                frame: { cx: 8, baseY: 6, width: 4 },
              },
            },
          },
        },
      }),
    });
    harness.accessory.onload();

    let getCtmCalls = 0;
    harness.api.swapToFile("dynamic.svg", "idle", true);
    const dynamicObject = harness.api.pendingNext;
    dynamicObject.contentDocument = {
      getElementById(id) {
        return id === "body-js"
          ? {
              getCTM() {
                getCtmCalls++;
                return { a: 2, b: 0, c: 0, d: 2, e: 10, f: 12 };
              },
            }
          : null;
      },
    };
    dynamicObject.listeners.get("load")();
    const firstFollow = harness.activeTimers().find((timer) => timer.ms === 16);
    assert.ok(firstFollow, "dynamic target should start one follow RAF");

    harness.api.setCurrentState("idle");
    harness.api.setLowPowerIdleMode(true);
    harness.api.setLowPowerSvgPaused(true);
    assert.strictEqual(firstFollow.cleared, true);
    const callsAtPause = getCtmCalls;
    assert.strictEqual(
      harness.activeTimers().filter((timer) => timer.ms === 16).length,
      0
    );

    harness.windowListeners.get("resize")();
    harness.context.document.hidden = true;
    harness.documentListeners.get("visibilitychange")();
    harness.context.document.hidden = false;
    harness.documentListeners.get("visibilitychange")();
    harness.electronHandlers.onPetAccessoryChange({
      id: "wizard-hat",
      assetFile: "wizard-hat.svg",
      aspect: 15 / 16,
      widthScale: 0.95,
      offsetY: 0.3,
    });
    harness.accessory.onload();
    assert.ok(
      getCtmCalls > callsAtPause,
      "paused refreshes may recompute a one-shot layout without starting a loop"
    );
    assert.strictEqual(
      harness.activeTimers().filter((timer) => timer.ms === 16).length,
      0,
      "refresh, visibility restore, and asset load must not restart follow while paused"
    );

    const callsBeforeResume = getCtmCalls;
    harness.api.setLowPowerSvgPaused(false);
    assert.ok(getCtmCalls > callsBeforeResume, "resume should refresh the dynamic layout once");
    assert.strictEqual(
      harness.activeTimers().filter((timer) => timer.ms === 16).length,
      1,
      "resume should restore exactly one follow RAF"
    );
  });

  it("keeps sibling objects outside tint and pet-media swap cleanup", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: accessoryConfig(),
    });
    harness.api.pendingNext.listeners.get("load")();
    harness.accessory.onload();
    const siblingObject = harness.context.document.createElement("object");
    siblingObject.className = "decorative-object";
    harness.accessoryLayer.appendChild(siblingObject);

    harness.electronHandlers.onPetTintChange({
      id: "mono",
      filter: "grayscale(1) brightness(1.05)",
    });
    assert.strictEqual(siblingObject.style.filter, undefined);

    harness.api.swapToFile("next.svg", "working", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(siblingObject.isConnected, true);
    assert.strictEqual(harness.accessory.isConnected, true);
  });

  it("rejects paths, unbounded geometry, and malformed none payloads", () => {
    const harness = createRendererHarness();
    const normalize = harness.api.normalizeAccessoryPayload;

    assert.strictEqual(normalize({ id: "hat", assetFile: "../hat.svg", aspect: 1, widthScale: 1, offsetY: 0 }).id, "none");
    assert.strictEqual(normalize({ id: "hat", assetFile: "hat.svg", aspect: Infinity, widthScale: 1, offsetY: 0 }).id, "none");
    assert.strictEqual(normalize({ id: "hat", assetFile: "hat.svg", aspect: 1, widthScale: 99, offsetY: 0 }).id, "none");
    assert.strictEqual(normalize({ id: "none", assetFile: "hat.svg", aspect: 1, widthScale: 1, offsetY: 0 }).id, "none");
  });

  it("keeps the structural stages full-size and uses independent transform properties", () => {
    const html = readNormalized(path.join(__dirname, "..", "src", "index.html"));
    const css = readNormalized(path.join(__dirname, "..", "src", "styles.css"));
    const renderer = readNormalized(RENDERER);
    const preload = readNormalized(PRELOAD);

    assert.ok(html.indexOf('id="pet-media-layer"') < html.indexOf('id="pet-accessory-layer"'));
    assert.ok(html.includes('<div id="pet-effect-stage">'));
    assert.ok(html.includes('<div id="pet-particle-layer"></div>'));
    assert.ok(html.indexOf('src="pet-accessory-layout.js"') < html.indexOf('src="renderer.js"'));
    assert.match(
      css,
      /#pet-effect-stage,\s*#pet-particle-layer\s*\{[^}]*pointer-events: none;[^}]*transform: none;[^}]*translate: none;[^}]*scale: none;[^}]*rotate: none;[^}]*\}/
    );
    assert.ok(css.includes("#pet-container.mini-left #pet-facing-stage"));
    assert.ok(css.includes("scale: -1 1;"));
    assert.ok(css.includes("#pet-container.roam-walk #pet-motion-stage"));
    assert.ok(css.includes("translate: 3px 0;"));
    assert.ok(renderer.includes('mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img")'));
    assert.ok(renderer.includes("const activeFlip = shouldApplyMiniAssetFlip(state);"));
    assert.ok(renderer.includes('assetDirectionStage.style.scale = activeFlip ? "-1 1" : "none";'));
    assert.ok(preload.includes(
      'onPetAccessoryChange: (cb) => ipcRenderer.on("pet-accessory-change", (_, payload) => cb(payload))'
    ));
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

describe("renderer initial frame idle visual", () => {
  it("rests on the user-selected idle visual when the theme config carries one", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: {
        idleFollowSvg: "clawd-idle-follow.svg",
        idleDefaultVisual: "clawd-idle-reading.svg",
      },
    });
    assert.strictEqual(harness.api.pendingSvgFile, "clawd-idle-reading.svg");
  });

  it("falls back to the follow sprite when no visual is selected", () => {
    const harness = createRendererHarness({
      initialObjectData: "",
      themeConfig: {
        idleFollowSvg: "clawd-idle-follow.svg",
        idleDefaultVisual: null,
      },
    });
    assert.strictEqual(harness.api.pendingSvgFile, "clawd-idle-follow.svg");
  });
});

describe("renderer file-aware idle eye tracking", () => {
  function restOnIdleVisual(harness, file, { withEyes } = {}) {
    harness.electronHandlers.onStateChange("idle", file);
    const next = harness.api.pendingNext;
    assert.ok(next, `state change to ${file} should start a swap`);
    attachFakeSvgDocument(next, { withEyes: !!withEyes });
    next.listeners.get("load")();
    return next;
  }

  it("attaches eye tracking when idle rests on the follow sprite", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    restOnIdleVisual(harness, "clawd-idle-follow.svg", { withEyes: true });

    assert.ok(harness.api.eyeTarget, "follow sprite must keep eye tracking");
  });

  it("never attaches eye tracking to a non-follow idle visual, even one with eye targets", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    restOnIdleVisual(harness, "clawd-idle-reading.svg", { withEyes: true });
    drainActiveTimers(harness, (timer) => timer.ms === 16 && !timer.cleared);

    assert.strictEqual(harness.api.eyeTarget, null);
  });

  it("does not reattach stale eye tracking on eye move for a non-follow idle visual", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    const nonFollowObject = restOnIdleVisual(
      harness,
      "clawd-idle-reading.svg",
      { withEyes: true }
    );

    // Simulate tracking left behind by an older renderer or a theme reload,
    // then replace the object's document so onEyeMove sees a stale target.
    harness.api.attachEyeTracking(nonFollowObject);
    assert.ok(harness.api.eyeTarget);
    const replacementSvg = attachFakeSvgDocument(nonFollowObject, { withEyes: true });

    harness.electronHandlers.onEyeMove(2, -1);

    assert.strictEqual(harness.api.eyeTarget, null);
    assert.equal(replacementSvg.elements.get("eyes-js").getAttribute("transform"), "");
    assert.equal(
      drainActiveTimers(harness, (timer) => timer.ms === 16 && !timer.cleared),
      0,
      "non-follow idle must not schedule an eye-target reattach retry"
    );
  });

  it("detaches stale eye tracking when the same non-follow idle visual is re-entered", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    const nonFollowObject = restOnIdleVisual(
      harness,
      "clawd-idle-reading.svg",
      { withEyes: true }
    );
    harness.api.attachEyeTracking(nonFollowObject);
    assert.ok(harness.api.eyeTarget);

    harness.electronHandlers.onStateChange("idle", "clawd-idle-reading.svg");

    assert.strictEqual(harness.api.clawdEl, nonFollowObject);
    assert.strictEqual(harness.api.pendingNext, null, "same-file re-entry must not swap media");
    assert.strictEqual(harness.api.eyeTarget, null);
  });

  it("still attaches eye tracking for mini-idle regardless of the idle choice", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    harness.electronHandlers.onStateChange("mini-idle", "clawd-mini.svg");
    const next = harness.api.pendingNext;
    assert.ok(next);
    attachFakeSvgDocument(next, { withEyes: true });
    next.listeners.get("load")();

    assert.ok(harness.api.eyeTarget, "mini-idle eye tracking is not file-gated");
  });

  it("skips the wake eye-object reload and reports resumed on a non-follow resting visual", () => {
    const harness = createRendererHarness({
      themeConfig: { idleFollowSvg: "clawd-idle-follow.svg" },
    });
    restOnIdleVisual(harness, "clawd-idle-reading.svg");
    harness.api.setLowPowerIdleMode(true);

    harness.electronHandlers.onSystemWake({ id: "wake-nonfollow-1", trigger: "resume", attempt: 0 });

    assert.strictEqual(harness.api.pendingNext, null, "no eye-object reload should start");
    const report = harness.electronCalls.find((call) => call.name === "reportSystemWakeStatus");
    assert.ok(report, "wake must report immediately instead of waiting for eye targets");
    assert.equal(report.args[0].id, "wake-nonfollow-1");
    assert.equal(report.args[0].result, "resumed");
    assert.equal(report.args[0].eyeTrackingReady, true);
  });
});

describe("renderer glyph flip compensation", () => {
  it("cancels a stale opposite-channel load when the displayed file already matches again", () => {
    const harness = createRendererHarness({
      themeConfig: {
        eyeTracking: { states: ["idle"] },
        idleFollowSvg: "shared.svg",
      },
    });

    harness.electronHandlers.onStateChange("idle", "shared.svg");
    const displayedObject = harness.api.pendingNext;
    assert.strictEqual(displayedObject.tagName, "OBJECT");
    attachFakeSvgDocument(displayedObject, { withEyes: true });
    displayedObject.listeners.get("load")();

    harness.electronHandlers.onStateChange("roam", "shared.svg");
    const staleImage = harness.api.pendingNext;
    assert.strictEqual(staleImage.tagName, "IMG");

    harness.electronHandlers.onStateChange("idle", "shared.svg");

    assert.strictEqual(harness.api.pendingNext, null);
    assert.strictEqual(harness.api.clawdEl, displayedObject);
    assert.strictEqual(harness.api.currentDisplayedState, "idle");
    staleImage.listeners.get("load")();
    assert.strictEqual(harness.api.clawdEl, displayedObject);
    assert.strictEqual(harness.api.currentDisplayedState, "idle");
  });

  it("retargets a pending same-file swap to the latest state before commit", () => {
    const harness = createRendererHarness({
      themeConfig: {
        hasRoamVisual: true,
        roamFlipAssets: true,
        miniFlipAssets: false,
      },
    });

    harness.electronHandlers.onRoamHeading(true);
    harness.electronHandlers.onStateChange("roam", "shared-crabwalk.svg");
    const pending = harness.api.pendingNext;
    assert.ok(pending);

    harness.electronHandlers.onMiniModeChange(true, "right", { preEntry: true });
    harness.electronHandlers.onStateChange("mini-crabwalk", "shared-crabwalk.svg");

    assert.strictEqual(
      harness.api.pendingNext,
      pending,
      "the loaded asset should stay deduplicated while its commit state is retargeted"
    );
    pending.listeners.get("load")();

    assert.strictEqual(harness.api.currentDisplayedState, "mini-crabwalk");
    assert.strictEqual(
      harness.assetDirectionStage.style.scale,
      "none",
      "miniFlipAssets=false must clear the leftward roam mirror at commit"
    );
  });

  it("retargets a pending same-file object swap to the latest state before commit", () => {
    const harness = createRendererHarness({
      themeConfig: {
        hasRoamVisual: true,
        roamFlipAssets: true,
        miniFlipAssets: false,
        rendering: {
          svgChannel: "object",
        },
      },
    });

    harness.electronHandlers.onRoamHeading(true);
    harness.electronHandlers.onStateChange("roam", "shared-crabwalk.svg");
    const pending = harness.api.pendingNext;
    assert.ok(pending);
    assert.strictEqual(pending.tagName, "OBJECT");

    harness.electronHandlers.onMiniModeChange(true, "right", { preEntry: true });
    harness.electronHandlers.onStateChange("mini-crabwalk", "shared-crabwalk.svg");

    assert.strictEqual(harness.api.pendingNext, pending);
    pending.listeners.get("load")();

    assert.strictEqual(harness.api.currentDisplayedState, "mini-crabwalk");
    assert.strictEqual(harness.assetDirectionStage.style.scale, "none");
  });

  it("preserves each fading media element's stamped direction when the shared stage flips", () => {
    const harness = createRendererHarness({
      themeConfig: {
        hasRoamVisual: true,
        transitions: {
          "roam.svg": { out: 500 },
        },
      },
    });

    harness.electronHandlers.onRoamHeading(true);
    harness.api.swapToFile("roam.svg", "roam", false);
    const roam = harness.api.pendingNext;
    roam.offsetLeft = 37;
    roam.listeners.get("load")();
    assert.strictEqual(harness.assetDirectionStage.style.scale, "-1 1");
    assert.strictEqual(roam.style.scale, "none");

    harness.api.swapToFile("working.svg", "working", false);
    const working = harness.api.pendingNext;
    working.listeners.get("load")();

    assert.strictEqual(harness.assetDirectionStage.style.scale, "none");
    assert.strictEqual(working.style.scale, "none");
    assert.strictEqual(roam.isConnected, true, "old media should still be fading");
    assert.strictEqual(roam.style.opacity, "0");
    assert.strictEqual(roam.style.scale, "-1 1");
    assert.strictEqual(roam.style.transformOrigin, "73px 50%");
  });

  it("preload forwards the accessory facing to main as a plain boolean", () => {
    // The renderer harness stubs electronAPI with a Proxy, so it cannot prove
    // this boundary — only the real preload can.
    const harness = loadPreloadWithElectron();
    try {
      harness.electronAPI.reportAccessoryMirror(true);
      harness.electronAPI.reportAccessoryMirror(0);
      assert.deepStrictEqual(
        harness.sentToMain
          .filter((sent) => sent.channel === "accessory-mirror")
          .map((sent) => sent.args[0]),
        [true, false]
      );
    } finally {
      harness.restore();
    }
  });

  it("tells main which way the accessory ended up facing", () => {
    // Main sizes the native hit window from this. Without the report it keeps
    // its startup default of "upright" forever and the hat is drawn on one
    // side while it stays draggable on the other.
    const harness = createRendererHarness({ themeConfig: { hasRoamVisual: true } });
    const reported = () => harness.electronCalls
      .filter((call) => call.name === "reportAccessoryMirror")
      .map((call) => call.args[0]);

    harness.electronHandlers.onRoamHeading(true);
    harness.api.swapToFile("roam.svg", "roam", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.assetDirectionStage.style.scale, "-1 1");
    assert.strictEqual(reported().at(-1), true, "a left-heading walk mirrors the accessory");

    harness.electronHandlers.onRoamHeading(false);
    assert.strictEqual(harness.assetDirectionStage.style.scale, "none");
    assert.strictEqual(reported().at(-1), false, "reversing the walk reports the change");

    // Edge-triggered: redundant recomputes must not spam main.
    const before = reported().length;
    harness.electronHandlers.onRoamHeading(false);
    assert.strictEqual(reported().length, before, "an unchanged facing must not re-report");
  });

  it("reports the two mirror stages composed, not just one of them", () => {
    const harness = createRendererHarness({ themeConfig: { miniFlipAssets: true } });
    const lastReported = () => {
      const calls = harness.electronCalls.filter((call) => call.name === "reportAccessoryMirror");
      return calls.length ? calls[calls.length - 1].args[0] : null;
    };

    // Edge-left flips the facing stage while a non-mini visual is on screen.
    harness.electronHandlers.onMiniModeChange(true, "left", {});
    assert.strictEqual(lastReported(), true, "mini-left alone mirrors the accessory");

    // A mini visual adds the asset-direction flip; the two cancel out.
    harness.api.swapToFile("mini-idle.svg", "mini-idle", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(lastReported(), false, "both stages flipped means upright again");
  });

  it("flips reverse-drawn mini crabwalk assets during pre-entry without entering mini layout", () => {
    const harness = createRendererHarness({ themeConfig: { miniFlipAssets: true } });

    // Pre-entry: the walk-in starts before mini mode is really on, and the
    // walk-in visual has to face the right way for the whole walk.
    harness.electronHandlers.onMiniModeChange(true, "right", { preEntry: true });
    harness.api.swapToFile("crabwalk.svg", "mini-crabwalk", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.assetDirectionStage.style.scale, "-1 1");

    // Other mini visuals keep their orientation until the mini swap happens.
    harness.api.swapToFile("mini-idle.svg", "mini-idle", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.assetDirectionStage.style.scale, "none");

    // Once mini mode is actually active they all flip.
    harness.electronHandlers.onMiniModeChange(true, "right", {});
    harness.api.swapToFile("mini-peek.svg", "mini-peek", false);
    harness.api.pendingNext.listeners.get("load")();
    assert.strictEqual(harness.assetDirectionStage.style.scale, "-1 1");
  });

  it("notifies object-channel SVGs when mini-left glyph compensation changes", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("typeof svgWindow.__clawdSetGlyphFlipCompensation === \"function\""));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(true);"));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(false);"));
  });
});

// Issue #690 Phase 2 item 3: renderer applies a composite-only signed X
// translate to the existing #pet-container for the Linux outer-edge viewport
// offset. §6.5 of docs/plans/plan-issue-690-gnome-mini-edge-snap.md: the
// harness here is node:vm + a hand-written DOM stub with no real layout
// engine, so these tests can only prove translate is written to the right
// element/layer and that the handler is composite-only — the actual visual
// direction under the mini-left mirror needs the real-machine QA in §7.
describe("renderer viewport offset X (#690)", () => {
  it("writes a signed composite-only translate to #pet-container", () => {
    const harness = createRendererHarness();

    harness.electronHandlers.onViewportOffsetX(99);
    assert.strictEqual(harness.container.style.translate, "99px 0");

    harness.electronHandlers.onViewportOffsetX(-99);
    assert.strictEqual(harness.container.style.translate, "-99px 0");
  });

  it("does not touch per-asset bottom, applyObjectScaleStyle(), or refreshAccessoryLayout() (composite-only)", () => {
    const harness = createRendererHarness();
    harness.clawd.style.bottom = "calc(5% + 3px)";
    harness.accessory.style.transform = "matrix(1,0,0,1,4,5)";
    const bottomBefore = harness.clawd.style.bottom;
    const accessoryTransformBefore = harness.accessory.style.transform;

    harness.electronHandlers.onViewportOffsetX(40);

    assert.strictEqual(
      harness.clawd.style.bottom,
      bottomBefore,
      "X offset must never touch per-asset bottom — that is the Y-offset layout path (plan §4.4 point 4)"
    );
    assert.strictEqual(
      harness.accessory.style.transform,
      accessoryTransformBefore,
      "X offset must not trigger an accessory layout refresh"
    );
  });

  it("keeps the setViewportOffsetX handler source strictly composite-only", () => {
    const source = readNormalized(RENDERER);
    const match = source.match(/function setViewportOffsetX\(offsetX\) \{[\s\S]*?\n\}/);
    assert.ok(match, "setViewportOffsetX() must exist in the renderer");
    const body = match[0];

    assert.ok(!body.includes("applyObjectScaleStyle"), "must not call applyObjectScaleStyle()");
    assert.ok(!body.includes("refreshAccessoryLayout"), "must not call refreshAccessoryLayout()");
    assert.ok(!body.includes(".bottom"), "must not write any element's bottom");
    assert.ok(!body.includes(".left"), "must not write any element's left");
    assert.ok(body.includes("container.style.translate"), "must write the composite-only translate property");
  });

  it("writes the translate on #pet-container only, not on any descendant layer", () => {
    const harness = createRendererHarness();

    harness.electronHandlers.onViewportOffsetX(30);

    assert.strictEqual(harness.container.id, "pet-container");
    assert.strictEqual(harness.container.style.translate, "30px 0");
    // #pet-facing-stage (mini-left's mirror layer) and #pet-effect-stage are
    // both direct children of #pet-container in the real DOM (src/index.html)
    // and in this harness (container.appendChild(facingStage) /
    // container.appendChild(effectStage)). Neither should receive its own
    // translate from this handler — the shift must come from the parent
    // alone so descendants inherit it "for free".
    for (const child of harness.container.children) {
      assert.strictEqual(
        child.style.translate,
        undefined,
        `${child.id} must not receive its own translate from the X-offset handler`
      );
    }
  });

  it("leaves non-composite properties of media, accessory, and effect layers alone across repeated offset changes", () => {
    const harness = createRendererHarness();
    const clawdBottomBefore = harness.clawd.style.bottom;
    const accessoryDisplayBefore = harness.accessory.style.display;

    harness.electronHandlers.onViewportOffsetX(12);
    harness.electronHandlers.onViewportOffsetX(-7);
    harness.electronHandlers.onViewportOffsetX(0);

    assert.strictEqual(harness.container.style.translate, "0px 0");
    assert.strictEqual(harness.clawd.style.bottom, clawdBottomBefore);
    assert.strictEqual(harness.accessory.style.display, accessoryDisplayBefore);
  });

  it("restores the current offset through the same did-finish-load resend path as viewport-offset (Y)", () => {
    const preload = readNormalized(PRELOAD);
    const main = readNormalized(MAIN);
    const runtime = readNormalized(path.join(__dirname, "..", "src", "pet-window-runtime.js"));

    // PR #751 Codex review #12 (rework batch B-8): preload's bridge now
    // normalizes a non-finite value to 0 (see the "§6.6" behavioral test
    // below for the actual proof) — this string check just confirms the
    // bridge still exists and still forwards to cb(...) at all.
    assert.ok(preload.includes(
      'onViewportOffsetX: (cb) => ipcRenderer.on("viewport-offset-x", (_, offsetX) => cb(Number.isFinite(offsetX) ? offsetX : 0))'
    ));
    // PR #751 Codex review #11 (rework batch B-6): main.js's did-finish-load
    // used to send both offsets unconditionally via two separate
    // sendToRenderer calls; it now delegates to a single runtime method,
    // which is what actually decides whether X is worth sending at all (see
    // the behavioral test below).
    assert.ok(main.includes("petWindowRuntime.resendViewportOffsets();"));
    assert.ok(runtime.includes("getViewportOffsetX,"));
    assert.ok(runtime.includes("setViewportOffsetX,"));
    assert.ok(runtime.includes("resendViewportOffsets,"));
  });

  // PR #751 Codex review #11 (rework batch B-6, non-blocking): the old
  // version of the test above only checked that main.js's SOURCE TEXT
  // contained two particular sendToRenderer call strings — it could not
  // distinguish "always sends viewport-offset-x, even at 0" from "only sends
  // it when non-zero", because it never actually ran the function. This
  // constructs the real runtime (createPetWindowRuntime has a safe default
  // for every option, so an empty/minimal options object is enough) and
  // drives resendViewportOffsets() directly, proving the actual conditional
  // behavior: a Windows/macOS-shaped reload (offsetX always 0) never
  // receives viewport-offset-x at all, while a context with a genuine
  // non-zero X offset (Linux edge-virtualization) does.
  it("resendViewportOffsets() behaviorally sends Y unconditionally and X only when non-zero", () => {
    const createPetWindowRuntime = require(path.join(__dirname, "..", "src", "pet-window-runtime.js"));
    const sent = [];
    const runtime = createPetWindowRuntime({
      sendToRenderer: (...args) => sent.push(args),
    });

    // Windows/macOS reload shape: offsetX was never touched, stays at its
    // cold-start default of 0.
    runtime.resendViewportOffsets();
    assert.deepStrictEqual(
      sent, [["viewport-offset", 0]],
      "a reload with X at 0 must resend Y but must NOT send viewport-offset-x at all"
    );

    // Linux edge-virtualization reload shape: a genuine non-zero X offset is
    // already in effect (set directly here — legality/clamping is
    // guardOffsetXLegalDomain's concern, not setViewportOffsetX's own, so
    // this is a faithful way to put the runtime in that state without
    // reconstructing a full Mutter-clamp scenario in this renderer-focused
    // test file; see test/pet-window-runtime.test.js for that scenario).
    sent.length = 0;
    runtime.setViewportOffsetX(51);
    sent.length = 0; // isolate the resend call from setViewportOffsetX's own initial send

    runtime.resendViewportOffsets();
    assert.deepStrictEqual(
      sent,
      [["viewport-offset", 0], ["viewport-offset-x", 51]],
      "a reload with a genuine non-zero X offset must resend both"
    );
  });

  // PR #751 Codex review #12 (rework batch B-8, §6.6, non-blocking): loads
  // the REAL src/preload.js (not createRendererHarness()'s hand-written
  // electronAPI Proxy, which bypasses preload.js's real ipcRenderer.on(...)
  // wrapping entirely) and proves the bridge itself zeroes a non-finite
  // value before it ever reaches the renderer's callback — a defense-in-depth
  // layer independent of whatever the renderer side does with the value.
  it("§6.6: preload's onViewportOffset/onViewportOffsetX zero a non-finite value at the bridge boundary", () => {
    const loader = loadPreloadWithElectron();
    try {
      const receivedY = [];
      const receivedX = [];
      loader.electronAPI.onViewportOffset((offsetY) => receivedY.push(offsetY));
      loader.electronAPI.onViewportOffsetX((offsetX) => receivedX.push(offsetX));

      loader.emitFromMain("viewport-offset", NaN);
      loader.emitFromMain("viewport-offset", Infinity);
      loader.emitFromMain("viewport-offset", -Infinity);
      loader.emitFromMain("viewport-offset", undefined);
      loader.emitFromMain("viewport-offset", 20); // legal value must still pass through untouched

      loader.emitFromMain("viewport-offset-x", NaN);
      loader.emitFromMain("viewport-offset-x", Infinity);
      loader.emitFromMain("viewport-offset-x", -Infinity);
      loader.emitFromMain("viewport-offset-x", undefined);
      loader.emitFromMain("viewport-offset-x", -51); // legal negative value must still pass through untouched

      assert.deepStrictEqual(receivedY, [0, 0, 0, 0, 20], "every non-finite Y value must be zeroed; a legal value must pass through unchanged");
      assert.deepStrictEqual(receivedX, [0, 0, 0, 0, -51], "every non-finite X value must be zeroed; a legal negative value must pass through unchanged");
    } finally {
      loader.restore();
    }
  });
});
