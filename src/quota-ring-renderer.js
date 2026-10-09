"use strict";

// ── Quota "Orbit" ring cluster (renderer) ──
// One coin per (source, provider). A coin carries up to two concentric rings:
// the outer for the shorter/rolling window, the inner for the weekly window.
// The arc can present USED percent (full = nearly exhausted) or REMAINING
// percent (full = plenty left). Severity still follows usedPercent, so changing
// the presentation never changes warning semantics. A healthy ring is colored
// by identity (provider + logical window, see identityClass) rather than by
// headroom, because severity has only three steps and would paint two healthy
// windows the same color; crossing a threshold hands the ring over to
// amber/red. Window labels come from
// each bucket's windowMinutes, never a hard-coded 5h/7d. The main process
// (session-hud.js) sizes/positions the window and passes the side.

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const DEFAULT_QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;
const PROVIDER_STALE_AFTER_MS = Object.freeze({
  kimiQuota: 7 * 60 * 1000,
});
const MAX_COINS = 4; // must match quota-ring-geometry RING_MAX_COINS

// Mirrors RING_PROVIDERS in quota-ring-geometry.js (that file is CommonJS; this
// runs in the browser and cannot require it). Antigravity reports two quota
// families; each physical ring selects the most constrained candidate for its
// timescale while the Dashboard keeps the full breakdown.
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
  {
    key: "kimiQuota",
    label: "Kimi",
    outer: [{ field: "kimiFiveHour", fallback: "5h" }],
    inner: [{ field: "kimiWeekly", fallback: "7d" }],
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
// Per-provider override, because the exporter does not give every glyph the
// same share of its canvas (see scripts/export-agent-icons.js):
//
//   plain marks           artwork fills 56 of 64  -> zoom 64/56
//   contrast-tile marks   artwork fills 40 of 64, inside a 56px light plate
//                         -> zoom 64/40
//
// A single 1.35 for both is what made the Codex mark look 29% smaller than
// Claude's and wear a visible frame: 1.35 shows the middle 47 units, so a
// 40-unit mark floats with 7 units of its plate still in frame. Zooming to
// 64/40 fills the hole with the mark itself and pushes the plate past the clip,
// which is also why the frame disappears — and the plate (#f4f4f4) is within a
// couple of levels of the coin's own plate (#f6f6f8), so nothing shows at the
// seam. The tile exists so these black-on-transparent marks survive the dark
// HUD and Dashboard surfaces; a coin already puts them on a light plate, so
// here it is pure cost. test/session-hud-style.test.js pins this mapping
// against the exporter's own manifest so a new provider cannot miss it.
// Tiled marks get a little breathing room rather than a flush fit. Filling the
// hole exactly (64/40) is geometrically "equal" to the plain marks but not
// visually: OpenAI's six-blade spiral has thin interlocking strokes, and at the
// coin's ~10.6px glyph circle its stroke gaps fall under a pixel and antialias
// into a grey smudge. Claude's starburst survives flush because it is radial,
// thick, and mostly empty. So 40 units of artwork are laid out at 90% of the
// hole — 40 / 0.9 = 44.4 — which still pushes the plate past the clip (the
// frame stays gone) without crowding the strokes.
const GLYPH_ZOOM_BY_PROVIDER = {
  antigravityQuota: 64 / 56,
  claudeQuota: 64 / 56,
  codexQuota: 64 / 44.4,
  kimiQuota: 64 / 56,
};
let coinClipSeq = 0;

let payload = {
  accountQuota: [],
  quotaAgentIcons: {},
  displayMode: "used",
  hiddenQuotaProviders: [],
  side: "left",
  translations: {},
};
const clusterEl = document.getElementById("cluster");

function t(key) {
  const dict = payload && payload.translations ? payload.translations : {};
  return dict[key] || key;
}

function quotaDisplayMode() {
  return payload && payload.displayMode === "remaining" ? "remaining" : "used";
}

function quotaDisplayPercent(usedPercent) {
  const used = Math.max(0, Math.min(100, Number(usedPercent) || 0));
  return quotaDisplayMode() === "remaining" ? 100 - used : used;
}

function formatWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

// One definition of the thresholds: the ring's color, the pulse, and whether
// the readout yields to the binding window all key off the same two numbers.
const WARN_AT = 60; // >= this is amber
const HOT_AT = 85; // > this is red (and pulses)

function severityClass(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "sev-ok";
  if (p > HOT_AT) return "sev-hot";
  if (p >= WARN_AT) return "sev-warn";
  return "sev-ok";
}

// Identity hint for the stylesheet: a healthy ring is colored by (provider,
// logical window) so the rolling and weekly windows stay tellable apart —
// severity alone paints both the same color whenever both are healthy. The
// slot argument is the window's LOGICAL timescale, not the physical ring it
// is drawn on: a provider reporting only its weekly window (Codex, since the
// 5h window was retired) draws that ring at the outer radius yet still wears
// the weekly/inner hue — the same hue the Dashboard paints its Weekly bar,
// so a color names one window across both surfaces.
// Appended last so the "sev-x is-near" pair stays contiguous.
function identityClass(providerKey, ringSlot) {
  return `pv-${providerKey} rg-${ringSlot}`;
}

function staleAfterMs(providerKey) {
  return PROVIDER_STALE_AFTER_MS[providerKey] || DEFAULT_QUOTA_STALE_AFTER_MS;
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
function selectRingWindow(group, candidates, now, ring, providerSeenAtValue, providerKey) {
  let selected = null;
  for (const candidate of candidates) {
    const bucket = liveBucket(group, candidate.field, now);
    if (!bucket) continue;
    const reset = bucket.expired === true;
    const pct = Math.max(0, Math.min(100, Number(bucket.usedPercent) || 0));
    const bucketSeenAt = Number(bucket.lastSeenAt);
    const seenAt = Number.isFinite(bucketSeenAt) ? bucketSeenAt : providerSeenAtValue;
    const stale = Number.isFinite(seenAt) && now - seenAt > staleAfterMs(providerKey);
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
  const outer = selectRingWindow(group, def.outer, now, "outer", providerSeen, def.key);
  const inner = selectRingWindow(group, def.inner, now, "inner", providerSeen, def.key);
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
  // The compact readout answers the common "what is my rolling-window usage?"
  // question, so it prefers the rolling window while that is fresh — never
  // presenting an old rolling number as live when the weekly window has a
  // newer confirmation.
  //
  // But it yields to the binding window once that crosses a warning threshold.
  // Otherwise the number and the alert describe different windows: 30% rolling
  // over 90% weekly printed "30% 5h" — the most reassuring reading available —
  // while the only thing reporting trouble was the inner ring's color. That
  // left color as the sole carrier of the alert, which fails anyone with a
  // color-vision deficiency, fails a glance that reads the digits, and (in the
  // 60-85 band, where nothing pulses) has no other channel at all.
  const restingWindow = (outer && !outer.stale)
    ? outer
    : ((inner && !inner.stale) ? inner : (outer || inner));
  const displayWindow = (binding && binding.pct >= WARN_AT && binding !== restingWindow)
    ? binding
    : restingWindow;
  const stale = windows.every((w) => w.stale);
  const state = allReset ? "reset" : (stale ? "stale" : "live");
  const near = state === "live" && binding && binding.pct > HOT_AT;

  const visibleHost = multiSource
    ? (source.host || t("dashboardQuotaSourceLocal"))
    : null;
  return {
    providerKey: def.key,
    label: def.label,
    host: visibleHost || source.host || null,
    // Stable identity from the store, distinct from the display label: two
    // trusted remote profiles may share one host string, so anything keyed per
    // source has to use this instead.
    sourceKey: source.sourceKey === undefined ? null : source.sourceKey,
    sourceMarker: visibleHost,
    glyphUrl: payload.quotaAgentIcons && payload.quotaAgentIcons[def.key],
    windows,
    binding,
    displayWindow,
    // Kept so the flashback can hand the readout back to the rolling number at
    // the moments it is asked about — yielding the headline was right, but
    // dropping the quiet number entirely trades one blind spot for another.
    restingWindow,
    state,
    near: !!near,
  };
}

// Providers the user hid from this cluster. Display-only — collection and the
// Dashboard are untouched. quota-ring-geometry.js applies the identical filter
// when it sizes this window; the two must agree or the window reserves space
// for coins that never render. test/quota-ring-geometry.test.js pins the pair.
function hiddenProviderSet() {
  const hidden = Array.isArray(payload.hiddenQuotaProviders) ? payload.hiddenQuotaProviders : [];
  const keys = hidden.filter((key) => typeof key === "string" && key);
  return keys.length ? new Set(keys) : null;
}

function collectCoins(now) {
  const sources = Array.isArray(payload.accountQuota) ? payload.accountQuota : [];
  const hidden = hiddenProviderSet();
  const isDrawn = (source, def) =>
    !(hidden && hidden.has(def.key)) && providerHasDrawableQuota(source, def);
  // "Multi-source" drives the per-coin host marker, so it counts sources that
  // still draw something AFTER hiding — hiding every provider a second machine
  // reports should retire the marker, not leave it labelling a single cluster.
  const drawableSources = sources.filter((source) =>
    source && typeof source === "object"
      && RING_PROVIDERS.some((def) => isDrawn(source, def)));
  const multiSource = drawableSources.length > 1;
  const coins = [];
  for (const source of drawableSources) {
    for (const def of RING_PROVIDERS) {
      if (hidden && hidden.has(def.key)) continue;
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

  // The track carries the identity classes too: it is the same hue as the fill,
  // just laid down faintly as a bed (see quota-ring.html). A reset ring draws no
  // fill at all, so its bed is the only thing left — it must not fall back to
  // grey there, and it gets its own class so the bed can be strengthened for
  // exactly that state. Per RING, not per row: .coin-row.is-reset only exists
  // when EVERY window reset, so "one window reset while the other is live" —
  // the common case right after a 5h rollover — falls straight through it.
  const bedOnly = (w) => !!w && w.reset === true && quotaDisplayMode() === "used";
  // Staleness belongs to a bucket, not necessarily the whole provider. A
  // presence-aware partial update can refresh weekly while leaving 5h old (or
  // vice versa), so each physical ring carries its own class. The row-level
  // state remains useful when every reported window is stale.
  const staleClass = (w) => (w && w.stale ? " is-stale" : "");
  // Identity classes come from each window's LOGICAL slot (outer.ring), so a
  // single-window provider drawn at the outer radius still wears the hue of
  // the window it is actually reporting (see identityClass).
  svg.appendChild(ringCircle(
    `track ${identityClass(model.providerKey, outer.ring)}${bedOnly(outer) ? " is-reset-bed" : ""}${staleClass(outer)}`,
    OUTER_R, OUTER_SW, null));
  if (outer && (!outer.reset || quotaDisplayMode() === "remaining")) {
    const outerNear = !outer.reset && model.near && model.binding === outer;
    const f = ringCircle(
      `fill ${outer.reset ? "sev-reset" : severityClass(outer.pct)}${outerNear ? " is-near" : ""} ${identityClass(model.providerKey, outer.ring)}${staleClass(outer)}`,
      OUTER_R,
      OUTER_SW,
      { pct: outer.reset ? 100 : quotaDisplayPercent(outer.pct) }
    );
    svg.appendChild(f);
  }
  if (dual) {
    svg.appendChild(ringCircle(
      `track ${identityClass(model.providerKey, inner.ring)}${bedOnly(inner) ? " is-reset-bed" : ""}${staleClass(inner)}`,
      INNER_R, INNER_SW, null));
    if (inner && (!inner.reset || quotaDisplayMode() === "remaining")) {
      const innerNear = !inner.reset && model.near && model.binding === inner;
      svg.appendChild(ringCircle(
        `fill ${inner.reset ? "sev-reset" : severityClass(inner.pct)}${innerNear ? " is-near" : ""} ${identityClass(model.providerKey, inner.ring)}${staleClass(inner)}`,
        INNER_R,
        INNER_SW,
        { pct: inner.reset ? 100 : quotaDisplayPercent(inner.pct) }
      ));
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

    const zoom = GLYPH_ZOOM_BY_PROVIDER[model.providerKey] || GLYPH_ZOOM;
    const box = plateR * 2 * zoom; // oversize past the clip → crops PNG padding
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

function buildCoinRow(model, now = Date.now()) {
  const row = document.createElement("div");
  row.className = `coin-row is-${model.state}`;
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
  // During a flashback the rolling window borrows the readout back. The rings
  // never change — only which window the digits are reporting — so the alert
  // stays on screen the whole time.
  const shown = model.flashingResting ? model.restingWindow : model.displayWindow;
  if (shown && shown.reset) {
    pct.textContent = quotaDisplayMode() === "remaining" ? "100%" : "0%";
    win.textContent = t("quotaRingReset");
  } else if (shown) {
    pct.textContent = `${Math.round(quotaDisplayPercent(shown.pct))}%`;
    win.textContent = shown.label;
  } else {
    pct.textContent = "—";
    win.textContent = model.windows[0] ? model.windows[0].label : "";
  }
  readout.append(pct, win);
  const foot = buildReadoutFoot(model);
  if (foot) readout.appendChild(foot);

  row.append(readout, buildCoinSvg(model));
  return row;
}

// The readout's optional third line answers, in priority order:
//   1. "what do the digits mean?" — remaining mode flips the percent's
//      meaning, so whenever it is active the mode word stays on screen.
//   2. "which machine reported this?" — the static source marker, shown only
//      when the mode word above does not need the line.
//
// Deliberately NOT here: the stale age. A draft spelled it out ("1h26m ago")
// so staleness would not ride on row opacity alone, which is an intensity
// channel a glance or any CVD can miss. On a real desktop it was wrong for a
// blunter reason — Codex goes stale 5 minutes after its last reading, so the
// note is on screen during every ordinary gap between runs, i.e. nearly
// always. A permanent footnote is not a warning, it is furniture, and it cost
// a third text line on a 26px coin row to say nothing new. If staleness needs
// a second channel later, it should be one that is silent while normal —
// desaturating the arc, or a dot — not standing text.
function buildReadoutFoot(model) {
  let text = null;
  if (quotaDisplayMode() === "remaining") {
    text = t("quotaRingRemainingWord");
  } else if (model.sourceMarker) {
    text = model.sourceMarker;
  }
  if (!text) return null;
  const foot = document.createElement("span");
  foot.className = "source";
  foot.textContent = text;
  return foot;
}

function buildOverflow(count) {
  const el = document.createElement("div");
  el.className = "overflow";
  el.textContent = `+${count}`;
  el.addEventListener("click", () => window.quotaRingAPI.openDashboard());
  return el;
}

// ── Rolling-window flashback ──
//
// When an alert borrows the headline, the rolling number vanishes — but "what
// did that last run cost me?" is still the question the ring gets opened for.
// Rather than cycling the two forever (permanent motion in the corner of the
// eye, and a glance can land on the wrong half), the rolling number is shown
// only at the moments it is actually being asked about:
//
//   - the cluster becomes visible and the rolling number moved since it was
//     last on screen — i.e. you summoned it right after using some quota;
//   - it is pinned, and the rolling number moves under you.
//
// Both are events, not a timer: an idle desktop never animates. Movement
// includes a window reset (70% -> 1%), which is exactly the kind of change
// worth surfacing.
const FLASH_MS = 1600;
const flashState = new Map(); // coin key -> { lastPct, dirty, until }
let ringVisible = true; // main process tells us; assume visible until told
let flashTimer = null;

// Keyed on the store's sourceKey, never on `host`: host is a display label and
// two trusted remote profiles are explicitly allowed to share one, which would
// otherwise fuse their coins into a single state entry — each overwriting the
// other's lastPct and manufacturing a change on every snapshot. JSON so no
// separator can appear inside a component.
function coinKey(model) {
  return JSON.stringify([model.providerKey, model.sourceKey ?? null]);
}

// A coin only has something to flash back TO when the alert took the headline
// from a different window.
function flashCandidate(model) {
  return model.restingWindow
    && model.displayWindow
    && model.restingWindow !== model.displayWindow
    ? model.restingWindow
    : null;
}

function armFlash(entry, now) {
  entry.dirty = false;
  // Do not restart a flash already running: with several runs back to back the
  // readout would otherwise sit on the rolling number indefinitely and the
  // alert would never get its headline back. (A newer value still paints
  // immediately — the snapshot repaints — it just does not extend the window.)
  if (!(entry.until > now)) entry.until = now + FLASH_MS;
}

// Fold the current snapshot into the flash state. Called only where the
// snapshot is actually consumed — never from fingerprint(), which runs every
// tick and must stay free of side effects.
function noteRestingWindows(coins, now) {
  const seen = new Set();
  for (const model of coins) {
    const key = coinKey(model);
    seen.add(key);
    const resting = model.restingWindow;
    const pct = resting && !resting.reset ? resting.pct : null;
    const entry = flashState.get(key);
    if (!entry) {
      // First sighting establishes the baseline; a fresh window (or a rebuilt
      // one after the panel was destroyed) should not flash on arrival.
      flashState.set(key, { lastPct: pct, dirty: false, until: 0 });
      continue;
    }
    if (pct === entry.lastPct) continue;
    entry.lastPct = pct;
    // Record the movement itself, independently of whether an alert happens to
    // hold the headline right now. Gating this on flashCandidate() lost the
    // ordinary case: rolling moves while hidden and healthy, THEN the weekly
    // window crosses the threshold — by the time anyone looks, the rolling
    // number has changed unseen and nothing remembers it.
    entry.dirty = true;
    if (!ringVisible) continue;
    // Visible: either play it now, or note that it is already on screen — the
    // readout IS the rolling window when no alert took it, so there is nothing
    // left to replay later.
    if (flashCandidate(model)) armFlash(entry, now);
    else entry.dirty = false;
  }
  for (const key of [...flashState.keys()]) if (!seen.has(key)) flashState.delete(key);
}

function isFlashing(model, now) {
  const entry = flashState.get(coinKey(model));
  return !!(entry && entry.until > now && flashCandidate(model));
}

// Release whatever was banked while the cluster was hidden. Returns whether
// anything actually fired, so the caller can skip a repaint.
function armPendingFlashes(coins, now) {
  let armed = false;
  for (const model of coins) {
    const entry = flashState.get(coinKey(model));
    if (!entry || !entry.dirty) continue;
    if (flashCandidate(model)) {
      armFlash(entry, now);
      armed = true;
    } else {
      // No alert holds the headline any more, so the rolling number is already
      // what the reader sees. Clear the debt rather than keeping it — otherwise
      // the next alert would open with a replay of a change the reader has
      // been looking at the whole time.
      entry.dirty = false;
    }
  }
  return armed;
}

// Fire at the EARLIEST pending expiry, not a fixed FLASH_MS from now: a second
// coin flashing later would otherwise push the timer out and leave the first
// one's handback to the 1s tick, stretching a 1.6s flash toward 2.6s.
function scheduleFlashEnd(now) {
  let earliest = Infinity;
  for (const entry of flashState.values()) {
    if (entry.until > now && entry.until < earliest) earliest = entry.until;
  }
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = null;
  if (!Number.isFinite(earliest)) return;
  flashTimer = setTimeout(() => {
    flashTimer = null;
    render();
    // Another coin may still be mid-flash with a later expiry.
    scheduleFlashEnd(Date.now());
  }, Math.max(0, earliest - now) + 30);
}

// Digest of everything time flips WITHOUT a new snapshot (bucket expiry, source
// staleness), so the 1s tick can re-render on change even for a pinned cluster
// receiving no snapshots.
let lastFingerprint = "";
function fingerprint(now) {
  const coins = collectCoins(now);
  const digest = coins.map((m) => {
    const windows = m.windows.map((w) => {
      const resetIn = Number.isFinite(w.resetAt) && w.resetAt > now
        ? Math.ceil((w.resetAt - now) / 60000)
        : 0;
      const staleAge = w.stale && Number.isFinite(w.seenAt)
        ? Math.floor((now - w.seenAt) / 60000)
        : 0;
      return `${w.ring}:${w.field}:${w.pct}:${w.reset ? 1 : 0}:${resetIn}:${w.stale ? 1 : 0}:${staleAge}`;
    }).join(",");
    // Include the flash so the 1s tick can repaint when one expires, as a
    // backstop for the precise timer. (It cannot recover a panel that was
    // destroyed and rebuilt mid-flash — that takes the whole Map with it.)
    return `${m.providerKey}:${m.host || ""}:${m.state}:${isFlashing(m, now) ? 1 : 0}:${windows}`;
  }).join("|");
  return `${quotaDisplayMode()}|${digest}`;
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

  for (const model of visible) {
    model.flashingResting = isFlashing(model, now);
    clusterEl.appendChild(buildCoinRow(model, now));
  }
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
      displayMode: next && next.displayMode === "remaining" ? "remaining" : "used",
      hiddenQuotaProviders: Array.isArray(next && next.hiddenQuotaProviders)
        ? next.hiddenQuotaProviders
        : [],
      side: next && next.side === "right" ? "right" : "left",
      translations: payload.translations,
      lang: payload.lang,
    };
    const now = Date.now();
    const coins = collectCoins(now);
    noteRestingWindows(coins, now);
    if (coins.some((model) => isFlashing(model, now))) scheduleFlashEnd(now);
    render();
  });

  // Visibility comes from the main process rather than the Page Visibility API:
  // an Electron window that is merely hidden does not reliably flip
  // document.visibilityState, and a pinned cluster never hides at all.
  if (typeof window.quotaRingAPI.onVisibility === "function") {
    window.quotaRingAPI.onVisibility((visible) => {
      const wasVisible = ringVisible;
      ringVisible = visible !== false;
      if (!ringVisible || wasVisible) return;
      const now = Date.now();
      if (!armPendingFlashes(collectCoins(now), now)) return;
      scheduleFlashEnd(now);
      render();
    });
  }

  const i18n = await window.quotaRingAPI.getI18n();
  if (i18n) payload = { ...payload, translations: i18n.translations || {}, lang: i18n.lang };
  // Establish the baseline before the first paint so a cold start never opens
  // on a flashback.
  noteRestingWindows(collectCoins(Date.now()), Date.now());
  render();
  setInterval(tick, 1000);
}

init().catch((err) => {
  clusterEl.textContent = err && err.message ? err.message : String(err);
});
