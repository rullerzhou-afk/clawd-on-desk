// --- Pointer-based drag + click detection (with Pointer Capture for safety) ---
const container = document.getElementById("pet-container");
let isDragging = false;
let didDrag = false; // true if pointer moved > threshold during this press
let lastScreenX, lastScreenY;
let mouseDownX, mouseDownY;
let pendingDx = 0, pendingDy = 0;
let dragRAF = null;
const DRAG_THRESHOLD = 3; // px — less than this = click, more = drag

container.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    container.setPointerCapture(e.pointerId);  // Guarantees pointerup even if pointer leaves window
    isDragging = true;
    didDrag = false;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    pendingDx = 0;
    pendingDy = 0;
    window.electronAPI.dragLock(true);
    container.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    pendingDx += e.screenX - lastScreenX;
    pendingDy += e.screenY - lastScreenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    // Mark as drag if moved beyond threshold
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction();
      }
    }

    if (!dragRAF) {
      dragRAF = requestAnimationFrame(() => {
        window.electronAPI.moveWindowBy(pendingDx, pendingDy);
        pendingDx = 0;
        pendingDy = 0;
        dragRAF = null;
      });
    }
  }
});

function stopDrag() {
  if (!isDragging) return;
  isDragging = false;
  window.electronAPI.dragLock(false);
  container.classList.remove("dragging");
  // Flush pending delta before releasing
  if (pendingDx !== 0 || pendingDy !== 0) {
    if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = null; }
    window.electronAPI.moveWindowBy(pendingDx, pendingDy);
    pendingDx = 0; pendingDy = 0;
  }
  // Only trigger edge snap check on actual drags (not clicks)
  if (didDrag) {
    window.electronAPI.dragEnd();
  }
  endDragReaction();
}

document.addEventListener("pointerup", (e) => {
  if (e.button === 0) {
    const wasDrag = didDrag;
    stopDrag();
    if (!wasDrag) {
      handleClick(e.clientX);
    }
  }
});

// Pointer Capture can end via OS interruption (Alt+Tab, system dialog, etc.)
container.addEventListener("pointercancel", stopDrag);
container.addEventListener("lostpointercapture", () => {
  if (isDragging) stopDrag();
});

window.addEventListener("blur", stopDrag);

// --- Do Not Disturb (synced from main process) ---
let dndEnabled = false;
window.electronAPI.onDndChange((enabled) => { dndEnabled = enabled; });

// --- Mini Mode (synced from main process) ---
let miniMode = false;
window.electronAPI.onMiniModeChange((enabled) => {
  miniMode = enabled;
  container.style.cursor = enabled ? "default" : "";
});

// --- Click reaction (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;  // max gap between consecutive clicks
const REACT_LEFT_SVG = "clawd-react-left.svg";
const REACT_RIGHT_SVG = "clawd-react-right.svg";
const REACT_DOUBLE_SVG = "clawd-react-double.svg";
const REACT_DRAG_SVG = "clawd-react-drag.svg";
const REACT_SINGLE_DURATION = 2500;
const REACT_DOUBLE_DURATION = 3500;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;     // direction from the first click in a sequence
let isReacting = false;       // click reaction animation is playing
let isDragReacting = false;   // drag reaction is active
let reactTimer = null;        // auto-return timer
let currentIdleSvg = null;    // tracks which SVG is currently showing

function handleClick(clientX) {
  if (miniMode) {
    window.electronAPI.exitMiniMode();
    return;
  }
  if (isReacting || isDragReacting) return;
  if (currentIdleSvg !== "clawd-idle-follow.svg" && currentIdleSvg !== "clawd-idle-living.svg") return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < container.offsetWidth / 2 ? "left" : "right";
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  if (clickCount >= 4) {
    // 4+ clicks → flail reaction (东张西望)
    clickCount = 0;
    firstClickDir = null;
    playReaction(REACT_DOUBLE_SVG, REACT_DOUBLE_DURATION);
  } else if (clickCount >= 2) {
    // 2-3 clicks → wait briefly for more, then poke reaction
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const svg = firstClickDir === "left" ? REACT_LEFT_SVG : REACT_RIGHT_SVG;
      clickCount = 0;
      firstClickDir = null;
      playReaction(svg, REACT_SINGLE_DURATION);
    }, CLICK_WINDOW_MS);
  } else {
    // 1 click → wait for more (single click alone does nothing)
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

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
  next.data = `../assets/svg/${svgFile}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
  };

  next.addEventListener("load", swap, { once: true });
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
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
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
  next.data = `../assets/svg/${svgFile}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;
  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
  };
  next.addEventListener("load", swap, { once: true });
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

window.electronAPI.onStateChange((state, svg) => {
  // Main process state change → cancel any active click reaction
  cancelReaction();

  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }
  detachEyeTracking();

  const next = document.createElement("object");
  next.data = `../assets/svg/${svg}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;

    if (svg === "clawd-idle-follow.svg" || svg.startsWith("clawd-mini-")) {
      attachEyeTracking(next);
    } else {
      detachEyeTracking();
    }

    // Track current SVG for click reaction gating
    currentIdleSvg = svg;
  };

  next.addEventListener("load", swap, { once: true });
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

function attachEyeTracking(objectEl) {
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
  try {
    const svgDoc = objectEl.contentDocument;
    if (svgDoc) {
      eyeTarget = svgDoc.getElementById("eyes-js");
      bodyTarget = svgDoc.getElementById("body-js");
      shadowTarget = svgDoc.getElementById("shadow-js");
    }
  } catch (e) {
    console.warn("Cannot access SVG contentDocument for eye tracking:", e.message);
  }
}

function detachEyeTracking() {
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
}

window.electronAPI.onEyeMove((dx, dy) => {
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

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.electronAPI.showContextMenu();
});
