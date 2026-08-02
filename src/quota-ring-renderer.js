"use strict";

// ── Quota "Orbit" ring cluster (renderer) ──
// One coin per (source, provider). A coin carries up to two concentric rings:
// the outer for the shorter/rolling window, the inner for the weekly window.
// The arc fills with USED percent (a full ring = nearly exhausted); an empty
// dim ring means the window reset with nothing reported since. Window labels
// come from each bucket's windowMinutes, never a hard-coded 5h/7d. The main
// process (session-hud.js) sizes/positions the window and passes the side.

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_COINS = 4; // must match quota-ring-geometry RING_MAX_COINS

// Mirrors RING_PROVIDERS in quota-ring-geometry.js (that file is CommonJS; this
// runs in the browser and cannot require it). Antigravity reports two quota
// families; each physical ring selects the most constrained candidate for its
// timescale, and the tooltip identifies which family won.
const RING_PROVIDERS = [
  {
    key: "antigravityQuota",
    label: "Antigravity",
    outer: [
      { field: "geminiFiveHour", fallback: "5h", familyKey: "dashboardQuotaGroupGemini", shortFamily: "G" },
      { field: "thirdPartyFiveHour", fallback: "5h", familyKey: "dashboardQuotaGroupThirdParty", shortFamily: "C/G" },
    ],
    inner: [
      { field: "geminiWeekly", fallback: "7d", familyKey: "dashboardQuotaGroupGemini", shortFamily: "G" },
      { field: "thirdPartyWeekly", fallback: "7d", familyKey: "dashboardQuotaGroupThirdParty", shortFamily: "C/G" },
    ],
  },
  {
    key: "claudeQuota",
    label: "Claude",
    outer: [{ field: "claudeFiveHour", fallback: "5h" }],
    inner: [{ field: "claudeWeekly", fallback: "7d" }],
  },
  {
    key: "codexQuota",
    label: "Codex",
    outer: [{ field: "codexFiveHour", fallback: "5h" }],
    inner: [{ field: "codexWeekly", fallback: "7d" }],
  },
];

// Coin ring geometry (SVG user units == the coin's 26px box).
const CX = 13;
const CY = 13;
const OUTER_R = 11;
const OUTER_SW = 3;
const INNER_R = 6.8;
const INNER_SW = 2.6;
const OUTER_C = 2 * Math.PI * OUTER_R;
const INNER_C = 2 * Math.PI * INNER_R;
// Provider logos are square PNGs with their own padding. Clip them to a circle
// (avatar mask) and oversize past the clip so the mark fills the circle instead
// of floating small inside the PNG's whitespace.
const GLYPH_ZOOM = 1.35;
let coinClipSeq = 0;

let payload = { accountQuota: [], quotaAgentIcons: {}, side: "left", translations: {} };
const clusterEl = document.getElementById("cluster");

function t(key) {
  const dict = payload && payload.translations ? payload.translations : {};
  return dict[key] || key;
}

function formatWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function severityClass(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "sev-ok";
  if (p > 85) return "sev-hot";
  if (p >= 60) return "sev-warn";
  return "sev-ok";
}

function formatDurationHM(totalMinutes) {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) {
    return t("dashboardQuotaResetHoursMinutes").replace("{h}", h).replace("{m}", m);
  }
  return t("dashboardQuotaResetMinutes").replace("{m}", m);
}

// Window reset on wall clock: the pre-reset number would read high, so an
// expired bucket becomes a dim 0 ("reset, nothing reported since").
function liveBucket(group, field, now) {
  const bucket = group && group[field];
  if (!bucket || typeof bucket !== "object") return null;
  if (bucket.expired === true || (Number.isFinite(bucket.resetAt) && bucket.resetAt <= now)) {
    return { ...bucket, usedPercent: 0, expired: true };
  }
  return bucket;
}

function providerSeenAt(provider) {
  const lastSeenAt = Number(provider && provider.lastSeenAt);
  if (Number.isFinite(lastSeenAt)) return lastSeenAt;
  const updatedAt = Number(provider && provider.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : null;
}

function providerHasDrawableQuota(source, def) {
  const provider = source && source[def.key];
  const group = provider && provider.group;
  if (!group) return false;
  return [...def.outer, ...def.inner].some((candidate) =>
    group[candidate.field] && typeof group[candidate.field] === "object");
}

// Select one candidate for a physical ring. A live bucket always beats a reset
// bucket; among equally live candidates the highest used percentage is the
// most constrained. This keeps Antigravity to one coin while never silently
// dropping its Claude/GPT quota family.
function selectRingWindow(group, candidates, now, ring, providerSeenAtValue) {
  let selected = null;
  for (const candidate of candidates) {
    const bucket = liveBucket(group, candidate.field, now);
    if (!bucket) continue;
    const reset = bucket.expired === true;
    const pct = Math.max(0, Math.min(100, Number(bucket.usedPercent) || 0));
    const bucketSeenAt = Number(bucket.lastSeenAt);
    const seenAt = Number.isFinite(bucketSeenAt) ? bucketSeenAt : providerSeenAtValue;
    const stale = Number.isFinite(seenAt) && now - seenAt > STALE_AFTER_MS;
    if (!selected
        || (selected.reset && !reset)
        || (selected.reset === reset && selected.stale && !stale)
        || (selected.reset === reset && selected.stale === stale && pct > selected.pct)) {
      selected = { bucket, candidate, reset, pct, stale, seenAt };
    }
  }
  if (!selected) return null;
  const baseLabel = formatWindowLabel(selected.bucket.windowMinutes, selected.candidate.fallback);
  const family = selected.candidate.familyKey ? t(selected.candidate.familyKey) : "";
  return {
    pct: selected.pct,
    label: selected.candidate.shortFamily
      ? `${selected.candidate.shortFamily}·${baseLabel}`
      : baseLabel,
    detailLabel: family ? `${family} · ${baseLabel}` : baseLabel,
    reset: selected.reset,
    resetAt: selected.bucket.resetAt,
    ring,
    field: selected.candidate.field,
    stale: selected.stale,
    seenAt: selected.seenAt,
  };
}

// Build the visual model for one coin from a source's provider group.
function buildCoinModel(source, def, now, multiSource) {
  const provider = source[def.key];
  const group = provider && provider.group;
  if (!group) return null;
  const providerSeen = providerSeenAt(provider);
  const outer = selectRingWindow(group, def.outer, now, "outer", providerSeen);
  const inner = selectRingWindow(group, def.inner, now, "inner", providerSeen);
  if (!outer && !inner) return null;

  const windows = [];
  if (outer) windows.push(outer);
  if (inner) windows.push(inner);

  const allReset = windows.every((w) => w.reset);
  // Binding window = the most-constrained live window (max used, tie → outer).
  const live = windows.filter((w) => !w.reset);
  const freshLive = live.filter((w) => !w.stale);
  const bindingCandidates = freshLive.length ? freshLive : live;
  let binding = null;
  for (const w of bindingCandidates) {
    if (!binding || w.pct > binding.pct) binding = w;
  }
  // The compact readout answers the common "what is my rolling-window
  // usage?" question. Keep it independent from binding: the weekly window
  // can still own warning/pulse when it is more constrained. Prefer the
  // rolling window while it is fresh, but never present an old rolling
  // number as live when the weekly window has a newer confirmation.
  const displayWindow = (outer && !outer.stale)
    ? outer
    : ((inner && !inner.stale) ? inner : (outer || inner));
  const stale = windows.every((w) => w.stale);
  const state = allReset ? "reset" : (stale ? "stale" : "live");
  const near = state === "live" && binding && binding.pct > 85;

  const visibleHost = multiSource
    ? (source.host || t("dashboardQuotaSourceLocal"))
    : null;
  return {
    providerKey: def.key,
    label: def.label,
    host: visibleHost || source.host || null,
    sourceMarker: visibleHost,
    glyphUrl: payload.quotaAgentIcons && payload.quotaAgentIcons[def.key],
    windows,
    binding,
    displayWindow,
    state,
    near: !!near,
  };
}

function collectCoins(now) {
  const sources = Array.isArray(payload.accountQuota) ? payload.accountQuota : [];
  const drawableSources = sources.filter((source) =>
    source && typeof source === "object"
      && RING_PROVIDERS.some((def) => providerHasDrawableQuota(source, def)));
  const multiSource = drawableSources.length > 1;
  const coins = [];
  for (const source of drawableSources) {
    for (const def of RING_PROVIDERS) {
      const model = buildCoinModel(source, def, now, multiSource);
      if (model) coins.push(model);
    }
  }
  return coins;
}

function ringCircle(cls, r, sw, dashFill) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("class", cls);
  c.setAttribute("cx", String(CX));
  c.setAttribute("cy", String(CY));
  c.setAttribute("r", String(r));
  c.setAttribute("fill", "none");
  c.setAttribute("stroke-width", String(sw));
  if (dashFill) {
    const circ = 2 * Math.PI * r;
    const filled = Math.max(0, Math.min(100, dashFill.pct)) / 100 * circ;
    c.setAttribute("stroke-linecap", "round");
    c.setAttribute("stroke-dasharray", `${filled.toFixed(2)} ${circ.toFixed(2)}`);
    c.setAttribute("transform", `rotate(-90 ${CX} ${CY})`);
  }
  return c;
}

function buildCoinSvg(model) {
  const dual = model.windows.length > 1;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "coin");
  svg.setAttribute("viewBox", "0 0 26 26");
  svg.setAttribute("aria-hidden", "true");

  const outer = model.windows.find((w) => w.ring === "outer") || model.windows[0];
  const inner = model.windows.find((w) => w.ring === "inner");

  svg.appendChild(ringCircle("track", OUTER_R, OUTER_SW, null));
  if (outer && !outer.reset) {
    const outerNear = model.near && model.binding === outer;
    const f = ringCircle(`fill ${severityClass(outer.pct)}${outerNear ? " is-near" : ""}`, OUTER_R, OUTER_SW, { pct: outer.pct });
    svg.appendChild(f);
  }
  if (dual) {
    svg.appendChild(ringCircle("track", INNER_R, INNER_SW, null));
    if (inner && !inner.reset) {
      const innerNear = model.near && model.binding === inner;
      svg.appendChild(ringCircle(`fill ${severityClass(inner.pct)}${innerNear ? " is-near" : ""}`, INNER_R, INNER_SW, { pct: inner.pct }));
    }
  }

  // Center token: a single-ring coin owns the whole inner hole; a dual-ring
  // coin only the space inside the weekly ring. The logo is clipped to a circle
  // (avatar mask) and oversized so it fills that circle edge-to-edge.
  const plateR = dual ? 5.3 : 7.9;
  const plate = document.createElementNS(SVG_NS, "circle");
  plate.setAttribute("class", "plate");
  plate.setAttribute("cx", String(CX));
  plate.setAttribute("cy", String(CY));
  plate.setAttribute("r", String(plateR));
  svg.appendChild(plate);

  if (model.glyphUrl) {
    const clipId = `coin-clip-${coinClipSeq++}`;
    const defs = document.createElementNS(SVG_NS, "defs");
    const clip = document.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", clipId);
    const clipCircle = document.createElementNS(SVG_NS, "circle");
    clipCircle.setAttribute("cx", String(CX));
    clipCircle.setAttribute("cy", String(CY));
    clipCircle.setAttribute("r", String(plateR));
    clip.appendChild(clipCircle);
    defs.appendChild(clip);
    svg.appendChild(defs);

    const box = plateR * 2 * GLYPH_ZOOM; // oversize past the clip → crops PNG padding
    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("class", "glyph");
    img.setAttribute("x", String(CX - box / 2));
    img.setAttribute("y", String(CY - box / 2));
    img.setAttribute("width", String(box));
    img.setAttribute("height", String(box));
    img.setAttribute("preserveAspectRatio", "xMidYMid slice");
    img.setAttribute("clip-path", `url(#${clipId})`);
    img.setAttribute("href", model.glyphUrl);
    img.setAttributeNS(XLINK_NS, "xlink:href", model.glyphUrl);
    svg.appendChild(img);
  }
  return svg;
}

function coinTooltip(model, now) {
  const parts = [model.label];
  if (model.host) parts.push(model.host);
  for (const w of model.windows) {
    if (w.reset) {
      parts.push(`${w.detailLabel} · ${t("quotaRingReset")}`);
    } else {
      let seg = `${w.detailLabel} · ${w.pct}% ${t("quotaRingUsedWord")}`;
      if (Number.isFinite(w.resetAt) && w.resetAt > now) {
        seg += ` · ${t("dashboardQuotaResetIn").replace("{time}", formatDurationHM((w.resetAt - now) / 60000))}`;
      }
      parts.push(seg);
    }
    if (w.stale && Number.isFinite(w.seenAt)) {
      parts.push(t("dashboardQuotaAsOf").replace("{time}", formatDurationHM((now - w.seenAt) / 60000)));
    }
  }
  return parts.join(" · ");
}

function buildCoinRow(model, now) {
  const row = document.createElement("div");
  row.className = `coin-row is-${model.state}`;
  row.title = coinTooltip(model, now);
  // The hosting Electron panel is intentionally non-focusable so checking
  // quota never steals focus from the terminal. Treat the ring as a decorative
  // pointer convenience; keyboard/screen-reader access remains in Dashboard.
  row.addEventListener("click", () => window.quotaRingAPI.openDashboard());

  const readout = document.createElement("div");
  readout.className = "readout";
  const pct = document.createElement("span");
  pct.className = "pct";
  const win = document.createElement("span");
  win.className = "win";
  if (model.displayWindow && model.displayWindow.reset) {
    pct.textContent = "0%";
    win.textContent = t("quotaRingReset");
  } else if (model.displayWindow) {
    pct.textContent = `${Math.round(model.displayWindow.pct)}%`;
    win.textContent = model.displayWindow.label;
  } else {
    pct.textContent = "—";
    win.textContent = model.windows[0] ? model.windows[0].label : "";
  }
  readout.append(pct, win);
  if (model.sourceMarker) {
    const source = document.createElement("span");
    source.className = "source";
    source.textContent = model.sourceMarker;
    readout.appendChild(source);
  }

  row.append(readout, buildCoinSvg(model));
  return row;
}

function buildOverflow(count) {
  const el = document.createElement("div");
  el.className = "overflow";
  el.textContent = `+${count}`;
  el.title = t("quotaRingOverflow").replace("{n}", count);
  el.addEventListener("click", () => window.quotaRingAPI.openDashboard());
  return el;
}

// Digest of everything time flips WITHOUT a new snapshot (bucket expiry, source
// staleness), so the 1s tick can re-render on change even for a pinned cluster
// receiving no snapshots.
let lastFingerprint = "";
function fingerprint(now) {
  const coins = collectCoins(now);
  return coins.map((m) => {
    const windows = m.windows.map((w) => {
      const resetIn = Number.isFinite(w.resetAt) && w.resetAt > now
        ? Math.ceil((w.resetAt - now) / 60000)
        : 0;
      const staleAge = w.stale && Number.isFinite(w.seenAt)
        ? Math.floor((now - w.seenAt) / 60000)
        : 0;
      return `${w.ring}:${w.field}:${w.pct}:${w.reset ? 1 : 0}:${resetIn}:${w.stale ? 1 : 0}:${staleAge}`;
    }).join(",");
    return `${m.providerKey}:${m.host || ""}:${m.state}:${windows}`;
  }).join("|");
}

function render() {
  const now = Date.now();
  lastFingerprint = fingerprint(now);
  clusterEl.className = `cluster side-${payload.side === "right" ? "right" : "left"}`;
  clusterEl.replaceChildren();
  coinClipSeq = 0;

  const coins = collectCoins(now);
  if (!coins.length) return;
  const visible = coins.slice(0, MAX_COINS);
  const overflow = coins.length - visible.length;

  for (const model of visible) clusterEl.appendChild(buildCoinRow(model, now));
  if (overflow > 0) clusterEl.appendChild(buildOverflow(overflow));
}

function tick() {
  const now = Date.now();
  if (fingerprint(now) !== lastFingerprint) render();
}

async function init() {
  window.quotaRingAPI.onLangChange((next) => {
    if (next) payload = { ...payload, translations: next.translations || {}, lang: next.lang };
    render();
  });
  window.quotaRingAPI.onSnapshot((next) => {
    payload = {
      accountQuota: Array.isArray(next && next.accountQuota) ? next.accountQuota : [],
      quotaAgentIcons: (next && next.quotaAgentIcons) || {},
      side: next && next.side === "right" ? "right" : "left",
      translations: payload.translations,
      lang: payload.lang,
    };
    render();
  });

  const i18n = await window.quotaRingAPI.getI18n();
  if (i18n) payload = { ...payload, translations: i18n.translations || {}, lang: i18n.lang };
  render();
  setInterval(tick, 1000);
}

init().catch((err) => {
  clusterEl.textContent = err && err.message ? err.message : String(err);
});
