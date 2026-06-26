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
  { id: "remote-ssh", labelKey: "sidebarRemoteSsh", available: true },
  { id: "mobile", labelKey: "sidebarMobile", available: true },
  { id: "about", labelKey: "sidebarAbout", available: true },
];

function getTabIcon(tabId) {
  const icons = globalThis.ClawdSettingsIcons;
  if (icons && typeof icons.getIcon === "function") return icons.getIcon(tabId);
  return "";
}

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.innerHTML = "";
  if (
    globalThis.ClawdSettingsDoctorModal
    && typeof globalThis.ClawdSettingsDoctorModal.renderSidebarIndicator === "function"
  ) {
    globalThis.ClawdSettingsDoctorModal.renderSidebarIndicator(sidebar, core);
  }
  for (const tab of SIDEBAR_TABS) {
    const item = document.createElement("div");
    item.className = "sidebar-item";
    if (!tab.available) item.classList.add("disabled");
    if (tab.id === core.state.activeTab) item.classList.add("active");
    // Icon HTML is trusted (it comes from our own settings-icons.js
    // module, not user input), so we drop it in as-is.
    item.innerHTML =
      `<span class="sidebar-item-icon">${getTabIcon(tab.id)}</span>` +
      `<span class="sidebar-item-label">${core.helpers.escapeHtml(core.helpers.t(tab.labelKey))}</span>` +
      (tab.available ? "" : `<span class="sidebar-item-soon">${core.helpers.escapeHtml(core.helpers.t("sidebarSoon"))}</span>`);
    if (tab.available) {
      item.addEventListener("click", () => {
        core.ops.selectTab(tab.id);
      });
    }
    sidebar.appendChild(item);
  }
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
  const tab = core.tabs[core.state.activeTab];
  if (tab && typeof tab.render === "function") {
    tab.render(content, core);
  } else {
    renderPlaceholder(content);
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
globalThis.ClawdSettingsTabAbout.init(core);
if (globalThis.ClawdSettingsTabRemoteSsh) globalThis.ClawdSettingsTabRemoteSsh.init(core);
if (globalThis.ClawdSettingsTabMobile) globalThis.ClawdSettingsTabMobile.init(core);

if (window.settingsAPI && typeof window.settingsAPI.onChanged === "function") {
  window.settingsAPI.onChanged((payload) => core.ops.applyChanges(payload));
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

if (window.settingsAPI && typeof window.settingsAPI.getShortcutFailures === "function") {
  window.settingsAPI.getShortcutFailures().then((failures) => {
    core.ops.applyShortcutFailures(failures);
  }).catch((err) => {
    console.warn("settings: getShortcutFailures failed", err);
  });
}

if (window.settingsAPI && typeof window.settingsAPI.getSnapshot === "function") {
  window.settingsAPI.getSnapshot().then((snapshot) => {
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
