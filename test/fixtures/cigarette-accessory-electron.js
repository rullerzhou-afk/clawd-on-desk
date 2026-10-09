"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const themeLoader = require("../../src/theme-loader");

const HTML = path.join(__dirname, "cigarette-accessory-electron.html");
const ROOT = path.join(__dirname, "..", "..");
const PRODUCTION_HTML = path.join(ROOT, "src", "index.html");
const PRODUCTION_PRELOAD = path.join(ROOT, "src", "preload.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForObjects(win) {
  return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const objects = [document.getElementById("pet"), document.getElementById("cigarette")];
    const ready = () => objects.every((object) => object.contentDocument && object.contentDocument.documentElement);
    if (ready()) return resolve(true);
    const timer = setTimeout(() => reject(new Error("stacked object load timed out")), 5000);
    for (const object of objects) {
      object.addEventListener("load", () => {
        if (!ready()) return;
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    }
  })`);
}

async function assertProductionStack(win) {
  const layout = await win.webContents.executeJavaScript(`(() => {
    const pet = document.getElementById("pet");
    const cigarette = document.getElementById("cigarette");
    const petRoot = pet.contentDocument.documentElement;
    const cigaretteRoot = cigarette.contentDocument.documentElement;
    if (typeof petRoot.pauseAnimations === "function") petRoot.pauseAnimations();
    if (typeof cigaretteRoot.pauseAnimations === "function") cigaretteRoot.pauseAnimations();
    const outer = cigarette.getBoundingClientRect();
    const inner = cigaretteRoot.getBoundingClientRect();
    return {
      devicePixelRatio: window.devicePixelRatio,
      outer: { width: outer.width, height: outer.height },
      inner: { width: inner.width, height: inner.height },
    };
  })()`);
  const expectedScale = Number(process.env.CLAWD_ELECTRON_AUDIT_SCALE);
  assert(Number.isFinite(expectedScale) && expectedScale > 0, "missing expected display scale");
  assert(Math.abs(layout.devicePixelRatio - expectedScale) < 0.05,
    `Electron used devicePixelRatio ${layout.devicePixelRatio}, expected ${expectedScale}`);
  // The object viewport and embedded SVG root may be rounded on opposite sides
  // of a physical pixel. Compare in CSS pixels using one device pixel of
  // tolerance instead of forcing every audit to 1x.
  const roundingTolerance = (1 / layout.devicePixelRatio) + 0.01;
  assert(Math.abs(layout.outer.width - layout.inner.width) <= roundingTolerance,
    "cigarette SVG root did not fill object width within one device pixel");
  assert(Math.abs(layout.outer.height - layout.inner.height) <= roundingTolerance,
    "cigarette SVG root did not fill object height within one device pixel");

  await win.webContents.executeJavaScript(`document.getElementById("cigarette").style.visibility = "hidden"`);
  const baseline = await win.webContents.capturePage({ x: 60, y: 45, width: 1, height: 1 });
  await win.webContents.executeJavaScript(`document.getElementById("cigarette").style.visibility = "visible"`);
  const stacked = await win.webContents.capturePage({ x: 60, y: 45, width: 1, height: 1 });
  assert(
    baseline.toDataURL() === stacked.toDataURL(),
    "transparent mouth object canvas obscured the real pet layer beneath it"
  );
}

async function inspect(win, seconds) {
  return win.webContents.executeJavaScript(`(async () => {
    const object = document.getElementById("cigarette");
    const doc = object.contentDocument;
    const root = doc && doc.documentElement;
    if (!root || typeof root.setCurrentTime !== "function") {
      throw new Error("cigarette SVG timeline is unavailable");
    }
    root.pauseAnimations();
    root.setCurrentTime(${JSON.stringify(seconds)});
    await Promise.resolve();
    const rects = doc.querySelectorAll("rect");
    if (rects.length !== 5) throw new Error("unexpected cigarette rect structure");
    const style = (element) => doc.defaultView.getComputedStyle(element);
    const smokeMatrix = rects[2].getCTM();
    return {
      documentUrl: doc.URL,
      currentTime: root.getCurrentTime(),
      emberFill: style(rects[1]).fill,
      emberOpacity: Number(style(rects[1]).opacity),
      smokeOpacity: Number(style(rects[2]).opacity),
      smokeTransform: [smokeMatrix.a, smokeMatrix.b, smokeMatrix.c, smokeMatrix.d, smokeMatrix.e, smokeMatrix.f],
    };
  })()`);
}

async function assertProductionRendererBootsMouthObject() {
  themeLoader.init(path.join(ROOT, "src"), app.getPath("userData"));
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const config = themeLoader.createThemeContext(theme).getRendererConfig();
  config.idleDefaultVisual = "clawd-idle-follow.svg";
  config.petTintPayload = { id: "none", filter: "none" };
  config.accessorySlots = {
    themeId: "clawd",
    accessoryGeneration: 1,
    head: {
      supported: true,
      attachments: config.accessoryAttachments,
      payload: { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 },
    },
    mouth: {
      supported: true,
      attachments: config.mouthAccessoryAttachments,
      payload: {
        id: "cigarette",
        assetFile: "cigarette.svg",
        aspect: 5 / 9,
        widthScale: 1,
        offsetY: 0,
      },
    },
  };

  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      preload: PRODUCTION_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: [`--theme-config=${JSON.stringify(config)}`],
    },
  });
  try {
    await win.loadFile(PRODUCTION_HTML);
    const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        const slot = _accessorySlots.mouth;
        const object = document.getElementById("clawd-mouth-accessory");
        if (
          slot.assetReady
          && object.contentDocument
          && object.contentDocument.documentElement
          && getComputedStyle(object).display === "block"
          && getComputedStyle(object).visibility === "visible"
        ) {
          const rect = object.getBoundingClientRect();
          resolve({
            file: currentDisplayedSvg,
            assetFile: slot.assetFile,
            width: rect.width,
            height: rect.height,
            rootWidth: object.contentDocument.documentElement.getAttribute("width"),
            rootHeight: object.contentDocument.documentElement.getAttribute("height"),
          });
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(JSON.stringify({
            assetReady: slot.assetReady,
            assetSettled: slot.assetSettled,
            display: object.style.display,
            visibility: object.style.visibility,
            contentDocument: !!object.contentDocument,
          })));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    })`);
    assert(result.file === "clawd-idle-follow.svg", "production renderer did not settle on idle");
    assert(result.assetFile === "cigarette.svg", "production renderer selected the wrong mouth asset");
    assert(result.width > 0 && result.height > 0, "production renderer gave the cigarette an empty layout");
    assert(result.rootWidth === "100%" && result.rootHeight === "100%", "production cigarette root did not fill its object");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 160,
    height: 160,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadFile(HTML);
    await waitForObjects(win);
    await assertProductionStack(win);
    const start = await inspect(win, 0);
    const emberPeak = await inspect(win, 0.8);
    const smokeRise = await inspect(win, 1.6);

    assert(start.emberFill !== emberPeak.emberFill, "cigarette ember fill did not animate");
    assert(start.emberOpacity !== emberPeak.emberOpacity, "cigarette ember opacity did not animate");
    assert(
      start.smokeOpacity !== smokeRise.smokeOpacity
        || JSON.stringify(start.smokeTransform) !== JSON.stringify(smokeRise.smokeTransform),
      "cigarette smoke did not animate"
    );

    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const object = document.getElementById("cigarette");
      const timer = setTimeout(() => reject(new Error("cigarette re-entry timed out")), 5000);
      object.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
      object.data = "../../assets/accessories/cigarette.svg?_t=second";
    })`);
    const restarted = await inspect(win, 0);
    assert(restarted.documentUrl.includes("_t=second"), "cigarette re-entry kept the old document");
    assert(restarted.emberFill === start.emberFill, "cigarette re-entry did not restart the ember timeline");
    assert(restarted.smokeOpacity === start.smokeOpacity, "cigarette re-entry did not restart the smoke timeline");

    const timing = await win.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById("cigarette").contentDocument.documentElement;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      root.unpauseAnimations();
      await wait(120);
      root.pauseAnimations();
      const pausedAt = root.getCurrentTime();
      await wait(250);
      const heldAt = root.getCurrentTime();
      root.unpauseAnimations();
      let resumedAt = heldAt;
      let resumeWaitMs = 0;
      while (resumedAt - heldAt <= 0.1 && resumeWaitMs < 2000) {
        await wait(100);
        resumeWaitMs += 100;
        resumedAt = root.getCurrentTime();
      }
      return { pausedAt, heldAt, resumedAt, resumeWaitMs };
    })()`);
    assert(Math.abs(timing.heldAt - timing.pausedAt) < 0.03, "cigarette timeline advanced while paused");
    assert(timing.resumedAt - timing.heldAt > 0.1, "cigarette timeline did not resume");
    await assertProductionRendererBootsMouthObject();
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
