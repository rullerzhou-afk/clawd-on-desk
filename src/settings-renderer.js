"use strict";

const core = globalThis.ClawdSettingsCore;

// Icons resolve via settings-icons.js at render time (keyed by tab id),
// not as emoji/unicode glyphs \u2014 those rendered inconsistently across
// system fonts and didn't dark-mode well.
const SIDEBAR_TABS = [
  { id: "general", labelKey: "sidebarGeneral", available: true },
  { id: "agents", labelKey: "sidebarAgents", available: true },
  { id: "theme", labelKey: "sidebarTheme", available: true },
  { id: "animOverrides", labelKey: "sidebarAnimOverrides", available: true },
  { id: "shortcuts", labelKey: "sidebarShortcuts", available: true },
  { id: "telegram-approval", labelKey: "sidebarTelegramApproval", available: true },
  { id: "discord-presence", labelKey: "sidebarDiscordPresence", available: true },
  { id: "remote-ssh", labelKey: "sidebarRemoteSsh", available: true },
  { id: "recap", labelKey: "sidebarRecap", available: true },
  { id: "about", labelKey: "sidebarAbout", available: true },
];

function getTabIcon(tabId) {
  const icons = globalThis.ClawdSettingsIcons;
  if (icons && typeof icons.getIcon === "function") return icons.getIcon(tabId);
  return "";
}

let sidebarTabs = null;

function renderSidebar() {
  document.title = core.helpers.t("settingsWindowTitle");
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const panels = sidebarTabs?.panels;
  if (sidebarTabs) sidebarTabs.dispose();
  sidebar.innerHTML = "";
  if (
    globalThis.ClawdSettingsDoctorModal
    && typeof globalThis.ClawdSettingsDoctorModal.renderSidebarIndicator === "function"
  ) {
    globalThis.ClawdSettingsDoctorModal.renderSidebarIndicator(sidebar, core);
  }
  sidebarTabs = core.helpers.buildTabs({
    id: "settings-navigation",
    ariaLabel: core.helpers.t("settingsWindowTitle"),
    orientation: "vertical",
    className: "settings-sidebar-tabs",
    buttonClassName: "sidebar-item",
    value: core.state.activeTab,
    panels,
    options: SIDEBAR_TABS.map((tab) => ({ ...tab, value: tab.id, disabled: !tab.available })),
    onChange: (value) => core.ops.selectTab(value),
    renderLabel(item, tab) {
      // Icons come from the bundled settings-icons.js, never user input.
      item.innerHTML =
        `<span class="sidebar-item-icon" aria-hidden="true">${getTabIcon(tab.id)}</span>` +
        `<span class="sidebar-item-label">${core.helpers.escapeHtml(core.helpers.t(tab.labelKey))}</span>` +
        (tab.available ? "" : `<span class="sidebar-item-soon">${core.helpers.escapeHtml(core.helpers.t("sidebarSoon"))}</span>`);
    },
  });
  sidebar.appendChild(sidebarTabs.element);
}

function renderPlaceholder(parent) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML =
    `<div class="placeholder-icon">${getTabIcon("placeholder")}</div>` +
    `<div class="placeholder-title">${core.helpers.escapeHtml(core.helpers.t("placeholderTitle"))}</div>` +
    `<div class="placeholder-desc">${core.helpers.escapeHtml(core.helpers.t("placeholderDesc"))}</div>`;
  parent.appendChild(div);
}

function renderContent() {
  const content = document.getElementById("content");
  if (!content) return;
  core.ops.clearMountedControls();
  content.innerHTML = "";
  if (!sidebarTabs) renderSidebar();
  sidebarTabs.setValue(core.state.activeTab);
  for (const panel of sidebarTabs.panels.values()) {
    panel.innerHTML = "";
    content.appendChild(panel);
  }
  const panel = sidebarTabs.panels.get(core.state.activeTab);
  const tab = core.tabs[core.state.activeTab];
  if (tab && typeof tab.render === "function") {
    tab.render(panel, core);
  } else {
    renderPlaceholder(panel);
  }
}

core.ops.installRenderHooks({
  sidebar: renderSidebar,
  content: renderContent,
});

globalThis.ClawdSettingsTabGeneral.init(core);
globalThis.ClawdSettingsTabAgents.init(core);
globalThis.ClawdSettingsTabTheme.init(core);
// Not a top-level tab anymore — it provides the "on / off" subtab that
// ClawdSettingsTabAnimOverrides renders. init() just wires up the core refs.
globalThis.ClawdSettingsTabAnimMap.init(core);
globalThis.ClawdSettingsTabAnimOverrides.init(core);
globalThis.ClawdSettingsTabShortcuts.init(core);
if (globalThis.ClawdSettingsTabTelegramApproval) globalThis.ClawdSettingsTabTelegramApproval.init(core);
if (globalThis.ClawdSettingsTabDiscordPresence) globalThis.ClawdSettingsTabDiscordPresence.init(core);
if (globalThis.ClawdSettingsTabRecap) globalThis.ClawdSettingsTabRecap.init(core);
globalThis.ClawdSettingsTabAbout.init(core);
if (globalThis.ClawdSettingsTabRemoteSsh) globalThis.ClawdSettingsTabRemoteSsh.init(core);
if (globalThis.ClawdSettingsTabMobile) globalThis.ClawdSettingsTabMobile.init(core);

core.ops.restoreNavigationState();
function selectRequestedTab(tab) {
  if (tab === "recap") core.ops.selectTab("recap", { persist: false });
}
if (window.settingsAPI && typeof window.settingsAPI.onRequestedTab === "function") {
  window.settingsAPI.onRequestedTab(selectRequestedTab);
}
if (window.settingsAPI && typeof window.settingsAPI.consumeRequestedTab === "function") {
  selectRequestedTab(window.settingsAPI.consumeRequestedTab());
}
if (typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    core.ops.persistNavigationState();
    if (sidebarTabs) sidebarTabs.dispose();
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onChanged === "function") {
  window.settingsAPI.onChanged((payload) => core.ops.applyChanges(payload));
}

if (window.settingsAPI && typeof window.settingsAPI.onAgentActivity === "function") {
  window.settingsAPI.onAgentActivity((payload) => {
    const tab = core.tabs.agents;
    if (tab && typeof tab.applyAgentActivity === "function") tab.applyAgentActivity(payload);
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onRecapChanged === "function") {
  window.settingsAPI.onRecapChanged(() => {
    const tab = core.tabs.recap;
    if (tab && typeof tab.applyDataChanged === "function") tab.applyDataChanged();
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onAnimationPreviewPosterReady === "function") {
  window.settingsAPI.onAnimationPreviewPosterReady((payload) => core.ops.applyAnimationPreviewPoster(payload));
}

if (window.settingsAPI && typeof window.settingsAPI.onShortcutRecordKey === "function") {
  window.settingsAPI.onShortcutRecordKey((payload) => core.ops.handleShortcutRecordKey(payload));
}

if (window.settingsAPI && typeof window.settingsAPI.onShortcutFailuresChanged === "function") {
  window.settingsAPI.onShortcutFailuresChanged((failures) => core.ops.applyShortcutFailures(failures));
}

if (window.settingsAPI && typeof window.settingsAPI.onRemoteApprovalStatusChanged === "function") {
  window.settingsAPI.onRemoteApprovalStatusChanged((payload) => {
    const tab = core.tabs[core.state.activeTab];
    if (tab && typeof tab.refreshRuntimeStatus === "function") {
      tab.refreshRuntimeStatus(payload);
    }
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onUpdateCheckStatus === "function") {
  window.settingsAPI.onUpdateCheckStatus((snapshot) => {
    core.runtime.about.updateCheckSnapshot = snapshot || { state: "idle" };
    const tab = core.tabs.about;
    if (tab && typeof tab.applyUpdateCheckStatus === "function") {
      tab.applyUpdateCheckStatus(core.runtime.about.updateCheckSnapshot);
    }
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onOfficialThemeProgress === "function") {
  window.settingsAPI.onOfficialThemeProgress((progress) => core.ops.applyOfficialThemeProgress(progress));
}

if (window.settingsAPI && typeof window.settingsAPI.getShortcutFailures === "function") {
  window.settingsAPI.getShortcutFailures().then((failures) => {
    core.ops.applyShortcutFailures(failures);
  }).catch((err) => {
    console.warn("settings: getShortcutFailures failed", err);
  });
}

if (window.settingsAPI && typeof window.settingsAPI.getSnapshot === "function") {
  const tintOptionsPromise =
    typeof window.settingsAPI.getPetTintOptions === "function"
      ? window.settingsAPI.getPetTintOptions().catch((err) => {
        console.warn("settings: getPetTintOptions failed", err);
        return [];
      })
      : Promise.resolve([]);
  const accessoryOptionsPromise =
    typeof window.settingsAPI.getPetAccessoryOptions === "function"
      ? window.settingsAPI.getPetAccessoryOptions().catch((err) => {
        console.warn("settings: getPetAccessoryOptions failed", err);
        return [];
      })
      : Promise.resolve([]);
  const mouthAccessoryOptionsPromise =
    typeof window.settingsAPI.getPetMouthAccessoryOptions === "function"
      ? window.settingsAPI.getPetMouthAccessoryOptions().catch((err) => {
        console.warn("settings: getPetMouthAccessoryOptions failed", err);
        return [];
      })
      : Promise.resolve([]);
  Promise.all([
    window.settingsAPI.getSnapshot(),
    tintOptionsPromise,
    accessoryOptionsPromise,
    mouthAccessoryOptionsPromise,
  ]).then(([snapshot, petTintOptions, petAccessoryOptions, petMouthAccessoryOptions]) => {
    core.runtime.petTintOptions = Array.isArray(petTintOptions) ? petTintOptions : [];
    core.runtime.petAccessoryOptions = Array.isArray(petAccessoryOptions)
      ? petAccessoryOptions
      : [];
    core.runtime.petMouthAccessoryOptions = Array.isArray(petMouthAccessoryOptions)
      ? petMouthAccessoryOptions
      : [];
    core.ops.applyBootstrap(snapshot);
  });
}

if (window.settingsAPI && typeof window.settingsAPI.listAgents === "function") {
  window.settingsAPI.listAgents().then((list) => {
    core.ops.applyAgentMetadata(list);
  }).catch((err) => {
    console.warn("settings: listAgents failed", err);
    core.ops.applyAgentMetadata([]);
  });
}
