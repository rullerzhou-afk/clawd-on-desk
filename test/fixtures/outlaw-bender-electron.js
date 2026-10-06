"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const HTML = path.join(__dirname, "outlaw-bender-electron.html");
const REQUIRED_ANIMATIONS = [
  "bd-topple",
  "bd-sway",
  "bd-droop",
  "bd-swig",
  "bd-shadow",
  "bd-ember",
  "bd-rise",
  "bd-float",
];

async function waitForObject(win) {
  return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const object = document.getElementById("bender");
    const ready = () => {
      try {
        if (object.contentDocument && object.contentDocument.documentElement) return resolve(true);
      } catch (error) {
        return reject(error);
      }
      return false;
    };
    if (ready()) return;
    const timer = setTimeout(() => reject(new Error("bender object load timed out")), 5000);
    object.addEventListener("load", () => {
      clearTimeout(timer);
      if (!ready()) reject(new Error("bender object loaded without a document"));
    }, { once: true });
  })`);
}

async function inspect(win, timeMs) {
  return win.webContents.executeJavaScript(`(async () => {
    const object = document.getElementById("bender");
    const doc = object.contentDocument;
    if (!doc) throw new Error("missing bender SVG document");
    const animations = doc.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = ${JSON.stringify(timeMs)};
    }
    // Setting Web Animations currentTime is synchronous; a style/layout read
    // below flushes the sampled frame without relying on throttled hidden-window rAF.
    await Promise.resolve();
    const style = (selector) => doc.defaultView.getComputedStyle(doc.querySelector(selector));
    const rootBounds = doc.documentElement.getBoundingClientRect();
    const rectBounds = [...doc.querySelectorAll("rect")].map((rect) => rect.getBoundingClientRect());
    const artBounds = {
      left: Math.min(...rectBounds.map((rect) => rect.left)),
      top: Math.min(...rectBounds.map((rect) => rect.top)),
      right: Math.max(...rectBounds.map((rect) => rect.right)),
      bottom: Math.max(...rectBounds.map((rect) => rect.bottom)),
    };
    return {
      names: animations.map((animation) => animation.animationName),
      master: style(".bd-master").transform,
      sway: style(".bd-sway").transform,
      eyes: style(".bd-eyes").transform,
      bottle: style(".bd-bottle").transform,
      shadow: style(".bd-shadow").transform,
      emberFill: style(".bd-ember").fill,
      smokeOpacity: Number(style(".bd-s1").opacity),
      zOpacity: Number(style(".bd-z1").opacity),
      rootBounds: {
        left: rootBounds.left,
        top: rootBounds.top,
        right: rootBounds.right,
        bottom: rootBounds.bottom,
      },
      artBounds,
    };
  })()`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertInsideViewport(sample, label) {
  const epsilon = 0.6;
  const root = sample.rootBounds;
  const art = sample.artBounds;
  assert(art.left >= root.left - epsilon, `${label}: art clips left (${art.left} < ${root.left})`);
  assert(art.top >= root.top - epsilon, `${label}: art clips top (${art.top} < ${root.top})`);
  assert(art.right <= root.right + epsilon, `${label}: art clips right (${art.right} > ${root.right})`);
  assert(art.bottom <= root.bottom + epsilon, `${label}: art clips bottom (${art.bottom} > ${root.bottom})`);
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 500,
    height: 500,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadFile(HTML);
    await waitForObject(win);
    const samples = {};
    for (const timeMs of [0, 1000, 3000, 8000, 11250, 12000, 14500, 15000]) {
      samples[timeMs] = await inspect(win, timeMs);
    }
    for (const [timeMs, sample] of Object.entries(samples)) assertInsideViewport(sample, `${timeMs}ms`);

    const names = new Set(samples[0].names);
    for (const name of REQUIRED_ANIMATIONS) {
      assert(names.has(name), `missing CSS animation in Electron object channel: ${name}`);
    }
    assert(samples[0].bottle !== samples[3000].bottle, "bottle swig did not animate");
    assert(samples[0].sway !== samples[8000].sway, "body sway did not animate");
    assert(samples[0].eyes !== samples[11250].eyes, "eye droop did not animate");
    assert(samples[0].master !== samples[12000].master, "face-plant did not animate");
    assert(samples[0].shadow !== samples[12000].shadow, "shadow did not animate");
    assert(samples[1000].smokeOpacity > 0, "cigarette smoke did not become visible");
    assert(samples[12000].zOpacity > 0, "post-collapse Z did not become visible");
    assert(samples[0].emberFill !== samples[1000].emberFill, "ember did not pulse");
    assert(samples[12000].master === samples[15000].master, "face-plant final pose did not hold");

    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const object = document.getElementById("bender");
      const timer = setTimeout(() => reject(new Error("bender re-entry timed out")), 5000);
      object.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
      object.data = "../../assets/svg/clawd-outlaw-bender.svg?_t=second";
    })`);
    const restarted = await inspect(win, 0);
    assert(restarted.master === samples[0].master, "same-file re-entry did not restart at the first pose");
    assert(restarted.master !== samples[15000].master, "same-file re-entry remained on the final pose");
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
