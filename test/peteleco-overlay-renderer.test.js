"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const RENDERER = fs.readFileSync(path.join(SRC_DIR, "peteleco-overlay-renderer.js"), "utf8");
const OVERLAY_HTML = fs.readFileSync(path.join(SRC_DIR, "peteleco-overlay.html"), "utf8");

// The projection is one dashed line and nothing else — the landing ring and
// arrowhead were removed on purpose, so this list is also the assertion that
// they stay gone.
const NODE_IDS = ["stage", "shaft-ink", "shaft-halo"];

class FakeNode {
  constructor(id) {
    this.id = id;
    this.attrs = {};
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)),
      contains: (c) => this.classList._set.has(c),
    };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  num(name) { return Number(this.attrs[name]); }
}

function createHarness() {
  const nodes = new Map(NODE_IDS.map((id) => [id, new FakeNode(id)]));
  const handlers = {};
  const context = {
    document: { getElementById: (id) => nodes.get(id) || null },
    window: {
      petelecoOverlayAPI: {
        onProjection: (cb) => { handlers.projection = cb; },
        onClear: (cb) => { handlers.clear = cb; },
        onFade: (cb) => { handlers.fade = cb; },
      },
    },
    console: { warn() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(RENDERER, context);
  return { nodes, draw: handlers.projection, clear: handlers.clear, fade: handlers.fade };
}

const SHOT = { from: { x: 200, y: 200 }, to: { x: 500, y: 200 }, power: 0.5, petSize: 100 };

describe("peteleco overlay renderer", () => {
  it("draws a single dashed line that ends exactly on the landing spot", () => {
    const h = createHarness();
    h.draw(SHOT);

    assert.ok(h.nodes.get("stage").classList.contains("is-visible"));

    const shaft = h.nodes.get("shaft-ink");
    // It starts clear of the pet so the sprite is not covered...
    assert.ok(shaft.num("x1") > SHOT.from.x, "shaft must clear the pet");
    // ...and now runs all the way to the target: with the ring gone, the end of
    // the line IS the answer to "where will it land".
    assert.strictEqual(shaft.num("x2"), SHOT.to.x);
    assert.strictEqual(shaft.num("y2"), SHOT.to.y);
    assert.strictEqual(shaft.num("y1"), 200);

    // The halo is wider than the ink it sits under, or a white line vanishes
    // against a white wallpaper.
    assert.ok(h.nodes.get("shaft-halo").num("stroke-width") > shaft.num("stroke-width"));
  });

  it("keeps the line white at every power, carrying strength on width alone", () => {
    const weak = createHarness();
    weak.draw({ ...SHOT, power: 0.1 });
    const strong = createHarness();
    strong.draw({ ...SHOT, power: 1 });

    assert.ok(
      strong.nodes.get("shaft-ink").num("stroke-width")
        > weak.nodes.get("shaft-ink").num("stroke-width")
    );
    // No hue channel at all: nothing may recolor the line by power.
    for (const h of [weak, strong]) {
      assert.strictEqual(h.nodes.get("stage").classList.contains("is-hot"), false);
      assert.strictEqual(h.nodes.get("shaft-ink").attrs.stroke, undefined);
    }
    assert.ok(!RENDERER.includes("is-hot"));
  });

  it("hides rather than drawing garbage for an unusable payload", () => {
    for (const bad of [
      null,
      {},
      { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
      { from: { x: NaN, y: 0 }, to: { x: 1, y: 1 } },
    ]) {
      const h = createHarness();
      h.draw(SHOT);
      h.draw(bad);
      assert.strictEqual(
        h.nodes.get("stage").classList.contains("is-visible"), false, JSON.stringify(bad)
      );
    }
  });

  it("collapses the shaft instead of reversing it when the shot is shorter than the pet", () => {
    const h = createHarness();
    h.draw({ from: { x: 200, y: 200 }, to: { x: 210, y: 200 }, power: 0.05, petSize: 100 });
    const shaft = h.nodes.get("shaft-ink");
    assert.ok(shaft.num("x2") >= shaft.num("x1"), "a backwards shaft would point at the wrong side");
    assert.ok(h.nodes.get("stage").classList.contains("is-visible"));
  });

  it("fades on release and clears outright on cancel", () => {
    const faded = createHarness();
    faded.draw(SHOT);
    faded.fade();
    const stage = faded.nodes.get("stage");
    assert.strictEqual(stage.classList.contains("is-fading"), true);
    assert.strictEqual(stage.classList.contains("is-visible"), false);

    const cleared = createHarness();
    cleared.draw(SHOT);
    cleared.clear();
    assert.strictEqual(cleared.nodes.get("stage").classList.contains("is-fading"), false);
    assert.strictEqual(cleared.nodes.get("stage").classList.contains("is-visible"), false);
  });

  it("a new gesture during a fade cancels it instead of inheriting the dissolve", () => {
    const h = createHarness();
    h.draw(SHOT);
    h.fade();
    h.draw(SHOT);
    assert.strictEqual(h.nodes.get("stage").classList.contains("is-fading"), false);
    assert.strictEqual(h.nodes.get("stage").classList.contains("is-visible"), true);
  });

  it("fading an empty overlay is a no-op", () => {
    const h = createHarness();
    h.fade();
    assert.strictEqual(h.nodes.get("stage").classList.contains("is-fading"), false);
  });

  it("keeps the page and the renderer agreed on which elements exist", () => {
    for (const id of NODE_IDS) {
      assert.ok(OVERLAY_HTML.includes(`id="${id}"`), `peteleco-overlay.html is missing #${id}`);
    }
    for (const gone of ["landing-ink", "landing-halo", "landing-fill", "tip-ink", "tip-halo"]) {
      assert.ok(!OVERLAY_HTML.includes(`id="${gone}"`), `#${gone} should have been removed`);
      assert.ok(!RENDERER.includes(gone), `the renderer still references ${gone}`);
    }
  });
});
