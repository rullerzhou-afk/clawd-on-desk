// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// ── Platform (injected via preload-hit.js additionalArguments) ──
const isMac = !!(window.hitPlatform && window.hitPlatform.isMac);

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
  window.hitAPI.onThemeConfig((cfg) => {
    tc = cfg || {};
    _reactions = (tc && tc.reactions) || {};
  });
}

// --- State synced from main ---
let currentSvg = null;
let currentState = null;
let miniMode = false;
let dndEnabled = false;
let petelecoEnabled = false;

window.hitAPI.onStateSync((data) => {
  if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
  if (data.petelecoEnabled !== undefined) {
    petelecoEnabled = !!data.petelecoEnabled;
    // Turning the feature off mid-gesture must not strand the aim: the main
    // side stops accepting aim updates, so the overlay would hang around.
    if (!petelecoEnabled && isAiming) stopAim(false);
  }
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let mouseDownX, mouseDownY;
let lastDragClientX;
let dragReactionDirection = null;
let dragMoveRAF = null;
const DRAG_THRESHOLD = 3;

// --- Peteleco (flick) aim state ---
// The modifier drag is a DIFFERENT gesture, not a decorated drag: while aiming
// the pet must hold still (it is the cue ball), so this branch never sends
// dragMove and never plays a drag reaction. Main owns the projection and the
// launch; this file only reports where the pointer is.
let isAiming = false;
let didAim = false;
let aimMoveRAF = null;
const AIM_THRESHOLD = 4;

// Which modifier arms the gesture. Ctrl everywhere except macOS, where
// Ctrl+click IS the system right-click gesture (Chromium synthesizes a
// contextmenu from it), so aiming would fight the context menu. Option/Alt is
// the free modifier there — Cmd-click is already the Dashboard shortcut.
function isPetelecoModifier(e) {
  if (isMac) return !!e.altKey && !e.metaKey && !e.ctrlKey;
  return !!e.ctrlKey && !e.metaKey && !e.altKey;
}

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
  isReacting = false;
  isDragReacting = false;
  dragReactionDirection = null;
});

function queueAimMove() {
  if (aimMoveRAF !== null) return;
  aimMoveRAF = requestAnimationFrame(() => {
    aimMoveRAF = null;
    if (!isAiming) return;
    window.hitAPI.petelecoAimMove();
  });
}

function clearQueuedAimMove() {
  if (aimMoveRAF === null) return;
  cancelAnimationFrame(aimMoveRAF);
  aimMoveRAF = null;
}

// Ends an aim gesture. `commit` distinguishes a real release (pointerup) from
// an abort (capture lost, window blur, feature switched off). Returns true only
// when a shot was actually fired, so the caller knows whether the gesture was
// consumed or should fall through to click handling.
function stopAim(commit) {
  if (!isAiming) return false;
  clearQueuedAimMove();
  isAiming = false;
  area.classList.remove("aiming");
  const fired = !!commit && didAim;
  didAim = false;
  // Order is no longer load-bearing: main releases the gesture's drag lock
  // inside its own aim-end handler, so this dragLock(false) is a defensive
  // no-op on the fired path and the real release on the cancelled one.
  if (fired) window.hitAPI.petelecoAimEnd();
  else window.hitAPI.petelecoAimCancel();
  window.hitAPI.dragLock(false);
  return fired;
}

function queueDragMove() {
  if (dragMoveRAF !== null) return;
  dragMoveRAF = requestAnimationFrame(() => {
    dragMoveRAF = null;
    if (!isDragging) return;
    window.hitAPI.dragMove();
  });
}

function clearQueuedDragMove() {
  if (dragMoveRAF === null) return;
  cancelAnimationFrame(dragMoveRAF);
  dragMoveRAF = null;
}

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    area.setPointerCapture(e.pointerId);
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    if (petelecoEnabled && isPetelecoModifier(e)) {
      isAiming = true;
      didAim = false;
      // Still take the drag lock: it cancels roam and hands the pet's position
      // to this gesture for its whole duration. Only dragMove is skipped.
      window.hitAPI.dragLock(true);
      window.hitAPI.petelecoAimStart();
      area.classList.add("aiming");
      return;
    }
    isDragging = true;
    didDrag = false;
    lastDragClientX = e.clientX;
    dragReactionDirection = null;
    window.hitAPI.dragLock(true);
    area.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isAiming) {
    if (!didAim) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > AIM_THRESHOLD || Math.abs(totalDy) > AIM_THRESHOLD) {
        didAim = true;
      }
    }
    if (didAim) queueAimMove();
    return;
  }
  if (isDragging) {
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction(totalDx < 0 ? "left" : (totalDx > 0 ? "right" : null));
      }
    } else {
      const stepDx = e.clientX - lastDragClientX;
      if (stepDx !== 0) startDragReaction(stepDx < 0 ? "left" : "right");
    }
    lastDragClientX = e.clientX;
    queueDragMove();
  }
});

function stopDrag() {
  if (!isDragging) return;
  clearQueuedDragMove();
  isDragging = false;
  window.hitAPI.dragLock(false);
  area.classList.remove("dragging");
  if (didDrag) {
    window.hitAPI.dragEnd();
  }
  // A state-change cancel can arrive after pointer movement and clear the
  // input window's local reaction flag. The render window may already have
  // received startDragReaction, so an actual drag must still complete the
  // end handshake on pointerup/cancel/lost capture/blur.
  endDragReaction(didDrag);
}

document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  // A modifier press that never moved is still a modifier CLICK — fall through
  // to the shortcut/click handling below so Ctrl-click keeps opening the
  // Dashboard. Only a real pull consumes the gesture.
  if (isAiming && stopAim(true)) return;
  const wasDrag = didDrag;
  stopDrag();
  if (wasDrag) return;

  // macOS Ctrl-click is the system right-click gesture. Let the OS / our
  // contextmenu handler deal with it; do NOT treat it as the Dashboard
  // shortcut, and do NOT fall through to handleClick (would otherwise
  // leak into the click accumulator).
  if (isMac && e.ctrlKey && !e.metaKey) {
    resetClickAccumulator();
    return;
  }

  // Dashboard shortcut: Cmd-click on mac, Ctrl-click elsewhere.
  const isDashboardShortcut = isMac ? e.metaKey : (e.ctrlKey && !e.metaKey);
  if (isDashboardShortcut) {
    resetClickAccumulator();
    window.hitAPI.showDashboard();
    return;
  }

  handleClick(e.clientX);
});

area.addEventListener("pointercancel", () => { stopAim(false); stopDrag(); });
area.addEventListener("lostpointercapture", () => {
  stopAim(false);
  if (isDragging) stopDrag();
});
window.addEventListener("blur", () => { stopAim(false); stopDrag(); });

// --- Click reaction logic (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;

function _getReaction(name) {
  return _reactions[name] || null;
}

function resetClickAccumulator() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  clickCount = 0;
  firstClickDir = null;
}

// Fresh-read at reaction timer fire time, NOT closured at click time —
// state / DND may change inside the 400 ms accumulator window.
function canPlayReactionNow() {
  return currentState === "idle" && !dndEnabled && !isReacting;
}

function handleClick(clientX) {
  if (miniMode) {
    window.hitAPI.exitMiniMode();
    return;
  }
  if (isDragReacting) return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
    // First click reveals the session HUD. Lightweight side effect — NOT
    // gated by isReacting (HUD reveal is independent of pet animation).
    window.hitAPI.revealSessionHud();
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (clickCount >= 4 && doubleReact) {
    clickCount = 0;
    firstClickDir = null;
    if (!canPlayReactionNow()) return;
    const files = doubleReact.files || [doubleReact.file];
    const file = files[Math.floor(Math.random() * files.length)];
    playReaction(file, doubleReact.duration || 3500);
  } else if (clickCount >= 2) {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      const dir = firstClickDir;
      firstClickDir = null;
      if (!canPlayReactionNow()) return;
      if (annoyedReact && Math.random() < 0.5) {
        playReaction(annoyedReact.file, annoyedReact.duration || 3500);
      } else if (leftReact && rightReact) {
        const react = dir === "left" ? leftReact : rightReact;
        playReaction(react.file, react.duration || 2500);
      }
    }, CLICK_WINDOW_MS);
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

function playReaction(svg, duration) {
  if (!svg) return;
  isReacting = true;
  window.hitAPI.playClickReaction(svg, duration);
  // Local timer to ungate input after duration
  setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction(direction) {
  if (dndEnabled) return;
  if (isDragReacting && dragReactionDirection === direction) return;

  if (isReacting) {
    isReacting = false;
  }

  isDragReacting = true;
  dragReactionDirection = direction;
  window.hitAPI.startDragReaction(direction);
}

function endDragReaction(force = false) {
  if (!isDragReacting && !force) return;
  isDragReacting = false;
  dragReactionDirection = null;
  window.hitAPI.endDragReaction();
}

// --- OS file drop → open terminal at that directory (#459, Windows/Linux only) ---
// macOS is OUT: the pet windows live at screen-saver level so they stay above
// fullscreen apps, and macOS drag-destination search never delivers drag
// events to windows at that level (real-machine bisect, 2026-06-11 — lowering
// only the hit window doesn't help either, the overlapping screen-saver render
// window still blocks the search; ignoresMouseEvents passes mouse events
// through but NOT drag destinations). Don't re-attempt without changing the
// window-level model; listeners are simply not registered on mac.
//
// Affordance gating lives HERE (not only in main): in mini mode dragover must
// not preventDefault, so the OS shows "no drop" instead of a copy cursor that
// would then do nothing. Main re-checks mini (and platform) as the second layer.
function dragHasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (const t of types) { if (t === "Files") return true; }
  return false;
}

if (!isMac) {
  area.addEventListener("dragover", (e) => {
    if (miniMode || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  area.addEventListener("drop", (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (miniMode) return;
    const paths = [];
    for (const file of e.dataTransfer.files || []) {
      const p = window.hitAPI.getPathForFile(file);
      if (typeof p === "string" && p) paths.push(p);
    }
    if (paths.length) window.hitAPI.dropPaths(paths);
  });

  // Main confirmed the drop opened a terminal → react. Routed back through the
  // local playReaction so isReacting gating stays consistent. Best-effort with a
  // fallback chain: double (Clawd) → clickLeft/clickRight poke (Calico) →
  // nothing (Cloudling only ships a drag reaction; no new theme capability is
  // invented for drops).
  window.hitAPI.onDropAccepted(() => {
    if (!canPlayReactionNow()) return;
    const doubleReact = _getReaction("double");
    if (doubleReact) {
      const files = doubleReact.files || [doubleReact.file];
      playReaction(files[Math.floor(Math.random() * files.length)], doubleReact.duration || 3500);
      return;
    }
    const left = _getReaction("clickLeft");
    const right = _getReaction("clickRight");
    const poke = left && right ? (Math.random() < 0.5 ? left : right) : (left || right);
    if (poke) playReaction(poke.file, poke.duration || 2500);
  });
}

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // Second layer for the macOS Ctrl-click overlap: the peteleco modifier is
  // Option there precisely so this cannot happen, but a platform that
  // synthesizes a contextmenu mid-aim must not pop a menu over the projection.
  if (isAiming) return;
  window.hitAPI.showContextMenu();
});
