"use strict";

// Notifications tab: every way the pet gets your attention — sound, tray
// flashing, and bubble visibility/placement. patchInPlace only accepts
// NOTIFICATIONS_IN_PLACE_KEYS; the sound toggle owns its own optimistic save.
(function initSettingsTabNotifications(root) {
  const NOTIFICATIONS_IN_PLACE_KEYS = new Set([
    "soundMuted",
    "soundVolume",
    "flashTaskbarOnComplete",
    "flashIntervalMs",
    "flashDurationMs",
    "hideBubbles",
    "permissionBubblesEnabled",
    "notificationBubbleAutoCloseSeconds",
    "updateBubbleAutoCloseSeconds",
    "bubbleFollowPet",
    "bubbleFollowPreference",
    "bubbleFixedCorner",
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
  const FLASH_NUMBER_KEYS = new Set([
    "flashIntervalMs",
    "flashDurationMs",
  ]);
  const BUBBLE_SECONDS_AUTO_COMMIT_DELAY_MS = 600;

  let state = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;

  function t(key) {
    return helpers.t(key);
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
      id: "bubble-placement-mode",
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
      id: "bubble-follow-preference",
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
      id: "bubble-fixed-corner",
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


  function buildSoundEnabledRow() {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    const label = row.querySelector(".row-label");
    label.id = "settings-sound-enabled-label";
    label.textContent = t("rowSoundEnabled");
    const text = row.querySelector(".row-text");
    const override = state.transientUiState.generalSwitches.get("soundMuted");
    const visualOn = override ? override.visualOn : readers.readGeneralSwitchVisual("soundMuted", true);
    const switchControl = helpers.buildSwitch({
      checked: visualOn,
      pending: override ? override.pending : false,
      ariaLabelledBy: label.id,
    });
    row.querySelector(".row-control").appendChild(switchControl.element);
    state.mountedControls.generalSwitches.set("soundMuted", {
      control: switchControl,
      element: switchControl.element,
      invert: true,
      row,
      text,
      extraElement: null,
    });

    function getSoundTransientState() {
      return state.transientUiState.generalSwitches.get("soundMuted") || null;
    }

    function getCommittedSoundVisual() {
      return readers.readGeneralSwitchVisual("soundMuted", true);
    }

    function setSoundChildSwitchVisual(visualOn, pendingVisual) {
      const meta = getMountedGeneralSwitch("soundMuted");
      if (!meta) return;
      meta.control.setState({ checked: visualOn, pending: pendingVisual });
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
      state.transientUiState.generalSwitches.set("soundMuted", {
        visualOn: nextVisual,
        pending: true,
        seq,
      });
      setSoundChildSwitchVisual(nextVisual, true);
      window.settingsAPI.update("soundMuted", nextMuted).then((result) => {
        const currentTransient = getSoundTransientState();
        if (!currentTransient || currentTransient.seq !== seq) return;
        state.transientUiState.generalSwitches.delete("soundMuted");
        if (!result || result.status !== "ok" || result.noop) {
          const committedVisual = getCommittedSoundVisual();
          setSoundChildSwitchVisual(committedVisual, false);
          if (result && result.noop) return;
          const msg = (result && result.message) || "unknown error";
          ops.showToast(t("toastSaveFailed") + msg, { error: true });
          return;
        }
        setSoundChildSwitchVisual(nextVisual, false);
      }).catch((err) => {
        const currentTransient = getSoundTransientState();
        if (!currentTransient || currentTransient.seq !== seq) return;
        state.transientUiState.generalSwitches.delete("soundMuted");
        const committedVisual = getCommittedSoundVisual();
        setSoundChildSwitchVisual(committedVisual, false);
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    }

    switchControl.setOnToggle(({ event }) => toggleSound(event));
    return row;
  }


  function buildBubbleCategoryControl({ category, labelKey, descKey, warningKey = null, secondsKey = null, enabledKey = null }) {
    const stateKey = enabledKey || secondsKey || "permissionBubblesEnabled";
    const item = document.createElement("div");
    item.className = "row";
    item.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"></div>`;
    const label = item.querySelector(".row-label");
    const description = item.querySelector(".row-desc");
    label.id = `settings-bubble-${category}-label`;
    description.id = `settings-bubble-${category}-description`;
    label.textContent = t(labelKey);
    description.textContent = t(descKey);
    if (warningKey) {
      const warning = document.createElement("span");
      warning.className = "row-desc bubble-policy-warning";
      warning.textContent = t(warningKey);
      item.querySelector(".row-text").appendChild(warning);
    }

    const controls = item.querySelector(".row-control");
    const switchControl = helpers.buildSwitch({
      checked: currentEnabled(),
      ariaLabelledBy: label.id,
      ariaDescribedBy: description.id,
    });
    controls.appendChild(switchControl.element);
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
      switchControl.setState({ checked: enabled, pending });
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
    switchControl.setOnToggle(runToggle);

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
      controls.insertBefore(prefix, switchControl.element);
      controls.insertBefore(input, switchControl.element);
      controls.insertBefore(suffix, switchControl.element);
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

  function hasMountedBubblePolicyControls() {
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


  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("notificationsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("notificationsSubtitle");
    parent.appendChild(subtitle);

    const soundSection = helpers.buildSection(t("sectionSound"), [
      buildSoundEnabledRow(),
      buildVolumeSliderRow(),
    ]);
    soundSection.classList.add("sound-section");
    parent.appendChild(soundSection);

    parent.appendChild(helpers.buildSection(t("sectionTrayFlash"), [
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
    ]));

    parent.appendChild(helpers.buildSection(t("sectionBubbles"), [
      helpers.buildSwitchRow({
        key: "hideBubbles",
        labelKey: "rowHideBubbles",
        descKey: "rowHideBubblesDesc",
        onToggle: ({ nextRaw }) => window.settingsAPI.command("setAllBubblesHidden", { hidden: nextRaw }),
      }),
      buildBubbleCategoryControl({
        category: "permission",
        labelKey: "bubblePermissionLabel",
        descKey: "bubblePermissionDesc",
        enabledKey: "permissionBubblesEnabled",
        secondsKey: "permissionBubbleAutoCloseSeconds",
      }),
      buildBubbleCategoryControl({
        category: "notification",
        labelKey: "bubbleNotificationLabel",
        descKey: "bubbleNotificationDesc",
        secondsKey: "notificationBubbleAutoCloseSeconds",
      }),
      buildBubbleCategoryControl({
        category: "update",
        labelKey: "bubbleUpdateLabel",
        descKey: "bubbleUpdateDesc",
        warningKey: "bubbleUpdateWarning",
        secondsKey: "updateBubbleAutoCloseSeconds",
      }),
      buildBubblePlacementGroup(),
    ]));
  }

  function patchInPlace(changes) {
    const keys = changes ? Object.keys(changes) : [];
    if (keys.length === 0) return false;
    if (!keys.every((key) => NOTIFICATIONS_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("soundVolume") || keys.includes("soundMuted")) {
      const vc = state.mountedControls.soundVolume;
      if (!vc || !document.body.contains(vc.row)) return false;
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !hasMountedBubblePolicyControls()) {
      return false;
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_PLACEMENT_KEYS.has(key)))
      && !getMountedBubblePlacement()) {
      return false;
    }
    if (keys.some((key) => FLASH_NUMBER_KEYS.has(key))) {
      for (const key of keys) {
        if (!FLASH_NUMBER_KEYS.has(key)) continue;
        const meta = state.mountedControls.sessionCleanupControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
      }
    }
    for (const key of keys) {
      if (key === "soundVolume") continue;
      if (BUBBLE_POLICY_KEYS.has(key)) {
        const meta = state.mountedControls.bubblePolicyControls.get(key);
        if (!meta || !document.body.contains(meta.row)) return false;
        continue;
      }
      if (BUBBLE_PLACEMENT_KEYS.has(key)) continue;
      if (FLASH_NUMBER_KEYS.has(key)) continue;
      const meta = state.mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "soundVolume") {
        state.mountedControls.soundVolume.syncValueFromSnapshot();
        continue;
      }
      if (BUBBLE_POLICY_KEYS.has(key)) {
        state.mountedControls.bubblePolicyControls.get(key).syncFromSnapshot();
        continue;
      }
      if (BUBBLE_PLACEMENT_KEYS.has(key)) continue;
      if (FLASH_NUMBER_KEYS.has(key)) {
        state.mountedControls.sessionCleanupControls.get(key).syncFromSnapshot();
        continue;
      }
      const meta = state.mountedControls.generalSwitches.get(key);
      state.transientUiState.generalSwitches.delete(key);
      meta.control.setState({
        checked: readers.readGeneralSwitchVisual(key, meta.invert),
        pending: false,
      });
      if (key === "soundMuted") {
        state.mountedControls.soundVolume.syncDisabled();
      }
    }
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_POLICY_KEYS.has(key)))
      && !syncBubblePolicyControlsFromSnapshot()) return false;
    if ((keys.includes("hideBubbles") || keys.some((key) => BUBBLE_PLACEMENT_KEYS.has(key)))
      && !syncBubblePlacementFromSnapshot()) return false;
    return true;
  }

  function init(core) {
    state = core.state;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    core.tabs.notifications = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabNotifications = { init };
})(globalThis);
