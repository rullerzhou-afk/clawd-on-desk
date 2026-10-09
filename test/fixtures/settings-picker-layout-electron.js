"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { applyZoomToWindow } = require("../../src/text-scale");

const SRC = path.resolve(__dirname, "../../src");
const css = ["settings.css", "language-picker.css"].map(file => fs.readFileSync(path.join(SRC, file), "utf8")).join("\n");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
  .language-picker-menu { transition: none !important; }
</style></head><body><div class="app"><aside class="sidebar"><button id="outside">Outside</button></aside>
<main id="content" class="content" data-language-picker-boundary>
<section class="section"><div class="row" id="down" style="margin-top:60px"></div>
<div class="row" id="up" style="margin-top:140px"></div></section>
<div style="height:1000px"></div></main></div></body></html>`;

async function installPickers(win) {
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(SRC, "language-picker.js"), "utf8"));
  await win.webContents.executeJavaScript(`
    window.controls = {};
    window.settleLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const direction of ["down", "up"]) {
      const control = ClawdLanguagePicker.createSettingsSelect({
        options: direction === "up"
          ? Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: "Accessory " + i }))
          : ["Default", "Midnight", "Gold", "Vaporwave", "Matcha", "Monochrome"],
        viewportPlacement: direction,
      });
      control.element.classList.add("settings-select");
      controls[direction] = control;
      document.getElementById(direction).appendChild(control.element);
    }
    window.measure = (direction) => {
      const picker = controls[direction].element;
      const menu = picker.querySelector(".language-picker-menu");
      const content = document.getElementById("content");
      return {
        trigger: picker.querySelector("button").getBoundingClientRect().toJSON(),
        menu: menu.getBoundingClientRect().toJSON(),
        boundary: content.getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight },
        open: picker.classList.contains("open"),
        openUp: picker.classList.contains("open-up"),
        outerHeight: content.scrollHeight,
        menuHeight: menu.clientHeight,
        menuContentHeight: menu.scrollHeight,
        overflow: getComputedStyle(menu).overflowY,
      };
    };
    void 0;
  `);
}

function assertLayout(layout, zoom, context) {
  const { trigger, menu, boundary, viewport } = layout;
  const tolerance = 2;
  const inset = 12 * zoom;
  const detail = `${context}: ${JSON.stringify(layout)}`;
  assert.ok(layout.open, `picker closed unexpectedly; ${detail}`);
  assert.ok(Math.abs(menu.left - trigger.left) < tolerance, `left alignment; ${detail}`);
  assert.ok(Math.abs(menu.width - trigger.width) < tolerance, `width alignment; ${detail}`);
  assert.ok(menu.left >= boundary.left + inset - tolerance, `left boundary; ${detail}`);
  assert.ok(menu.right <= Math.min(boundary.right, viewport.width) - inset + tolerance, `right boundary; ${detail}`);
  assert.ok(menu.top >= Math.max(boundary.top, 0) + inset - tolerance, `top boundary; ${detail}`);
  assert.ok(menu.bottom <= Math.min(boundary.bottom, viewport.height) - inset + tolerance, `bottom boundary; ${detail}`);
  assert.ok(menu.height > 0 && menu.height <= 240 * zoom + tolerance, `height limit; ${detail}`);
  assert.ok(layout.openUp
    ? Math.abs(menu.bottom - (trigger.top - 6 * zoom)) < tolerance
    : Math.abs(menu.top - (trigger.bottom + 6 * zoom)) < tolerance, `trigger gap; ${detail}`);
  if (layout.menuContentHeight > layout.menuHeight + 1) {
    assert.equal(layout.overflow, "auto", `long menus must scroll internally; ${detail}`);
  }
}

async function main() {
  const profile = process.env.CLAWD_PICKER_LAYOUT_PROFILE;
  assert.ok(profile && path.isAbsolute(profile), "the test runner must supply an isolated profile");
  app.setPath("userData", profile);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 700, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await installPickers(win);
    for (const zoom of [0.8, 1, 1.25, 1.5, 1.6]) {
      applyZoomToWindow(win, zoom);
      await win.webContents.__clawdTextZoomQueue;
      for (const direction of ["down", "up"]) {
        for (let cycle = 0; cycle < 2; cycle++) {
          const layout = await win.webContents.executeJavaScript(`(async () => {
            const trigger = controls.${direction}.element.querySelector("button");
            trigger.scrollIntoView({ block: "nearest" });
            await settleLayout();
            const before = document.getElementById("content").scrollHeight;
            trigger.click();
            await settleLayout();
            return { ...measure("${direction}"), before };
          })()`);
          assertLayout(layout, zoom, `${zoom} / ${direction} / ${cycle}`);
          assert.equal(layout.outerHeight, layout.before, "opening must not grow the outer scroller");
          const closed = await win.webContents.executeJavaScript(`(async () => {
            document.getElementById("outside").click();
            await new Promise(resolve => setTimeout(resolve, 200));
            return measure("${direction}");
          })()`);
          assert.equal(closed.outerHeight, layout.before, "closing must not change the outer height");
          assert.equal(closed.menu.height, 0, "closed menus must leave layout");
        }
      }
    }
    // Wrapping must be measured at trigger width, before the height is capped.
    const wrapped = await win.webContents.executeJavaScript(`(async () => {
      const picker = controls.down.element;
      for (const option of picker.querySelectorAll(".language-picker-option")) {
        option.textContent = "A long translated color option that wraps across several lines";
      }
      const trigger = picker.querySelector("button");
      trigger.scrollIntoView({ block: "nearest" });
      await settleLayout();
      trigger.click();
      await settleLayout();
      return measure("down");
    })()`);
    assertLayout(wrapped, 1.6, "wrapped options");
    assert.ok(wrapped.menuContentHeight > wrapped.menuHeight, "fixture must exercise internal overflow");
    await win.webContents.executeJavaScript(`(async () => {
      document.getElementById("outside").click();
      await new Promise(resolve => setTimeout(resolve, 200));
      controls.up.element.querySelector("button").scrollIntoView({ block: "nearest" });
      await settleLayout();
    })()`);
    // Reflow an open menu at the current zoom, including a narrower viewport.
    await win.webContents.executeJavaScript(`controls.up.element.querySelector("button").click()`);
    win.setContentSize(800, 650);
    await win.webContents.executeJavaScript("settleLayout()");
    assertLayout(await win.webContents.executeJavaScript('measure("up")'), 1.6, "resize");
    console.log("PASS: real CSS zoom, menu bounds, resize, and repeated open/close overflow");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch(error => {
  console.error(error && error.stack || error);
  app.exit(1);
});
