"use strict";

// Permissions & approval tab: a three-sub-page shell (on this machine / IM
// channels / LAN approval). The local rows live here; the IM and LAN bodies,
// their status refreshes and their leave-cleaning come from
// ClawdSettingsTabTelegramApproval, resolved only when a body renders.
// patchInPlace owns PERMISSIONS_IN_PLACE_KEYS first, then delegates the rest.
(function initSettingsTabPermissions(root) {
  const PERMISSIONS_IN_PLACE_KEYS = new Set([
    "permissionAutomationMode",
    "permissionAutomationAutoToolsWarningDismissed",
    "permissionAutomationUnattendedWarningDismissed",
    "destructiveActionReminder",
  ]);
  const PERMISSION_AUTOMATION_OPTIONS = [
    { id: "off", labelKey: "permissionAutomationOff" },
    { id: "auto-tools", labelKey: "permissionAutomationAutoTools" },
    { id: "unattended", labelKey: "permissionAutomationUnattended" },
  ];
  // Sub-page navigation uses `id`, never `key`: the tab-split test treats every
  // `key`-colon string literal in this module as a pref key.
  const SUBTABS = [
    { id: "local", labelKey: "permissionsSubtabLocal" },
    { id: "channels", labelKey: "permissionsSubtabChannels" },
    { id: "lan", labelKey: "permissionsSubtabLan" },
  ];

  let state = null;
  let runtime = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;
  let mountedSubtabs = null;
  let mountedHost = null;

  function remote() {
    return root.ClawdSettingsTabTelegramApproval;
  }

  function currentSubtab() {
    const value = runtime && runtime.permissionsSubtab;
    return value === "channels" || value === "lan" ? value : "local";
  }

  function t(key) {
    return helpers.t(key);
  }

  function readPermissionAutomationMode() {
    const mode = state.snapshot && state.snapshot.permissionAutomationMode;
    return PERMISSION_AUTOMATION_OPTIONS.some((option) => option.id === mode)
      ? mode
      : "off";
  }

  function permissionAutomationWarningKey(mode) {
    if (mode === "auto-tools") return "permissionAutomationAutoToolsWarningDismissed";
    if (mode === "unattended") return "permissionAutomationUnattendedWarningDismissed";
    return null;
  }

  function isPermissionAutomationWarningDismissed(mode) {
    const key = permissionAutomationWarningKey(mode);
    return !!(key && state.snapshot && state.snapshot[key] === true);
  }

  function showPermissionAutomationConfirmModal(mode) {
    const unattended = mode === "unattended";
    return helpers.showSettingsConfirmModal({
      title: t(unattended
        ? "permissionAutomationUnattendedConfirmTitle"
        : "permissionAutomationAutoToolsConfirmTitle"),
      detail: t(unattended
        ? "permissionAutomationUnattendedConfirmDetail"
        : "permissionAutomationAutoToolsConfirmDetail"),
      checkboxLabel: t(unattended
        ? "permissionAutomationUnattendedDontShowAgain"
        : "permissionAutomationAutoToolsDontShowAgain"),
      checkboxChecked: false,
      returnDetails: true,
      actions: [
        { id: "cancel", label: t("permissionAutomationCancel"), tone: "neutral", defaultFocus: true },
        {
          id: "enable",
          label: t(unattended
            ? "permissionAutomationEnableUnattended"
            : "permissionAutomationEnableAutoTools"),
          tone: "danger",
        },
      ],
    });
  }

  function setPermissionAutomationMode(mode) {
    if (mode === readPermissionAutomationMode()) return Promise.resolve({ status: "ok", noop: true });
    if (mode === "off") {
      return window.settingsAPI.command("setPermissionAutomationMode", {
        mode,
        confirmed: false,
      });
    }
    if (isPermissionAutomationWarningDismissed(mode)) {
      return window.settingsAPI.command("setPermissionAutomationMode", {
        mode,
        confirmed: false,
      });
    }
    return showPermissionAutomationConfirmModal(mode).then((result) => {
      if (!result || result.actionId !== "enable") return { status: "ok", noop: true };
      return window.settingsAPI.command("setPermissionAutomationMode", {
        mode,
        confirmed: true,
        suppressFutureConfirmation: result.checkboxChecked === true,
      });
    });
  }

  function buildCodexApprovalOwnerRow() {
    const row = document.createElement("div");
    row.className = "row codex-approval-owner-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowCodexApprovalOwner");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t(readers.readAgentPermissionMode("codex") === "intercept"
      ? "rowCodexApprovalOwnerInterceptDesc" : "rowCodexApprovalOwnerAutoDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);
    const control = document.createElement("div");
    control.className = "row-control";
    const button = helpers.buildButton({
      tone: "quiet",
      size: "compact",
      label: t("codexApprovalSettingsLink"),
      className: "codex-approval-settings-btn",
      onClick: () => {
        root.ClawdSettingsCore.runtime.agentsSubtab = readers.readAgentIntegrationInstalled("codex")
          ? "connected" : "discover";
        ops.selectTab("agents");
        requestAnimationFrame(() => {
          const target = state.mountedControls.agentPermissionModes.get("codex");
          if (!target || !target.row || !document.body.contains(target.row)) return;
          for (let parent = target.row.parentElement; parent; parent = parent.parentElement) {
            if (typeof parent.expand === "function") parent.expand({ animate: false });
          }
          target.row.scrollIntoView({ block: "center" });
          const active = target.row.querySelector("button.active");
          if (active) active.focus({ preventScroll: true });
        });
      },
    });
    control.appendChild(button);
    row.appendChild(control);
    return row;
  }

  function buildPermissionAutomationRow() {
    const row = document.createElement("div");
    row.className = "row permission-automation-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowPermissionAutomation");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    const current = readPermissionAutomationMode();
    const descKey = current === "auto-tools"
      ? "permissionAutomationAutoToolsDesc"
      : (current === "unattended"
        ? "permissionAutomationUnattendedDesc"
        : "permissionAutomationOffDesc");
    desc.textContent = t(descKey);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const segmented = helpers.buildSegmentedRadio({
      id: "permission-automation",
      value: current,
      ariaLabel: t("rowPermissionAutomation"),
      className: "permission-automation-segmented",
      options: PERMISSION_AUTOMATION_OPTIONS.map((option) => ({
        value: option.id,
        label: t(option.labelKey),
      })),
      onChange(nextMode) {
        return setPermissionAutomationMode(nextMode).then((result) => {
          if (result && result.status === "ok" && result.noop !== true) return true;
          if (result && result.status === "ok") return false;
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          return false;
        }).catch((err) => {
          ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
          return false;
        });
      },
    });
    ctrl.appendChild(segmented.element);
    row.appendChild(ctrl);
    state.mountedControls.permissionAutomationMode = {
      element: segmented.element,
      syncFromSnapshot() {
        const mode = readPermissionAutomationMode();
        segmented.setValue(mode);
        const nextDescKey = mode === "auto-tools"
          ? "permissionAutomationAutoToolsDesc"
          : (mode === "unattended"
            ? "permissionAutomationUnattendedDesc"
            : "permissionAutomationOffDesc");
        desc.textContent = t(nextDescKey);
      },
    };
    return row;
  }

  function getMountedGeneralSwitch(key) {
    const meta = state.mountedControls.generalSwitches.get(key);
    if (!meta || !document.body.contains(meta.element)) return null;
    return meta;
  }

  function setGeneralSwitchDisabled(key, disabled) {
    const meta = getMountedGeneralSwitch(key);
    if (!meta) return false;
    meta.control.setState({ disabled: !!disabled });
    return true;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("permissionsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("permissionsSubtitle");
    parent.appendChild(subtitle);

    if (mountedSubtabs) mountedSubtabs.dispose();
    if (mountedHost) mountedHost.dispose();
    mountedHost = helpers.createSubpageHost({ disposeBody: () => ops.clearMountedControls() });
    const switcher = buildSubtabSwitcher();
    mountedSubtabs = switcher.control;
    parent.appendChild(switcher.wrap);
    for (const panel of switcher.control.panels.values()) parent.appendChild(panel);
    mountedHost.render(switcher.control.panels.get(switcher.control.getValue()), renderSubtabBody);
  }

  function renderSubtabBody(parent) {
    const subtab = currentSubtab();
    if (subtab === "channels") {
      const remoteApi = remote();
      if (remoteApi) remoteApi.renderChannelsBody(parent);
      return;
    }
    if (subtab === "lan") {
      const remoteApi = remote();
      if (remoteApi) remoteApi.renderLanBody(parent);
      return;
    }
    renderLocalBody(parent);
  }

  function renderLocalBody(parent) {
    const destructiveRow = helpers.buildSwitchRow({
      key: "destructiveActionReminder",
      labelKey: "rowDestructiveActionReminder",
      descKey: "rowDestructiveActionReminderDesc",
      descExtraKey: "rowDestructiveActionReminderNote",
    });
    helpers.attachDescriptionDisclosure(destructiveRow, { includeExtra: true });
    parent.appendChild(helpers.buildSection(t("sectionPermissionLocal"), [
      buildPermissionAutomationRow(),
      destructiveRow,
    ]));

    // The per-tool block only makes sense for an agent that is actually wired
    // in; without Codex there is no approval owner to redirect.
    if (readers.readAgentIntegrationInstalled("codex")) {
      parent.appendChild(helpers.buildSection(t("sectionPermissionPerTool"), [
        buildCodexApprovalOwnerRow(),
      ]));
    }
  }

  function buildSubtabSwitcher() {
    const wrap = document.createElement("div");
    wrap.className = "anim-override-subtabs";
    const control = helpers.buildTabs({
      id: "settings-permissions",
      ariaLabel: t("permissionsTitle"),
      value: currentSubtab(),
      options: SUBTABS.map((entry) => ({ value: entry.id, label: t(entry.labelKey) })),
      onChange(value) {
        if (currentSubtab() === "channels" && value !== "channels") {
          const remoteApi = remote();
          if (remoteApi) remoteApi.leave();
        }
        runtime.permissionsSubtab = value;
        mountedHost.render(control.panels.get(value), renderSubtabBody, { scrollTop: 0 });
      },
    });
    wrap.appendChild(control.element);
    return { wrap, control };
  }

  function patchInPlace(changes, context) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (keys.every((key) => PERMISSIONS_IN_PLACE_KEYS.has(key))) {
      if (keys.includes("permissionAutomationMode")) {
        const control = state.mountedControls.permissionAutomationMode;
        if (!control || !document.body.contains(control.element)) return false;
      }
      for (const key of keys) {
        if (key === "permissionAutomationMode") continue;
        if (key === "permissionAutomationAutoToolsWarningDismissed"
          || key === "permissionAutomationUnattendedWarningDismissed") continue;
        const meta = state.mountedControls.generalSwitches.get(key);
        if (!meta || !document.body.contains(meta.element)) return false;
      }
      for (const key of keys) {
        if (key === "permissionAutomationMode") {
          state.mountedControls.permissionAutomationMode.syncFromSnapshot();
          continue;
        }
        if (key === "permissionAutomationAutoToolsWarningDismissed"
          || key === "permissionAutomationUnattendedWarningDismissed") continue;
        const meta = state.mountedControls.generalSwitches.get(key);
        state.transientUiState.generalSwitches.delete(key);
        meta.control.setState({
          checked: readers.readGeneralSwitchVisual(key, meta.invert),
          pending: false,
        });
      }
      return true;
    }
    const remoteApi = remote();
    return !!(remoteApi && typeof remoteApi.patchInPlace === "function"
      && remoteApi.patchInPlace(changes, context));
  }

  function refreshRuntimeStatus(payload) {
    const remoteApi = remote();
    if (!remoteApi || typeof remoteApi.refreshRuntimeStatus !== "function") return false;
    return remoteApi.refreshRuntimeStatus(payload);
  }

  function onExit() {
    const remoteApi = remote();
    if (remoteApi && typeof remoteApi.leave === "function") remoteApi.leave();
    if (mountedSubtabs) mountedSubtabs.dispose();
    if (mountedHost) mountedHost.dispose();
    mountedSubtabs = null;
    mountedHost = null;
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.permissions = {
      render,
      patchInPlace,
      refreshRuntimeStatus,
      onExit,
    };
  }

  root.ClawdSettingsTabPermissions = { init };
})(globalThis);
