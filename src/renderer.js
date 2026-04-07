// --- Render window: pure view (SVG rendering + eye tracking) ---
// All input (pointer/drag/click) is handled by the hit window (hit-renderer.js).
// Reactions are triggered via IPC from main (relayed from hit window).

const container = document.getElementById("pet-container");

// ── Theme config (injected via preload.js additionalArguments) ──
let tc = window.themeConfig || {};

function initWithConfig(cfg) {
  tc = cfg || {};
  _assetsPath = tc.assetsPath || "../assets/svg";
  _sourceAssetsPath = tc.sourceAssetsPath || null;
  _eyeIds = (tc.eyeTracking && tc.eyeTracking.ids) || { eyes: "eyes-js", body: "body-js", shadow: "shadow-js", dozeEyes: "eyes-doze" };
  _bodyScale = (tc.eyeTracking && tc.eyeTracking.bodyScale) || 0.33;
  _shadowStretch = (tc.eyeTracking && tc.eyeTracking.shadowStretch) || 0.15;
  _shadowShift = (tc.eyeTracking && tc.eyeTracking.shadowShift) || 0.3;
  _eyeTrackingStates = (tc.eyeTrackingStates) || ["idle", "dozing", "mini-idle"];
  _dragSvg = tc.dragSvg || "clawd-react-drag.svg";
  _idleFollowSvg = tc.idleFollowSvg || "clawd-idle-follow.svg";
  _glyphFlipDefs = tc.glyphFlips || { "pixel-z": 4, "pixel-z-small": 3 };
}

let _assetsPath;
let _sourceAssetsPath;
let _eyeIds;
let _bodyScale;
let _shadowStretch;
let _shadowShift;
let _eyeTrackingStates;
let _dragSvg;
let _idleFollowSvg;
let _glyphFlipDefs;
initWithConfig(tc);

// Theme switch: reload + IPC push overrides additionalArguments
window.electronAPI.onThemeConfig((newConfig) => {
  initWithConfig(newConfig);
});

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
let dndEnabled = false;
let miniLeftFlip = false;

window.electronAPI.onDndChange((enabled) => { dndEnabled = enabled; });

window.electronAPI.onMiniModeChange((enabled, edge) => {
  miniLeftFlip = enabled && edge === "left";
  container.classList.toggle("mini-left", miniLeftFlip);
  if (miniLeftFlip) {
    applyGlyphFlipCompensation(clawdEl);
  } else {
    removeGlyphFlipCompensation(clawdEl);
  }
});

// Counter-flip asymmetric pixel-art glyphs (Zzz) inside SVG defs so they
// render correctly when the container has scaleX(-1). Only the glyph shape
// is flipped — CSS animation transforms (float direction) are unaffected.
function applyGlyphFlipCompensation(objectEl) {
  if (!objectEl || objectEl.tagName !== "OBJECT") return;
  try {
    const doc = objectEl.contentDocument;
    if (!doc) return;
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
// Img channel: <img> for all other formats (SVG/GIF/APNG/WebP pure playback)

/**
 * Determine if a state+file needs the <object> channel (eye tracking).
 */
function needsObjectChannel(state, file) {
  if (!file) return false;
  if (!file.endsWith(".svg")) return false;
  return _eyeTrackingStates.includes(state);
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
window.electronAPI.onStartDragReaction(() => startDragReaction());
window.electronAPI.onEndDragReaction(() => endDragReaction());
window.electronAPI.onPlayClickReaction((svg, duration) => playReaction(svg, duration));

function playReaction(svgFile, durationMs) {
  isReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();

  // Reactions always use <img> channel (no eye tracking needed)
  swapToFile(svgFile, null, false);

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
function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return;

  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }

  isDragReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();
  swapToFile(_dragSvg, null, false);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.electronAPI.resumeFromReaction();
}

// --- Generic swap function: handles both <object> and <img> channels ---
let clawdEl = document.getElementById("clawd");
let pendingNext = null;
let currentDisplayedSvg = getObjectSvgName(clawdEl);
currentIdleSvg = currentDisplayedSvg;

/**
 * Swap to a new animation file.
 * @param {string} file - animation filename
 * @param {string|null} state - current state name (for eye tracking decision)
 * @param {boolean} [useObjectChannel] - force object channel (true), img (false), or auto (undefined)
 */
function swapToFile(file, state, useObjectChannel) {
  if (pendingNext) {
    if (pendingNext.tagName === "OBJECT") releaseObject(pendingNext);
    else releaseImg(pendingNext);
    pendingNext = null;
  }

  const useObj = useObjectChannel !== undefined ? useObjectChannel : needsObjectChannel(state, file);
  const url = getAssetUrl(file);

  if (useObj) {
    // Object channel: <object type="image/svg+xml">
    const next = document.createElement("object");
    next.type = "image/svg+xml";
    next.id = "clawd";
    next.style.opacity = "0";

    const swap = () => {
      if (pendingNext !== next) return;
      next.style.transition = "none";
      next.style.opacity = "1";
      for (const child of [...container.querySelectorAll("object, img.clawd-img")]) {
        if (child !== next) {
          if (child.tagName === "OBJECT") releaseObject(child);
          else releaseImg(child);
        }
      }
      pendingNext = null;
      clawdEl = next;
      currentDisplayedSvg = file;

      if (state && needsObjectChannel(state, file)) {
        attachEyeTracking(next);
      }
      if (miniLeftFlip) applyGlyphFlipCompensation(next);
    };

    next.addEventListener("load", swap, { once: true });
    next.data = url;
    container.appendChild(next);
    pendingNext = next;
    setTimeout(() => {
      if (pendingNext !== next) return;
      try { if (!next.contentDocument) { releaseObject(next); pendingNext = null; return; } } catch {}
      swap();
    }, 3000);
  } else {
    // Img channel: <img> for pure playback (all formats)
    const next = document.createElement("img");
    next.className = "clawd-img";
    next.id = "clawd";
    next.style.opacity = "0";

    const swap = () => {
      if (pendingNext !== next) return;
      next.style.transition = "none";
      next.style.opacity = "1";
      for (const child of [...container.querySelectorAll("object, img.clawd-img")]) {
        if (child !== next) {
          if (child.tagName === "OBJECT") releaseObject(child);
          else releaseImg(child);
        }
      }
      pendingNext = null;
      clawdEl = next;
      currentDisplayedSvg = file;
    };

    next.addEventListener("load", swap, { once: true });
    next.src = url;
    container.appendChild(next);
    pendingNext = next;
    // Timeout fallback for images that fail to load
    setTimeout(() => {
      if (pendingNext !== next) return;
      swap();
    }, 3000);
  }
}

// --- Usage badge (below pet during working/thinking states) ---
const usageBadge = document.getElementById("usage-badge");
let usageBadgeData = null;
const USAGE_BADGE_STATES = new Set(["working", "thinking", "juggling"]);

function pickBarColor(pct) {
  if (pct >= 80) return "#ff5252";
  if (pct >= 50) return "#ffab40";
  return "#69f0ae";
}

function fmtRemaining(resetAt) {
  if (!resetAt) return null;
  const resetMs = typeof resetAt === "number" && resetAt < 1e12 ? resetAt * 1000 : new Date(resetAt).getTime();
  if (Number.isNaN(resetMs)) return null;
  const diff = resetMs - Date.now();
  if (diff <= 0) return "0m";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function renderUsageBadge(state) {
  if (!usageBadge) return;
  const fh = usageBadgeData && usageBadgeData.rate_limits && usageBadgeData.rate_limits.five_hour;
  if (!fh || typeof fh.used_percentage !== "number" || !USAGE_BADGE_STATES.has(state)) {
    usageBadge.classList.remove("visible");
    return;
  }
  const pct = Math.round(fh.used_percentage);
  const color = pickBarColor(pct);
  const remaining = fmtRemaining(fh.resets_at);
  const text = remaining ? `${pct}%/${remaining}` : `${pct}%`;
  usageBadge.textContent = text;
  usageBadge.style.color = color;
  usageBadge.classList.add("visible");
}

window.electronAPI.onUsageUpdate((data) => {
  usageBadgeData = data;
});

// --- State change → switch animation (preload + instant swap) ---
window.electronAPI.onStateChange((state, svg) => {
  renderUsageBadge(state);
  // Main process state change → cancel any active click reaction
  cancelReaction();

  if (pendingNext) {
    if (pendingNext.tagName === "OBJECT") releaseObject(pendingNext);
    else releaseImg(pendingNext);
    pendingNext = null;
  }

  // Same file already displayed — just update eye tracking state
  if (clawdEl && clawdEl.isConnected && currentDisplayedSvg === svg) {
    if (needsObjectChannel(state, svg) && !eyeTarget) {
      if (clawdEl.tagName === "OBJECT") attachEyeTracking(clawdEl);
    } else if (!needsObjectChannel(state, svg)) {
      detachEyeTracking();
    }
    currentIdleSvg = svg;
    return;
  }
  detachEyeTracking();

  swapToFile(svg, state);
  currentIdleSvg = svg;
});

// --- Eye tracking (idle state only) ---
let eyeTarget = null;
let bodyTarget = null;
let shadowTarget = null;
let lastEyeDx = 0;
let lastEyeDy = 0;
let eyeAttachToken = 0;

function applyEyeMove(dx, dy) {
  if (eyeTarget) {
    eyeTarget.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  if (bodyTarget || shadowTarget) {
    const bdx = Math.round(dx * _bodyScale * 2) / 2;
    const bdy = Math.round(dy * _bodyScale * 2) / 2;
    if (bodyTarget) bodyTarget.style.transform = `translate(${bdx}px, ${bdy}px)`;
    if (shadowTarget) {
      const absDx = Math.abs(bdx);
      const scaleX = 1 + absDx * _shadowStretch;
      const shiftX = Math.round(bdx * _shadowShift * 2) / 2;
      shadowTarget.style.transform = `translate(${shiftX}px, 0) scaleX(${scaleX})`;
    }
  }
}

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
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
}

window.electronAPI.onEyeMove((dx, dy) => {
  const effectiveDx = miniLeftFlip ? -dx : dx;
  lastEyeDx = effectiveDx;
  lastEyeDy = dy;
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

// --- Sound playback (IPC from main) ---
const _audioCache = {};
window.electronAPI.onPlaySound((name) => {
  let audio = _audioCache[name];
  if (!audio) {
    audio = new Audio(`../assets/sounds/${name}.mp3`);
    _audioCache[name] = audio;
  }
  audio.currentTime = 0;
  audio.play().catch(() => {});
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

// --- Initial frame: set data from theme config (avoids hardcoded path in HTML) ---
if (clawdEl && clawdEl.tagName === "OBJECT" && !clawdEl.data) {
  const initialSvg = _idleFollowSvg;
  const url = getAssetUrl(initialSvg);
  clawdEl.data = url;
  currentDisplayedSvg = initialSvg;
  currentIdleSvg = initialSvg;
  // Attach eye tracking once loaded
  clawdEl.addEventListener("load", () => {
    if (clawdEl && clawdEl.isConnected) {
      attachEyeTracking(clawdEl);
      if (miniLeftFlip) applyGlyphFlipCompensation(clawdEl);
    }
  }, { once: true });
}
