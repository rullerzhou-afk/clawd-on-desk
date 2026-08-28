"use strict";

// --- Peteleco aim overlay: pure view ---
// Main computes the shot (src/peteleco-geometry.js) and sends it here in
// window-local CSS px. This file only draws; it makes no decision about where
// the pet lands, so the line the user sees and the position the pet flies to
// can never disagree.
//
// The whole projection is one dashed white line: it starts clear of the pet and
// ends exactly on the landing spot. There is no ring or arrowhead — the far end
// of the line IS the answer to "where will it go".

const stage = document.getElementById("stage");
const shaftInk = document.getElementById("shaft-ink");
const shaftHalo = document.getElementById("shaft-halo");

// The shaft starts clear of the pet instead of under it: a line drawn from the
// sprite's middle covers the very character it is launching.
const PET_CLEARANCE_RATIO = 0.42;
const PET_CLEARANCE_MIN_PX = 18;

function setAttrs(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
}

function hide() {
  stage.classList.remove("is-fading");
  stage.classList.remove("is-visible");
}

// Release: keep the line on screen and dissolve it. Main hides the window on
// the same clock (PETELECO_FADE_OUT_MS), so nothing here has to time it.
function fade() {
  if (!stage.classList.contains("is-visible")) return;
  stage.classList.add("is-fading");
  stage.classList.remove("is-visible");
}

function draw(shot) {
  if (!shot || !shot.from || !shot.to) {
    hide();
    return;
  }
  const fromX = Number(shot.from.x);
  const fromY = Number(shot.from.y);
  const toX = Number(shot.to.x);
  const toY = Number(shot.to.y);
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
    hide();
    return;
  }

  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) {
    hide();
    return;
  }
  const ux = dx / length;
  const uy = dy / length;

  const petSize = Number(shot.petSize);
  const clearance = Math.max(
    PET_CLEARANCE_MIN_PX,
    Number.isFinite(petSize) ? petSize * PET_CLEARANCE_RATIO : 0
  );
  // A shot shorter than the clearance would draw a backwards shaft. Collapse it
  // to a zero-length shaft rather than pointing at the wrong side.
  const startOffset = Math.min(clearance, length);
  const startX = fromX + ux * startOffset;
  const startY = fromY + uy * startOffset;

  const power = Math.max(0, Math.min(1, Number(shot.power) || 0));
  const inkWidth = 2 + power * 2.4;

  setAttrs(shaftInk, { x1: startX, y1: startY, x2: toX, y2: toY, "stroke-width": inkWidth });
  setAttrs(shaftHalo, { x1: startX, y1: startY, x2: toX, y2: toY, "stroke-width": inkWidth + 3 });

  // A redraw during a fade (a new gesture reusing the window) must cancel it.
  stage.classList.remove("is-fading");
  stage.classList.add("is-visible");
}

if (window.petelecoOverlayAPI) {
  window.petelecoOverlayAPI.onProjection(draw);
  window.petelecoOverlayAPI.onClear(hide);
  window.petelecoOverlayAPI.onFade(fade);
}
