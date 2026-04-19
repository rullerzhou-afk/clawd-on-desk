"use strict";

function buildSettingsSizeSliderExports() {
const SIZE_PREFS_MAX = 30;
const SIZE_UI_MIN = 1;
const SIZE_UI_MAX = 100;
const SIZE_TICK_VALUES = [25, 50, 75, 100];
const SIZE_SLIDER_TRACK_HEIGHT = 6;
const SIZE_SLIDER_THUMB_DIAMETER = 18;

function uiSizeToPrefs(ui) {
  return Math.round((ui * SIZE_PREFS_MAX / SIZE_UI_MAX) * 10) / 10;
}

function prefsSizeToUi(prefs) {
  return Math.round(prefs * SIZE_UI_MAX / SIZE_PREFS_MAX);
}

function clampSizeUi(n) {
  return Math.max(SIZE_UI_MIN, Math.min(SIZE_UI_MAX, Math.round(n)));
}

function sizeUiToPct(ui) {
  return ((ui - SIZE_UI_MIN) / (SIZE_UI_MAX - SIZE_UI_MIN)) * 100;
}

function clampSliderNormalized(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function getSizeSliderAnchorPx({
  value,
  min = SIZE_UI_MIN,
  max = SIZE_UI_MAX,
  sliderWidth,
  thumbDiameter = SIZE_SLIDER_THUMB_DIAMETER,
}) {
  const width = Number.isFinite(sliderWidth) ? Math.max(0, sliderWidth) : 0;
  const diameter = Number.isFinite(thumbDiameter) ? Math.max(0, thumbDiameter) : 0;
  const radius = diameter / 2;
  if (width <= 0) return radius;
  if (width <= diameter) return width / 2;
  const normalized = clampSliderNormalized(value, min, max);
  return radius + (normalized * (width - diameter));
}

function formatSizeKey(ui) {
  return `P:${uiSizeToPrefs(clampSizeUi(ui))}`;
}

function createSizeSliderController({
  readSnapshotUi,
  settingsAPI,
  onLocalValue,
  onDraggingChange,
  onError,
}) {
  if (typeof readSnapshotUi !== "function") {
    throw new TypeError("createSizeSliderController: readSnapshotUi is required");
  }
  const api = settingsAPI || {};
  const emitLocalValue = typeof onLocalValue === "function" ? onLocalValue : () => {};
  const emitDragging = typeof onDraggingChange === "function" ? onDraggingChange : () => {};
  const emitError = typeof onError === "function" ? onError : () => {};

  const state = {
    draftUi: null,
    dragging: false,
    pending: false,
    previewActive: false,
    beginPromise: null,
    finalizePromise: null,
  };

  function emitDraggingState() {
    emitDragging(state.dragging, state.pending);
  }

  function reportFailure(message) {
    if (message) emitError(message);
  }

  async function ensurePreviewStarted() {
    if (state.previewActive) return { status: "ok" };
    if (state.beginPromise) return state.beginPromise;
    state.beginPromise = Promise.resolve(
      typeof api.beginSizePreview === "function" ? api.beginSizePreview() : { status: "ok" }
    ).then((result) => {
      if (result && result.status && result.status !== "ok") {
        reportFailure(result.message || "unknown error");
        return result;
      }
      state.previewActive = true;
      return { status: "ok" };
    }).catch((err) => {
      reportFailure(err && err.message);
      return { status: "error", message: err && err.message };
    }).finally(() => {
      state.beginPromise = null;
    });
    return state.beginPromise;
  }

  async function sendPreview(ui) {
    const beginResult = await ensurePreviewStarted();
    if (!beginResult || beginResult.status !== "ok") return beginResult;
    try {
      const result = await Promise.resolve(
        typeof api.previewSize === "function" ? api.previewSize(formatSizeKey(ui)) : undefined
      );
      if (result && result.status && result.status !== "ok") {
        reportFailure(result.message || "unknown error");
        return result;
      }
      return { status: "ok" };
    } catch (err) {
      reportFailure(err && err.message);
      return { status: "error", message: err && err.message };
    }
  }

  async function finalize(commitDraft) {
    if (state.finalizePromise) return state.finalizePromise;
    const hasDraft = state.draftUi !== null;
    const finalSizeKey = commitDraft && hasDraft ? formatSizeKey(state.draftUi) : null;
    if (!state.previewActive && !state.dragging && !finalSizeKey) {
      state.pending = false;
      emitDraggingState();
      return { status: "ok", noop: true };
    }

    state.dragging = false;
    state.pending = !!finalSizeKey;
    emitDraggingState();

    state.finalizePromise = Promise.resolve(
      typeof api.endSizePreview === "function" ? api.endSizePreview(finalSizeKey) : { status: "ok" }
    ).then((result) => {
      if (result && result.status && result.status !== "ok") {
        state.draftUi = null;
        emitLocalValue(readSnapshotUi());
        reportFailure(result.message || "unknown error");
        return result;
      }
      return { status: "ok" };
    }).catch((err) => {
      state.draftUi = null;
      emitLocalValue(readSnapshotUi());
      reportFailure(err && err.message);
      return { status: "error", message: err && err.message };
    }).finally(() => {
      state.previewActive = false;
      state.pending = false;
      state.finalizePromise = null;
      emitDraggingState();
    });

    return state.finalizePromise;
  }

  return {
    syncFromSnapshot({ fromBroadcast = false } = {}) {
      const snapshotUi = clampSizeUi(readSnapshotUi());
      if (fromBroadcast) {
        state.pending = false;
        if (
          !state.dragging
          || state.draftUi === null
          || state.draftUi === snapshotUi
        ) {
          state.draftUi = null;
        }
      }
      const displayedUi = state.draftUi === null ? snapshotUi : state.draftUi;
      emitDraggingState();
      emitLocalValue(displayedUi);
      return displayedUi;
    },
    async pointerDown() {
      state.dragging = true;
      emitDraggingState();
      return ensurePreviewStarted();
    },
    async input(ui) {
      const nextUi = clampSizeUi(ui);
      state.draftUi = nextUi;
      emitLocalValue(nextUi);
      return sendPreview(nextUi);
    },
    async pointerUp() {
      return finalize(true);
    },
    async pointerCancel() {
      return finalize(state.draftUi !== null);
    },
    async blur() {
      return finalize(state.draftUi !== null);
    },
    async change(ui) {
      const nextUi = clampSizeUi(ui);
      state.draftUi = nextUi;
      emitLocalValue(nextUi);
      return finalize(true);
    },
    async dispose() {
      return finalize(false);
    },
  };
}

return {
  SIZE_PREFS_MAX,
  SIZE_UI_MIN,
  SIZE_UI_MAX,
  SIZE_TICK_VALUES,
  SIZE_SLIDER_TRACK_HEIGHT,
  SIZE_SLIDER_THUMB_DIAMETER,
  uiSizeToPrefs,
  prefsSizeToUi,
  clampSizeUi,
  sizeUiToPct,
  getSizeSliderAnchorPx,
  createSizeSliderController,
};
}

const settingsSizeSliderExports = buildSettingsSizeSliderExports();

if (typeof module !== "undefined" && module.exports) {
  module.exports = settingsSizeSliderExports;
}
if (typeof globalThis !== "undefined") {
  globalThis.ClawdSettingsSizeSlider = settingsSizeSliderExports;
}
