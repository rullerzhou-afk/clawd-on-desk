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
test("Claude and Antigravity slot names supply missing lengths while explicit reports remain authoritative", () => {
  // Each slot is paired with the provider that actually owns it: only Claude
  // Code and Antigravity infer a window from the slot name.
  const slots = [
    ["claudeQuota", "claudeFiveHour", 300, "claudeWeekly"],
    ["claudeQuota", "claudeWeekly", 10080, "claudeFiveHour"],
    ["antigravityQuota", "geminiFiveHour", 300, "geminiWeekly"],
    ["antigravityQuota", "geminiWeekly", 10080, "geminiFiveHour"],
    ["antigravityQuota", "thirdPartyFiveHour", 300, "thirdPartyWeekly"],
    ["antigravityQuota", "thirdPartyWeekly", 10080, "thirdPartyFiveHour"],
  ];
  for (const lang of ["en", "zh", "zh-TW", "ja", "ko", "pt-BR", "es"]) {
    for (const [providerKey, windowKey, minutes, siblingWindowKey] of slots) {
      const event = { ...EVENT, providerKey, windowKey };
      // A missing duration renders exactly like the slot's implied duration.
      assert.deepEqual(formatQuotaAlert({ ...event, windowMinutes: null }, lang),
        formatQuotaAlert({ ...event, windowMinutes: minutes }, lang));
      // An explicit duration wins over the slot name; both sides share the
      // provider and group, so their display names match too.
      assert.deepEqual(formatQuotaAlert({ ...event, windowMinutes: 90 }, lang),
        formatQuotaAlert({ ...event, windowKey: siblingWindowKey, windowMinutes: 90 }, lang));
    }
    assert.ok(!formatQuotaAlert({ ...EVENT, providerKey: "claudeQuota", windowKey: "unknown",
      windowMinutes: null }, lang).body.includes("·"));
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

test("claude quota slots imply their window when the report omits a duration", () => {
  const fiveHour = { type: "low", providerKey: "claudeQuota", windowKey: "claudeFiveHour", remainingPercent: 15 };
  const weekly = { type: "low", providerKey: "claudeQuota", windowKey: "claudeWeekly", remainingPercent: 9 };
  assert.equal(formatQuotaAlert(fiveHour, "zh").body, "Claude Code · 5 小时额度：剩余 15%。");
  assert.equal(formatQuotaAlert(weekly, "zh").body, "Claude Code · 7 天额度：剩余 9%。");
  assert.equal(formatQuotaAlert(fiveHour, "en").body, "Claude Code · 5-hour window: 15% remaining.");
  assert.equal(formatQuotaAlert(weekly, "en").body, "Claude Code · 7-day window: 9% remaining.");
});

test("antigravity names its two quota groups and infers their windows", () => {
  const geminiWeekly = { type: "low", providerKey: "antigravityQuota", windowKey: "geminiWeekly", remainingPercent: 9 };
  const thirdPartyFiveHour = { type: "low", providerKey: "antigravityQuota", windowKey: "thirdPartyFiveHour", remainingPercent: 30 };
  assert.equal(formatQuotaAlert(geminiWeekly, "zh").body, "Antigravity Gemini · 7 天额度：剩余 9%。");
  assert.equal(formatQuotaAlert(thirdPartyFiveHour, "en").body, "Antigravity Claude/GPT · 5-hour window: 30% remaining.");
  assert.notEqual(formatQuotaAlert(geminiWeekly, "zh").body, formatQuotaAlert(thirdPartyFiveHour, "zh").body);
});

test("codex-family quota never guesses a window from its slot name", () => {
  const cases = [["codexQuota", "Codex"], ["codexSparkQuota", "Codex Spark"], ["kimiQuota", "Kimi"]];
  for (const [providerKey, name] of cases) {
    const value = formatQuotaAlert({ type: "low", providerKey, windowKey: "codexWeekly", remainingPercent: 15 }, "zh");
    assert.equal(value.body, `${name}：剩余 15%。`);
    assert.ok(!value.body.includes("额度"));
  }
});

test("keeps the remote source host on inferred window labels", () => {
  const event = { type: "low", providerKey: "claudeQuota", windowKey: "claudeFiveHour", remainingPercent: 15,
    host: "remote-host" };
  assert.equal(formatQuotaAlert(event, "zh").body, "Claude Code (remote-host) · 5 小时额度：剩余 15%。");
  assert.equal(
    formatQuotaAlert({ ...event, providerKey: "antigravityQuota", windowKey: "geminiFiveHour" }, "en").body,
    "Antigravity Gemini (remote-host) · 5-hour window: 15% remaining.",
  );
});
