"use strict";

// ── Linux / native Wayland: BaseWindow geometry & placement shim ──
//
// Original work by xingguangcuican6666.
//
// On the native Wayland Ozone backend Electron's window geometry API is half
// broken (all measured on Electron 41 / Hyprland 0.57):
//
//   • getBounds()/getPosition()/getContentBounds() return x=0,y=0 once the
//     window is mapped — Chromium does not know where the compositor put it.
//   • setBounds()/setPosition() update Electron's own state and the native
//     SIZE, but the position never reaches the compositor (clients may not
//     place themselves). The window keeps its compositor-chosen spot.
//   • setSize() resizes around the window CENTER, so the top-left drifts by
//     half the size delta.
//   • getNormalBounds() goes stale (frozen at the pre-map constructor rect).
//   • A hide→show remap frequently never maps at all: 25-50% of rapid cycles
//     left no entry in `j/clients` while win.isVisible() still reported true.
//     Independent of focusable and of window rules. One hide+wait+show retry
//     recovered 36/36 measured failures, so the shim verifies and retries.
//   • show()/focus() cannot activate a toplevel; only the compositor can.
//   • setIgnoreMouseEvents() is a complete no-op (X11-only implementation)
//     and setShape() has no Wayland path, so click-through needs the
//     compositor's `no_focus` rule.
//   • A window's initialTitle (what window rules match) is frozen at the
//     moment it maps and never changes for that toplevel; a window that was
//     already visible when the shim adopted it therefore keeps a markerless
//     title forever (see findOwnClientWithoutMarker).
//
// This module patches BaseWindow.prototype ONCE — BrowserWindow's prototype
// inherits from it, so every window class in the app is covered — and
// restores the documented Electron contract on top of the Hyprland backend
// (src/linux-wayland.js):
//
//   1. Position truth: every requested x/y is kept in a per-window record;
//      getters merge it with the live native size (size DOES round-trip).
//   2. Placement for floating surfaces: a named Hyprland window rule
//      (float + pin + no_initial_focus + move + size) matched on a unique
//      invisible marker title, re-asserted before every show because those
//      are STATIC effects that only apply at map time; plus a post-map
//      `movewindow` dispatcher correction.
//   3. Position for ordinary windows: `movewindow` dispatcher after the
//      native write (works while mapped; a tiled window is the compositor's
//      to place, which is the honest Wayland answer).
//   4. Show reliability: verify the map through `j/clients`, retry on miss.
//   5. Click-through: setIgnoreMouseEvents() toggles a dedicated `no_focus`
//      rule's `enabled` flag — verified to flip live on a mapped window.
//   6. Focus: focus() additionally dispatches compositor focus on the
//      window's address; blur() hands focus back to the previous window.
//
// Marker titles: each adopted window gets a unique invisible title prefix
// ("Clawd" + zero-width bits encoding pid+id). Hyprland matches window rules
// against initialTitle with RE2 FullMatch, and initialTitle re-freezes at
// EVERY map, so the marker must be in the title before the first show and
// must never be dropped. `page-title-updated` is therefore prevented on the
// WINDOW object (preventing it on webContents does nothing — Electron only
// skips SetTitle when the window-level emit is defaultPrevented), setTitle()
// composes marker + visible text, and getTitle() strips the marker back off
// so the rest of the app sees exactly what it set. Rules match "^<marker>.*"
// so a visible tail is tolerated.
//
// Degradation: with no Hyprland backend every hook falls through to the
// native call, so the app runs as a plain native-Wayland client.

const { MARKER_PREFIX, RULE_PREFIX, encodeMarker, markerRegex } = require("./linux-wayland");

// Sync sleep for the show-verification poll. Atomics.wait is allowed on the
// Node/Electron main thread (unlike a browser main thread) and needs no
// native addon.
const _waitCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(_waitCell, 0, 0, ms); } catch {}
}

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed !== "function" || (win && !win.isDestroyed()));
}

function round4(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function roundRect(rect) {
  if (!rect) return null;
  return {
    x: round4(rect.x), y: round4(rect.y),
    width: round4(rect.width), height: round4(rect.height),
  };
}

function normalizeAddress(address) {
  const s = String(address == null ? "" : address).trim();
  if (!s) return null;
  return s.startsWith("0x") ? s : `0x${s}`;
}

// ── Pure helpers (unit-tested) ──

// A window needs compositor placement (float + pin + rule-driven move) when
// the app positions it pixel-exactly and it must never take keyboard focus —
// the pet render/hit windows, session HUD, quota ring, update bubble. Every
// one of those is created focusable:false. Focusable windows are the user's
// to place (settings, dashboard, tutorial) unless a caller explicitly opts
// them in (the 1×1 context-menu owner, permission bubbles).
function needsFloatingPlacement(win, explicitlyFloating) {
  if (explicitlyFloating === true) return true;
  if (explicitlyFloating === false) return false;
  try {
    if (typeof win.isFocusable === "function") return !win.isFocusable();
  } catch {}
  return false;
}

// The permanent marker title. Idempotent: a value that already starts with
// the marker is returned untouched.
function composeMarkerTitle(marker, visible) {
  const v = String(visible == null ? "" : visible);
  return v.startsWith(marker) ? v : marker + v;
}

function stripMarkerTitle(marker, raw) {
  const s = String(raw == null ? "" : raw);
  return marker && s.startsWith(marker) ? s.slice(marker.length) : s;
}

// ── Shim installation ──

let installedShim = null;

// installLinuxWaylandWindowShim({ BaseWindow, backend, onWarn, verifyTimeoutMs,
//                                 verifyPollMs, maxShowRetries, retryDelayMs })
// Returns the shim handle (idempotent: a second call returns the same one),
// or null when there is no usable backend.
function installLinuxWaylandWindowShim(options = {}) {
  const BaseWindow = options.BaseWindow;
  const backend = options.backend;
  if (!BaseWindow || !BaseWindow.prototype || !backend || !backend.available) return null;
  if (installedShim) return installedShim;

  const onWarn = options.onWarn || ((message) => console.warn(message));
  const verifyTimeoutMs = Number.isFinite(options.verifyTimeoutMs) ? options.verifyTimeoutMs : 200;
  const verifyPollMs = Number.isFinite(options.verifyPollMs) ? options.verifyPollMs : 15;
  const maxShowRetries = Number.isFinite(options.maxShowRetries) ? options.maxShowRetries : 3;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 120;
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid;

  const proto = BaseWindow.prototype;

  // Capture the native implementations BEFORE patching: they are the only
  // way to reach Chromium's own window state.
  const native = {
    getBounds: proto.getBounds,
    setBounds: proto.setBounds,
    getPosition: proto.getPosition,
    setPosition: proto.setPosition,
    getSize: proto.getSize,
    setSize: proto.setSize,
    getNormalBounds: proto.getNormalBounds,
    setNormalBounds: proto.setNormalBounds,
    getContentBounds: proto.getContentBounds,
    setContentBounds: proto.setContentBounds,
    getTitle: proto.getTitle,
    setTitle: proto.setTitle,
    show: proto.show,
    showInactive: proto.showInactive,
    hide: proto.hide,
    focus: proto.focus,
    blur: proto.blur,
    setIgnoreMouseEvents: proto.setIgnoreMouseEvents,
    setAlwaysOnTop: proto.setAlwaysOnTop,
  };

  const states = new WeakMap();
  // Toplevels resolved to a window without a marker (first map of a
  // show:false window). They are never candidates for a second window.
  const claimedAddresses = new Set();
  // Windows that hit a title read before adoption; adopted on the next tick.
  const deferredAdoption = new WeakSet();
  // Rules to re-assert when Hyprland wipes its Lua registry on config reload.
  const definedRules = new Map();
  let nextWindowId = 1;
  let warnNoClickThrough = false;

  function placementRuleName(state) { return `${RULE_PREFIX}place-${state.markerId}`; }
  function clickRuleName(state) { return `${RULE_PREFIX}click-${state.markerId}`; }
  // The primary identity of each window is an invisible marker in its title.
  // Adoption sets that title synchronously (Electron suppresses the
  // constructor's initial SetTitle, so the marker is in place before the
  // first map), and the show path re-asserts it immediately before every
  // show — a map therefore freezes a marker title as initialTitle.
  //
  // One measured exception: a window that was ALREADY mapped when it got
  // adopted (created with show:true) froze the markerless constructor title
  // at that first map, and initialTitle never changes for a toplevel. The
  // adoption-time hide→show does not help — it does not remap the same
  // toplevel — so such a window is matched by its constructor title instead.
  // That pattern is deliberately NOT pid-scoped (Hyprland's Lua rule match
  // has no pid property), so it is only used for a title Electron itself
  // gives our windows ("Electron"); an app window with a real title relies on
  // the marker alone.
  function markerOnlyPattern(state) { return markerRegex(state.marker); }
  function fullPattern(state) { return state.pattern; }
  function clientIsFocusable(win) {
    try { return typeof win.isFocusable === "function" ? !!win.isFocusable() : true; } catch { return true; }
  }

  // Full static effect set for the placement rule. Boolean effects are always
  // emitted explicitly: a same-name hl.window_rule call REPLACES the match
  // but APPENDS effects, and the last value for a scalar property wins — so
  // an omitted `no_initial_focus=false` would leave an earlier true active.
  function placementEffects(state) {
    const rect = state.logical;
    return {
      float: true,
      // pin = visible on every workspace: the Wayland replacement for
      // setVisibleOnAllWorkspaces()/_NET_WM_STATE_STICKY (both X11-only).
      pin: !!state.pin,
      no_initial_focus: !state.wantsFocusOnMap,
      move: rect ? [rect.x, rect.y] : [0, 0],
      size: rect ? [rect.width, rect.height] : [1, 1],
    };
  }

  // Every pattern that may match the toplevel this window mapped. The
  // constructor title is captured at adoption (see ensureAdopted) and only
  // used while it is not already marker-composed.
  // Matched with FullMatch, so `^…$` is implied; escaping matters because
  // a title is arbitrary text.
  function rulePatterns(state) {
    const patterns = [fullPattern(state), markerOnlyPattern(state)];
    const ctor = String(state.constructorTitle || "");
    if (ctor && !ctor.includes(MARKER_PREFIX) && ELECTRON_OWN_TITLES.has(ctor)) {
      patterns.push(`^${escapeRegExp(ctor)}$`);
    }
    return patterns;
  }

  // Titles Electron gives a window before any app title is set. Only these
  // are safe to match without the marker: a rule on an arbitrary title would
  // also catch some other application's window.
  const ELECTRON_OWN_TITLES = new Set(["Electron", ""]);

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function syncPlacementRule(state) {
    if (!state.floating || !state.logical) return;
    const name = placementRuleName(state);
    const effects = placementEffects(state);
    const key = JSON.stringify(effects);
    if (key === state.lastPlacementKey && !state.patternsDirty) return;
    state.lastPlacementKey = key;
    state.patternsDirty = false;
    for (const pattern of rulePatterns(state)) {
      const ruleName = `${name}-${hashPattern(pattern)}`;
      definedRules.set(ruleName, { pattern, effects });
      backend.defineWindowRule(ruleName, pattern, effects);
    }
  }

  // Short stable suffix so both variants of one placement rule stay within
  // whatever name length Hyprland tolerates.
  function hashPattern(pattern) {
    let h = 0;
    const s = String(pattern);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).slice(0, 6);
  }

  function syncClickThroughRule(state, ignore) {
    const name = clickRuleName(state);
    const effects = { no_focus: true };
    if (!definedRules.has(`${name}-${hashPattern(fullPattern(state))}`)) {
      for (const pattern of rulePatterns(state)) {
        const ruleName = `${name}-${hashPattern(pattern)}`;
        definedRules.set(ruleName, { pattern, effects });
        backend.defineWindowRule(ruleName, pattern, effects);
      }
    }
    // One toggle disables/enables the window's click-through as a unit.
    for (const ruleName of definedRules.keys()) {
      if (ruleName.startsWith(`${name}-`)) backend.setWindowRuleEnabled(ruleName, !!ignore);
    }
  }

  function ensureAdopted(win) {
    if (!isLiveWindow(win)) return null;
    const existing = states.get(win);
    if (existing) return existing;

    const markerId = nextWindowId++;
    const marker = encodeMarker(pid, markerId);
    const state = {
      markerId,
      marker,
      pattern: markerRegex(marker),
      logical: null,
      normal: null,
      address: null,
      floating: false,
      floatingExplicit: null,
      pin: false,
      wantsFocusOnMap: false,
      clickThrough: null,
      lastPlacementKey: "",
      patternsDirty: false,
      constructorTitle: "",
      titleGuarded: false,
      inNativeShow: false,
      shownOnce: false,
    };
    states.set(win, state);

    // A page load replaces the window title with the document title, which
    // would drop the marker and break rule matching on the next map. Electron
    // only skips SetTitle when the WINDOW-level emit is prevented.
    try {
      win.on("page-title-updated", (event) => { try { event.preventDefault(); } catch {} });
      state.titleGuarded = true;
    } catch {}

    let nativeTitle = "";
    try { nativeTitle = native.getTitle.call(win) || ""; } catch {}
    state.constructorTitle = String(nativeTitle);
    try { native.setTitle.call(win, composeMarkerTitle(marker, nativeTitle)); } catch {}

    classify(win, state);

    // Seed the logical rect from Electron's own pre-show state (the
    // constructor's x/y/width/height are readable until the first map).
    try { state.logical = roundRect(native.getBounds.call(win)); } catch {}
    if (state.logical) state.normal = { ...state.logical };

    // A window that already mapped before adoption froze an initialTitle
    // WITHOUT the marker (Electron's constructor shows windows natively when
    // `show` is not false, bypassing the patched show), so no rule can match
    // it and findClientByMarker can't see it. initialTitle re-freezes at
    // every map, so one hide + verified re-show with the marker title in
    // place fixes both. runShowAttempt brings the normal map verification +
    // retry loop (the flaky-remap recovery) to this path too.
    let visible = false;
    try { visible = !!win.isVisible(); } catch {}
    if (visible) {
      try { native.hide.call(win); } catch {}
      sleepSync(60);
      if (state.floating) syncPlacementRule(state);
      runShowAttempt(win, state, false);
    }
    return state;
  }

  function classify(win, state) {
    state.floatingExplicit = win && win._clawdWaylandFloating === true
      ? true
      : (win && win._clawdWaylandFloating === false ? false : null);
    state.floating = needsFloatingPlacement(win, state.floatingExplicit);
    state.pin = state.floating && !clientIsFocusable(win);
    state.wantsFocusOnMap = clientIsFocusable(win);
  }

  // Re-assert marker + current visible title on the NATIVE title, immediately
  // before a native show: initialTitle is frozen at map, so the marker has to
  // be there at that instant.
  function assertMarkerTitle(win, state) {
    try {
      const raw = native.getTitle.call(win);
      const composed = composeMarkerTitle(state.marker, stripMarkerTitle(state.marker, raw));
      if (composed !== raw) native.setTitle.call(win, composed);
    } catch {}
  }

  function refreshAddress(state) {
    const client = backend.findClientByMarker(state.marker, pid);
    if (client) {
      const addr = normalizeAddress(client.address);
      if (addr) state.address = addr;
      return client;
    }
    return null;
  }

  // Poll the compositor until this window is mapped. `j/clients` only lists
  // mapped windows, so presence is the ground truth — win.isVisible() reports
  // true even when the remap never landed.
  function waitForMap(state) {
    const deadline = Date.now() + verifyTimeoutMs;
    for (;;) {
      const client = refreshAddress(state);
      if (client) return client;
      if (Date.now() >= deadline) return null;
      sleepSync(verifyPollMs);
    }
  }

  // The show path: IDENTITY first, then placement rules → native show →
  // verify → retry.
  function showWithVerification(win, state, activating) {
    assertMarkerTitle(win, state);
    if (!state.floating) {
      // Ordinary window: no static rule to assert; still verify the map so a
      // dropped remap gets retried instead of leaving an invisible window
      // that isVisible() claims is on screen.
      runShowAttempt(win, state, activating);
      return;
    }
    syncPlacementRule(state);
    runShowAttempt(win, state, activating);
  }

  function runShowAttempt(win, state, activating) {
    for (let attempt = 0; ; attempt++) {
      state.inNativeShow = true;
      try {
        if (activating) native.show.call(win);
        else native.showInactive.call(win);
      } finally {
        state.inNativeShow = false;
      }
      state.shownOnce = true;
      const client = waitForMap(state);
      if (client) {
        // Static rules are the primary placement; nudge once more so a
        // window that mapped while our rule was stale still lands correctly.
        if (state.logical && state.address) {
          backend.moveWindow(state.address, state.logical.x, state.logical.y);
        }
        return;
      }
      // The recovery that measured 36/36: a real hide, a beat, then show.
      // Before retrying, look for an ALREADY-MAPPED toplevel of ours: an
      // adopted window that was visible under its pre-marker constructor
      // title is hidden and immediately re-shown by ensureAdopted(); that
      // remap lands, but its marker title is only created by the NEXT map, so
      // the marker lookup misses once and every retry then hides+shows a
      // window that keeps a frozen markerless title. Reporting "did not map"
      // there is a false negative on a client that is on screen right now.
      const live = findOwnClientWithoutMarker(state);
      if (live) {
        const addr = normalizeAddress(live.address);
        if (addr) state.address = addr;
        if (state.logical && state.address) {
          backend.moveWindow(state.address, state.logical.x, state.logical.y);
        }
        return;
      }
      if (attempt >= maxShowRetries) {
        onWarn(`Clawd: wayland shim — window #${state.markerId} did not map after ${attempt} retries`);
        return;
      }
      try { native.hide.call(win); } catch {}
      sleepSync(retryDelayMs);
    }
  }

  // A toplevel of ours on screen that carries no marker yet: the first map of
  // a window created with show:false freezes the constructor title
  // ("Electron") as initialTitle, and initialTitle never changes for that
  // toplevel. Candidates are scoped to our pid and to titles this app could
  // have produced; when several of our windows are up, the one without a
  // marker that is not claimed by another state wins (marker-less toplevels
  // are tracked in `claimedAddresses` once resolved).
  function findOwnClientWithoutMarker(state) {
    const list = typeof backend.clients === "function" ? backend.clients() : null;
    if (!Array.isArray(list)) return null;
    const candidates = list.filter((c) => {
      if (!c || c.pid !== pid) return false;
      const addr = normalizeAddress(c.address);
      if (!addr || claimedAddresses.has(addr)) return false;
      const title = String(c.initialTitle || c.title || "");
      return !title.includes(MARKER_PREFIX);
    });
    if (!candidates.length) return null;
    if (candidates.length === 1) {
      claimedAddresses.add(normalizeAddress(candidates[0].address));
      return candidates[0];
    }
    // Prefer the client whose size matches the logical rect this window asked
    // for; fall back to the first unclaimed one.
    const want = state && state.logical;
    const sized = want
      ? candidates.find((c) => {
        const s = Array.isArray(c.size) ? c.size : null;
        return s && Math.abs(s[0] - want.width) <= 1 && Math.abs(s[1] - want.height) <= 1;
      })
      : null;
    const picked = sized || candidates[0];
    claimedAddresses.add(normalizeAddress(picked.address));
    return picked;
  }

  // Logical position merged with the live native size. Size always comes from
  // the compositor — that half of the protocol works — so a resize the app
  // did not request is still reflected.
  function correctedBounds(state, nativeRect) {
    if (!state || !state.logical) return nativeRect;
    const width = nativeRect && Number.isFinite(nativeRect.width) && nativeRect.width > 0
      ? nativeRect.width : state.logical.width;
    const height = nativeRect && Number.isFinite(nativeRect.height) && nativeRect.height > 0
      ? nativeRect.height : state.logical.height;
    return { x: state.logical.x, y: state.logical.y, width, height };
  }

  // After a size change the compositor recenters the window, and a position
  // change never reaches it at all — either way the logical top-left has to
  // be re-asserted through the dispatcher. The placement RULE is not touched
  // here: its move/size effects are static (map-time only) and prepareShow()
  // re-syncs it from the current logical rect before every show, so syncing
  // per frame during roam/drag would be pure IPC waste.
  function pushPosition(win, state) {
    if (!state || !state.logical) return;
    if (!state.address) refreshAddress(state);
    if (state.address) {
      backend.moveWindow(state.address, state.logical.x, state.logical.y);
    }
  }

  // ── patched prototype methods ──

  proto.getBounds = function getBounds() {
    const state = ensureAdopted(this);
    return correctedBounds(state, native.getBounds.call(this));
  };

  proto.getPosition = function getPosition() {
    const state = ensureAdopted(this);
    if (state && state.logical) return [state.logical.x, state.logical.y];
    return native.getPosition.call(this);
  };

  proto.getContentBounds = function getContentBounds() {
    const state = ensureAdopted(this);
    return correctedBounds(state, native.getContentBounds.call(this));
  };

  proto.getNormalBounds = function getNormalBounds() {
    const state = ensureAdopted(this);
    if (state && state.normal) return { ...state.normal };
    const fallback = native.getNormalBounds
      ? native.getNormalBounds.call(this)
      : native.getBounds.call(this);
    return correctedBounds(state, fallback);
  };

  // Adoption point for title READS. A construction-time getTitle() sees a
  // native title Electron has not applied yet; adopting there would compose
  // the marker onto an empty string and lose the real title. Adoption is
  // therefore deferred to the next tick — still long before any show — and a
  // read that arrives in between is answered from the native title.
  proto.getTitle = function getTitle() {
    const state = states.get(this);
    if (!state && !deferredAdoption.has(this)) {
      deferredAdoption.add(this);
      setImmediate(() => {
        deferredAdoption.delete(this);
        if (!states.has(this)) ensureAdopted(this);
      });
    }
    return stripMarkerTitle(state && state.marker, native.getTitle.call(this));
  };

  proto.setTitle = function setTitle(title) {
    const state = states.get(this);
    if (!state) {
      // Before adoption the caller's title is applied verbatim (no marker).
      native.setTitle.call(this, title);
      return;
    }
    native.setTitle.call(this, composeMarkerTitle(state.marker, title));
  };

  proto.setBounds = function setBounds(bounds, animate) {
    const state = ensureAdopted(this);
    const next = roundRect(bounds);
    native.setBounds.call(this, bounds, animate);
    if (!state || !next) return;
    const prev = state.logical;
    const sizeChanged = !prev || prev.width !== next.width || prev.height !== next.height;
    const posChanged = !prev || prev.x !== next.x || prev.y !== next.y;
    state.logical = next;
    state.normal = { ...next };
    if (sizeChanged || posChanged) pushPosition(this, state, { sizeChanged });
  };

  proto.setPosition = function setPosition(x, y, animate) {
    const state = ensureAdopted(this);
    native.setPosition.call(this, x, y, animate);
    if (!state) return;
    const rx = round4(x);
    const ry = round4(y);
    if (!state.logical) {
      let width = 0; let height = 0;
      try { const s = native.getSize.call(this); width = s[0]; height = s[1]; } catch {}
      state.logical = { x: rx, y: ry, width, height };
    } else if (state.logical.x !== rx || state.logical.y !== ry) {
      state.logical = { ...state.logical, x: rx, y: ry };
    } else {
      return;
    }
    state.normal = { ...state.logical };
    pushPosition(this, state, {});
  };

  proto.setSize = function setSize(width, height, animate) {
    const state = ensureAdopted(this);
    native.setSize.call(this, width, height, animate);
    if (!state) return;
    const w = round4(width);
    const h = round4(height);
    if (state.logical) {
      if (state.logical.width === w && state.logical.height === h) return;
      state.logical = { ...state.logical, width: w, height: h };
    } else {
      state.logical = { x: 0, y: 0, width: w, height: h };
    }
    // Hyprland resizes around the center: re-anchor the top-left.
    pushPosition(this, state, { sizeChanged: true });
  };

  proto.setNormalBounds = function setNormalBounds(bounds, animate) {
    const state = ensureAdopted(this);
    if (native.setNormalBounds) native.setNormalBounds.call(this, bounds, animate);
    if (state) state.normal = roundRect(bounds);
  };

  proto.setContentBounds = function setContentBounds(bounds, animate) {
    // Every window this app creates on Linux is frameless, so the content
    // box and the window box are the same rect.
    this.setBounds(bounds, animate);
  };

  proto.show = function show() {
    const state = ensureAdopted(this);
    if (!state || state.inNativeShow) { native.show.call(this); return; }
    showWithVerification(this, state, true);
  };

  proto.showInactive = function showInactive() {
    const state = ensureAdopted(this);
    if (!state || state.inNativeShow) { native.showInactive.call(this); return; }
    showWithVerification(this, state, false);
  };

  proto.focus = function focus() {
    const state = ensureAdopted(this);
    native.focus.call(this);
    if (!state) return;
    refreshAddress(state);
    // Electron's activation request cannot focus a native Wayland toplevel;
    // the dispatcher is the only path that works (measured).
    if (state.address) backend.focusWindow(state.address);
  };

  proto.blur = function blur() {
    native.blur.call(this);
    // Hand keyboard focus back to whatever the user had before us — the
    // compositor's own "last window" is the right source of truth here.
    backend.focusLastWindow();
  };

  // THE click-through primitive on native Wayland. `no_focus` takes the
  // window out of Hyprland's hit test (ViewHitTester skips noFocus windows),
  // so pointer events fall through to whatever is below. Toggling the rule's
  // `enabled` flag flips live on a mapped window (measured), which is why the
  // rule is created once and switched rather than re-defined.
  proto.setIgnoreMouseEvents = function setIgnoreMouseEvents(ignore, forwardOptions) {
    const state = ensureAdopted(this);
    const want = !!ignore;
    if (!state) {
      if (native.setIgnoreMouseEvents) native.setIgnoreMouseEvents.call(this, ignore, forwardOptions);
      return;
    }
    if (want === state.clickThrough) return;
    state.clickThrough = want;
    if (!backend.available) {
      if (!warnNoClickThrough) {
        warnNoClickThrough = true;
        onWarn("Clawd: wayland shim — no Hyprland backend; click-through unavailable on this compositor");
      }
      return;
    }
    syncClickThroughRule(state, want);
  };

  // Electron's setAlwaysOnTop is a no-op on Wayland. float+pin already puts
  // these surfaces above tiled windows; raise within the floating layer for
  // the ordering the app asks for.
  proto.setAlwaysOnTop = function setAlwaysOnTop(flag, level, relativeLevel) {
    const state = ensureAdopted(this);
    native.setAlwaysOnTop.call(this, flag, level, relativeLevel);
    if (!state || !flag) return;
    refreshAddress(state);
    if (state.address) backend.raiseWindow(state.address);
  };

  // Re-create every rule we own. Hyprland clears its Lua rule registry on a
  // config reload (ConfigManager wipes m_luaWindowRules), which would
  // silently drop placement and click-through for every window.
  function reassertAllRules() {
    for (const [name, def] of definedRules) {
      try { backend.defineWindowRule(name, def.pattern, def.effects); } catch {}
    }
    // Placement effects are static: re-assert the live position too.
    // (Callers that can enumerate windows pass them in; otherwise the rules
    // alone are enough for the next map.)
  }

  installedShim = {
    reassertAllRules,
    // Explicit opt-in/opt-out of floating placement for focusable windows
    // (the 1×1 context-menu owner, permission bubbles) or for windows that
    // should stay the compositor's to place even though they are not
    // focusable.
    setFloatingPlacement(win, floating) {
      if (!isLiveWindow(win)) return false;
      try { win._clawdWaylandFloating = !!floating; } catch {}
      const state = ensureAdopted(win);
      if (!state) return false;
      classify(win, state);
      state.lastPlacementKey = "";
      syncPlacementRule(state);
      return true;
    },
    // Place an already-mapped window right now. Static rule effects only apply
    // at map time, so a window shown BEFORE the caller knew where it belongs
    // (the menu owner is shown, then moved to the cursor) needs this.
    placeWindow(win, rect) {
      if (!isLiveWindow(win)) return false;
      try { win._clawdWaylandFloating = true; } catch {}
      const state = ensureAdopted(win);
      if (!state) return false;
      const next = roundRect(rect);
      classify(win, state);
      if (next) {
        state.logical = next;
        state.normal = { ...next };
        if (!next.width || !next.height) {
          // Electron refuses 0-sized bounds; keep the live size.
          try {
            const live = native.getSize.call(win);
            if (live && live[0] > 0) state.logical.width = live[0];
            if (live && live[1] > 0) state.logical.height = live[1];
          } catch {}
        }
      }
      state.lastPlacementKey = "";
      syncPlacementRule(state);
      if (!state.address) refreshAddress(state);
      if (state.logical && state.address) {
        backend.moveWindow(state.address, state.logical.x, state.logical.y);
      }
      return true;
    },
    // Mark the window pinned/unpinned to all workspaces (the rule effect —
    // setVisibleOnAllWorkspaces() does nothing on Wayland).
    setPinnedAllWorkspaces(win, pinned) {
      if (!isLiveWindow(win)) return false;
      const state = ensureAdopted(win);
      if (!state) return false;
      state.pin = !!pinned;
      state.lastPlacementKey = "";
      syncPlacementRule(state);
      if (state.address) backend.setWindowPin(state.address, !!pinned);
      return true;
    },
    // Adopt a window eagerly (normally lazy, on the first patched call).
    adoptWindow(win) { return !!ensureAdopted(win); },
    // Diagnostics for tests.
    _states: states,
    _definedRules: definedRules,
    _native: native,
    _sleepSync: sleepSync,
  };
  return installedShim;
}

module.exports = {
  installLinuxWaylandWindowShim,
  needsFloatingPlacement,
  composeMarkerTitle,
  stripMarkerTitle,
  sleepSync,
};
