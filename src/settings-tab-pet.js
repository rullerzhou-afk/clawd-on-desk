"use strict";

// Pet tab: the pet body itself — size, roaming position, edge pinning and
// reaction animations. patchInPlace only accepts PET_IN_PLACE_KEYS; it never
// mounts session, notification or permission controls.
(function initSettingsTabPet(root) {
  const PET_IN_PLACE_KEYS = new Set([
    "size",
    "keepSizeAcrossDisplays",
    "testReactionsEnabled",
    "petAlwaysOnTop",
    "allowEdgePinning",
    "disableMiniMode",
    "eyeTrackingEnabled",
    "freeRoam",
    "roamConstrainAxis",
    "idleActivities",
    "idleActivityFrequency",
    "fullscreenAutoHide",
  ]);

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;
  // #1275: Mac windows keep their launch level until restart (null until known).
  let petAlwaysOnTopAtStartup = null;
  let startupRenderStateRequested = false;
  let mountedPetAlwaysOnTopRestartPending = false;

  const ROAM_MOVEMENT_NATURAL = "natural";
  const ROAM_MOVEMENT_AXIS = "axis";
  const IDLE_ACTIVITY_FREQUENCIES = ["low", "medium", "high"];
  const IDLE_ACTIVITY_DEFAULT_FREQUENCY = "medium";

  function t(key) {
    return helpers.t(key);
  }

  function requestStartupRenderState() {
    if (startupRenderStateRequested) return;
    if (!window.settingsAPI || typeof window.settingsAPI.getStartupRenderState !== "function") return;
    startupRenderStateRequested = true;
    window.settingsAPI.getStartupRenderState()
      .then((result) => {
        const v = result && result.petAlwaysOnTop;
        petAlwaysOnTopAtStartup = typeof v === "boolean" ? v : null;
        if (state.activeTab === "pet") ops.requestRender({ content: true });
      })
      .catch(() => {});
  }

  function isPetAlwaysOnTopRestartPending() {
    const saved = !!(state.snapshot && state.snapshot.petAlwaysOnTop);
    return !!(i18n && i18n.IS_MAC)
      && petAlwaysOnTopAtStartup !== null
      && saved !== petAlwaysOnTopAtStartup;
  }

  function buildPetAlwaysOnTopRow() {
    const isMac = !!(i18n && i18n.IS_MAC);
    if (isMac) requestStartupRenderState();
    const restartPending = isPetAlwaysOnTopRestartPending();
    mountedPetAlwaysOnTopRestartPending = restartPending;
    return helpers.buildSwitchRow({
      key: "petAlwaysOnTop",
      labelKey: "rowPetAlwaysOnTop",
      descKey: isMac ? "rowPetAlwaysOnTopDescMac" : "rowPetAlwaysOnTopDesc",
      descExtraKey: restartPending ? "rowDisableHardwareAccelerationRestartPending" : null,
      actionButton: restartPending
        ? {
          labelKey: "doctorRestartButton",
          invoke: () => window.settingsAPI.command("restartClawd", { confirmed: true }),
        }
        : null,
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
      id: "roam-movement-style",
      value: readRoamMovementStyle(),
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

  function readIdleActivityFrequency() {
    const value = state.snapshot && state.snapshot.idleActivityFrequency;
    return IDLE_ACTIVITY_FREQUENCIES.includes(value)
      ? value
      : IDLE_ACTIVITY_DEFAULT_FREQUENCY;
  }

  async function saveIdleActivityFrequency(value) {
    try {
      const result = await window.settingsAPI.update("idleActivityFrequency", value);
      if (result && result.status === "ok") return true;
      const message = (result && result.message) || "unknown error";
      ops.showToast(t("toastSaveFailed") + message, { error: true });
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }
    return false;
  }

  function buildIdleActivityFrequencyRow() {
    const row = document.createElement("div");
    row.className = "row idle-activity-frequency-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowIdleActivityFrequency");
    const description = document.createElement("span");
    description.className = "row-desc";
    description.textContent = t("rowIdleActivityFrequencyDesc");
    text.appendChild(label);
    text.appendChild(description);

    const controlHost = document.createElement("div");
    controlHost.className = "row-control";
    const control = helpers.buildSegmentedRadio({
      id: "idle-activity-frequency",
      value: readIdleActivityFrequency(),
      ariaLabel: t("rowIdleActivityFrequency"),
      className: "idle-activity-frequency-segmented",
      options: [
        { value: "low", label: t("idleActivityFrequencyLow") },
        { value: "medium", label: t("idleActivityFrequencyMedium") },
        { value: "high", label: t("idleActivityFrequencyHigh") },
      ],
      onChange: saveIdleActivityFrequency,
    });
    controlHost.appendChild(control.element);
    row.appendChild(text);
    row.appendChild(controlHost);
    state.mountedControls.idleActivityFrequency = control;
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

  function readIdleBehavior(snapshot = state.snapshot) {
    if (snapshot && snapshot.freeRoam === true) return "roam";
    return snapshot && snapshot.idleActivities === true ? "activities" : "none";
  }

  async function saveIdleBehavior(mode) {
    try {
      const result = await window.settingsAPI.command("setIdleBehavior", { mode });
      if (result && result.status === "ok") return true;
      const message = (result && result.message) || "unknown error";
      ops.showToast(t("toastSaveFailed") + message, { error: true });
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    }
    return false;
  }

  function buildIdleBehaviorGroup() {
    const group = document.createElement("div");
    group.className = "idle-behavior-group";
    const modeRow = document.createElement("div");
    modeRow.className = "row idle-behavior-mode-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("rowIdleBehavior");
    const description = document.createElement("span");
    description.className = "row-desc";
    text.appendChild(label);
    text.appendChild(description);
    const controlHost = document.createElement("div");
    controlHost.className = "row-control";
    const modeControl = helpers.buildSegmentedRadio({
      id: "idle-behavior-mode",
      value: readIdleBehavior(),
      ariaLabel: t("rowIdleBehavior"),
      className: "idle-behavior-mode-segmented",
      options: [
        { value: "none", label: t("idleBehaviorNone") },
        { value: "roam", label: t("idleBehaviorRoam") },
        { value: "activities", label: t("idleBehaviorActivities") },
      ],
      onChange(mode) {
        return saveIdleBehavior(mode).then((accepted) => {
          if (accepted) syncMode(mode);
          return accepted;
        });
      },
    });
    controlHost.appendChild(modeControl.element);
    modeRow.appendChild(text);
    modeRow.appendChild(controlHost);
    const movementRow = buildRoamMovementStyleRow();
    const areaRow = buildRoamAreaRow();
    const frequencyRow = buildIdleActivityFrequencyRow();
    group.appendChild(modeRow);
    group.appendChild(movementRow);
    group.appendChild(areaRow);
    group.appendChild(frequencyRow);

    function syncMode(mode) {
      const descriptionKeys = {
        none: "idleBehaviorNoneDesc",
        roam: "idleBehaviorRoamDesc",
        activities: "idleBehaviorActivitiesDesc",
      };
      description.textContent = t(descriptionKeys[mode]);
      for (const [row, visible] of [
        [movementRow, mode === "roam"],
        [areaRow, mode === "roam"],
        [frequencyRow, mode === "activities"],
      ]) {
        row.hidden = !visible;
        row.setAttribute("aria-hidden", visible ? "false" : "true");
      }
    }

    state.mountedControls.idleBehavior = {
      element: group,
      modeControl,
      syncFromSnapshot({ modeChanged = true } = {}) {
        const mode = readIdleBehavior();
        modeControl.setValue(mode);
        if (modeChanged) syncMode(mode);
      },
    };
    state.mountedControls.idleBehavior.syncFromSnapshot();
    return group;
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
    return true;
  }

  function getMountedIdleActivityFrequency() {
    const control = state.mountedControls.idleActivityFrequency;
    if (!control || !document.body.contains(control.element)) return null;
    return control;
  }

  function syncIdleActivityFrequencyFromSnapshot() {
    const control = getMountedIdleActivityFrequency();
    if (!control) return false;
    control.setValue(readIdleActivityFrequency());
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
      buildIdleBehaviorGroup(),
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
      ...(i18n && (i18n.IS_WIN || i18n.IS_MAC) ? [helpers.buildSwitchRow({
        key: "fullscreenAutoHide",
        labelKey: "rowFullscreenAutoHide",
        descKey: "rowFullscreenAutoHideDesc",
      })] : []),
    ]));

    // #1275: master always-on-top switch. Cross-platform — the pet body's
    // topmost band is maintained on every OS, so the opt-out is too.
    parent.appendChild(helpers.buildSection(t("sectionPetTopmost"), [
      buildPetAlwaysOnTopRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionPetGaze"), [
      helpers.buildSwitchRow({
        key: "eyeTrackingEnabled",
        labelKey: "rowEyeTracking",
        descKey: "rowEyeTrackingDesc",
      }),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionPetReactions"), [
      helpers.buildSwitchRow({
        key: "testReactionsEnabled",
        labelKey: "rowTestReactions",
        descKey: "rowTestReactionsDesc",
      }),
    ]));
  }

  function patchInPlace(changes, { previousSnapshot } = {}) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => PET_IN_PLACE_KEYS.has(key))) return false;
    if ((keys.includes("size") || keys.includes("keepSizeAcrossDisplays"))
      && !ops.syncMountedSizeControl({ fromBroadcast: true })) return false;
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !getMountedRoamMovementStyle()) {
      return false;
    }
    if ((keys.includes("idleActivities") || keys.includes("idleActivityFrequency"))
      && !getMountedIdleActivityFrequency()) {
      return false;
    }
    const idleBehavior = state.mountedControls.idleBehavior;
    const behaviorChanged = keys.includes("freeRoam") || keys.includes("idleActivities");
    if (behaviorChanged && (!idleBehavior || !document.body.contains(idleBehavior.element))) return false;
    // #1275: adding or removing the restart note/button needs a new row.
    if (keys.includes("petAlwaysOnTop")
      && isPetAlwaysOnTopRestartPending() !== mountedPetAlwaysOnTopRestartPending) {
      return false;
    }
    for (const key of keys) {
      if (key === "size" || key === "roamConstrainAxis") continue;
      if (key === "idleActivityFrequency" || key === "freeRoam" || key === "idleActivities") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      if (key === "roamConstrainAxis") continue;
      if (key === "idleActivityFrequency" || key === "freeRoam" || key === "idleActivities") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      meta.control.setState({
        checked: readers.readGeneralSwitchVisual(key, meta.invert),
        pending: false,
      });
    }
    if (behaviorChanged) {
      // Compare authoritative snapshots: the control already changed optimistically.
      const modeChanged = !previousSnapshot || readIdleBehavior(previousSnapshot) !== readIdleBehavior();
      idleBehavior.syncFromSnapshot({ modeChanged });
    }
    if ((keys.includes("freeRoam") || keys.includes("roamConstrainAxis"))
      && !syncRoamMovementStyleFromSnapshot()) return false;
    if ((keys.includes("idleActivities") || keys.includes("idleActivityFrequency"))
      && !syncIdleActivityFrequencyFromSnapshot()) return false;
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
