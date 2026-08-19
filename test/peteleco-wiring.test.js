"use strict";

// Peteleco spans main.js, the hit window, the pet-window runtime and roam. Each
// of those has its own behavioral test; what none of them can see is whether
// main.js still HANDS the pieces to each other. These are source assertions on
// exactly the joins that are silent when they break: a dropped protection
// predicate only shows up as the pet snapping back mid-flight on a real
// machine, and a dropped state-sync flag only as "the gesture does nothing".

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC_DIR = path.join(__dirname, "..", "src");
const read = (file) => fs.readFileSync(path.join(SRC_DIR, file), "utf8");

describe("peteleco wiring", () => {
  const main = read("main.js");

  it("constructs the runtime and its overlay window", () => {
    assert.ok(main.includes('require("./peteleco-overlay-window")'));
    assert.ok(main.includes('require("./peteleco")('));
    assert.ok(main.includes("const petelecoOverlay = createPetelecoOverlayWindow({"));
    assert.ok(main.includes("showProjection: (shot) => petelecoOverlay.show(shot)"));
    assert.ok(main.includes("hideProjection: () => petelecoOverlay.hide()"));
    assert.ok(main.includes("fadeProjection: () => petelecoOverlay.fadeOut()"));
    assert.ok(main.includes("petelecoOverlay.destroy();"), "the overlay must be torn down on quit");
  });

  it("anchors the projection on the avatar, through the existing theme mapping", () => {
    assert.ok(main.includes("getPetVisualCenter: (bounds) => petWindowRuntime.getPetVisualCenter(bounds)"));
    const runtime = read("pet-window-runtime.js");
    assert.ok(runtime.includes("petGeometryMain.getPetVisualCenter(bounds)"));
    const geometry = read("pet-geometry-main.js");
    // The center comes from the theme's own layout block — the same declaration
    // the accessory frames use — not from a peteleco-specific constant.
    assert.ok(geometry.includes("layout.centerX"));
    assert.ok(geometry.includes("getViewBoxPointScreen"));
    assert.ok(read("hit-geometry.js").includes("function getViewBoxPointScreen"));
  });

  it("keeps a shot on the display it started from", () => {
    // main forces the launch display's work area into the clamp; without the
    // second argument the clamp resolves a display from the target's centre.
    assert.ok(main.includes("clampPosition: (x, y, w, h, workArea) =>"));
    assert.ok(main.includes("clampToScreenVisual(x, y, w, h, workArea ? { workArea } : {})"));
    assert.ok(main.includes("getWorkAreaFor: (bounds) =>"));
    const runtime = read("peteleco.js");
    assert.ok(runtime.includes('call("getWorkAreaFor", bounds)'));
    // And the overlay follows: one display, never a spanning window.
    assert.ok(read("peteleco-overlay-window.js").includes("function resolveOverlayBounds(screen, from)"));
  });

  it("reclaims the overlay window under low-power idle mode", () => {
    assert.ok(main.includes("isLowPowerIdleMode: () => lowPowerIdleMode"));
    const overlay = read("peteleco-overlay-window.js");
    assert.ok(overlay.includes("function scheduleHiddenDestroy()"));
    // Same constant the HUD/Orbit windows reclaim on — one policy, not two.
    const hud = read("session-hud.js").match(/HIDDEN_WINDOW_DESTROY_MS\s*=\s*(\d+)/);
    const own = overlay.match(/HIDDEN_WINDOW_DESTROY_MS\s*=\s*(\d+)/);
    assert.ok(hud && own);
    assert.strictEqual(own[1], hud[1]);
  });

  it("hands the gesture's drag lock back before the shot is fired", () => {
    // The launch gates every frame on "did someone grab the pet?"; that gate is
    // only honest if the gesture's own lock is already gone.
    const ipc = read("pet-interaction-ipc.js");
    const handler = ipc.slice(ipc.indexOf('on("peteleco:aim-end"'));
    const unlock = handler.indexOf("setDragLocked(false)");
    const fire = handler.indexOf("petelecoReleaseAim()");
    assert.ok(unlock !== -1 && fire !== -1);
    assert.ok(unlock < fire);
    // And the runtime no longer carries the ordering heuristic it replaced.
    assert.ok(!read("peteleco.js").includes("inheritedDragLock"));
  });

  it("gives the flick the same reconcile protection roam has", () => {
    assert.ok(main.includes("isPetelecoAnimating: () => _peteleco.isFlicking()"));
    const runtime = read("pet-window-runtime.js");
    assert.ok(runtime.includes("options.isPetelecoAnimating || (() => false)"));
    assert.ok(/\|\|\s*isPetelecoAnimating\(\)/.test(runtime), "the protection branch must poll it");
  });

  it("stands roam down for the whole gesture, aim and flight", () => {
    assert.ok(main.includes("_roamCtx.isPetelecoActive = () => _peteleco.isActive();"));
    const roam = read("roam.js");
    assert.ok(roam.includes('typeof ctx.isPetelecoActive === "function" && ctx.isPetelecoActive()'));
  });

  it("routes the four aim channels from the hit window to the runtime", () => {
    const preload = read("preload-hit.js");
    const ipc = read("pet-interaction-ipc.js");
    for (const [method, channel] of [
      ["petelecoAimStart", "peteleco:aim-start"],
      ["petelecoAimMove", "peteleco:aim-move"],
      ["petelecoAimEnd", "peteleco:aim-end"],
      ["petelecoAimCancel", "peteleco:aim-cancel"],
    ]) {
      assert.ok(preload.includes(`${method}: () => ipcRenderer.send("${channel}")`), method);
      assert.ok(ipc.includes(`on("${channel}"`), channel);
    }
    assert.ok(main.includes("petelecoBeginAim: () => _peteleco.beginAim()"));
    assert.ok(main.includes("petelecoUpdateAim: () => _peteleco.updateAim()"));
    assert.ok(main.includes("petelecoReleaseAim: () => _peteleco.releaseAim()"));
    assert.ok(main.includes("petelecoCancelAim: () => _peteleco.cancelAim()"));
  });

  it("tells the hit window whether the gesture is armed, at load and on change", () => {
    // The hit renderer owns the "does this modifier drag aim?" decision, so it
    // needs the flag both in the initial sync and on every toggle.
    assert.ok(main.includes('petelecoEnabled: _settingsController.get("petelecoEnabled") === true'));
    assert.ok(main.includes('sendToHitWin("hit-state-sync", { petelecoEnabled: value === true })'));
    const hit = read("hit-renderer.js");
    assert.ok(hit.includes("data.petelecoEnabled !== undefined"));
  });

  it("follows both prefs at startup and on change", () => {
    assert.ok(main.includes('_peteleco.setEnabled(_settingsController.get("petelecoEnabled") === true)'));
    assert.ok(main.includes('_peteleco.setIntensity(_settingsController.get("petelecoIntensity"))'));
    assert.ok(main.includes('_settingsController.subscribeKey("petelecoEnabled"'));
    assert.ok(main.includes('_settingsController.subscribeKey("petelecoIntensity"'));
  });

  it("keeps the overlay page self-contained and script-locked", () => {
    const html = read("peteleco-overlay.html");
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes("script-src 'self'"));
    assert.ok(html.includes('src="./peteleco-overlay-renderer.js"'));
    assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline script in the overlay page");
  });

  it("routes the release fade from the runtime to the page", () => {
    const preload = read("preload-peteleco-overlay.js");
    assert.ok(preload.includes('ipcRenderer.on("peteleco:fade"'));
    assert.ok(preload.includes("onFade:"));
    assert.ok(read("peteleco-overlay-window.js").includes('send("peteleco:fade")'));
    assert.ok(read("peteleco-overlay-renderer.js").includes("onFade(fade)"));
  });
});
