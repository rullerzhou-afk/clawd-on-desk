"use strict";

// Toss physics behind the Gravity toggle. When a drag releases, the pet keeps
// the gesture's velocity and falls: it arcs, bounces off work-area walls and
// floor, skids to a stop, and can be caught mid-air (a new drag-lock cancels
// the sim instantly). With the ledges sidecar available (macOS), the pet also
// lands on the visible top edges of other apps' windows — a swept feet-line
// test, so fast falls can't tunnel through a ledge — and ledges.js rides /
// drops him as the supporting window moves or closes.
//
// Modeled on roam.js: a main-process module driving applyPetWindowBounds on a
// 16 ms loop, with per-frame cancellation gates, a size frozen at sim start
// (#569 invariant), and bubble/HUD/hit-window syncing every frame.
//
// Coordinates: global top-left origin, y DOWN (Electron/CG native on macOS).

const { getFootRestInset } = require("./visible-margins");

const GRAVITY_PX_S2 = 3200;          // px/s², downward
const FRAME_MS = 16;
const MAX_FALL_SPEED = 2600;
const MAX_FRAME_DT_MS = 50;          // clamp long stalls
const THROW_WINDOW_MS = 140;         // gesture window for velocity estimate
const THROW_STALE_MS = 90;           // pointer parked this long ⇒ no throw
const THROW_MAX_SPEED = 2200;
const FLOOR_RESTITUTION = 0.38;
const WALL_RESTITUTION = 0.55;
const MIN_BOUNCE_SPEED = 240;        // below this, land instead of bouncing
const AIR_DRAG_PER_S = 0.12;
const SKID_DECEL_PER_S = 8;
const SKID_STOP_SPEED = 40;
const MIN_LEDGE_OVERLAP = 0.4;       // of pet width, at the crossing point
const MAX_SIM_MS = 4000;             // hard stop safeguard

module.exports = function initGravity(ctx) {
  let enabled = true;
  let falling = false;
  let simTimer = null;
  let samples = [];                  // {x, y, t} window positions during drag

  function cleanupTimer() {
    if (simTimer) { clearTimeout(simTimer); simTimer = null; }
  }

  function endReaction() {
    if (typeof ctx.sendToRenderer === "function") {
      ctx.sendToRenderer("end-drag-reaction");
    }
  }

  function setStanding(ledge) {
    if (typeof ctx.setStandingLedge === "function") ctx.setStandingLedge(ledge || null);
  }

  // ── drag-gesture sampling ──────────────────────────────────────

  function onDragStart() {
    cancel();                        // catching a falling pet: new drag wins
    setStanding(null);               // grabbed off his perch
    samples = [];
  }

  function onDragMove() {
    const bounds = ctx.getPetWindowBounds();
    if (!bounds) return;
    const t = Date.now();
    samples.push({ x: bounds.x, y: bounds.y, t });
    const cutoff = t - THROW_WINDOW_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  function releaseVelocity() {
    const t = Date.now();
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const last = samples[samples.length - 1];
    if (t - last.t > THROW_STALE_MS) return { vx: 0, vy: 0 };   // parked ⇒ drop
    const first = samples[0];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0.005) return { vx: 0, vy: 0 };
    let vx = (last.x - first.x) / dt;
    let vy = (last.y - first.y) / dt;
    const mag = Math.sqrt(vx * vx + vy * vy);
    if (mag > THROW_MAX_SPEED) {
      vx *= THROW_MAX_SPEED / mag;
      vy *= THROW_MAX_SPEED / mag;
    }
    return { vx, vy };
  }

  // ── simulation ─────────────────────────────────────────────────

  function simAllowed() {
    if (!enabled) return false;
    const win = ctx.win;
    if (!win || win.isDestroyed()) return false;
    if (ctx.getMiniMode && ctx.getMiniMode()) return false;
    if (ctx.miniTransitioning) return false;
    // A new grab catches the pet mid-air — the drag snapshot takes over.
    if (typeof ctx.isDragLocked === "function" && ctx.isDragLocked()) return false;
    return true;
  }

  // Highest surface (smallest y) the pet's bottom edge crosses while moving
  // down from prevBottom to newBottom. Returns { y, ledge } or null.
  // The floor of the work area counts as a surface with ledge = null.
  function crossedSurface(prevBottom, newBottom, xPrev, xNow, w, wa) {
    let best = null;
    const consider = (surfaceY, ledge) => {
      if (prevBottom - 1 > surfaceY || newBottom < surfaceY) return;   // not crossed
      if (best && surfaceY >= best.y) return;
      if (ledge) {
        // horizontal footing at the crossing point
        const span = newBottom - prevBottom;
        const t = span > 0 ? Math.max(0, Math.min(1, (surfaceY - prevBottom) / span)) : 0;
        const cx = xPrev + (xNow - xPrev) * t;
        const overlap = Math.min(ledge.x2, cx + w) - Math.max(ledge.x, cx);
        if (overlap < MIN_LEDGE_OVERLAP * w) return;
      }
      best = { y: surfaceY, ledge: ledge || null };
    };
    consider(wa.y + wa.height, null);                       // floor
    if (typeof ctx.getLedges === "function") {
      for (const l of ctx.getLedges()) {
        // pet must fit below the menu bar / above the work-area top
        if (l.y - (wa.y || 0) < 30) continue;
        consider(l.y, l);
      }
    }
    return best;
  }

  function startFall(throwVx, throwVy) {
    if (falling || !simAllowed()) return false;
    const startBounds = ctx.getPetWindowBounds();
    if (!startBounds) return false;

    // Frozen size for the whole sim (#569 — never re-read live bounds).
    const effectiveSize = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize()
      : null;
    const w = effectiveSize && Number.isFinite(effectiveSize.width) && effectiveSize.width > 0
      ? effectiveSize.width : startBounds.width;
    const h = effectiveSize && Number.isFinite(effectiveSize.height) && effectiveSize.height > 0
      ? effectiveSize.height : startBounds.height;

    let x = startBounds.x;
    let y = startBounds.y;
    let vx = throwVx;
    let vy = throwVy;
    let lastTick = Date.now();
    const simStart = lastTick;
    let frameCount = 0;

    falling = true;
    cleanupTimer();
    setStanding(null);

    // Keep the dangling drag-reaction visual alive through the fall.
    if (typeof ctx.sendToRenderer === "function") {
      ctx.sendToRenderer("start-drag-reaction", vx < 0 ? "left" : vx > 0 ? "right" : null);
    }

    function settle(finalX, finalY, ledge) {
      falling = false;
      cleanupTimer();
      endReaction();
      ctx.applyPetWindowBounds({ x: Math.round(finalX), y: Math.round(finalY), width: w, height: h });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      if (typeof ctx.repositionBubbles === "function") ctx.repositionBubbles();
      if (typeof ctx.reassertWinTopmost === "function") ctx.reassertWinTopmost();
      if (typeof ctx.flushRuntimeStateToPrefs === "function") ctx.flushRuntimeStateToPrefs();
      setStanding(ledge);
    }

    function step() {
      if (!falling) return;
      if (!simAllowed()) {
        // Caught mid-air / mini mode / shutdown: stop moving, end the visual,
        // and let whoever took over own the window from here.
        falling = false;
        cleanupTimer();
        endReaction();
        return;
      }
      const nowMs = Date.now();
      const dt = Math.min(nowMs - lastTick, MAX_FRAME_DT_MS) / 1000;
      lastTick = nowMs;

      if (nowMs - simStart > MAX_SIM_MS) { settle(x, y, null); return; }

      const xPrev = x;
      const fo = getFootRestInset(h);
      const prevBottom = y + h - fo;    // visual feet line
      const movingDown = vy >= 0;

      // integrate
      vy = Math.min(vy + GRAVITY_PX_S2 * dt, MAX_FALL_SPEED);
      vx *= Math.max(0, 1 - AIR_DRAG_PER_S * dt);
      x += vx * dt;
      y += vy * dt;

      // resolve against the work area nearest the pet's center (cross-display arcs)
      const wa = ctx.getNearestWorkArea(x + w / 2, y + h / 2);
      if (!wa) { settle(x, y, null); return; }
      const leftWall = wa.x;
      const rightWall = wa.x + wa.width - w;

      if (x < leftWall) { x = leftWall; vx = Math.abs(vx) * WALL_RESTITUTION; }
      else if (x > rightWall) { x = rightWall; vx = -Math.abs(vx) * WALL_RESTITUTION; }
      if (y < wa.y) { y = wa.y; vy = Math.max(vy, 0); }   // menu-bar thunk

      // swept landing: floor OR any window ledge crossed this frame
      if (movingDown && vy > 0) {
        const hit = crossedSurface(prevBottom, y + h - fo, xPrev, x, w, wa);
        if (hit) {
          y = hit.y - h + fo;
          if (vy > MIN_BOUNCE_SPEED) {
            vy = -vy * FLOOR_RESTITUTION;                  // boing
            vx *= 0.7;
          } else {
            vy = 0;
            vx *= Math.max(0, 1 - SKID_DECEL_PER_S * dt); // skid
            if (Math.abs(vx) < SKID_STOP_SPEED) { settle(x, y, hit.ledge); return; }
            // Skidding along a ledge that ends mid-skid resumes falling on
            // the next frame (crossedSurface won't match, pet floats → falls).
          }
        }
      }

      ctx.applyPetWindowBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      if (typeof ctx.repositionBubbles === "function" && ctx.bubbleFollowPet
          && ctx.pendingPermissions.length && (++frameCount % 3 === 0)) {
        ctx.repositionBubbles();
      }

      simTimer = setTimeout(step, FRAME_MS);
    }
    step();
    return true;
  }

  // Returns true when a fall was started (caller should skip its own
  // prefs flush — gravity flushes once the pet comes to rest).
  function onDragEnd() {
    if (!simAllowed()) { samples = []; return false; }
    if (typeof ctx.isImeEditingActive === "function" && ctx.isImeEditingActive()) {
      samples = [];
      return false;
    }
    const startBounds = ctx.getPetWindowBounds();
    if (!startBounds) { samples = []; return false; }

    const { vx, vy } = releaseVelocity();
    samples = [];

    // Released standing on the floor (or a ledge) without a real throw?
    // Let the sim run one cheap step anyway ONLY if there's air below;
    // resting-on-floor with no velocity is a no-op.
    const wa0 = ctx.getNearestWorkArea(
      startBounds.x + startBounds.width / 2,
      startBounds.y + startBounds.height / 2
    );
    if (wa0) {
      const floor0 = wa0.y + wa0.height - startBounds.height
        + getFootRestInset(startBounds.height);
      if (startBounds.y >= floor0 - 2 && Math.abs(vx) < 60 && vy >= -60) {
        return false;
      }
    }
    return startFall(vx, vy);
  }

  // External trigger: support vanished (window closed/moved) — plain drop.
  function startFreeFall() {
    return startFall(0, 0);
  }

  // Gravity just turned on (or the app just started with it on): if the pet
  // is hovering mid-air, drop him now. Standing on a window ledge counts as
  // grounded — he adopts the perch instead of falling through it.
  function dropIfAirborne() {
    if (!enabled || falling || !simAllowed()) return false;
    const b = ctx.getPetWindowBounds();
    if (!b) return false;
    const wa = ctx.getNearestWorkArea(b.x + b.width / 2, b.y + b.height / 2);
    if (!wa) return false;
    const bottom = b.y + b.height - getFootRestInset(b.height);   // visual feet
    if (bottom >= wa.y + wa.height - 2) return false;   // already on the floor
    if (typeof ctx.getLedges === "function") {
      for (const l of ctx.getLedges()) {
        if (Math.abs(l.y - bottom) <= 3) {
          const overlap = Math.min(l.x2, b.x + b.width) - Math.max(l.x, b.x);
          if (overlap >= MIN_LEDGE_OVERLAP * b.width) {
            setStanding(l);                             // adopt the perch
            return false;
          }
        }
      }
    }
    return startFall(0, 0);
  }

  function cancel() {
    if (!falling) { cleanupTimer(); return; }
    falling = false;
    cleanupTimer();
    endReaction();
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) cancel();
  }

  return {
    setEnabled,
    onDragStart,
    onDragMove,
    onDragEnd,
    startFreeFall,
    dropIfAirborne,
    cancel,
    get enabled() { return enabled; },
    get falling() { return falling; },
  };
};

