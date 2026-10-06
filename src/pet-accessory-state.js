"use strict";

const NONE_PAYLOAD = Object.freeze({
  id: "none",
  assetFile: null,
  aspect: 1,
  widthScale: 1,
  offsetY: 0,
});

function emptyPayloads() {
  return Object.freeze({ head: NONE_PAYLOAD, mouth: NONE_PAYLOAD });
}

let current = Object.freeze({
  themeId: null,
  payloads: emptyPayloads(),
  accessoryGeneration: 0,
});
let nextAccessoryGeneration = 0;
let issuedCandidates = new WeakSet();
let issuedDeliveries = new WeakSet();
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

function createPetAccessorySlotsCandidate(payloads, theme = null) {
  const themeId = themeIdOf(theme);
  const normalizedPayloads = Object.freeze({
    head: normalizePayload(payloads && payloads.head),
    mouth: normalizePayload(payloads && payloads.mouth),
  });
  const candidate = Object.freeze({
    themeId,
    payloads: normalizedPayloads,
    accessoryGeneration: ++nextAccessoryGeneration,
  });
  issuedCandidates.add(candidate);
  return candidate;
}

function payloadEquals(a, b) {
  return !!(a && b
    && a.id === b.id
    && a.assetFile === b.assetFile
    && a.aspect === b.aspect
    && a.widthScale === b.widthScale
    && a.offsetY === b.offsetY);
}

function preparePetAccessorySlotsDelivery(payloads, theme = null) {
  const themeId = themeIdOf(theme);
  const normalizedPayloads = Object.freeze({
    head: normalizePayload(payloads && payloads.head),
    mouth: normalizePayload(payloads && payloads.mouth),
  });
  const canReuseCurrent = current.themeId === themeId
    && payloadEquals(current.payloads.head, normalizedPayloads.head)
    && payloadEquals(current.payloads.mouth, normalizedPayloads.mouth);
  const delivery = Object.freeze({
    snapshot: canReuseCurrent
      ? current
      : createPetAccessorySlotsCandidate(normalizedPayloads, theme),
    needsCommit: !canReuseCurrent,
  });
  issuedDeliveries.add(delivery);
  return delivery;
}

function finalizePetAccessorySlotsDelivery(delivery, delivered) {
  if (!delivery || !issuedDeliveries.has(delivery)) {
    throw new Error("pet accessory delivery must be prepared by canonical state");
  }
  if (delivered !== true) return false;
  if (delivery.needsCommit) commitPetAccessorySlotsCandidate(delivery.snapshot);
  return delivery.snapshot;
}

function commitPetAccessorySlotsCandidate(candidate) {
  if (!candidate || !issuedCandidates.has(candidate)) {
    throw new Error("pet accessory commit requires an issued candidate snapshot");
  }
  if (candidate.accessoryGeneration < current.accessoryGeneration) return current;
  current = candidate;
  return current;
}

function getPetAccessorySlotsSnapshot(theme = null) {
  if (theme && current.themeId !== themeIdOf(theme)) return null;
  return current;
}

// Compatibility wrappers for head-only callers while production migrates to
// atomic two-slot candidates. New code must use the slots APIs above.
function commitPetAccessoryPayload(payload, theme = null) {
  const sameTheme = current.themeId === themeIdOf(theme);
  const candidate = createPetAccessorySlotsCandidate({
    head: payload,
    mouth: sameTheme ? current.payloads.mouth : NONE_PAYLOAD,
  }, theme);
  return commitPetAccessorySlotsCandidate(candidate);
}

function getPetAccessoryPayloadSnapshot(theme = null) {
  const snapshot = getPetAccessorySlotsSnapshot(theme);
  if (!snapshot) return null;
  return Object.freeze({
    themeId: snapshot.themeId,
    payload: snapshot.payloads.head,
    generation: snapshot.accessoryGeneration,
  });
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
    payloads: emptyPayloads(),
    accessoryGeneration: 0,
  });
  nextAccessoryGeneration = 0;
  issuedCandidates = new WeakSet();
  issuedDeliveries = new WeakSet();
  repositionFloatingSurfaces = null;
}

module.exports = {
  NONE_PAYLOAD,
  describeGeometrySync,
  createPetAccessorySlotsCandidate,
  preparePetAccessorySlotsDelivery,
  finalizePetAccessorySlotsDelivery,
  commitPetAccessorySlotsCandidate,
  getPetAccessorySlotsSnapshot,
  commitPetAccessoryPayload,
  getPetAccessoryPayloadSnapshot,
  setPetAccessoryFloatingSurfaceRepositioner,
  repositionPetAccessoryFloatingSurfaces,
  resetPetAccessoryStateForTests,
};
