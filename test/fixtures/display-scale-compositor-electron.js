"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const themeLoader = require("../../src/theme-loader");
const { createRendererConfigChannel } = require("../../src/renderer-config-channel");

const ROOT = path.join(__dirname, "..", "..");
const FILE = "clawd-idle-follow.svg";
const UNLISTED_FILE = "clawd-happy.svg";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForObject(win, file, { changed = false, sampled = false } = {}) {
  return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      const object = clawdEl;
      const doc = object && object.tagName === "OBJECT" && object.contentDocument;
      const root = doc && doc.documentElement;
      // A readable document can arrive before the renderer's sampling retry.
      if (!pendingNext && currentDisplayedSvg === ${JSON.stringify(file)} && root
        && (!${JSON.stringify(sampled)} || discreteSampledDocuments.has(doc))
        && (!${JSON.stringify(changed)} || object !== globalThis.__displayScalePreviousObject)) {
        resolve({ devicePixelRatio: window.devicePixelRatio, zoom: root.style.zoom, display: root.style.display });
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("SVG document did not settle: " + JSON.stringify({
          file: currentDisplayedSvg, pending: !!pendingNext, root: !!root,
          sampled: !!doc && discreteSampledDocuments.has(doc),
          changed: object !== globalThis.__displayScalePreviousObject,
          devicePixelRatio: window.devicePixelRatio,
        })));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  })`);
}

async function inspectGeometry(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const slot = _accessorySlots.head;
    if (!slot.assetReady || slot.payload.id !== "cowboy-hat") throw new Error("head accessory did not load");
    const doc = clawdEl.contentDocument;
    const root = doc.documentElement;
    const animations = doc.getAnimations();
    const sampledCount = animations.filter((animation) => animation.effect.getTiming().easing.includes("steps(")).length;
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 1000;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const context = getCurrentAccessoryContext("head");
    if (!context || !context.descriptor.followTarget) throw new Error("missing head follow target");
    const layout = computeFollowAccessoryLayout(context);
    const mediaBox = getMediaLayoutBox(context.media);
    if (!layout || !mediaBox) throw new Error("missing accessory layout");
    const matrix = layout.matrix;
    return {
      devicePixelRatio: window.devicePixelRatio,
      zoom: root.style.zoom,
      display: root.style.display,
      animationCount: animations.length,
      sampledCount,
      mediaBox,
      normalizedMatrix: [
        matrix.a * layout.width / mediaBox.width,
        matrix.b * layout.width / mediaBox.height,
        matrix.c * layout.height / mediaBox.width,
        matrix.d * layout.height / mediaBox.height,
        (matrix.e - mediaBox.x) / mediaBox.width,
        (matrix.f - mediaBox.y) / mediaBox.height,
      ],
    };
  })()`);
}

async function changePageZoom(win, factor) {
  await win.webContents.executeJavaScript("globalThis.__displayScalePreviousObject = clawdEl; true;");
  // Page zoom changes the effective scale and resolution media query, unlike
  // a CDP device-metrics override, so this exercises the renderer's listener.
  win.webContents.setZoomFactor(factor);
  return waitForObject(win, FILE, { changed: true, sampled: true });
}

async function main() {
  const profile = app.commandLine.getSwitchValue("user-data-dir");
  assert(profile && path.isAbsolute(profile), "fixture requires an isolated user-data directory");
  app.setPath("userData", profile);
  await app.whenReady();
  themeLoader.init(path.join(ROOT, "src"), app.getPath("userData"));
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const config = themeLoader.createThemeContext(theme).getRendererConfig();
  assert(config.rendering.discreteSampling[FILE], "fixture must use a sampled Clawd asset");
  assert(!config.rendering.discreteSampling[UNLISTED_FILE], "fixture control must not be sampled");
  config.idleDefaultVisual = FILE;
  config.petTintPayload = { id: "none", filter: "none" };
  config.accessorySlots = {
    themeId: "clawd",
    accessoryGeneration: 1,
    head: {
      supported: true,
      attachments: config.accessoryAttachments,
      payload: { id: "cowboy-hat", assetFile: "cowboy-hat.svg", aspect: 16 / 7, widthScale: 1, offsetY: 0 },
    },
    mouth: {
      supported: true,
      attachments: config.mouthAccessoryAttachments,
      payload: { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 },
    },
  };
  const rendererConfigChannel = createRendererConfigChannel({ ipcMain });
  rendererConfigChannel.setPetConfig(config);

  const win = new BrowserWindow({
    show: false,
    width: 220,
    height: 220,
    // A Windows frame takes a different share of the window at each scale, which
    // would change the viewport's shape and with it the fitted SVG.
    useContentSize: true,
    webPreferences: {
      preload: path.join(ROOT, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await win.loadFile(path.join(ROOT, "src", "index.html"));
    await waitForObject(win, FILE, { sampled: true });
    const snapshot = await inspectGeometry(win);
    await win.webContents.executeJavaScript(`swapToFile(${JSON.stringify(UNLISTED_FILE)}, "working", true);`);
    const unlisted = await waitForObject(win, UNLISTED_FILE);
    const zoomChanges = [];
    const scale = Number(process.env.CLAWD_ELECTRON_AUDIT_SCALE);
    if (scale === 1) {
      await win.webContents.executeJavaScript(`swapToFile(${JSON.stringify(FILE)}, "idle", true);`);
      await waitForObject(win, FILE, { sampled: true });
      zoomChanges.push(await changePageZoom(win, 1.5));
      zoomChanges.push(await changePageZoom(win, 1));
    }
    process.stdout.write(JSON.stringify({ displayScaleCompositor: true, ...snapshot, unlistedZoom: unlisted.zoom, zoomChanges }) + "\n");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error && error.stack || error);
    app.exit(1);
  });
