"use strict";

const {
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
} = require("./shortcut-actions");

function requiredDependency(value, name) {
  if (!value) throw new Error(`createShortcutRuntime requires ${name}`);
  return value;
}

function hasLiveWebContents(win) {
  return !!(
    win
    && !win.isDestroyed()
    && win.webContents
    && !win.webContents.isDestroyed()
  );
}

function createShortcutRuntime(options = {}) {
  const globalShortcut = requiredDependency(options.globalShortcut, "globalShortcut");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const getSettingsWindow = requiredDependency(options.getSettingsWindow, "getSettingsWindow");
  const shortcutHandlers = requiredDependency(options.shortcutHandlers, "shortcutHandlers");
  const ipcMain = options.ipcMain || null;
  const failures = new Map();
  const disposers = [];
  let recording = null;

  function getFailures() {
    return Object.fromEntries(failures);
  }

  function getFailure(actionId) {
    return failures.get(actionId) || null;
  }

  function broadcastFailures() {
    const settingsWindow = getSettingsWindow();
    if (!hasLiveWebContents(settingsWindow)) return;
    settingsWindow.webContents.send("shortcut-failures-changed", getFailures());
  }

  function reportFailure(actionId, reason) {
    if (!SHORTCUT_ACTIONS[actionId]) return;
    if (failures.get(actionId) === reason) return;
    failures.set(actionId, reason);
    broadcastFailures();
  }

  function clearFailure(actionId) {
    if (!failures.has(actionId)) return;
    failures.delete(actionId);
    broadcastFailures();
  }

  function getSnapshotShortcuts() {
    const snapshot = settingsController.getSnapshot();
    return (snapshot && snapshot.shortcuts) || {};
  }

  function getPersistentHandler(actionId) {
    const handler = shortcutHandlers && shortcutHandlers[actionId];
    return typeof handler === "function" ? handler : null;
  }

  function registerPersistentShortcutsFromSettings() {
    const shortcuts = getSnapshotShortcuts();
    for (const actionId of SHORTCUT_ACTION_IDS) {
      const meta = SHORTCUT_ACTIONS[actionId];
      if (!meta || !meta.persistent) continue;
      const accelerator = shortcuts[actionId];
      if (!accelerator) {
        clearFailure(actionId);
        continue;
      }
      const handler = getPersistentHandler(actionId);
      if (!handler) continue;
      let ok = false;
      try {
        ok = !!globalShortcut.register(accelerator, handler);
      } catch {
        ok = false;
      }
      if (!ok) {
        reportFailure(actionId, "system conflict");
        console.warn(`Clawd: failed to register shortcut ${actionId}: ${accelerator}`);
        continue;
      }
      clearFailure(actionId);
    }
  }

  function stopRecording() {
    if (!recording) return;
    const settingsWindow = getSettingsWindow();
    if (hasLiveWebContents(settingsWindow)) {
      try {
        settingsWindow.webContents.removeListener(
          "before-input-event",
          recording.listener
        );
      } catch {}
    }

    const { tempUnregistered } = recording;
    const currentShortcuts = getSnapshotShortcuts();
    for (const entry of tempUnregistered) {
      if (currentShortcuts[entry.actionId] === entry.accelerator) {
        const handler = getPersistentHandler(entry.actionId);
        if (handler) {
          try { globalShortcut.register(entry.accelerator, handler); } catch {}
        }
      }
    }

    recording = null;
  }

  function startRecording(actionId) {
    if (!SHORTCUT_ACTIONS[actionId]) {
      return { status: "error", message: "unknown shortcut action" };
    }
    const settingsWindow = getSettingsWindow();
    if (!hasLiveWebContents(settingsWindow)) {
      return { status: "error", message: "settings window unavailable" };
    }

    stopRecording();

    const tempUnregistered = [];
    const shortcuts = getSnapshotShortcuts();
    for (const persistentActionId of SHORTCUT_ACTION_IDS) {
      const meta = SHORTCUT_ACTIONS[persistentActionId];
      if (!meta || !meta.persistent) continue;
      const current = shortcuts[persistentActionId];
      if (current) {
        try {
          if (globalShortcut.isRegistered(current)) {
            globalShortcut.unregister(current);
            tempUnregistered.push({
              actionId: persistentActionId,
              accelerator: current,
            });
          }
        } catch {}
      }
    }

    const listener = (event, input) => {
      if (!input || input.type !== "keyDown") return;
      event.preventDefault();
      settingsWindow.webContents.send("shortcut-record-key", {
        actionId,
        key: input.key,
        code: input.code,
        altKey: !!input.alt,
        ctrlKey: !!input.control,
        metaKey: !!input.meta,
        shiftKey: !!input.shift,
      });
    };
    settingsWindow.webContents.on("before-input-event", listener);
    recording = { actionId, listener, tempUnregistered };
    return { status: "ok" };
  }

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  if (ipcMain) {
    handle("settings:getShortcutFailures", () => getFailures());
    handle("settings:enterShortcutRecording", (_event, actionId) =>
      startRecording(actionId)
    );
    handle("settings:exitShortcutRecording", () => {
      stopRecording();
      return { status: "ok" };
    });
  }

  return {
    clearFailure,
    dispose() {
      stopRecording();
      while (disposers.length) {
        const dispose = disposers.pop();
        try { dispose(); } catch {}
      }
    },
    getFailure,
    getFailures,
    registerPersistentShortcutsFromSettings,
    reportFailure,
    startRecording,
    stopRecording,
  };
}

module.exports = createShortcutRuntime;
