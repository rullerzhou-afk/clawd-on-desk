"use strict";

const { isDrawableBalanceBucket } = require("./quota-balance");

// ── Pet-attached quota "Orbit" ring geometry ──
//
// The account-quota indicators live in their OWN transparent window, attached
// to the pet's side (not stacked inside the Session HUD, which now shows only
// sessions). One coin per (source, provider); a coin carries up to two
// concentric rings — an outer ring for the shorter/rolling window and an inner
// ring for the weekly window — so a single provider's 5h + weekly both read at
// a glance without spawning two gauges. Only the first three selected coins
// draw beside the pet; the Dashboard retains every provider and source.
//
// This module owns the PURE geometry: how many coins a snapshot draws, the
// cluster's pixel footprint, and where it sits relative to the pet (default
// left — clear of the right-entering permission bubble — flipping to the right
// only when the left has no room). The renderer (browser context) owns the
// per-coin visual model; the main process (session-hud.js) requires this for
// window sizing, positioning, and the auto-hide hot zone.

// Provider → candidate bucket fields for the two rings (outer = rolling, inner
// = weekly). Antigravity can report both Gemini and Claude/GPT quotas; each ring
// compresses that timescale to the most constrained candidate, while the
// Dashboard keeps showing all four values. Mirrors quota-ring-renderer.js.
// `label` is the provider's brand name, carried here so main-side consumers
// (the Settings "show beside the pet" list) have one source for it instead of a
// third hand-kept copy. Kept byte-identical to the renderer's own RING_PROVIDERS
// labels; test/quota-ring-geometry.test.js pins the mirror.
const RING_PROVIDERS = [
  {
    key: "antigravityQuota",
    label: "Antigravity",
    outer: ["geminiFiveHour", "thirdPartyFiveHour"],
    inner: ["geminiWeekly", "thirdPartyWeekly"],
  },
  { key: "claudeQuota", label: "Claude", outer: ["claudeFiveHour"], inner: ["claudeWeekly"] },
  { key: "codexQuota", label: "Codex", outer: ["codexFiveHour"], inner: ["codexWeekly"] },
  { key: "kimiQuota", label: "Kimi", outer: ["kimiFiveHour"], inner: ["kimiWeekly"] },
  { key: "deepseekQuota", label: "DeepSeek", kind: "balance", outer: ["deepseekBalance"], inner: [] },
];

// Layout constants in CSS px (scaled by textScale by the caller, exactly like
// the HUD). Kept in sync with quota-ring.html.
const COIN_SIZE = 26; // outer ring diameter
const COIN_GAP = 10; // vertical gap between stacked coins
const READOUT_W = 44; // "%" + window/source column, outer side of each coin
const COIN_READOUT_GAP = 6; // gap between coin and its readout
const CLUSTER_PAD = 6; // inner padding around the cluster content
const RING_PET_GAP = 8; // gap between the pet body and the cluster
const RING_EDGE_MARGIN = 8; // keep the cluster this far from the work-area edge
// Matches prefs.normalizeQuotaRingShownProviders and settings-actions' selection
// limit. They count provider choices; this display limit counts physical coins.
const RING_MAX_COINS = 3;

// Transparent window shell (room for the coin drop shadows), mirrors HUD.
const RING_SHELL = Object.freeze({ top: 6, right: 6, bottom: 8, left: 6 });

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function normalizeAvoidRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  if (Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (isScreenRect(rect) && rect.right > rect.left && rect.bottom > rect.top) {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  }
  return null;
}

function overlapArea(a, b, gap = 0) {
  const left = Math.max(a.x, b.x - gap);
  const top = Math.max(a.y, b.y - gap);
  const right = Math.min(a.x + a.width, b.x + b.width + gap);
  const bottom = Math.min(a.y + a.height, b.y + b.height + gap);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function resolveAvoidingY({ initialY, minY, maxY, width, height, x, avoidRects, gap }) {
  const avoids = (Array.isArray(avoidRects) ? avoidRects : [])
    .map(normalizeAvoidRect)
    .filter(Boolean);
  if (!avoids.length) return initialY;

  const candidates = new Set([initialY, minY, maxY]);
  for (const rect of avoids) {
    candidates.add(clamp(Math.round(rect.y - gap - height), minY, maxY));
    candidates.add(clamp(Math.round(rect.y + rect.height + gap), minY, maxY));
  }
  const scored = Array.from(candidates).map((y) => {
    const candidate = { x, y, width, height };
    const overlap = avoids.reduce((sum, rect) => sum + overlapArea(candidate, rect, gap), 0);
    return { y, overlap, distance: Math.abs(y - initialY) };
  });
  scored.sort((a, b) => a.overlap - b.overlap || a.distance - b.distance || a.y - b.y);
  return scored[0].y;
}

// A window provider needs a candidate bucket; a balance provider also needs
// complete money metadata. Mirrors the renderer's draw rule exactly so the window is never
// sized for a coin the renderer will not draw (or vice versa).
function providerHasDrawableQuota(source, def) {
  const entry = source && source[def.key];
  const group = entry && entry.group;
  if (!group) return false;
  if (def.kind === "balance") return def.outer.some((field) => isDrawableBalanceBucket(group[field]));
  return [...def.outer, ...def.inner].some((field) =>
    group[field] && typeof group[field] === "object");
}

// Manual selections ignore the legacy hidden list. Data only determines which
// selected providers draw coins; collection and the Dashboard are unaffected.
// Provider-first order intentionally takes precedence over source order when
// truncating multiple machines. Keep this rule mirrored in the renderer.
function collectQuotaCoins(snapshot, hiddenProviders, shownProviders) {
  const sources = snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  const shown = Array.isArray(shownProviders) ? new Set(shownProviders) : null;
  const hidden = new Set(Array.isArray(hiddenProviders) ? hiddenProviders : []);
  const coins = [];
  for (const def of RING_PROVIDERS) {
    if (shown ? !shown.has(def.key) : hidden.has(def.key)) continue;
    for (const source of sources) {
      if (!providerHasDrawableQuota(source, def)) continue;
      coins.push({ source, def });
      // Selection is per provider, but multiple machines consume separate
      // coins. Truncation in provider/source order is an accepted boundary.
      if (coins.length === RING_MAX_COINS) return coins;
    }
  }
  return coins;
}

function countQuotaCoins(snapshot, showQuota, hiddenProviders, shownProviders) {
  return showQuota === false ? 0 : collectQuotaCoins(snapshot, hiddenProviders, shownProviders).length;
}

// Include selected providers without data so the user can release their choice
// slots. They draw no coins and therefore consume none of the coin budget.
function listQuotaRingProviders(snapshot, hiddenProviders, shownProviders) {
  const sources = snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  const coins = collectQuotaCoins(snapshot, hiddenProviders, shownProviders);
  const selected = new Set(Array.isArray(shownProviders) ? shownProviders : []);
  const definitions = [...RING_PROVIDERS];
  // Prefs preserve unknown keys across upgrades; keep those choices removable.
  for (const key of selected) {
    if (!definitions.some((def) => def.key === key)) {
      definitions.push({ key, label: key, outer: [], inner: [] });
    }
  }
  const list = [];
  for (const def of definitions) {
    const coinCount = sources.filter((source) => providerHasDrawableQuota(source, def)).length;
    if (!coinCount && !selected.has(def.key)) continue;
    const shownCoinCount = coins.filter((coin) => coin.def.key === def.key).length;
    list.push({
      key: def.key,
      label: def.label,
      selected: selected.has(def.key),
      shown: shownCoinCount > 0,
      coinCount,
      shownCoinCount,
    });
  }
  return list;
}

function formatWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

// Severity thresholds match the Dashboard / prior HUD strip: > 85 hot, >= 60
// warn, else ok. usedPercent semantics (a full ring = nearly exhausted).
function quotaSeverity(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "ok";
  if (p > 85) return "hot";
  if (p >= 60) return "warn";
  return "ok";
}

// Content width is fixed (coin + readout column); height grows with the coin
// count up to the cap. The ring fills with USED
// percent (matching the Dashboard) and an empty ring is the reset state, so
// the semantics read from the form — no persistent "used" label needed.
function ringClusterContentSize(coinCount) {
  const total = Math.max(0, Math.floor(Number(coinCount) || 0));
  const visible = Math.min(total, RING_MAX_COINS);
  const rows = Math.max(1, visible);

  const width = CLUSTER_PAD * 2 + READOUT_W + COIN_READOUT_GAP + COIN_SIZE;
  const height = CLUSTER_PAD * 2
    + rows * COIN_SIZE
    + Math.max(0, rows - 1) * COIN_GAP;
  return { width, height, visible };
}

// Default side is LEFT (the permission bubble slides in from the right, so the
// left flank keeps them apart). Flip to the right only when the left cannot fit
// the cluster; if neither side fits, keep the side with more room and let the
// caller clamp.
function resolveRingSide({ petLeft, petRight, workArea, clusterWidth, gap = RING_PET_GAP, margin = RING_EDGE_MARGIN }) {
  if (!workArea) return "left";
  const need = clusterWidth + gap + margin;
  const leftRoom = petLeft - workArea.x;
  const rightRoom = (workArea.x + workArea.width) - petRight;
  if (leftRoom >= need) return "left";
  if (rightRoom >= need) return "right";
  return leftRoom >= rightRoom ? "left" : "right";
}

// Full placement: cluster footprint, chosen side, and the outer window bounds
// (content + transparent shell). Vertically centered on the pet's follow rect
// (the anchor rect if provided, else the hit rect), clamped to the work area.
function computeQuotaRingBounds({
  hitRect,
  anchorRect,
  workArea,
  coinCount,
  scale = 1,
  sidePreference,
  avoidRects = [],
  avoidGap,
}) {
  // Attach to the pet's actual body (hit rect); fall back to the HUD anchor.
  const followRect = isScreenRect(hitRect) ? hitRect : anchorRect;
  if (!isScreenRect(followRect) || !workArea) return null;
  const total = Math.max(0, Math.floor(Number(coinCount) || 0));
  if (total <= 0) return null;

  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const content = ringClusterContentSize(total);
  const contentW = Math.round(content.width * s);
  const contentH = Math.round(content.height * s);
  const gap = Math.round(RING_PET_GAP * s);
  const margin = Math.round(RING_EDGE_MARGIN * s);
  const shell = {
    top: Math.round(RING_SHELL.top * s),
    right: Math.round(RING_SHELL.right * s),
    bottom: Math.round(RING_SHELL.bottom * s),
    left: Math.round(RING_SHELL.left * s),
  };

  const petLeft = Math.round(followRect.left);
  const petRight = Math.round(followRect.right);
  const petCy = Math.round((followRect.top + followRect.bottom) / 2);

  const side = sidePreference === "left" || sidePreference === "right"
    ? sidePreference
    : resolveRingSide({ petLeft, petRight, workArea, clusterWidth: contentW, gap, margin });

  const minX = Math.round(workArea.x + margin);
  const maxX = Math.round(workArea.x + workArea.width - margin - contentW);
  let x = side === "left" ? petLeft - gap - contentW : petRight + gap;
  x = clamp(x, minX, maxX);

  const minY = Math.round(workArea.y + margin);
  const maxY = Math.round(workArea.y + workArea.height - margin - contentH);
  const initialY = clamp(petCy - Math.round(contentH / 2), minY, maxY);
  const y = resolveAvoidingY({
    initialY,
    minY,
    maxY,
    x,
    width: contentW,
    height: contentH,
    avoidRects,
    gap: Number.isFinite(avoidGap) ? Math.max(0, avoidGap) : Math.round(6 * s),
  });

  const contentBounds = { x, y, width: contentW, height: contentH };
  return {
    side,
    visibleCoins: content.visible,
    contentBounds,
    bounds: {
      x: contentBounds.x - shell.left,
      y: contentBounds.y - shell.top,
      width: contentW + shell.left + shell.right,
      height: contentH + shell.top + shell.bottom,
    },
  };
}

module.exports = {
  RING_PROVIDERS,
  collectQuotaCoins,
  countQuotaCoins,
  listQuotaRingProviders,
  formatWindowLabel,
  quotaSeverity,
  ringClusterContentSize,
  resolveRingSide,
  computeQuotaRingBounds,
  providerHasDrawableQuota,
  overlapArea,
  resolveAvoidingY,
  constants: {
    COIN_SIZE,
    COIN_GAP,
    READOUT_W,
    COIN_READOUT_GAP,
    CLUSTER_PAD,
    RING_PET_GAP,
    RING_EDGE_MARGIN,
    RING_MAX_COINS,
    RING_SHELL,
  },
};
