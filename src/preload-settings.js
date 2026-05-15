"use strict";

// ── Settings panel preload ──
//
// Surface: window.settingsAPI
//
//   getSnapshot()                       Promise<snapshot>
//   update(key, value)                  Promise<{ status, message? }>
//   command(action, payload)            Promise<{ status, message? }>
//   listAgents()                        Promise<Array<{id, name, ...}>>
//   onChanged(cb)                       cb({ changes, snapshot? }) — fires for
//                                       every settings-changed broadcast
//   onAnimationPreviewPosterReady(cb)   cb({ themeId, filename, previewImageUrl,
//                                       previewPosterCacheKey }) — incremental
//                                       animation override preview poster
//
// All writes go through the main-process "settings:update" handler, which
// routes through the controller. The renderer never owns state — it always
// re-renders from the snapshot delivered via onChanged broadcasts (or the
// initial getSnapshot() call). This is the unidirectional flow contract from
// plan-settings-panel.md §4.2.

const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Set();
const shortcutFailureListeners = new Set();
const shortcutRecordKeyListeners = new Set();
const remoteSshStatusListeners = new Set();
const remoteSshProgressListeners = new Set();
ipcRenderer.on("settings-changed", (_event, payload) => {
  for (const cb of listeners) {
    try { cb(payload); } catch (err) { console.warn("settings onChanged listener threw:", err); }
  }
});
ipcRenderer.on("shortcut-failures-changed", (_event, payload) => {
  for (const cb of shortcutFailureListeners) {
    try { cb(payload); } catch (err) { console.warn("shortcut failure listener threw:", err); }
  }
});
ipcRenderer.on("shortcut-record-key", (_event, payload) => {
  for (const cb of shortcutRecordKeyListeners) {
    try { cb(payload); } catch (err) { console.warn("shortcut record listener threw:", err); }
  }
});
ipcRenderer.on("remoteSsh:status-changed", (_event, payload) => {
  for (const cb of remoteSshStatusListeners) {
    try { cb(payload); } catch (err) { console.warn("remoteSsh status listener threw:", err); }
  }
});
ipcRenderer.on("remoteSsh:progress", (_event, payload) => {
  for (const cb of remoteSshProgressListeners) {
    try { cb(payload); } catch (err) { console.warn("remoteSsh progress listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("settingsAPI", {
  getSnapshot: () => ipcRenderer.invoke("settings:get-snapshot"),
  getShortcutFailures: () => ipcRenderer.invoke("settings:getShortcutFailures"),
  getAnimationOverridesData: () => ipcRenderer.invoke("settings:get-animation-overrides-data"),
  openThemeAssetsDir: () => ipcRenderer.invoke("settings:open-theme-assets-dir"),
  previewAnimationOverride: (payload) => ipcRenderer.invoke("settings:preview-animation-override", payload),
  previewReaction: (payload) => ipcRenderer.invoke("settings:preview-reaction", payload),
  pickSoundFile: (payload) => ipcRenderer.invoke("settings:pick-sound-file", payload),
  previewSound: (payload) => ipcRenderer.invoke("settings:preview-sound", payload),
  openSoundOverridesDir: () => ipcRenderer.invoke("settings:open-sound-overrides-dir"),
  beginSizePreview: () => ipcRenderer.invoke("settings:begin-size-preview"),
  previewSize: (value) => ipcRenderer.invoke("settings:preview-size", value),
  endSizePreview: (value) => ipcRenderer.invoke("settings:end-size-preview", value),
  exportAnimationOverrides: () => ipcRenderer.invoke("settings:export-animation-overrides"),
  importAnimationOverrides: () => ipcRenderer.invoke("settings:import-animation-overrides"),
  enterShortcutRecording: (actionId) => ipcRenderer.invoke("settings:enterShortcutRecording", actionId),
  exitShortcutRecording: () => ipcRenderer.invoke("settings:exitShortcutRecording"),
  update: (key, value) => ipcRenderer.invoke("settings:update", { key, value }),
  getPreviewSoundUrl: () => ipcRenderer.invoke("settings:get-preview-sound-url"),
  command: (action, payload) => ipcRenderer.invoke("settings:command", { action, payload }),
  openDashboard: () => ipcRenderer.send("settings:open-dashboard"),
  listAgents: () => ipcRenderer.invoke("settings:list-agents"),
  getAboutInfo: () => ipcRenderer.invoke("settings:get-about-info"),
  checkForUpdates: () => ipcRenderer.invoke("settings:check-for-updates"),
  openExternal: (url) => ipcRenderer.invoke("settings:open-external", url),
  listThemes: () => ipcRenderer.invoke("settings:list-themes"),
  openUserThemesDir: () => ipcRenderer.invoke("settings:open-user-themes-dir"),
  importUserThemeZip: () => ipcRenderer.invoke("settings:import-user-theme-zip"),
  refreshCodexPets: () => ipcRenderer.invoke("settings:refresh-codex-pets"),
  openCodexPetsDir: () => ipcRenderer.invoke("settings:open-codex-pets-dir"),
  importCodexPetZip: () => ipcRenderer.invoke("settings:import-codex-pet-zip"),
  removeCodexPet: (themeId) => ipcRenderer.invoke("settings:remove-codex-pet", themeId),
  confirmRemoveTheme: (themeId) =>
    ipcRenderer.invoke("settings:confirm-remove-theme", themeId),
  onChanged: (cb) => {
    if (typeof cb === "function") listeners.add(cb);
  },
  onAnimationPreviewPosterReady: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) => {
      try { cb(payload); } catch (err) { console.warn("animation preview poster listener threw:", err); }
    };
    ipcRenderer.on("settings:animation-preview-poster-ready", listener);
    return () => ipcRenderer.removeListener("settings:animation-preview-poster-ready", listener);
  },
  onShortcutFailuresChanged: (cb) => {
    if (typeof cb !== "function") return () => {};
    shortcutFailureListeners.add(cb);
    return () => shortcutFailureListeners.delete(cb);
  },
  onShortcutRecordKey: (cb) => {
    if (typeof cb !== "function") return () => {};
    shortcutRecordKeyListeners.add(cb);
    return () => shortcutRecordKeyListeners.delete(cb);
  },
});

contextBridge.exposeInMainWorld("doctor", {
  runChecks: () => ipcRenderer.invoke("doctor:run-checks"),
  getReport: () => ipcRenderer.invoke("doctor:get-report"),
  testConnection: (durationMs) => ipcRenderer.invoke("doctor:test-connection", { durationMs }),
  openClawdLog: () => ipcRenderer.invoke("doctor:open-clawd-log"),
});

// ── Remote SSH (Phase 2) ──
//
// Surface: window.remoteSsh
//
//   listStatuses()                 Promise<{ status, statuses: Array<state> }>
//   status(profileId)              Promise<{ status, state }>
//   connect(profileId)             Promise<{ status, state? }>
//   disconnect(profileId)          Promise<{ status, state? }>
//   deploy(profileId)              Promise<{ status, message?, step? }>
//   authenticate(profileId)        Promise<{ status, terminal?, message? }>
//   openTerminal(profileId)        Promise<{ status, terminal?, message? }>
//   onStatusChanged(cb)            cb({ profileId, status, ... })
//   onProgress(cb)                 cb({ profileId, step, status, message? })
//
// Profile CRUD goes through the existing settingsAPI.command pathway
// (action: "remoteSsh.add" | "remoteSsh.update" | "remoteSsh.delete") so all
// writes flow through settings-controller as the single source of truth.
contextBridge.exposeInMainWorld("remoteSsh", {
  listStatuses: () => ipcRenderer.invoke("remoteSsh:list-statuses"),
  status: (profileId) => ipcRenderer.invoke("remoteSsh:status", profileId),
  connect: (profileId) => ipcRenderer.invoke("remoteSsh:connect", profileId),
  disconnect: (profileId) => ipcRenderer.invoke("remoteSsh:disconnect", profileId),
  deploy: (profileId) => ipcRenderer.invoke("remoteSsh:deploy", profileId),
  authenticate: (profileId) => ipcRenderer.invoke("remoteSsh:authenticate", profileId),
  openTerminal: (profileId) => ipcRenderer.invoke("remoteSsh:open-terminal", profileId),
  onStatusChanged: (cb) => {
    if (typeof cb !== "function") return () => {};
    remoteSshStatusListeners.add(cb);
    return () => remoteSshStatusListeners.delete(cb);
  },
  onProgress: (cb) => {
    if (typeof cb !== "function") return () => {};
    remoteSshProgressListeners.add(cb);
    return () => remoteSshProgressListeners.delete(cb);
  },
});
