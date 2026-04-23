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

  function buildAnimMapRow(spec, themeId) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(spec.labelKey);
    row.querySelector(".row-desc").textContent = t(spec.descKey);
    const sw = row.querySelector(".switch");

    const disabled = isStateDisabled(themeId, spec.stateKey);
    const visualOn = !disabled;
    if (visualOn) sw.classList.add("on");
    sw.setAttribute("aria-checked", visualOn ? "true" : "false");

    helpers.attachActivation(sw, () => {
      const nextDisabled = !isStateDisabled(themeId, spec.stateKey);
      return window.settingsAPI.command("setThemeOverrideDisabled", {
        themeId,
        stateKey: spec.stateKey,
        disabled: nextDisabled,
      });
    });
    return row;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("animMapTitle");
    parent.appendChild(h1);

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

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    readers = core.readers;
    core.tabs.animMap = {
      render,
    };
  }

  root.ClawdSettingsTabAnimMap = { init };
})(globalThis);
