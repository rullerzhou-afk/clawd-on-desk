"use strict";
// Settings copy remains in its browser bundle; load that same static catalog
// in main so native notifications use the identical seven translations.
require("./settings-i18n");
const { STRINGS } = globalThis.ClawdSettingsI18n;
function getQuotaStrings(lang) { return STRINGS[lang] || STRINGS.en; }

const PROVIDER_NAMES = { claudeQuota: "Claude Code", codexQuota: "Codex", codexSparkQuota: "Codex Spark",
  kimiQuota: "Kimi", antigravityQuota: "Antigravity" };
// Claude Code's statusline and Antigravity's usage report never carry a window
// duration, so only their fixed slot names may imply one. Codex-family slots are
// excluded: the "primary" slot is not reliably the short window, so guessing
// would mislabel it.
const WINDOW_KEY_MINUTES = { FiveHour: 300, Weekly: 10080 };

function deriveWindowMinutes(providerKey, windowKey) {
  if (providerKey !== "claudeQuota" && providerKey !== "antigravityQuota") return null;
  const key = typeof windowKey === "string" ? windowKey : "";
  if (key.endsWith("FiveHour")) return WINDOW_KEY_MINUTES.FiveHour;
  if (key.endsWith("Weekly")) return WINDOW_KEY_MINUTES.Weekly;
  return null;
}

function providerDisplayName(event) {
  if (event.providerKey === "antigravityQuota") {
    // Antigravity reports two groups under one provider; name them the same way
    // the Dashboard does so a notification is traceable back to its ring.
    const key = typeof event.windowKey === "string" ? event.windowKey : "";
    if (key.startsWith("gemini")) return "Antigravity Gemini";
    if (key.startsWith("thirdParty")) return "Antigravity Claude/GPT";
  }
  return PROVIDER_NAMES[event.providerKey] || event.providerKey;
}

function formatQuotaAlert(event, lang) {
  const strings = getQuotaStrings(lang);
  const provider = providerDisplayName(event);
  const n = Number.isFinite(event.windowMinutes) && event.windowMinutes > 0
    ? event.windowMinutes
    : deriveWindowMinutes(event.providerKey, event.windowKey);
  const windowLabel = Number.isFinite(n) && n > 0 ? (n % 1440 === 0
    ? strings.quotaWindowDays.replace("{n}", String(n / 1440))
    : n % 60 === 0 ? strings.quotaWindowHours.replace("{n}", String(n / 60))
      : strings.quotaWindowMinutes.replace("{n}", String(n))) : "";
  const recovered = event.type === "recovered";
  let body = recovered ? strings.quotaRecoveredBody : strings.quotaLowBody;
  if (!windowLabel) body = body.replace(" · {window}", "");
  return { title: recovered ? strings.quotaRecoveredTitle : strings.quotaLowTitle,
    body: body.replace("{provider}", provider + (event.host ? ` (${event.host})` : ""))
      .replace("{window}", windowLabel).replace("{remaining}", String(Math.round(event.remainingPercent))) };
}

function createQuotaNotificationPresenter(options) {
  const { Notification } = options;
  const setTimer = options.setTimeout || setTimeout, clearTimer = options.clearTimeout || clearTimeout;
  const live = new Set();
  let disposed = false;
  function showMessage(message) {
    if (disposed || options.isSuppressed()) return Promise.resolve(false);
    if (!Notification?.isSupported()) {
      // Tray balloon dispatch has no failure acknowledgement. Keep it as the
      // existing Windows best-effort fallback, never bypass the mute setting.
      try { return Promise.resolve(options.platform === "win32" && !options.isMuted()
        && options.trayBalloonOwner.show(options.getTray(), {
          title: message.title, content: message.body, iconType: "info", onClick: options.openSettings,
        }) === true); } catch { return Promise.resolve(false); }
    }
    return new Promise((resolve) => {
      let notification, timer, settled = false;
      const settle = (shown) => { if (!settled) { settled = true; resolve(shown); } };
      const cleanup = () => {
        if (timer) clearTimer(timer);
        live.delete(cleanup);
        notification?.removeAllListeners();
        settle(false);
      };
      cleanup.close = () => { cleanup(); try { notification?.close(); } catch {} };
      live.add(cleanup);
      try {
        notification = new Notification({ ...message, silent: options.isMuted() });
        notification.once("show", () => {
          settle(true);
          if (timer) clearTimer(timer);
          // Retain the object for click handling, but bound its lifetime even
          // on platforms that never emit close.
          timer = setTimer(cleanup, 60_000); timer?.unref?.();
        });
        notification.once("failed", cleanup.close);
        notification.once("close", cleanup);
        notification.once("click", () => { try { options.openSettings(); } catch {} finally { cleanup(); } });
        timer = setTimer(cleanup.close, 10_000); timer?.unref?.();
        notification.show();
      } catch { cleanup.close(); }
    });
  }
  return {
    show: (event) => showMessage(formatQuotaAlert(event, options.getLang())),
    test: () => {
      const strings = getQuotaStrings(options.getLang());
      return showMessage({ title: strings.notificationTestTitle, body: strings.notificationTestBody });
    },
    dispose() { disposed = true; for (const cleanup of [...live]) cleanup.close(); },
  };
}
module.exports = { createQuotaNotificationPresenter, formatQuotaAlert };
