"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const { MARKER_COLORS } = require("../src/niri-inspect-artifact");
const {
  createNiriPlacementInspect,
  matchesNiri2604Release,
  queryX11TitleCounts,
  resolveNiriInspectRequest,
} = require("../src/niri-placement-inspect");

function markerImage({ render = false, hit = false } = {}) {
  const width = 32;
  const height = 32;
  const bitmap = Buffer.alloc(width * height * 4);
  const paint = (colorName, x, y, regionWidth, regionHeight) => {
    const color = MARKER_COLORS[colorName];
    for (let py = y; py < y + regionHeight; py += 1) {
      for (let px = x; px < x + regionWidth; px += 1) {
        const offset = (py * width + px) * 4;
        bitmap[offset] = color[2];
        bitmap[offset + 1] = color[1];
        bitmap[offset + 2] = color[0];
        bitmap[offset + 3] = 255;
      }
    }
  };
  if (render) {
    paint("renderPrimary", 0, 0, 8, 8);
    paint("renderCorner", 4, 4, 4, 4);
  }
  if (hit) {
    paint("hitPrimary", 12, 0, 10, 3);
    paint("hitPrimary", 19, 0, 3, 10);
    paint("hitPrimary", 12, 7, 10, 3);
    paint("hitPrimary", 12, 0, 3, 10);
    paint("hitCorner", 12, 0, 4, 4);
  }
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
  };
}

function makeWindow(bounds, image, options = {}) {
  const win = new EventEmitter();
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.capturePage = async () => image;
  win.webContents = contents;
  win.bounds = { ...bounds };
  win.visible = options.visible !== false;
  win.title = "";
  win.isDestroyed = () => false;
  win.isVisible = () => win.visible;
  win.getBounds = () => ({ ...win.bounds });
  win.setTitle = (title) => { win.title = title; };
  win.showInactive = () => {
    win.visible = true;
    win.emit("show");
  };
  return win;
}

function makeScreen() {
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [{
    id: 1,
    scaleFactor: 1.25,
    workArea: { x: 0, y: 0, width: 1000, height: 800 },
  }];
  return screen;
}

describe("niri placement inspect", () => {
  it("is exact, default-off, and inspect-only at the static gate", () => {
    assert.deepStrictEqual(resolveNiriInspectRequest({ env: {}, argv: [], platform: "linux" }), {
      requested: false,
      enabled: false,
      reason: "default-off",
      stage: null,
    });
    assert.equal(resolveNiriInspectRequest({
      env: {
        CLAWD_WINDOW_PLACEMENT: "niri-ipc",
        CLAWD_NIRI_STAGE: "drag",
        CLAWD_DISABLE_EDGE_VIRTUALIZATION: "1",
        NIRI_SOCKET: "/run/niri.sock",
      },
      argv: ["--ozone-platform=x11"],
      platform: "linux",
    }).reason, "stage-drag-not-implemented");
    assert.equal(resolveNiriInspectRequest({
      env: {
        CLAWD_WINDOW_PLACEMENT: "niri-ipc",
        CLAWD_DISABLE_EDGE_VIRTUALIZATION: "1",
        NIRI_SOCKET: "/run/niri.sock",
      },
      argv: ["--ozone-platform=x11"],
      platform: "linux",
    }).enabled, true);
  });

  it("keeps the disabled runtime inert at every class-level entry point", async () => {
    const ipcMain = new EventEmitter();
    const screen = new EventEmitter();
    let clientFactories = 0;
    const logs = [];
    const visualLeases = [];
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    const hit = makeWindow(
      { x: 210, y: 220, width: 50, height: 60 },
      markerImage({ hit: true }),
    );
    const runtime = createNiriPlacementInspect({
      config: { enabled: false, requested: false, reason: "default-off", stage: null },
      ipcMain,
      screen,
      readyTimeoutMs: 1,
      clientFactory: () => { clientFactories += 1; return null; },
      logger: (line) => logs.push(line),
      setVisualLease: (active) => visualLeases.push(active),
    });

    runtime.registerIpc();
    runtime.attachRenderWindow(render);
    runtime.attachHitWindow(hit);
    const result = await runtime.start();

    assert.equal(runtime.shouldDeferHitMapping(), false);
    assert.equal(result, null);
    assert.equal(runtime.state, "off");
    assert.equal(runtime.started, false);
    assert.equal(clientFactories, 0);
    assert.deepStrictEqual(logs, []);
    assert.deepStrictEqual(visualLeases, []);
    assert.deepStrictEqual(ipcMain.eventNames(), []);
    assert.deepStrictEqual(screen.eventNames(), []);
    assert.deepStrictEqual(render.eventNames(), []);
    assert.deepStrictEqual(render.webContents.eventNames(), []);
    assert.deepStrictEqual(hit.eventNames(), []);
    assert.deepStrictEqual(hit.webContents.eventNames(), []);
    runtime.dispose();
  });

  it("accepts only the 26.04 release family", () => {
    assert.equal(matchesNiri2604Release("26.04"), true);
    assert.equal(matchesNiri2604Release("26.04 (8ed0da4)"), true);
    assert.equal(matchesNiri2604Release("26.04.2 (unknown commit)"), true);
    assert.equal(matchesNiri2604Release("26.04.2+git.abc"), false);
    assert.equal(matchesNiri2604Release("26.04 arbitrary suffix"), false);
    assert.equal(matchesNiri2604Release("26.05"), false);
    assert.equal(matchesNiri2604Release("niri 26.04"), false);
  });

  it("extracts only exact quoted X11 titles and their positive native sizes", async () => {
    const details = await queryX11TitleCounts(["Clawd niri render 1-1-0", "Clawd niri hit 1-1-0"], {
      execFile: async () => ({ stdout: [
        '     0x1 "Clawd niri render 1-1-0": ("clawd" "Clawd")  120x120+200+200  +200+200',
        '     0x2 "Clawd niri hit 1-1-0": ("clawd" "Clawd")  50x60+210+220  +210+220',
        '     0x3 "Clawd niri render 1-1-0 suffix": ("clawd" "Clawd")  1x1+0+0  +0+0',
      ].join("\n") }),
    });
    assert.deepStrictEqual(details["Clawd niri render 1-1-0"], {
      count: 1,
      sizes: [{ width: 120, height: 120 }],
    });
    assert.deepStrictEqual(details["Clawd niri hit 1-1-0"], {
      count: 1,
      sizes: [{ width: 50, height: 60 }],
    });
  });

  it("keeps reload identity tombstoned until did-finish-load", () => {
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    const runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      pid: 123,
      getRenderWindow: () => render,
    });
    runtime.attachRenderWindow(render);

    render.webContents.emit("did-start-loading");
    assert.equal(render.title, "Clawd niri render loading 123-1-1");
    let prevented = false;
    render.emit("page-title-updated", {
      preventDefault: () => { prevented = true; },
    }, "Clawd");
    assert.equal(prevented, true);
    assert.equal(render.title, "Clawd niri render loading 123-1-1");

    render.webContents.emit("did-finish-load");
    assert.equal(render.title, "Clawd niri render 123-1-1");
    runtime.dispose();
  });

  it("creates hit only after trusted render dwell and proves the positive marker oracle", async () => {
    const ipcMain = new EventEmitter();
    const screen = makeScreen();
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    let hit = null;
    let runtime = null;
    let hitCreates = 0;
    let tickStarts = 0;
    const leases = [];
    const logs = [];
    let cleanupCalls = 0;
    const fakeClient = {
      version: async () => "26.04 (8ed0da4)",
      windows: async () => [{
        id: 77,
        title: render.title,
        app_id: "clawd-on-desk",
        workspace_id: 3,
        is_floating: true,
        layout: {
          tile_pos_in_workspace_view: [200, 200],
          tile_size: [120, 120],
        },
      }],
      screenshotWindow: async () => true,
      close: () => {},
    };

    runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      ipcMain,
      screen,
      nativeImage: { createFromBuffer: () => markerImage({ render: true, hit: true }) },
      pid: 1234,
      pointerDwellMs: 1,
      pointerTimeoutMs: 100,
      readyTimeoutMs: 100,
      clientFactory: () => fakeClient,
      isTrustedEvent: (event, contents) => event.sender === contents,
      getRenderWindow: () => render,
      getHitWindow: () => hit,
      getExpectedHitBounds: () => ({ x: 210, y: 220, width: 50, height: 60 }),
      checkDynamicPrerequisites: () => ({ ok: true }),
      ensureHitWindow: () => {
        if (hit) return hit;
        hitCreates += 1;
        hit = makeWindow(
          { x: 210, y: 220, width: 50, height: 60 },
          markerImage({ hit: true }),
          { visible: false },
        );
        runtime.attachHitWindow(hit);
        queueMicrotask(() => {
          hit.webContents.emit("did-finish-load");
          ipcMain.emit("niri-inspect-renderer-ready", { sender: hit.webContents }, { role: "hit" });
        });
        return hit;
      },
      showDeferredHit: () => hit.showInactive(),
      startMainTick: () => { tickStarts += 1; },
      setVisualLease: (active) => leases.push(active),
      queryX11Titles: async (titles) => Object.fromEntries(titles.map((title) => [title, {
        count: 1,
        sizes: [{ width: 100, height: 100 }],
      }])),
      createCaptureTarget: () => ({ dir: "/tmp/hidden", filePath: "/tmp/hidden/capture.png" }),
      waitForCompletePng: async () => Buffer.from("complete"),
      cleanupCaptureTarget: () => { cleanupCalls += 1; },
      logger: (line) => {
        logs.push(line);
        if (line.includes("move the pointer")) {
          queueMicrotask(() => ipcMain.emit(
            "niri-inspect-render-pointer",
            { sender: render.webContents },
            { role: "render", inside: true, screenX: 240, screenY: 250 },
          ));
        }
      },
    });
    runtime.registerIpc();
    runtime.attachRenderWindow(render);
    render.webContents.emit("did-finish-load");
    ipcMain.emit("niri-inspect-renderer-ready", { sender: render.webContents }, { role: "render" });

    assert.equal(hit, null, "hit must not exist before the trusted hover");
    const result = await runtime.start();
    assert.equal(result.verdict, "parent-coupled-candidate");
    assert.equal(hitCreates, 1);
    assert.equal(hit.visible, true);
    assert.equal(tickStarts, 1);
    assert.deepStrictEqual(leases, [true, false]);
    assert.equal(result.markers.render, true);
    assert.equal(result.markers.hit, true);
    assert.equal(cleanupCalls, 1);
    assert.ok(logs.some((line) => line.includes("inspect artifact")));
    runtime.dispose();
  });

  it("does not promote a compositor capture that contains only the render marker", async () => {
    const ipcMain = new EventEmitter();
    const screen = makeScreen();
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    const hit = makeWindow(
      { x: 210, y: 220, width: 50, height: 60 },
      markerImage({ hit: true }),
      { visible: false },
    );
    let runtime = null;
    runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      ipcMain,
      screen,
      nativeImage: { createFromBuffer: () => markerImage({ render: true }) },
      pid: 1234,
      pointerDwellMs: 1,
      pointerTimeoutMs: 100,
      readyTimeoutMs: 100,
      clientFactory: () => ({
        version: async () => "26.04 (8ed0da4)",
        windows: async () => [{
          id: 77,
          title: render.title,
          app_id: "clawd-on-desk",
          workspace_id: 3,
          is_floating: true,
          layout: {
            tile_pos_in_workspace_view: [200, 200],
            tile_size: [120, 120],
          },
        }],
        screenshotWindow: async () => true,
        close: () => {},
      }),
      isTrustedEvent: (event, contents) => event.sender === contents,
      getRenderWindow: () => render,
      getHitWindow: () => hit,
      getExpectedHitBounds: () => ({ x: 210, y: 220, width: 50, height: 60 }),
      checkDynamicPrerequisites: () => ({ ok: true }),
      ensureHitWindow: () => hit,
      showDeferredHit: () => hit.showInactive(),
      startMainTick: () => {},
      queryX11Titles: async (titles) => Object.fromEntries(titles.map((title) => [title, {
        count: 1,
        sizes: [{ width: 100, height: 100 }],
      }])),
      createCaptureTarget: () => ({ dir: "/tmp/hidden", filePath: "/tmp/hidden/capture.png" }),
      waitForCompletePng: async () => Buffer.from("complete"),
      cleanupCaptureTarget: () => {},
      logger: (line) => {
        if (line.includes("move the pointer")) {
          queueMicrotask(() => ipcMain.emit(
            "niri-inspect-render-pointer",
            { sender: render.webContents },
            { role: "render", inside: true, screenX: 240, screenY: 250 },
          ));
        }
      },
    });
    runtime.registerIpc();
    runtime.attachRenderWindow(render);
    runtime.attachHitWindow(hit);
    render.webContents.emit("did-finish-load");
    hit.webContents.emit("did-finish-load");
    ipcMain.emit("niri-inspect-renderer-ready", { sender: render.webContents }, { role: "render" });
    ipcMain.emit("niri-inspect-renderer-ready", { sender: hit.webContents }, { role: "hit" });

    const result = await runtime.start();
    assert.equal(result.verdict, "unavailable");
    assert.equal(result.reason, "marker-oracle-ambiguous");
    runtime.dispose();
  });

  it("restores the legacy hit and tick after a zero-write pointer timeout", async () => {
    const ipcMain = new EventEmitter();
    const screen = makeScreen();
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    const hit = makeWindow(
      { x: 210, y: 220, width: 50, height: 60 },
      markerImage({ hit: true }),
      { visible: false },
    );
    let ensures = 0;
    let shows = 0;
    let ticks = 0;
    const runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      ipcMain,
      screen,
      pointerTimeoutMs: 5,
      readyTimeoutMs: 50,
      clientFactory: () => ({ version: async () => "26.04 (8ed0da4)", close: () => {} }),
      isTrustedEvent: (event, contents) => event.sender === contents,
      getRenderWindow: () => render,
      getHitWindow: () => hit,
      getExpectedHitBounds: () => ({ x: 210, y: 220, width: 50, height: 60 }),
      checkDynamicPrerequisites: () => ({ ok: true }),
      ensureHitWindow: () => { ensures += 1; return hit; },
      showDeferredHit: () => { shows += 1; hit.visible = true; },
      startMainTick: () => { ticks += 1; },
      logger: () => {},
    });
    runtime.registerIpc();
    runtime.attachRenderWindow(render);
    render.webContents.emit("did-finish-load");
    ipcMain.emit("niri-inspect-renderer-ready", { sender: render.webContents }, { role: "render" });

    const result = await runtime.start();
    assert.equal(result.verdict, "unavailable");
    assert.equal(result.reason, "pointer-handshake-timeout");
    assert.equal(ensures, 1);
    assert.equal(shows, 1);
    assert.equal(ticks, 1);
    runtime.dispose();
  });

  it("restores render click-through once even when legacy hit recovery is unsafe", () => {
    let missingTicks = 0;
    const missingRuntime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      ensureHitWindow: () => null,
      startMainTick: () => { missingTicks += 1; },
      logger: () => {},
    });
    missingRuntime._releaseToLegacy();
    missingRuntime._releaseToLegacy();
    assert.equal(missingTicks, 1);
    assert.equal(missingRuntime.legacyReleased, false);
    assert.equal(missingRuntime.legacyReleaseBlocked, true);

    const hit = makeWindow(
      { x: 0, y: 0, width: 10, height: 10 },
      markerImage({ hit: true }),
      { visible: false },
    );
    let geometryTicks = 0;
    let shows = 0;
    const geometryRuntime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      ensureHitWindow: () => hit,
      getExpectedHitBounds: () => ({ x: 100, y: 100, width: 10, height: 10 }),
      startMainTick: () => { geometryTicks += 1; },
      showDeferredHit: () => { shows += 1; },
      logger: () => {},
    });
    geometryRuntime._releaseToLegacy();
    geometryRuntime._releaseToLegacy();
    assert.equal(geometryTicks, 1);
    assert.equal(shows, 0);
    assert.equal(geometryRuntime.legacyReleaseBlocked, true);
  });

  it("does not issue a screenshot after the inspected generation is invalidated", async () => {
    const screen = makeScreen();
    const render = makeWindow(
      { x: 200, y: 200, width: 120, height: 120 },
      markerImage({ render: true }),
    );
    const hit = makeWindow(
      { x: 210, y: 220, width: 50, height: 60 },
      markerImage({ hit: true }),
    );
    let screenshots = 0;
    let targets = 0;
    let runtime = null;
    render.webContents.capturePage = async () => {
      runtime._invalidate("render-reload");
      return markerImage({ render: true });
    };
    runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      screen,
      getRenderWindow: () => render,
      getHitWindow: () => hit,
      checkDynamicPrerequisites: () => ({ ok: true }),
      clientFactory: () => null,
      createCaptureTarget: () => { targets += 1; return { dir: "/tmp/x", filePath: "/tmp/x/a.png" }; },
    });
    runtime.client = {
      screenshotWindow: async () => { screenshots += 1; },
    };

    await assert.rejects(
      runtime._inspectMarkers(77),
      (err) => err && err.code === "render-reload",
    );
    assert.equal(targets, 0);
    assert.equal(screenshots, 0);
  });

  it("stops topology polling as soon as its generation is invalidated", async () => {
    const screen = makeScreen();
    let titleQueries = 0;
    let runtime = null;
    runtime = createNiriPlacementInspect({
      config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
      screen,
      checkDynamicPrerequisites: () => ({ ok: true }),
      queryX11Titles: async () => { titleQueries += 1; return {}; },
    });
    runtime.client = {
      windows: async () => {
        runtime._invalidate("render-reload");
        return [];
      },
    };

    await assert.rejects(
      runtime._inspectTopology(),
      (err) => err && err.code === "render-reload",
    );
    assert.equal(titleQueries, 0);
  });

  it("rejects every invalid self-capture before requesting a compositor screenshot", async () => {
    const cases = [
      {
        name: "missing render marker",
        renderImage: markerImage(),
        hitImage: markerImage({ hit: true }),
        code: "render-marker-not-painted",
      },
      {
        name: "hit marker leaked into render self-capture",
        renderImage: markerImage({ render: true, hit: true }),
        hitImage: markerImage({ hit: true }),
        code: "render-marker-not-isolated",
      },
      {
        name: "missing hit marker",
        renderImage: markerImage({ render: true }),
        hitImage: markerImage(),
        code: "hit-marker-not-painted",
      },
      {
        name: "render marker leaked into hit self-capture",
        renderImage: markerImage({ render: true }),
        hitImage: markerImage({ render: true, hit: true }),
        code: "hit-marker-not-isolated",
      },
    ];

    for (const testCase of cases) {
      const screen = makeScreen();
      const render = makeWindow(
        { x: 200, y: 200, width: 120, height: 120 },
        testCase.renderImage,
      );
      const hit = makeWindow(
        { x: 210, y: 220, width: 50, height: 60 },
        testCase.hitImage,
      );
      let screenshots = 0;
      const runtime = createNiriPlacementInspect({
        config: { enabled: true, requested: true, socketPath: "/run/niri.sock", stage: "inspect" },
        screen,
        getRenderWindow: () => render,
        getHitWindow: () => hit,
        checkDynamicPrerequisites: () => ({ ok: true }),
      });
      runtime.client = {
        screenshotWindow: async () => { screenshots += 1; },
      };

      await assert.rejects(
        runtime._inspectMarkers(77),
        (err) => err && err.code === testCase.code,
        testCase.name,
      );
      assert.equal(screenshots, 0, testCase.name);
    }
  });
});
