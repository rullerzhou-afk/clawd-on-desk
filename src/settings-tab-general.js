"use strict";

(function initSettingsTabGeneral(root) {
  const GENERAL_IN_PLACE_KEYS = new Set([
    "size",
    "soundMuted",
    "soundVolume",
    "lowPowerIdleMode",
    "sessionHudEnabled",
    "sessionHudShowElapsed",
    "sessionHudCleanupDetached",
    "sessionHudAutoHide",
    "allowEdgePinning",
    "keepSizeAcrossDisplays",
    "manageClaudeHooksAutomatically",
    "openAtLogin",
    "autoStartWithClaude",
    "hideBubbles",
    "bubbleFollowPet",
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const BUBBLE_POLICY_KEYS = new Set([
    "permissionBubblesEnabled",
    "permissionBubbleAutoCloseSeconds",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const SESSION_HUD_CHILD_SWITCH_KEYS = [
    "sessionHudShowElapsed",
    "sessionHudCleanupDetached",
    "sessionHudAutoHide",
  ];
  const SESSION_HUD_SUMMARY_KEYS = new Set([
    "sessionHudEnabled",
    "sessionHudShowElapsed",
    "sessionHudAutoHide",
    "sessionHudCleanupDetached",
  ]);
  const CLAUDE_HOOK_MANAGEMENT_CHILD_SWITCH_KEYS = [
    "autoStartWithClaude",
  ];
  const BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS = 600;

  let state = null;
  let runtime = null;
  let readers = null;
  let helpers = null;
  let ops = null;

  const LANGUAGE_OPTIONS = ["en", "zh", "zh-TW", "ko", "ja"];

  function t(key) {
    return helpers.t(key);
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("settingsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("settingsSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("sectionAppearance"), [
      buildLanguageRow(),
      buildSizeSliderRow(),
      buildSessionHudGroup(),
      buildDashboardRow(),
      buildSoundGroup(),
      helpers.buildSwitchRow({
        key: "lowPowerIdleMode",
        labelKey: "rowLowPowerIdleMode",
        descKey: "rowLowPowerIdleModeDesc",
      }),
      helpers.buildSwitchRow({
        key: "allowEdgePinning",
        labelKey: "rowAllowEdgePinning",
        descKey: "rowAllowEdgePinningDesc",
      }),
      helpers.buildSwitchRow({
        key: "keepSizeAcrossDisplays",
        labelKey: "rowKeepSizeAcrossDisplays",
        descKey: "rowKeepSizeAcrossDisplaysDesc",
      }),
    ]));

    const manageClaudeHooksEnabled = !!(state.snapshot && state.snapshot.manageClaudeHooksAutomatically);
    parent.appendChild(helpers.buildSection(t("sectionStartup"), [
      helpers.buildSwitchRow({
        key: "manageClaudeHooksAutomatically",
        labelKey: "rowManageClaudeHooks",
        descKey: "rowManageClaudeHooksDesc",
        descExtraKey: "rowManageClaudeHooksOffNote",
        onToggle: ({ nextRaw }) => confirmDisableClaudeHookManagement(nextRaw),
        actionButton: {
          labelKey: "actionDisconnectClaudeHooks",
          invoke: () => runDisconnectClaudeHooks(),
        },
      }),
      helpers.buildSwitchRow({
        key: "openAtLogin",
        labelKey: "rowOpenAtLogin",
        descKey: "rowOpenAtLoginDesc",
      }),
      helpers.buildSwitchRow({
        key: "autoStartWithClaude",
        labelKey: "rowStartWithClaude",
        descKey: "rowStartWithClaudeDesc",
        descExtraKey: manageClaudeHooksEnabled ? null : "rowStartWithClaudeDisabledDesc",
        disabled: !manageClaudeHooksEnabled,
      }),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionBubbles"), [
      helpers.buildSwitchRow({
        key: "hideBubbles",
        labelKey: "rowHideBubbles",
        descKey: "rowHideBubblesDesc",
        onToggle: ({ nextRaw }) => window.settingsAPI.command("setAllBubblesHidden", { hidden: nextRaw }),
      }),
      buildBubblePolicyRow(),
      helpers.buildSwitchRow({
        key: "bubbleFollowPet",
        labelKey: "rowBubbleFollow",
        descKey: "rowBubbleFollowDesc",
      }),
    ]));
  }

  function confirmDisableClaudeHookManagement(nextRaw) {
    if (nextRaw) return window.settingsAPI.update("manageClaudeHooksAutomatically", true);
    return showClaudeHooksDisableConfirmModal().then((actionId) => {
      if (!actionId || actionId === "keep") return { status: "ok", noop: true };
      if (actionId === "disconnect") return window.settingsAPI.command("uninstallHooks");
      return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
    });
  }

  function runDisconnectClaudeHooks() {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      return Promise.resolve({ status: "error", message: "settings API unavailable" });
    }
    return showClaudeHooksDisconnectConfirmModal().then((actionId) => {
      if (actionId !== "disconnect") return { status: "ok", noop: true };
      return window.settingsAPI.command("uninstallHooks");
    });
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
        `<div class="language-picker">` +
          `<button type="button" class="language-picker-trigger" aria-haspopup="listbox" aria-expanded="false">` +
            `<span class="language-picker-value"></span>` +
            `<span class="language-picker-chevron" aria-hidden="true"></span>` +
          `</button>` +
          `<div class="language-picker-menu" role="listbox" aria-hidden="true"></div>` +
        `</div>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowLanguage");
    row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
    const picker = row.querySelector(".language-picker");
    const trigger = row.querySelector(".language-picker-trigger");
    const valueEl = row.querySelector(".language-picker-value");
    const menu = row.querySelector(".language-picker-menu");
    trigger.setAttribute("aria-label", t("rowLanguage"));
    const currentLang = readers.getLang();
    let activeLang = currentLang;
    const getLabel = (lang) => t(LANGUAGE_LABEL_KEYS[lang] || "langEnglish");
    const options = [];
    for (const lang of LANGUAGE_OPTIONS) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "language-picker-option";
      option.setAttribute("role", "option");
      option.setAttribute("data-lang", lang);
      option.setAttribute("aria-selected", lang === currentLang ? "true" : "false");
      option.textContent = getLabel(lang);
      menu.appendChild(option);
      options.push(option);
    }
    function getOption(lang) {
      return options.find((option) => option.dataset.lang === lang) || options[0] || null;
    }
    function syncDisplay(lang) {
      const selectedLang = LANGUAGE_OPTIONS.includes(lang) ? lang : LANGUAGE_OPTIONS[0];
      activeLang = selectedLang;
      valueEl.textContent = getLabel(selectedLang);
      const open = picker.classList.contains("open");
      for (const option of options) {
        const selected = option.dataset.lang === selectedLang;
        option.classList.toggle("selected", selected);
        option.setAttribute("aria-selected", selected ? "true" : "false");
        option.tabIndex = open && selected ? 0 : -1;
      }
    }
    function setOpen(open) {
      picker.classList.toggle("open", open);
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      menu.setAttribute("aria-hidden", open ? "false" : "true");
      syncDisplay(activeLang);
      if (!open) return;
      const option = getOption(activeLang);
      if (option && typeof option.focus === "function") option.focus();
    }
    function chooseLanguage(next) {
      if (next === activeLang) {
        setOpen(false);
        return;
      }
      if (next === readers.getLang()) {
        syncDisplay(next);
        setOpen(false);
        return;
      }
      syncDisplay(next);
      setOpen(false);
      const revertIfStillPending = () => {
        if (activeLang === next) syncDisplay(readers.getLang());
      };
      window.settingsAPI.update("lang", next).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          revertIfStillPending();
        }
      }).catch((err) => {
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        revertIfStillPending();
      });
    }
    trigger.addEventListener("click", () => {
      setOpen(!picker.classList.contains("open"));
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
    });
    for (const option of options) {
      option.addEventListener("click", () => chooseLanguage(option.dataset.lang));
      option.addEventListener("keydown", (event) => {
        const index = options.indexOf(option);
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          if (typeof trigger.focus === "function") trigger.focus();
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          chooseLanguage(option.dataset.lang);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const nextOption = options[(index + delta + options.length) % options.length];
          if (nextOption && typeof nextOption.focus === "function") nextOption.focus();
        }
      });
    }
    const closeOnOutsideClick = (event) => {
      if (!picker.classList.contains("open")) return;
      if (picker.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || !picker.classList.contains("open")) return;
      event.preventDefault();
      setOpen(false);
    };
    if (document && typeof document.addEventListener === "function") {
      document.addEventListener("click", closeOnOutsideClick);
      document.addEventListener("keydown", closeOnEscape);
      state.mountedControls.languagePicker = {
        dispose: () => {
          if (typeof document.removeEventListener === "function") {
            document.removeEventListener("click", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
          }
        },
      };
    }
    syncDisplay(currentLang);
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
        key: "sessionHudShowElapsed",
        labelKey: "rowSessionHudElapsed",
        descKey: "rowSessionHudElapsedDesc",
        disabled: !sessionHudControlsEnabled,
      }),
      helpers.buildSwitchRow({
        key: "sessionHudAutoHide",
        labelKey: "rowSessionHudAutoHide",
        descKey: "rowSessionHudAutoHideDesc",
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
      const items = [{
        text: t("sessionHudSummaryEnabled").replace("{state}", enabled ? onLabel : offLabel),
        accent: enabled,
      }];
      if (enabled) {
        items.push({
          text: t("sessionHudSummaryElapsed").replace(
            "{state}",
            snapshot.sessionHudShowElapsed !== false ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudShowElapsed !== false,
        });
        items.push({
          text: t("sessionHudSummaryAutoHide").replace(
            "{state}",
            snapshot.sessionHudAutoHide === true ? onLabel : offLabel
          ),
          accent: snapshot.sessionHudAutoHide === true,
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
      if (secondsInput) secondsInput.disabled = !enabled || pending;
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
      const input = document.createElement("input");
      input.type = "text";
      input.className = "bubble-policy-seconds";
      input.inputMode = "numeric";
      input.maxLength = 4;
      input.pattern = "[0-9]*";
      input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
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
      input.disabled = !currentEnabled();
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
      input.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        flushSecondsCommit();
        input.blur();
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
    return showSettingsConfirmModal({
      title: t("updateBubbleDisableConfirmTitle"),
      detail: t("updateBubbleDisableConfirmDetail"),
      actions: [
        { id: "confirm", label: t("updateBubbleDisableConfirmAction"), tone: "danger" },
        { id: "cancel", label: t("updateBubbleDisableConfirmCancel"), tone: "accent", defaultFocus: true },
      ],
    });
  }

  function showClaudeHooksDisableConfirmModal() {
    return showSettingsConfirmModal({
      title: t("claudeHooksDisableConfirmTitle"),
      detail: t("claudeHooksDisableConfirmDetail"),
      actions: [
        { id: "disconnect", label: t("claudeHooksDisableConfirmDisconnect"), tone: "danger" },
        { id: "disable", label: t("claudeHooksDisableConfirmDisableOnly"), tone: "neutral" },
        { id: "keep", label: t("claudeHooksDisableConfirmKeep"), tone: "accent", defaultFocus: true },
      ],
    });
  }

  function showClaudeHooksDisconnectConfirmModal() {
    return showSettingsConfirmModal({
      title: t("claudeHooksDisconnectConfirmTitle"),
      detail: t("claudeHooksDisconnectConfirmDetail"),
      actions: [
        { id: "disconnect", label: t("claudeHooksDisconnectConfirmAction"), tone: "danger" },
        { id: "keep", label: t("claudeHooksDisconnectConfirmKeep"), tone: "accent", defaultFocus: true },
      ],
    });
  }

  function showSettingsConfirmModal({ title, detail, actions }) {
    const rootNode = document.getElementById("modalRoot");
    if (!rootNode) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const overlay = document.createElement("div");
      overlay.className = "modal-backdrop settings-confirm-backdrop";

      const modal = document.createElement("div");
      modal.className = "settings-confirm-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");

      const icon = document.createElement("div");
      icon.className = "settings-confirm-icon";
      icon.textContent = "!";

      const titleNode = document.createElement("h2");
      titleNode.textContent = title;

      const detailNode = document.createElement("p");
      detailNode.textContent = detail;

      const actionsNode = document.createElement("div");
      actionsNode.className = "settings-confirm-actions";

      function close(actionId) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown, true);
        rootNode.innerHTML = "";
        resolve(actionId);
      }

      function onKeyDown(ev) {
        if (ev.key === "Escape") close(null);
      }

      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) close(null);
      });
      const buttons = (Array.isArray(actions) ? actions : []).map((action) => {
        const button = document.createElement("button");
        const tone = action && typeof action.tone === "string" ? action.tone : "neutral";
        const toneClass = tone === "accent"
          ? "accent"
          : (tone === "danger" ? "settings-confirm-danger" : "");
        button.type = "button";
        button.className = `soft-btn${toneClass ? ` ${toneClass}` : ""}`;
        button.textContent = action && action.label ? action.label : "";
        button.addEventListener("click", () => close(action && action.id ? action.id : null));
        actionsNode.appendChild(button);
        return { action, button };
      });
      document.addEventListener("keydown", onKeyDown, true);
      modal.appendChild(icon);
      modal.appendChild(titleNode);
      modal.appendChild(detailNode);
      modal.appendChild(actionsNode);
      overlay.appendChild(modal);
      rootNode.innerHTML = "";
      rootNode.appendChild(overlay);
      const focusTarget =
        buttons.find((action) => action.action && action.action.defaultFocus)
        || buttons[buttons.length - 1]
        || null;
      if (focusTarget) focusTarget.button.focus();
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
    row.className = "row";
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

  function buildSizeSliderRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control size-control">` +
        `<div class="size-slider-wrap">` +
          `<div class="size-bubble"></div>` +
          `<input type="range" class="size-slider" min="${helpers.SIZE_UI_MIN}" max="${helpers.SIZE_UI_MAX}" step="1" />` +
        `</div>` +
        `<div class="size-ticks"></div>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowSize");
    row.querySelector(".row-desc").textContent = t("rowSizeDesc");

    const control = row.querySelector(".size-control");
    const sliderWrap = row.querySelector(".size-slider-wrap");
    const slider = row.querySelector(".size-slider");
    const bubble = row.querySelector(".size-bubble");
    const ticksEl = row.querySelector(".size-ticks");
    const tickMarks = [];

    function readThumbDiameterPx() {
      const raw = window.getComputedStyle(slider).getPropertyValue("--size-slider-thumb-diameter");
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : helpers.SIZE_SLIDER_THUMB_DIAMETER;
    }

    function getSliderAnchorPx(ui) {
      return helpers.getSizeSliderAnchorPx({
        value: ui,
        min: helpers.SIZE_UI_MIN,
        max: helpers.SIZE_UI_MAX,
        sliderWidth: slider.clientWidth,
        thumbDiameter: readThumbDiameterPx(),
      });
    }

    function repositionScaleGeometry(ui) {
      const anchorPx = getSliderAnchorPx(ui);
      bubble.style.left = `${anchorPx}px`;
      for (const tick of tickMarks) {
        tick.element.style.left = `${getSliderAnchorPx(tick.value)}px`;
      }
    }

    function applyLocalValue(ui) {
      const pct = helpers.sizeUiToPct(ui);
      slider.value = String(ui);
      slider.style.setProperty("--size-fill", `${pct}%`);
      bubble.textContent = `${ui}%`;
      repositionScaleGeometry(ui);
    }

    function setDragging(nextDragging, pending = state.transientUiState.size.pending) {
      control.classList.toggle("dragging", !!nextDragging);
      control.classList.toggle("pending", !!pending);
    }

    const initial =
      state.transientUiState.size.draftUi === null ? readers.readSizeUiFromSnapshot() : state.transientUiState.size.draftUi;
    applyLocalValue(initial);
    setDragging(state.transientUiState.size.dragging, state.transientUiState.size.pending);

    for (const v of helpers.SIZE_TICK_VALUES) {
      const mark = document.createElement("span");
      mark.className = "size-tick";
      mark.dataset.value = String(v);
      const dot = document.createElement("span");
      dot.className = "size-tick-dot";
      const label = document.createElement("span");
      label.className = "size-tick-label";
      label.textContent = String(v);
      mark.appendChild(dot);
      mark.appendChild(label);
      ticksEl.appendChild(mark);
      tickMarks.push({ value: v, element: mark });
    }

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
      dispose: () => {
        if (resizeObserver) resizeObserver.disconnect();
        window.removeEventListener("resize", handleGeometryRefresh);
        return controller.dispose();
      },
    };
    controller.syncFromSnapshot();

    function handleGeometryRefresh() {
      const currentUi =
        state.transientUiState.size.draftUi === null ? readers.readSizeUiFromSnapshot() : state.transientUiState.size.draftUi;
      repositionScaleGeometry(currentUi);
    }

    let resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        handleGeometryRefresh();
      });
      resizeObserver.observe(sliderWrap);
    }
    window.addEventListener("resize", handleGeometryRefresh);
    handleGeometryRefresh();

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

  function setGeneralSwitchExtraDesc(key, descExtraKey) {
    const meta = getMountedGeneralSwitch(key);
    if (!meta || !meta.text) return false;
    if (descExtraKey) {
      if (!meta.extraElement) {
        meta.extraElement = document.createElement("span");
        meta.extraElement.className = "row-desc row-desc-extra";
        meta.text.appendChild(meta.extraElement);
      }
      meta.extraElement.textContent = t(descExtraKey);
      return true;
    }
    if (meta.extraElement) {
      meta.extraElement.remove();
      meta.extraElement = null;
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

  function syncClaudeHookManagementChildSwitchesDisabled() {
    const disabled = !(state.snapshot && state.snapshot.manageClaudeHooksAutomatically);
    for (const key of CLAUDE_HOOK_MANAGEMENT_CHILD_SWITCH_KEYS) {
      if (!setGeneralSwitchDisabled(key, disabled)) return false;
    }
    return setGeneralSwitchExtraDesc(
      "autoStartWithClaude",
      disabled ? "rowStartWithClaudeDisabledDesc" : null
    );
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

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("size") && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
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
    if (keys.includes("manageClaudeHooksAutomatically")
      && !CLAUDE_HOOK_MANAGEMENT_CHILD_SWITCH_KEYS.every((key) => getMountedGeneralSwitch(key))) {
      return false;
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !hasMountedBubblePolicyControls()) {
      return false;
    }
    for (const key of keys) {
      if (key === "size" || key === "soundVolume") continue;
      if (BUBBLE_POLICY_KEYS.has(key)) {
        const meta = state.mountedControls.bubblePolicyControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
        continue;
      }
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      if (key === "soundVolume") {
        state.mountedControls.soundVolume.syncValueFromSnapshot();
        continue;
      }
      if (BUBBLE_POLICY_KEYS.has(key)) {
        state.mountedControls.bubblePolicyControls.get(key).syncFromSnapshot();
        continue;
      }
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      helpers.setSwitchVisual(meta.element, readers.readGeneralSwitchVisual(key, meta.invert), { pending: false });
      if (key === "soundMuted") {
        state.mountedControls.soundVolume.syncDisabled();
      }
    }
    if (keys.includes("sessionHudEnabled") && !syncSessionHudChildSwitchesDisabled()) return false;
    if (keys.some((key) => SESSION_HUD_SUMMARY_KEYS.has(key))) {
      const summary = state.mountedControls.sessionHudSummary;
      if (summary && document.body.contains(summary.element)) summary.syncFromSnapshot();
    }
    if (keys.includes("manageClaudeHooksAutomatically")
      && !syncClaudeHookManagementChildSwitchesDisabled()) return false;
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !syncBubblePolicyControlsFromSnapshot()) return false;
    if ((keys.includes("soundVolume") || keys.includes("soundMuted"))
      && state.mountedControls.soundSummary
      && document.body.contains(state.mountedControls.soundSummary.element)) {
      state.mountedControls.soundSummary.syncFromSnapshot();
    }
    return true;
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.general = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabGeneral = { init };
})(globalThis);
