"use strict";

(function initSettingsTabGeneral(root) {
  const GENERAL_IN_PLACE_KEYS = new Set([
    "size",
    "soundMuted",
    "soundVolume",
    "lowPowerIdleMode",
    "sessionHudEnabled",
    "allowEdgePinning",
    "keepSizeAcrossDisplays",
    "openAtLogin",
    "autoStartWithClaude",
    "bubbleFollowPet",
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const BUBBLE_POLICY_KEYS = new Set([
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
  ]);
  const BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS = 600;

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;

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
      helpers.buildSwitchRow({
        key: "sessionHudEnabled",
        labelKey: "rowSessionHud",
        descKey: "rowSessionHudDesc",
      }),
      buildDashboardRow(),
      helpers.buildSwitchRow({
        key: "soundMuted",
        labelKey: "rowSound",
        descKey: "rowSoundDesc",
        invert: true,
      }),
      buildVolumeSliderRow(),
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
      helpers.buildSwitchRow({
        key: "bubbleFollowPet",
        labelKey: "rowBubbleFollow",
        descKey: "rowBubbleFollowDesc",
      }),
      buildBubblePolicyRow(),
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

  function buildLanguageRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control">` +
        `<div class="segmented" role="tablist">` +
          `<button data-lang="en"></button>` +
          `<button data-lang="zh"></button>` +
          `<button data-lang="ko"></button>` +
          `<button data-lang="ja"></button>` +
        `</div>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowLanguage");
    row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
    const buttons = row.querySelectorAll(".segmented button");
    buttons[0].textContent = t("langEnglish");
    buttons[1].textContent = t("langChinese");
    buttons[2].textContent = t("langKorean");
    buttons[3].textContent = t("langJapanese");
    const current = readers.getLang();
    for (const btn of buttons) {
      if (btn.dataset.lang === current) btn.classList.add("active");
      btn.addEventListener("click", () => {
        const next = btn.dataset.lang;
        if (next === readers.getLang()) return;
        window.settingsAPI.update("lang", next).then((result) => {
          if (!result || result.status !== "ok") {
            const msg = (result && result.message) || "unknown error";
            ops.showToast(t("toastSaveFailed") + msg, { error: true });
          }
        }).catch((err) => {
          ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        });
      });
    }
    return row;
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
      secondsKey: null,
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

  function buildBubbleCategoryControl({ category, labelKey, descKey, warningKey = null, secondsKey = null }) {
    const stateKey = secondsKey || "permissionBubblesEnabled";
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

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (keys.includes("hideBubbles")) {
      // Aggregate hiding also changes the policy summary and category controls.
      const meta = state.mountedControls.generalSwitches.get("hideBubbles");
      if (meta && document.body.contains(meta.element)) {
        state.transientUiState.generalSwitches.delete("hideBubbles");
        helpers.setSwitchVisual(meta.element, readers.readGeneralSwitchVisual("hideBubbles", meta.invert), { pending: false });
      }
      return false;
    }
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("size") && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
    if (keys.includes("soundVolume") || keys.includes("soundMuted")) {
      const vc = state.mountedControls.soundVolume;
      if (!vc || !document.body.contains(vc.row)) return false;
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
    if (keys.some((key) => BUBBLE_POLICY_KEYS.has(key))) {
      const summaryControl = state.mountedControls.bubblePolicySummary;
      if (!summaryControl || !document.body.contains(summaryControl.element)) return false;
      summaryControl.syncFromSnapshot();
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
