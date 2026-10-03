"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createQuotaNotificationPresenter, formatQuotaAlert } = require("../src/quota-notifications");
const EVENT = { type: "low", providerKey: "codexQuota", windowMinutes: 300, remainingPercent: 9 };
function harness(overrides = {}) {
  const notifications = [], timers = new Map(), clicks = [];
  let suppressed = false, muted = false, supported = true, throws = false;
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { if (throws) throw new Error("native failure"); }
    close() { this.closed = true; }
  }
  const presenter = createQuotaNotificationPresenter({ Notification, platform: "win32",
    getLang: () => "zh", isSuppressed: () => suppressed, isMuted: () => muted,
    openSettings: () => clicks.push(true), getTray: () => ({}), trayBalloonOwner: { show: () => false },
    setTimeout(fn, ms) { const token = {}; timers.set(token, { fn, ms }); return token; },
    clearTimeout(token) { timers.delete(token); },
    ...overrides,
  });
  return { presenter, notifications, timers, clicks,
    suppress(value) { suppressed = value; }, mute(value) { muted = value; },
    support(value) { supported = value; }, throws(value) { throws = value; } };
}
test("format all languages using actual window length; omit unknown duration cleanly", () => {
  for (const lang of ["en", "zh", "zh-TW", "ja", "ko", "pt-BR", "es"]) {
    for (const n of [300, 1440, 10080, 90, null]) {
      const value = formatQuotaAlert({ ...EVENT, windowMinutes: n }, lang);
      assert.ok(value.body.includes("9")); assert.ok(!/[{}]/.test(value.body));
      if (!n) assert.ok(!value.body.includes("·"));
    }
    assert.notEqual(formatQuotaAlert({ ...EVENT, type: "recovered" }, lang).title, formatQuotaAlert(EVENT, lang).title);
  }
});
test("wait for native show, respect mute and retain the click handler until close", async () => {
  const h = harness(); h.mute(true);
  let resolved = false; const pending = h.presenter.show(EVENT).then(v => { resolved = true; return v; });
  await Promise.resolve(); assert.equal(resolved, false);
  const n = h.notifications[0]; assert.equal(n.options.silent, true);
  n.emit("show"); assert.equal(await pending, true);
  assert.equal([...h.timers.values()][0].ms, 60_000);
  n.emit("click"); assert.equal(h.clicks.length, 1); assert.equal(h.timers.size, 0);
  assert.equal(n.listenerCount("click"), 0); h.presenter.dispose();
});
test("async native failure and show timeout are not acknowledged", async () => {
  const h = harness(); const first = h.presenter.show(EVENT);
  h.notifications[0].emit("failed", "system error"); assert.equal(await first, false);
  assert.equal(h.notifications[0].closed, true);
  const second = h.presenter.show(EVENT); [...h.timers.values()][0].fn();
  assert.equal(await second, false); assert.equal(h.notifications[1].closed, true);
  h.notifications[1].emit("show"); assert.equal(h.timers.size, 0); h.presenter.dispose();
});
test("sync errors, DND and unavailable notification backends fail safely", async () => {
  const h = harness(); h.throws(true); assert.equal(await h.presenter.show(EVENT), false);
  h.suppress(true); assert.equal(await h.presenter.test(), false); assert.equal(h.notifications.length, 1);
  h.suppress(false); h.support(false); assert.equal(await h.presenter.show(EVENT), false); h.presenter.dispose();
});
test("shutdown settles in-flight sends and releases displayed notifications", async () => {
  const h = harness(); const pending = h.presenter.show(EVENT);
  h.presenter.dispose(); assert.equal(await pending, false); assert.equal(h.timers.size, 0);
  assert.equal(h.notifications[0].closed, true); assert.equal(await h.presenter.show(EVENT), false);
});
test("fixed test notification has no synthetic provider usage", async () => {
  const h = harness(), pending = h.presenter.test();
  assert.equal(h.notifications[0].options.title, "Clawd 通知测试");
  assert.ok(!h.notifications[0].options.body.includes("9%"));
  h.notifications[0].emit("show"); assert.equal(await pending, true); h.presenter.dispose();
});
test("click failures cannot escape the native event handler", async () => {
  const h = harness({ openSettings() { throw new Error("window unavailable"); } });
  const pending = h.presenter.show(EVENT); h.notifications[0].emit("show");
  assert.equal(await pending, true);
  assert.doesNotThrow(() => h.notifications[0].emit("click"));
  assert.equal(h.timers.size, 0); h.presenter.dispose();
});
test("unsupported native notifications use the Windows balloon fallback only when unmuted", async () => {
  let balloons = 0;
  const h = harness({ trayBalloonOwner: { show() { balloons++; return true; } } }); h.support(false);
  assert.equal(await h.presenter.show(EVENT), true); assert.equal(balloons, 1);
  h.mute(true); assert.equal(await h.presenter.show(EVENT), false); assert.equal(balloons, 1); h.presenter.dispose();
  const linux = harness({ platform: "linux", trayBalloonOwner: { show() { throw new Error("must not show"); } } });
  linux.support(false); assert.equal(await linux.presenter.show(EVENT), false); linux.presenter.dispose();
});
