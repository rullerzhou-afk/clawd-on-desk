// --- Render window: pure view (SVG rendering + eye tracking) ---
// All input (pointer/drag/click) is handled by the hit window (hit-renderer.js).
// Reactions are triggered via IPC from main (relayed from hit window).

const container = document.getElementById("pet-container");
const clipLayer = document.getElementById("pet-clip");
const facingStage = document.getElementById("pet-facing-stage") || container;
const motionStage = document.getElementById("pet-motion-stage") || container;
const assetDirectionStage = document.getElementById("pet-asset-direction-stage") || container;
const mediaLayer = document.getElementById("pet-media-layer") || container;
const accessoryLayer = document.getElementById("pet-accessory-layer") || container;
const particleLayer = document.getElementById("pet-particle-layer") || container;
const accessoryEl = document.getElementById("clawd-accessory");
const mouthAccessoryEl = document.getElementById("clawd-mouth-accessory");
const accessoryLayout = globalThis.petAccessoryLayout || null;
const accessoryDescriptor = globalThis.petAccessoryDescriptor || null;
const visualSwapPolicy = globalThis.petVisualSwapPolicy || {};
let clawdEl = document.getElementById("clawd");
let pendingNext = null;
const LOW_POWER_IDLE_PAUSE_MS = 5000;
const SWAP_LOAD_FALLBACK_MS = visualSwapPolicy.SWAP_LOAD_FALLBACK_MS || 3000;
const ACCESSORY_SETTLE_TIMEOUT_MS = visualSwapPolicy.ACCESSORY_SETTLE_TIMEOUT_MS || 3000;
const SWAP_VISIBILITY_RESCUE_BUFFER_MS = visualSwapPolicy.SWAP_VISIBILITY_RESCUE_BUFFER_MS || 750;
const EYE_ATTACH_RETRY_MS = 16;
const EYE_ATTACH_MAX_ATTEMPTS = 60;
const WAKE_OBJECT_RELOAD_RETRIES = 1;
const LOW_POWER_PAUSE_STYLE_ID = "clawd-low-power-pause-svg";
const LOW_POWER_PAUSE_STATES = new Set(["idle", "mini-idle", "dozing"]);
const LOW_POWER_BOUNDARY_EPSILON_MS = 80;
const CLOUDLING_POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);
const CODEX_PET_VISUAL_BY_FILE = Object.freeze({
  "codex-pet-idle-loop.svg": "idle-loop",
  "codex-pet-idle-static.svg": "idle-static",
  "codex-pet-waving-loop.svg": "waving-loop",
  "codex-pet-waving-once.svg": "waving-once",
  "codex-pet-jumping-loop.svg": "jumping-loop",
  "codex-pet-jumping-once.svg": "jumping-once",
  "codex-pet-failed-loop.svg": "failed-loop",
  "codex-pet-waiting-loop.svg": "waiting-loop",
  "codex-pet-running-loop.svg": "running-loop",
  "codex-pet-review-loop.svg": "review-loop",
  "codex-pet-drag-directional-loop.svg": "drag-directional",
});
let lowPowerIdleMode = false;
let lowPowerIdlePauseTimer = null;
let lowPowerSvgPaused = false;
let lastSystemWakeId = null;
let lastSystemWakeStatus = null;
let pendingSystemWakeId = null;
let queuedSystemWakePayload = null;
let queuedSystemWakeReplayTimer = null;
let _lowPowerStaticImageOverrides = {};
let _petTintPayload = { id: "none", filter: "" };
let _petTintSupported = false;
const ACCESSORY_SLOT_NAMES = Object.freeze(["head", "mouth"]);
function createAccessorySlotRuntime(element) {
  return {
    element,
    supported: false,
    attachments: null,
    payload: { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 },
    assetFile: null,
    assetReady: false,
    assetSettled: true,
    assetLoadTimer: null,
    assetWaiters: [],
    raf: null,
    lastLayout: null,
    followKey: null,
    pausedRoot: null,
    documentPaused: false,
    diagnostics: new Set(),
  };
}
const _accessorySlots = {
  head: createAccessorySlotRuntime(accessoryEl),
  mouth: createAccessorySlotRuntime(mouthAccessoryEl),
};
let _accessoryThemeId = null;
let _lastAccessoryGeneration = 0;
const PET_TINT_FILTER_TOKEN_RE =
  /^(?:hue-rotate\(-?\d+(?:\.\d+)?deg\)|(?:saturate|brightness|contrast|sepia|grayscale)\(\d+(?:\.\d+)?\))$/;

// ── Theme config (injected via preload.js additionalArguments) ──
let tc = window.themeConfig || {};

function initWithConfig(cfg) {
  tc = cfg || {};
  _viewBox = tc.viewBox || { x: -15, y: -25, width: 45, height: 45 };
  _layout = tc.layout || null;
  _assetsPath = tc.assetsPath || "../assets/svg";
  _sourceAssetsPath = tc.sourceAssetsPath || null;
  _eyeIds = (tc.eyeTracking && tc.eyeTracking.ids) || { eyes: "eyes-js", body: "body-js", shadow: "shadow-js", dozeEyes: "eyes-doze" };
  _bodyScale = (tc.eyeTracking && tc.eyeTracking.bodyScale) || 0.33;
  _shadowStretch = (tc.eyeTracking && tc.eyeTracking.shadowStretch) || 0.15;
  _shadowShift = (tc.eyeTracking && tc.eyeTracking.shadowShift) || 0.3;
  _eyeTrackingStates = (tc.eyeTrackingStates) || ["idle", "dozing", "mini-idle"];
  _trustedScriptedSvgFiles = new Set(Array.isArray(tc.trustedScriptedSvgFiles) ? tc.trustedScriptedSvgFiles : []);
  _forceSvgObjectChannel = !!(tc.rendering && tc.rendering.svgChannel === "object");
  _objectChannelFiles = new Set(
    tc.rendering && Array.isArray(tc.rendering.objectChannelFiles)
      ? tc.rendering.objectChannelFiles
      : []
  );
  _lowPowerStaticImageOverrides = (tc.rendering && tc.rendering.lowPowerStaticImageOverrides) || {};
  _petTintSupported = tc.petTintSupported === true;
  if (Object.prototype.hasOwnProperty.call(tc, "petTintPayload")) {
    _petTintPayload = normalizePetTintPayload(tc.petTintPayload);
  }
  const configuredSlots = tc.accessorySlots && typeof tc.accessorySlots === "object"
    ? tc.accessorySlots
    : null;
  _accessoryThemeId = configuredSlots
    && (configuredSlots.themeId === null || typeof configuredSlots.themeId === "string")
    ? configuredSlots.themeId
    : null;
  _lastAccessoryGeneration = configuredSlots
    && Number.isSafeInteger(configuredSlots.accessoryGeneration)
    && configuredSlots.accessoryGeneration >= 0
    ? configuredSlots.accessoryGeneration
    : 0;
  for (const slotName of ACCESSORY_SLOT_NAMES) {
    const slot = _accessorySlots[slotName];
    const configured = configuredSlots && configuredSlots[slotName];
    const legacyHead = slotName === "head" && !configuredSlots;
    slot.supported = configured
      ? configured.supported === true
      : (legacyHead && tc.accessorySupported === true);
    slot.attachments = slot.supported
      ? ((configured && configured.attachments) || (legacyHead && tc.accessoryAttachments) || null)
      : null;
    slot.payload = normalizeAccessoryPayload(
      (configured && configured.payload) || (legacyHead && tc.accessoryPayload)
    );
  }
  _imgCacheBustSeq = 0;
  _miniViewBox = tc.miniModeViewBox || null;
  _fileViewBoxes = tc.fileViewBoxes || {};
  _dragSvg = tc.dragSvg || null;
  _dragSvgs = tc.dragSvgs || {};
  isDragReacting = false;
  currentDragSvg = null;
  currentDragDirection = null;
  _idleFollowSvg = tc.idleFollowSvg || "clawd-idle-follow.svg";
  // Pre-IPC first frame rests on the user-selected idle visual when one is set.
  _initialIdleSvg = tc.idleDefaultVisual || _idleFollowSvg;
  _glyphFlipDefs = tc.glyphFlips || { "pixel-z": 4, "pixel-z-small": 3 };

  // Layered tracking: detect if theme uses multi-layer config
  _useLayeredTracking = !!(tc.eyeTracking && tc.eyeTracking.trackingLayers);
  _trackingLayersConfig = _useLayeredTracking ? tc.eyeTracking.trackingLayers : null;
  _themeMaxOffset = (tc.eyeTracking && tc.eyeTracking.maxOffset) || 20;

  // objectScale — applied via element.style in swapToFile() (CSP blocks <style> injection)
  const os = tc.objectScale || { widthRatio: 1.9, heightRatio: 1.3, offsetX: -0.45, offsetY: -0.25 };
  _objectScaleCSS = {
    width:  `${os.widthRatio * 100}%`,
    height: `${os.heightRatio * 100}%`,
    imgWidthBase: (os.imgWidthRatio || os.widthRatio) * 100,
    left:   `${os.offsetX * 100}%`,
    imgLeft: `${(os.imgOffsetX != null ? os.imgOffsetX : os.offsetX) * 100}%`,
    // Unified bottom-anchored positioning for both <object> and <img>
    // Theme can override objBottom directly; otherwise derive from offsetY + heightRatio
    objBottom: `${(os.objBottom != null ? os.objBottom : (1 - os.offsetY - os.heightRatio)) * 100}%`,
    imgBottom: `${(os.imgBottom != null ? os.imgBottom : 0.05) * 100}%`,
  };
  _fileScales = os.fileScales || {};
  _fileOffsets = os.fileOffsets || {};
  _transitions = tc.transitions || {};
  _miniFlipAssets = !!tc.miniFlipAssets;
  _hasRoamVisual = !!tc.hasRoamVisual;
  _roamFlipAssets = !!tc.roamFlipAssets;
  _rightSideMirrorFiles = Array.isArray(tc.rightSideMirrorFiles) ? tc.rightSideMirrorFiles : [];

  applyObjectScaleStyle(clawdEl, getObjectSvgName(clawdEl), null);
  applyObjectScaleStyle(pendingNext, getObjectSvgName(pendingNext), null);
  for (const slotName of ACCESSORY_SLOT_NAMES) {
    const slot = _accessorySlots[slotName];
    if (slot.supported && slot.payload.id !== "none") ensureAccessoryAsset(slotName);
  }
}

function applyObjectScaleStyle(el, file, state) {
  if (!el || !_objectScaleCSS) return;
  if (shouldUseNormalizedLayout(file, state)) {
    applyNormalizedLayoutStyle(el, file, state);
    return;
  }
  const fo = (file && _fileOffsets[file]) || null;
  const ox = fo ? fo.x : 0;
  const oy = fo ? fo.y : 0;

  // Unified bottom-anchored positioning: both <object> and <img> use bottom + oy
  if (el.tagName === "IMG") {
    const scale = (file && _fileScales[file]) || 1.0;
    el.style.width = `${_objectScaleCSS.imgWidthBase * scale}%`;
    el.style.height = "auto";
    el.style.left = `calc(${_objectScaleCSS.imgLeft} + ${ox}px)`;
    el.style.top = "auto";
    el.style.bottom = `calc(${_objectScaleCSS.imgBottom || "5%"} + ${oy + _viewportOffsetY}px)`;
  } else {
    el.style.width = _objectScaleCSS.width;
    el.style.height = _objectScaleCSS.height;
    el.style.left = `calc(${_objectScaleCSS.left} + ${ox}px)`;
    el.style.top = "auto";
    el.style.bottom = `calc(${_objectScaleCSS.objBottom} + ${oy + _viewportOffsetY}px)`;
  }
}

function getObjectSvgRoot(objectEl) {
  if (!objectEl || objectEl.tagName !== "OBJECT") return null;
  try {
    const svgDoc = objectEl.contentDocument;
    return svgDoc ? svgDoc.documentElement : null;
  } catch {
    return null;
  }
}

function getCurrentSvgRoot() {
  return getObjectSvgRoot(clawdEl);
}

function setSvgRootLowPowerPaused(root, paused) {
  if (!root) return false;
  try {
    const svgDoc = root.ownerDocument;
    const existingStyle = svgDoc && svgDoc.getElementById(LOW_POWER_PAUSE_STYLE_ID);
    if (paused) {
      if (!existingStyle && svgDoc) {
        const style = svgDoc.createElementNS("http://www.w3.org/2000/svg", "style");
        style.id = LOW_POWER_PAUSE_STYLE_ID;
        style.textContent = `
          *, *::before, *::after {
            animation-play-state: paused !important;
            transition-property: none !important;
          }
        `;
        root.appendChild(style);
      }
      if (typeof root.pauseAnimations === "function") root.pauseAnimations();
    } else {
      if (existingStyle) existingStyle.remove();
      if (typeof root.unpauseAnimations === "function") root.unpauseAnimations();
    }
    return true;
  } catch {
    return false;
  }
}

function setAccessorySvgLowPowerPaused(slotName, paused) {
  const slot = _accessorySlots[slotName];
  if (!slot || !slot.element || slot.element.tagName !== "OBJECT") return false;
  const root = getObjectSvgRoot(slot.element);
  if (!root) return false;
  const next = !!paused;
  if (slot.pausedRoot === root && slot.documentPaused === next) return true;
  if (!setSvgRootLowPowerPaused(root, next)) return false;
  slot.pausedRoot = root;
  slot.documentPaused = next;
  return true;
}

function syncAccessorySvgLowPowerPaused(paused) {
  for (const slotName of ACCESSORY_SLOT_NAMES) {
    const slot = getAccessorySlot(slotName);
    const hidden = !!(slot && slot.element && slot.element.style.display === "none");
    setAccessorySvgLowPowerPaused(slotName, paused || hidden);
  }
}

function setCurrentScriptedSvgLowPowerPaused(paused) {
  const target = clawdEl;
  if (!target || target.tagName !== "OBJECT") return;
  try {
    const fn = target.contentWindow && target.contentWindow.__clawdSetLowPowerPaused;
    if (typeof fn === "function") fn(!!paused);
  } catch {}
}

function shouldPauseForLowPower() {
  if (isReacting || isDragReacting) return false;
  return lowPowerIdleMode && LOW_POWER_PAUSE_STATES.has(currentState);
}

function shouldSuppressPassiveTrackingForLowPower() {
  return lowPowerIdleMode && lowPowerSvgPaused && shouldPauseForLowPower();
}

function setLowPowerSvgPaused(paused) {
  const next = !!paused;
  if (lowPowerSvgPaused === next) return;
  lowPowerSvgPaused = next;
  if (next) {
    _cancelLayerAnimLoop();
    for (const slotName of ACCESSORY_SLOT_NAMES) cancelAccessoryFollow(slotName);
  } else {
    refreshAccessoryLayout();
  }
  syncAccessorySvgLowPowerPaused(next);
  if (window.electronAPI && typeof window.electronAPI.setLowPowerIdlePaused === "function") {
    window.electronAPI.setLowPowerIdlePaused(next);
  }
}

function getLowPowerAnimationBoundaryDelayMs(root) {
  if (!root || typeof root.getAnimations !== "function") return 0;
  let animations = [];
  try {
    animations = root.getAnimations({ subtree: true });
  } catch {
    return 0;
  }

  let delayMs = 0;
  for (const animation of animations) {
    if (!animation || animation.playState === "paused" || animation.playState === "finished") continue;
    const effect = animation.effect;
    if (!effect || typeof effect.getComputedTiming !== "function") continue;

    let timing = null;
    try {
      timing = effect.getComputedTiming();
    } catch {
      continue;
    }
    if (!timing) continue;

    const localTime = Number.isFinite(timing.localTime)
      ? timing.localTime
      : (Number.isFinite(animation.currentTime) ? animation.currentTime : null);
    if (!Number.isFinite(localTime) || localTime < 0) continue;

    const activeDuration = Number.isFinite(timing.activeDuration)
      ? timing.activeDuration
      : (Number.isFinite(timing.endTime) ? timing.endTime : null);
    if (Number.isFinite(activeDuration) && activeDuration > localTime) {
      delayMs = Math.max(delayMs, activeDuration - localTime);
      continue;
    }

    const duration = Number.isFinite(timing.duration) ? timing.duration : null;
    if (!Number.isFinite(duration) || duration <= 0) continue;

    let direction = timing.direction || "";
    try {
      const rawTiming = typeof effect.getTiming === "function" ? effect.getTiming() : null;
      if (rawTiming && rawTiming.direction) direction = rawTiming.direction;
    } catch {}
    const loopDuration = duration * ((direction === "alternate" || direction === "alternate-reverse") ? 2 : 1);
    const progress = localTime % loopDuration;
    const remaining = progress <= LOW_POWER_BOUNDARY_EPSILON_MS ? 0 : loopDuration - progress;
    delayMs = Math.max(delayMs, remaining);
  }
  return delayMs > LOW_POWER_BOUNDARY_EPSILON_MS ? Math.ceil(delayMs) : 0;
}

function pauseCurrentSvgForLowPower({ waitForBoundary = false } = {}) {
  if (!shouldPauseForLowPower()) return;
  const root = getCurrentSvgRoot();
  if (root && waitForBoundary) {
    const delayMs = getLowPowerAnimationBoundaryDelayMs(root);
    if (delayMs > 0) {
      lowPowerIdlePauseTimer = setTimeout(() => {
        lowPowerIdlePauseTimer = null;
        pauseCurrentSvgForLowPower();
      }, delayMs);
      return;
    }
  }
  setSvgRootLowPowerPaused(root, true);
  setCurrentScriptedSvgLowPowerPaused(true);
  setLowPowerSvgPaused(true);
}

function resumeCurrentSvgForLowPower() {
  if (lowPowerIdlePauseTimer) {
    clearTimeout(lowPowerIdlePauseTimer);
    lowPowerIdlePauseTimer = null;
  }
  const root = getCurrentSvgRoot();
  setSvgRootLowPowerPaused(root, false);
  setCurrentScriptedSvgLowPowerPaused(false);
  setLowPowerSvgPaused(false);
}

function hasLowPowerPauseStyle(root = getCurrentSvgRoot()) {
  if (!root) return false;
  try {
    const svgDoc = root.ownerDocument;
    return !!(svgDoc && svgDoc.getElementById(LOW_POWER_PAUSE_STYLE_ID));
  } catch {
    return false;
  }
}

function scheduleLowPowerIdlePause() {
  if (lowPowerIdlePauseTimer) {
    clearTimeout(lowPowerIdlePauseTimer);
    lowPowerIdlePauseTimer = null;
  }
  if (!shouldPauseForLowPower()) {
    resumeCurrentSvgForLowPower();
    return;
  }
  lowPowerIdlePauseTimer = setTimeout(() => {
    lowPowerIdlePauseTimer = null;
    pauseCurrentSvgForLowPower({ waitForBoundary: true });
  }, LOW_POWER_IDLE_PAUSE_MS);
}

function noteLowPowerActivity() {
  if (!lowPowerIdleMode && !lowPowerSvgPaused) return;
  if (lowPowerSvgPaused) {
    resumeCurrentSvgForLowPower();
  }
  scheduleLowPowerIdlePause();
}

function setLowPowerIdleMode(enabled) {
  lowPowerIdleMode = !!enabled;
  if (lowPowerIdleMode) {
    scheduleLowPowerIdlePause();
  } else {
    resumeCurrentSvgForLowPower();
  }
}

function isSvgFile(file) {
  return typeof file === "string" && file.toLowerCase().endsWith(".svg");
}

function resolveViewBox(state, file) {
  if (file && _fileViewBoxes && _fileViewBoxes[file]) return _fileViewBoxes[file];
  if (state && state.startsWith("mini-") && _miniViewBox) return _miniViewBox;
  return _viewBox;
}

function viewBoxEquals(a, b) {
  return !!(a && b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height);
}

function hasRootViewBoxFileOverride(file) {
  return !!(file && _fileViewBoxes && viewBoxEquals(_fileViewBoxes[file], _viewBox));
}

function shouldUseNormalizedLayout(file, state) {
  if (!_layout || !_layout.contentBox) return false;
  if (_inMiniMode) return false;
  if (hasRootViewBoxFileOverride(file)) return true;
  if ((state && state.startsWith("mini-")) || (file && file.startsWith("mini-"))) return false;
  return true;
}

function applyNormalizedLayoutStyle(el, file, state) {
  const viewBox = resolveViewBox(state, file);
  if (!el || !_layout || !_layout.contentBox || !viewBox) return;
  const fo = (file && _fileOffsets[file]) || null;
  const ox = fo ? fo.x : 0;
  const oy = fo ? fo.y : 0;
  const scale = (file && _fileScales[file]) || 1.0;
  const cb = _layout.contentBox;
  const centerX = _layout.centerX != null ? _layout.centerX : (cb.x + cb.width / 2);
  const baselineY = _layout.baselineY != null ? _layout.baselineY : (cb.y + cb.height);
  const unitRatio = ((_layout.visibleHeightRatio || 0.58) * scale) / cb.height;
  const widthRatio = viewBox.width * unitRatio;
  const heightRatio = viewBox.height * unitRatio;
  const leftRatio = (_layout.centerXRatio != null ? _layout.centerXRatio : 0.5)
    - ((centerX - viewBox.x) * unitRatio);
  const bottomRatio = (_layout.baselineBottomRatio != null ? _layout.baselineBottomRatio : 0.05)
    - ((viewBox.y + viewBox.height - baselineY) * unitRatio);

  if (el.tagName === "IMG") {
    el.style.width = `${widthRatio * 100}%`;
    el.style.height = "auto";
    el.style.left = `calc(${leftRatio * 100}% + ${ox}px)`;
    el.style.top = "auto";
    el.style.bottom = `calc(${bottomRatio * 100}% + ${oy + _viewportOffsetY}px)`;
  } else {
    el.style.width = `${widthRatio * 100}%`;
    el.style.height = `${heightRatio * 100}%`;
    el.style.left = `calc(${leftRatio * 100}% + ${ox}px)`;
    el.style.top = "auto";
    el.style.bottom = `calc(${bottomRatio * 100}% + ${oy + _viewportOffsetY}px)`;
  }
}

let _assetsPath;
let _sourceAssetsPath;
let _viewBox;
let _layout;
let _eyeIds;
let _bodyScale;
let _shadowStretch;
let _shadowShift;
let _eyeTrackingStates;
let _trustedScriptedSvgFiles = new Set();
let _forceSvgObjectChannel = false;
let _objectChannelFiles = new Set();
let _imgCacheBustSeq = 0;
let _miniViewBox = null;
let _fileViewBoxes = {};
let _dragSvg;
let _dragSvgs;
let isDragReacting = false;
let currentDragSvg = null;
let currentDragDirection = null;
const directionalDragBridgeWarnings = new Set();
const codexPetVisualBridgeWarnings = new Set();
let _idleFollowSvg;
let _initialIdleSvg;
let _glyphFlipDefs;
let _objectScaleCSS;
let _fileScales = {};
let _fileOffsets = {};
let _transitions = {};  // per-file fade config: { "file.apng": { in: 400, out: 400 } }
let _miniFlipAssets = false; // theme's mini assets drawn in reverse direction
let _hasRoamVisual = false;  // theme binds a dedicated roam visual (≠ idle)
let _roamFlipAssets = false; // theme's roam visual is drawn facing left, not right
let _roamHeadingLeft = false; // current walk direction; roam visuals are drawn facing right
let _rightSideMirrorFiles = []; // idle animations mirrored while the pet sits on the right half
let _petOnRightSide = false;
let _inMiniMode = false;
let _miniPreEntryMode = false;
let _viewportOffsetY = 0;
let _viewportOffsetX = 0;

function setViewportOffset(offsetY) {
  const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
  if (next === _viewportOffsetY) return;
  _viewportOffsetY = next;
  applyObjectScaleStyle(clawdEl, currentDisplayedSvg, currentState);
  if (pendingNext) {
    applyObjectScaleStyle(pendingNext, getObjectSvgName(pendingNext), currentState);
  }
  refreshAccessoryLayout();
}

// Issue #690: Linux outer-edge X offset. Deliberately the mirror image of
// setViewportOffset() above in every way that matters — this is
// composite-only. It must NOT call applyObjectScaleStyle() or
// refreshAccessoryLayout(), and must NOT touch any element's `left`/`bottom` —
// those are the Y-offset layout hot path (plan §4.4 point 4), and re-entering
// it per X-offset update is exactly the per-frame stall #690's plan warns
// about for mini's future animation entry point. #pet-container (this
// function's only target) is the real screen-space layer the plan's DOM
// layering puts the signed X translate on: `#pet-clip` (unmoved, carries the
// internal-seam clip-path) -> `#pet-container` (this translate) ->
// `#pet-facing-stage` (carries the separate mini-left mirror `scale: -1 1`,
// src/styles.css). Because the flip lives on the child, not this element,
// the translate here is never re-signed by it, and every descendant —
// current/pending media, accessory, effect/particle, Cloudling pointer bridge
// — inherits the shift for free by being painted inside the translated box.
function setViewportOffsetX(offsetX) {
  const next = Number.isFinite(offsetX) ? Math.round(offsetX) : 0;
  if (next === _viewportOffsetX) return;
  _viewportOffsetX = next;
  if (container) container.style.translate = `${_viewportOffsetX}px 0`;
}

// Shared with the main process's hit geometry via src/pet-accessory-mirror.js
// so the two sides cannot drift apart.
function miniFlipContext() {
  return {
    hasRoamVisual: _hasRoamVisual,
    roamHeadingLeft: _roamHeadingLeft,
    roamFlipAssets: _roamFlipAssets,
    file: currentDisplayedSvg,
    petOnRightSide: _petOnRightSide,
    rightSideMirrorFiles: _rightSideMirrorFiles,
    miniFlipAssets: _miniFlipAssets,
    inMiniMode: _inMiniMode,
    miniPreEntryMode: _miniPreEntryMode,
    miniLeftFlip,
  };
}

function shouldApplyMiniAssetFlip(state) {
  return petAccessoryMirror.shouldFlipAssetDirection(state, miniFlipContext());
}

// Main owns the native hit window but cannot see either flip stage, so it used
// to re-derive the accessory's facing from mini edge + theme flags — which got
// free roam and the mini walk-in wrong, because neither is gated on miniMode.
// Report the composed answer instead. #pet-facing-stage (.mini-left) and
// #pet-asset-direction-stage both wrap #pet-accessory-layer, so the accessory
// ends up mirrored exactly when the two stages disagree.
let _reportedAccessoryMirror = null;
function reportAccessoryMirror(mirrored) {
  const next = !!mirrored;
  if (_reportedAccessoryMirror === next) return;
  try {
    window.electronAPI.reportAccessoryMirror(next);
  } catch {
    // Memo only a delivered value: remembering a send that never landed would
    // dedupe every later attempt and strand main on the stale facing.
    return;
  }
  _reportedAccessoryMirror = next;
}

function applyMiniFlip(el, state = currentState) {
  if (!assetDirectionStage || !assetDirectionStage.style) return;
  const activeFlip = shouldApplyMiniAssetFlip(state);
  if (el) el.__clawdAssetDirectionFlip = activeFlip;
  assetDirectionStage.style.scale = activeFlip ? "-1 1" : "none";
  reportAccessoryMirror(petAccessoryMirror.isAccessoryMirrored(state, miniFlipContext()));

  // A media crossfade can leave older children alive after the shared stage
  // adopts the new file's direction. Counter-flip only those older children
  // whose stamped direction differs, using the stage's horizontal center so
  // their fading position and orientation stay visually unchanged.
  const stageWidth = assetDirectionStage.clientWidth || assetDirectionStage.offsetWidth;
  for (const child of getPetMediaElements()) {
    const childFlip = child === el
      ? activeFlip
      : child.__clawdAssetDirectionFlip === true;
    if (childFlip === activeFlip) {
      child.style.scale = "none";
      child.style.transformOrigin = "";
      continue;
    }
    const originX = Number.isFinite(stageWidth) && Number.isFinite(child.offsetLeft)
      ? (stageWidth / 2) - child.offsetLeft
      : null;
    child.style.transformOrigin = originX == null ? "50% 50%" : `${originX}px 50%`;
    child.style.scale = "-1 1";
  }
}

// ── Layered tracking state (multi-layer eye/head/body tracking) ──
let _useLayeredTracking = false;
let _trackingLayersConfig = null;  // raw config from theme.json
let _themeMaxOffset = 20;          // theme-level maxOffset for normalization
let _trackingLayers = null;        // { name: { wrappers: [], maxOffset, ease, x, y } }
let _layerTargetDx = 0;           // raw dx from tick.js (scaled to _themeMaxOffset)
let _layerTargetDy = 0;           // raw dy from tick.js
let _layerAnimFrame = null;        // requestAnimationFrame handle
let _layeredTrackingObj = null;    // the <object> element currently tracked (guard against re-init)
let _layeredTrackingDocument = null;
const LAYER_SETTLE_EPSILON = 0.02;

initWithConfig(tc);

// Theme switch: reload + IPC push overrides additionalArguments
window.electronAPI.onThemeConfig((newConfig) => {
  // Clean up layered tracking before reinitializing
  _cleanupLayeredTracking();
  cancelPendingSwap("theme-config");
  clearAllAccessoryRuntimes({ clearAsset: true });
  initWithConfig(newConfig);
  applyPetTintToAllMedia();
});

window.electronAPI.onViewportOffset((offsetY) => {
  setViewportOffset(offsetY);
});

window.electronAPI.onViewportOffsetX((offsetX) => {
  setViewportOffsetX(offsetX);
});

// ── Pet color tint ──
// Main resolves a persisted catalog id to this small payload. The renderer
// still rejects URL/variable/custom CSS syntax before projecting the filter
// onto every live pet media element (current, pending, and fading-out).
function isSafePetTintFilter(value) {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 240) return false;
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((token) => PET_TINT_FILTER_TOKEN_RE.test(token));
}

function normalizePetTintPayload(payload) {
  if (!payload || typeof payload !== "object") return { id: "none", filter: "" };
  const id = typeof payload.id === "string" ? payload.id : "";
  const filter = typeof payload.filter === "string" ? payload.filter.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return { id: "none", filter: "" };
  if (!isSafePetTintFilter(filter)) return { id: "none", filter: "" };
  if (id === "none") return filter === "" ? { id, filter } : { id: "none", filter: "" };
  if (!filter) return { id: "none", filter: "" };
  return { id, filter };
}

function applyPetTintToElement(element) {
  if (!element) return;
  const isPetObject = element.tagName === "OBJECT"
    && element.classList
    && element.classList.contains("clawd-object");
  const isPetImg = element.tagName === "IMG"
    && element.classList
    && element.classList.contains("clawd-img");
  if (!isPetObject && !isPetImg) return;
  element.style.filter = _petTintSupported ? _petTintPayload.filter : "";
}

function applyPetTintToAllMedia() {
  for (const element of getPetMediaElements()) applyPetTintToElement(element);
}

function setPetTintPayload(payload) {
  _petTintPayload = normalizePetTintPayload(payload);
  applyPetTintToAllMedia();
}

if (window.electronAPI && typeof window.electronAPI.onPetTintChange === "function") {
  window.electronAPI.onPetTintChange(setPetTintPayload);
}

// ── Pet accessory wardrobe ──
// Accessories are a persistent sibling of pet media. They never enter an SVG
// document and never share the media filter or swap cleanup selector.
function normalizeAccessoryPayload(payload) {
  const none = {
    id: "none",
    assetFile: null,
    aspect: 1,
    widthScale: 1,
    offsetY: 0,
  };
  if (!payload || typeof payload !== "object") return none;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return none;
  if (id === "none") return none;
  const assetFile = typeof payload.assetFile === "string" ? payload.assetFile : "";
  if (!/^[a-z][a-z0-9-]{0,63}\.svg$/.test(assetFile)) return none;
  if (assetFile.includes("/") || assetFile.includes("\\")) return none;
  const aspect = payload.aspect;
  const widthScale = payload.widthScale;
  const offsetY = payload.offsetY;
  if (!Number.isFinite(aspect) || aspect < 0.1 || aspect > 10) return none;
  if (!Number.isFinite(widthScale) || widthScale < 0.25 || widthScale > 2.5) return none;
  if (!Number.isFinite(offsetY) || Math.abs(offsetY) > 64) return none;
  return { id, assetFile, aspect, widthScale, offsetY };
}

function getAccessorySlot(slotName) {
  return _accessorySlots[slotName] || null;
}

function cancelAccessoryFollow(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  if (slot.raf != null) {
    cancelAnimationFrame(slot.raf);
    slot.raf = null;
  }
  slot.followKey = null;
}

function hideAccessory(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  cancelAccessoryFollow(slotName);
  slot.lastLayout = null;
  if (!slot.element) return;
  slot.element.style.visibility = "hidden";
  // A document-backed accessory that is still loading must stay mounted;
  // otherwise a fast state change to a hidden pose can abort its first load
  // and leave the slot unable to recover when a visible pose returns.
  slot.element.style.display = (
    slot.element.tagName === "OBJECT" && !slot.assetSettled
  ) ? "block" : "none";
  slot.element.style.transform = "";
  // Hidden document-backed accessories must not keep advancing their SMIL
  // timeline behind a sprite that declares the slot hidden.
  setAccessorySvgLowPowerPaused(slotName, true);
}

function clearAccessoryAssetLoadTimer(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot || slot.assetLoadTimer == null) return;
  clearTimeout(slot.assetLoadTimer);
  slot.assetLoadTimer = null;
}

function flushAccessoryAssetWaiters(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  const waiters = slot.assetWaiters;
  slot.assetWaiters = [];
  for (const waiter of waiters) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.callback();
  }
}

function clearAccessoryRuntime(slotName, options = {}) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  hideAccessory(slotName);
  slot.diagnostics.clear();
  if (!options.clearAsset) return;
  clearAccessoryAssetLoadTimer(slotName);
  if (slot.element) {
    setAccessorySvgLowPowerPaused(slotName, false);
    slot.element.onload = null;
    slot.element.onerror = null;
    try {
      if (slot.element.tagName === "OBJECT") slot.element.data = "";
      else slot.element.src = "";
    } catch {}
  }
  slot.pausedRoot = null;
  slot.documentPaused = false;
  slot.assetFile = null;
  slot.assetReady = false;
  slot.assetSettled = true;
  flushAccessoryAssetWaiters(slotName);
}

function clearAllAccessoryRuntimes(options = {}) {
  for (const slotName of ACCESSORY_SLOT_NAMES) clearAccessoryRuntime(slotName, options);
}

function noteAccessoryDiagnostic(slotName, file, reason) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  const key = `${file || "unknown"}|${reason}`;
  if (slot.diagnostics.has(key)) return;
  slot.diagnostics.add(key);
  try { console.warn(`Clawd: ${slotName} accessory fallback for ${file || "unknown"}: ${reason}`); } catch {}
}

function getAccessoryDescriptor(slotName, file, state) {
  const slot = getAccessorySlot(slotName);
  if (!slot || !slot.supported || !slot.attachments || !file) return null;
  if (!accessoryDescriptor || typeof accessoryDescriptor.resolveAccessoryDescriptor !== "function") return null;
  return accessoryDescriptor.resolveAccessoryDescriptor({
    attachments: slot.attachments,
    slot: slotName,
    itemId: slot.payload.id,
    file: String(file).replace(/^.*[\/\\]/, ""),
    state,
  });
}

function getAccessoryStageSize() {
  const width = assetDirectionStage && (assetDirectionStage.clientWidth || assetDirectionStage.offsetWidth);
  const height = assetDirectionStage && (assetDirectionStage.clientHeight || assetDirectionStage.offsetHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function getMediaLayoutBox(media) {
  if (!media) return null;
  const x = media.offsetLeft;
  const y = media.offsetTop;
  const width = media.clientWidth || media.offsetWidth;
  const height = media.clientHeight || media.offsetHeight;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function ensureAccessoryAsset(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot || !slot.element || !slot.payload.assetFile) return false;
  const file = slot.payload.assetFile;
  if (slot.assetFile === file) return slot.assetReady;

  slot.assetFile = file;
  slot.assetReady = false;
  slot.assetSettled = false;
  // Chromium does not create an <object>'s nested SVG document while the
  // element is display:none. Keep document-backed accessories mounted but
  // visually hidden until their load event and first layout complete.
  slot.element.style.visibility = "hidden";
  slot.element.style.display = slot.element.tagName === "OBJECT" ? "block" : "none";
  slot.element.onload = () => {
    if (slot.assetFile !== file) return;
    clearAccessoryAssetLoadTimer(slotName);
    slot.assetReady = true;
    slot.assetSettled = true;
    if (lowPowerSvgPaused) setAccessorySvgLowPowerPaused(slotName, true);
    refreshAccessoryLayout(slotName);
    flushAccessoryAssetWaiters(slotName);
  };
  slot.element.onerror = () => {
    if (slot.assetFile !== file) return;
    clearAccessoryAssetLoadTimer(slotName);
    slot.assetReady = false;
    slot.assetSettled = true;
    hideAccessory(slotName);
    noteAccessoryDiagnostic(slotName, file, "asset-load-failed");
    flushAccessoryAssetWaiters(slotName);
  };
  const loadTimer = setTimeout(() => {
    if (slot.assetLoadTimer !== loadTimer || slot.assetFile !== file) return;
    slot.assetLoadTimer = null;
    slot.assetReady = false;
    slot.assetSettled = true;
    hideAccessory(slotName);
    noteAccessoryDiagnostic(slotName, file, "asset-load-timeout");
    flushAccessoryAssetWaiters(slotName);
  }, ACCESSORY_SETTLE_TIMEOUT_MS);
  slot.assetLoadTimer = loadTimer;
  const assetUrl = `../assets/accessories/${file}`;
  // The mouth slot uses a document-backed <object> so low-power mode can pause
  // and resume its bounded SMIL timeline through contentDocument. The static
  // head slot remains a cheaper <img>.
  if (slot.element.tagName === "OBJECT") slot.element.data = assetUrl;
  else slot.element.src = assetUrl;
  return false;
}

function shouldWaitForAccessoryAsset(slotName, file, state) {
  const slot = getAccessorySlot(slotName);
  if (!slot || !slot.supported || slot.payload.id === "none") return false;
  const descriptor = getAccessoryDescriptor(slotName, file, state);
  if (!descriptor || descriptor.visibility === "hidden") return false;
  ensureAccessoryAsset(slotName);
  return !slot.assetSettled;
}

function deferSwapUntilAccessorySettles(file, state, next, callback) {
  const waitingSlots = ACCESSORY_SLOT_NAMES.filter((slotName) => (
    shouldWaitForAccessoryAsset(slotName, file, state)
  ));
  if (waitingSlots.length === 0) return false;
  if (next.__clawdWaitingForAccessory) return true;
  next.__clawdWaitingForAccessory = true;
  let settled = false;
  let remaining = waitingSlots.length;
  const resume = () => {
    if (settled) return;
    remaining--;
    if (remaining > 0) return;
    settled = true;
    next.__clawdWaitingForAccessory = false;
    callback();
  };
  for (const slotName of waitingSlots) {
    const slot = getAccessorySlot(slotName);
    const waiter = {
      callback: resume,
      timer: setTimeout(() => {
        const index = slot.assetWaiters.indexOf(waiter);
        if (index >= 0) slot.assetWaiters.splice(index, 1);
        resume();
      }, ACCESSORY_SETTLE_TIMEOUT_MS),
    };
    slot.assetWaiters.push(waiter);
  }
  return true;
}

function getCurrentAccessoryContext(slotName) {
  const slot = getAccessorySlot(slotName);
  if (!slot || !slot.supported || !slot.attachments) return null;
  if (!slot.payload || slot.payload.id === "none" || !slot.payload.assetFile) return null;
  if (!clawdEl || !clawdEl.isConnected || !currentDisplayedSvg) return null;
  const descriptor = getAccessoryDescriptor(slotName, currentDisplayedSvg, currentDisplayedState);
  if (!descriptor || typeof descriptor !== "object") return null;
  return {
    slotName,
    slot,
    file: currentDisplayedSvg,
    state: currentDisplayedState,
    media: clawdEl,
    descriptor,
  };
}

function computeStaticAccessoryLayout(context) {
  if (!accessoryLayout || typeof accessoryLayout.computeStaticAccessoryLayout !== "function") return null;
  const frame = context.descriptor.staticFrame;
  const mediaBox = getMediaLayoutBox(context.media);
  const viewBox = resolveViewBox(context.state, context.file);
  const stageSize = getAccessoryStageSize();
  if (!frame || !mediaBox || !viewBox || !stageSize) return null;
  return accessoryLayout.computeStaticAccessoryLayout({
    mediaBox,
    viewBox,
    frame,
    accessory: context.slot.payload,
    stageSize,
  });
}

function computeFollowAccessoryLayout(context) {
  if (!accessoryLayout || typeof accessoryLayout.computeDynamicAccessoryLayout !== "function") return null;
  const followTarget = context.descriptor.followTarget;
  if (!followTarget || !followTarget.frame) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(followTarget.id || "")) return null;
  if (!context.media || context.media.tagName !== "OBJECT") return null;
  let target;
  let matrix;
  try {
    const doc = context.media.contentDocument;
    target = doc && doc.getElementById(followTarget.id);
    matrix = target && typeof target.getCTM === "function" ? target.getCTM() : null;
  } catch {
    return null;
  }
  if (!target || !matrix) return null;
  const mediaBox = getMediaLayoutBox(context.media);
  const stageSize = getAccessoryStageSize();
  if (!mediaBox || !stageSize) return null;
  return accessoryLayout.computeDynamicAccessoryLayout({
    mediaOffset: { x: mediaBox.x, y: mediaBox.y },
    matrix,
    frame: followTarget.frame,
    accessory: context.slot.payload,
    normalizeReflection: followTarget.normalizeReflection,
    stageSize,
  });
}

function applyAccessoryLayout(context, layout) {
  const slot = context && context.slot;
  if (!slot || !slot.element || !slot.assetReady || !layout) return false;
  const unchanged = accessoryLayout
    && typeof accessoryLayout.layoutsEqual === "function"
    && accessoryLayout.layoutsEqual(slot.lastLayout, layout);
  if (!unchanged) {
    const matrix = layout.matrix;
    slot.element.style.width = `${layout.width}px`;
    slot.element.style.height = `${layout.height}px`;
    slot.element.style.transform =
      `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
    slot.lastLayout = layout;
  }
  slot.element.style.filter = "none";
  // hideAccessory() pauses object-backed assets. Restore this document to the
  // global low-power state before making it visible again.
  setAccessorySvgLowPowerPaused(context.slotName, lowPowerSvgPaused);
  slot.element.style.visibility = "visible";
  slot.element.style.display = "block";
  return true;
}

function accessoryFollowTick(slotName, expectedKey) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  slot.raf = null;
  if (document.hidden === true || shouldSuppressPassiveTrackingForLowPower()) return;
  const context = getCurrentAccessoryContext(slotName);
  if (!context || context.descriptor.visibility === "hidden") {
    hideAccessory(slotName);
    return;
  }
  const follow = context.descriptor.followTarget;
  const key = follow
    ? `${context.file}|${slot.payload.id}|${follow.id}`
    : null;
  if (!key || key !== expectedKey || key !== slot.followKey) {
    refreshAccessoryLayout(slotName);
    return;
  }
  const layout = computeFollowAccessoryLayout(context);
  if (!layout) {
    noteAccessoryDiagnostic(slotName, context.file, `follow-target-unavailable:${follow.id}`);
    cancelAccessoryFollow(slotName);
    applyAccessoryLayout(context, computeStaticAccessoryLayout(context));
    return;
  }
  applyAccessoryLayout(context, layout);
  slot.raf = requestAnimationFrame(() => accessoryFollowTick(slotName, expectedKey));
}

function startAccessoryFollow(context) {
  const { slotName, slot } = context;
  const follow = context.descriptor.followTarget;
  if (!follow || shouldSuppressPassiveTrackingForLowPower()) return;
  const key = `${context.file}|${slot.payload.id}|${follow.id}`;
  cancelAccessoryFollow(slotName);
  slot.followKey = key;
  slot.raf = requestAnimationFrame(() => accessoryFollowTick(slotName, key));
}

function refreshAccessoryLayout(slotName = null) {
  if (!slotName) {
    for (const name of ACCESSORY_SLOT_NAMES) refreshAccessoryLayout(name);
    return;
  }
  cancelAccessoryFollow(slotName);
  const context = getCurrentAccessoryContext(slotName);
  if (!context || context.descriptor.visibility === "hidden") {
    hideAccessory(slotName);
    return;
  }
  if (!ensureAccessoryAsset(slotName)) {
    // A pending <object> must remain mounted for Chromium to load its nested
    // document. It is already visibility:hidden, so there is no pre-layout
    // flash. Failed/timed-out assets are settled and stay fully hidden.
    if (context.slot.assetSettled) hideAccessory(slotName);
    return;
  }

  const follow = context.descriptor.followTarget;
  if (follow && context.media.tagName === "OBJECT") {
    const dynamicLayout = computeFollowAccessoryLayout(context);
    if (dynamicLayout) {
      applyAccessoryLayout(context, dynamicLayout);
      startAccessoryFollow(context);
      return;
    }
    noteAccessoryDiagnostic(slotName, context.file, `follow-target-unavailable:${follow.id}`);
  }
  const staticLayout = computeStaticAccessoryLayout(context);
  if (!applyAccessoryLayout(context, staticLayout)) {
    hideAccessory(slotName);
    noteAccessoryDiagnostic(slotName, context.file, "static-layout-unavailable");
  }
}

function applyAccessorySlotPayload(slotName, payload) {
  const slot = getAccessorySlot(slotName);
  if (!slot) return;
  const next = normalizeAccessoryPayload(payload);
  const fileChanged = next.assetFile !== slot.assetFile;
  slot.payload = next;
  if (next.id === "none" || !slot.supported) {
    clearAccessoryRuntime(slotName, { clearAsset: true });
    return;
  }
  if (fileChanged) clearAccessoryRuntime(slotName, { clearAsset: true });
  refreshAccessoryLayout(slotName);
}

function setAccessorySlotsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (snapshot.themeId !== _accessoryThemeId) return false;
  if (!Number.isSafeInteger(snapshot.accessoryGeneration) || snapshot.accessoryGeneration < 0) return false;
  if (snapshot.accessoryGeneration < _lastAccessoryGeneration) return false;
  if (!snapshot.payloads || typeof snapshot.payloads !== "object") return false;
  _lastAccessoryGeneration = snapshot.accessoryGeneration;
  for (const slotName of ACCESSORY_SLOT_NAMES) {
    applyAccessorySlotPayload(slotName, snapshot.payloads[slotName]);
  }
  refreshAccessoryMediaChannel();
  return true;
}

if (window.electronAPI && typeof window.electronAPI.onPetAccessoryChange === "function") {
  window.electronAPI.onPetAccessoryChange((payload) => {
    applyAccessorySlotPayload("head", payload);
    refreshAccessoryMediaChannel();
  });
}
if (window.electronAPI && typeof window.electronAPI.onPetAccessorySlotsChange === "function") {
  window.electronAPI.onPetAccessorySlotsChange(setAccessorySlotsSnapshot);
}

if (document && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden === true) {
      for (const slotName of ACCESSORY_SLOT_NAMES) cancelAccessoryFollow(slotName);
    }
    else refreshAccessoryLayout();
  });
}

if (window && typeof window.addEventListener === "function") {
  window.addEventListener("resize", () => refreshAccessoryLayout());
  window.addEventListener("beforeunload", () => {
    clearAllAccessoryRuntimes({ clearAsset: true });
    clearTestReactionVisuals();
  });
}

// ── Test-result reactions ──
// Theme-independent decorative overlays. They never swap the current state
// SVG, pause cursor tracking, or enter the click/drag reaction state machine.
const TEST_CONFETTI_COLORS = ["#ff5d8f", "#ffd166", "#4ec3e0", "#8a5cff", "#5ad17a"];
const testConfettiTimers = new Map();
let testShakeTimer = null;

function clearTestConfetti() {
  for (const [particle, timer] of testConfettiTimers) {
    if (timer) clearTimeout(timer);
    try { particle.remove(); } catch {}
  }
  testConfettiTimers.clear();
}

function clearTestShake() {
  if (testShakeTimer) {
    clearTimeout(testShakeTimer);
    testShakeTimer = null;
  }
  if (facingStage) facingStage.classList.remove("clawd-test-shake");
}

function clearTestReactionVisuals() {
  clearTestConfetti();
  clearTestShake();
}

function burstTestConfetti() {
  clearTestReactionVisuals();
  if (!particleLayer) return;
  const count = 18;
  for (let i = 0; i < count; i++) {
    const particle = document.createElement("div");
    const startX = 30 + Math.floor((i / count) * 40);
    const dx = (i % 2 === 0 ? 1 : -1) * (10 + (i * 7) % 60);
    const delay = (i % 6) * 40;
    particle.className = "clawd-test-confetti";
    particle.style.left = `${startX}%`;
    particle.style.background = TEST_CONFETTI_COLORS[i % TEST_CONFETTI_COLORS.length];
    particle.style.setProperty("--test-confetti-dx", `${dx}px`);
    particle.style.animationDelay = `${delay}ms`;
    particleLayer.appendChild(particle);
    const timer = setTimeout(() => {
      testConfettiTimers.delete(particle);
      try { particle.remove(); } catch {}
    }, 1500 + delay);
    testConfettiTimers.set(particle, timer);
  }
}

function shakePetForTestFailure() {
  clearTestReactionVisuals();
  if (!facingStage) return;
  // Force a style flush so consecutive failed test runs restart the wobble.
  void facingStage.offsetWidth;
  facingStage.classList.add("clawd-test-shake");
  testShakeTimer = setTimeout(() => {
    testShakeTimer = null;
    try { facingStage.classList.remove("clawd-test-shake"); } catch {}
  }, 650);
}

function playTestReaction(result) {
  if (dndEnabled) return;
  if (result === "pass") burstTestConfetti();
  else if (result === "fail") shakePetForTestFailure();
}

if (window.electronAPI && typeof window.electronAPI.onPlayTestReaction === "function") {
  window.electronAPI.onPlayTestReaction(playTestReaction);
}

// Release an <object> SVG element: navigate away to unload the SVG document
// (stops CSS animations and frees the internal frame), then remove from DOM.
function releaseObject(el) {
  if (!el) return;
  try { el.data = ""; } catch {}
  el.remove();
}

// Release an <img> element from DOM
function releaseImg(el) {
  if (!el) return;
  try { el.src = ""; } catch {}
  el.remove();
}

// --- Reaction state (visual side) ---
let isReacting = false;
let reactTimer = null;
let isSettingsPreviewReaction = false;
let currentIdleSvg = null;    // tracks which SVG is currently showing
let currentState = null;      // last state name received from main (for re-pulse)
let lastCloudlingPointerPayload = null;
let dndEnabled = false;
let miniLeftFlip = false;

if (window.electronAPI && typeof window.electronAPI.onLowPowerIdleModeChange === "function") {
  window.electronAPI.onLowPowerIdleModeChange(setLowPowerIdleMode);
}

window.electronAPI.onDndChange((enabled) => {
  dndEnabled = enabled;
  if (dndEnabled) clearTestReactionVisuals();
});

window.electronAPI.onMiniModeChange((enabled, edge, options) => {
  const preEntry = !!(options && options.preEntry);
  _miniPreEntryMode = !!enabled && preEntry;
  _inMiniMode = !!enabled && !preEntry;
  if (enabled) clearTestReactionVisuals();
  miniLeftFlip = !!enabled && edge === "left";
  container.classList.toggle("mini-left", miniLeftFlip);
  applyMiniFlip(clawdEl, currentState);
  if (miniLeftFlip) {
    applyGlyphFlipCompensation(clawdEl);
  } else {
    removeGlyphFlipCompensation(clawdEl);
  }
  if (!enabled) applyMiniClip(null);
  if (shouldUseCloudlingPointerBridge(currentState, currentDisplayedSvg) && lastCloudlingPointerPayload) {
    applyCloudlingPointerBridge(lastCloudlingPointerPayload);
  }
  refreshAccessoryLayout();
});

// Multi-monitor seam clip: in mini mode at an internal seam, main sends the
// fraction of the window width that falls on the local display. We clip the
// rest away so the half that physically crosses onto the neighbouring
// monitor renders nothing there — the local display keeps the half-body peek.
//
// The clip is applied to #pet-clip outside #pet-facing-stage, which carries
// the left-edge mini-mode flip. A clip-path inside that flipped stage would
// be mirrored too, so a left-edge clip would land on the wrong half; the
// unflipped wrapper keeps `inset()` in screen space for both edges.
function applyMiniClip(info) {
  if (!clipLayer) return;
  if (!info || !Number.isFinite(info.fraction)) {
    clipLayer.style.clipPath = "";
    return;
  }
  const f = Math.max(0, Math.min(1, info.fraction));
  if (info.edge === "left") {
    // Local display lies to the RIGHT of the seam — keep [f, 1], clip the left.
    clipLayer.style.clipPath = `inset(0 0 0 ${f * 100}%)`;
  } else {
    // Local display lies to the LEFT of the seam — keep [0, f], clip the right.
    clipLayer.style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
  }
}

if (window.electronAPI && typeof window.electronAPI.onMiniClip === "function") {
  window.electronAPI.onMiniClip(applyMiniClip);
}

// Counter-flip asymmetric pixel-art glyphs (Zzz) inside SVG defs so they
// render correctly when the container has scaleX(-1). Only the glyph shape
// is flipped — CSS animation transforms (float direction) are unaffected.
function applyGlyphFlipCompensation(objectEl) {
  if (!objectEl || objectEl.tagName !== "OBJECT") return;
  try {
    const doc = objectEl.contentDocument;
    if (!doc) return;
    const svgWindow = objectEl.contentWindow;
    if (svgWindow && typeof svgWindow.__clawdSetGlyphFlipCompensation === "function") {
      svgWindow.__clawdSetGlyphFlipCompensation(true);
    }
    for (const [id, w] of Object.entries(_glyphFlipDefs)) {
      const el = doc.getElementById(id);
      if (el) el.setAttribute("transform", `translate(${w}, 0) scale(-1, 1)`);
    }
  } catch {}
}

function removeGlyphFlipCompensation(objectEl) {
  if (!objectEl || objectEl.tagName !== "OBJECT") return;
  try {
    const doc = objectEl.contentDocument;
    if (!doc) return;
    const svgWindow = objectEl.contentWindow;
    if (svgWindow && typeof svgWindow.__clawdSetGlyphFlipCompensation === "function") {
      svgWindow.__clawdSetGlyphFlipCompensation(false);
    }
    for (const id of Object.keys(_glyphFlipDefs)) {
      const el = doc.getElementById(id);
      if (el) el.removeAttribute("transform");
    }
  } catch {}
}

function getObjectSvgName(objectEl) {
  if (!objectEl) return null;
  const data = (objectEl.tagName === "OBJECT")
    ? (objectEl.getAttribute("data") || objectEl.data || "")
    : (objectEl.getAttribute("src") || objectEl.src || "");
  if (!data) return null;
  const clean = data.split(/[?#]/)[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || null;
}

// ── Dual-channel rendering ──
// Object channel: <object type="image/svg+xml"> for SVG states needing eye tracking
// or built-in trusted SVG files whose own scripts need a document context.
// Img channel: <img> for all other formats (SVG/GIF/APNG/WebP pure playback)

/**
 * Determine if a state should attach Clawd-controlled eye tracking.
 */
function needsEyeTracking(state) {
  return _eyeTrackingStates.includes(state);
}

/**
 * Determine if this state+file combination should attach eye tracking.
 * Idle can rest on a non-follow visual (#509); only the follow sprite carries
 * eye targets, and tick.js only streams eye movement for that exact file —
 * attaching to anything else retries until timeout, or freezes stale offsets
 * into a third-party SVG that happens to expose targets.
 */
function tracksEyesForFile(state, file) {
  if (!needsEyeTracking(state)) return false;
  return state !== "idle" || file === _idleFollowSvg;
}

/**
 * Determine if a state+file needs the <object> channel.
 */
function needsObjectChannel(state, file) {
  if (!isSvgFile(file)) return false;
  const needsAccessoryFollow = ACCESSORY_SLOT_NAMES.some((slotName) => {
    const slot = getAccessorySlot(slotName);
    const descriptor = getAccessoryDescriptor(slotName, file, state);
    return !!(slot && slot.payload.id !== "none" && descriptor && descriptor.followTarget);
  });
  return _forceSvgObjectChannel
    || _objectChannelFiles.has(file)
    || needsEyeTracking(state)
    || _trustedScriptedSvgFiles.has(file)
    || needsAccessoryFollow;
}

function refreshAccessoryMediaChannel() {
  if (pendingNext && pendingSvgFile) {
    const pendingState = getPendingSwapState(pendingNext, currentState);
    const wantsObject = needsObjectChannel(pendingState, pendingSvgFile);
    const pendingIsObject = pendingNext.tagName === "OBJECT";
    if (wantsObject !== pendingIsObject) {
      const file = pendingSvgFile;
      const visualRequest = pendingNext.__clawdVisualRequest || null;
      const fallbackFromObject = pendingNext.__clawdFallbackFromObject === true;
      cancelPendingSwap("channel-refresh", { retainedRequest: visualRequest });
      detachEyeTracking();
      swapToFile(file, pendingState, undefined, { visualRequest, fallbackFromObject });
      return true;
    }
  }
  // A correctly-channelled pending swap already represents the newest state.
  // Do not let the older displayed file cancel and replace it merely because
  // that displayed element still needs a channel correction.
  if (pendingNext) return false;
  if (!clawdEl || !clawdEl.isConnected || !currentDisplayedSvg) return false;
  const wantsObject = needsObjectChannel(currentDisplayedState, currentDisplayedSvg);
  const currentIsObject = clawdEl.tagName === "OBJECT";
  if (wantsObject === currentIsObject) return false;
  cancelPendingSwap();
  detachEyeTracking();
  swapToFile(currentDisplayedSvg, currentDisplayedState);
  return true;
}

function resolveLowPowerStaticImageOverride(state, file) {
  if (!lowPowerIdleMode) return null;
  const override = _lowPowerStaticImageOverrides && _lowPowerStaticImageOverrides[state];
  if (!override || override.from !== file || !override.to) return null;
  return override.to;
}

function shouldUseCloudlingPointerBridge(state, file) {
  return CLOUDLING_POINTER_BRIDGE_STATES.has(state) && isSvgFile(file);
}

function normalizeCloudlingPointerPayload(payload) {
  if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return null;
  return {
    x: payload.x,
    y: payload.y,
    inside: !!payload.inside,
  };
}

function getDisplayedCloudlingPointerPayload(payload) {
  const next = { ...payload };
  if (miniLeftFlip) {
    const viewBox = resolveViewBox(currentState, currentDisplayedSvg);
    if (viewBox && Number.isFinite(viewBox.x) && Number.isFinite(viewBox.width)) {
      next.x = viewBox.x + viewBox.width - (payload.x - viewBox.x);
    }
  }
  return next;
}

function callCloudlingPointerBridge(objectEl, payload) {
  if (!objectEl || objectEl.tagName !== "OBJECT" || !payload) return false;
  try {
    const svgWindow = objectEl.contentWindow;
    if (svgWindow && typeof svgWindow.__cloudlingSetPointer === "function") {
      svgWindow.__cloudlingSetPointer(payload);
      return true;
    }
  } catch {}
  return false;
}

function applyCloudlingPointerBridge(payload) {
  const normalized = normalizeCloudlingPointerPayload(payload);
  if (!normalized) return;
  lastCloudlingPointerPayload = normalized;
  if (shouldSuppressPassiveTrackingForLowPower()) return;
  if (!shouldUseCloudlingPointerBridge(currentState, currentDisplayedSvg)) return;
  callCloudlingPointerBridge(clawdEl, getDisplayedCloudlingPointerPayload(normalized));
}

function clearCloudlingPointerBridge(objectEl = clawdEl) {
  const payload = {
    ...(lastCloudlingPointerPayload || { x: 0, y: 0 }),
    inside: false,
  };
  callCloudlingPointerBridge(objectEl, getDisplayedCloudlingPointerPayload(payload));
}

/**
 * Get the full asset URL for a file.
 * SVGs use _assetsPath (which may point to cache for external themes).
 * Non-SVGs use _sourceAssetsPath if available (direct from theme dir).
 */
function getAssetUrl(file) {
  if (!file) return "";
  if (file.endsWith(".svg") || !_sourceAssetsPath) {
    return `${_assetsPath}/${file}`;
  }
  return `${_sourceAssetsPath}/${file}`;
}

// --- IPC-triggered reactions (from hit window via main relay) ---
window.electronAPI.onStartDragReaction((requestOrDirection, legacyDirection) => startDragReaction(requestOrDirection, legacyDirection));
window.electronAPI.onEndDragReaction(() => endDragReaction());
window.electronAPI.onPlayClickReaction((svg, duration, options) => playReaction(svg, duration, options));
// Settings cancels its own reaction preview when it closes; without this the
// pet would hold the reaction visual, and its paused cursor polling, until the
// clip's own timer fired. A reaction the user started by clicking the pet runs
// on the same channel and must survive Settings closing, so only a preview is
// cancelled here.
window.electronAPI.onCancelClickReaction(() => {
  if (!isSettingsPreviewReaction) return;
  if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
  endReaction();
});

function playReaction(requestOrFile, durationMs, options) {
  // A reaction preview now runs as long as the clip, so the next one can start
  // while this timer is still pending. Clearing it first keeps the old timer
  // from firing mid-clip and ending the new reaction early.
  if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
  const visualRequest = normalizeVisualRequest(requestOrFile);
  const svgFile = visualRequest ? visualRequest.file : requestOrFile;
  isSettingsPreviewReaction = !!(options && options.settingsPreview);
  isReacting = true;
  detachEyeTracking();
  resumeCurrentSvgForLowPower();
  window.electronAPI.pauseCursorPolling();

  // Reactions do not attach eye tracking, but some themes force SVGs through
  // <object> so their SVG documents can load local sub-resources.
  swapToFile(svgFile, null, undefined, { visualRequest });

  reactTimer = setTimeout(() => endReaction(), durationMs);
}

function endReaction() {
  if (!isReacting) return;
  isReacting = false;
  isSettingsPreviewReaction = false;
  reactTimer = null;
  // A drag reaction holds the same cursor-polling pause and is still running;
  // endDragReaction() releases it when the drag itself ends.
  if (isDragReacting) return;
  window.electronAPI.resumeFromReaction();
}

function cancelReaction() {
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
    isSettingsPreviewReaction = false;
  }
  if (isDragReacting) {
    isDragReacting = false;
  }
  currentDragSvg = null;
  currentDragDirection = null;
}

// --- Drag reaction (loops while dragging) ---
function normalizeDragDirection(direction) {
  return direction === "left" || direction === "right" ? direction : null;
}

function usesDirectionalDragBridge(file) {
  return !!(
    file
    && _dragSvgs.left === file
    && _dragSvgs.right === file
  );
}

function warnDirectionalDragBridgeOnce(reason) {
  if (directionalDragBridgeWarnings.has(reason)) return;
  directionalDragBridgeWarnings.add(reason);
  console.warn(`Clawd: directional drag bridge unavailable (${reason}); keeping the fallback direction.`);
}

function applyDirectionalDragToObject(objectEl, direction, options = {}) {
  const normalized = normalizeDragDirection(direction);
  if (!normalized) return false;
  const warn = options.warn === true;
  if (!objectEl || objectEl.tagName !== "OBJECT") {
    if (warn) warnDirectionalDragBridgeOnce("non-object media channel");
    return false;
  }
  try {
    const root = objectEl.contentDocument && objectEl.contentDocument.documentElement;
    if (!root) {
      if (warn) warnDirectionalDragBridgeOnce("contentDocument unavailable");
      return false;
    }
    if (root.getAttribute("data-clawd-drag-directional") !== "v1") {
      if (warn) warnDirectionalDragBridgeOnce("v1 marker missing");
      return false;
    }
    if (root.getAttribute("data-clawd-drag-direction") !== normalized) {
      root.setAttribute("data-clawd-drag-direction", normalized);
    }
    return true;
  } catch {
    if (warn) warnDirectionalDragBridgeOnce("contentDocument access denied");
    return false;
  }
}

function getCodexPetVisualForFile(file) {
  if (!file) return null;
  const basename = String(file).replace(/\\/g, "/").split("/").pop().split(/[?#]/, 1)[0];
  return CODEX_PET_VISUAL_BY_FILE[basename] || null;
}

function getAssetDirectoryUrl(url) {
  const value = String(url || "").replace(/\\/g, "/");
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(0, slash) : "";
}

function restartCodexPetVisualAnimation(root) {
  if (!root || typeof root.getAnimations !== "function") return;
  let animations = [];
  try {
    animations = root.getAnimations({ subtree: true });
  } catch {
    return;
  }
  for (const animation of animations) {
    try {
      animation.currentTime = 0;
    } catch {}
  }
}

function warnCodexPetVisualBridgeOnce(reason) {
  if (codexPetVisualBridgeWarnings.has(reason)) return;
  codexPetVisualBridgeWarnings.add(reason);
  console.warn(`Clawd: Codex Pet visual bridge unavailable (${reason}); using a normal media swap.`);
}

function applyCodexPetVisualToObject(objectEl, file, options = {}) {
  const visual = getCodexPetVisualForFile(file);
  if (!visual) return false;
  const warn = options.warn === true;
  if (!objectEl || objectEl.tagName !== "OBJECT") {
    if (warn) warnCodexPetVisualBridgeOnce("non-object media channel");
    return false;
  }
  try {
    const root = objectEl.contentDocument && objectEl.contentDocument.documentElement;
    if (!root) {
      if (warn) warnCodexPetVisualBridgeOnce("contentDocument unavailable");
      return false;
    }
    if (root.getAttribute("data-clawd-codex-pet-visuals") !== "v1") {
      if (warn) warnCodexPetVisualBridgeOnce("v1 marker missing");
      return false;
    }
    const unchanged = root.getAttribute("data-clawd-codex-pet-visual") === visual;
    if (!unchanged) root.setAttribute("data-clawd-codex-pet-visual", visual);
    if (visual === "drag-directional") {
      const direction = normalizeDragDirection(options.direction);
      if (direction && root.getAttribute("data-clawd-drag-direction") !== direction) {
        root.setAttribute("data-clawd-drag-direction", direction);
      }
    }
    if (unchanged && options.restart === true) restartCodexPetVisualAnimation(root);
    return true;
  } catch {
    if (warn) warnCodexPetVisualBridgeOnce("contentDocument access denied");
    return false;
  }
}

function startDragReaction(requestOrDirection, legacyDirection) {
  const visualRequest = normalizeVisualRequest(requestOrDirection);
  const direction = legacyDirection !== undefined ? legacyDirection : requestOrDirection;
  if (dndEnabled) {
    notifyVisualSettlement(visualRequest, "failed", {
      actualFile: currentDisplayedSvg || null,
      channel: clawdEl && clawdEl.tagName === "OBJECT" ? "object" : "img",
      verified: false,
    });
    return;
  }
  const normalizedDirection = normalizeDragDirection(direction);
  const dragSvg = visualRequest
    ? visualRequest.file
    : ((normalizedDirection && _dragSvgs[normalizedDirection]) || _dragSvg);
  if (!dragSvg) return;
  currentDragDirection = normalizedDirection;
  if (isDragReacting && currentDragSvg === dragSvg) {
    if (usesDirectionalDragBridge(dragSvg) && currentDisplayedSvg === dragSvg) {
      applyDirectionalDragToObject(clawdEl, currentDragDirection, { warn: true });
    }
    if (usesDirectionalDragBridge(dragSvg) && pendingNext && pendingSvgFile === dragSvg) {
      applyDirectionalDragToObject(pendingNext, currentDragDirection);
    }
    if (!visualRequest) return;
    if (pendingNext && pendingSvgFile === dragSvg) {
      pendingNext.__clawdVisualRequest = visualRequest;
      return;
    }
    if (clawdEl && clawdEl.isConnected && currentDisplayedSvg === dragSvg) {
      notifyVisualSettlement(visualRequest, "already-displayed", {
        actualFile: dragSvg,
        channel: clawdEl.tagName === "OBJECT" ? "object" : "img",
        verified: true,
      });
      return;
    }
  }

  if (!isDragReacting && isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
    isSettingsPreviewReaction = false;
  }

  isDragReacting = true;
  currentDragSvg = dragSvg;
  detachEyeTracking();
  resumeCurrentSvgForLowPower();
  window.electronAPI.pauseCursorPolling();
  swapToFile(dragSvg, null, undefined, { visualRequest });
}

function endDragReaction() {
  const wasDragReacting = isDragReacting;
  isDragReacting = false;
  currentDragSvg = null;
  currentDragDirection = null;
  // A click reaction that started during the drag holds the same cursor-polling
  // pause and is still running; endReaction() releases it when that one ends.
  if (!wasDragReacting || isReacting) return;
  window.electronAPI.resumeFromReaction();
}

// --- Generic swap function: handles both <object> and <img> channels ---
let currentDisplayedSvg = getObjectSvgName(clawdEl);
let currentDisplayedState = null;
let currentDisplayedAssetUrl = null;
let pendingSvgFile = null; // tracks the SVG currently being loaded (for dedup)
let pendingAssetUrl = null;
let activeSwapToken = 0;
let swapVisibilityRescueTimer = null;
let petVisualReadyNotified = false;
currentIdleSvg = currentDisplayedSvg;

function notifyPetVisualReadyOnce() {
  if (petVisualReadyNotified) return;
  if (!window.electronAPI || typeof window.electronAPI.notifyPetVisualReady !== "function") return;
  petVisualReadyNotified = true;
  window.electronAPI.notifyPetVisualReady();
}

function normalizeVisualRequest(value) {
  if (!value || typeof value !== "object") return null;
  if (
    (value.themeId !== null && typeof value.themeId !== "string")
    || typeof value.logicalState !== "string"
    || typeof value.displayState !== "string"
    || typeof value.file !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.file)
    || typeof value.source !== "string"
    || !Number.isSafeInteger(value.visualGeneration)
    || value.visualGeneration <= 0
  ) return null;
  return Object.freeze({
    themeId: value.themeId,
    logicalState: value.logicalState,
    displayState: value.displayState,
    file: value.file,
    source: value.source,
    visualGeneration: value.visualGeneration,
  });
}

const settledVisualGenerations = new Set();
function notifyVisualSettlement(request, outcome, options = {}) {
  if (!request || settledVisualGenerations.has(request.visualGeneration)) return false;
  if (!window.electronAPI || typeof window.electronAPI.notifyPetVisualSettled !== "function") return false;
  const channel = options.channel;
  if (!["object", "img", "bridge"].includes(channel)) return false;
  const actualFile = typeof options.actualFile === "string" ? options.actualFile : null;
  settledVisualGenerations.add(request.visualGeneration);
  while (settledVisualGenerations.size > 128) {
    settledVisualGenerations.delete(settledVisualGenerations.values().next().value);
  }
  window.electronAPI.notifyPetVisualSettled({
    themeId: request.themeId,
    displayState: request.displayState,
    requestedFile: request.file,
    actualFile,
    channel,
    verified: options.verified === true,
    visualGeneration: request.visualGeneration,
    outcome,
  });
  return true;
}

function settleSuccessfulVisual(request, actualFile, channel, options = {}) {
  if (!request) return false;
  const outcome = options.fallback === true || actualFile !== request.file
    ? "fallback"
    : "swapped";
  return notifyVisualSettlement(request, outcome, {
    actualFile,
    channel,
    verified: true,
  });
}

/**
 * Swap to a new animation file.
 * @param {string} file - animation filename
 * @param {string|null} state - current state name (for eye tracking decision)
 * @param {boolean} [useObjectChannel] - force object channel (true), img (false), or auto (undefined)
 */
// Fade out an element and remove it after the transition completes
function fadeOutAndRemove(el, durationMs) {
  el.style.transition = `opacity ${durationMs}ms ease-out`;
  el.style.opacity = "0";
  setTimeout(() => {
    if (el.tagName === "OBJECT") releaseObject(el);
    else releaseImg(el);
  }, durationMs);
}

function getPetMediaElements() {
  return [...mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img")];
}

function isVisiblyOpaque(el) {
  if (!el || !el.isConnected) return false;
  let opacity = 1;
  try {
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    opacity = Number.parseFloat((style && style.opacity) || el.style.opacity || "1");
  } catch {
    opacity = Number.parseFloat(el.style.opacity || "1");
  }
  return !Number.isFinite(opacity) || opacity > 0.05;
}

function hasVisiblePetElement() {
  return getPetMediaElements().some(isVisiblyOpaque);
}

function forceVisiblePetElement(el) {
  if (!el || !el.isConnected) return false;
  el.style.transition = "none";
  el.style.opacity = "1";
  return true;
}

function clearSwapVisibilityRescueTimer() {
  if (swapVisibilityRescueTimer) {
    clearTimeout(swapVisibilityRescueTimer);
    swapVisibilityRescueTimer = null;
  }
}

function getSwapVisibilityRescueDelay(file) {
  const fadeInMs = (_transitions[file] && _transitions[file].in) || 0;
  return Math.max(SWAP_LOAD_FALLBACK_MS + SWAP_VISIBILITY_RESCUE_BUFFER_MS, fadeInMs + SWAP_VISIBILITY_RESCUE_BUFFER_MS);
}

function scheduleSwapVisibilityRescue(token, file, state) {
  clearSwapVisibilityRescueTimer();
  const timer = setTimeout(() => {
    if (swapVisibilityRescueTimer === timer) swapVisibilityRescueTimer = null;
    if (token !== activeSwapToken) return;
    if (hasVisiblePetElement()) return;

    if (pendingNext && pendingSvgFile === file) {
      // A verified media load can remain pending solely while an accessory's
      // bounded waiter settles. Restarting here discards that progress.
      if (pendingNext.__clawdWaitingForAccessory) return;
      forceImageChannelReload(file, getPendingSwapState(pendingNext, state), true, {
        visualRequest: pendingNext.__clawdVisualRequest || null,
      });
      return;
    }

    if (forceVisiblePetElement(clawdEl)) return;
    forceImageChannelReload(file, state);
  }, getSwapVisibilityRescueDelay(file));
  swapVisibilityRescueTimer = timer;
}

function getPendingSwapState(next, fallbackState) {
  if (
    next
    && Object.prototype.hasOwnProperty.call(next, "__clawdPendingState")
  ) {
    return next.__clawdPendingState;
  }
  return fallbackState;
}

function forceImageChannelReload(file, state, allowImageFallback = true, options = {}) {
  if (!allowImageFallback) return false;
  if (!file) return false;
  console.warn("Clawd: animation stayed invisible; reloading through the image channel:", file);
  swapToFile(file, state, false, {
    allowImageFallback: false,
    visualRequest: options.visualRequest || null,
    fallbackFromObject: true,
    onReady: options.onReady,
    onError: options.onError,
  });
  return true;
}

function cancelPendingSwap(reason = "superseded", options = {}) {
  const next = pendingNext;
  if (!next) return false;
  const visualRequest = normalizeVisualRequest(next.__clawdVisualRequest);
  const retainedRequest = normalizeVisualRequest(options.retainedRequest);
  const requestRetained = !!(
    visualRequest
    && retainedRequest
    && visualRequest.visualGeneration === retainedRequest.visualGeneration
  );
  if (typeof next.__clawdSwapCancelled === "function") {
    next.__clawdSwapCancelled(reason);
  }
  if (next.__clawdImageLoadTimer) {
    clearTimeout(next.__clawdImageLoadTimer);
    next.__clawdImageLoadTimer = null;
  }
  if (next.tagName === "OBJECT") releaseObject(next);
  else releaseImg(next);
  if (pendingNext === next) {
    pendingNext = null;
    pendingSvgFile = null;
    pendingAssetUrl = null;
  }
  if (visualRequest && !requestRetained) {
    notifyVisualSettlement(visualRequest, "failed", {
      actualFile: currentDisplayedSvg || null,
      channel: next.tagName === "OBJECT" ? "object" : "img",
      verified: false,
    });
  }
  return true;
}

function swapToFile(file, state, useObjectChannel, options = {}) {
  const allowImageFallback = options.allowImageFallback !== false;
  const visualRequest = normalizeVisualRequest(options.visualRequest);
  const useObj = useObjectChannel !== undefined ? useObjectChannel : needsObjectChannel(state, file);
  const url = getAssetUrl(file);
  const canReuseCodexPetDocument = useObj
    && options.forceDocumentReload !== true
    && currentDisplayedAssetUrl
    && getAssetDirectoryUrl(currentDisplayedAssetUrl) === getAssetDirectoryUrl(url)
    && applyCodexPetVisualToObject(clawdEl, file, {
      direction: isDragReacting && currentDragSvg === file ? currentDragDirection : null,
      restart: true,
      warn: true,
    });
  if (canReuseCodexPetDocument) {
    cancelPendingSwap("superseded", { retainedRequest: visualRequest });
    clearSwapVisibilityRescueTimer();
    currentDisplayedSvg = file;
    currentDisplayedState = state;
    currentDisplayedAssetUrl = url;
    applyObjectScaleStyle(clawdEl, file, state);
    applyPetTintToElement(clawdEl);
    applyMiniFlip(clawdEl, state);
    refreshAccessoryLayout();
    notifyPetVisualReadyOnce();
    settleSuccessfulVisual(visualRequest, file, "bridge", {
      fallback: options.fallbackFromObject === true,
    });
    if (state && tracksEyesForFile(state, file)) attachEyeTracking(clawdEl);
    else detachEyeTracking();
    if (miniLeftFlip) applyGlyphFlipCompensation(clawdEl);
    scheduleLowPowerIdlePause();
    if (typeof options.onReady === "function") options.onReady(clawdEl);
    return;
  }

  const swapToken = ++activeSwapToken;
  cancelPendingSwap("superseded", { retainedRequest: visualRequest });

  pendingSvgFile = file; // track what's loading for dedup
  pendingAssetUrl = url;

  if (useObj) {
    // Object channel: <object type="image/svg+xml">
    const next = document.createElement("object");
    next.type = "image/svg+xml";
    next.className = "clawd-object";
    next.id = "clawd";
    next.style.opacity = "0";
    next.__clawdPendingState = state;
    next.__clawdVisualRequest = visualRequest;
    next.__clawdFallbackFromObject = options.fallbackFromObject === true;
    applyObjectScaleStyle(next, file, state);
    applyPetTintToElement(next);
    let swapCallbackSettled = false;
    const finishSwapReady = () => {
      if (swapCallbackSettled) return;
      swapCallbackSettled = true;
      next.__clawdSwapCancelled = null;
      if (typeof options.onReady === "function") options.onReady(next);
    };
    const finishSwapError = (reason) => {
      if (swapCallbackSettled) return;
      swapCallbackSettled = true;
      next.__clawdSwapCancelled = null;
      if (typeof options.onError === "function") options.onError(reason);
    };
    next.__clawdSwapCancelled = finishSwapError;

    const swap = () => {
      if (pendingNext !== next) return;
      const commitState = getPendingSwapState(next, state);
      if (deferSwapUntilAccessorySettles(file, commitState, next, swap)) return;
      if (swapToken === activeSwapToken) clearSwapVisibilityRescueTimer();
      const fadeInMs = (_transitions[file] && _transitions[file].in) || 0;
      const fadeOutMs = (currentDisplayedSvg && _transitions[currentDisplayedSvg] && _transitions[currentDisplayedSvg].out) || 0;

      if (fadeInMs > 0) {
        next.style.transition = `opacity ${fadeInMs}ms ease-in`;
        next.offsetHeight; // force reflow to trigger transition
      } else {
        next.style.transition = "none";
      }
      if (isDragReacting && currentDragSvg === file && usesDirectionalDragBridge(file)) {
        applyDirectionalDragToObject(next, currentDragDirection, { warn: true });
      }
      next.style.opacity = "1";

      for (const child of [...mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img")]) {
        if (child !== next) {
          if (fadeOutMs > 0) fadeOutAndRemove(child, fadeOutMs);
          else if (child.tagName === "OBJECT") releaseObject(child);
          else releaseImg(child);
        }
      }
      pendingNext = null;
      pendingSvgFile = null;
      pendingAssetUrl = null;
      clawdEl = next;
      currentDisplayedSvg = file;
      currentDisplayedState = commitState;
      currentDisplayedAssetUrl = url;
      applyMiniFlip(next, commitState);
      refreshAccessoryLayout();
      notifyPetVisualReadyOnce();
      settleSuccessfulVisual(next.__clawdVisualRequest, file, "object", {
        fallback: next.__clawdFallbackFromObject === true,
      });

      if (commitState && tracksEyesForFile(commitState, file)) {
        attachEyeTracking(next);
      }
      if (miniLeftFlip) applyGlyphFlipCompensation(next);
      if (shouldUseCloudlingPointerBridge(currentState, file) && lastCloudlingPointerPayload) {
        callCloudlingPointerBridge(next, getDisplayedCloudlingPointerPayload(lastCloudlingPointerPayload));
      }
      scheduleLowPowerIdlePause();
      finishSwapReady();
    };

    const retryThroughImage = (reason) => {
      if (pendingNext !== next) return;
      const retryState = getPendingSwapState(next, state);
      const retryRequest = next.__clawdVisualRequest;
      releaseObject(next);
      if (pendingNext === next) {
        pendingNext = null;
        pendingSvgFile = null;
        pendingAssetUrl = null;
      }
      if (!pendingNext && forceImageChannelReload(file, retryState, allowImageFallback, {
        visualRequest: retryRequest,
        onReady: options.onReady,
        onError: options.onError,
      })) return;
      finishSwapError(reason);
      notifyVisualSettlement(retryRequest, "failed", {
        actualFile: currentDisplayedSvg || null,
        channel: "object",
        verified: false,
      });
    };
    // A load event verifies that Chromium accepted and rendered the object.
    // contentDocument can still be transiently null at this exact callback;
    // reserve that check for the no-load timeout path below.
    next.addEventListener("load", swap, { once: true });
    next.addEventListener("error", () => retryThroughImage("object-load-error"), { once: true });
    // Same cache-bust as the <img> channel below. Chromium reuses the SVG
    // document (and its CSS animation timeline) across loads of the same
    // URL on the object channel too, so one-shot animations for scripted /
    // eye-tracking SVGs would stall on their last frame on re-entry. A fresh
    // query each swap forces a fresh document. Bookkeeping (currentDisplayed
    // /pendingAssetUrl) stays keyed on the base `url`, not the busted one.
    const cacheBust = `${Date.now()}-${++_imgCacheBustSeq}`;
    next.data = `${url}${url.includes("?") ? "&" : "?"}_t=${cacheBust}`;
    mediaLayer.appendChild(next);
    pendingNext = next;
    scheduleSwapVisibilityRescue(swapToken, file, state);
    setTimeout(() => {
      if (pendingNext !== next) return;
      try {
        if (!next.contentDocument) {
          retryThroughImage("object-document-unavailable");
          return;
        }
      } catch {
        retryThroughImage("object-document-inaccessible");
        return;
      }
      swap();
    }, SWAP_LOAD_FALLBACK_MS);
  } else {
    // Img channel: <img> for pure playback (all formats)
    const next = document.createElement("img");
    next.className = "clawd-img";
    next.id = "clawd";
    next.style.opacity = "0";
    next.__clawdPendingState = state;
    next.__clawdVisualRequest = visualRequest;
    next.__clawdFallbackFromObject = options.fallbackFromObject === true;
    applyObjectScaleStyle(next, file, state);
    applyPetTintToElement(next);

    const swap = () => {
      if (pendingNext !== next) return;
      const commitState = getPendingSwapState(next, state);
      if (deferSwapUntilAccessorySettles(file, commitState, next, swap)) return;
      if (next.__clawdImageLoadTimer) {
        clearTimeout(next.__clawdImageLoadTimer);
        next.__clawdImageLoadTimer = null;
      }
      if (swapToken === activeSwapToken) clearSwapVisibilityRescueTimer();
      const fadeInMs = (_transitions[file] && _transitions[file].in) || 0;
      const fadeOutMs = (currentDisplayedSvg && _transitions[currentDisplayedSvg] && _transitions[currentDisplayedSvg].out) || 0;

      if (fadeInMs > 0) {
        next.style.transition = `opacity ${fadeInMs}ms ease-in`;
        next.offsetHeight; // force reflow to trigger transition
      } else {
        next.style.transition = "none";
      }
      next.style.opacity = "1";

      for (const child of [...mediaLayer.querySelectorAll("object.clawd-object, img.clawd-img")]) {
        if (child !== next) {
          if (fadeOutMs > 0) fadeOutAndRemove(child, fadeOutMs);
          else if (child.tagName === "OBJECT") releaseObject(child);
          else releaseImg(child);
        }
      }
      pendingNext = null;
      pendingSvgFile = null;
      pendingAssetUrl = null;
      clawdEl = next;
      currentDisplayedSvg = file;
      currentDisplayedState = commitState;
      currentDisplayedAssetUrl = url;
      applyMiniFlip(next, commitState);
      refreshAccessoryLayout();
      notifyPetVisualReadyOnce();
      settleSuccessfulVisual(next.__clawdVisualRequest, file, "img", {
        fallback: next.__clawdFallbackFromObject === true,
      });
      scheduleLowPowerIdlePause();
      if (typeof options.onReady === "function") options.onReady(next);
    };

    next.addEventListener("load", swap, { once: true });
    const failImageSwap = (reason) => {
      if (pendingNext !== next) return;
      if (next.__clawdImageLoadTimer) {
        clearTimeout(next.__clawdImageLoadTimer);
        next.__clawdImageLoadTimer = null;
      }
      if (next.tagName === "IMG") releaseImg(next);
      if (pendingNext === next) {
        pendingNext = null;
        pendingSvgFile = null;
        pendingAssetUrl = null;
      }
      clearSwapVisibilityRescueTimer();
      notifyVisualSettlement(next.__clawdVisualRequest, "failed", {
        actualFile: currentDisplayedSvg || null,
        channel: "img",
        verified: false,
      });
      if (typeof options.onError === "function") options.onError(reason);
    };
    next.addEventListener("error", () => failImageSwap("image-load-error"), { once: true });
    // Cache-bust query param: Chromium reuses the SVG document (and its CSS
    // animation timeline) across <img> elements pointing at the same URL, so
    // one-shot animations (`animation: foo 3.2s 1 forwards`) that already ran
    // once would reappear stuck on their last frame on subsequent loads —
    // the user sees a static pet instead of the entry animation. Appending
    // a timestamp plus monotonic sequence forces a fresh SVG document & fresh
    // animation start each swap, even when several swaps happen in the same
    // millisecond. Infinite animations are unaffected (they look identical
    // either way). Load time stays ~0ms since the file itself is still in the
    // HTTP cache; only the in-memory SVG document is rebuilt.
    const cacheBust = `${Date.now()}-${++_imgCacheBustSeq}`;
    next.src = `${url}${url.includes("?") ? "&" : "?"}_t=${cacheBust}`;
    mediaLayer.appendChild(next);
    pendingNext = next;
    scheduleSwapVisibilityRescue(swapToken, file, state);
    // A timed-out image is not verified and must never replace the visible
    // element merely to force progress.
    next.__clawdImageLoadTimer = setTimeout(() => {
      if (pendingNext !== next) return;
      if (next.__clawdWaitingForAccessory) return;
      failImageSwap("image-load-timeout");
    }, SWAP_LOAD_FALLBACK_MS);
  }
}

function renderStateFile(requestOrState, legacySvg) {
  const visualRequest = normalizeVisualRequest(requestOrState);
  if (requestOrState && typeof requestOrState === "object" && !visualRequest) {
    try { console.warn("Clawd: ignored malformed visual request"); } catch {}
    return;
  }
  const state = visualRequest ? visualRequest.displayState : requestOrState;
  const svg = visualRequest ? visualRequest.file : legacySvg;
  // Main process state change → cancel any active click reaction
  cancelReaction();
  // Track the latest state name so the Kimi permission pulse can re-trigger
  // swapToFile() with the matching state for eye-tracking decisions.
  currentState = state;
  const requestedSvg = svg;
  const lowPowerStaticImageOverride = resolveLowPowerStaticImageOverride(state, requestedSvg);
  const effectiveSvg = lowPowerStaticImageOverride || requestedSvg;
  noteLowPowerActivity();

  // ── Roam state: add walk animation class for visual movement ──
  // When the pet is roaming (free-roam mode), add a CSS animation to simulate
  // walking even if the theme doesn't have a dedicated roam SVG. The animation
  // is a subtle horizontal bob that makes the idle SVG look like it's walking.
  // Themes with a dedicated roam visual animate themselves — no bob on top.
  if (container) {
    container.classList.toggle("roam-walk", state === "roam" && !_hasRoamVisual);
  }

  if (!shouldUseCloudlingPointerBridge(state, effectiveSvg)) {
    clearCloudlingPointerBridge();
  }

  // Dedup only when the same file resolves to the same asset URL. Imported
  // Codex Pet themes reuse filenames, so filename-only dedup can keep showing
  // the previous theme until a drag/click forces a different animation.
  const desiredObjectChannel = lowPowerStaticImageOverride ? false : needsObjectChannel(state, effectiveSvg);
  const desiredAssetUrl = getAssetUrl(effectiveSvg);
  const alreadyDisplayed = clawdEl && clawdEl.isConnected
    && currentDisplayedSvg === effectiveSvg
    && currentDisplayedAssetUrl === desiredAssetUrl;
  const displayedChannelMatches = !alreadyDisplayed || ((clawdEl.tagName === "OBJECT") === desiredObjectChannel);
  const alreadyPending = pendingSvgFile === effectiveSvg
    && pendingNext
    && pendingAssetUrl === desiredAssetUrl;
  const pendingChannelMatches = !alreadyPending || ((pendingNext.tagName === "OBJECT") === desiredObjectChannel);

  if (alreadyPending && !pendingChannelMatches) {
    cancelPendingSwap("channel-mismatch", { retainedRequest: visualRequest });
  }

  // A request that returns to the currently displayed file is terminal now,
  // but an older different-file load may still be pending. Cancel that load
  // before acknowledging the displayed request; otherwise its later load
  // event can overwrite the visual after the `already-displayed` ACK.
  if (
    alreadyDisplayed
    && displayedChannelMatches
    && pendingNext
    && !(alreadyPending && pendingChannelMatches)
  ) {
    cancelPendingSwap("superseded");
  }

  if ((alreadyDisplayed && displayedChannelMatches) || (alreadyPending && pendingChannelMatches)) {
    // Same file, no swap — but the flip is state-dependent (mini flip vs roam
    // heading), so re-apply it for the incoming state. E.g. a leftward roam
    // entering mini pre-entry reuses the same crabwalk asset; without this the
    // roam mirror would leak into the mini entry (and vice versa).
    if (alreadyDisplayed) {
      currentDisplayedState = state;
      applyMiniFlip(clawdEl, state);
      refreshAccessoryLayout();
    }
    if (alreadyPending && pendingChannelMatches) {
      // The file/channel can be reused while its state-dependent presentation
      // cannot. Retarget the pending commit so its eventual direction,
      // attachment descriptor, layout, and eye-tracking decision all use the
      // newest state rather than the state captured when loading began.
      pendingNext.__clawdPendingState = state;
      pendingNext.__clawdVisualRequest = visualRequest;
      applyObjectScaleStyle(pendingNext, effectiveSvg, state);
    }
    if (alreadyDisplayed) {
      if (tracksEyesForFile(state, effectiveSvg) && !eyeTarget && !_trackingLayers) {
        if (clawdEl.tagName === "OBJECT") attachEyeTracking(clawdEl);
      } else if (!tracksEyesForFile(state, effectiveSvg)) {
        detachEyeTracking();
      }
      if (shouldUseCloudlingPointerBridge(state, effectiveSvg) && lastCloudlingPointerPayload) {
        applyCloudlingPointerBridge(lastCloudlingPointerPayload);
      }
      scheduleLowPowerIdlePause();
    }
    currentIdleSvg = effectiveSvg;
    if (alreadyDisplayed) {
      const channel = clawdEl.tagName === "OBJECT" ? "object" : "img";
      notifyVisualSettlement(visualRequest, effectiveSvg === visualRequest?.file
        ? "already-displayed"
        : "fallback", {
        actualFile: effectiveSvg,
        channel,
        verified: true,
      });
    }
    return;
  }

  // Different file — cancel pending, detach, and swap
  cancelPendingSwap("superseded", { retainedRequest: visualRequest });
  detachEyeTracking();

  swapToFile(effectiveSvg, state, lowPowerStaticImageOverride ? false : undefined, {
    visualRequest,
    fallbackFromObject: !!lowPowerStaticImageOverride,
  });
  currentIdleSvg = effectiveSvg;
}

// --- State change → switch animation (preload + instant swap) ---
window.electronAPI.onStateChange((requestOrState, legacySvg) => {
  renderStateFile(requestOrState, legacySvg);
});

// Kimi CLI permission hold: re-trigger the current animation so it loops
// while the user is reviewing the permission prompt.
window.electronAPI.onKimiPermissionPulse(() => {
  // applyResolvedDisplayState() sends the notification visual immediately
  // before this pulse. Its pending media already owns a fresh animation
  // timeline; replacing it here would terminally fail that generation.
  if (pendingNext) return;
  if (clawdEl && clawdEl.isConnected && currentDisplayedSvg) {
    swapToFile(currentDisplayedSvg, currentState);
  }
});

// --- Eye tracking (idle state only) ---
// Two systems coexist:
//   1. Single-target (legacy): eyeTarget/bodyTarget/shadowTarget + applyEyeMove
//      Used by default clawd theme (tc.eyeTracking.ids config)
//   2. Layered tracking: per-element <g> wrappers + independent easing per layer
//      Used when tc.eyeTracking.trackingLayers is defined (e.g. calico theme)

let eyeTarget = null;
let bodyTarget = null;
let shadowTarget = null;
let lastEyeDx = 0;
let lastEyeDy = 0;
let eyeAttachToken = 0;

// ── Single-target eye tracking (legacy) ──

function applyEyeMove(dx, dy) {
  if (eyeTarget) {
    eyeTarget.setAttribute("transform", `translate(${dx}, ${dy})`);
  }
  if (bodyTarget || shadowTarget) {
    const bdx = Math.round(dx * _bodyScale * 2) / 2;
    const bdy = Math.round(dy * _bodyScale * 2) / 2;
    if (bodyTarget) bodyTarget.setAttribute("transform", `translate(${bdx}, ${bdy})`);
    if (shadowTarget) {
      const absDx = Math.abs(bdx);
      const scaleX = 1 + absDx * _shadowStretch;
      const shiftX = Math.round(bdx * _shadowShift * 2) / 2;
      shadowTarget.setAttribute("transform", `translate(${shiftX}, 0) scale(${scaleX}, 1)`);
    }
  }
}

// ── Layered tracking helpers ──

/**
 * Wrap a single SVG element in a <g> for transform control.
 * Returns the wrapper <g>, or null if element not found.
 */
function _wrapSvgElement(svgDoc, el) {
  if (!el) return null;
  const wrapper = svgDoc.createElementNS("http://www.w3.org/2000/svg", "g");
  wrapper.setAttribute("data-tracking-wrapper", "1");
  el.parentNode.insertBefore(wrapper, el);
  wrapper.appendChild(el);
  return wrapper;
}

/**
 * Unwrap all tracking wrappers in the SVG document (restore original structure).
 */
function _unwrapAll(svgDoc) {
  if (!svgDoc) return;
  try {
    const wrappers = svgDoc.querySelectorAll("[data-tracking-wrapper]");
    for (const wrapper of wrappers) {
      const parent = wrapper.parentNode;
      if (!parent) continue;
      // Move all children out of wrapper, then remove wrapper
      while (wrapper.firstChild) {
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
      parent.removeChild(wrapper);
    }
  } catch {}
}

/**
 * Calculate clamped offset for a layer (same formula as calico-test.html).
 * Maps raw distance to [0, maxOffset] with soft clamping.
 */
function _calcLayerOffset(dx, dy, maxOffset) {
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return [0, 0];
  const clamp = Math.min(dist, maxOffset * 40) / (maxOffset * 40) * maxOffset;
  return [(dx / dist) * clamp, (dy / dist) * clamp];
}

function _getLayerTarget(layer, rawDx, rawDy) {
  const scale = layer.maxOffset / (_themeMaxOffset || 20);
  return [rawDx * scale, rawDy * scale];
}

function _layerNeedsAnimation(layer, rawDx, rawDy) {
  const [tx, ty] = _getLayerTarget(layer, rawDx, rawDy);
  return Math.abs(layer.x - tx) >= LAYER_SETTLE_EPSILON
    || Math.abs(layer.y - ty) >= LAYER_SETTLE_EPSILON;
}

/**
 * Initialize layered tracking for a loaded SVG document.
 * Creates <g> wrappers for each element listed in trackingLayers config.
 */
function _initLayeredTracking(svgDoc) {
  if (!_trackingLayersConfig || !svgDoc) return;

  _trackingLayers = {};

  for (const [layerName, layerCfg] of Object.entries(_trackingLayersConfig)) {
    const wrappers = [];

    // Wrap elements by ID
    if (layerCfg.ids) {
      for (const id of layerCfg.ids) {
        const el = svgDoc.getElementById(id);
        const w = _wrapSvgElement(svgDoc, el);
        if (w) wrappers.push(w);
      }
    }

    // Wrap elements by class
    if (layerCfg.classes) {
      for (const cls of layerCfg.classes) {
        const els = svgDoc.querySelectorAll(`.${cls}`);
        for (const el of els) {
          const w = _wrapSvgElement(svgDoc, el);
          if (w) wrappers.push(w);
        }
      }
    }

    _trackingLayers[layerName] = {
      wrappers,
      maxOffset: layerCfg.maxOffset || 10,
      ease: layerCfg.ease || 0.15,
      x: 0,
      y: 0,
    };
  }

  _layerTargetDx = lastEyeDx;
  _layerTargetDy = lastEyeDy;
  if (Object.values(_trackingLayers).some(layer => _layerNeedsAnimation(layer, _layerTargetDx, _layerTargetDy))) {
    _startLayerAnimLoop();
  }
}

/**
 * Start the requestAnimationFrame easing loop for layered tracking.
 */
function _startLayerAnimLoop() {
  if (_layerAnimFrame) return; // already running

  function tick() {
    if (!_trackingLayers) { _layerAnimFrame = null; return; }
    if (shouldSuppressPassiveTrackingForLowPower()) { _layerAnimFrame = null; return; }

    const rawDx = _layerTargetDx;
    const rawDy = _layerTargetDy;
    let allSettled = true;

    for (const layer of Object.values(_trackingLayers)) {
      // Scale the pre-calculated offset (from tick.js, already in [-maxOffset, maxOffset])
      // to this layer's range. No second normalization — tick.js already did it.
      const [tx, ty] = _getLayerTarget(layer, rawDx, rawDy);

      // Lerp towards target
      layer.x += (tx - layer.x) * layer.ease;
      layer.y += (ty - layer.y) * layer.ease;

      if (Math.abs(layer.x - tx) < LAYER_SETTLE_EPSILON) layer.x = tx;
      if (Math.abs(layer.y - ty) < LAYER_SETTLE_EPSILON) layer.y = ty;

      // Snap to zero when very close (avoid sub-pixel jitter)
      if (Math.abs(layer.x) < 0.01 && Math.abs(layer.y) < 0.01 && tx === 0 && ty === 0) {
        layer.x = 0;
        layer.y = 0;
      }

      if (layer.x !== tx || layer.y !== ty) allSettled = false;

      // Quantize to quarter-pixel grid for smooth rendering
      const qx = Math.round(layer.x * 4) / 4;
      const qy = Math.round(layer.y * 4) / 4;

      // Apply transform to all wrappers in this layer
      for (const w of layer.wrappers) {
        w.setAttribute("transform", `translate(${qx},${qy})`);
      }
    }

    if (allSettled) {
      _layerAnimFrame = null;
      return;
    }

    _layerAnimFrame = requestAnimationFrame(tick);
  }

  _layerAnimFrame = requestAnimationFrame(tick);
}

function _cancelLayerAnimLoop() {
  if (_layerAnimFrame) {
    cancelAnimationFrame(_layerAnimFrame);
    _layerAnimFrame = null;
  }
}

/**
 * Clean up layered tracking: cancel RAF, unwrap elements, reset state.
 */
function _cleanupLayeredTracking() {
  _cancelLayerAnimLoop();

  // Unwrap elements in the current SVG if still accessible
  if (_trackingLayers && clawdEl && clawdEl.tagName === "OBJECT") {
    try {
      _unwrapAll(clawdEl.contentDocument);
    } catch {}
  }

  _trackingLayers = null;
  _layerTargetDx = 0;
  _layerTargetDy = 0;
  _layeredTrackingObj = null;
  _layeredTrackingDocument = null;
}

// ── Attach / Detach (dispatches to correct system) ──

function attachEyeTracking(objectEl) {
  if (!objectEl || objectEl.tagName !== "OBJECT") return;
  const token = ++eyeAttachToken;
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;

  const tryAttach = (attempt) => {
    if (token !== eyeAttachToken) return;
    if (!objectEl || !objectEl.isConnected) return;

    try {
      const svgDoc = objectEl.contentDocument;
      if (!svgDoc) {
        if (attempt < EYE_ATTACH_MAX_ATTEMPTS) setTimeout(() => tryAttach(attempt + 1), EYE_ATTACH_RETRY_MS);
        return;
      }

      // Layered tracking: wrap elements and start RAF loop
      if (_useLayeredTracking) {
        // Skip if already tracking this exact <object> element
        if (_trackingLayers && _layeredTrackingObj === objectEl) return;
        _initLayeredTracking(svgDoc);
        _layeredTrackingObj = objectEl;
        _layeredTrackingDocument = svgDoc;
        return;
      }

      // Single-target tracking (legacy)
      const eyes = svgDoc && svgDoc.getElementById(_eyeIds.eyes);
      if (eyes) {
        eyeTarget = eyes;
        bodyTarget = svgDoc.getElementById(_eyeIds.body);
        shadowTarget = svgDoc.getElementById(_eyeIds.shadow);
        applyEyeMove(lastEyeDx, lastEyeDy);
        return;
      }
    } catch (e) {
      console.warn("Cannot access SVG contentDocument for eye tracking:", e.message);
      return;
    }

    if (attempt >= EYE_ATTACH_MAX_ATTEMPTS) {
      console.warn("Timed out waiting for SVG eye targets");
      return;
    }
    setTimeout(() => tryAttach(attempt + 1), EYE_ATTACH_RETRY_MS);
  };

  tryAttach(0);
}

function detachEyeTracking() {
  eyeAttachToken++;
  // Single-target cleanup
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
  // Layered tracking cleanup
  _cleanupLayeredTracking();
}

function isEyeTrackingReady() {
  if (!clawdEl || clawdEl.tagName !== "OBJECT" || !clawdEl.isConnected) return false;
  let currentDocument = null;
  try {
    currentDocument = clawdEl.contentDocument;
  } catch {
    return false;
  }
  if (!currentDocument) return false;
  if (_trackingLayers && _layeredTrackingObj === clawdEl) {
    return _layeredTrackingDocument === currentDocument;
  }
  return !!(eyeTarget
    && eyeTarget.ownerDocument === currentDocument
    && eyeTarget.ownerDocument.defaultView);
}

function waitForWakeEyeTrackingReady(callback, attempt = 0) {
  if (isEyeTrackingReady()) {
    callback(true);
    return;
  }
  if (attempt >= EYE_ATTACH_MAX_ATTEMPTS) {
    callback(false);
    return;
  }
  setTimeout(() => waitForWakeEyeTrackingReady(callback, attempt + 1), EYE_ATTACH_RETRY_MS);
}

function reportSystemWakeStatus(status) {
  if (window.electronAPI && typeof window.electronAPI.reportSystemWakeStatus === "function") {
    window.electronAPI.reportSystemWakeStatus(status);
  }
}

function finishSystemWake(status) {
  pendingSystemWakeId = null;
  lastSystemWakeId = status.id;
  lastSystemWakeStatus = status;
  reportSystemWakeStatus(status);
  if (queuedSystemWakePayload && !queuedSystemWakeReplayTimer) {
    queuedSystemWakeReplayTimer = setTimeout(() => {
      queuedSystemWakeReplayTimer = null;
      const payload = queuedSystemWakePayload;
      queuedSystemWakePayload = null;
      if (payload) recoverFromSystemWake(payload);
    }, 0);
  }
}

function recoverFromSystemWake(payload) {
  const id = payload && typeof payload.id === "string" ? payload.id : "";
  if (!id || id.length > 96) return;
  if (id === lastSystemWakeId && lastSystemWakeStatus) {
    reportSystemWakeStatus(lastSystemWakeStatus);
    return;
  }
  if (pendingSystemWakeId || queuedSystemWakeReplayTimer) {
    if (id !== pendingSystemWakeId) queuedSystemWakePayload = payload;
    return;
  }

  const rootBefore = getCurrentSvgRoot();
  const lowPowerWasPaused = lowPowerSvgPaused || hasLowPowerPauseStyle(rootBefore);
  const eyeTargetWasCurrentDocument = isEyeTrackingReady();

  // Do this even when the local mirror says false: the injected pause style or
  // the embedded SVG timeline can outlive that boolean across a system sleep.
  resumeCurrentSvgForLowPower();
  if (lowPowerIdleMode) scheduleLowPowerIdlePause();

  const needsEyes = tracksEyesForFile(currentState, currentDisplayedSvg);
  const shouldReloadEyeObject = lowPowerIdleMode
    && needsEyes
    && clawdEl
    && clawdEl.tagName === "OBJECT"
    && currentDisplayedSvg;

  if (shouldReloadEyeObject) {
    const wakeContext = {
      id,
      wakeState: currentState,
      wakeSvg: currentDisplayedSvg,
      lowPowerWasPaused,
      pauseStyleRemoved: !hasLowPowerPauseStyle(),
      eyeTargetWasCurrentDocument,
    };

    const finishWakeEyeObjectReload = (objectEl) => {
      waitForWakeEyeTrackingReady((eyeTrackingReady) => {
        if (pendingSystemWakeId !== wakeContext.id) return;
        const stillCurrentWakeObject = clawdEl === objectEl
          && currentDisplayedSvg === wakeContext.wakeSvg
          && currentState === wakeContext.wakeState;
        const ready = stillCurrentWakeObject && eyeTrackingReady;
        finishSystemWake({
          id: wakeContext.id,
          result: ready ? "resumed" : "error",
          lowPowerWasPaused: wakeContext.lowPowerWasPaused,
          pauseStyleRemoved: wakeContext.pauseStyleRemoved,
          eyeTrackingReady: ready,
          eyeTargetWasCurrentDocument: wakeContext.eyeTargetWasCurrentDocument,
          objectReloaded: stillCurrentWakeObject,
          eyeTargetRebound: ready,
        });
      });
    };

    const failWakeEyeObjectReload = () => {
      if (pendingSystemWakeId !== wakeContext.id) return;
      if (clawdEl && clawdEl.tagName === "OBJECT" && clawdEl.isConnected) {
        attachEyeTracking(clawdEl);
      }
      const eyeTrackingReady = isEyeTrackingReady();
      finishSystemWake({
        id: wakeContext.id,
        result: "error",
        lowPowerWasPaused: wakeContext.lowPowerWasPaused,
        pauseStyleRemoved: wakeContext.pauseStyleRemoved,
        eyeTrackingReady,
        eyeTargetWasCurrentDocument: wakeContext.eyeTargetWasCurrentDocument,
        objectReloaded: false,
        eyeTargetRebound: !wakeContext.eyeTargetWasCurrentDocument && eyeTrackingReady,
      });
    };

    const reloadWakeObject = (reloadAttempt = 0) => {
      if (pendingSystemWakeId !== wakeContext.id) return;
      if (currentState !== wakeContext.wakeState || currentDisplayedSvg !== wakeContext.wakeSvg) {
        failWakeEyeObjectReload();
        return;
      }
      swapToFile(wakeContext.wakeSvg, wakeContext.wakeState, true, {
        allowImageFallback: false,
        forceDocumentReload: true,
        onReady: finishWakeEyeObjectReload,
        onError: (reason) => {
          if (pendingSystemWakeId !== wakeContext.id) return;
          if (reason === "object-document-unavailable" && reloadAttempt < WAKE_OBJECT_RELOAD_RETRIES) {
            reloadWakeObject(reloadAttempt + 1);
            return;
          }
          failWakeEyeObjectReload();
        },
      });
    };

    pendingSystemWakeId = id;
    detachEyeTracking();
    reloadWakeObject();
    return;
  }

  if (needsEyes && !isEyeTrackingReady() && clawdEl && clawdEl.tagName === "OBJECT") {
    detachEyeTracking();
    attachEyeTracking(clawdEl);
  }

  const status = {
    id,
    result: rootBefore ? "resumed" : "no-svg",
    lowPowerWasPaused,
    pauseStyleRemoved: !hasLowPowerPauseStyle(),
    eyeTrackingReady: !needsEyes || isEyeTrackingReady(),
    eyeTargetWasCurrentDocument,
    objectReloaded: false,
    eyeTargetRebound: needsEyes && !eyeTargetWasCurrentDocument && isEyeTrackingReady(),
  };
  finishSystemWake(status);
}

window.electronAPI.onEyeMove((dx, dy) => {
  const effectiveDx = miniLeftFlip ? -dx : dx;
  lastEyeDx = effectiveDx;
  lastEyeDy = dy;

  if (lowPowerIdleMode) noteLowPowerActivity();

  if (shouldSuppressPassiveTrackingForLowPower()) {
    _cancelLayerAnimLoop();
    return;
  }

  if ((eyeTarget || _trackingLayers) && !isEyeTrackingReady()) {
    detachEyeTracking();
    if (clawdEl && clawdEl.isConnected && clawdEl.tagName === "OBJECT"
      && tracksEyesForFile(currentState, currentDisplayedSvg)) attachEyeTracking(clawdEl);
    return;
  }

  if (_trackingLayers) {
    // Layered tracking: store targets, RAF loop handles easing
    _layerTargetDx = effectiveDx;
    _layerTargetDy = dy;
    _startLayerAnimLoop();
    return;
  }

  // Single-target tracking (legacy)
  applyEyeMove(effectiveDx, dy);
});

if (window.electronAPI && typeof window.electronAPI.onSystemWake === "function") {
  window.electronAPI.onSystemWake(recoverFromSystemWake);
}

if (window.electronAPI && typeof window.electronAPI.onCloudlingPointer === "function") {
  window.electronAPI.onCloudlingPointer((payload) => {
    applyCloudlingPointerBridge(payload);
  });
}

if (window.electronAPI && typeof window.electronAPI.onRoamHeading === "function") {
  window.electronAPI.onRoamHeading((headingLeft) => {
    _roamHeadingLeft = !!headingLeft;
    // Re-apply in place: consecutive walks reuse the displayed roam visual
    // without a swap, and if this message lands after the state-change (IPC
    // order across channels is not contractual) the flip captured at IMG
    // creation is stale — refresh both the on-screen and the pending element.
    applyMiniFlip(clawdEl, currentState);
  });
}

if (window.electronAPI && typeof window.electronAPI.onPetScreenSide === "function") {
  window.electronAPI.onPetScreenSide((onRight) => {
    _petOnRightSide = !!onRight;
    applyMiniFlip(clawdEl, currentState);
  });
}

// --- Sound playback (IPC from main, receives { url, volume } from theme) ---
const _audioCache = {};
const AUDIO_WARMUP_STALE_MS = 10000;
const AUDIO_WARMUP_DELAY_MS = 50;
const AUDIO_WARMUP_VOLUME = 0.001;
let _lastAudioWarmupAt = 0;

function reportSoundPlaybackError(phase, err) {
  const message = err && err.message ? err.message : String(err || "unknown");
  if (window.electronAPI && typeof window.electronAPI.reportSoundPlaybackError === "function") {
    window.electronAPI.reportSoundPlaybackError({ phase, message });
    return;
  }
  try { console.warn(`Clawd sound ${phase} failed:`, message); } catch {}
}

function cacheAudio(url) {
  if (typeof url !== "string" || !url) return null;
  let audio = _audioCache[url];
  const created = !audio;
  if (!audio) {
    audio = new Audio(url);
    audio.preload = "auto";
    _audioCache[url] = audio;
  }
  if (created) {
    try { audio.load(); } catch {}
  }
  return audio;
}

function normalizeSoundUrls(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.urls) ? payload.urls : []);
  return raw.filter((url) => typeof url === "string" && url);
}

function warmAudioOutput(url, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - _lastAudioWarmupAt < AUDIO_WARMUP_STALE_MS) {
    return Promise.resolve();
  }
  if (!url) return Promise.resolve();
  _lastAudioWarmupAt = now;

  const primer = new Audio(url);
  primer.preload = "auto";
  primer.volume = AUDIO_WARMUP_VOLUME;
  return primer.play()
    .then(() => new Promise((resolve) => {
      setTimeout(() => {
        try { primer.pause(); } catch {}
        resolve();
      }, AUDIO_WARMUP_DELAY_MS);
    }))
    .catch((err) => {
      reportSoundPlaybackError("warmup", err);
    });
}

if (window.electronAPI && typeof window.electronAPI.onPreloadSounds === "function") {
  window.electronAPI.onPreloadSounds((payload) => {
    const urls = normalizeSoundUrls(payload);
    urls.forEach((url) => cacheAudio(url));
  });
}

window.electronAPI.onPlaySound((payload) => {
  const url = typeof payload === "string" ? payload : payload && payload.url;
  const volume = typeof payload === "object" && payload && typeof payload.volume === "number"
    ? Math.max(0, Math.min(1, payload.volume))
    : 1;
  if (!url) return;
  // Preview URLs carry a `_t=` cache-buster so every click is a fresh URL;
  // caching them would grow the map unboundedly (one entry per preview click)
  // for no benefit since the URL will never be requested again. Only cache
  // real playback URLs.
  const isPreview = url.includes("_t=");
  const audio = isPreview ? new Audio(url) : cacheAudio(url);
  if (!audio) return;
  if (isPreview) audio.preload = "auto";
  warmAudioOutput(url).then(() => {
    audio.volume = volume;
    audio.currentTime = 0;
    audio.play().catch((err) => reportSoundPlaybackError("play", err));
  });
});
// Same-extension override replacement overwrites the file on disk without
// changing the URL, so the cached Audio object keeps its old buffered data.
// Main sends this after a successful pick so the next playback re-loads.
window.electronAPI.onInvalidateSoundCache((url) => {
  if (typeof url === "string" && url) delete _audioCache[url];
});

// --- Wake from doze (smooth eye opening) ---
window.electronAPI.onWakeFromDoze(() => {
  if (clawdEl && clawdEl.tagName === "OBJECT" && clawdEl.contentDocument) {
    try {
      const eyes = clawdEl.contentDocument.getElementById(_eyeIds.dozeEyes || "eyes-doze");
      if (eyes) eyes.style.transform = "scaleY(1)";
    } catch (e) {}
  }
});

// --- Initial frame: always go through swapToFile so the right channel and theme scaling apply ---
if (!currentDisplayedSvg && _initialIdleSvg) {
  currentIdleSvg = _initialIdleSvg;
  swapToFile(_initialIdleSvg, "idle");
}
