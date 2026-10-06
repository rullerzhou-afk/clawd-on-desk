"use strict";

(function initSettingsTabAnimMap(root) {
  const ANIM_MAP_ROWS = [
    { stateKey: "error", labelKey: "animMapErrorLabel", descKey: "animMapErrorDesc" },
    { stateKey: "notification", labelKey: "animMapNotificationLabel", descKey: "animMapNotificationDesc" },
    { stateKey: "sweeping", labelKey: "animMapSweepingLabel", descKey: "animMapSweepingDesc" },
    { stateKey: "attention", labelKey: "animMapAttentionLabel", descKey: "animMapAttentionDesc" },
    { stateKey: "carrying", labelKey: "animMapCarryingLabel", descKey: "animMapCarryingDesc" },
  ];

  let state = null;
  let helpers = null;
  let ops = null;
  let readers = null;

  function t(key) {
    return helpers.t(key);
  }

  function isStateDisabled(themeId, stateKey) {
    const map = readers.readThemeOverrideMap(themeId);
    const states = map && map.states;
    const entry = (states && states[stateKey]) || (map && map[stateKey]);
    return !!(entry && entry.disabled === true);
  }

  function animMapSwitchId(themeId, stateKey) {
    return `${themeId}:${stateKey}`;
  }

  function readAnimMapVisualOn(themeId, stateKey) {
    return !isStateDisabled(themeId, stateKey);
  }

  function buildAnimMapRow(spec, themeId) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    const label = row.querySelector(".row-label");
    const desc = row.querySelector(".row-desc");
    label.textContent = t(spec.labelKey);
    desc.textContent = t(spec.descKey);

    const switchId = animMapSwitchId(themeId, spec.stateKey);
    label.id = `settings-anim-map-${themeId}-${spec.stateKey}-label`;
    desc.id = `settings-anim-map-${themeId}-${spec.stateKey}-description`;
    const override = state.transientUiState.animMapSwitches.get(switchId);
    const visualOn = override ? override.visualOn : readAnimMapVisualOn(themeId, spec.stateKey);
    const switchControl = helpers.buildSwitch({
      checked: visualOn,
      pending: override ? override.pending : false,
      ariaLabelledBy: label.id,
      ariaDescribedBy: desc.id,
    });
    row.querySelector(".row-control").appendChild(switchControl.element);
    state.mountedControls.animMapSwitches.set(switchId, {
      control: switchControl,
      element: switchControl.element,
      themeId,
      stateKey: spec.stateKey,
    });

    helpers.attachOptimisticSwitch(switchControl, {
      getCommittedVisual: () => readAnimMapVisualOn(themeId, spec.stateKey),
      getTransientState: () => state.transientUiState.animMapSwitches.get(switchId) || null,
      setTransientState: (value) => state.transientUiState.animMapSwitches.set(switchId, value),
      clearTransientState: (seq) => {
        const current = state.transientUiState.animMapSwitches.get(switchId);
        if (!current || (seq !== undefined && current.seq !== seq)) return;
        state.transientUiState.animMapSwitches.delete(switchId);
      },
      invoke: () => window.settingsAPI.command("setThemeOverrideDisabled", {
        themeId,
        stateKey: spec.stateKey,
        disabled: readAnimMapVisualOn(themeId, spec.stateKey),
      }),
    });
    return row;
  }

  // The parent tab supplies the stable title, subtitle, and subtab switcher.
  // This module only renders the map-specific explanation and controls.
  function renderMapSubtab(parent) {
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("animMapSubtitle");
    parent.appendChild(subtitle);

    const note = document.createElement("p");
    note.className = "subtitle";
    note.textContent = t("animMapSemanticsNote");
    parent.appendChild(note);

    const themeId = (state.snapshot && state.snapshot.theme) || "clawd";
    const rows = ANIM_MAP_ROWS.map((spec) => buildAnimMapRow(spec, themeId));
    parent.appendChild(helpers.buildSection("", rows));

    const hasAny = readers.readThemeOverrideMap(themeId) !== null;
    const resetWrap = document.createElement("div");
    resetWrap.className = "anim-map-reset";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "theme-delete-btn anim-map-reset-btn";
    resetBtn.textContent = t("animMapResetAll");
    if (!hasAny) resetBtn.disabled = true;
    state.mountedControls.animMapReset = {
      element: resetBtn,
      themeId,
      syncFromSnapshot: () => {
        resetBtn.disabled = readers.readThemeOverrideMap(themeId) === null;
      },
    };
    helpers.attachActivation(resetBtn, () =>
      window.settingsAPI.command("resetThemeOverrides", { themeId })
        .then((result) => {
          if (result && result.status === "ok" && !result.noop) {
            ops.showToast(t("toastAnimMapResetOk"));
          }
          return result;
        })
    );
    resetWrap.appendChild(resetBtn);
    parent.appendChild(resetWrap);
  }

  function patchMapInPlace(changes) {
    if (!changes || !Object.prototype.hasOwnProperty.call(changes, "themeOverrides")) return false;
    if (Object.prototype.hasOwnProperty.call(changes, "theme")) {
      // Theme switched: the mounted switch ids (themeId:stateKey) are now stale,
      // so rebuild the subtab. The map reads themeOverrides straight from the
      // snapshot, so a synchronous content re-render is enough — no need to
      // refetch the (unrelated) animation-override asset data.
      ops.requestRender({ content: true });
      return true;
    }
    if (state.mountedControls.animMapSwitches.size === 0) return false;
    for (const [, meta] of state.mountedControls.animMapSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const [id, meta] of state.mountedControls.animMapSwitches) {
      state.transientUiState.animMapSwitches.delete(id);
      meta.control.setState({
        checked: readAnimMapVisualOn(meta.themeId, meta.stateKey),
        pending: false,
      });
    }
    const reset = state.mountedControls.animMapReset;
    if (reset && document.body.contains(reset.element)) {
      reset.syncFromSnapshot();
    }
    return true;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    readers = core.readers;
  }

  // The map is no longer a top-level tab — the Animation & Sound Overrides tab
  // renders it as its "on / off" subtab via these two entry points.
  root.ClawdSettingsTabAnimMap = { init, renderMapSubtab, patchMapInPlace };
})(globalThis);
