"use strict";

const NONE_PAYLOAD = Object.freeze({
  id: "none",
  assetFile: null,
  aspect: 1,
  widthScale: 1,
  offsetY: 0,
});

let current = Object.freeze({
  themeId: null,
  payload: NONE_PAYLOAD,
  generation: 0,
});
let repositionFloatingSurfaces = null;

function themeIdOf(theme) {
  return theme && typeof theme._id === "string" ? theme._id : null;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return NONE_PAYLOAD;
  const id = typeof payload.id === "string" ? payload.id : "none";
  if (id === "none") return NONE_PAYLOAD;
  if (
    typeof payload.assetFile !== "string"
    || !payload.assetFile
    || !Number.isFinite(payload.aspect)
    || payload.aspect <= 0
    || !Number.isFinite(payload.widthScale)
    || payload.widthScale <= 0
    || !Number.isFinite(payload.offsetY)
  ) {
    return NONE_PAYLOAD;
  }
  return Object.freeze({
    id,
    assetFile: payload.assetFile,
    aspect: payload.aspect,
    widthScale: payload.widthScale,
    offsetY: payload.offsetY,
  });
}

function payloadEquals(a, b) {
  return !!(
    a && b
    && a.id === b.id
    && a.assetFile === b.assetFile
    && a.aspect === b.aspect
    && a.widthScale === b.widthScale
    && a.offsetY === b.offsetY
  );
}

function commitPetAccessoryPayload(payload, theme = null) {
  const themeId = themeIdOf(theme);
  const normalized = normalizePayload(payload);
  if (current.themeId === themeId && payloadEquals(current.payload, normalized)) {
    return current;
  }
  current = Object.freeze({
    themeId,
    payload: normalized,
    generation: current.generation + 1,
  });
  return current;
}

function getPetAccessoryPayloadSnapshot(theme = null) {
  if (theme && current.themeId !== themeIdOf(theme)) return null;
  return current;
}

function setPetAccessoryFloatingSurfaceRepositioner(fn) {
  repositionFloatingSurfaces = typeof fn === "function" ? fn : null;
}

function repositionPetAccessoryFloatingSurfaces() {
  if (typeof repositionFloatingSurfaces !== "function") return;
  return repositionFloatingSurfaces();
}

// Reads the outcome of a native hit-window sync. syncHitWin() reports
// {applied, deferred}; "deferred" (mid-drag, windows not up yet, transient
// sliver rect) is normal and must be retried rather than logged as a failure.
// Callers and test doubles that predate the contract return undefined — those
// are taken at face value as applied, so only an explicit signal means failure.
function describeGeometrySync(result) {
  if (result === false) return { applied: false, deferred: false };
  if (result && typeof result === "object") {
    return { applied: !!result.applied, deferred: !!result.deferred };
  }
  return { applied: true, deferred: false };
}

function resetPetAccessoryStateForTests() {
  current = Object.freeze({
    themeId: null,
    payload: NONE_PAYLOAD,
    generation: 0,
  });
  repositionFloatingSurfaces = null;
}

module.exports = {
  NONE_PAYLOAD,
  describeGeometrySync,
  commitPetAccessoryPayload,
  getPetAccessoryPayloadSnapshot,
  setPetAccessoryFloatingSurfaceRepositioner,
  repositionPetAccessoryFloatingSurfaces,
  resetPetAccessoryStateForTests,
};
