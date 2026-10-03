"use strict";
const path = require("path");
const { pathToFileURL } = require("url");
const { validateProjectBookmarks } = require("./project-bookmarks");
const BULK_KEYS = new Set(["quotaAlertsEnabled", "quotaAlertThresholds", "quotaRecoveryAlertsEnabled"]);

function registerProductivityIpc(options) {
  const { ipcMain, settingsController, getSettingsWindow, dialog, launcher } = options;
  const settingsUrl = pathToFileURL(path.join(__dirname, "settings.html")).href;
  const channels = [], busy = new Set();
  let choosing = false, testing = false, disposed = false;
  function trusted(event) {
    const win = getSettingsWindow();
    const contents = win?.webContents, frame = event?.senderFrame;
    return !disposed && !!win && !win.isDestroyed() && !!contents && !contents.isDestroyed()
      && event.sender === contents && !!frame && frame === contents.mainFrame && frame.url === settingsUrl;
  }
  function blocked(event) {
    return !trusted(event) ? { ok: false, status: "error", code: "UNTRUSTED_SENDER" }
      : settingsController.hasReadFailure() ? { ok: false, status: "error", code: "SETTINGS_UNAVAILABLE" } : null;
  }
  function handle(channel, fn) { channels.push(channel); ipcMain.handle(channel, fn); }
  handle("settings:productivity-test-notification", async (event) => {
    const denial = blocked(event); if (denial) return denial;
    if (testing) return { ok: false, code: "BUSY" };
    testing = true;
    try {
      const shown = await options.testNotification?.();
      const cancelled = blocked(event); if (cancelled) return cancelled;
      return { ok: shown === true };
    } catch { return { ok: false }; }
    finally { testing = false; }
  });
  handle("settings:productivity-apply-bulk", (event, patch) => {
    const denial = blocked(event); if (denial) return denial;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
      || !Object.keys(patch).length || Object.keys(patch).some((key) => !BULK_KEYS.has(key))) {
      return { status: "error", code: "INVALID_PATCH" };
    }
    return settingsController.applyBulk(patch);
  });
  handle("settings:productivity-choose-project-directory", async (event) => {
    const denial = blocked(event); if (denial) return denial;
    if (choosing) return { status: "error", code: "BUSY" };
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(getSettingsWindow(), { properties: ["openDirectory"] });
      const cancelled = blocked(event); if (cancelled) return cancelled;
      return result.canceled || !result.filePaths?.[0]
        ? { status: "cancelled" } : { status: "ok", cwd: result.filePaths[0] };
    } catch { return { status: "error", code: "DIALOG_FAILED" }; }
    finally { choosing = false; }
  });
  handle("settings:productivity-launch-project", async (event, id) => {
    const denial = blocked(event); if (denial) return denial;
    if (typeof id !== "string" || id.length > 80) return { ok: false, code: "BOOKMARK_INVALID" };
    if (busy.has(id)) return { ok: false, code: "BUSY" };
    const result = validateProjectBookmarks(settingsController.get("projectBookmarks"));
    const bookmark = result.ok && result.value.find((item) => item.id === id);
    if (!bookmark) return { ok: false, code: "BOOKMARK_INVALID" };
    busy.add(id);
    try {
      return await launcher.launch(bookmark, {
        // Repeat owner and current-record checks immediately before opening.
        canLaunch: () => {
          if (blocked(event)) return false;
          const current = validateProjectBookmarks(settingsController.get("projectBookmarks"));
          return current.ok && JSON.stringify(current.value.find((item) => item.id === id)) === JSON.stringify(bookmark);
        },
      });
    } catch { return { ok: false, code: "LAUNCH_FAILED" }; }
    finally { busy.delete(id); }
  });
  return { dispose() { disposed = true; for (const channel of channels) ipcMain.removeHandler(channel); } };
}
module.exports = { registerProductivityIpc };
