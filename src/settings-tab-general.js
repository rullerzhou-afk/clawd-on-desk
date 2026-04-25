"use strict";

(function initSettingsTabGeneral(root) {
  const GENERAL_IN_PLACE_KEYS = new Set([
    "size",
    "soundMuted",
    "soundVolume",
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
        key: "bubbleFollowPet",
        labelKey: "rowBubbleFollow",
        descKey: "rowBubbleFollowDesc",
      }),
      buildBubblePolicyRow(),
    ]));
  }

  function confirmDisableClaudeHookManagement(nextRaw) {
    if (nextRaw) return window.settingsAPI.update("manageClaudeHooksAutomatically", true);
    if (!window.settingsAPI || typeof window.settingsAPI.confirmDisableClaudeHooks !== "function") {
      return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
    }
    return window.settingsAPI.confirmDisableClaudeHooks().then((result) => {
      if (!result || result.choice === "cancel") return { status: "ok", noop: true };
      if (result.choice === "disconnect") return window.settingsAPI.command("uninstallHooks");
      return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
    });
  }

  function runDisconnectClaudeHooks() {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      return Promise.resolve({ status: "error", message: "settings API unavailable" });
    }
    if (typeof window.settingsAPI.confirmDisconnectClaudeHooks !== "function") {
      return window.settingsAPI.command("uninstallHooks");
    }
    return window.settingsAPI.confirmDisconnectClaudeHooks().then((result) => {
      if (!result || !result.confirmed) return { status: "ok", noop: true };
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
        `</div>` +
      `</div>`;
    row.querySelector(".row-label").textContent = t("rowLanguage");
    row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
    const buttons = row.querySelectorAll(".segmented button");
    buttons[0].textContent = t("langEnglish");
    buttons[1].textContent = t("langChinese");
    buttons[2].textContent = t("langKorean");
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
    return helpers.buildCollapsibleGroup({
      id: "general:bubble-policy",
      title: t("rowBubblePolicy"),
      desc: t("rowBubblePolicyDesc"),
      summary: buildBubblePolicySummary(),
      defaultCollapsed: true,
      children: [buildBubblePolicyList()],
      className: "bubble-policy-collapsible",
    });
  }

  function buildBubblePolicySummary() {
    const wrap = document.createElement("div");
    const permissionOn = !!(state.snapshot && state.snapshot.permissionBubblesEnabled !== false);
    const notificationSeconds = Number(state.snapshot && state.snapshot.notificationBubbleAutoCloseSeconds) || 0;
    const updateSeconds = Number(state.snapshot && state.snapshot.updateBubbleAutoCloseSeconds) || 0;
    const items = [
      {
        text: t("bubblePolicySummaryPermission").replace(
          "{state}",
          permissionOn ? t("bubblePolicySummaryOn") : t("bubblePolicySummaryOff")
        ),
        accent: permissionOn,
      },
      {
        text: t("bubblePolicySummaryNotification").replace("{seconds}", String(notificationSeconds)),
        accent: notificationSeconds > 0,
      },
      {
        text: t("bubblePolicySummaryUpdate").replace("{seconds}", String(updateSeconds)),
        accent: updateSeconds > 0,
      },
    ];
    for (const item of items) {
      const chip = document.createElement("span");
      chip.className = "collapsible-summary-chip" + (item.accent ? " accent" : "");
      chip.textContent = item.text;
      wrap.appendChild(chip);
    }
    return wrap;
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

    function currentEnabled() {
      if (!secondsKey) return !!(state.snapshot && state.snapshot.permissionBubblesEnabled !== false);
      const seconds = Number(state.snapshot && state.snapshot[secondsKey]);
      return Number.isFinite(seconds) && seconds > 0;
    }

    function setVisual(enabled, pending = false) {
      helpers.setSwitchVisual(sw, enabled, { pending });
      if (secondsKey) {
        const input = controls.querySelector("input");
        if (input) input.disabled = !enabled || pending;
      }
    }

    function runToggle() {
      if (sw.classList.contains("pending")) return;
      const nextEnabled = !currentEnabled();
      if (category === "update" && !nextEnabled) {
        setVisual(nextEnabled, true);
        confirmDisableUpdateBubbles().then((confirmed) => {
          if (confirmed) runToggleCommit(nextEnabled);
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
      input.disabled = !currentEnabled();
      input.addEventListener("input", () => {
        const next = input.value.replace(/\D+/g, "").slice(0, 4);
        if (input.value !== next) input.value = next;
      });
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        const next = Number(raw);
        if (!raw || !Number.isInteger(next) || next < 0 || next > 3600) {
          input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
          ops.showToast(t("toastSaveFailed") + t("bubbleSecondsInvalid"), { error: true });
          return;
        }
        commitSecondsValue(input, secondsKey, next, category);
      });
    }

    return item;
  }

  function confirmDisableUpdateBubbles() {
    return showSettingsConfirmModal({
      title: t("updateBubbleDisableConfirmTitle"),
      detail: t("updateBubbleDisableConfirmDetail"),
      confirmLabel: t("updateBubbleDisableConfirmAction"),
      cancelLabel: t("updateBubbleDisableConfirmCancel"),
    });
  }

  function showSettingsConfirmModal({ title, detail, confirmLabel, cancelLabel }) {
    const rootNode = document.getElementById("modalRoot");
    if (!rootNode) return Promise.resolve(false);
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

      const actions = document.createElement("div");
      actions.className = "settings-confirm-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "soft-btn";
      cancelBtn.textContent = cancelLabel;

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "soft-btn accent settings-confirm-danger";
      confirmBtn.textContent = confirmLabel;

      function close(confirmed) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown, true);
        rootNode.innerHTML = "";
        resolve(confirmed);
      }

      function onKeyDown(ev) {
        if (ev.key === "Escape") close(false);
      }

      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) close(false);
      });
      cancelBtn.addEventListener("click", () => close(false));
      confirmBtn.addEventListener("click", () => close(true));
      document.addEventListener("keydown", onKeyDown, true);

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      modal.appendChild(icon);
      modal.appendChild(titleNode);
      modal.appendChild(detailNode);
      modal.appendChild(actions);
      overlay.appendChild(modal);
      rootNode.innerHTML = "";
      rootNode.appendChild(overlay);
      cancelBtn.focus();
    });
  }

  function commitSecondsValue(input, secondsKey, next, category) {
    const previous = Number(state.snapshot && state.snapshot[secondsKey]) || 0;
    const doCommit = () => {
      window.settingsAPI.update(secondsKey, next).then((result) => {
        if (!result || result.status !== "ok") {
          input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch((err) => {
        input.value = String(Number(state.snapshot && state.snapshot[secondsKey]) || 0);
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    };
    if (category === "update" && next === 0 && previous !== 0) {
      confirmDisableUpdateBubbles().then((confirmed) => {
        if (confirmed) doCommit();
        else input.value = String(previous);
      });
      return;
    }
    doCommit();
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
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("size") && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
    if (keys.includes("soundVolume") || keys.includes("soundMuted")) {
      const vc = state.mountedControls.soundVolume;
      if (!vc || !document.body.contains(vc.row)) return false;
    }
    for (const key of keys) {
      if (key === "size" || key === "soundVolume") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      if (key === "soundVolume") {
        state.mountedControls.soundVolume.syncValueFromSnapshot();
        continue;
      }
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      helpers.setSwitchVisual(meta.element, readers.readGeneralSwitchVisual(key, meta.invert), { pending: false });
      if (key === "soundMuted") {
        state.mountedControls.soundVolume.syncDisabled();
      }
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
