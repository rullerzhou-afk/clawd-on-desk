"use strict";

// Per-window text zoom (settings keys: textScale + textScaleByDisplay).
//
// Mechanism: root CSS zoom injected per document — NOT webContents
// setZoomFactor. Chromium's zoom map is keyed by scheme+host per partition,
// and every loadFile window shares the empty file:// host, so setZoomFactor
// values propagate across all text windows AND the pet windows; that makes
// per-display divergence impossible. Root CSS zoom is per-document: layout
// viewport shrinks exactly like zoomFactor (window DIP / zoom) while
// offsetHeight/scrollHeight keep reporting unzoomed CSS px (verified
// empirically on this Electron version), so all CSS px ↔ DIP conventions in
// the geometry code hold unchanged. See docs/plans/plan-text-scale.md.
const TEXT_SCALE_MIN = 0.8;
const TEXT_SCALE_MAX = 1.6;
const TEXT_SCALE_DEFAULT = 1;
const TEXT_SCALE_STEP = 0.05;

function isValidTextScale(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= TEXT_SCALE_MIN
    && value <= TEXT_SCALE_MAX;
}

function clampTextScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TEXT_SCALE_DEFAULT;
  if (n < TEXT_SCALE_MIN) return TEXT_SCALE_MIN;
  if (n > TEXT_SCALE_MAX) return TEXT_SCALE_MAX;
  return n;
}

// CSS px → DIP. Widths round: bubble base widths are multiples of 20, so every
// 5% step lands on an integer and the CSS viewport width stays exact — cached
// renderer-side heights survive scale changes. Heights ceil so a rounded-down
// window can never clip scaled content.
function scaleWidth(cssPx, scale) {
  return Math.round(cssPx * clampTextScale(scale));
}

function scaleHeight(cssPx, scale) {
  return Math.ceil(cssPx * clampTextScale(scale));
}

function applyZoomToWindow(win, scale) {
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
  return applyZoomToWebContents(win.webContents, scale);
}

// The Dashboard page lives in a WebContentsView on darwin/win32, so its
// WebContents belongs to no window. Take the contents directly instead of
// inventing a window-shaped object with a `.webContents` property.
function applyZoomToWebContents(wc, scale) {
  if (!wc) return false;
  if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
  // The text-window pages ship CSP without 'unsafe-eval', which makes the
  // page reject webContents.executeJavaScript — so the zoom travels as an
  // embedder-level stylesheet (insertCSS), which page CSP cannot block.
  if (typeof wc.insertCSS !== "function") return false;
  const s = clampTextScale(scale);
  // Reposition paths call this every frame during pet drags; memoize per
  // webContents. Inserted CSS does not survive reloads, so the
  // did-finish-load hook below clears the memo and the next call re-injects.
  if (wc.__clawdAppliedTextZoom === s) return true;
  try {
    if (!wc.__clawdTextZoomReloadHooked && typeof wc.on === "function") {
      wc.__clawdTextZoomReloadHooked = true;
      wc.on("did-finish-load", () => {
        wc.__clawdAppliedTextZoom = undefined;
        wc.__clawdTextZoomCssKey = undefined;
      });
    }
    // Neutralize any shared HostZoomMap factor left behind by the earlier
    // setZoomFactor-based builds.
    if (typeof wc.setZoomFactor === "function") wc.setZoomFactor(1);

    wc.__clawdAppliedTextZoom = s;
    const runInjection = () => {
      // --clawd-text-zoom rides along for stylesheets that need zoom-corrected
      // viewport units: vh/vw resolve against the UNZOOMED initial containing
      // block, so `100vh` renders S× too tall inside the zoomed page. Rules
      // write `calc(100vh / var(--clawd-text-zoom, 1))` to stay window-true.
      const insertion = wc.insertCSS(
        `:root { zoom: ${s} !important; --clawd-text-zoom: ${s}; }`
      );
      if (!insertion || typeof insertion.then !== "function") return insertion;
      return insertion.then((key) => {
        // Swap-then-remove keeps exactly one zoom stylesheet alive; removal
        // failures are harmless (the newer sheet wins the cascade).
        const previousKey = wc.__clawdTextZoomCssKey;
        wc.__clawdTextZoomCssKey = key;
        if (previousKey != null && typeof wc.removeInsertedCSS === "function") {
          const removal = wc.removeInsertedCSS(previousKey);
          if (removal && typeof removal.catch === "function") removal.catch(() => {});
        }
      }, () => {
        // Pre-load injections reject; clearing the memo lets the
        // did-finish-load / next reposition apply retry.
        if (wc.__clawdAppliedTextZoom === s) wc.__clawdAppliedTextZoom = undefined;
      });
    };
    // Serialize insert/remove pairs per webContents so rapid slider drags
    // can't interleave and resurrect a stale sheet.
    const queue = wc.__clawdTextZoomQueue;
    wc.__clawdTextZoomQueue = queue && typeof queue.then === "function"
      ? queue.then(runInjection, runInjection)
      : runInjection();
    return true;
  } catch {
    wc.__clawdAppliedTextZoom = undefined;
    return false;
  }
}

// Resolve the effective scale for one display key, falling back to the
// legacy/global `textScale` value for displays the user has not tuned.
function resolveTextScaleForKey(byDisplay, fallback, key) {
  const map = byDisplay && typeof byDisplay === "object" && !Array.isArray(byDisplay) ? byDisplay : {};
  const k = typeof key === "string" && key ? key : null;
  if (k && Object.prototype.hasOwnProperty.call(map, k)) return clampTextScale(map[k]);
  return clampTextScale(fallback);
}

// Keep the per-display map bounded and every entry valid. Display ids can
// churn across reconnects/reboots, so stale keys accumulate; 16 displays is
// far beyond any real setup.
const TEXT_SCALE_MAX_DISPLAY_ENTRIES = 16;

function normalizeTextScaleByDisplay(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (!isValidTextScale(raw)) continue;
    out[key] = raw;
    count += 1;
    if (count >= TEXT_SCALE_MAX_DISPLAY_ENTRIES) break;
  }
  return out;
}

// Settings slider mapping (UI works in whole percent: 80–160, step 5).
function textScaleToUiPercent(scale) {
  return Math.round(clampTextScale(scale) * 100);
}

function uiPercentToTextScale(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return TEXT_SCALE_DEFAULT;
  return clampTextScale(n / 100);
}

module.exports = {
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_STEP,
  TEXT_SCALE_MAX_DISPLAY_ENTRIES,
  isValidTextScale,
  clampTextScale,
  scaleWidth,
  scaleHeight,
  applyZoomToWindow,
  applyZoomToWebContents,
  resolveTextScaleForKey,
  normalizeTextScaleByDisplay,
  textScaleToUiPercent,
  uiPercentToTextScale,
};
