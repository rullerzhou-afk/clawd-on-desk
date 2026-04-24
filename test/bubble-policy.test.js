"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getBubblePolicy,
  isAllBubblesHidden,
  buildCategoryEnabledCommit,
} = require("../src/bubble-policy");

describe("bubble policy", () => {
  it("keeps permission bubbles visible without auto-close by default", () => {
    assert.deepStrictEqual(getBubblePolicy({}, "permission"), {
      enabled: true,
      autoCloseMs: null,
    });
  });

  it("maps notification and update seconds to enabled policies", () => {
    assert.deepStrictEqual(getBubblePolicy({ notificationBubbleAutoCloseSeconds: 2 }, "notification"), {
      enabled: true,
      autoCloseMs: 2000,
    });
    assert.deepStrictEqual(getBubblePolicy({ updateBubbleAutoCloseSeconds: 0 }, "update"), {
      enabled: false,
      autoCloseMs: 0,
    });
  });

  it("treats aggregate hidden as all three categories off", () => {
    assert.strictEqual(isAllBubblesHidden({
      permissionBubblesEnabled: false,
      notificationBubbleAutoCloseSeconds: 0,
      updateBubbleAutoCloseSeconds: 0,
    }), true);
    assert.strictEqual(isAllBubblesHidden({
      permissionBubblesEnabled: false,
      notificationBubbleAutoCloseSeconds: 0,
      updateBubbleAutoCloseSeconds: 9,
    }), false);
  });

  it("category toggles update the matching setting and aggregate flag", () => {
    const snapshot = {
      permissionBubblesEnabled: false,
      notificationBubbleAutoCloseSeconds: 0,
      updateBubbleAutoCloseSeconds: 0,
    };
    const result = buildCategoryEnabledCommit(snapshot, "notification", true);
    assert.deepStrictEqual(result.commit, {
      permissionBubblesEnabled: false,
      notificationBubbleAutoCloseSeconds: 3,
      updateBubbleAutoCloseSeconds: 0,
      hideBubbles: false,
    });
  });
});
