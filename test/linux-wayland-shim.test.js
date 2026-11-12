// test/linux-wayland-shim.test.js — Unit tests for src/linux-wayland-shim.js
// (native Wayland BaseWindow geometry & placement shim).
// Original work by xingguangcuican6666.
//
// The shim patches BaseWindow.prototype and talks to the Hyprland backend, so
// the tests drive a minimal fake BaseWindow class plus a recording fake
// backend. sleepSync/Atomics are exercised through the real code path but the
// fake backend maps windows instantly, so no test ever blocks.
"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const SHIM_PATH = require.resolve("../src/linux-wayland-shim");
const { MARKER_PREFIX } = require("../src/linux-wayland");

// Fresh module per test: installLinuxWaylandWindowShim is once-per-process.
function loadShim() {
  delete require.cache[SHIM_PATH];
  return require("../src/linux-wayland-shim");
}

// ── Fake BaseWindow ──
// Mirrors the measured Electron-41-on-Wayland behavior the shim compensates
// for: position writes are swallowed by the compositor (getBounds returns
// x=0,y=0 once "mapped"), size writes take effect, and show() only maps the
// window when the fake compositor says so.
function createFakeBaseWindowClass(compositor) {
  class FakeBaseWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this._destroyed = false;
      this._visible = false;
      this._title = options.title || "";
      this._rect = {
        x: Math.round(options.x || 0),
        y: Math.round(options.y || 0),
        width: Math.round(options.width || 100),
        height: Math.round(options.height || 100),
      };
      this._focusable = options.focusable !== false;
      this._focused = false;
      this._ignoreMouse = false;
      this._alwaysOnTop = false;
      this._nativeShowCount = 0;
      this._nativeHideCount = 0;
      if (options.show !== false) this.show();
    }
    isDestroyed() { return this._destroyed; }
    destroy() { this._destroyed = true; this._visible = false; }
    isVisible() { return this._visible; }
    isFocusable() { return this._focusable; }
    setFocusable(v) { this._focusable = !!v; }
    isFocused() { return this._focused; }
    getBounds() {
      // Compositor truth: position reads back 0,0 while mapped (measured).
      if (this._visible) return { x: 0, y: 0, width: this._rect.width, height: this._rect.height };
      return { ...this._rect };
    }
    setBounds(b) {
      this._rect = {
        x: Math.round(b.x), y: Math.round(b.y),
        width: Math.round(b.width), height: Math.round(b.height),
      };
      if (this._visible) compositor.maybeResize(this, this._rect);
    }
    getPosition() {
      return this._visible ? [0, 0] : [this._rect.x, this._rect.y];
    }
    setPosition(x, y) {
      this._rect.x = Math.round(x); this._rect.y = Math.round(y);
    }
    getSize() { return [this._rect.width, this._rect.height]; }
    setSize(w, h) {
      this._rect.width = Math.round(w); this._rect.height = Math.round(h);
      if (this._visible) compositor.maybeResize(this, this._rect);
    }
    getNormalBounds() { return { ...this._rect }; }
    setNormalBounds(b) { this._rect = { ...b }; }
    getContentBounds() { return this.getBounds(); }
    setContentBounds(b) { this.setBounds(b); }
    getTitle() { return this._title; }
    setTitle(t) { this._title = String(t); }
    show() {
      this._nativeShowCount += 1;
      this._visible = true;
      compositor.onNativeShow(this, true);
    }
    showInactive() {
      this._nativeShowCount += 1;
      this._visible = true;
      compositor.onNativeShow(this, false);
    }
    hide() {
      this._nativeHideCount += 1;
      this._visible = false;
      compositor.onNativeHide(this);
    }
    focus() { this._focused = true; }
    blur() { this._focused = false; }
    setIgnoreMouseEvents(v) { this._ignoreMouse = !!v; }
    setAlwaysOnTop(v) { this._alwaysOnTop = !!v; }
  }
  return FakeBaseWindow;
}

// The fake compositor decides when a window "maps" (becomes visible in
// j/clients). failFirstShows: N ⇒ the first N native shows of a window do
// not map, so the shim must retry. frozenInitialTitle: the map freezes a
// title WITHOUT the marker (a toplevel that mapped before adoption — its
// initialTitle never changes again).
function createFakeCompositor({ failFirstShows = 0, frozenInitialTitle = null } = {}) {
  const clients = new Map(); // win → { address, marker }
  const showCounts = new Map();
  const moves = [];
  const focus = [];
  const rules = new Map(); // name → { pattern, effects, enabled }
  let nextAddress = 0x1000;

  function markerOf(win) {
    // Read the NATIVE title field, not getTitle() — the patched getTitle()
    // strips the marker by design.
    const t = win._title;
    return typeof t === "string" && t.startsWith(MARKER_PREFIX) ? t : null;
  }

  return {
    moves, focus, rules, clients,
    onNativeShow(win) {
      const count = (showCounts.get(win) || 0) + 1;
      showCounts.set(win, count);
      const marker = markerOf(win);
      if (!marker) return; // never maps without a marker title
      if (count <= failFirstShows) return; // simulate the dropped remap
      clients.set(win, {
        address: `0x${(nextAddress++).toString(16)}`,
        initialTitle: frozenInitialTitle == null ? marker : frozenInitialTitle,
        title: marker,
        pid: process.pid,
        mapped: true,
      });
    },
    onNativeHide(win) { clients.delete(win); },
    maybeResize(win, rect) {
      const client = clients.get(win);
      if (client) { client.size = [rect.width, rect.height]; }
    },
    // ── fake backend (same surface as createHyprlandBackend) ──
    backend: {
      available: true,
      // The backend's JSON query (see linux-wayland queryJson): same data.
      clients() { return Array.from(clients.values()).map((c) => ({ ...c })); },
      findClientByMarker(marker, pid) {
        for (const [win, c] of clients) {
          if (c.pid === pid && String(c.initialTitle).startsWith(marker)) return c;
          if (c.pid === pid && String(c.title).startsWith(marker)) return c;
        }
        return null;
      },
      moveWindow(address, x, y) { moves.push({ address, x, y }); return true; },
      focusWindow(address) { focus.push({ op: "focus", address }); return true; },
      focusLastWindow() { focus.push({ op: "focusLast" }); return true; },
      setWindowPin(address, pin) { focus.push({ op: "pin", address, pin }); return true; },
      raiseWindow(address) { focus.push({ op: "raise", address }); return true; },
      defineWindowRule(name, pattern, effects) {
        rules.set(name, { pattern, effects: { ...effects }, enabled: true });
        return true;
      },
      setWindowRuleEnabled(name, enabled) {
        const rule = rules.get(name);
        if (rule) rule.enabled = enabled;
        else rules.set(name, { pattern: null, effects: {}, enabled });
        return true;
      },
    },
  };
}

let BaseWindow;
let compositor;
let shim;

function install(options = {}) {
  compositor = createFakeCompositor(options.compositor || {});
  BaseWindow = createFakeBaseWindowClass(compositor);
  const { installLinuxWaylandWindowShim } = loadShim();
  shim = installLinuxWaylandWindowShim({
    BaseWindow,
    backend: compositor.backend,
    verifyTimeoutMs: 60,
    verifyPollMs: 5,
    maxShowRetries: 3,
    retryDelayMs: 1,
    onWarn: () => {},
    ...options,
  });
  return shim;
}

beforeEach(() => {
  // Reset the module-level installedShim by re-requiring fresh.
  install();
});

describe("installLinuxWaylandWindowShim()", () => {
  it("returns null without a backend or BaseWindow", () => {
    const { installLinuxWaylandWindowShim } = loadShim();
    assert.equal(installLinuxWaylandWindowShim({}), null);
    assert.equal(installLinuxWaylandWindowShim({ BaseWindow, backend: { available: false } }), null);
  });

  it("marker title: adopted windows carry Clawd + zero-width marker; getTitle strips it", async () => {
    const w = new BaseWindow({ show: false, title: "Settings" });
    // A title read before adoption defers adoption to the next tick (a
    // constructor-time read sees no title yet — see proto.getTitle).
    w.getTitle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(w.getTitle(), "Settings"); // patched getTitle strips the marker
    // The native title keeps marker + visible
    const nativeTitle = shim._native.getTitle.call(w);
    assert.ok(nativeTitle.startsWith(MARKER_PREFIX), JSON.stringify(nativeTitle));
    assert.ok(nativeTitle.endsWith("Settings"));
  });

  it("page-title-updated is prevented on the WINDOW object", async () => {
    const w = new BaseWindow({ show: false });
    w.getTitle(); // adopt (on the next tick)
    await new Promise((resolve) => setImmediate(resolve));
    let prevented = false;
    w.emit("page-title-updated", { preventDefault: () => { prevented = true; } }, false);
    assert.equal(prevented, true);
  });

  it("setTitle composes the marker and survives repeated sets", async () => {
    const w = new BaseWindow({ show: false, title: "A" });
    w.getTitle(); // adopt (on the next tick)
    await new Promise((resolve) => setImmediate(resolve));
    w.setTitle("B");
    w.setTitle("C");
    const nativeTitle = shim._native.getTitle.call(w);
    assert.equal(nativeTitle.indexOf(MARKER_PREFIX), 0);
    assert.equal(nativeTitle.slice(-1), "C");
    assert.equal(w.getTitle(), "C");
  });
});

describe("logical geometry truth", () => {
  it("getBounds returns the requested position merged with live size after map", () => {
    const w = new BaseWindow({ show: false, x: 111, y: 222, width: 300, height: 200, focusable: false });
    w.getBounds(); // adopt pre-show
    w.showInactive();
    // native getBounds would say x=0,y=0 while visible — the shim must not
    const b = w.getBounds();
    assert.equal(b.x, 111);
    assert.equal(b.y, 222);
    assert.equal(b.width, 300);
    assert.equal(b.height, 200);
  });

  it("getPosition returns the logical position, not compositor 0,0", () => {
    const w = new BaseWindow({ show: false, x: 33, y: 44, focusable: false });
    w.getPosition();
    w.showInactive();
    assert.deepEqual(w.getPosition(), [33, 44]);
  });

  it("setBounds records logical truth, pushes a compositor move and updates rules", () => {
    const w = new BaseWindow({ show: false, x: 0, y: 0, width: 100, height: 100, focusable: false });
    w.getBounds();
    w.showInactive();
    compositor.moves.length = 0;
    w.setBounds({ x: 400, y: 300, width: 100, height: 100 });
    assert.deepEqual(w.getBounds(), { x: 400, y: 300, width: 100, height: 100 });
    assert.equal(compositor.moves.length, 1);
    assert.deepEqual({ x: compositor.moves[0].x, y: compositor.moves[0].y }, { x: 400, y: 300 });
  });

  it("setSize updates logical size and re-anchors the top-left (center-resize compensation)", () => {
    const w = new BaseWindow({ show: false, x: 100, y: 100, width: 100, height: 100, focusable: false });
    w.getBounds();
    w.showInactive();
    compositor.moves.length = 0;
    w.setSize(200, 100);
    assert.deepEqual(w.getSize(), [200, 100]);
    const b = w.getBounds();
    assert.equal(b.x, 100);
    assert.equal(b.y, 100);
    assert.equal(b.width, 200);
    assert.ok(compositor.moves.length >= 1, "top-left must be re-pushed after a size change");
    assert.equal(compositor.moves[compositor.moves.length - 1].x, 100);
  });

  it("getNormalBounds tracks setBounds instead of the stale native rect", () => {
    const w = new BaseWindow({ show: false, x: 5, y: 6, width: 70, height: 80, focusable: false });
    w.getBounds();
    w.setBounds({ x: 50, y: 60, width: 70, height: 80 });
    assert.deepEqual(w.getNormalBounds(), { x: 50, y: 60, width: 70, height: 80 });
  });
});

describe("placement rules (floating surfaces)", () => {
  it("non-focusable windows get a float+pin placement rule created before show", () => {
    const w = new BaseWindow({ show: false, x: 210, y: 130, width: 64, height: 64, focusable: false });
    w.getBounds();
    w.showInactive();
    const placement = [...compositor.rules.entries()].find(([n]) => n.includes("place-"));
    assert.ok(placement, "placement rule must exist");
    const [, rule] = placement;
    assert.equal(rule.effects.float, true);
    assert.equal(rule.effects.pin, true);
    assert.equal(rule.effects.no_initial_focus, true);
    assert.deepEqual(rule.effects.move, [210, 130]);
    assert.deepEqual(rule.effects.size, [64, 64]);
    assert.ok(rule.pattern.startsWith("^Clawd"));
  });

  it("focusable windows get NO placement rule by default (compositor places them)", () => {
    const w = new BaseWindow({ show: false, x: 10, y: 10, width: 400, height: 300 });
    w.getBounds();
    w.showInactive();
    const placement = [...compositor.rules.keys()].find((n) => n.includes("place-"));
    assert.equal(placement, undefined);
  });

  it("setFloatingPlacement(true) opts a focusable window into rule placement", () => {
    const w = new BaseWindow({ show: false, x: 10, y: 10, width: 1, height: 1 });
    w.getBounds();
    shim.setFloatingPlacement(w, true);
    w.showInactive();
    const placement = [...compositor.rules.keys()].find((n) => n.includes("place-"));
    assert.ok(placement);
  });

  it("placement rule move/size re-sync before the NEXT show, not per frame", () => {
    const w = new BaseWindow({ show: false, x: 0, y: 0, width: 50, height: 50, focusable: false });
    w.getBounds();
    w.showInactive();
    const ruleName = [...compositor.rules.keys()].find((n) => n.includes("place-"));
    assert.deepEqual(compositor.rules.get(ruleName).effects.move, [0, 0]);
    // Runtime moves go through the dispatcher only — the static rule is for
    // map-time placement and must NOT churn on every setBounds (roam/drag
    // call it per frame).
    w.setBounds({ x: 90, y: 80, width: 50, height: 50 });
    assert.deepEqual(compositor.rules.get(ruleName).effects.move, [0, 0]);
    assert.ok(compositor.moves.some((m) => m.x === 90 && m.y === 80));
    // The next hide/show re-asserts the rule from the current logical rect.
    w.hide();
    w.showInactive();
    assert.deepEqual(compositor.rules.get(ruleName).effects.move, [90, 80]);
  });

  it("reassertAllRules re-defines every recorded rule (config-reload recovery)", () => {
    const w = new BaseWindow({ show: false, x: 0, y: 0, width: 50, height: 50, focusable: false });
    w.getBounds();
    w.showInactive();
    w.setIgnoreMouseEvents(true);
    const names = [...compositor.rules.keys()];
    assert.ok(names.some((n) => n.includes("place-")));
    assert.ok(names.some((n) => n.includes("click-")));
    compositor.rules.clear(); // simulate hyprland config reload wiping Lua rules
    shim.reassertAllRules();
    for (const name of names) {
      assert.ok(compositor.rules.has(name), `rule ${name} must be re-asserted`);
    }
  });
});

describe("click-through (setIgnoreMouseEvents → no_focus rule)", () => {
  it("toggles a dedicated no_focus rule instead of calling the native no-op", () => {
    const w = new BaseWindow({ show: false, focusable: false });
    w.getBounds();
    w.showInactive();
    w.setIgnoreMouseEvents(true);
    const clickRule = [...compositor.rules.entries()].find(([n]) => n.includes("click-"));
    assert.ok(clickRule, "click rule must exist");
    assert.equal(clickRule[1].effects.no_focus, true);
    assert.equal(clickRule[1].enabled, true);
    w.setIgnoreMouseEvents(false);
    assert.equal(compositor.rules.get(clickRule[0]).enabled, false);
    w.setIgnoreMouseEvents(false); // dedupe: no extra flip recorded
    assert.equal(compositor.rules.get(clickRule[0]).enabled, false);
  });

  it("the native setIgnoreMouseEvents is NOT relied on for state", () => {
    const w = new BaseWindow({ show: false, focusable: false });
    w.getBounds();
    w.setIgnoreMouseEvents(true);
    // Fake native flag stays false — the shim routes to the rule instead.
    assert.equal(w._ignoreMouse, false);
  });
});

describe("show reliability", () => {
  it("retries hide+show when the first map drops, then succeeds", () => {
    install({ compositor: { failFirstShows: 1 } });
    const w = new BaseWindow({ show: false, focusable: false });
    w.getBounds();
    w.showInactive();
    // The fake compositor dropped the first show; the shim must have hidden
    // and shown again until the window appeared in j/clients.
    assert.ok(w._nativeShowCount >= 2, `expected retries, got ${w._nativeShowCount} shows`);
    assert.ok(compositor.clients.has(w), "window must end up mapped");
  });

  it("gives up with a warning after maxShowRetries", () => {
    const warnings = [];
    install({ compositor: { failFirstShows: 99 }, onWarn: (m) => warnings.push(m) });
    const w = new BaseWindow({ show: false, focusable: false });
    w.getBounds();
    w.showInactive();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /did not map/);
  });

  it("post-map position correction pushes the logical rect via dispatcher", () => {
    const w = new BaseWindow({ show: false, x: 123, y: 456, width: 40, height: 40, focusable: false });
    w.getBounds();
    compositor.moves.length = 0;
    w.showInactive();
    const last = compositor.moves[compositor.moves.length - 1];
    assert.ok(last, "a post-map move must be dispatched");
    assert.deepEqual({ x: last.x, y: last.y }, { x: 123, y: 456 });
  });
});

describe("marker-free toplevels (mapped before adoption)", () => {
  it("a markerless initialTitle is still recognised as ours, without the false warning", () => {
    const warnings = [];
    install({ compositor: { frozenInitialTitle: "Electron" }, onWarn: (m) => warnings.push(m) });
    // A window whose constructor title is Electron's own (the app's windows
    // rely on the marker and a real title after the page loads).
    const w = new BaseWindow({ show: false, title: "Electron", x: 10, y: 20, width: 30, height: 40, focusable: false });
    w.setBounds({ x: 10, y: 20, width: 30, height: 40 }); // adopt
    w.showInactive();
    assert.deepEqual(warnings, [], "an on-screen client must not be reported as missing");
    // The placement pattern list covers the constructor title as well, so the
    // rule can match a toplevel whose initialTitle is still "Electron".
    const patterns = Array.from(compositor.rules.values()).map((r) => r.pattern);
    assert.ok(patterns.includes("^Electron$"), JSON.stringify(patterns));
  });

  it("another app's Electron window is never claimed twice", () => {
    install({
      compositor: { frozenInitialTitle: "Electron" },
    });
    // Two windows of ours, both markerless in the fake: each resolves to a
    // DIFFERENT client, never the same one twice.
    const a = new BaseWindow({ show: false, title: "Electron", width: 11, height: 11, focusable: false });
    const b = new BaseWindow({ show: false, title: "Electron", width: 22, height: 22, focusable: false });
    a.setBounds({ x: 1, y: 1, width: 11, height: 11 });
    b.setBounds({ x: 2, y: 2, width: 22, height: 22 });
    a.showInactive();
    b.showInactive();
    const stubs = shim._states.get(a);
    const stubb = shim._states.get(b);
    assert.ok(stubs.address);
    assert.ok(stubb.address);
    assert.notEqual(stubs.address, stubb.address);
  });
});

describe("live placement (placeWindow)", () => {
  it("moves an already-mapped owner without waiting for the next map", () => {
    const w = new BaseWindow({ show: false, x: 0, y: 0, width: 1, height: 1, focusable: true });
    w.getBounds();
    w.show();
    compositor.moves.length = 0;
    shim.placeWindow(w, { x: 640, y: 480, width: 1, height: 1 });
    const last = compositor.moves[compositor.moves.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 640, y: 480 });
    assert.deepEqual(w.getPosition(), [640, 480]);
    const placement = Array.from(compositor.rules.values()).find((r) => r.effects.float);
    assert.deepEqual(placement.effects.move, [640, 480]);
  });
});

describe("focus/blur", () => {
  it("focus() dispatches compositor focus on the window address", () => {
    const w = new BaseWindow({ show: false });
    w.getBounds();
    w.showInactive();
    compositor.focus.length = 0;
    w.focus();
    const op = compositor.focus.find((f) => f.op === "focus");
    assert.ok(op, "compositor focus must be dispatched");
    assert.ok(op.address.startsWith("0x"));
  });

  it("blur() hands focus back to the compositor's last window", () => {
    const w = new BaseWindow({ show: false });
    w.getBounds();
    w.showInactive();
    compositor.focus.length = 0;
    w.blur();
    assert.ok(compositor.focus.some((f) => f.op === "focusLast"));
  });

  it("setAlwaysOnTop(true) raises the window in the compositor z-order", () => {
    const w = new BaseWindow({ show: false, focusable: false });
    w.getBounds();
    w.showInactive();
    compositor.focus.length = 0;
    w.setAlwaysOnTop(true, "screen-saver");
    assert.ok(compositor.focus.some((f) => f.op === "raise"));
  });
});

describe("pure helpers", () => {
  it("needsFloatingPlacement: focusable=false floats; explicit flags win", () => {
    const { needsFloatingPlacement } = loadShim();
    assert.equal(needsFloatingPlacement({ isFocusable: () => false }, null), true);
    assert.equal(needsFloatingPlacement({ isFocusable: () => true }, null), false);
    assert.equal(needsFloatingPlacement({ isFocusable: () => true }, true), true);
    assert.equal(needsFloatingPlacement({ isFocusable: () => false }, false), false);
    assert.equal(needsFloatingPlacement({}, null), false); // no API → false
  });

  it("composeMarkerTitle is idempotent; stripMarkerTitle is its inverse", () => {
    const { composeMarkerTitle, stripMarkerTitle } = loadShim();
    const marker = "Clawd​‌";
    assert.equal(composeMarkerTitle(marker, "X"), marker + "X");
    assert.equal(composeMarkerTitle(marker, marker + "X"), marker + "X");
    assert.equal(composeMarkerTitle(marker, undefined), marker);
    assert.equal(stripMarkerTitle(marker, marker + "X"), "X");
    assert.equal(stripMarkerTitle(marker, "X"), "X");
    assert.equal(stripMarkerTitle(null, "X"), "X");
  });

  it("sleepSync returns immediately for non-positive values", () => {
    const { sleepSync } = loadShim();
    const t0 = Date.now();
    sleepSync(0);
    sleepSync(-5);
    assert.ok(Date.now() - t0 < 50);
  });
});
