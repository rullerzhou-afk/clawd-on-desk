"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const modulePath = require.resolve("../src/permission");
delete require.cache[modulePath];
const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === "electron") {
    return {
      BrowserWindow: { fromWebContents: (sender) => sender && sender.__win },
      globalShortcut: {
        register: () => true,
        unregister() {},
        isRegistered: () => false,
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const initPermission = require("../src/permission");
Module._load = originalLoad;

function interaction(capabilities = {}) {
  return {
    intent: capabilities.answerQuestions ? "human-question"
      : (capabilities.planFeedback ? "plan-review" : "tool-approval"),
    automationEligibility: { autoTools: false, unattended: false },
    capabilities: {
      allowDeny: true,
      answerQuestions: false,
      planFeedback: false,
      nativeFallback: true,
      ...capabilities,
    },
  };
}

function makeCtx() {
  return {
    lang: "en",
    sessions: new Map(),
    getSettingsSnapshot: () => ({}),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 800, y: 400, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    subscribeShortcuts: () => () => {},
    bubbleFollowPet: false,
    bubbleFixedCorner: "bottom-right",
    win: null,
  };
}

function makeBubble() {
  const sends = [];
  return {
    sends,
    focusCount: 0,
    isDestroyed: () => false,
    webContents: { send: (...args) => sends.push(args) },
    focus() { this.focusCount += 1; },
  };
}

function eventFor(bubble) {
  return { sender: { __win: bubble } };
}

describe("permission expanded presentation owner", () => {
  it("keeps one expanded owner, focuses Plan/Ask only after the user expands, and honors IME composition lock", () => {
    const permission = initPermission(makeCtx());
    const planBubble = makeBubble();
    const ordinaryBubble = makeBubble();
    const plan = {
      bubble: planBubble,
      bubbleReady: true,
      interaction: interaction({ planFeedback: true }),
      suggestions: [],
    };
    const ordinary = {
      bubble: ordinaryBubble,
      bubbleReady: true,
      interaction: interaction(),
      suggestions: [],
    };
    permission.pendingPermissions.push(plan, ordinary);

    assert.strictEqual(permission.handleBubbleExpanded(eventFor(planBubble), true), true);
    assert.strictEqual(plan.expanded, true);
    assert.strictEqual(planBubble.focusCount, 1);

    permission.handleCompositionActive(eventFor(planBubble), true);
    assert.strictEqual(permission.handleBubbleExpanded(eventFor(ordinaryBubble), true), false);
    assert.strictEqual(plan.expanded, true);
    assert.strictEqual(ordinary.expanded, false);

    permission.handleCompositionActive(eventFor(planBubble), false);
    assert.strictEqual(permission.handleBubbleExpanded(eventFor(ordinaryBubble), true), true);
    assert.strictEqual(plan.expanded, false);
    assert.strictEqual(ordinary.expanded, true);
    assert.strictEqual(ordinaryBubble.focusCount, 0);
    assert.ok(planBubble.sends.some(([channel, payload]) =>
      channel === "permission-presentation" && payload.expanded === false
    ));
  });

  it("rejects stale height acknowledgements from the previous presentation epoch", () => {
    const permission = initPermission(makeCtx());
    const bubble = makeBubble();
    const entry = {
      bubble,
      bubbleReady: true,
      interaction: interaction(),
      suggestions: [],
    };
    permission.pendingPermissions.push(entry);
    permission.handleBubbleExpanded(eventFor(bubble), true);
    assert.strictEqual(entry.measurementEpoch, 1);

    permission.handleBubbleHeight(eventFor(bubble), {
      height: 900,
      state: "expanded",
      measurementEpoch: 0,
    });
    assert.strictEqual(entry.expandedMeasuredHeight, undefined);

    permission.handleBubbleHeight(eventFor(bubble), {
      height: 600,
      state: "expanded",
      measurementEpoch: 1,
      chromeHeight: 180,
      detailLineHeight: 18,
    });
    assert.strictEqual(entry.expandedMeasuredHeight, 600);
    assert.strictEqual(entry.expandedChromeHeight, 180);
  });
});
