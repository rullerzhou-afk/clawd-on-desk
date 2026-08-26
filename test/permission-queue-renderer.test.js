"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "permission-queue-renderer.js"),
  "utf8"
);

function fakeElement(options = {}) {
  const classes = new Set();
  const children = [];
  return {
    className: "",
    disabled: false,
    scrollHeight: options.scrollHeight || 0,
    title: "",
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener() {},
    append(...nodes) { children.push(...nodes); },
    appendChild(node) { children.push(node); },
    setAttribute() {},
    set textContent(value) {
      this._textContent = String(value);
      if (value === "") children.length = 0;
    },
    get textContent() { return this._textContent || ""; },
  };
}

function createRendererHarness() {
  const elements = new Map([
    ["queueCard", fakeElement({ scrollHeight: 288 })],
    ["queueLauncher", fakeElement()],
    ["queueLauncherCopy", fakeElement()],
    ["queueLauncherAction", fakeElement()],
    ["queueTitle", fakeElement()],
    ["queueClose", fakeElement()],
    ["queueList", fakeElement()],
  ]);
  const acknowledgements = [];
  const animationFrames = [];
  let visibilityState = "hidden";
  let showHandler = null;

  const document = {
    get visibilityState() { return visibilityState; },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return fakeElement(); },
  };
  const window = {
    addEventListener() {},
    permissionQueueAPI: {
      acknowledge(payload) {
        acknowledgements.push(JSON.parse(JSON.stringify(payload)));
      },
      close() {},
      onShow(handler) { showHandler = handler; },
      open() {},
      select() {},
    },
  };

  vm.runInNewContext(RENDERER_SOURCE, {
    document,
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    window,
  });

  return {
    acknowledgements,
    animationFrames,
    setVisible() { visibilityState = "visible"; },
    show(payload) { showHandler(payload); },
    flushAnimationFrame() {
      const callback = animationFrames.shift();
      if (callback) callback();
    },
  };
}

function queuePayload(revision, drawerOpen) {
  return {
    revision,
    drawerOpen,
    hiddenCount: 3,
    totalCount: 4,
    switchingLocked: false,
    sessions: [],
    lang: "en",
  };
}

test("hidden queue ACK bypasses suspended rAF, then visible drawer measurement waits a frame", () => {
  const harness = createRendererHarness();

  harness.show(queuePayload(1, false));
  assert.deepStrictEqual(harness.acknowledgements, [{ revision: 1 }]);
  assert.strictEqual(harness.animationFrames.length, 0,
    "a never-shown queue cannot depend on an animation frame to become visible");

  harness.setVisible();
  harness.show(queuePayload(2, true));
  assert.deepStrictEqual(harness.acknowledgements, [{ revision: 1 }],
    "visible drawer measurement still waits for the rendered frame");
  assert.strictEqual(harness.animationFrames.length, 1);

  harness.flushAnimationFrame();
  assert.deepStrictEqual(harness.acknowledgements, [
    { revision: 1 },
    { revision: 2, height: 300 },
  ]);
});
