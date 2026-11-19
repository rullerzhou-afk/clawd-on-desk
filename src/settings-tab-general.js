"use strict";

// General tab: language, text scale, and the set-once startup/system toggles.
// patchInPlace only accepts GENERAL_IN_PLACE_KEYS; any other key falls through
// to a full re-render.
(function initSettingsTabGeneral(root) {
  const GENERAL_IN_PLACE_KEYS = new Set([
    "textScale",
    "textScaleByDisplay",
    "lowPowerIdleMode",
    "keepAwakeWhileWorking",
    "showTray",
    "showDock",
    "openAtLogin",
    "disableHardwareAcceleration",
  ]);

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;
  // #1183: what this process launched with (null until main answers).
  let hardwareAccelerationDisabledAtStartup = null;
  let startupRenderStateRequested = false;
  let mountedHardwareAccelerationRestartPending = false;

  const LANGUAGE_OPTIONS = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];

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
    return definitions.map((definition) => helpers.buildSwitchRow(definition));
  }


  function requestStartupRenderState() {
    if (startupRenderStateRequested) return;
    if (!window.settingsAPI || typeof window.settingsAPI.getStartupRenderState !== "function") return;
    startupRenderStateRequested = true;
    window.settingsAPI.getStartupRenderState()
      .then((result) => {
        hardwareAccelerationDisabledAtStartup = !!(result && result.hardwareAccelerationDisabled === true);
        if (state.activeTab === "general") ops.requestRender({ content: true });
      })
      .catch(() => {});
  }

  function isHardwareAccelerationRestartPending() {
    const saved = !!(state.snapshot && state.snapshot.disableHardwareAcceleration);
    return hardwareAccelerationDisabledAtStartup !== null
      && saved !== hardwareAccelerationDisabledAtStartup;
  }

  function buildHardwareAccelerationRow() {
    requestStartupRenderState();
    const restartPending = isHardwareAccelerationRestartPending();
    mountedHardwareAccelerationRestartPending = restartPending;
    return helpers.buildSwitchRow({
      key: "disableHardwareAcceleration",
      labelKey: "rowDisableHardwareAcceleration",
      descKey: "rowDisableHardwareAccelerationDesc",
      descExtraKey: restartPending ? "rowDisableHardwareAccelerationRestartPending" : null,
      actionButton: restartPending
        ? {
          labelKey: "doctorRestartButton",
          invoke: () => window.settingsAPI.command("restartClawd", { confirmed: true }),
        }
        : null,
    });
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


  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("generalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("generalSubtitle");
    parent.appendChild(subtitle);
    parent.appendChild(buildTutorialReplayHint());

    parent.appendChild(helpers.buildSection(t("sectionInterface"), [
      buildLanguageRow(),
      buildTextScaleRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionStartupSystem"), [
      helpers.buildSwitchRow({
        key: "openAtLogin",
        labelKey: "rowOpenAtLogin",
        descKey: "rowOpenAtLoginDesc",
      }),
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
      // #1183: Windows-only, like the switch it backs (main.js reads it at
      // startup only on win32).
      ...(i18n && i18n.IS_WIN ? [buildHardwareAccelerationRow()] : []),
    ]));
  }

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("textScale") || keys.includes("textScaleByDisplay")) {
      const tc = state.mountedControls.textScale;
      if (!tc || !document.body.contains(tc.row)) return false;
    }
    // The restart button and note live inside the row; adding or removing
    // them needs a re-render.
    if (keys.includes("disableHardwareAcceleration")
      && isHardwareAccelerationRestartPending() !== mountedHardwareAccelerationRestartPending) {
      return false;
    }
    if (keys.some((key) => key === "showTray" || key === "showDock")
      && (!i18n || !i18n.IS_MAC
        || !getMountedGeneralSwitch("showTray")
        || !getMountedGeneralSwitch("showDock"))) {
      return false;
    }
    for (const key of keys) {
      if (key === "textScale" || key === "textScaleByDisplay") continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "textScale" || key === "textScaleByDisplay") {
        state.mountedControls.textScale.syncValueFromSnapshot();
        continue;
      }
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      meta.control.setState({
        checked: readers.readGeneralSwitchVisual(key, meta.invert),
        pending: false,
      });
    }
    if (keys.some((key) => key === "showTray" || key === "showDock")
      && !syncMacAppPresenceSwitchesDisabled()) return false;
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
