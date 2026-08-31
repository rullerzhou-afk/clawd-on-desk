"use strict";

// ── Settings panel preload ──
//
// Surface: window.settingsAPI
//
//   discordDefaultAppIdPresent          boolean — a default Discord App ID is
//                                       hardcoded (maintainer-shipped)
//   getSnapshot()                       Promise<snapshot>
//   getPetTintOptions()                 Promise<Array<{id, labelKey}>>
//   getPetAccessoryOptions()            Promise<Array<{id, labelKey}>>
//   getPetMouthAccessoryOptions()       Promise<Array<{id, labelKey}>>
//   update(key, value)                  Promise<{ status, message? }>
//   command(action, payload)            Promise<{ status, message? }>
//   listAgents()                        Promise<Array<{id, name, ...}>>
//   onChanged(cb)                       cb({ changes, snapshot? }) — fires for
//                                       every settings-changed broadcast
//   onAgentActivity(cb)                 cb({ agentId, timestamp, eventType }) —
//                                       accepted custom /state activity only
//   onRecapChanged(cb)                  cb() — coalesced signal that the local
//                                       Footprints aggregate changed
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

// A sandboxed preload (Electron's default since 20) may only require "electron"
// plus a few Node builtins — never an app module. The "is a default Discord App
// ID baked in?" flag is therefore injected by value from main, via
// webPreferences.additionalArguments, and read off process.argv here.
const DISCORD_DEFAULT_APP_ID_FLAG = "--discord-default-app-id-present=";
const discordDefaultAppIdArg = process.argv.find((a) => a.startsWith(DISCORD_DEFAULT_APP_ID_FLAG));
const discordDefaultAppIdPresent =
  !!discordDefaultAppIdArg && discordDefaultAppIdArg.slice(DISCORD_DEFAULT_APP_ID_FLAG.length) === "1";

const listeners = new Set();
const shortcutFailureListeners = new Set();
const shortcutRecordKeyListeners = new Set();
const remoteSshStatusListeners = new Set();
const remoteSshProgressListeners = new Set();
const remoteApprovalStatusListeners = new Set();
const textScaleContextListeners = new Set();
const agentActivityListeners = new Set();
const recapChangedListeners = new Set();
const updateCheckStatusListeners = new Set();
const requestedTabListeners = new Set();
let pendingRequestedTab = null;
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
ipcRenderer.on("remoteApproval:status-changed", (_event, payload) => {
  for (const cb of remoteApprovalStatusListeners) {
    try { cb(payload); } catch (err) { console.warn("remote approval status listener threw:", err); }
  }
});
// Fired by the settings-window runtime whenever the window's effective text
// scale was re-resolved (display move, topology change, commit) — the
// committed percent lives main-side, so the slider must re-pull it.
ipcRenderer.on("settings:text-scale-context-changed", () => {
  for (const cb of textScaleContextListeners) {
    try { cb(); } catch (err) { console.warn("text scale context listener threw:", err); }
  }
});
ipcRenderer.on("settings:agent-activity", (_event, payload) => {
  for (const cb of agentActivityListeners) {
    try { cb(payload); } catch (err) { console.warn("agent activity listener threw:", err); }
  }
});
ipcRenderer.on("settings:recap-changed", () => {
  for (const cb of recapChangedListeners) {
    try { cb(); } catch (err) { console.warn("recap changed listener threw:", err); }
  }
});
ipcRenderer.on("settings:update-check-status", (_event, payload) => {
  for (const cb of updateCheckStatusListeners) {
    try { cb(payload); } catch (err) { console.warn("update check status listener threw:", err); }
  }
});
ipcRenderer.on("settings:select-tab", (_event, tab) => {
  if (typeof tab !== "string") return;
  pendingRequestedTab = tab;
  for (const cb of requestedTabListeners) {
    try { cb(tab); } catch (err) { console.warn("settings requested-tab listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("settingsAPI", {
  // Capability flag: true when a default Discord App ID is hardcoded (maintainer-
  // shipped), so the presence enable switch can be ready without a user-saved App ID.
  discordDefaultAppIdPresent,
  getSnapshot: () => ipcRenderer.invoke("settings:get-snapshot"),
  queryRecap: (period) => ipcRenderer.invoke("settings:recap-query", period),
  clearRecap: () => ipcRenderer.invoke("settings:recap-clear"),
  consumeRequestedTab: () => {
    const tab = pendingRequestedTab;
    pendingRequestedTab = null;
    return tab;
  },
  onRequestedTab: (cb) => {
    if (typeof cb !== "function") return () => {};
    requestedTabListeners.add(cb);
    return () => requestedTabListeners.delete(cb);
  },
  getQuotaSourceCount: () => ipcRenderer.invoke("settings:get-quota-source-count"),
  getQuotaRingProviders: () => ipcRenderer.invoke("settings:get-quota-ring-providers"),
  getKimiQuotaStatus: () => ipcRenderer.invoke("settings:kimi-quota-status"),
  connectKimiQuota: (apiKey) => ipcRenderer.invoke("settings:kimi-quota-connect", { apiKey }),
  refreshKimiQuota: () => ipcRenderer.invoke("settings:kimi-quota-refresh"),
  reconnectKimiQuota: () => ipcRenderer.invoke("settings:kimi-quota-reconnect"),
  disconnectKimiQuota: () => ipcRenderer.invoke("settings:kimi-quota-disconnect"),
  forgetKimiQuotaCredential: () => ipcRenderer.invoke("settings:kimi-quota-forget"),
  getPetTintOptions: () => ipcRenderer.invoke("settings:get-pet-tint-options"),
  getPetAccessoryOptions: () => ipcRenderer.invoke("settings:get-pet-accessory-options"),
  getPetMouthAccessoryOptions: () => ipcRenderer.invoke("settings:get-pet-mouth-accessory-options"),
  getRoamFence: () => ipcRenderer.invoke("settings:get-roam-fence"),
  selectRoamFence: () => ipcRenderer.invoke("settings:select-roam-fence"),
  clearRoamFence: () => ipcRenderer.invoke("settings:clear-roam-fence"),
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
  previewTextScale: (value) => ipcRenderer.invoke("settings:preview-text-scale", value),
  endTextScalePreview: () => ipcRenderer.invoke("settings:end-text-scale-preview"),
  getTextScaleContext: () => ipcRenderer.invoke("settings:get-text-scale-context"),
  onTextScaleContextChanged: (cb) => {
    if (typeof cb !== "function") return () => {};
    textScaleContextListeners.add(cb);
    return () => textScaleContextListeners.delete(cb);
  },
  exportAnimationOverrides: () => ipcRenderer.invoke("settings:export-animation-overrides"),
  importAnimationOverrides: () => ipcRenderer.invoke("settings:import-animation-overrides"),
  enterShortcutRecording: (actionId) => ipcRenderer.invoke("settings:enterShortcutRecording", actionId),
  exitShortcutRecording: () => ipcRenderer.invoke("settings:exitShortcutRecording"),
  update: (key, value) => ipcRenderer.invoke("settings:update", { key, value }),
  getPreviewSoundUrl: () => ipcRenderer.invoke("settings:get-preview-sound-url"),
  command: (action, payload) => ipcRenderer.invoke("settings:command", { action, payload }),
  openDashboard: () => ipcRenderer.send("settings:open-dashboard"),
  listAgents: () => ipcRenderer.invoke("settings:list-agents"),
  pickAgentDiscoveryPath: (kind) => ipcRenderer.invoke("settings:pick-agent-discovery-path", { kind }),
  detectAgentInstallations: (opts) => ipcRenderer.invoke("settings:detect-agent-installations", opts),
  getAboutInfo: () => ipcRenderer.invoke("settings:get-about-info"),
  checkForUpdates: () => ipcRenderer.invoke("settings:check-for-updates"),
  clearUpdateError: () => ipcRenderer.invoke("settings:clear-update-error"),
  copyUpdateError: (copyText) => ipcRenderer.invoke("settings:copy-update-error", copyText),
  showTutorial: () => ipcRenderer.invoke("settings:show-tutorial"),
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
  getMobileConnectionInfo: () => ipcRenderer.invoke("settings:mobile-connection-info"),
  regenerateMobileToken: () => ipcRenderer.invoke("settings:regenerate-mobile-token"),
  resetMobileAccess: () => ipcRenderer.invoke("settings:reset-mobile-access"),
  onChanged: (cb) => {
    if (typeof cb === "function") listeners.add(cb);
  },
  onAgentActivity: (cb) => {
    if (typeof cb !== "function") return () => {};
    agentActivityListeners.add(cb);
    return () => agentActivityListeners.delete(cb);
  },
  onRecapChanged: (cb) => {
    if (typeof cb !== "function") return () => {};
    recapChangedListeners.add(cb);
    return () => recapChangedListeners.delete(cb);
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
  onRemoteApprovalStatusChanged: (cb) => {
    if (typeof cb !== "function") return () => {};
    remoteApprovalStatusListeners.add(cb);
    return () => remoteApprovalStatusListeners.delete(cb);
  },
  onUpdateCheckStatus: (cb) => {
    if (typeof cb !== "function") return () => {};
    updateCheckStatusListeners.add(cb);
    return () => updateCheckStatusListeners.delete(cb);
  },
});

contextBridge.exposeInMainWorld("doctor", {
  runChecks: () => ipcRenderer.invoke("doctor:run-checks"),
  getReport: () => ipcRenderer.invoke("doctor:get-report"),
  testConnection: (durationMs) => ipcRenderer.invoke("doctor:test-connection", { durationMs }),
  openClawdLog: () => ipcRenderer.invoke("doctor:open-clawd-log"),
  codexHookHealth: () => ipcRenderer.invoke("doctor:codex-hook-health"),
});

// ── Remote SSH (Phase 2) ──
//
// Surface: window.remoteSsh
//
//   listStatuses()                 Promise<{ status, statuses: Array<state> }>
//   status(profileId)              Promise<{ status, state }>
//   connect(profileId)             Promise<{ status, state?, reason?, hint?, detail? }>
//   disconnect(profileId)          Promise<{ status, state? }>
//   deploy(profileId, options?)    Promise<{ status, message?, step? }>
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
  cleanup: (profileId) => ipcRenderer.invoke("remoteSsh:cleanup", profileId),
  deploy: (profileId, options = {}) => ipcRenderer.invoke("remoteSsh:deploy", {
    profileId,
    legacyMigrationConfirmed: options.legacyMigrationConfirmed === true,
  }),
  setRuntimeMode: (profileId, runtimeMode, confirmed) => ipcRenderer.invoke(
    "remoteSsh:set-runtime-mode",
    { profileId, runtimeMode, confirmed: confirmed === true }
  ),
  forceRevoke: (profileId, mode, confirmed) => ipcRenderer.invoke(
    "remoteSsh:force-revoke",
    { profileId, mode, confirmed: confirmed === true }
  ),
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
