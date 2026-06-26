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
    "soundVolume",
    "lowPowerIdleMode",
    "keepAwakeWhileWorking",
    "sessionHudEnabled",
    "sessionHudShowStateLabels",
    "sessionHudShowElapsed",
    "sessionHudShowContextUsage",
    "sessionHudCleanupDetached",
    "allowEdgePinning",
    "disableMiniMode",
    "freeRoam",
    "keepSizeAcrossDisplays",
    "openAtLogin",
    "hideBubbles",
    "bubbleFollowPet",
    "permissionBubblesEnabled",
    "autoApproveAllPermissions",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
    "sessionStaleMs",
    "workingStaleMs",
    "detachedIdleStaleMs",
  ]);
  const BUBBLE_POLICY_KEYS = new Set([
    "permissionBubblesEnabled",
    "permissionBubbleAutoCloseSeconds",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const SESSION_CLEANUP_NUMBER_KEYS = new Set([
    "sessionStaleMs",
    "workingStaleMs",
    "detachedIdleStaleMs",
  ]);
  const FLASH_NUMBER_KEYS = new Set([
    "flashIntervalMs",
    "flashDurationMs",
  ]);
  const SESSION_CLEANUP_DEFAULTS = {
    sessionStaleMs: 600_000,
    workingStaleMs: 300_000,
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

  let state = null;
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
      buildSessionCleanupGroup(),
      buildDashboardRow(),
    ]));

    // Alerts & feedback: every way the pet gets your attention — sound, screen
    // flash, and the bubble preferences (visibility, auto-close policy, follow).
    parent.appendChild(helpers.buildSection(t("sectionAlerts"), [
      buildSoundGroup(),
      buildFlashGroup(),
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

    // Behavior & position: how the pet moves and sits on screen. Rarely changed
    // after first setup, so it sits below the everyday sections.
    parent.appendChild(helpers.buildSection(t("sectionBehavior"), [
      helpers.buildSwitchRow({
        key: "freeRoam",
        labelKey: "rowFreeRoam",
        descKey: "rowFreeRoamDesc",
      }),
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
    ]));

    // System & startup: machine-level toggles (low-power idle throttling and
    // blocking OS sleep while working) plus launch-at-login. Set-once, near bottom.
    parent.appendChild(helpers.buildSection(t("sectionSystemStartup"), [
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

    // Permissions is kept last so the danger toggle (auto-approve everything)
    // sits at the bottom, away from everyday settings.
    parent.appendChild(helpers.buildSection(t("sectionPermissions"), [
      helpers.buildSwitchRow({
        key: "autoApproveAllPermissions",
        labelKey: "rowAutoApproveAll",
        descKey: "rowAutoApproveAllDesc",
        danger: true,
        onToggle: ({ nextRaw }) => confirmAutoApproveAll(nextRaw),
      }),
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

  // DANGER "auto-pilot": enabling auto-approves every agent permission request
  // (Bash, file writes, rm — everything) with no prompt. Gate the ENABLE path
  // behind a destructive confirm; disabling is always safe and immediate.
  function confirmAutoApproveAll(nextRaw) {
    // Route through the setAutoApproveAll command (not settings:update, which
    // now rejects this key). Enabling carries confirmed:true only after the
    // user accepts the danger modal, so the confirmation is a real gate.
    if (!nextRaw) return window.settingsAPI.command("setAutoApproveAll", { enabled: false });
    return showAutoApproveAllConfirmModal().then((actionId) => {
      if (actionId !== "enable") return { status: "ok", noop: true };
      return window.settingsAPI.command("setAutoApproveAll", { enabled: true, confirmed: true });
    });
  }

  function showAutoApproveAllConfirmModal() {
    return helpers.showSettingsConfirmModal({
      title: t("autoApproveAllConfirmTitle"),
      detail: t("autoApproveAllConfirmDetail"),
      actions: [
        { id: "enable", label: t("autoApproveAllConfirmEnable"), tone: "danger" },
        { id: "cancel", label: t("autoApproveAllConfirmCancel"), tone: "accent", defaultFocus: true },
      ],
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
    return helpers.showSettingsConfirmModal({
      title: t("updateBubbleDisableConfirmTitle"),
      detail: t("updateBubbleDisableConfirmDetail"),
      actions: [
        { id: "confirm", label: t("updateBubbleDisableConfirmAction"), tone: "danger" },
        { id: "cancel", label: t("updateBubbleDisableConfirmCancel"), tone: "accent", defaultFocus: true },
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
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !hasMountedBubblePolicyControls()) {
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
      if (BUBBLE_POLICY_KEYS.has(key)) {
        const meta = state.mountedControls.bubblePolicyControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
        continue;
      }
      if (SESSION_CLEANUP_NUMBER_KEYS.has(key)) continue;
      if (FLASH_NUMBER_KEYS.has(key)) continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
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
      if (SESSION_CLEANUP_NUMBER_KEYS.has(key)) {
        state.mountedControls.sessionCleanupControls.get(key).syncFromSnapshot();
        continue;
      }
      if (FLASH_NUMBER_KEYS.has(key)) {
        state.mountedControls.sessionCleanupControls.get(key).syncFromSnapshot();
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
