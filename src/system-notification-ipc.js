"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

// Settings → Notifications "Send test notification". Same trust rules as the
// quota test channel: only the real settings page may trigger a native toast.
function registerSystemNotificationIpc(options) {
  const { ipcMain, settingsController, getSettingsWindow } = options;
  const settingsUrl = pathToFileURL(path.join(__dirname, "settings.html")).href;
  const channel = "settings:system-test-notification";
  let testing = false, disposed = false;
  function blocked(event) {
    const win = getSettingsWindow();
    const contents = win?.webContents, frame = event?.senderFrame;
    const trusted = !disposed && !!win && !win.isDestroyed()
      && !!contents && !contents.isDestroyed() && event.sender === contents
      && !!frame && frame === contents.mainFrame && frame.url === settingsUrl;
    return !trusted ? { ok: false, code: "UNTRUSTED_SENDER" }
      : settingsController.hasReadFailure() ? { ok: false, code: "SETTINGS_UNAVAILABLE" } : null;
  }
  ipcMain.handle(channel, async (event) => {
    const denial = blocked(event); if (denial) return denial;
    if (!options.isSupported()) return { ok: false, code: "UNSUPPORTED_PLATFORM" };
    if (testing) return { ok: false, code: "BUSY" };
    testing = true;
    try {
      const shown = await options.testNotification();
      const cancelled = blocked(event); if (cancelled) return cancelled;
      return { ok: shown === true };
    } catch { return { ok: false }; }
    finally { testing = false; }
  });
  return { dispose() { disposed = true; ipcMain.removeHandler(channel); } };
}
module.exports = { registerSystemNotificationIpc };
