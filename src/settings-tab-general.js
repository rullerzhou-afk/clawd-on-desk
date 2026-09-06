"use strict";

(function initSettingsTabGeneral(root) {
  const GENERAL_IN_PLACE_KEYS = new Set([
    "size",
    "textScale",
    "textScaleByDisplay",
    "soundMuted",
    "flashTaskbarOnComplete",
    "flashIntervalMs",
    "flashDurationMs",
    "testReactionsEnabled",
    "soundVolume",
    "lowPowerIdleMode",
    "keepAwakeWhileWorking",
    "showTray",
    "showDock",
    "sessionHudEnabled",
    "sessionHudShowStateLabels",
    "sessionHudShowElapsed",
    "sessionHudShowContextUsage",
    "sessionHudShowQuota",
    "quotaRingDisplayMode",
    "permissionAutomationMode",
    "permissionAutomationAutoToolsWarningDismissed",
    "permissionAutomationUnattendedWarningDismissed",
    // claudeQuotaCollectionEnabled is deliberately absent: the switch moved to
    // the Claude card on the Agents tab, so General has nothing mounted to
    // patch and must fall through to a full re-render.
    "quotaMergeSources",
    "sessionHudCleanupDetached",
    "allowEdgePinning",
    "disableMiniMode",
    "freeRoam",
    "roamConstrainAxis",
    "keepSizeAcrossDisplays",
    "fullscreenAutoHide",
    "openAtLogin",
    "hideBubbles",
    "bubbleFollowPet",
    "bubbleFollowPreference",
    "bubbleFixedCorner",
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
    "sessionStaleMs",
    "workingStaleMs",
    "codexWorkingStaleMs",
    "detachedIdleStaleMs",
  ]);
  const BUBBLE_POLICY_KEYS = new Set([
    "permissionBubblesEnabled",
    "permissionBubbleAutoCloseSeconds",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const BUBBLE_PLACEMENT_KEYS = new Set([
    "bubbleFollowPet",
    "bubbleFollowPreference",
    "bubbleFixedCorner",
  ]);
  const SESSION_CLEANUP_NUMBER_KEYS = new Set([
    "sessionStaleMs",
    "workingStaleMs",
    "codexWorkingStaleMs",
    "detachedIdleStaleMs",
  ]);
  const FLASH_NUMBER_KEYS = new Set([
    "flashIntervalMs",
    "flashDurationMs",
  ]);
  const SESSION_CLEANUP_DEFAULTS = {
    sessionStaleMs: 600_000,
    workingStaleMs: 300_000,
    codexWorkingStaleMs: 1_200_000,
    detachedIdleStaleMs: 30_000,
  };
  const SESSION_HUD_CHILD_SWITCH_KEYS = [
    "sessionHudShowStateLabels",
    "sessionHudShowElapsed",
    "sessionHudShowContextUsage",
    "sessionHudCleanupDetached",
  ];
  const SESSION_HUD_SUMMARY_KEYS = new Set([
    "sessionHudEnabled",
    "sessionHudShowStateLabels",
    "sessionHudShowElapsed",
    "sessionHudShowContextUsage",
    "sessionHudCleanupDetached",
  ]);
  const BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS = 600;
  const PERMISSION_AUTOMATION_OPTIONS = [
    { id: "off", labelKey: "permissionAutomationOff" },
    { id: "auto-tools", labelKey: "permissionAutomationAutoTools" },
    { id: "unattended", labelKey: "permissionAutomationUnattended" },
  ];

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  const LANGUAGE_OPTIONS = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];
  const ROAM_MOVEMENT_NATURAL = "natural";
  const ROAM_MOVEMENT_AXIS = "axis";

  function t(key) {
    return helpers.t(key);
  }

  function buildMacAppPresenceRows() {
    if (!i18n || !i18n.IS_MAC) return [];
    const showTray = !!(state.snapshot && state.snapshot.showTray);
    const showDock = !!(state.snapshot && state.snapshot.showDock);
    const definitions = [
      {
        key: "showTray",
        labelKey: "rowShowInMenuBar",
        descKey: "rowShowInMenuBarDesc",
        disabled: showTray && !showDock,
      },
      {
        key: "showDock",
        labelKey: "rowShowInDock",
        descKey: "rowShowInDockDesc",
        disabled: showDock && !showTray,
      },
    ];
    return definitions.map((definition) => {
      const row = helpers.buildSwitchRow(definition);
      const sw = row.querySelector(".switch");
      if (sw) sw.setAttribute("aria-label", t(definition.labelKey));
      return row;
    });
  }

  function readRoamMovementStyle() {
    return state.snapshot && state.snapshot.roamConstrainAxis === true
      ? ROAM_MOVEMENT_AXIS
      : ROAM_MOVEMENT_NATURAL;
  }

  async function saveRoamMovementStyle(value) {
    try {
      const result = await window.settingsAPI.update(
        "roamConstrainAxis",
        value === ROAM_MOVEMENT_AXIS,
      );
      if (result && result.status === "ok") return true;
      const message = (result && result.message) || "unknown error";
      ops.showToast(t("toastSaveFailed") + message, { error: true });
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }
    return false;
  }

  function buildRoamMovementStyleRow() {
    const row = document.createElement("div");
    row.className = "row roam-movement-style-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowRoamMovementStyle");
    const description = document.createElement("span");
    description.className = "row-desc";
    description.textContent = t("rowRoamMovementStyleDesc");
    text.appendChild(label);
    text.appendChild(description);

    const controlHost = document.createElement("div");
    controlHost.className = "row-control";
    const control = helpers.buildSegmentedRadio({
      value: readRoamMovementStyle(),
      disabled: !(state.snapshot && state.snapshot.freeRoam === true),
      ariaLabel: t("rowRoamMovementStyle"),
      className: "roam-movement-style-segmented",
      options: [
        { value: ROAM_MOVEMENT_NATURAL, label: t("roamMovementNatural") },
        { value: ROAM_MOVEMENT_AXIS, label: t("roamMovementAxis") },
      ],
      onChange: saveRoamMovementStyle,
    });
    controlHost.appendChild(control.element);
    row.appendChild(text);
    row.appendChild(controlHost);
    state.mountedControls.roamMovementStyle = control;
    return row;
  }

  function saveBubblePlacementValue(key, value) {
    return window.settingsAPI.update(key, value).then((result) => {
      if (result && result.status === "ok") return true;
      const message = (result && result.message) || "unknown error";
      ops.showToast(t("toastSaveFailed") + message, { error: true });
      return false;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return false;
    });
  }

  function buildBubblePlacementRow({ labelKey, descKey, className, control }) {
    const row = document.createElement("div");
    row.className = `row ${className}`;
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t(descKey);
    text.appendChild(label);
    text.appendChild(desc);
    const host = document.createElement("div");
    host.className = "row-control";
    host.appendChild(control.element);
    row.appendChild(text);
    row.appendChild(host);
    return row;
  }

  function buildBubblePlacementGroup() {
    const group = document.createElement("div");
    group.className = "bubble-placement-group";
    let syncConditionalVisibility = () => {};

    const modeControl = helpers.buildSegmentedRadio({
      value: state.snapshot && state.snapshot.bubbleFollowPet === true ? "follow" : "fixed",
      ariaLabel: t("rowBubblePlacement"),
      className: "bubble-placement-mode-segmented",
      options: [
        { value: "follow", label: t("bubblePlacementFollow") },
        { value: "fixed", label: t("bubblePlacementFixed") },
      ],
      onChange(nextMode) {
        return saveBubblePlacementValue("bubbleFollowPet", nextMode === "follow").then((accepted) => {
          if (accepted) syncConditionalVisibility(nextMode === "follow");
          return accepted;
        });
      },
    });
    const followControl = helpers.buildSegmentedRadio({
      value: state.snapshot && state.snapshot.bubbleFollowPreference || "auto",
      ariaLabel: t("rowBubbleFollowPreference"),
      className: "bubble-follow-preference-segmented",
      options: [
        { value: "auto", label: t("bubbleFollowAuto") },
        { value: "left", label: t("bubbleFollowLeft") },
        { value: "right", label: t("bubbleFollowRight") },
      ],
      onChange: (value) => saveBubblePlacementValue("bubbleFollowPreference", value),
    });
    const cornerControl = helpers.buildSegmentedRadio({
      value: state.snapshot && state.snapshot.bubbleFixedCorner || "bottom-right",
      ariaLabel: t("rowBubbleFixedCorner"),
      className: "bubble-fixed-corner-segmented",
      options: [
        { value: "top-left", label: t("bubbleCornerTopLeft") },
        { value: "top-right", label: t("bubbleCornerTopRight") },
        { value: "bottom-left", label: t("bubbleCornerBottomLeft") },
        { value: "bottom-right", label: t("bubbleCornerBottomRight") },
      ],
      onChange: (value) => saveBubblePlacementValue("bubbleFixedCorner", value),
    });

    const modeRow = buildBubblePlacementRow({
      labelKey: "rowBubblePlacement",
      descKey: "rowBubblePlacementDesc",
      className: "bubble-placement-mode-row",
      control: modeControl,
    });
    const followRow = buildBubblePlacementRow({
      labelKey: "rowBubbleFollowPreference",
      descKey: "rowBubbleFollowPreferenceDesc",
      className: "bubble-follow-preference-row",
      control: followControl,
    });
    const cornerRow = buildBubblePlacementRow({
      labelKey: "rowBubbleFixedCorner",
      descKey: "rowBubbleFixedCornerDesc",
      className: "bubble-fixed-corner-row",
      control: cornerControl,
    });
    group.appendChild(modeRow);
    group.appendChild(followRow);
    group.appendChild(cornerRow);

    syncConditionalVisibility = (followPet) => {
      const globallyDisabled = !!(state.snapshot && state.snapshot.hideBubbles === true);
      followRow.hidden = !followPet;
      cornerRow.hidden = followPet;
      followRow.setAttribute("aria-hidden", followPet ? "false" : "true");
      cornerRow.setAttribute("aria-hidden", followPet ? "true" : "false");
      modeControl.setDisabled(globallyDisabled);
      followControl.setDisabled(globallyDisabled || !followPet);
      cornerControl.setDisabled(globallyDisabled || followPet);
    };

    state.mountedControls.bubblePlacement = {
      element: group,
      modeRow,
      followRow,
      cornerRow,
      modeControl,
      followControl,
      cornerControl,
      syncFromSnapshot() {
        const followPet = !!(state.snapshot && state.snapshot.bubbleFollowPet === true);
        modeControl.setValue(followPet ? "follow" : "fixed");
        followControl.setValue(state.snapshot && state.snapshot.bubbleFollowPreference || "auto");
        cornerControl.setValue(state.snapshot && state.snapshot.bubbleFixedCorner || "bottom-right");
        syncConditionalVisibility(followPet);
      },
    };
    state.mountedControls.bubblePlacement.syncFromSnapshot();
    return group;
  }

  function buildRoamAreaRow() {
    const row = document.createElement("div");
    row.className = "row roam-area-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowRoamArea");
    const description = document.createElement("span");
    description.className = "row-desc roam-area-status";
    description.textContent = t("roamAreaLoading");
    text.appendChild(label);
    text.appendChild(description);

    const controls = document.createElement("div");
    controls.className = "row-control roam-area-controls";
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "soft-btn roam-area-reset";
    resetButton.textContent = t("roamAreaReset");
    resetButton.style.display = "none";
    const chooseButton = document.createElement("button");
    chooseButton.type = "button";
    chooseButton.className = "soft-btn accent roam-area-choose";
    chooseButton.textContent = t("roamAreaChoose");
    controls.appendChild(resetButton);
    controls.appendChild(chooseButton);
    row.appendChild(text);
    row.appendChild(controls);

    let busy = false;
    function isMounted() {
      return document.body.contains(row);
    }
    function setBusy(next) {
      busy = !!next;
      chooseButton.disabled = busy;
      resetButton.disabled = busy;
      chooseButton.classList.toggle("pending", busy);
    }
    function applyStatus(result) {
      if (!isMounted()) return;
      if (!result || result.status !== "ok" || result.active === null) {
        description.textContent = t("roamAreaUnavailable");
        resetButton.style.display = "none";
        return;
      }
      if (result.active && result.fence) {
        const width = Math.round((result.fence.right - result.fence.left) * 100);
        const height = Math.round((result.fence.bottom - result.fence.top) * 100);
        description.textContent = t("roamAreaCustom")
          .replace("{width}", String(width))
          .replace("{height}", String(height));
        resetButton.style.display = "";
        return;
      }
      description.textContent = t("roamAreaEntire");
      resetButton.style.display = "none";
    }
    async function refresh() {
      if (!window.settingsAPI || typeof window.settingsAPI.getRoamFence !== "function") {
        applyStatus({ status: "unknown", active: null });
        return;
      }
      try { applyStatus(await window.settingsAPI.getRoamFence()); }
      catch { applyStatus({ status: "unknown", active: null }); }
    }
    chooseButton.addEventListener("click", async () => {
      if (busy || !window.settingsAPI || typeof window.settingsAPI.selectRoamFence !== "function") return;
      setBusy(true);
      try {
        const result = await window.settingsAPI.selectRoamFence();
        if (result && result.status === "ok") {
          applyStatus(result);
          ops.showToast(t("roamAreaSaved"));
        } else if (result && result.code === "pet-too-large") {
          ops.showToast(t("roamAreaPetTooLarge"), { error: true });
        } else if (result && result.status !== "cancel") {
          ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
        }
      } catch (err) {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      } finally {
        if (isMounted()) setBusy(false);
      }
    });
    resetButton.addEventListener("click", async () => {
      if (busy || !window.settingsAPI || typeof window.settingsAPI.clearRoamFence !== "function") return;
      setBusy(true);
      try {
        const result = await window.settingsAPI.clearRoamFence();
        if (result && result.status === "ok") {
          applyStatus(result);
          ops.showToast(t("roamAreaResetDone"));
        } else {
          ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
        }
      } catch (err) {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      } finally {
        if (isMounted()) setBusy(false);
      }
    });
    state.mountedControls.roamArea = {
      row,
      description,
      chooseButton,
      resetButton,
      refresh,
    };
    Promise.resolve().then(refresh);
    return row;
  }

  function buildFreeRoamGroup() {
    const headerRow = helpers.buildSwitchRow({
      key: "freeRoam",
      labelKey: "rowFreeRoam",
      descKey: "rowFreeRoamDesc",
    });
    headerRow.classList.add("free-roam-header-row");

    const headerSwitch = headerRow.querySelector(".switch");
    if (headerSwitch) headerSwitch.setAttribute("aria-label", t("rowFreeRoam"));
    const headerAction = headerRow.querySelector(".row-control");
    if (headerAction) headerAction.remove();

    return helpers.buildCollapsibleGroup({
      id: "general:free-roam",
      headerContent: headerRow,
      headerAction,
      disclosureLabel: t("rowFreeRoam"),
      defaultCollapsed: true,
      className: "free-roam-collapsible",
      children: [buildOptionList("free-roam-option-list", [
        buildRoamMovementStyleRow(),
        buildRoamAreaRow(),
      ])],
    });
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("settingsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("settingsSubtitle");
    parent.appendChild(subtitle);
    parent.appendChild(buildTutorialReplayHint());

    // General tab IA: sections are ordered by how often they're touched, with
    // the danger section pinned last. Appearance stays first (language sits at
    // the top of settings by convention); Session ranks high because it's
    // checked often; Behavior & position and System & startup are set-once, so
    // they sink toward the bottom.
    parent.appendChild(helpers.buildSection(t("sectionAppearance"), [
      buildLanguageRow(),
      buildSizeSliderRow(),
      buildTextScaleRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionSession"), [
      buildSessionHudGroup(),
      buildQuotaRingGroup(),
      buildSessionCleanupGroup(),
      buildDashboardRow(),
    ]));

    // Alerts & feedback: every way the pet gets your attention — sound, screen
    // flash, and the bubble preferences (visibility, auto-close policy, follow).
    parent.appendChild(helpers.buildSection(t("sectionAlerts"), [
      buildSoundGroup(),
      buildFlashGroup(),
      helpers.buildSwitchRow({
        key: "testReactionsEnabled",
        labelKey: "rowTestReactions",
        descKey: "rowTestReactionsDesc",
      }),
      helpers.buildSwitchRow({
        key: "hideBubbles",
        labelKey: "rowHideBubbles",
        descKey: "rowHideBubblesDesc",
        onToggle: ({ nextRaw }) => window.settingsAPI.command("setAllBubblesHidden", { hidden: nextRaw }),
      }),
      buildBubblePolicyRow(),
      buildBubblePlacementGroup(),
    ]));

    // Behavior & position: how the pet moves and sits on screen. Rarely changed
    // after first setup, so it sits below the everyday sections.
    parent.appendChild(helpers.buildSection(t("sectionBehavior"), [
      buildFreeRoamGroup(),
      helpers.buildSwitchRow({
        key: "allowEdgePinning",
        labelKey: "rowAllowEdgePinning",
        descKey: "rowAllowEdgePinningDesc",
      }),
      helpers.buildSwitchRow({
        key: "disableMiniMode",
        labelKey: "rowDisableMiniMode",
        descKey: "rowDisableMiniModeDesc",
      }),
      helpers.buildSwitchRow({
        key: "keepSizeAcrossDisplays",
        labelKey: "rowKeepSizeAcrossDisplays",
        descKey: "rowKeepSizeAcrossDisplaysDesc",
      }),
      // #562: the fullscreenOverlay switch is intentionally NOT rendered here.
      // For borderless-fullscreen games (the common case) "off" can't drop the
      // pet behind the game anyway (a Windows limit), so the toggle was a
      // non-choice. The pref + #538 stand-down logic stay (default on) as an
      // escape hatch for exclusive-fullscreen games, whose overlay behavior is
      // unverified. To restore the toggle: re-add a buildSwitchRow for
      // "fullscreenOverlay" here AND add its key back into GENERAL_IN_PLACE_KEYS
      // (dropped so patchInPlace doesn't force a full re-render for a pref that
      // has no mounted control). The rowFullscreenOverlay[Desc] i18n keys remain.
      // #935: unlike that overlay toggle, auto-hide CAN always deliver what it
      // promises (hiding our own windows needs no z-order fight), so it gets a
      // real switch. Windows-only: the fullscreen probe is constant false
      // elsewhere, so rendering it off-Windows would be a dead toggle.
      ...(i18n && i18n.IS_WIN ? [helpers.buildSwitchRow({
        key: "fullscreenAutoHide",
        labelKey: "rowFullscreenAutoHide",
        descKey: "rowFullscreenAutoHideDesc",
      })] : []),
    ]));

    // System & startup: machine-level toggles (low-power idle throttling and
    // blocking OS sleep while working) plus launch-at-login. Set-once, near bottom.
    parent.appendChild(helpers.buildSection(t("sectionSystemStartup"), [
      ...buildMacAppPresenceRows(),
      helpers.buildSwitchRow({
        key: "lowPowerIdleMode",
        labelKey: "rowLowPowerIdleMode",
        descKey: "rowLowPowerIdleModeDesc",
      }),
      helpers.buildSwitchRow({
        key: "keepAwakeWhileWorking",
        labelKey: "rowKeepAwakeWhileWorking",
        descKey: "rowKeepAwakeWhileWorkingDesc",
      }),
      helpers.buildSwitchRow({
        key: "openAtLogin",
        labelKey: "rowOpenAtLogin",
        descKey: "rowOpenAtLoginDesc",
      }),
    ]));

    // Permission automation stays last: both automatic modes carry a broad
    // trust boundary and require an explicit confirmation.
    parent.appendChild(helpers.buildSection(t("sectionPermissions"), [
      buildPermissionAutomationRow(),
    ]));
  }

  function buildTutorialReplayHint() {
    const wrap = document.createElement("p");
    wrap.className = "general-tutorial-hint";

    const button = document.createElement("button");
    button.className = "general-tutorial-link";
    button.type = "button";
    button.textContent = t("settingsTutorialReplayLink");
    button.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.showTutorial !== "function") return;
      button.disabled = true;
      window.settingsAPI.showTutorial()
        .then((result) => {
          if (!result || result.status !== "ok") {
            throw new Error((result && result.message) || t("settingsTutorialReplayFailed"));
          }
        })
        .catch((err) => {
          const message = t("settingsTutorialReplayFailed") + (err && err.message ? ": " + err.message : "");
          ops.showToast(message, { ttl: 5000 });
        })
        .finally(() => {
          button.disabled = false;
        });
    });

    wrap.appendChild(button);
    return wrap;
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

  function buildDashboardRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control">` +
        `<button type="button" class="soft-btn accent"></button>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowSessionDashboard");
    row.querySelector(".row-desc").textContent = t("rowSessionDashboardDesc");
    const btn = row.querySelector("button");
    btn.textContent = t("actionOpenDashboard");
    btn.addEventListener("click", () => {
      if (window.settingsAPI && typeof window.settingsAPI.openDashboard === "function") {
        window.settingsAPI.openDashboard();
      }
    });
    return row;
  }

  const LANGUAGE_LABEL_KEYS = {
    "en": "langEnglish",
    "zh": "langChinese",
    "zh-TW": "langTraditionalChinese",
    "ko": "langKorean",
    "ja": "langJapanese",
    "pt-BR": "langPortugueseBrazil",
    "es": "langSpanish",
  };

  function buildLanguageRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control">` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowLanguage");
    row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
    const currentLang = readers.getLang();
    const getLabel = (lang) => t(LANGUAGE_LABEL_KEYS[lang] || "langEnglish");
    const pickerControl = helpers.buildSettingsSelect({
      value: currentLang,
      options: LANGUAGE_OPTIONS.map((lang) => ({ value: lang, label: getLabel(lang) })),
      ariaLabel: t("rowLanguage"),
      className: "settings-language-select",
      onChange: (next) => {
        // Selecting the already committed language only closes the menu. This
        // also avoids sending a duplicate update while an earlier save settles.
        if (next === readers.getLang()) return true;
        let updatePromise;
        try {
          updatePromise = window.settingsAPI.update("lang", next);
        } catch (err) {
          ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
          return false;
        }
        return Promise.resolve(updatePromise).then((result) => {
          if (!result || result.status !== "ok") {
            const msg = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + msg, { error: true });
            return false;
          }
          return true;
        }).catch((err) => {
          ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
          return false;
        });
      },
    });
    row.querySelector(".row-control").appendChild(pickerControl.element);
    return row;
  }

  function buildSessionHudGroup() {
    const summaryControl = buildSessionHudSummary();
    state.mountedControls.sessionHudSummary = summaryControl;
    const sessionHudControlsEnabled = !!(state.snapshot && state.snapshot.sessionHudEnabled);
    return helpers.buildCollapsibleGroup({
      id: "general:session-hud",
      title: t("rowSessionHud"),
      desc: t("rowSessionHudDesc"),
      summary: summaryControl.element,
      defaultCollapsed: true,
      className: "session-hud-collapsible",
      children: [buildSessionHudOptionsList(sessionHudControlsEnabled)],
    });
  }

  // The quota ring is a sibling of the Session HUD under "Session management",
  // not a child of it: its switches are never gated by the HUD master, so the
  // ring can be used with the Session HUD turned off (and vice versa).
  //
  // This group answers ONE question: what does the ring look like. It used to
  // also carry "collect local Claude usage", which is a different question —
  // whether to read a provider at all — and having the two side by side is why
  // per-provider collection ended up split across two tabs, Claude here and
  // Kimi on its agent card. Collection now lives on each provider's own card
  // under Agents, so "which providers am I reading" has one place to look.
  // Keep it that way: a new provider's collection switch goes on its card.
  function buildQuotaRingGroup() {
    const enabledRow = helpers.buildSwitchRow({
      key: "sessionHudShowQuota",
      labelKey: "rowQuotaRingEnabled",
      descKey: "rowQuotaRingEnabledDesc",
    });
    const mergeRow = helpers.buildSwitchRow({
      key: "quotaMergeSources",
      labelKey: "rowQuotaMergeSources",
      descKey: "rowQuotaMergeSourcesDesc",
    });
    const displayModeRow = buildQuotaRingDisplayModeRow();
    const providersBlock = buildQuotaRingProvidersBlock();
    // "Merge across machines" only matters with more than one reporting source
    // (WSL / SSH remotes). Hidden by default so single-machine users never see
    // a confusing no-op switch; revealed once multiple sources are confirmed.
    mergeRow.style.display = state.snapshot && state.snapshot.quotaMergeSources === true
      ? ""
      : "none";
    const optionList = buildOptionList("quota-ring-option-list", [
      enabledRow,
      displayModeRow,
      providersBlock.element,
      mergeRow,
    ]);
    const group = helpers.buildCollapsibleGroup({
      id: "general:quota-ring",
      title: t("rowQuotaRingGroup"),
      desc: t("rowQuotaRingGroupDesc"),
      defaultCollapsed: true,
      className: "quota-ring-collapsible",
      children: [optionList],
    });
    if (window.settingsAPI && typeof window.settingsAPI.getQuotaSourceCount === "function") {
      Promise.resolve(window.settingsAPI.getQuotaSourceCount())
        .then((count) => {
          if (Number(count) <= 1) return;
          const revealMergeRow = () => {
            mergeRow.style.display = "";
            return mergeRow;
          };
          if (typeof group.mutateCollapsibleBody === "function") {
            group.mutateCollapsibleBody(revealMergeRow);
          } else {
            revealMergeRow();
          }
        })
        .catch(() => {});
    }
    providersBlock.load(group);
    return group;
  }

  // Per-provider visibility for the pet-side cluster. This is display-only —
  // collection stays on each provider's Agents card and the Dashboard keeps
  // showing everything — because the cluster caps at four coins and the
  // renderer simply takes the first four in provider order, so without this the
  // user has no say over WHICH four survive. With remotes the count is sources
  // × providers, which is where it stops being theoretical.
  //
  // The list is built from providers that actually report, so a fresh install
  // sees nothing here rather than four checkboxes for things it never
  // connected — the same rule that hides "merge across machines" on one machine.
  function buildQuotaRingProvidersBlock() {
    const element = document.createElement("div");
    element.className = "quota-ring-providers";
    element.style.display = "none";

    const head = document.createElement("div");
    head.className = "row quota-ring-providers-head";
    const headText = document.createElement("div");
    headText.className = "row-text";
    const headLabel = document.createElement("span");
    headLabel.className = "row-label";
    headLabel.textContent = t("rowQuotaRingProviders");
    const headDesc = document.createElement("span");
    headDesc.className = "row-desc";
    headDesc.textContent = t("rowQuotaRingProvidersDesc");
    headText.append(headLabel, headDesc);
    head.appendChild(headText);
    element.appendChild(head);

    function hiddenList() {
      const raw = state.snapshot && state.snapshot.quotaRingHiddenProviders;
      return Array.isArray(raw) ? raw.filter((key) => typeof key === "string" && key) : [];
    }

    function buildProviderRow(provider) {
      const row = document.createElement("div");
      row.className = "row row-sub quota-ring-provider-row";
      row.dataset.providerKey = provider.key;
      const text = document.createElement("div");
      text.className = "row-text";
      const label = document.createElement("span");
      label.className = "row-label";
      // Brand name, deliberately not translated — it identifies the provider.
      label.textContent = provider.label || provider.key;
      text.appendChild(label);
      const control = document.createElement("div");
      control.className = "row-control";
      const sw = document.createElement("div");
      sw.className = "switch";
      sw.setAttribute("role", "switch");
      sw.tabIndex = 0;
      // ON means "shown", so the switch reads the way the label does. The pref
      // stores the inverse (what is HIDDEN) — see prefs.js for why.
      let shown = !hiddenList().includes(provider.key);
      helpers.setSwitchVisual(sw, shown);
      sw.setAttribute("aria-label", provider.label || provider.key);
      control.appendChild(sw);
      row.append(text, control);

      helpers.attachActivation(sw, () => {
        const next = !shown;
        // Optimistic: the broadcast that confirms this rebuilds the tab, and
        // leaving the switch stale until then reads as an ignored click.
        shown = next;
        helpers.setSwitchVisual(sw, shown, { pending: true });
        const hidden = hiddenList().filter((key) => key !== provider.key);
        if (!next) hidden.push(provider.key);
        return Promise.resolve(
          window.settingsAPI.update("quotaRingHiddenProviders", hidden)
        ).catch(() => {
          shown = !next;
          helpers.setSwitchVisual(sw, shown);
        });
      });
      return row;
    }

    function load(group) {
      const api = window.settingsAPI;
      if (!api || typeof api.getQuotaRingProviders !== "function") return;
      Promise.resolve(api.getQuotaRingProviders())
        .then((providers) => {
          const list = Array.isArray(providers) ? providers : [];
          // One connected provider cannot crowd anything out, so the control
          // would be a no-op switch — the same reason merge stays hidden.
          if (list.length <= 1) return;
          const reveal = () => {
            for (const provider of list) {
              if (!provider || typeof provider.key !== "string") continue;
              element.appendChild(buildProviderRow(provider));
            }
            element.style.display = "";
            return element;
          };
          if (group && typeof group.mutateCollapsibleBody === "function") {
            group.mutateCollapsibleBody(reveal);
          } else {
            reveal();
          }
        })
        .catch(() => {});
    }

    return { element, load };
  }

  function buildQuotaRingDisplayModeRow() {
    const row = document.createElement("div");
    row.className = "row quota-ring-display-mode-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowQuotaRingDisplayMode");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("rowQuotaRingDisplayModeDesc");
    text.append(label, desc);

    const controlWrap = document.createElement("div");
    controlWrap.className = "row-control";
    const control = helpers.buildSegmentedRadio({
      value: state.snapshot && state.snapshot.quotaRingDisplayMode,
      ariaLabel: t("rowQuotaRingDisplayMode"),
      className: "quota-ring-display-mode-choice",
      options: [
        { value: "used", label: t("quotaRingDisplayUsed") },
        { value: "remaining", label: t("quotaRingDisplayRemaining") },
      ],
      onChange: (next) => {
        if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
          ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
          return false;
        }
        return Promise.resolve()
          .then(() => window.settingsAPI.update("quotaRingDisplayMode", next))
          .then((result) => {
            if (result && result.status === "ok") return true;
            ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
            return false;
          })
          .catch((err) => {
            ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
            return false;
          });
      },
    });
    controlWrap.appendChild(control.element);
    row.append(text, controlWrap);
    state.mountedControls.quotaRingDisplayMode = control;
    return row;
  }

  function buildOptionList(className, rows) {
    const list = document.createElement("div");
    list.className = `settings-option-list ${className || ""}`.trim();
    for (const row of rows) {
      row.classList.add("settings-option-item");
      list.appendChild(row);
    }
    return list;
  }

  function buildSessionHudOptionsList(sessionHudControlsEnabled) {
    return buildOptionList("session-hud-option-list", [
      helpers.buildSwitchRow({
        key: "sessionHudEnabled",
        labelKey: "rowSessionHudMaster",
      }),
      helpers.buildSwitchRow({
        key: "sessionHudShowStateLabels",
        labelKey: "rowSessionHudStateLabels",
        descKey: "rowSessionHudStateLabelsDesc",
        disabled: !sessionHudControlsEnabled,
      }),
      helpers.buildSwitchRow({
        key: "sessionHudShowElapsed",
        labelKey: "rowSessionHudElapsed",
        descKey: "rowSessionHudElapsedDesc",
        disabled: !sessionHudControlsEnabled,
      }),
      helpers.buildSwitchRow({
        key: "sessionHudShowContextUsage",
        labelKey: "rowSessionHudContextUsage",
        descKey: "rowSessionHudContextUsageDesc",
        disabled: !sessionHudControlsEnabled,
      }),
      helpers.buildSwitchRow({
        key: "sessionHudCleanupDetached",
        labelKey: "rowSessionHudCleanupDetached",
        descKey: "rowSessionHudCleanupDetachedDesc",
        disabled: !sessionHudControlsEnabled,
      }),
    ]);
  }

  function buildSessionHudSummary() {
    const wrap = document.createElement("div");
    wrap.className = "collapsible-summary-wrap session-hud-summary-control";

    function syncFromSnapshot() {
      wrap.innerHTML = "";
      const snapshot = state.snapshot || {};
      const enabled = snapshot.sessionHudEnabled !== false;
      wrap.classList.toggle("compact", !enabled);
      const onLabel = t("bubblePolicySummaryOn");
      const offLabel = t("bubblePolicySummaryOff");
      const items = [];
      if (!enabled) {
        items.push({
          text: t("sessionHudSummaryEnabled").replace("{state}", offLabel),
          accent: false,
        });
      }
      if (enabled) {
        items.push({
          text: t("sessionHudSummaryLabels").replace(
            "{state}",
            snapshot.sessionHudShowStateLabels !== false ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudShowStateLabels !== false,
        });
        items.push({
          text: t("sessionHudSummaryElapsed").replace(
            "{state}",
            snapshot.sessionHudShowElapsed !== false ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudShowElapsed !== false,
        });
        items.push({
          text: t("sessionHudSummaryContextUsage").replace(
            "{state}",
            snapshot.sessionHudShowContextUsage !== false ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudShowContextUsage !== false,
        });
        items.push({
          text: t("sessionHudSummaryCleanup").replace(
            "{state}",
            snapshot.sessionHudCleanupDetached === true ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudCleanupDetached === true,
        });
      }
      for (const item of items) {
        const chip = document.createElement("span");
        chip.className = "collapsible-summary-chip" + (item.accent ? " accent" : "");
        chip.textContent = item.text;
        wrap.appendChild(chip);
      }
    }

    syncFromSnapshot();
    return {
      element: wrap,
      syncFromSnapshot,
    };
  }

  function buildSessionCleanupGroup() {
    const optionList = buildOptionList("session-cleanup-option-list", [
      helpers.buildNumberInputRow({
        key: "sessionStaleMs",
        labelKey: "rowStaleSession",
        descKey: "rowStaleSessionDesc",
        unitKey: "unitMinutes",
        toDisplay: (ms) => Math.round(ms / 60_000),
        fromDisplay: (min) => Math.max(0, Math.round(min * 60_000)),
        min: 0,
        max: 1440,
        zeroLabelKey: "valueDisabled",
      }).row,
      helpers.buildNumberInputRow({
        key: "workingStaleMs",
        labelKey: "rowStaleWorking",
        descKey: "rowStaleWorkingDesc",
        unitKey: "unitSeconds",
        toDisplay: (ms) => Math.round(ms / 1000),
        fromDisplay: (sec) => Math.max(30_000, Math.min(86_400_000, Math.round(sec * 1000))),
        min: 30,
        max: 86_400,
      }).row,
      helpers.buildNumberInputRow({
        key: "codexWorkingStaleMs",
        labelKey: "rowCodexStaleWorking",
        descKey: "rowCodexStaleWorkingDesc",
        unitKey: "unitMinutes",
        toDisplay: (ms) => Math.round(ms / 60_000),
        fromDisplay: (min) => min === 0
          ? 0
          : Math.max(30_000, Math.min(86_400_000, Math.round(min * 60_000))),
        min: 0,
        max: 1440,
        zeroLabelKey: "valueDisabled",
      }).row,
      helpers.buildNumberInputRow({
        key: "detachedIdleStaleMs",
        labelKey: "rowStaleDetached",
        descKey: "rowStaleDetachedDesc",
        unitKey: "unitSeconds",
        toDisplay: (ms) => Math.round(ms / 1000),
        fromDisplay: (sec) => Math.max(5_000, Math.min(300_000, Math.round(sec * 1000))),
        min: 5,
        max: 300,
      }).row,
    ]);

    // Reset lives in its own row outside the option-list so it doesn't render
    // as a card; mirrors how Sound group puts the volume slider on its own row.
    const resetRow = document.createElement("div");
    resetRow.className = "row session-cleanup-reset-row";
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "soft-btn";
    resetButton.textContent = t("actionResetSessionCleanup");
    resetButton.addEventListener("click", async () => {
      resetButton.disabled = true;
      try {
        const result = await window.settingsAPI.command(
          "sessionCleanup.setTriple",
          { ...SESSION_CLEANUP_DEFAULTS }
        );
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
        }
      } catch (err) {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      } finally {
        resetButton.disabled = false;
      }
    });
    resetRow.appendChild(resetButton);

    return helpers.buildCollapsibleGroup({
      id: "general:session-cleanup",
      title: t("rowSessionCleanupGroup"),
      desc: t("rowSessionCleanupGroupDesc"),
      defaultCollapsed: true,
      className: "session-cleanup-collapsible",
      children: [optionList, resetRow],
    });
  }

  function buildSoundGroup() {
    const summaryControl = buildSoundSummary();
    state.mountedControls.soundSummary = summaryControl;
    return helpers.buildCollapsibleGroup({
      id: "general:sound",
      title: t("rowSound"),
      desc: t("rowSoundDesc"),
      summary: summaryControl.element,
      defaultCollapsed: true,
      className: "sound-collapsible",
      children: [buildOptionList("sound-option-list", [
        buildSoundEnabledRow(summaryControl),
        buildVolumeSliderRow(),
      ])],
    });
  }

  function buildFlashGroup() {
    return helpers.buildCollapsibleGroup({
      id: "general:flash",
      title: t("rowFlash"),
      desc: t("rowFlashDesc"),
      defaultCollapsed: true,
      className: "flash-collapsible",
      children: [buildOptionList("flash-option-list", [
        helpers.buildSwitchRow({
          key: "flashTaskbarOnComplete",
          labelKey: "rowFlashTaskbarOnComplete",
          descKey: "rowFlashTaskbarOnCompleteDesc",
        }),
        helpers.buildNumberInputRow({
          key: "flashIntervalMs",
          labelKey: "rowFlashInterval",
          descKey: "rowFlashIntervalDesc",
          unitKey: "unitMilliseconds",
          toDisplay: (ms) => ms,
          fromDisplay: (v) => Math.max(200, Math.min(2000, Math.round(v))),
          min: 200,
          max: 2000,
        }).row,
        helpers.buildNumberInputRow({
          key: "flashDurationMs",
          labelKey: "rowFlashDuration",
          descKey: "rowFlashDurationDesc",
          unitKey: "unitMilliseconds",
          toDisplay: (ms) => ms,
          fromDisplay: (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.max(0, Math.min(60000, Math.round(n))) : 0;
          },
          min: 0,
          max: 60000,
          zeroLabelKey: "valueAlways",
        }).row,
      ])],
    });
  }

  function buildSoundEnabledRow(summaryControl) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t("rowSoundEnabled");
    const sw = row.querySelector(".switch");
    const text = row.querySelector(".row-text");
    const override = state.transientUiState.generalSwitches.get("soundMuted");
    const visualOn = override ? override.visualOn : readers.readGeneralSwitchVisual("soundMuted", true);
    helpers.setSwitchVisual(sw, visualOn, { pending: override ? override.pending : false });
    state.mountedControls.generalSwitches.set("soundMuted", {
      element: sw,
      invert: true,
      row,
      text,
      extraElement: null,
    });

    const run = (ev) => {
      if (sw.classList.contains("disabled") || sw.getAttribute("aria-disabled") === "true") return;
      if (!summaryControl || typeof summaryControl.toggleSound !== "function") return;
      summaryControl.toggleSound(ev);
    };
    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      run(ev);
    });
    return row;
  }

  function buildSoundSummary() {
    const wrap = document.createElement("div");
    wrap.className = "sound-summary-control";
    const chip = document.createElement("span");
    const sw = document.createElement("div");
    sw.className = "switch sound-header-switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", t("rowSoundEnabled"));
    sw.setAttribute("tabindex", "0");
    wrap.appendChild(chip);
    wrap.appendChild(sw);

    function getSnapshotVolumePct() {
      const v = state.snapshot && typeof state.snapshot.soundVolume === "number"
        ? state.snapshot.soundVolume : 1;
      return Math.round(Math.max(0, Math.min(1, v)) * 100);
    }

    function getSoundTransientState() {
      return state.transientUiState.generalSwitches.get("soundMuted") || null;
    }

    function getCommittedSoundVisual() {
      return readers.readGeneralSwitchVisual("soundMuted", true);
    }

    function getDisplaySoundVisual() {
      const transient = getSoundTransientState();
      return transient ? transient.visualOn : getCommittedSoundVisual();
    }

    function getDisplaySoundPending() {
      const transient = getSoundTransientState();
      return transient ? transient.pending : false;
    }

    function setSoundChildSwitchVisual(visualOn, pendingVisual) {
      const meta = getMountedGeneralSwitch("soundMuted");
      if (!meta) return;
      helpers.setSwitchVisual(meta.element, visualOn, { pending: pendingVisual });
    }

    function normalizeVolumePct(pct) {
      const n = Number(pct);
      if (!Number.isFinite(n)) return getSnapshotVolumePct();
      return Math.round(Math.max(0, Math.min(100, n)));
    }

    function applySoundSummaryVisual(enabled, pendingVisual = false, volumePct = getSnapshotVolumePct()) {
      const stateLabel = enabled ? t("bubblePolicySummaryOn") : t("bubblePolicySummaryOff");
      chip.className = "collapsible-summary-chip" + (enabled ? " accent" : "");
      chip.textContent = `${stateLabel} · ${normalizeVolumePct(volumePct)}%`;
      helpers.setSwitchVisual(sw, enabled, { pending: pendingVisual });
    }

    function syncFromSnapshot() {
      applySoundSummaryVisual(getDisplaySoundVisual(), getDisplaySoundPending());
    }

    function syncVolumePreview(pct) {
      applySoundSummaryVisual(getDisplaySoundVisual(), getDisplaySoundPending(), pct);
    }

    function toggleSound(ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      const activeTransient = getSoundTransientState();
      if (activeTransient && activeTransient.pending) return;
      const currentRaw = readers.readGeneralSwitchRaw("soundMuted");
      const currentVisual = !currentRaw;
      const nextVisual = !currentVisual;
      const nextMuted = !nextVisual;
      const seq = state.nextTransientUiSeq++;
      state.transientUiState.generalSwitches.set("soundMuted", { visualOn: nextVisual, pending: true, seq });
      applySoundSummaryVisual(nextVisual, true);
      setSoundChildSwitchVisual(nextVisual, true);
      window.settingsAPI.update("soundMuted", nextMuted).then((result) => {
        const currentTransient = getSoundTransientState();
        if (!currentTransient || currentTransient.seq !== seq) return;
        state.transientUiState.generalSwitches.delete("soundMuted");
        if (!result || result.status !== "ok" || result.noop) {
          const committedVisual = getCommittedSoundVisual();
          applySoundSummaryVisual(committedVisual, false);
          setSoundChildSwitchVisual(committedVisual, false);
          if (result && result.noop) return;
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          return;
        }
        applySoundSummaryVisual(nextVisual, false);
        setSoundChildSwitchVisual(nextVisual, false);
      }).catch((err) => {
        const currentTransient = getSoundTransientState();
        if (!currentTransient || currentTransient.seq !== seq) return;
        state.transientUiState.generalSwitches.delete("soundMuted");
        const committedVisual = getCommittedSoundVisual();
        applySoundSummaryVisual(committedVisual, false);
        setSoundChildSwitchVisual(committedVisual, false);
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    }

    sw.addEventListener("click", toggleSound);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      toggleSound(ev);
    });

    syncFromSnapshot();
    return {
      element: wrap,
      headerSwitch: sw,
      syncFromSnapshot,
      syncVolumePreview,
      toggleSound,
    };
  }

  function buildBubblePolicyRow() {
    const summaryControl = buildBubblePolicySummary();
    state.mountedControls.bubblePolicySummary = summaryControl;
    return helpers.buildCollapsibleGroup({
      id: "general:bubble-policy",
      title: t("rowBubblePolicy"),
      desc: t("rowBubblePolicyDesc"),
      summary: summaryControl.element,
      defaultCollapsed: true,
      children: [buildBubblePolicyList()],
      className: "bubble-policy-collapsible",
    });
  }

  function readBubblePolicySnapshot() {
    const aggregateHidden = !!(state.snapshot && state.snapshot.hideBubbles === true);
    return {
      permissionOn: !aggregateHidden && !!(state.snapshot && state.snapshot.permissionBubblesEnabled !== false),
      notificationSeconds: aggregateHidden ? 0 : Number(state.snapshot && state.snapshot.notificationBubbleAutoCloseSeconds) || 0,
      updateSeconds: aggregateHidden ? 0 : Number(state.snapshot && state.snapshot.updateBubbleAutoCloseSeconds) || 0,
    };
  }

  function buildBubblePolicySummary() {
    const wrap = document.createElement("div");
    wrap.className = "collapsible-summary-wrap";

    function syncFromSnapshot() {
      wrap.innerHTML = "";
      const snapshot = readBubblePolicySnapshot();
      const items = [
      {
        text: t("bubblePolicySummaryPermission").replace(
          "{state}",
          snapshot.permissionOn ? t("bubblePolicySummaryOn") : t("bubblePolicySummaryOff")
        ),
        accent: snapshot.permissionOn,
      },
      {
        text: t("bubblePolicySummaryNotification").replace("{seconds}", String(snapshot.notificationSeconds)),
        accent: snapshot.notificationSeconds > 0,
      },
      {
        text: t("bubblePolicySummaryUpdate").replace("{seconds}", String(snapshot.updateSeconds)),
        accent: snapshot.updateSeconds > 0,
      },
      ];
      for (const item of items) {
        const chip = document.createElement("span");
        chip.className = "collapsible-summary-chip" + (item.accent ? " accent" : "");
        chip.textContent = item.text;
        wrap.appendChild(chip);
      }
    }

    syncFromSnapshot();
    return {
      element: wrap,
      syncFromSnapshot,
    };
  }

  function buildBubblePolicyList() {
    const list = document.createElement("div");
    list.className = "bubble-policy-list";
    list.appendChild(buildBubbleCategoryControl({
      category: "permission",
      labelKey: "bubblePermissionLabel",
      descKey: "bubblePermissionDesc",
      enabledKey: "permissionBubblesEnabled",
      secondsKey: "permissionBubbleAutoCloseSeconds",
    }));
    list.appendChild(buildBubbleCategoryControl({
      category: "notification",
      labelKey: "bubbleNotificationLabel",
      descKey: "bubbleNotificationDesc",
      secondsKey: "notificationBubbleAutoCloseSeconds",
    }));
    list.appendChild(buildBubbleCategoryControl({
      category: "update",
      labelKey: "bubbleUpdateLabel",
      descKey: "bubbleUpdateDesc",
      warningKey: "bubbleUpdateWarning",
      secondsKey: "updateBubbleAutoCloseSeconds",
    }));
    return list;
  }

  function buildBubbleCategoryControl({ category, labelKey, descKey, warningKey = null, secondsKey = null, enabledKey = null }) {
    const stateKey = enabledKey || secondsKey || "permissionBubblesEnabled";
    const item = document.createElement("div");
    item.className = "bubble-policy-item";
    item.innerHTML =
      `<div class="bubble-policy-copy">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="bubble-policy-controls">` +
        `<div class="switch" role="switch" tabindex="0"></div>` +
      `</div>`;
    item.querySelector(".row-label").textContent = t(labelKey);
    item.querySelector(".row-desc").textContent = t(descKey);
    if (warningKey) {
      const warning = document.createElement("span");
      warning.className = "row-desc bubble-policy-warning";
      warning.textContent = t(warningKey);
      item.querySelector(".bubble-policy-copy").appendChild(warning);
    }

    const sw = item.querySelector(".switch");
    const controls = item.querySelector(".bubble-policy-controls");
    let secondsInput = null;
    let secondsCommitTimer = null;
    let secondsDraftValue = null;
    let secondsInFlightValue = null;
    let secondsCommitSeq = 0;

    function currentEnabled() {
      if (state.snapshot && state.snapshot.hideBubbles === true) return false;
      if (enabledKey) return !!(state.snapshot && state.snapshot[enabledKey] !== false);
      if (!secondsKey) return !!(state.snapshot && state.snapshot.permissionBubblesEnabled !== false);
      const seconds = Number(state.snapshot && state.snapshot[secondsKey]);
      return Number.isFinite(seconds) && seconds > 0;
    }

    function currentSeconds() {
      if (!secondsKey) return 0;
      return Number(state.snapshot && state.snapshot[secondsKey]) || 0;
    }

    function setVisual(enabled, pending = false) {
      helpers.setSwitchVisual(sw, enabled, { pending });
      if (secondsInput) helpers.setTextInputState(secondsInput, { disabled: !enabled, pending });
    }

    function clearSecondsCommitTimer() {
      if (secondsCommitTimer) {
        clearTimeout(secondsCommitTimer);
        secondsCommitTimer = null;
      }
    }

    function syncFromSnapshot() {
      setVisual(currentEnabled(), false);
      if (!secondsInput) return;
      const snapshotSeconds = currentSeconds();
      if (secondsDraftValue === snapshotSeconds) secondsDraftValue = null;
      if (secondsInFlightValue === snapshotSeconds) secondsInFlightValue = null;
      if (document.activeElement === secondsInput || secondsDraftValue != null) return;
      secondsInput.value = String(snapshotSeconds);
    }

    function submitSecondsCommit(next) {
      if (!secondsInput) return Promise.resolve(false);
      if (next === currentSeconds() || next === secondsInFlightValue) {
        if (secondsDraftValue === next) secondsDraftValue = null;
        return Promise.resolve(true);
      }
      clearSecondsCommitTimer();
      secondsDraftValue = next;
      secondsInFlightValue = next;
      const seq = ++secondsCommitSeq;
      return commitSecondsValue(secondsInput, secondsKey, next, category).then((committed) => {
        if (seq === secondsCommitSeq && secondsInFlightValue === next) secondsInFlightValue = null;
        if (seq !== secondsCommitSeq) return committed;
        if (committed && secondsDraftValue === next) secondsDraftValue = null;
        if (!committed) secondsDraftValue = null;
        return committed;
      });
    }

    function scheduleSecondsCommit(next) {
      secondsDraftValue = next;
      clearSecondsCommitTimer();
      secondsCommitTimer = setTimeout(() => {
        secondsCommitTimer = null;
        void submitSecondsCommit(next);
      }, BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS);
    }

    function flushSecondsCommit() {
      clearSecondsCommitTimer();
      const raw = secondsInput.value.trim();
      const next = parseBubbleSecondsInputValue(raw);
      if (next == null) {
        secondsDraftValue = null;
        secondsInput.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
        ops.showToast(t("toastSaveFailed") + t("bubbleSecondsInvalid"), { error: true });
        return;
      }
      void submitSecondsCommit(next);
    }

    function runToggle() {
      if (sw.classList.contains("pending")) return;
      const nextEnabled = !currentEnabled();
      if (category === "update" && !nextEnabled) {
        setVisual(nextEnabled, true);
        confirmDisableUpdateBubbles().then((actionId) => {
          if (actionId === "confirm") runToggleCommit(nextEnabled);
          else setVisual(currentEnabled(), false);
        });
        return;
      }
      runToggleCommit(nextEnabled);
    }

    function runToggleCommit(nextEnabled) {
      setVisual(nextEnabled, true);
      window.settingsAPI.command("setBubbleCategoryEnabled", { category, enabled: nextEnabled }).then((result) => {
        if (!result || result.status !== "ok") {
          setVisual(currentEnabled(), false);
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch((err) => {
        setVisual(currentEnabled(), false);
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    }

    setVisual(currentEnabled(), false);
    sw.addEventListener("click", runToggle);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        runToggle();
      }
    });

    if (secondsKey) {
      const input = helpers.buildTextInput({
        type: "text",
        size: "compact",
        className: "bubble-policy-seconds",
        inputMode: "numeric",
        maxLength: 4,
        pattern: "[0-9]*",
        value: String(Number(state.snapshot && state.snapshot[secondsKey]) || 0),
        ariaLabel: t(labelKey),
        onEnter: () => {
          flushSecondsCommit();
          input.blur();
        },
      });
      const prefix = document.createElement("span");
      prefix.className = "bubble-policy-prefix";
      prefix.textContent = t("bubbleSecondsPrefix");
      const suffix = document.createElement("span");
      suffix.className = "bubble-policy-unit";
      suffix.textContent = t("bubbleSecondsUnit");
      controls.insertBefore(prefix, sw);
      controls.insertBefore(input, sw);
      controls.insertBefore(suffix, sw);
      secondsInput = input;
      helpers.setTextInputState(input, { disabled: !currentEnabled() });
      input.addEventListener("input", () => {
        const sanitized = input.value.replace(/\D+/g, "").slice(0, 4);
        if (input.value !== sanitized) input.value = sanitized;
        const raw = input.value.trim();
        const next = parseBubbleSecondsInputValue(raw);
        if (next == null) {
          clearSecondsCommitTimer();
          secondsDraftValue = null;
          return;
        }
        if (category === "update" && next === 0) return;
        scheduleSecondsCommit(next);
      });
      input.addEventListener("blur", () => {
        flushSecondsCommit();
      });
      input.addEventListener("change", () => {
        flushSecondsCommit();
      });
    }

    state.mountedControls.bubblePolicyControls.set(stateKey, {
      row: item,
      syncFromSnapshot,
    });
    // Permission row owns two settings keys (the on/off toggle and the
    // autoclose seconds). Register the secondary key against the same row so
    // the diff-based sync loop can resolve either key without remounting.
    if (secondsKey && secondsKey !== stateKey) {
      state.mountedControls.bubblePolicyControls.set(secondsKey, {
        row: item,
        syncFromSnapshot,
      });
    }

    return item;
  }

  function confirmDisableUpdateBubbles() {
    return helpers.showSettingsConfirmModal({
      title: t("updateBubbleDisableConfirmTitle"),
      detail: t("updateBubbleDisableConfirmDetail"),
      actions: [
        { id: "cancel", label: t("updateBubbleDisableConfirmCancel"), tone: "neutral", defaultFocus: true },
        { id: "confirm", label: t("updateBubbleDisableConfirmAction"), tone: "danger" },
      ],
    });
  }

  function commitSecondsValue(input, secondsKey, next, category) {
    const previous = Number(state.snapshot && state.snapshot[secondsKey]) || 0;
    const doCommit = () => {
      return window.settingsAPI.update(secondsKey, next).then((result) => {
        if (!result || result.status !== "ok") {
          input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          return false;
        }
        return true;
      }).catch((err) => {
        input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        return false;
      });
    };
    if (category === "update" && next === 0 && previous !== 0) {
      return confirmDisableUpdateBubbles().then((actionId) => {
        if (actionId === "confirm") return doCommit();
        input.value = String(previous);
        return false;
      });
    }
    return doCommit();
  }

  function parseBubbleSecondsInputValue(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    const next = Number(trimmed);
    if (!Number.isInteger(next) || next < 0 || next > 3600) return null;
    return next;
  }

  function buildVolumeSliderRow() {
    const row = document.createElement("div");
    row.className = "row volume-slider-row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control volume-control">` +
        `<input type="range" class="volume-slider" min="0" max="100" step="1" />` +
        `<span class="volume-readout" aria-hidden="true"></span>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowVolume");
    row.querySelector(".row-desc").textContent = t("rowVolumeDesc");

    const control = row.querySelector(".volume-control");
    const slider = row.querySelector(".volume-slider");
    const readout = row.querySelector(".volume-readout");

    let previewUrl = null;
    let previewAudio = null;

    function applySliderValue(pct) {
      slider.value = String(pct);
      slider.style.setProperty("--volume-fill", `${pct}%`);
      readout.textContent = `${pct}%`;
      const summary = state.mountedControls.soundSummary;
      if (summary && document.body.contains(summary.element) && typeof summary.syncVolumePreview === "function") {
        summary.syncVolumePreview(pct);
      }
    }

    function getSnapshotVolumePct() {
      const v = state.snapshot && typeof state.snapshot.soundVolume === "number"
        ? state.snapshot.soundVolume : 1;
      return Math.round(v * 100);
    }

    function applyDisabledState(muted) {
      control.classList.toggle("disabled", !!muted);
      slider.disabled = !!muted;
      slider.tabIndex = muted ? -1 : 0;
    }

    function playPreview(vol) {
      if (!previewUrl) return;
      if (!previewAudio) previewAudio = new Audio(previewUrl);
      previewAudio.volume = Math.max(0, Math.min(1, vol));
      previewAudio.currentTime = 0;
      previewAudio.play().catch(() => {});
    }

    applySliderValue(getSnapshotVolumePct());
    applyDisabledState(!!(state.snapshot && state.snapshot.soundMuted));

    slider.addEventListener("input", () => {
      applySliderValue(Number(slider.value));
    });

    slider.addEventListener("change", () => {
      const pct = Number(slider.value);
      const vol = pct / 100;
      playPreview(vol);
      window.settingsAPI.update("soundVolume", vol).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          applySliderValue(getSnapshotVolumePct());
        }
      }).catch((err) => {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        applySliderValue(getSnapshotVolumePct());
      });
    });

    window.settingsAPI.getPreviewSoundUrl().then((url) => {
      if (url) previewUrl = url;
    }).catch(() => {});

    state.mountedControls.soundVolume = {
      row,
      syncDisabled() {
        applyDisabledState(!!(state.snapshot && state.snapshot.soundMuted));
      },
      syncValueFromSnapshot() {
        applySliderValue(getSnapshotVolumePct());
      },
      dispose() {
        if (previewAudio) {
          previewAudio.pause();
          previewAudio = null;
        }
      },
    };

    return row;
  }

  // Mirrors TEXT_SCALE_MIN/MAX/STEP in src/text-scale.js (×100). The renderer
  // can't require that module, so keep the two in sync by hand.
  const TEXT_SCALE_UI_MIN = 80;
  const TEXT_SCALE_UI_MAX = 160;
  const TEXT_SCALE_UI_STEP = 5;
  const TEXT_SCALE_UI_DEFAULT = 100;

  function buildTextScaleRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control volume-control text-scale-control">` +
        `<input type="range" class="volume-slider text-scale-slider"` +
          ` min="${TEXT_SCALE_UI_MIN}" max="${TEXT_SCALE_UI_MAX}" step="${TEXT_SCALE_UI_STEP}" />` +
        `<button type="button" class="volume-readout text-scale-readout"></button>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowTextScale");
    row.querySelector(".row-desc").textContent = t("rowTextScaleDesc");

    const slider = row.querySelector(".text-scale-slider");
    const readout = row.querySelector(".text-scale-readout");
    const control = row.querySelector(".text-scale-control");
    readout.title = t("textScaleResetTitle");

    // textScale is per-display; the committed value for the display this
    // window sits on lives main-side, so sync is an IPC round-trip rather
    // than a snapshot read.
    function syncFromContext() {
      if (!window.settingsAPI || typeof window.settingsAPI.getTextScaleContext !== "function") return;
      Promise.resolve(window.settingsAPI.getTextScaleContext()).then((context) => {
        const pct = context && Number.isFinite(Number(context.percent))
          ? Number(context.percent)
          : 100;
        paint(Math.min(TEXT_SCALE_UI_MAX, Math.max(TEXT_SCALE_UI_MIN, Math.round(pct))));
      }).catch(() => {});
    }

    function paint(pct) {
      slider.value = String(pct);
      const fill = ((pct - TEXT_SCALE_UI_MIN) / (TEXT_SCALE_UI_MAX - TEXT_SCALE_UI_MIN)) * 100;
      slider.style.setProperty("--volume-fill", `${fill}%`);
      readout.textContent = `${pct}%`;
    }

    function snapTextScalePct(raw) {
      const n = Number(raw);
      const base = Number.isFinite(n) ? n : TEXT_SCALE_UI_DEFAULT;
      const stepped = TEXT_SCALE_UI_MIN
        + Math.round((base - TEXT_SCALE_UI_MIN) / TEXT_SCALE_UI_STEP) * TEXT_SCALE_UI_STEP;
      return Math.min(TEXT_SCALE_UI_MAX, Math.max(TEXT_SCALE_UI_MIN, stepped));
    }

    // True from the first drag tick until commit (change) or rollback (blur).
    // Context-changed pokes arriving mid-drag must NOT repaint the slider to
    // the committed value — the preview itself triggers such pokes.
    let previewLive = false;

    // Single-flight gate instead of a timer: at most one preview IPC in the
    // air, the freshest dragged value queued behind it.
    let previewInFlight = false;
    let previewQueued = null;
    function sendPreview(pct) {
      if (typeof window.settingsAPI.previewTextScale !== "function") return;
      if (previewInFlight) {
        previewQueued = pct;
        return;
      }
      previewInFlight = true;
      Promise.resolve(window.settingsAPI.previewTextScale(pct / 100))
        .catch(() => {})
        .then(() => {
          previewInFlight = false;
          if (previewQueued !== null) {
            const next = previewQueued;
            previewQueued = null;
            sendPreview(next);
          }
        });
    }

    function rollbackPreview() {
      if (typeof window.settingsAPI.endTextScalePreview !== "function") return;
      Promise.resolve(window.settingsAPI.endTextScalePreview()).catch(() => {});
    }

    function commit(pct) {
      window.settingsAPI.command("setTextScaleForDisplay", { value: pct / 100 }).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          rollbackPreview();
          syncFromContext();
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch(() => {
        rollbackPreview();
        syncFromContext();
      });
    }

    let pointerDrag = null;
    let suppressNativeChange = null;

    function stopNativePointer(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (ev && typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      else if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    }

    function capturePointerDrag(ev) {
      const rect = typeof slider.getBoundingClientRect === "function"
        ? slider.getBoundingClientRect()
        : null;
      const width = rect && Number.isFinite(Number(rect.width)) && Number(rect.width) > 0
        ? Number(rect.width)
        : 240;
      const rectLeft = rect && Number.isFinite(Number(rect.left)) ? Number(rect.left) : 0;
      const screenX = Number(ev && ev.screenX);
      const clientX = Number(ev && ev.clientX);
      const left = Number.isFinite(screenX) && Number.isFinite(clientX)
        ? screenX - (clientX - rectLeft)
        : rectLeft;
      return {
        pointerId: ev && ev.pointerId,
        left,
        width,
      };
    }

    function pointerMatchesDrag(ev) {
      if (!pointerDrag) return false;
      if (pointerDrag.pointerId === undefined || pointerDrag.pointerId === null) return true;
      return ev && ev.pointerId === pointerDrag.pointerId;
    }

    function textScalePctFromPointer(ev) {
      if (!pointerDrag) return Number(slider.value);
      const screenX = Number(ev && ev.screenX);
      const clientX = Number(ev && ev.clientX);
      if (!Number.isFinite(screenX) && !Number.isFinite(clientX)) {
        return snapTextScalePct(slider.value);
      }
      const x = Number.isFinite(screenX)
        ? screenX
        : (Number.isFinite(clientX) ? clientX : pointerDrag.left);
      const normalized = Math.max(0, Math.min(1, (x - pointerDrag.left) / pointerDrag.width));
      return snapTextScalePct(TEXT_SCALE_UI_MIN + normalized * (TEXT_SCALE_UI_MAX - TEXT_SCALE_UI_MIN));
    }

    function previewPointerPct(pct) {
      const nextPct = snapTextScalePct(pct);
      if (Number(slider.value) !== nextPct) {
        paint(nextPct);
        sendPreview(nextPct);
      }
      return nextPct;
    }

    function markNativeChangeSuppressed(pct) {
      suppressNativeChange = { pct: snapTextScalePct(pct), until: Date.now() + 500 };
    }

    function shouldSuppressNativeChange() {
      if (!suppressNativeChange) return false;
      if (Date.now() > suppressNativeChange.until) {
        suppressNativeChange = null;
        return false;
      }
      if (Number(slider.value) === suppressNativeChange.pct) {
        suppressNativeChange = null;
        return true;
      }
      return false;
    }

    function beginPointerDrag(ev) {
      if (ev && ev.isPrimary === false) return;
      if (ev && ev.button !== undefined && ev.button !== 0) return;
      pointerDrag = capturePointerDrag(ev);
      previewLive = true;
      if (control) control.classList.add("dragging");
      try {
        if (typeof slider.focus === "function") slider.focus({ preventScroll: true });
        if (typeof slider.setPointerCapture === "function" && ev && ev.pointerId !== undefined) {
          slider.setPointerCapture(ev.pointerId);
        }
      } catch {}
      stopNativePointer(ev);
      previewPointerPct(textScalePctFromPointer(ev));
    }

    function movePointerDrag(ev) {
      if (!pointerMatchesDrag(ev)) return;
      stopNativePointer(ev);
      previewPointerPct(textScalePctFromPointer(ev));
    }

    function finishPointerDrag(ev, { commitValue }) {
      if (!pointerMatchesDrag(ev)) return false;
      stopNativePointer(ev);
      const finalPct = previewPointerPct(textScalePctFromPointer(ev));
      try {
        if (typeof slider.releasePointerCapture === "function" && pointerDrag.pointerId !== undefined) {
          slider.releasePointerCapture(pointerDrag.pointerId);
        }
      } catch {}
      pointerDrag = null;
      if (control) control.classList.remove("dragging");
      previewLive = false;
      if (commitValue) {
        markNativeChangeSuppressed(finalPct);
        commit(finalPct);
      } else {
        rollbackPreview();
        syncFromContext();
      }
      return true;
    }

    slider.addEventListener("pointerdown", beginPointerDrag);
    slider.addEventListener("pointermove", movePointerDrag);
    slider.addEventListener("pointerup", (ev) => {
      finishPointerDrag(ev, { commitValue: true });
    });
    slider.addEventListener("pointercancel", (ev) => {
      finishPointerDrag(ev, { commitValue: false });
    });
    slider.addEventListener("input", () => {
      if (pointerDrag) return;
      previewLive = true;
      const pct = snapTextScalePct(slider.value);
      paint(pct);
      sendPreview(pct);
    });
    slider.addEventListener("change", () => {
      if (shouldSuppressNativeChange()) return;
      previewLive = false;
      commit(snapTextScalePct(slider.value));
    });
    slider.addEventListener("blur", () => {
      if (pointerDrag) return;
      // A real edit already committed via change (which clears the preview in
      // the main process); this only rolls back an abandoned preview.
      previewLive = false;
      rollbackPreview();
    });
    readout.addEventListener("click", () => {
      paint(TEXT_SCALE_UI_DEFAULT);
      commit(TEXT_SCALE_UI_DEFAULT);
    });

    // The window landed on a display with a different committed value (drag
    // across screens, topology change) — re-pull. No store change happens in
    // that case, so the settings-changed broadcast can't cover it.
    const unsubscribeContextChanged =
      window.settingsAPI && typeof window.settingsAPI.onTextScaleContextChanged === "function"
        ? window.settingsAPI.onTextScaleContextChanged(() => {
            if (!previewLive) syncFromContext();
          })
        : null;

    paint(TEXT_SCALE_UI_DEFAULT);
    syncFromContext();

    state.mountedControls.textScale = {
      row,
      syncValueFromSnapshot() {
        syncFromContext();
      },
      dispose() {
        if (typeof unsubscribeContextChanged === "function") unsubscribeContextChanged();
        rollbackPreview();
      },
    };

    return row;
  }

  // = prefsSizeToUi(9): the prefs `size` default is "P:9" (see src/prefs.js).
  const SIZE_UI_DEFAULT = 30;

  function buildSizeSliderRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control volume-control size-control">` +
        `<input type="range" class="volume-slider size-slider" min="${helpers.SIZE_UI_MIN}" max="${helpers.SIZE_UI_MAX}" step="1" />` +
        `<button type="button" class="volume-readout text-scale-readout size-readout"></button>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowSize");
    row.querySelector(".row-desc").textContent = t("rowSizeDesc");

    const control = row.querySelector(".size-control");
    const slider = row.querySelector(".size-slider");
    const readout = row.querySelector(".size-readout");
    readout.title = t("rowSizeResetTitle");

    function applyLocalValue(ui) {
      const pct = helpers.sizeUiToPct(ui);
      slider.value = String(ui);
      slider.style.setProperty("--volume-fill", `${pct}%`);
      readout.textContent = `${ui}%`;
    }

    function setDragging(nextDragging, pending = state.transientUiState.size.pending) {
      control.classList.toggle("dragging", !!nextDragging);
      control.classList.toggle("pending", !!pending);
    }

    const initial =
      state.transientUiState.size.draftUi === null ? readers.readSizeUiFromSnapshot() : state.transientUiState.size.draftUi;
    applyLocalValue(initial);
    setDragging(state.transientUiState.size.dragging, state.transientUiState.size.pending);

    const controller = helpers.createSizeSliderController({
      readSnapshotUi: readers.readSizeUiFromSnapshot,
      settingsAPI: window.settingsAPI,
      onLocalValue: (ui) => {
        state.transientUiState.size.draftUi = ui;
        applyLocalValue(ui);
      },
      onDraggingChange: (dragging, pending) => {
        state.transientUiState.size.dragging = dragging;
        state.transientUiState.size.pending = pending;
        setDragging(dragging, pending);
      },
      onError: (message) => {
        state.transientUiState.size.draftUi = null;
        applyLocalValue(readers.readSizeUiFromSnapshot());
        if (message) ops.showToast(t("toastSaveFailed") + message, { error: true });
      },
    });

    state.mountedControls.size = {
      row,
      syncFromSnapshot: (options) => controller.syncFromSnapshot(options),
      dispose: () => controller.dispose(),
    };
    controller.syncFromSnapshot();

    slider.addEventListener("pointerdown", () => { void controller.pointerDown(); });
    slider.addEventListener("pointerup", () => { void controller.pointerUp(); });
    slider.addEventListener("pointercancel", () => { void controller.pointerCancel(); });
    slider.addEventListener("blur", () => { void controller.blur(); });
    slider.addEventListener("input", () => {
      void controller.input(Number(slider.value));
    });
    slider.addEventListener("change", () => {
      void controller.change(Number(slider.value));
    });
    readout.addEventListener("click", () => {
      void controller.change(SIZE_UI_DEFAULT);
    });

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
    meta.element.classList.toggle("disabled", !!disabled);
    if (disabled) {
      meta.element.setAttribute("aria-disabled", "true");
      meta.element.tabIndex = -1;
    } else {
      meta.element.removeAttribute("aria-disabled");
      meta.element.tabIndex = 0;
    }
    return true;
  }

  function syncSessionHudChildSwitchesDisabled() {
    const disabled = !(state.snapshot && state.snapshot.sessionHudEnabled);
    for (const key of SESSION_HUD_CHILD_SWITCH_KEYS) {
      if (!setGeneralSwitchDisabled(key, disabled)) return false;
    }
    return true;
  }

  function syncMacAppPresenceSwitchesDisabled() {
    if (!i18n || !i18n.IS_MAC) return false;
    const tray = getMountedGeneralSwitch("showTray");
    const dock = getMountedGeneralSwitch("showDock");
    if (!tray || !dock) return false;
    const showTray = !!(state.snapshot && state.snapshot.showTray);
    const showDock = !!(state.snapshot && state.snapshot.showDock);
    return setGeneralSwitchDisabled("showTray", showTray && !showDock)
      && setGeneralSwitchDisabled("showDock", showDock && !showTray);
  }

  function getMountedRoamMovementStyle() {
    const control = state.mountedControls.roamMovementStyle;
    if (!control || !document.body.contains(control.element)) return null;
    return control;
  }

  function syncRoamMovementStyleFromSnapshot() {
    const control = getMountedRoamMovementStyle();
    if (!control) return false;
    control.setValue(readRoamMovementStyle());
    control.setDisabled(!(state.snapshot && state.snapshot.freeRoam === true));
    return true;
  }

  function hasMountedBubblePolicyControls() {
    const summaryControl = state.mountedControls.bubblePolicySummary;
    if (!summaryControl || !document.body.contains(summaryControl.element)) return false;
    for (const key of BUBBLE_POLICY_KEYS) {
      const meta = state.mountedControls.bubblePolicyControls.get(key);
      if (!meta || !document.body.contains(meta.row)) return false;
    }
    return true;
  }

  function syncBubblePolicyControlsFromSnapshot() {
    if (!hasMountedBubblePolicyControls()) return false;
    for (const key of BUBBLE_POLICY_KEYS) {
      state.mountedControls.bubblePolicyControls.get(key).syncFromSnapshot();
    }
    state.mountedControls.bubblePolicySummary.syncFromSnapshot();
    return true;
  }

  function getMountedBubblePlacement() {
    const meta = state.mountedControls.bubblePlacement;
    if (!meta || !document.body.contains(meta.element)) return null;
    return meta;
  }

  function syncBubblePlacementFromSnapshot() {
    const meta = getMountedBubblePlacement();
    if (!meta) return false;
    meta.syncFromSnapshot();
    return true;
  }

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("size") && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
    if (keys.includes("textScale") || keys.includes("textScaleByDisplay")) {
      const tc = state.mountedControls.textScale;
      if (!tc || !document.body.contains(tc.row)) return false;
    }
    if (keys.includes("soundVolume") || keys.includes("soundMuted")) {
      const vc = state.mountedControls.soundVolume;
      if (!vc || !document.body.contains(vc.row)) return false;
      const summary = state.mountedControls.soundSummary;
      if (!summary || !document.body.contains(summary.element)) return false;
    }
    if (keys.includes("sessionHudEnabled")
      && !SESSION_HUD_CHILD_SWITCH_KEYS.every((key) => getMountedGeneralSwitch(key))) {
      return false;
    }
    if (keys.some((key) => key === "showTray" || key === "showDock")
      && (!i18n || !i18n.IS_MAC
        || !getMountedGeneralSwitch("showTray")
        || !getMountedGeneralSwitch("showDock"))) {
      return false;
    }
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !getMountedRoamMovementStyle()) {
      return false;
    }
    if (keys.includes("quotaRingDisplayMode")) {
      const control = state.mountedControls.quotaRingDisplayMode;
      if (!control || !document.body.contains(control.element)) return false;
    }
    if (keys.includes("permissionAutomationMode")) {
      const control = state.mountedControls.permissionAutomationMode;
      if (!control || !document.body.contains(control.element)) return false;
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !hasMountedBubblePolicyControls()) {
      return false;
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_PLACEMENT_KEYS.has(key)))
      && !getMountedBubblePlacement()) {
      return false;
    }
    if (keys.some((key) => SESSION_CLEANUP_NUMBER_KEYS.has(key))) {
      for (const key of keys) {
        if (!SESSION_CLEANUP_NUMBER_KEYS.has(key)) continue;
        const meta = state.mountedControls.sessionCleanupControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
      }
    }
    if (keys.some((key) => FLASH_NUMBER_KEYS.has(key))) {
      for (const key of keys) {
        if (!FLASH_NUMBER_KEYS.has(key)) continue;
        const meta = state.mountedControls.sessionCleanupControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
      }
    }
    for (const key of keys) {
      if (key === "size" || key === "soundVolume" || key === "textScale" || key === "textScaleByDisplay") continue;
      if (key === "quotaRingDisplayMode") continue;
      if (key === "permissionAutomationMode"
        || key === "permissionAutomationAutoToolsWarningDismissed"
        || key === "permissionAutomationUnattendedWarningDismissed") continue;
      if (BUBBLE_POLICY_KEYS.has(key)) {
        const meta = state.mountedControls.bubblePolicyControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
        continue;
      }
      if (BUBBLE_PLACEMENT_KEYS.has(key)) continue;
      if (SESSION_CLEANUP_NUMBER_KEYS.has(key)) continue;
      if (FLASH_NUMBER_KEYS.has(key)) continue;
      if (key === "roamConstrainAxis") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      if (key === "quotaRingDisplayMode") {
        state.mountedControls.quotaRingDisplayMode.setValue(
          state.snapshot && state.snapshot.quotaRingDisplayMode
        );
        continue;
      }
      if (key === "permissionAutomationMode") {
        state.mountedControls.permissionAutomationMode.syncFromSnapshot();
        continue;
      }
      if (key === "permissionAutomationAutoToolsWarningDismissed"
        || key === "permissionAutomationUnattendedWarningDismissed") continue;
      if (key === "textScale" || key === "textScaleByDisplay") {
        state.mountedControls.textScale.syncValueFromSnapshot();
        continue;
      }
      if (key === "soundVolume") {
        state.mountedControls.soundVolume.syncValueFromSnapshot();
        continue;
      }
      if (BUBBLE_POLICY_KEYS.has(key)) {
        state.mountedControls.bubblePolicyControls.get(key).syncFromSnapshot();
        continue;
      }
      if (BUBBLE_PLACEMENT_KEYS.has(key)) continue;
      if (SESSION_CLEANUP_NUMBER_KEYS.has(key)) {
        state.mountedControls.sessionCleanupControls.get(key).syncFromSnapshot();
        continue;
      }
      if (FLASH_NUMBER_KEYS.has(key)) {
        state.mountedControls.sessionCleanupControls.get(key).syncFromSnapshot();
        continue;
      }
      if (key === "roamConstrainAxis") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      helpers.setSwitchVisual(meta.element, readers.readGeneralSwitchVisual(key, meta.invert), { pending: false });
      if (key === "soundMuted") {
        state.mountedControls.soundVolume.syncDisabled();
      }
    }
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !syncRoamMovementStyleFromSnapshot()) return false;
    if (keys.includes("sessionHudEnabled") && !syncSessionHudChildSwitchesDisabled()) return false;
    if (keys.some((key) => key === "showTray" || key === "showDock")
      && !syncMacAppPresenceSwitchesDisabled()) return false;
    if (keys.some((key) => SESSION_HUD_SUMMARY_KEYS.has(key))) {
      const summary = state.mountedControls.sessionHudSummary;
      if (summary && document.body.contains(summary.element)) summary.syncFromSnapshot();
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !syncBubblePolicyControlsFromSnapshot()) return false;
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_PLACEMENT_KEYS.has(key)))
      && !syncBubblePlacementFromSnapshot()) return false;
    if ((keys.includes("soundVolume") || keys.includes("soundMuted"))
      && state.mountedControls.soundSummary
      && document.body.contains(state.mountedControls.soundSummary.element)) {
      state.mountedControls.soundSummary.syncFromSnapshot();
    }
    return true;
  }

  function init(core) {
    state = core.state;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.general = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabGeneral = { init };
})(globalThis);
