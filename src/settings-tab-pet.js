"use strict";

// Pet tab: the pet body itself — size, roaming position, edge pinning and
// reaction animations. patchInPlace only accepts PET_IN_PLACE_KEYS; it never
// mounts session, notification or permission controls.
(function initSettingsTabPet(root) {
  const PET_IN_PLACE_KEYS = new Set([
    "size",
    "keepSizeAcrossDisplays",
    "testReactionsEnabled",
    "modelPowerUpEnabled",
    "modelPowerUpAuraEnabled",
    "allowEdgePinning",
    "disableMiniMode",
    "freeRoam",
    "roamConstrainAxis",
    "fullscreenAutoHide",
  ]);

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  const ROAM_MOVEMENT_NATURAL = "natural";
  const ROAM_MOVEMENT_AXIS = "axis";

  function t(key) {
    return helpers.t(key);
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
      id: "roam-movement-style",
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
    const resetButton = helpers.buildButton({
      labelKey: "roamAreaReset",
      size: "compact",
      className: "roam-area-reset",
    });
    resetButton.style.display = "none";
    const chooseButton = helpers.buildButton({
      labelKey: "roamAreaChoose",
      tone: "accent",
      size: "compact",
      className: "roam-area-choose",
    });
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
      helpers.setButtonState(chooseButton, { pending: busy });
      helpers.setButtonState(resetButton, { pending: busy });
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
      id: "pet:free-roam",
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

  function buildOptionList(className, rows) {
    const list = document.createElement("div");
    list.className = `settings-option-list ${className || ""}`.trim();
    for (const row of rows) {
      row.classList.add("settings-option-item");
      list.appendChild(row);
    }
    return list;
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
    const warning = document.createElement("span");
    warning.className = "row-desc size-over-max-hint";
    warning.textContent = t("rowSizeOverMaxHint");
    warning.hidden = true;
    row.querySelector(".row-text").appendChild(warning);

    const control = row.querySelector(".size-control");
    const slider = row.querySelector(".size-slider");
    const readout = row.querySelector(".size-readout");
    readout.title = t("rowSizeResetTitle");

    let context = null;
    let requestId = 0;
    let disposed = false;
    let interactionBusy = false;
    let refreshAfterInteraction = false;

    function readDisplayedUi() {
      return context && !context.synced ? context.ui : readers.readSizeUiFromSnapshot();
    }

    function requestContext() {
      if (disposed || !window.settingsAPI || typeof window.settingsAPI.getSizeContext !== "function") return;
      if (interactionBusy) {
        ++requestId;
        refreshAfterInteraction = true;
        return;
      }
      const id = ++requestId;
      Promise.resolve().then(() => window.settingsAPI.getSizeContext()).then((result) => {
        if (disposed || id !== requestId) return;
        if (interactionBusy) {
          refreshAfterInteraction = true;
          return;
        }
        if (!result || !Number.isInteger(result.ui)
          || result.ui < helpers.SIZE_UI_MIN || result.ui > helpers.SIZE_UI_MAX
          || typeof result.synced !== "boolean" || typeof result.overMax !== "boolean"
          || (result.overMax && (result.synced || result.ui !== helpers.SIZE_UI_MAX))) {
          context = null;
          controller.syncFromSnapshot();
          return;
        }
        context = result;
        controller.syncFromSnapshot();
      }).catch(() => {
        if (disposed || id !== requestId || interactionBusy) return;
        context = null;
        controller.syncFromSnapshot();
      });
    }

    function invalidateContext() {
      ++requestId;
      context = null;
    }

    function applyLocalValue(ui) {
      const pct = helpers.sizeUiToPct(ui);
      slider.value = String(ui);
      slider.style.setProperty("--volume-fill", `${pct}%`);
      const overMax = !interactionBusy && context && !context.synced
        && context.overMax && ui === context.ui;
      readout.textContent = overMax ? "100%+" : `${ui}%`;
      readout.classList.toggle("over-max", !!overMax);
      warning.hidden = !overMax;
    }

    function setDragging(nextDragging, pending = state.transientUiState.size.pending) {
      control.classList.toggle("dragging", !!nextDragging);
      control.classList.toggle("pending", !!pending);
    }

    const initial = (state.transientUiState.size.dragging || state.transientUiState.size.pending)
      && state.transientUiState.size.draftUi !== null
      ? state.transientUiState.size.draftUi : readers.readSizeUiFromSnapshot();
    applyLocalValue(initial);
    setDragging(state.transientUiState.size.dragging, state.transientUiState.size.pending);

    const controller = helpers.createSizeSliderController({
      readSnapshotUi: readDisplayedUi,
      settingsAPI: window.settingsAPI,
      onLocalValue: (ui) => {
        state.transientUiState.size.draftUi = ui;
        applyLocalValue(ui);
      },
      onDraggingChange: (dragging, pending) => {
        state.transientUiState.size.dragging = dragging;
        state.transientUiState.size.pending = pending;
        const wasInteractionBusy = interactionBusy;
        interactionBusy = !!(dragging || pending);
        setDragging(dragging, pending);
        if (!interactionBusy && (wasInteractionBusy || refreshAfterInteraction)) {
          refreshAfterInteraction = false;
          requestContext();
        }
      },
      onError: (message) => {
        state.transientUiState.size.draftUi = null;
        applyLocalValue(readers.readSizeUiFromSnapshot());
        requestContext();
        if (message) ops.showToast(t("toastSaveFailed") + message, { error: true });
      },
    });

    state.mountedControls.size = {
      row,
      syncFromSnapshot: (options) => {
        invalidateContext();
        controller.syncFromSnapshot(options);
        requestContext();
      },
      dispose: () => {
        disposed = true;
        ++requestId;
        if (typeof unsubscribeContextChanged === "function") unsubscribeContextChanged();
        window.removeEventListener("focus", onFocus);
        return controller.dispose();
      },
    };
    controller.syncFromSnapshot();

    const onFocus = () => requestContext();
    window.addEventListener("focus", onFocus);
    const unsubscribeContextChanged = window.settingsAPI
      && typeof window.settingsAPI.onSizeContextChanged === "function"
      ? window.settingsAPI.onSizeContextChanged(requestContext) : null;
    requestContext();

    slider.addEventListener("pointerdown", () => {
      invalidateContext();
      applyLocalValue(Number(slider.value));
      void controller.pointerDown();
    });
    slider.addEventListener("pointerup", () => { void controller.pointerUp(); });
    slider.addEventListener("pointercancel", () => { void controller.pointerCancel(); });
    slider.addEventListener("blur", () => { void controller.blur(); });
    slider.addEventListener("input", () => {
      invalidateContext();
      void controller.input(Number(slider.value));
    });
    slider.addEventListener("change", () => {
      invalidateContext();
      void controller.change(Number(slider.value));
    });
    readout.addEventListener("click", () => {
      invalidateContext();
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
    meta.control.setState({ disabled: !!disabled });
    return true;
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


  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("petTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("petSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("sectionPetSize"), [
      buildSizeSliderRow(),
      helpers.buildSwitchRow({
        key: "keepSizeAcrossDisplays",
        labelKey: "rowKeepSizeAcrossDisplays",
        descKey: "rowKeepSizeAcrossDisplaysDesc",
      }),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionPetMovement"), [
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
      ...(i18n && i18n.IS_WIN ? [helpers.buildSwitchRow({
        key: "fullscreenAutoHide",
        labelKey: "rowFullscreenAutoHide",
        descKey: "rowFullscreenAutoHideDesc",
      })] : []),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionPetReactions"), [
      helpers.buildSwitchRow({
        key: "modelPowerUpEnabled",
        labelKey: "rowModelPowerUp",
        descKey: "rowModelPowerUpDesc",
      }),
      buildPowerUpSourceRow(),
      helpers.buildSwitchRow({
        key: "modelPowerUpAuraEnabled",
        labelKey: "rowModelPowerUpAura",
        descKey: "rowModelPowerUpAuraDesc",
      }),
      helpers.buildSwitchRow({
        key: "testReactionsEnabled",
        labelKey: "rowTestReactions",
        descKey: "rowTestReactionsDesc",
      }),
    ]));
  }

  async function savePowerUpSource(value) {
    try {
      const result = await window.settingsAPI.update("modelPowerUpSource", value);
      if (result && result.status === "ok") return true;
      ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }
    return false;
  }

  function buildPowerUpSourceRow() {
    const row = document.createElement("div");
    row.className = "row model-power-up-source-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowModelPowerUpSource");
    const description = document.createElement("span");
    description.className = "row-desc";
    description.textContent = t("rowModelPowerUpSourceDesc");
    text.appendChild(label);
    text.appendChild(description);
    const controlHost = document.createElement("div");
    controlHost.className = "row-control";
    const control = helpers.buildSegmentedRadio({
      id: "model-power-up-source",
      value: state.snapshot && state.snapshot.modelPowerUpSource || "auto",
      ariaLabel: t("rowModelPowerUpSource"),
      options: [
        { value: "auto", label: t("modelPowerUpSourceAuto") },
        { value: "claude-code", label: t("modelPowerUpSourceClaude") },
        { value: "codex", label: t("modelPowerUpSourceCodex") },
      ],
      onChange: savePowerUpSource,
    });
    controlHost.appendChild(control.element);
    row.appendChild(text);
    row.appendChild(controlHost);
    return row;
  }

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => PET_IN_PLACE_KEYS.has(key))) return false;
    if ((keys.includes("size") || keys.includes("keepSizeAcrossDisplays"))
      && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !getMountedRoamMovementStyle()) {
      return false;
    }
    for (const key of keys) {
      if (key === "size" || key === "roamConstrainAxis") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      if (key === "roamConstrainAxis") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      meta.control.setState({
        checked: readers.readGeneralSwitchVisual(key, meta.invert),
        pending: false,
      });
    }
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !syncRoamMovementStyleFromSnapshot()) return false;
    return true;
  }

  function init(core) {
    state = core.state;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.pet = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabPet = { init };
})(globalThis);
