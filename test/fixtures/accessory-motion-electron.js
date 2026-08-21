"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..");
const { PET_ACCESSORY_CATALOG } = require(path.join(ROOT, "src", "pet-customization-catalog"));
const { computeDynamicAccessoryLayout } = require(path.join(ROOT, "src", "pet-accessory-layout"));
const { isAccessoryMirrored } = require(path.join(ROOT, "src", "pet-accessory-mirror"));
const {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  resolveAccessoryAwareHitBox,
} = require(path.join(ROOT, "src", "pet-accessory-hitbox"));
const hitGeometry = require(path.join(ROOT, "src", "hit-geometry"));
const themeLoader = require(path.join(ROOT, "src", "theme-loader"));

themeLoader.init(path.join(ROOT, "src"));

const BUILTINS = [
  { id: "clawd", theme: path.join(ROOT, "themes", "clawd", "theme.json"), assets: path.join(ROOT, "assets", "svg") },
  { id: "cloudling", theme: path.join(ROOT, "themes", "cloudling", "theme.json"), assets: path.join(ROOT, "themes", "cloudling", "assets") },
];
const ACCESSORIES = PET_ACCESSORY_CATALOG.filter((entry) => entry.id !== "none");
const MOTION_EPSILON = 0.15;
const SCREEN_EPSILON = 0.51;
const LARGE_SCREEN_BOUNDS = Object.freeze({ x: 0, y: 0, width: 6000, height: 6000 });
// Mirrors src/tick.js POINTER_BRIDGE_STATES, intersected with the visuals that
// actually carry an accessory followTarget.
const POINTER_DRIVEN = new Set(["cloudling-idle.svg", "cloudling-mini-idle.svg"]);
const MINI_PAD_X = 25;
const MINI_PAD_Y = 8;

function rectFor(frame, accessory, themeId) {
  const themeWidthScale = accessory.themeWidthScales && accessory.themeWidthScales[themeId];
  const widthScale = Number.isFinite(themeWidthScale) ? themeWidthScale : accessory.widthScale;
  const width = frame.width * widthScale;
  const height = width / (accessory.viewBox.width / accessory.viewBox.height);
  return {
    left: frame.cx - width / 2,
    top: frame.baseY + accessory.offsetY - height,
    right: frame.cx + width / 2,
    bottom: frame.baseY + accessory.offsetY,
    width,
    height,
    widthScale,
  };
}

function emptyPadding() {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

function maxPadding(a, b) {
  return {
    left: Math.max(a.left || 0, b.left || 0),
    top: Math.max(a.top || 0, b.top || 0),
    right: Math.max(a.right || 0, b.right || 0),
    bottom: Math.max(a.bottom || 0, b.bottom || 0),
  };
}

function stateForFile(file) {
  return file.includes("mini-") ? "mini-idle" : "idle";
}

function baseHitBoxFor(theme, file) {
  return (theme.fileHitBoxes && theme.fileHitBoxes[file])
    || (theme.hitBoxes && theme.hitBoxes.default)
    || null;
}

function mirrorRectX(rect, viewBox) {
  const axis2 = 2 * viewBox.x + viewBox.width;
  return {
    x: axis2 - (rect.x + rect.width),
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function intersectThemeRect(rect, viewBox) {
  const left = Math.max(rect.x, viewBox.x);
  const top = Math.max(rect.y, viewBox.y);
  const right = Math.min(rect.x + rect.width, viewBox.x + viewBox.width);
  const bottom = Math.min(rect.y + rect.height, viewBox.y + viewBox.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function projectThemeRectToScreen(theme, state, file, rect) {
  const art = hitGeometry.getAssetRectScreen(theme, LARGE_SCREEN_BOUNDS, state, file);
  const viewBox = hitGeometry.resolveViewBox(theme, state, file);
  if (!art || !viewBox) return null;
  const scaleX = art.w / viewBox.width;
  const scaleY = art.h / viewBox.height;
  return {
    left: art.x + (rect.x - viewBox.x) * scaleX,
    top: art.y + (rect.y - viewBox.y) * scaleY,
    right: art.x + (rect.x + rect.width - viewBox.x) * scaleX,
    bottom: art.y + (rect.y + rect.height - viewBox.y) * scaleY,
  };
}

function outwardRound(rect) {
  return {
    left: Math.floor(rect.left),
    top: Math.floor(rect.top),
    right: Math.ceil(rect.right),
    bottom: Math.ceil(rect.bottom),
  };
}

// Exercise the same ordering requested in the review: mini padding is already
// present on the screen hit rect, then a contained internal seam clips the
// native input surface. Clip the sampled rendered pixels by the same synthetic
// seam because pixels beyond it are physically outside the contained viewport.
function clipMiniAtSyntheticSeam(hit, actual, edge) {
  const visibleWidth = actual.right - actual.left;
  if (!(visibleWidth > 0)) return { hit, actual };
  const cut = Math.max(1, visibleWidth * 0.2);
  if (edge === "right") {
    const boundary = actual.right - cut;
    return {
      hit: { ...hit, right: Math.max(hit.left, Math.min(hit.right, boundary)) },
      actual: { ...actual, right: Math.max(actual.left, boundary) },
    };
  }
  const boundary = actual.left + cut;
  return {
    hit: { ...hit, left: Math.min(hit.right, Math.max(hit.left, boundary)) },
    actual: { ...actual, left: Math.min(actual.right, boundary) },
  };
}

function containsScreenRect(hit, actual) {
  return hit.left <= actual.left + SCREEN_EPSILON
    && hit.top <= actual.top + SCREEN_EPSILON
    && hit.right + SCREEN_EPSILON >= actual.right
    && hit.bottom + SCREEN_EPSILON >= actual.bottom;
}

async function sampleMatrices(win, targetId, options = {}) {
  const scriptedCycleMs = Number.isFinite(options.scriptedCycleMs) ? options.scriptedCycleMs : 0;
  const cloudlingPointer = options.cloudlingPointer === true;
  // Long enough to cover both periods a scripted walk composes: the step cycle
  // (~1.16s) and the slower breath (4.4s) land back in phase together at 127.6s.
  const seekSeconds = Number.isFinite(options.seekSeconds) ? options.seekSeconds : 127.6;
  return win.webContents.executeJavaScript(`(async () => {
    const root = document.documentElement;
    const target = document.getElementById(${JSON.stringify(targetId)});
    if (!root || !target) throw new Error("missing accessory follow target: ${targetId}");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => {
      const rootM = root.getScreenCTM();
      const targetM = target.getScreenCTM();
      if (!rootM || !targetM) throw new Error("getScreenCTM returned null");
      const m = rootM.inverse().multiply(targetM);
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    };
    const out = [];

    if (${cloudlingPointer ? "true" : "false"}) {
      if (typeof window.__cloudlingSetPointer !== "function") {
        throw new Error("cloudling scripted pointer hook is unavailable");
      }
      // The diagonals alone cap the eye offset's x component at 1/sqrt(2), so
      // they can never reach the full MAX_ROT_DEG the horizontal probes do —
      // which is how the sampled envelope came out short of the real one.
      const probes = [
        { x: -1000, y: 0, inside: true },
        { x: 1000, y: 0, inside: true },
        { x: 0, y: -1000, inside: true },
        { x: 0, y: 1000, inside: true },
        { x: -1000, y: -1000, inside: true },
        { x: 1000, y: -1000, inside: true },
        { x: -1000, y: 1000, inside: true },
        { x: 1000, y: 1000, inside: true },
      ];
      for (const probe of probes) {
        window.__cloudlingSetPointer(probe);
        await wait(1200);
        for (let i = 0; i < 12; i++) {
          out.push(snapshot());
          await wait(16);
        }
      }
      return out;
    }

    const animations = document.getAnimations({ subtree: true });
    const durations = [];
    for (const animation of animations) {
      animation.pause();
      const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
      const duration = timing && Number(timing.duration);
      if (Number.isFinite(duration) && duration > 0) durations.push({ animation, duration });
    }
    if (durations.length > 0) {
      const horizon = Math.min(12000, Math.max(4000, ...durations.map(({ duration }) => duration * 4)));
      for (let t = 0; t <= horizon; t += 25) {
        for (const { animation, duration } of durations) animation.currentTime = t % duration;
        out.push(snapshot());
      }
      return out;
    }

    const scriptedCycleMs = ${scriptedCycleMs};
    if (scriptedCycleMs > 0) {
      // Preferred: the visual exposes a pure seek, so sweep its whole cycle
      // deterministically. Sampling a script-driven SVG against the wall clock
      // measures the machine, not the animation.
      if (typeof window.__clawdSeekTo === "function") {
        const seekSeconds = ${JSON.stringify(seekSeconds)};
        // 19 ms because it is coprime with both periods (1160 ms walk cycle,
        // 4400 ms breath). A 20 ms step divides the walk cycle exactly 58
        // times, so it revisits the same 58 phases forever and steps clean over
        // the contact pulse's peak at q=0.72 however long it runs; a coprime
        // step walks every 1 ms phase of both cycles for the same sample count.
        for (let ms = 0; ms <= seekSeconds * 1000; ms += 19) {
          window.__clawdSeekTo(ms / 1000);
          out.push(snapshot());
        }
        if (new Set(out.map((m) => JSON.stringify(m))).size < 2) {
          // A seek that does not move is indistinguishable from an animation
          // that does not move, and the latter passes every envelope check.
          throw new Error("seek hook produced no motion");
        }
        return out;
      }
      const horizon = Math.min(12000, Math.max(1200, scriptedCycleMs + 250));
      const started = performance.now();
      while (performance.now() - started <= horizon) {
        out.push(snapshot());
        await wait(25);
      }
      return out;
    }

    return [snapshot()];
  })()`);
}

async function auditTheme(win, builtin) {
  const raw = JSON.parse(fs.readFileSync(builtin.theme, "utf8"));
  const theme = themeLoader.loadTheme(builtin.id, { strict: true });
  const files = raw.customization && raw.customization.accessories && raw.customization.accessories.files;
  if (!files) return [];
  const scriptedCycles = raw.trustedRuntime && raw.trustedRuntime.scriptedSvgCycleMs || {};
  const failures = [];

  for (const [file, descriptor] of Object.entries(files)) {
    if (!descriptor || !descriptor.followTarget || !descriptor.staticFrame) continue;
    const svgPath = path.join(builtin.assets, file);
    if (!fs.existsSync(svgPath)) throw new Error(`missing SVG for motion audit: ${svgPath}`);
    await win.loadFile(svgPath);
    const matrices = await sampleMatrices(win, descriptor.followTarget.id, {
      // Every visual the pointer bridge drives, not just idle:
      // src/tick.js's POINTER_BRIDGE_STATES covers mini-idle too, and probing
      // only idle measured mini-idle's breath-only subspace and called it the
      // envelope.
      cloudlingPointer: builtin.id === "cloudling" && POINTER_DRIVEN.has(file),
      scriptedCycleMs: Number(scriptedCycles[file]) || 0,
    });
    const authored = descriptor.hitBoxPadding || emptyPadding();
    const measured = (BUILTIN_ACCESSORY_MOTION_PADDING[builtin.id] || {})[file] || emptyPadding();
    const configured = maxPadding(authored, measured);
    const required = emptyPadding();
    const state = stateForFile(file);
    const viewBox = hitGeometry.resolveViewBox(theme, state, file);
    const baseHitBox = baseHitBoxFor(theme, file);
    if (!viewBox || !baseHitBox) throw new Error(`${builtin.id}/${file}: missing viewBox/base hitbox`);
    const mini = state.startsWith("mini-");
    const edges = mini ? ["right", "left"] : [null];

    for (const accessory of ACCESSORIES) {
      const staticRect = rectFor(descriptor.staticFrame, accessory, builtin.id);
      const normalizedAccessory = {
        aspect: accessory.viewBox.width / accessory.viewBox.height,
        widthScale: staticRect.widthScale,
        offsetY: accessory.offsetY,
      };
      const payload = {
        id: accessory.id,
        assetFile: accessory.file,
        ...normalizedAccessory,
      };

      for (const matrix of matrices) {
        const layout = computeDynamicAccessoryLayout({
          matrix,
          frame: descriptor.followTarget.frame,
          accessory: normalizedAccessory,
          mediaOffset: { x: 0, y: 0 },
          stageSize: { width: 1000, height: 1000 },
        });
        if (!layout) throw new Error(`${builtin.id}/${file}/${accessory.id}: dynamic layout rejected sampled CTM`);
        const b = layout.bounds;
        required.left = Math.max(required.left, staticRect.left - b.x);
        required.top = Math.max(required.top, staticRect.top - b.y);
        required.right = Math.max(required.right, b.x + b.width - staticRect.right);
        required.bottom = Math.max(required.bottom, b.y + b.height - staticRect.bottom);

        for (const edge of edges) {
          // Same rule the renderer applies and reports; do not re-derive it
          // here, or the audit certifies a facing production never produces.
          const mirrorX = isAccessoryMirrored(state, {
            miniLeftFlip: edge === "left",
            miniFlipAssets: !!(theme.miniMode && theme.miniMode.flipAssets),
            inMiniMode: mini,
            miniPreEntryMode: false,
            hasRoamVisual: false,
            roamHeadingLeft: false,
            roamFlipAssets: false,
          });
          const hitBox = resolveAccessoryAwareHitBox(
            theme,
            state,
            file,
            baseHitBox,
            payload,
            { viewBox, mirrorX }
          );
          let finalHit = hitGeometry.getHitRectScreen(
            theme,
            LARGE_SCREEN_BOUNDS,
            state,
            file,
            hitBox,
            { padX: mini ? MINI_PAD_X : 0, padY: mini ? MINI_PAD_Y : 0 }
          );
          if (!finalHit) throw new Error(`${builtin.id}/${file}/${accessory.id}: screen hit projection failed`);
          finalHit = outwardRound(finalHit);

          let visibleThemeRect = {
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
          };
          if (mirrorX) visibleThemeRect = mirrorRectX(visibleThemeRect, viewBox);
          visibleThemeRect = intersectThemeRect(visibleThemeRect, viewBox);
          if (!visibleThemeRect) continue;
          let visibleScreenRect = projectThemeRectToScreen(theme, state, file, visibleThemeRect);
          if (!visibleScreenRect) throw new Error(`${builtin.id}/${file}/${accessory.id}: sampled screen projection failed`);

          if (mini) {
            const clipped = clipMiniAtSyntheticSeam(finalHit, visibleScreenRect, edge);
            finalHit = clipped.hit;
            visibleScreenRect = clipped.actual;
          }

          if (!containsScreenRect(finalHit, visibleScreenRect)) {
            failures.push(
              `${builtin.id}/${file}/${accessory.id}${edge ? `/${edge}` : ""} final-screen miss: `
              + `hit=${JSON.stringify(finalHit)} actual=${JSON.stringify(visibleScreenRect)}`
            );
            break;
          }
        }
      }
    }

    // A pointer-driven visual that measured no horizontal travel means the
    // probes never engaged — which reads identically to "this animation barely
    // moves" and silently certifies a far-too-small envelope.
    if (POINTER_DRIVEN.has(file) && required.left < 1 && required.right < 1) {
      failures.push(
        `${builtin.id}/${file}: pointer probes produced no rotation `
        + `(required=${JSON.stringify(required)}) — the sweep measured the idle subspace only`
      );
    }

    for (const side of ["left", "top", "right", "bottom"]) {
      const need = Math.max(0, required[side]);
      if (need > configured[side] + MOTION_EPSILON) {
        failures.push(`${builtin.id}/${file} ${side}: need ${need.toFixed(3)}, configured ${configured[side].toFixed(3)}`);
      }
    }
    process.stdout.write(`${builtin.id}/${file}: samples=${matrices.length} required=${JSON.stringify(required)} configured=${JSON.stringify(configured)}\n`);
  }
  return failures;
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  });
  const failures = [];
  try {
    for (const builtin of BUILTINS) failures.push(...await auditTheme(win, builtin));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  if (failures.length > 0) throw new Error(`Accessory motion audit failed:\n${failures.join("\n")}`);
}

main()
  .then(() => app.quit())
  .catch((err) => {
    console.error(err && err.stack || err);
    app.exit(1);
  });
