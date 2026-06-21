"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createSettingsEffectRouter = require("../src/settings-effect-router");

function createFakeSettingsController() {
  let subscriber = null;
  return {
    controller: {
      getSnapshot: () => ({ shortcuts: {} }),
      subscribe: (fn) => {
        subscriber = fn;
        return () => {
          if (subscriber === fn) subscriber = null;
        };
      },
      subscribeKey: () => () => {},
    },
    emit(changes) {
      assert.strictEqual(typeof subscriber, "function", "router should subscribe to settings");
      subscriber({ changes, snapshot: { shortcuts: {}, ...changes } });
    },
  };
}

describe("settings effect router notification auto-close sync", () => {
  it("clears 0-second notify bubbles and refreshes visible notify timers for positive values", () => {
    const calls = [];
    const { controller, emit } = createFakeSettingsController();
    const router = createSettingsEffectRouter({
      settingsController: controller,
      clearCodexNotifyBubbles: (...args) => calls.push(["clearCodex", ...args]),
      clearKimiNotifyBubbles: (...args) => calls.push(["clearKimi", ...args]),
      clearStateNotifyBubbles: (...args) => calls.push(["clearState", ...args]),
      refreshPassiveNotifyAutoClose: () => calls.push(["refreshPassive"]),
      updateMirrors: () => {},
    });

    router.start();
    emit({ notificationBubbleAutoCloseSeconds: 0 });
    assert.deepStrictEqual(calls, [
      ["clearCodex", undefined, "settings-policy-disabled"],
      ["clearKimi", undefined, "settings-policy-disabled"],
      ["clearState", undefined, "settings-policy-disabled"],
    ]);

    calls.length = 0;
    emit({ notificationBubbleAutoCloseSeconds: 10 });
    assert.deepStrictEqual(calls, [["refreshPassive"]]);

    calls.length = 0;
    emit({ hideBubbles: true, notificationBubbleAutoCloseSeconds: 10 });
    assert.deepStrictEqual(calls, [
      ["clearCodex", undefined, "settings-policy-disabled"],
      ["clearKimi", undefined, "settings-policy-disabled"],
      ["clearState", undefined, "settings-policy-disabled"],
    ]);
  });

  it("hides 0-second update bubbles and refreshes visible update-bubble timers for positive values", () => {
    const calls = [];
    const { controller, emit } = createFakeSettingsController();
    const router = createSettingsEffectRouter({
      settingsController: controller,
      hideUpdateBubbleForPolicy: () => calls.push(["hideUpdate"]),
      refreshUpdateBubbleAutoClose: () => calls.push(["refreshUpdate"]),
      updateMirrors: () => {},
    });

    router.start();
    emit({ updateBubbleAutoCloseSeconds: 0 });
    assert.deepStrictEqual(calls, [["hideUpdate"]]);

    calls.length = 0;
    emit({ updateBubbleAutoCloseSeconds: 10 });
    assert.deepStrictEqual(calls, [["refreshUpdate"]]);

    calls.length = 0;
    emit({ hideBubbles: true, updateBubbleAutoCloseSeconds: 10 });
    assert.deepStrictEqual(calls, [["hideUpdate"]]);
  });
});
