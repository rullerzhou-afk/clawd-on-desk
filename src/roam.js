"use strict";

// src/roam.js — Free roam mode: pet wanders around the desk when idle
//
// Design notes (from PR #467 review):
//   • Before moving the window, the visual state switches to "roam" (which
//     falls back to idle SVG for themes without a dedicated roam animation).
//     This prevents the "idle pet dragged across the desktop" regression.
//   • Movement goes through applyPetWindowBounds every frame — anchored to a
//     size captured once at walk start (#569) — so virtual bounds, hit window,
//     HUD, and anchored surfaces stay in sync with the pet.
//   • Each animation step re-checks isRoamAllowed() so a state change to working /
//     notification / permission cancels the roam immediately — no "pet drifting while
//     working" regression.
//   • The first roam after entering idle uses ROAM_IDLE_DELAY_MS (8s); subsequent
//     roams use ROAM_BETWEEN_DELAY_MS (4s).
//   • When the state changes away from idle/roam (detected in tick or step),
//     firstRoam is reset so the next idle entry waits the full 8s delay.
//   • Optional roam fence (#810): when ctx.roamFence (src/roam-fence.js)
//     reports an active fence, targets are confined to that sub-rectangle of
//     the work area. Without an active fence every code path below behaves
//     exactly as it did before the fence existed.

const ROAM_IDLE_DELAY_MS = 8000; // first roam after entering idle
const ROAM_BETWEEN_DELAY_MS = 4000; // delay between consecutive roams
const ROAM_SPEED_PX_PER_MS = 0.08; // 80px/s — slower than mini crabwalk (120px/s)
const ROAM_MIN_DIST = 100;
const ROAM_MARGIN_RATIO = 0.15;
const ROAM_FRAME_MS = 16;
const ROAM_TARGET_ATTEMPTS = 8;

module.exports = function initRoam(ctx) {
  let enabled = false;
  let constrainAxis = false;
  let roamActive = false;
  let roamAnimTimer = null;
  let roamPauseTimer = null;
  let firstRoam = true; // true until the first roam fires after idle entry

  function cleanupTimers() {
    if (roamAnimTimer) {
      clearTimeout(roamAnimTimer);
      roamAnimTimer = null;
    }
    if (roamPauseTimer) {
      clearTimeout(roamPauseTimer);
      roamPauseTimer = null;
    }
  }

  function hasPermissionBubbleHold() {
    return !!(
      typeof ctx.hasVisiblePermissionBubbles === "function"
      && ctx.hasVisiblePermissionBubbles()
    );
  }

  // Issue #690 plan §4.3.10's roam protection-period release point. Roam's
  // per-frame applyPetWindowBounds() (ROAM_FRAME_MS=16) is a continuous
  // native-write period the reconcile state machine must not fight — every
  // exit from that period (walk finishing naturally below, or being
  // cancelled) must tell the runtime so a reconcile that was only "marked
  // dirty" during the walk gets its one terminal pass. No-op when the
  // runtime hasn't wired this in (e.g. plain unit tests of roam.js alone).
  function notifyRoamProtectionReleased() {
    if (typeof ctx.releaseReconcileProtection === "function")
      ctx.releaseReconcileProtection();
  }

  function isRoamAllowed() {
    if (!enabled) return false;
    if (ctx.dragLocked) return false;
    if (ctx.getMiniMode && ctx.getMiniMode()) return false;
    const state = ctx.getCurrentState ? ctx.getCurrentState() : "idle";
    // Allow roaming when idle (about to start) or already roaming (mid-animation)
    if (state !== "idle" && state !== "roam") return false;
    if (ctx.miniTransitioning) return false;
    if (hasPermissionBubbleHold()) return false;
    // #640: while the user is typing into a bubble's text field (macOS IME
    // editing), the pet must hold still — a wandering pet either drags the
    // bubble along (followPet anchoring) or walks over the box being typed
    // into. Checked per-frame like the state gate, so an editing start
    // cancels a walk mid-stride.
    if (
      typeof ctx.isImeEditingActive === "function" &&
      ctx.isImeEditingActive()
    )
      return false;
    return true;
  }

  function pickRandomTarget() {
    const bounds = ctx.getPetWindowBounds();
    if (!bounds) return null;
    const wa = ctx.getNearestWorkArea(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    if (!wa) return null;
    const hasFenceLoader =
      ctx.roamFence && typeof ctx.roamFence.get === "function";
    const fenceState = hasFenceLoader ? ctx.roamFence.get() : undefined;
    // UNKNOWN means a configured loader has not confirmed any status yet.
    // Hold before resolving the keep-size snapshot: a skipped round must not
    // lazy-seed cross-display size state that the historical picker never
    // touched when it could not produce a target.
    if (hasFenceLoader && fenceState === null) return null;
    let petW = bounds.width;
    let petH = bounds.height;
    let size;
    if (fenceState && fenceState.active) {
      // #810: freeze the effective-size snapshot only when active-fence
      // geometry needs it. No-fence picking remains parent-identical; if it
      // finds a target, animateTo() resolves the normal walk snapshot there.
      const effectiveSize =
        typeof ctx.getEffectiveCurrentPixelSize === "function"
          ? ctx.getEffectiveCurrentPixelSize()
          : null;
      petW =
        effectiveSize &&
        Number.isFinite(effectiveSize.width) &&
        effectiveSize.width > 0
          ? effectiveSize.width
          : bounds.width;
      petH =
        effectiveSize &&
        Number.isFinite(effectiveSize.height) &&
        effectiveSize.height > 0
          ? effectiveSize.height
          : bounds.height;
      size = { width: petW, height: petH };
    }
    const marginX = Math.round(wa.width * ROAM_MARGIN_RATIO);
    const marginY = Math.round(wa.height * ROAM_MARGIN_RATIO);
    // Parent margin-band intervals, bounds-based — bit-identical to the
    // historical picker when no active fence narrows them below.
    const bxMin = wa.x + marginX;
    const bxMax = wa.x + wa.width - bounds.width - marginX;
    const byMin = wa.y + marginY;
    const byMax = wa.y + wa.height - bounds.height - marginY;
    let xMin = bxMin;
    let xMax = bxMax;
    let yMin = byMin;
    let yMax = byMax;
    // #810: optional roam fence — a user-editable rectangle (fractions of the
    // work area) that further restricts where targets may land. State comes
    // from the injected loader's in-memory cache (main.js wires
    // src/roam-fence.js; refreshed asynchronously in scheduleNextRoam), never
    // from disk here. When no fence applies — loader absent, confirmed
    // missing, or disabled — the intervals and thresholds below stay exactly
    // the historical values.
    let fenceRect = null;
    let fenceShrinks = false;
    let fenceAltersX = false;
    let fenceAltersY = false;
    let startInsideFence = true;
    // Round-2 review: get() === null means UNKNOWN — the loader has not yet
    // confirmed any status (first read pending, or the file exists but has
    // never parsed). Roaming the full area then would fail open — skip the
    // round instead; scheduleNextRoam retries after the next pause with a
    // fresh refresh. No loader wired at all still means "no fence".
    if (fenceState && fenceState.active) {
      fenceRect = {
        left: wa.x + Math.round(wa.width * fenceState.left),
        top: wa.y + Math.round(wa.height * fenceState.top),
        right: wa.x + Math.round(wa.width * fenceState.right),
        bottom: wa.y + Math.round(wa.height * fenceState.bottom),
      };
      // Round-4 review: the fence takes precedence over the historical 15%
      // margin band when the two do not overlap on an axis that the fence
      // actually narrows — a valid fence deliberately placed in the outer
      // band (a right-edge strip, a strip above the dock) must not become a
      // permanent no-roam zone. Per axis: intersect with the margins when
      // possible, else use the narrowed fence containment interval. A fence
      // the pet cannot fit into at all leaves a negative interval and roam
      // holds (whole-window containment; see docs/guides/roam-fence.md).
      const fxMin = fenceRect.left;
      const fxMax = fenceRect.right - petW;
      const fyMin = fenceRect.top;
      const fyMax = fenceRect.bottom - petH;
      startInsideFence =
        bounds.x >= fenceRect.left &&
        bounds.x + petW <= fenceRect.right &&
        bounds.y >= fenceRect.top &&
        bounds.y + petH <= fenceRect.bottom;
      // Determine narrowing from the realized pixel rectangle, not the raw
      // fractions: a tiny non-zero edge may round back to the full work area.
      const fenceNarrowsX =
        fenceRect.left > wa.x ||
        fenceRect.right < wa.x + Math.round(wa.width);
      const fenceNarrowsY =
        fenceRect.top > wa.y ||
        fenceRect.bottom < wa.y + Math.round(wa.height);
      xMin = Math.max(bxMin, fxMin);
      xMax = Math.min(bxMax, fxMax);
      // During ordinary contained roaming, only an axis the explicit fence
      // actually narrows may override the historical margin band. Recovery is
      // the exception: once any coordinate starts outside an active fence, all
      // impossible margin intervals must yield to the fence's containment
      // intervals so a large cross-display pet can get back inside. After that
      // one recovery, a full-range fence resumes the parent hold behavior.
      if (xMax < xMin && (fenceNarrowsX || !startInsideFence)) {
        xMin = fxMin;
        xMax = fxMax;
      }
      yMin = Math.max(byMin, fyMin);
      yMax = Math.min(byMax, fyMax);
      if (yMax < yMin && (fenceNarrowsY || !startInsideFence)) {
        yMin = fyMin;
        yMax = fyMax;
      }
      // Round-2 review: fenceRect is retained even when it does NOT alter
      // the candidate band — the band being inside the fence says nothing
      // about the pet's STARTING position, and containment classification
      // plus the final revalidation still need the rectangle. fenceShrinks
      // only decides whether the adaptive minimum hop may engage (any
      // fence-altered band scales the hop to its actual size).
      fenceAltersX = xMin !== bxMin || xMax !== bxMax;
      fenceAltersY = yMin !== byMin || yMax !== byMax;
      fenceShrinks = fenceAltersX || fenceAltersY;
    }
    // #810: a fence smaller than ROAM_MIN_DIST would reject every candidate,
    // so the minimum hop scales down with the fenced interval — but only when
    // an active fence actually shrank it; otherwise the historical 100px
    // threshold applies unchanged (including the "small work area, no fence"
    // case, which must keep returning no target).
    // #810 round-3: a containment-recovery round — the start rect lies outside
    // an active fence — must accept any non-zero legal displacement. The pet
    // may sit only 1px outside, and the ordinary 24/100px threshold would
    // reject every in-fence candidate forever. Normal wandering keeps the
    // usual minimums once the start is contained.
    const minDist = !startInsideFence
      ? 1
      : fenceShrinks
        ? Math.min(
            ROAM_MIN_DIST,
            Math.max(
              24,
              Math.round(
                (Math.max(0, xMax - xMin) + Math.max(0, yMax - yMin)) / 4,
              ),
            ),
          )
        : ROAM_MIN_DIST;
    // Axis-constrained walks move along one axis only, so their reachable
    // distance is bounded by that axis' range alone (best case ~range from an
    // edge, ~range/2 from the center) — scale per-axis, same 24px floor.
    const axisMinDist = (range, fenceAltersAxis) =>
      fenceAltersAxis
        ? Math.min(ROAM_MIN_DIST, Math.max(24, Math.round(range / 2)))
        : ROAM_MIN_DIST;
    /* #686: axis-constrained roam — pick a target that varies in only one axis.
     * Randomly choose horizontal (same Y, random X) or vertical (same X, random Y).
     * The constrained branch owns its complete retry/fallback behavior: it never
     * falls through to the two-dimensional picker or corner fallback below.
     *
     * Invariant: exactly one coordinate equals the walk's starting coordinate.
     * The stationary coordinate is never clamped or adjusted — if the pet starts
     * outside the inner margin band, that position is kept as-is so the "axis-only"
     * promise holds even at screen edges. */
    if (constrainAxis) {
      /* #810 fence × #686 axis: a single-axis move keeps one coordinate
       * exactly, so that stationary coordinate must already satisfy the fence
       * or the final window ends up outside it (PR #810 review). Rule:
       *   • start fully inside the fence → either axis may be selected;
       *   • exactly one coordinate outside → that coordinate must be the
       *     moving axis (the walk pulls it back inside);
       *   • both coordinates outside → recover in two stages: X this round,
       *     then Y on the next, without moving diagonally.
       * Without an active fence the historical behavior is untouched: either
       * axis, stationary coordinate kept as-is even outside the margin band. */
      let forcedAxis = null;
      let partialRecovery = false;
      if (fenceRect) {
        const insideX =
          bounds.x >= fenceRect.left && bounds.x + petW <= fenceRect.right;
        const insideY =
          bounds.y >= fenceRect.top && bounds.y + petH <= fenceRect.bottom;
        if (!insideX && !insideY) {
          // Round-4 review: both coordinates outside cannot be fixed by one
          // single-axis move, but returning no target forever froze the pet
          // permanently. Staged recovery: fix X this round (partial — the
          // final revalidation only checks the moving axis), then the next
          // round sees only Y outside and finishes the job. The axis-only
          // invariant holds on every frame of both stages.
          forcedAxis = "horizontal";
          partialRecovery = true;
        } else if (!insideX) forcedAxis = "horizontal";
        else if (!insideY) forcedAxis = "vertical";
      }
      const tryAxis = (axis, recovery) => {
        // recovery: this move exists to pull an out-of-fence coordinate back
        // inside (#810 round-3) — any non-zero legal displacement is enough.
        if (axis === "horizontal") {
          // Keep Y unchanged, pick random X
          const range = xMax - xMin;
          if (range < 0) return null;
          const min = recovery ? 1 : axisMinDist(range, fenceAltersX);
          if (range > 0) {
            for (let i = 0; i < ROAM_TARGET_ATTEMPTS; i += 1) {
              const targetX = xMin + Math.floor(Math.random() * range);
              if (Math.abs(targetX - bounds.x) >= min) {
                return {
                  x: targetX,
                  y: bounds.y,
                  axis: "horizontal",
                  size,
                  fence: fenceRect,
                };
              }
            }
          }
          // Fallback: farthest edge on X
          const farX =
            Math.abs(xMin - bounds.x) >= Math.abs(xMax - bounds.x)
              ? xMin
              : xMax;
          if (Math.abs(farX - bounds.x) >= min) {
            return {
              x: farX,
              y: bounds.y,
              axis: "horizontal",
              size,
              fence: fenceRect,
            };
          }
          return null;
        } else {
          // Keep X unchanged, pick random Y
          const range = yMax - yMin;
          if (range < 0) return null;
          const min = recovery ? 1 : axisMinDist(range, fenceAltersY);
          if (range > 0) {
            for (let i = 0; i < ROAM_TARGET_ATTEMPTS; i += 1) {
              const targetY = yMin + Math.floor(Math.random() * range);
              if (Math.abs(targetY - bounds.y) >= min) {
                return {
                  x: bounds.x,
                  y: targetY,
                  axis: "vertical",
                  size,
                  fence: fenceRect,
                };
              }
            }
          }
          // Fallback: farthest edge on Y
          const farY =
            Math.abs(yMin - bounds.y) >= Math.abs(yMax - bounds.y)
              ? yMin
              : yMax;
          if (Math.abs(farY - bounds.y) >= min) {
            return {
              x: bounds.x,
              y: farY,
              axis: "vertical",
              size,
              fence: fenceRect,
            };
          }
          return null;
        }
      };

      if (forcedAxis) {
        const target = tryAxis(forcedAxis, true);
        if (target && partialRecovery) target.partial = true;
        return target;
      }
      // Randomly prefer one axis; if it fails, try the other
      const firstAxis = Math.random() < 0.5 ? "horizontal" : "vertical";
      const secondAxis = firstAxis === "horizontal" ? "vertical" : "horizontal";
      return tryAxis(firstAxis) || tryAxis(secondAxis);
    }

    // #810 review: an exact-fit corridor — fence width or height exactly the
    // pet size, so one interval collapses to a single point — is still valid
    // geometry; movement continues on the other axis. Only a negative interval
    // is impossible. The historical (no-fence) check keeps its `<=` so parent
    // behavior stays bit-identical without a fence.
    if (fenceRect) {
      if (xMax < xMin || yMax < yMin) return null;
    } else if (xMax <= xMin || yMax <= yMin) return null;

    for (let i = 0; i < ROAM_TARGET_ATTEMPTS; i += 1) {
      const targetX = xMin + Math.floor(Math.random() * (xMax - xMin));
      const targetY = yMin + Math.floor(Math.random() * (yMax - yMin));
      const dx = targetX - bounds.x;
      const dy = targetY - bounds.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= minDist)
        return { x: targetX, y: targetY, size, fence: fenceRect };
    }

    const fallbackTargets = [
      { x: xMin, y: yMin },
      { x: xMax, y: yMin },
      { x: xMin, y: yMax },
      { x: xMax, y: yMax },
    ];
    let best = null;
    let bestDist = -1;
    for (const target of fallbackTargets) {
      const dx = target.x - bounds.x;
      const dy = target.y - bounds.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > bestDist) {
        best = target;
        bestDist = dist;
      }
    }
    return bestDist >= minDist ? { ...best, size, fence: fenceRect } : null;
  }

  function animateTo(target) {
    if (roamAnimTimer) {
      clearTimeout(roamAnimTimer);
      roamAnimTimer = null;
    }
    const win = ctx.win;
    if (!win || win.isDestroyed()) {
      roamActive = false;
      return;
    }
    const startBounds = ctx.getPetWindowBounds();
    if (!startBounds) {
      roamActive = false;
      return;
    }
    const startX = startBounds.x;
    const startY = startBounds.y;
    const axis = target.axis;
    // #569: freeze the window size for the whole walk (mirrors the drag
    // snapshot in drag-position.js). Re-reading live bounds every frame lets
    // the non-idempotent setBounds(getBounds()) round-trip on mixed-DPI
    // Windows setups ratchet the pet larger while roaming — same mechanism
    // as #408. When keepSizeAcrossDisplays is ON, the frozen keep-size wins
    // over the live start bounds so both anchors share one source of truth.
    // #810: active-fence planning resolves the snapshot in pickRandomTarget()
    // and carries it on the target, so containment planning and animation
    // cannot disagree. No-fence targets deliberately use this inline path to
    // preserve the historical picker and only seed keep-size after a target
    // has actually been found.
    const plannedSize = target.size;
    const effectiveSize =
      plannedSize ||
      (typeof ctx.getEffectiveCurrentPixelSize === "function"
        ? ctx.getEffectiveCurrentPixelSize()
        : null);
    const roamW =
      effectiveSize &&
      Number.isFinite(effectiveSize.width) &&
      effectiveSize.width > 0
        ? effectiveSize.width
        : startBounds.width;
    const roamH =
      effectiveSize &&
      Number.isFinite(effectiveSize.height) &&
      effectiveSize.height > 0
        ? effectiveSize.height
        : startBounds.height;
    let finalX = target.x;
    let finalY = target.y;
    if (ctx.clampToScreenVisual) {
      const clamped = ctx.clampToScreenVisual(finalX, finalY, roamW, roamH);
      finalX = clamped.x;
      finalY = clamped.y;
    }
    // #686 (review pass 2): the picker returns an axis-aligned target, but
    // clampToScreenVisual() may correct the stationary coordinate when the pet
    // starts outside the rest-clamp region (e.g. Y=-100 clamped up to 0). That
    // would reintroduce a diagonal interpolation. Restore the stationary axis
    // to the walk's starting coordinate so every applied frame keeps exactly
    // one coordinate equal to the start — the moving axis still benefits from
    // the clamp. Non-constrained roams (axis undefined) are unaffected.
    if (axis === "horizontal") {
      finalY = startY;
    } else if (axis === "vertical") {
      finalX = startX;
    }
    // #810: the fence promise is about the real window rectangle, not the
    // picked target — clampToScreenVisual() knows nothing about the fence and
    // can move the target when the visual clamp region disagrees with it.
    // Revalidate the final full-window rect (post-clamp, post-axis-restore,
    // frozen size) and skip the round instead of walking out of bounds. The
    // axis invariant needs no re-check here: the restore above just pinned the
    // stationary coordinate.
    if (target.fence) {
      const f = target.fence;
      const okX = finalX >= f.left && finalX + roamW <= f.right;
      const okY = finalY >= f.top && finalY + roamH <= f.bottom;
      // Round-4: a staged (partial) recovery only promises containment on
      // its moving axis — the stationary axis is still outside by design
      // and recovers next round. Everything else requires the full window.
      const contained = target.partial
        ? (axis === "horizontal" ? okX : okY)
        : okX && okY;
      if (!contained) {
        scheduleNextRoam();
        return;
      }
    }
    // ── Calculate duration based on distance (speed = 80px/s) ──
    const dx = finalX - startX;
    const dy = finalY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const animDurationMs = Math.max(1000, dist / ROAM_SPEED_PX_PER_MS);

    // ── Face the walk direction ──
    // Dedicated roam visuals (e.g. clawd's crabwalk) are drawn facing right;
    // tell the renderer to mirror while heading left. Sent before applyState
    // so the flip is settled when the roam visual swaps in. A purely vertical
    // walk keeps the previous heading.
    if (typeof ctx.setRoamHeading === "function" && dx !== 0) {
      ctx.setRoamHeading(dx < 0);
    }

    // ── Switch to "roam" visual state before moving ──
    // This ensures the pet shows a walk animation (if the theme provides one)
    // or at least the idle SVG via fallback, instead of being "dragged" in
    // whatever frozen pose the previous state left it in.
    if (typeof ctx.applyState === "function") {
      ctx.applyState("roam");
    }

    roamActive = true;
    const startTime = Date.now();
    let frameCount = 0;

    function step() {
      // ── Per-frame cancellation checks ──
      if (!roamActive) return;
      if (!win || win.isDestroyed()) {
        // PR #751 Codex review (rework batch B-1, non-blocking #3): this
        // exception exit used to leave the reconcile protection period
        // un-released — isRoamAnimating() correctly flips false immediately,
        // but nothing then requeues a check for whatever reconcile went dirty
        // while roam was active, same class of gap as mini.js's exit points.
        roamActive = false;
        notifyRoamProtectionReleased();
        return;
      }
      // Re-check state on every frame: if the pet is no longer idle/roam (e.g. a
      // working/notification event arrived), stop the animation immediately.
      if (!isRoamAllowed()) {
        // A drag only pauses the current roam phase; other gates still mean the
        // pet left normal idle eligibility and reset the next wait to 8s.
        if (hasPermissionBubbleHold() || !ctx.dragLocked) firstRoam = true;
        // cancelRoam also restores "idle" when the state is still "roam" —
        // gates with no incoming state of their own (IME editing #640, mini
        // mode) would otherwise strand the pet frozen in its walk pose.
        cancelRoam();
        return;
      }

      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / animDurationMs);
      const eased = t * (2 - t);
      const vx = Math.round(startX + (finalX - startX) * eased);
      const vy = Math.round(startY + (finalY - startY) * eased);
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
        // Same reconcile-protection release gap as the destroyed-window exit
        // above.
        roamActive = false;
        notifyRoamProtectionReleased();
        return;
      }

      // ── Per-frame sync ──
      // Write the anchored size, never a re-read of live bounds (#569).
      ctx.applyPetWindowBounds({ x: vx, y: vy, width: roamW, height: roamH });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function")
        ctx.repositionAnchoredSurfaces();
      // Throttle bubble reposition to every 3rd frame (~20fps) — same as mini.js
      if (
        typeof ctx.repositionBubbles === "function" &&
        ctx.bubbleFollowPet &&
        ctx.pendingPermissions.length &&
        (++frameCount % 3 === 0 || t >= 1)
      ) {
        ctx.repositionBubbles();
      }

      if (t < 1 && roamActive) {
        roamAnimTimer = setTimeout(step, ROAM_FRAME_MS);
      } else {
        roamActive = false;
        notifyRoamProtectionReleased();
        // ── Return to idle via setState (respects priority) ──
        // If a higher-priority state was set while the last frame was in
        // flight, setState("idle") won't downgrade it.
        if (typeof ctx.setState === "function") {
          ctx.setState("idle");
        }
        scheduleNextRoam();
      }
    }
    step();
  }

  function scheduleNextRoam() {
    if (roamPauseTimer) {
      clearTimeout(roamPauseTimer);
      roamPauseTimer = null;
    }
    if (!enabled) return;
    // #810: kick an async re-read of the fence file now, so the cached state
    // is fresh by the time this pause elapses and pickRandomTarget() runs.
    // Target selection itself never touches the disk. Because refresh is
    // asynchronous, a save around or after arming may affect this pending walk
    // if the in-flight read observes it; otherwise a later scheduled refresh
    // retries. There is no fixed wall-clock guarantee. No restart needed.
    if (ctx.roamFence && typeof ctx.roamFence.refresh === "function") {
      // Defensive: a loader that throws synchronously must not kill the roam
      // scheduling chain — the walk would simply use the cached fence state.
      try {
        ctx.roamFence.refresh();
      } catch {}
    }
    const delay = firstRoam ? ROAM_IDLE_DELAY_MS : ROAM_BETWEEN_DELAY_MS;
    firstRoam = false;
    roamPauseTimer = setTimeout(() => {
      roamPauseTimer = null;
      if (!isRoamAllowed()) return;
      const target = pickRandomTarget();
      if (!target) {
        scheduleNextRoam();
        return;
      }
      animateTo(target);
    }, delay);
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      cancelRoam();
    } else {
      // Fresh enable — first roam should wait the full idle delay
      firstRoam = true;
    }
  }

  function setConstrainAxis(value) {
    const next = !!value;
    if (next === constrainAxis) return;
    constrainAxis = next;
    // When enabling the constraint during an active unconstrained roam,
    // cancel and replan so the new restriction takes effect immediately
    // instead of finishing the current diagonal walk.
    if (next && roamActive) {
      cancelRoam();
      if (enabled && isRoamAllowed()) {
        firstRoam = true;
        scheduleNextRoam();
      }
    }
  }

  function cancelRoam() {
    const shouldRestoreIdle =
      roamActive &&
      typeof ctx.getCurrentState === "function" &&
      ctx.getCurrentState() === "roam" &&
      typeof ctx.setState === "function";
    const wasActive = roamActive;
    cleanupTimers();
    roamActive = false;
    if (wasActive) notifyRoamProtectionReleased();
    // Roam is an interruptible movement state. A user theme may define
    // timings.minDisplay.roam, but cancelling a walk must restore idle now so
    // a delayed idle broadcast cannot overwrite a drag reaction mid-hold.
    if (shouldRestoreIdle) {
      ctx.setState("idle", undefined, { bypassMinDisplay: true });
    }
  }

  function tick() {
    if (!enabled) return;
    if (!isRoamAllowed()) {
      // Preserve the already-consumed 4s/8s phase while drag owns movement.
      // Existing non-drag gates still reset the next idle entry to 8s.
      if (hasPermissionBubbleHold() || !ctx.dragLocked) firstRoam = true;
      cancelRoam();
      return;
    }
    if (roamActive) return;
    if (roamPauseTimer) return;
    scheduleNextRoam();
  }

  // Issue #690 plan §4.3.10's protection-period predicate: pet-window-runtime's
  // runReconcile() polls this (isRoamAnimating()) alongside dragLocked /
  // getMiniTransitioning() / isMiniAnimating() / settingsSizePreviewSyncFrozen
  // so a reconcile pass never fights roam's own per-frame writes.
  function isRoamAnimating() {
    return roamActive;
  }

  return {
    setEnabled,
    setConstrainAxis,
    cancelRoam,
    tick,
    isRoamAnimating,
    get enabled() {
      return enabled;
    },
  };
};
