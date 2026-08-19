"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createPetelecoOverlayWindow,
  resolveOverlayBounds,
} = require("../src/peteleco-overlay-window");
const { PETELECO_FADE_OUT_MS } = require("../src/peteleco-geometry");

const LEFT = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const RIGHT = { bounds: { x: 1920, y: 0, width: 1280, height: 1024 } };

function makeScreen(displays = [LEFT]) {
  return {
    getDisplayNearestPoint(point) {
      for (const display of displays) {
        const b = display.bounds;
        if (point.x >= b.x && point.x < b.x + b.width) return display;
      }
      return displays[0];
    },
  };
}

function makeBrowserWindowClass(log) {
  return class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.bounds = {
        x: options.x, y: options.y, width: options.width, height: options.height,
      };
      this.handlers = new Map();
      this.webContents = { send: (channel, payload) => log.sent.push([channel, payload]) };
      log.created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setIgnoreMouseEvents(value, opts) { log.ignoreMouse.push([value, opts]); }
    setFocusable(value) { log.focusable.push(value); }
    setAlwaysOnTop() {}
    loadFile(file) { log.loaded.push(file); }
    on(event, handler) { this.handlers.set(event, handler); }
    setBounds(next) { this.bounds = { ...next }; log.resized.push({ ...next }); }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; }
  };
}

function makeOverlay(displays = [LEFT], { lowPower = false } = {}) {
  const log = { created: [], sent: [], loaded: [], resized: [], ignoreMouse: [], focusable: [] };
  const state = { lowPower };
  // Hand-driven clock: the fade's hide is scheduled, and a test that waited on
  // a real timer would be a slow test that also cannot prove WHEN it fires.
  const timers = [];
  const overlay = createPetelecoOverlayWindow({
    BrowserWindow: makeBrowserWindowClass(log),
    screen: makeScreen(displays),
    keepOutOfTaskbar: () => {},
    isLowPowerIdleMode: () => state.lowPower,
    setTimeout: (cb, ms) => {
      const timer = { cb, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  });
  function runTimers() {
    for (const timer of timers.splice(0)) {
      if (!timer.cleared) timer.cb();
    }
  }
  return { overlay, log, timers, runTimers, state };
}

function shot(from, to, extra = {}) {
  return {
    from,
    to,
    power: 0.5,
    target: { x: to.x - 50, y: to.y - 50, width: 100, height: 100 },
    ...extra,
  };
}

describe("peteleco overlay geometry", () => {
  it("covers the display the shot was launched from", () => {
    const bounds = resolveOverlayBounds(makeScreen([LEFT, RIGHT]), { x: 100, y: 100 });
    assert.deepStrictEqual(bounds, LEFT.bounds);
    assert.deepStrictEqual(
      resolveOverlayBounds(makeScreen([LEFT, RIGHT]), { x: 2400, y: 300 }),
      RIGHT.bounds
    );
  });

  it("never stretches across monitors, even for a landing point on the neighbour", () => {
    // A window spanning two displays renders its CSS pixels at ONE scale
    // factor, so on a mixed-DPI desk the far half of the line lands in the
    // wrong place. The launch display is the whole answer; the runtime keeps
    // both ends of the shot on it by forcing the clamp onto its work area.
    const bounds = resolveOverlayBounds(makeScreen([LEFT, RIGHT]), { x: 1800, y: 500 });
    assert.deepStrictEqual(bounds, LEFT.bounds);
    assert.ok(bounds.width <= LEFT.bounds.width);
  });

  it("rejects an unusable launch point", () => {
    const screen = makeScreen([LEFT]);
    assert.strictEqual(resolveOverlayBounds(screen, null), null);
    assert.strictEqual(resolveOverlayBounds(screen, { x: NaN, y: 0 }), null);
    assert.strictEqual(resolveOverlayBounds(null, { x: 0, y: 0 }), null);
  });
});

describe("peteleco overlay window", () => {
  it("creates one click-through window and reuses it across gestures", () => {
    const { overlay, log } = makeOverlay();

    assert.strictEqual(overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 })), true);
    assert.strictEqual(log.created.length, 1);
    assert.deepStrictEqual(log.ignoreMouse, [[true, { forward: false }]]);
    assert.deepStrictEqual(log.focusable, [false]);
    assert.strictEqual(log.created[0].options.transparent, true);
    assert.strictEqual(log.created[0].options.skipTaskbar, true);
    assert.strictEqual(log.created[0].visible, true);

    overlay.hide();
    assert.strictEqual(log.created[0].visible, false);
    assert.strictEqual(log.created[0].isDestroyed(), false, "hidden, not destroyed");

    overlay.show(shot({ x: 900, y: 500 }, { x: 300, y: 500 }));
    assert.strictEqual(log.created.length, 1, "the window is reused");
    assert.strictEqual(log.created[0].visible, true);
  });

  it("converts the shot into window-local coordinates", () => {
    const { overlay, log } = makeOverlay([LEFT, RIGHT]);
    // Both ends on the right display: the window origin is x=1920, so the
    // renderer must receive coordinates relative to that.
    overlay.show(shot({ x: 2400, y: 300 }, { x: 2100, y: 300 }));

    const [channel, payload] = log.sent.find(([c]) => c === "peteleco:projection");
    assert.strictEqual(channel, "peteleco:projection");
    assert.deepStrictEqual(payload.from, { x: 480, y: 300 });
    assert.deepStrictEqual(payload.to, { x: 180, y: 300 });
    assert.strictEqual(payload.power, 0.5);
    assert.strictEqual(payload.petSize, 100);
  });

  it("resizes instead of recreating when the gesture moves to another display", () => {
    const { overlay, log } = makeOverlay([LEFT, RIGHT]);
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();
    overlay.show(shot({ x: 2400, y: 300 }, { x: 2100, y: 300 }));

    assert.strictEqual(log.created.length, 1);
    assert.deepStrictEqual(log.resized, [RIGHT.bounds]);
  });

  it("clears the stale line before hiding so the next gesture cannot flash it", () => {
    const { overlay, log } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();
    assert.ok(log.sent.some(([c]) => c === "peteleco:clear"));
  });

  it("ignores an unusable shot", () => {
    const { overlay, log } = makeOverlay();
    assert.strictEqual(overlay.show(null), false);
    assert.strictEqual(overlay.show({ from: { x: 1, y: 1 } }), false);
    assert.strictEqual(log.created.length, 0);
  });

  it("recreates the window after it was destroyed", () => {
    const { overlay, log } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.destroy();
    assert.strictEqual(log.created[0].isDestroyed(), true);
    assert.strictEqual(overlay.isVisible(), false);

    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    assert.strictEqual(log.created.length, 2);
    assert.strictEqual(log.created[1].visible, true);
  });
});

describe("peteleco overlay release fade", () => {
  it("dissolves the line and only then hides, on the shared fade clock", () => {
    const { overlay, log, timers, runTimers } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));

    assert.strictEqual(overlay.fadeOut(), true);
    assert.ok(log.sent.some(([c]) => c === "peteleco:fade"));
    // Still on screen: the line has to outlive the mouse-up and dissolve over
    // the launch instead of popping out.
    assert.strictEqual(log.created[0].visible, true);
    assert.strictEqual(overlay.isVisible(), true);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, PETELECO_FADE_OUT_MS);

    runTimers();
    assert.strictEqual(log.created[0].visible, false);
    assert.strictEqual(overlay.isVisible(), false);
  });

  it("the CSS transition and the hide timer run off the same duration", () => {
    // One decision written twice: a CSS fade longer than the timer gets cut off
    // mid-dissolve, and a shorter one leaves an invisible window up.
    const css = fs.readFileSync(
      path.join(__dirname, "..", "src", "peteleco-overlay.html"), "utf8"
    );
    const match = css.match(/#stage\.is-fading\s*\{[^}]*opacity\s+(\d+)ms/);
    assert.ok(match, "peteleco-overlay.html has no #stage.is-fading transition");
    assert.strictEqual(Number(match[1]), PETELECO_FADE_OUT_MS);
  });

  it("a new gesture during the fade takes the window back instead of being hidden under it", () => {
    const { overlay, log, runTimers } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.fadeOut();

    overlay.show(shot({ x: 900, y: 500 }, { x: 300, y: 500 }));
    runTimers(); // the fade's pending hide must have been cancelled
    assert.strictEqual(log.created[0].visible, true, "the new aim must survive the old fade");
    assert.strictEqual(overlay.isVisible(), true);
  });

  it("cancelling clears at once — a projection must not outlive a shot nobody fired", () => {
    const { overlay, log, timers } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();
    assert.strictEqual(log.created[0].visible, false);
    assert.strictEqual(timers.length, 0);
  });

  it("fading with nothing on screen falls back to a plain hide", () => {
    const { overlay, timers } = makeOverlay();
    assert.strictEqual(overlay.fadeOut(), false);
    assert.strictEqual(timers.length, 0);
  });

  it("destroy drops a pending fade", () => {
    const { overlay, log, timers, runTimers } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.fadeOut();
    overlay.destroy();
    assert.strictEqual(timers[0].cleared, true);
    runTimers();
    assert.strictEqual(log.created[0].isDestroyed(), true);
  });
});

describe("peteleco overlay window reclaim", () => {
  it("keeps the window warm by default — building one mid-gesture costs a frame", () => {
    const { overlay, log, timers, runTimers } = makeOverlay();
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();

    assert.strictEqual(timers.length, 0, "no reclaim is scheduled outside low-power mode");
    runTimers();
    assert.strictEqual(log.created[0].isDestroyed(), false);
  });

  it("hands the window back under low-power idle mode", () => {
    const { overlay, log, timers, runTimers } = makeOverlay([LEFT], { lowPower: true });
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();

    const reclaim = timers.find((t) => t.ms === 30000);
    assert.ok(reclaim, "low-power mode must schedule the reclaim");
    assert.strictEqual(log.created[0].isDestroyed(), false, "not before the delay");
    runTimers();
    assert.strictEqual(log.created[0].isDestroyed(), true);

    // And it comes back on demand.
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    assert.strictEqual(log.created.length, 2);
    assert.strictEqual(log.created[1].visible, true);
  });

  it("a new gesture before the delay cancels the reclaim", () => {
    const { overlay, log, runTimers } = makeOverlay([LEFT], { lowPower: true });
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.hide();
    overlay.show(shot({ x: 900, y: 500 }, { x: 300, y: 500 }));

    runTimers();
    assert.strictEqual(log.created[0].isDestroyed(), false, "an in-use window must survive");
    assert.strictEqual(log.created.length, 1);
  });

  it("leaving low-power mode while hidden spares the window", () => {
    // The flag is re-read when the timer fires, not captured when it is armed.
    const h = makeOverlay([LEFT], { lowPower: true });
    h.overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    h.overlay.hide();
    h.state.lowPower = false;
    h.runTimers();
    assert.strictEqual(h.log.created[0].isDestroyed(), false);
  });

  it("the release fade still reclaims once the dissolve is over", () => {
    const { overlay, log, runTimers } = makeOverlay([LEFT], { lowPower: true });
    overlay.show(shot({ x: 900, y: 500 }, { x: 600, y: 500 }));
    overlay.fadeOut();

    runTimers(); // fade completes -> hide() -> arms the reclaim
    assert.strictEqual(log.created[0].visible, false);
    assert.strictEqual(log.created[0].isDestroyed(), false);
    runTimers(); // reclaim
    assert.strictEqual(log.created[0].isDestroyed(), true);
  });
});
