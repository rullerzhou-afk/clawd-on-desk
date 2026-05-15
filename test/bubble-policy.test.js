"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getBubblePolicy,
  isAllBubblesHidden,
  buildAggregateHideCommit,
  buildCategoryEnabledCommit,
} = require("../src/bubble-policy");

describe("bubble policy", () => {
  it("keeps permission bubbles visible without auto-close by default", () => {
    assert.deepStrictEqual(getBubblePolicy({}, "permission"), {
      enabled: true,
      autoCloseMs: 0,
    });
  });

  it("maps permissionBubbleAutoCloseSeconds to autoCloseMs for permission kind", () => {
    assert.deepStrictEqual(getBubblePolicy({ permissionBubbleAutoCloseSeconds: 30 }, "permission"), {
      enabled: true,
      autoCloseMs: 30000,
    });
    assert.deepStrictEqual(getBubblePolicy({ permissionBubbleAutoCloseSeconds: 0 }, "permission"), {
      enabled: true,
      autoCloseMs: 0,
    });
  });

  it("disabling the permission bubble switch ignores any autoclose seconds", () => {
    assert.deepStrictEqual(
      getBubblePolicy({ permissionBubblesEnabled: false, permissionBubbleAutoCloseSeconds: 60 }, "permission"),
      { enabled: false, autoCloseMs: 60000 }
    );
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
      hideBubbles: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    }), true);
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
      notificationBubbleAutoCloseSeconds: 6,
      updateBubbleAutoCloseSeconds: 0,
      hideBubbles: false,
    });
  });

  it("category toggles preserve existing positive auto-close seconds", () => {
    const result = buildCategoryEnabledCommit({
      hideBubbles: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 1,
      updateBubbleAutoCloseSeconds: 12,
    }, "notification", true);
    assert.deepStrictEqual(result.commit, {
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 1,
      updateBubbleAutoCloseSeconds: 12,
      hideBubbles: false,
    });
  });

  it("uses aggregate hide as an override without destroying category settings", () => {
    assert.deepStrictEqual(getBubblePolicy({
      hideBubbles: true,
      notificationBubbleAutoCloseSeconds: 12,
    }, "notification"), {
      enabled: false,
      autoCloseMs: 0,
    });
    assert.deepStrictEqual(buildAggregateHideCommit(true, {
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    }), {
      hideBubbles: true,
    });
    assert.deepStrictEqual(buildAggregateHideCommit(false, {
      hideBubbles: true,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    }), {
      hideBubbles: false,
    });
  });

  it("restores defaults when the aggregate menu is used on fully disabled categories", () => {
    assert.deepStrictEqual(buildAggregateHideCommit(false, {
      hideBubbles: true,
      permissionBubblesEnabled: false,
      notificationBubbleAutoCloseSeconds: 0,
      updateBubbleAutoCloseSeconds: 0,
    }), {
      hideBubbles: false,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 6,
      updateBubbleAutoCloseSeconds: 9,
    });
  });
});
