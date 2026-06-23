// --- Render window: pure view (SVG rendering + eye tracking) ---
// All input (pointer/drag/click) is handled by the hit window (hit-renderer.js).
// Reactions are triggered via IPC from main (relayed from hit window).

const container = document.getElementById("pet-container");
const clipLayer = document.getElementById("pet-clip");
let clawdEl = document.getElementById("clawd");
let pendingNext = null;
const LOW_POWER_IDLE_PAUSE_MS = 5000;
const SWAP_LOAD_FALLBACK_MS = 3000;
const SWAP_VISIBILITY_RESCUE_BUFFER_MS = 750;
const LOW_POWER_PAUSE_STYLE_ID = "clawd-low-power-pause-svg";
const LOW_POWER_PAUSE_STATES = new Set(["idle", "mini-idle", "dozing"]);
const LOW_POWER_BOUNDARY_EPSILON_MS = 80;
const CLOUDLING_POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);
let lowPowerIdleMode = false;
let lowPowerIdlePauseTimer = null;
let lowPowerSvgPaused = false;
let _lowPowerStaticImageOverrides = {};

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
  _lowPowerStaticImageOverrides = (tc.rendering && tc.rendering.lowPowerStaticImageOverrides) || {};
  _imgCacheBustSeq = 0;
  _miniViewBox = tc.miniModeViewBox || null;
  _fileViewBoxes = tc.fileViewBoxes || {};
  _dragSvg = tc.dragSvg || null;
  _dragSvgs = tc.dragSvgs || {};
  _idleFollowSvg = tc.idleFollowSvg || "clawd-idle-follow.svg";
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

  applyObjectScaleStyle(clawdEl, getObjectSvgName(clawdEl), null);
  applyObjectScaleStyle(pendingNext, getObjectSvgName(pendingNext), null);
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

function getCurrentSvgRoot() {
  if (!clawdEl || clawdEl.tagName !== "OBJECT") return null;
  try {
    const svgDoc = clawdEl.contentDocument;
    return svgDoc ? svgDoc.documentElement : null;
  } catch {
    return null;
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
  if (next) _cancelLayerAnimLoop();
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
  if (!root) return;
  if (waitForBoundary) {
    const delayMs = getLowPowerAnimationBoundaryDelayMs(root);
    if (delayMs > 0) {
      lowPowerIdlePauseTimer = setTimeout(() => {
        lowPowerIdlePauseTimer = null;
        pauseCurrentSvgForLowPower();
      }, delayMs);
      return;
    }
  }
  const svgDoc = root.ownerDocument;
  if (svgDoc && !svgDoc.getElementById(LOW_POWER_PAUSE_STYLE_ID)) {
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
  try {
    if (typeof root.pauseAnimations === "function") root.pauseAnimations();
  } catch {}
  setCurrentScriptedSvgLowPowerPaused(true);
  setLowPowerSvgPaused(true);
}

function resumeCurrentSvgForLowPower() {
  if (lowPowerIdlePauseTimer) {
    clearTimeout(lowPowerIdlePauseTimer);
    lowPowerIdlePauseTimer = null;
  }
  const root = getCurrentSvgRoot();
  if (root) {
    try {
      const svgDoc = root.ownerDocument;
      const style = svgDoc && svgDoc.getElementById(LOW_POWER_PAUSE_STYLE_ID);
      if (style) style.remove();
      if (typeof root.unpauseAnimations === "function") root.unpauseAnimations();
    } catch {}
  }
  setCurrentScriptedSvgLowPowerPaused(false);
  setLowPowerSvgPaused(false);
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
  refreshCurrentStateForLowPowerStaticImage();
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
let _imgCacheBustSeq = 0;
let _miniViewBox = null;
let _fileViewBoxes = {};
let _dragSvg;
let _dragSvgs;
let currentDragSvg = null;
let _idleFollowSvg;
let _glyphFlipDefs;
let _objectScaleCSS;
let _fileScales = {};
let _fileOffsets = {};
let _transitions = {};  // per-file fade config: { "file.apng": { in: 400, out: 400 } }
let _miniFlipAssets = false; // theme's mini assets drawn in reverse direction
let _inMiniMode = false;
let _miniPreEntryMode = false;
let _viewportOffsetY = 0;

function setViewportOffset(offsetY) {
  const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
  if (next === _viewportOffsetY) return;
  _viewportOffsetY = next;
  applyObjectScaleStyle(clawdEl, currentDisplayedSvg, currentState);
  if (pendingNext) {
    applyObjectScaleStyle(pendingNext, getObjectSvgName(pendingNext), currentState);
  }
}

function shouldApplyMiniAssetFlip(state) {
  return _miniFlipAssets && (_inMiniMode || (_miniPreEntryMode && state === "mini-crabwalk"));
}

function applyMiniFlip(el, state = currentState) {
  if (!el || el.tagName !== "IMG") return;
  el.style.transform = shouldApplyMiniAssetFlip(state) ? "scaleX(-1)" : "";
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
const LAYER_SETTLE_EPSILON = 0.02;

initWithConfig(tc);

// Theme switch: reload + IPC push overrides additionalArguments
window.electronAPI.onThemeConfig((newConfig) => {
  // Clean up layered tracking before reinitializing
  _cleanupLayeredTracking();
  initWithConfig(newConfig);
  // Re-anchor the worn accessory to the new theme's headAnchor.
  reapplyAccessory();
});

window.electronAPI.onViewportOffset((offsetY) => {
  setViewportOffset(offsetY);
});

// ── Cosmetic accessory (the pet's wardrobe) ──
// The worn item is injected as an <image> INSIDE the pet's live SVG document,
// parented to the animated body group — so it inherits every transform (the
// per-pose head position, the breathe/lean motion, the mini flip) and stays
// glued to the head instead of floating in window space.
//
// `aspect` = the asset's viewBox w/h (so injected height is derived from width).
// `wScale` scales the item vs the theme's base head width; `dy` nudges the
// resting line (+down) in viewBox units — e.g. a halo floats above the head.
// Placement comes from the theme's `layout.headAnchor` in viewBox units:
//   { cx: head centre x, baseY: head-top line, width: base hat width }.
const ACCESSORY_ASSETS = {
  "cowboy-hat": { file: "cowboy-hat.svg",  aspect: 16 / 7 },
  "party-hat":  { file: "party-hat.svg",   aspect: 11 / 14, wScale: 0.7,  dy: 0.3 },
  "wizard-hat": { file: "wizard-hat.svg",  aspect: 15 / 16, wScale: 0.95, dy: 0.3 },
  "top-hat":    { file: "top-hat.svg",     aspect: 14 / 10, wScale: 0.88, dy: 0.2 },
  "santa-hat":  { file: "santa-hat.svg",   aspect: 16 / 9,  wScale: 1.0,  dy: 0.2 },
  "pumpkin-hat":{ file: "pumpkin-hat.svg", aspect: 13 / 9,  wScale: 0.85, dy: 0.4 },
  "halo":       { file: "halo.svg",        aspect: 14 / 5,  wScale: 1.15, dy: -1.4 },
};
// viewBox-unit fallback if a theme declares no headAnchor (clawd-ish framing).
// `width` = base hat width in viewBox units; `eyeGap` = units above the eyes
// where the hat base rests; cx/baseY are the fixed fallback when no eyes found.
const DEFAULT_HEAD_ANCHOR = { cx: 7.5, baseY: 6.5, width: 16, eyeGap: 2.5 };
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
let _accessoryId = "none";       // the stored pref ("none" | concrete id | "seasonal")
let _accessoryActive = false;    // resolves to a real item right now (drives channel)
let _accessoryCacheBust = 0;
let _seasonalTimer = null;

// "seasonal" is a meta-id resolved by calendar date to a concrete item. Returns
// "none" out of season. Birthday/other dates can be added later.
function resolveSeasonalAccessory() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const day = now.getDate();
  if (month === 12) return "santa-hat";        // December → Santa
  if (month === 10) return "pumpkin-hat";       // October → pumpkin
  if (month === 1 && day === 1) return "party-hat"; // New Year's Day
  return "none";
}

function resolveAccessoryId() {
  if (_accessoryId === "seasonal") return resolveSeasonalAccessory();
  return _accessoryId;
}

function accNum(v, d) { return Number.isFinite(v) ? v : d; }

// Find the pet's eyes group in a pose SVG. Every clawd pose draws eyes on the
// head (ids/classes vary: eyes-js, eyes-code, eyes-blink…), so the eyes are a
// reliable, pose-agnostic head marker.
function findEyesEl(svgDoc) {
  return svgDoc.querySelector('[id^="eyes"]')
    || svgDoc.querySelector('[id^="eye"]')
    || svgDoc.querySelector('[class~="eyes"]')
    || svgDoc.querySelector('[class*="eye"]')
    || null;
}

// Inject (or clear) the worn item inside the given SVG document. Idempotent.
// The item is anchored to the eyes' bounding box and parented to the eyes'
// group, so it sits on the head AND inherits that group's transforms (breathe,
// body-bounce, lean) in every pose — no per-state tuning needed.
function injectAccessory(svgDoc) {
  if (!svgDoc) return;
  const root = svgDoc.documentElement;
  if (!root) return;
  const prior = svgDoc.getElementById("clawd-acc");
  if (prior) prior.remove();

  const item = ACCESSORY_ASSETS[resolveAccessoryId()];
  if (!item) return;

  const a = (_layout && _layout.headAnchor) || DEFAULT_HEAD_ANCHOR;
  const baseW = accNum(a.width, DEFAULT_HEAD_ANCHOR.width);
  const eyeGap = accNum(a.eyeGap, DEFAULT_HEAD_ANCHOR.eyeGap);

  let cx;
  let baseY;       // the head line the hat's base rests on
  let parent = null;

  const eyes = findEyesEl(svgDoc);
  if (eyes) {
    try {
      const bb = eyes.getBBox();
      if (bb && Number.isFinite(bb.x) && bb.width >= 0) {
        cx = bb.x + bb.width / 2;
        baseY = bb.y - eyeGap;            // a touch above the eyes = top of head
        parent = eyes.parentNode || null;  // share the eyes' animated group
      }
    } catch { /* getBBox can throw on a not-yet-laid-out doc */ }
  }
  if (parent == null || !Number.isFinite(cx)) {
    // Fallback: fixed theme anchor at the root (no pose tracking, best effort).
    cx = accNum(a.cx, DEFAULT_HEAD_ANCHOR.cx);
    baseY = accNum(a.baseY, DEFAULT_HEAD_ANCHOR.baseY);
    parent = svgDoc.getElementById("body-js") || root;
  }

  const w = baseW * (item.wScale || 1);
  const h = w / (item.aspect || 1.6);
  const dy = item.dy || 0;
  const x = cx - w / 2;
  const y = baseY + dy - h; // bottom-anchored: the item's base sits at baseY+dy

  const img = svgDoc.createElementNS(SVG_NS, "image");
  img.setAttribute("id", "clawd-acc");
  img.setAttribute("x", String(x));
  img.setAttribute("y", String(y));
  img.setAttribute("width", String(w));
  img.setAttribute("height", String(h));
  img.setAttribute("preserveAspectRatio", "xMidYMax meet");
  img.style.pointerEvents = "none";
  // Absolute file URL so it resolves regardless of the SVG doc's own location;
  // cache-bust to dodge Chromium's same-URL SVG reuse.
  const href = new URL("../assets/accessories/" + item.file, document.baseURI).href
    + "?_t=" + (++_accessoryCacheBust);
  img.setAttribute("href", href);
  img.setAttributeNS(XLINK_NS, "href", href);

  parent.appendChild(img);
}

// Re-apply to the live pet. If it's already an object SVG, inject directly;
// otherwise re-swap the current state so the channel flips (an active accessory
// forces the object channel for SVG states — see needsObjectChannel).
function reapplyAccessory() {
  _accessoryActive = !!ACCESSORY_ASSETS[resolveAccessoryId()];
  if (clawdEl && clawdEl.tagName === "OBJECT" && clawdEl.contentDocument) {
    injectAccessory(clawdEl.contentDocument);
    if (!_accessoryActive) return; // nothing more to do when clearing
  }
  if (currentDisplayedSvg && (!clawdEl || clawdEl.tagName !== "OBJECT") && _accessoryActive && isSvgFile(currentDisplayedSvg)) {
    // currently an <img> SVG but we want the hat → re-render through object channel
    swapToFile(currentDisplayedSvg, currentState, needsObjectChannel(currentState, currentDisplayedSvg));
  }
}

function setAccessory(id) {
  const valid = id === "seasonal" || (typeof id === "string" && ACCESSORY_ASSETS[id]);
  _accessoryId = valid ? id : "none";
  // Re-resolve "seasonal" hourly so it flips across midnight / month boundaries.
  if (_seasonalTimer) { clearInterval(_seasonalTimer); _seasonalTimer = null; }
  if (_accessoryId === "seasonal") {
    _seasonalTimer = setInterval(reapplyAccessory, 60 * 60 * 1000);
  }
  reapplyAccessory();
}

if (window.electronAPI && typeof window.electronAPI.onSetAccessory === "function") {
  window.electronAPI.onSetAccessory(setAccessory);
}

// ── Pet color tint (palette swaps) ──
// A CSS filter applied to the pet sprite only (the accessory keeps its own
// colors). Re-applied on every swap because each state is a fresh element.
const TINT_FILTERS = {
  none: "",
  midnight: "hue-rotate(200deg) saturate(1.2) brightness(0.82)",
  gold: "sepia(0.8) saturate(2.2) hue-rotate(-18deg) brightness(1.05)",
  vaporwave: "hue-rotate(265deg) saturate(1.6) contrast(1.05)",
  mono: "grayscale(1) brightness(1.05)",
  matcha: "hue-rotate(75deg) saturate(1.25) brightness(1.0)",
};
let _petTint = "none";

function applyPetTint() {
  if (!clawdEl) return;
  clawdEl.style.filter = TINT_FILTERS[_petTint] || "";
}

function setPetTint(id) {
  _petTint = (typeof id === "string" && TINT_FILTERS[id] != null) ? id : "none";
  applyPetTint();
}

if (window.electronAPI && typeof window.electronAPI.onSetPetTint === "function") {
  window.electronAPI.onSetPetTint(setPetTint);
}

// ── Test-result reactions ──
// One-shot, theme-agnostic delight when a test command finishes: a confetti
// burst over the pet on pass, a quick shake on fail. Pure DOM/CSS — no
// dependency on per-theme reaction SVGs. Triggered by main via IPC.
const CONFETTI_COLORS = ["#ff5d8f", "#ffd166", "#4ec3e0", "#8a5cff", "#5ad17a"];

function burstConfetti() {
  const n = 18;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "clawd-confetti";
    const startX = 30 + Math.floor((i / n) * 40); // spread across the head
    const dx = (i % 2 === 0 ? 1 : -1) * (10 + (i * 7) % 60);
    const delay = (i % 6) * 40;
    p.style.left = startX + "%";
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    p.style.setProperty("--dx", dx + "px");
    p.style.animationDelay = delay + "ms";
    container.appendChild(p);
    // Remove after the animation (1.2s + max delay) to avoid DOM buildup.
    setTimeout(() => { try { p.remove(); } catch {} }, 1500 + delay);
  }
}

function shakePet() {
  const target = container;
  target.classList.remove("clawd-shake");
  // Force reflow so re-adding the class restarts the animation.
  void target.offsetWidth;
  target.classList.add("clawd-shake");
  setTimeout(() => { try { target.classList.remove("clawd-shake"); } catch {} }, 650);
}

function playTestReaction(result) {
  if (result === "pass") burstConfetti();
  else if (result === "fail") shakePet();
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
let isDragReacting = false;
let reactTimer = null;
let currentIdleSvg = null;    // tracks which SVG is currently showing
let currentState = null;      // last state name received from main (for re-pulse)
let currentRequestedSvg = null; // original state file from main, before low-power substitution
let lastCloudlingPointerPayload = null;
let dndEnabled = false;
let miniLeftFlip = false;

if (window.electronAPI && typeof window.electronAPI.onLowPowerIdleModeChange === "function") {
  window.electronAPI.onLowPowerIdleModeChange(setLowPowerIdleMode);
}

window.electronAPI.onDndChange((enabled) => { dndEnabled = enabled; });

window.electronAPI.onMiniModeChange((enabled, edge, options) => {
  const preEntry = !!(options && options.preEntry);
  _miniPreEntryMode = !!enabled && preEntry;
  _inMiniMode = !!enabled && !preEntry;
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
});

// Multi-monitor seam clip: in mini mode at an internal seam, main sends the
// fraction of the window width that falls on the local display. We clip the
// rest away so the half that physically crosses onto the neighbouring
// monitor renders nothing there — the local display keeps the half-body peek.
//
// The clip is applied to #pet-clip, which (unlike #pet-container) never
// carries transform: scaleX(-1). A clip-path on the flipped container would
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
 * Determine if a state+file needs the <object> channel.
 */
function needsObjectChannel(state, file) {
  if (!isSvgFile(file)) return false;
  // A worn accessory is injected into the SVG document, so SVG *state* poses
  // must use the object channel. `state` is falsy for one-shot reaction swaps —
  // we leave those on the image channel to avoid freezing their animation.
  if (_accessoryActive && state) return true;
  return _forceSvgObjectChannel || needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);
}

function resolveLowPowerStaticImageOverride(state, file) {
  if (!lowPowerIdleMode) return null;
  const override = _lowPowerStaticImageOverrides && _lowPowerStaticImageOverrides[state];
  if (!override || override.from !== file || !override.to) return null;
  return override.to;
}

function hasLowPowerStaticImageOverride(state, file) {
  const override = _lowPowerStaticImageOverrides && _lowPowerStaticImageOverrides[state];
  return !!(override && override.from === file && override.to);
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
window.electronAPI.onStartDragReaction((direction) => startDragReaction(direction));
window.electronAPI.onEndDragReaction(() => endDragReaction());
window.electronAPI.onPlayClickReaction((svg, duration) => playReaction(svg, duration));

function playReaction(svgFile, durationMs) {
  isReacting = true;
  detachEyeTracking();
  resumeCurrentSvgForLowPower();
  window.electronAPI.pauseCursorPolling();

  // Reactions do not attach eye tracking, but some themes force SVGs through
  // <object> so their SVG documents can load local sub-resources.
  swapToFile(svgFile, null);

  reactTimer = setTimeout(() => endReaction(), durationMs);
}

function endReaction() {
  if (!isReacting) return;
  isReacting = false;
  reactTimer = null;
  window.electronAPI.resumeFromReaction();
}

function cancelReaction() {
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }
  if (isDragReacting) {
    isDragReacting = false;
  }
}

// --- Drag reaction (loops while dragging) ---
function startDragReaction(direction) {
  if (dndEnabled) return;
  const dragSvg = (direction && _dragSvgs[direction]) || _dragSvg;
  if (!dragSvg) return;
  if (isDragReacting && currentDragSvg === dragSvg) return;

  if (!isDragReacting && isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }

  isDragReacting = true;
  currentDragSvg = dragSvg;
  detachEyeTracking();
  resumeCurrentSvgForLowPower();
  window.electronAPI.pauseCursorPolling();
  swapToFile(dragSvg, null);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  currentDragSvg = null;
  window.electronAPI.resumeFromReaction();
}

// --- Generic swap function: handles both <object> and <img> channels ---
let currentDisplayedSvg = getObjectSvgName(clawdEl);
let currentDisplayedAssetUrl = null;
let pendingSvgFile = null; // tracks the SVG currently being loaded (for dedup)
let pendingAssetUrl = null;
let activeSwapToken = 0;
let swapVisibilityRescueTimer = null;
currentIdleSvg = currentDisplayedSvg;

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
  return [...container.querySelectorAll("object, img.clawd-img")];
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
      forceImageChannelReload(file, state);
      return;
    }

    if (forceVisiblePetElement(clawdEl)) return;
    forceImageChannelReload(file, state);
  }, getSwapVisibilityRescueDelay(file));
  swapVisibilityRescueTimer = timer;
}

function forceImageChannelReload(file, state, allowImageFallback = true) {
  if (!allowImageFallback) return false;
  if (!file) return false;
  if (hasVisiblePetElement()) return false;
  console.warn("Clawd: animation stayed invisible; reloading through the image channel:", file);
  swapToFile(file, state, false, { allowImageFallback: false });
  return true;
}

function swapToFile(file, state, useObjectChannel, options = {}) {
  const swapToken = ++activeSwapToken;
  const allowImageFallback = options.allowImageFallback !== false;
  if (pendingNext) {
    if (pendingNext.tagName === "OBJECT") releaseObject(pendingNext);
    else releaseImg(pendingNext);
    pendingNext = null;
    pendingAssetUrl = null;
  }

  pendingSvgFile = file; // track what's loading for dedup
  const useObj = useObjectChannel !== undefined ? useObjectChannel : needsObjectChannel(state, file);
  const url = getAssetUrl(file);
  pendingAssetUrl = url;

  if (useObj) {
    // Object channel: <object type="image/svg+xml">
    const next = document.createElement("object");
    next.type = "image/svg+xml";
    next.id = "clawd";
    next.style.opacity = "0";
    applyObjectScaleStyle(next, file, state);

    const swap = () => {
      if (pendingNext !== next) return;
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

      for (const child of [...container.querySelectorAll("object, img.clawd-img")]) {
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
      currentDisplayedAssetUrl = url;
      applyPetTint();
      injectAccessory(next.contentDocument);

      if (state && needsEyeTracking(state)) {
        attachEyeTracking(next);
      }
      if (miniLeftFlip) applyGlyphFlipCompensation(next);
      if (shouldUseCloudlingPointerBridge(currentState, file) && lastCloudlingPointerPayload) {
        callCloudlingPointerBridge(next, getDisplayedCloudlingPointerPayload(lastCloudlingPointerPayload));
      }
      scheduleLowPowerIdlePause();
    };

    next.addEventListener("load", swap, { once: true });
    // Same cache-bust as the <img> channel below. Chromium reuses the SVG
    // document (and its CSS animation timeline) across loads of the same
    // URL on the object channel too, so one-shot animations for scripted /
    // eye-tracking SVGs would stall on their last frame on re-entry. A fresh
    // query each swap forces a fresh document. Bookkeeping (currentDisplayed
    // /pendingAssetUrl) stays keyed on the base `url`, not the busted one.
    const cacheBust = `${Date.now()}-${++_imgCacheBustSeq}`;
    next.data = `${url}${url.includes("?") ? "&" : "?"}_t=${cacheBust}`;
    container.appendChild(next);
    pendingNext = next;
    scheduleSwapVisibilityRescue(swapToken, file, state);
    setTimeout(() => {
      if (pendingNext !== next) return;
      try {
        if (!next.contentDocument) {
          releaseObject(next);
          pendingNext = null;
          pendingSvgFile = null;
          pendingAssetUrl = null;
          forceImageChannelReload(file, state, allowImageFallback);
          return;
        }
      } catch {}
      swap();
    }, SWAP_LOAD_FALLBACK_MS);
  } else {
    // Img channel: <img> for pure playback (all formats)
    const next = document.createElement("img");
    next.className = "clawd-img";
    next.id = "clawd";
    next.style.opacity = "0";
    applyObjectScaleStyle(next, file, state);
    applyMiniFlip(next, state);

    const swap = () => {
      if (pendingNext !== next) return;
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

      for (const child of [...container.querySelectorAll("object, img.clawd-img")]) {
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
      currentDisplayedAssetUrl = url;
      applyPetTint();
      scheduleLowPowerIdlePause();
    };

    next.addEventListener("load", swap, { once: true });
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
    container.appendChild(next);
    pendingNext = next;
    scheduleSwapVisibilityRescue(swapToken, file, state);
    // Timeout fallback for images that fail to load
    setTimeout(() => {
      if (pendingNext !== next) return;
      swap();
    }, SWAP_LOAD_FALLBACK_MS);
  }
}

function renderStateFile(state, svg) {
  // Main process state change → cancel any active click reaction
  cancelReaction();
  // Track the latest state name so the Kimi permission pulse can re-trigger
  // swapToFile() with the matching state for eye-tracking decisions.
  currentState = state;
  currentRequestedSvg = svg;
  const requestedSvg = svg;
  const lowPowerStaticImageOverride = resolveLowPowerStaticImageOverride(state, requestedSvg);
  const effectiveSvg = lowPowerStaticImageOverride || requestedSvg;
  noteLowPowerActivity();

  // ── Roam state: add walk animation class for visual movement ──
  // When the pet is roaming (free-roam mode), add a CSS animation to simulate
  // walking even if the theme doesn't have a dedicated roam SVG. The animation
  // is a subtle horizontal bob that makes the idle SVG look like it's walking.
  if (container) {
    container.classList.toggle("roam-walk", state === "roam");
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

  if ((alreadyDisplayed && displayedChannelMatches) || (alreadyPending && pendingChannelMatches)) {
    if (alreadyDisplayed) {
      if (needsEyeTracking(state) && !eyeTarget && !_trackingLayers) {
        if (clawdEl.tagName === "OBJECT") attachEyeTracking(clawdEl);
      } else if (!needsEyeTracking(state)) {
        detachEyeTracking();
      }
      if (shouldUseCloudlingPointerBridge(state, effectiveSvg) && lastCloudlingPointerPayload) {
        applyCloudlingPointerBridge(lastCloudlingPointerPayload);
      }
      scheduleLowPowerIdlePause();
    }
    currentIdleSvg = effectiveSvg;
    return;
  }

  // Different file — cancel pending, detach, and swap
  if (pendingNext) {
    if (pendingNext.tagName === "OBJECT") releaseObject(pendingNext);
    else releaseImg(pendingNext);
    pendingNext = null;
    pendingSvgFile = null;
    pendingAssetUrl = null;
  }
  detachEyeTracking();

  swapToFile(effectiveSvg, state, lowPowerStaticImageOverride ? false : undefined);
  currentIdleSvg = effectiveSvg;
}

function refreshCurrentStateForLowPowerStaticImage() {
  if (!currentState || !currentRequestedSvg) return;
  if (!hasLowPowerStaticImageOverride(currentState, currentRequestedSvg)) return;
  renderStateFile(currentState, currentRequestedSvg);
}

// --- State change → switch animation (preload + instant swap) ---
window.electronAPI.onStateChange((state, svg) => {
  renderStateFile(state, svg);
});

// Kimi CLI permission hold: re-trigger the current animation so it loops
// while the user is reviewing the permission prompt.
window.electronAPI.onKimiPermissionPulse(() => {
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
        if (attempt < 60) setTimeout(() => tryAttach(attempt + 1), 16);
        return;
      }

      // Layered tracking: wrap elements and start RAF loop
      if (_useLayeredTracking) {
        // Skip if already tracking this exact <object> element
        if (_trackingLayers && _layeredTrackingObj === objectEl) return;
        _initLayeredTracking(svgDoc);
        _layeredTrackingObj = objectEl;
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

    if (attempt >= 60) {
      console.warn("Timed out waiting for SVG eye targets");
      return;
    }
    setTimeout(() => tryAttach(attempt + 1), 16);
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

window.electronAPI.onEyeMove((dx, dy) => {
  const effectiveDx = miniLeftFlip ? -dx : dx;
  lastEyeDx = effectiveDx;
  lastEyeDy = dy;

  if (shouldSuppressPassiveTrackingForLowPower()) {
    _cancelLayerAnimLoop();
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
  // Detect stale eye targets (e.g. after DWM z-order recovery invalidates contentDocument)
  if (eyeTarget && !eyeTarget.ownerDocument?.defaultView) {
    eyeTarget = null;
    bodyTarget = null;
    shadowTarget = null;
    if (clawdEl && clawdEl.isConnected && clawdEl.tagName === "OBJECT") attachEyeTracking(clawdEl);
    return;
  }
  applyEyeMove(effectiveDx, dy);
});

if (window.electronAPI && typeof window.electronAPI.onCloudlingPointer === "function") {
  window.electronAPI.onCloudlingPointer((payload) => {
    applyCloudlingPointerBridge(payload);
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
if (!currentDisplayedSvg && _idleFollowSvg) {
  currentIdleSvg = _idleFollowSvg;
  swapToFile(_idleFollowSvg, "idle");
}
