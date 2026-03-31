// --- Render window: pure view (SVG rendering + eye tracking) ---
// All input (pointer/drag/click) is handled by the hit window (hit-renderer.js).
// Reactions are triggered via IPC from main (relayed from hit window).

const container = document.getElementById("pet-container");

// --- Reaction state (visual side) ---
const REACT_DRAG_SVG = "clawd-react-drag.svg";
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
const GLYPH_FLIP_DEFS = { "pixel-z": 4, "pixel-z-small": 3 };

function applyGlyphFlipCompensation(objectEl) {
  if (!objectEl) return;
  try {
    const doc = objectEl.contentDocument;
    if (!doc) return;
    for (const [id, w] of Object.entries(GLYPH_FLIP_DEFS)) {
      const el = doc.getElementById(id);
      if (el) el.setAttribute("transform", `translate(${w}, 0) scale(-1, 1)`);
    }
  } catch {}
}

function removeGlyphFlipCompensation(objectEl) {
  if (!objectEl) return;
  try {
    const doc = objectEl.contentDocument;
    if (!doc) return;
    for (const id of Object.keys(GLYPH_FLIP_DEFS)) {
      const el = doc.getElementById(id);
      if (el) el.removeAttribute("transform");
    }
  } catch {}
}

function getObjectSvgName(objectEl) {
  if (!objectEl) return null;
  const data = objectEl.getAttribute("data") || objectEl.data || "";
  if (!data) return null;
  const clean = data.split(/[?#]/)[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || null;
}

const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";

function shouldTrackEyes(state, svg) {
  return (state === "idle" && svg === SVG_IDLE_FOLLOW) || state === "mini-idle";
}

// --- IPC-triggered reactions (from hit window via main relay) ---
window.electronAPI.onStartDragReaction(() => startDragReaction());
window.electronAPI.onEndDragReaction(() => endDragReaction());
window.electronAPI.onPlayClickReaction((svg, duration) => playReaction(svg, duration));

function playReaction(svgFile, durationMs) {
  isReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();

  // Reuse existing swap pattern
  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }

  const next = document.createElement("object");
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svgFile;
  };

  next.addEventListener("load", swap, { once: true });
  next.data = `../assets/svg/${svgFile}`;
  container.appendChild(next);
  pendingNext = next;
  setTimeout(() => {
    if (pendingNext !== next) return;
    // If SVG failed to load, abandon swap and keep current display
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);

  reactTimer = setTimeout(() => endReaction(), durationMs);
}

function endReaction() {
  if (!isReacting) return;
  isReacting = false;
  reactTimer = null;
  window.electronAPI.resumeFromReaction();
}

function cancelReaction() {
  // Click timers are now in hit-renderer.js — only clear local reaction state
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }
  if (isDragReacting) {
    isDragReacting = false;
  }
}

// --- Drag reaction (loops while dragging, idle-follow only) ---
function swapToSvg(svgFile) {
  if (pendingNext) { pendingNext.remove(); pendingNext = null; }
  const next = document.createElement("object");
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svgFile;
  };
  next.addEventListener("load", swap, { once: true });
  next.data = `../assets/svg/${svgFile}`;
  container.appendChild(next);
  pendingNext = next;
  setTimeout(() => {
    if (pendingNext !== next) return;
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);
}

function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return;  // DND: just move the window, no reaction animation

  // Drag interrupts click reaction if active
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }

  isDragReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();
  swapToSvg(REACT_DRAG_SVG);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.electronAPI.resumeFromReaction();
}

// --- State change → switch SVG animation (preload + instant swap) ---
let clawdEl = document.getElementById("clawd");
let pendingNext = null;
let currentDisplayedSvg = getObjectSvgName(clawdEl);
currentIdleSvg = currentDisplayedSvg;

window.electronAPI.onStateChange((state, svg) => {
  // Main process state change → cancel any active click reaction
  cancelReaction();

  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }
  if (clawdEl && clawdEl.isConnected && currentDisplayedSvg === svg) {
    if (shouldTrackEyes(state, svg) && !eyeTarget) {
      attachEyeTracking(clawdEl);
    } else if (!shouldTrackEyes(state, svg)) {
      detachEyeTracking();
    }
    currentIdleSvg = svg;
    return;
  }
  detachEyeTracking();

  const next = document.createElement("object");
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
    currentDisplayedSvg = svg;

    if (shouldTrackEyes(state, svg)) {
      attachEyeTracking(next);
    }
    if (miniLeftFlip) applyGlyphFlipCompensation(next);

    // Track current SVG for click reaction gating
    currentIdleSvg = svg;
  };

  next.addEventListener("load", swap, { once: true });
  next.data = `../assets/svg/${svg}`;
  container.appendChild(next);
  pendingNext = next;
  setTimeout(() => {
    if (pendingNext !== next) return;
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);
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
    const bdx = Math.round(dx * 0.33 * 2) / 2;
    const bdy = Math.round(dy * 0.33 * 2) / 2;
    if (bodyTarget) bodyTarget.style.transform = `translate(${bdx}px, ${bdy}px)`;
    if (shadowTarget) {
      // Shadow stretches toward lean direction (feet stay anchored)
      const absDx = Math.abs(bdx);
      const scaleX = 1 + absDx * 0.15;
      const shiftX = Math.round(bdx * 0.3 * 2) / 2;
      shadowTarget.style.transform = `translate(${shiftX}px, 0) scaleX(${scaleX})`;
    }
  }
}

function attachEyeTracking(objectEl) {
  const token = ++eyeAttachToken;
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;

  const tryAttach = (attempt) => {
    if (token !== eyeAttachToken) return;
    if (!objectEl || !objectEl.isConnected) return;

    try {
      const svgDoc = objectEl.contentDocument;
      const eyes = svgDoc && svgDoc.getElementById("eyes-js");
      if (eyes) {
        eyeTarget = eyes;
        bodyTarget = svgDoc.getElementById("body-js");
        shadowTarget = svgDoc.getElementById("shadow-js");
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
    // setTimeout fallback — rAF may be throttled in unfocused windows
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
    if (clawdEl && clawdEl.isConnected) attachEyeTracking(clawdEl);
    return;
  }
  applyEyeMove(effectiveDx, dy);
});

// --- Wake from doze (smooth eye opening) ---
window.electronAPI.onWakeFromDoze(() => {
  if (clawdEl && clawdEl.contentDocument) {
    try {
      const eyes = clawdEl.contentDocument.getElementById("eyes-doze");
      if (eyes) eyes.style.transform = "scaleY(1)";
    } catch (e) {}
  }
});

