"use strict";

// #1260 backstop: the context menu's modal loop can swallow the pointerup
// that would have ended a drag, leaving main's dragLocked held after the
// menu closes (the normal renderer path ends the drag before the menu opens,
// so this only fires for strands that slip past it). The close callback must
// funnel the still-held lock through the shared releaseStrandedDragLock
// recovery, which also pushes force-drag-release to the hit renderer.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron, fakeTaskbar) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "./taskbar") return fakeTaskbar;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness({ dragLocked = false, includeReleaseEntry = true } = {}) {
  const calls = [];
  const owner = {
    isDestroyed: () => false,
    setBounds: () => calls.push("owner.setBounds"),
    show: () => calls.push("owner.show"),
    focus: () => calls.push("owner.focus"),
    hide: () => calls.push("owner.hide"),
  };
  const fakeElectron = {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: { buildFromTemplate: (template) => ({ template }) },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return { resize() { return this; }, setTemplateImage() {} };
      },
    },
    screen: { getCursorScreenPoint: () => ({ x: 12, y: 34 }) },
  };
  const fakeTaskbar = { keepOutOfTaskbar: () => calls.push("keepOutOfTaskbar") };
  const initMenu = loadMenuWithElectron(fakeElectron, fakeTaskbar);

  let releaseAttempts = 0;
  const ctx = {
    win: {
      isDestroyed: () => false,
      showInactive: () => calls.push("win.showInactive"),
      setAlwaysOnTop: () => calls.push("win.setAlwaysOnTop"),
    },
    menuOpen: false,
    contextMenuOwner: owner,
    petHidden: false,
    reapplyMacVisibility: () => calls.push("reapplyMacVisibility"),
    get dragLocked() { return dragLocked; },
  };
  if (includeReleaseEntry) {
    ctx.releaseStrandedDragLock = () => {
      releaseAttempts += 1;
      calls.push("releaseStrandedDragLock");
    };
  }
  const menu = initMenu(ctx);
  let closeCallback = null;
  const fakeMenu = {
    popup: (opts) => { closeCallback = opts.callback; },
  };

  return {
    calls,
    get releaseAttempts() { return releaseAttempts; },
    get menuOpen() { return ctx.menuOpen; },
    popup() {
      menu.popupMenuAt(fakeMenu);
      assert.ok(closeCallback, "popup must capture the close callback");
      return closeCallback;
    },
  };
}

describe("context menu close releases a stranded drag lock (#1260)", () => {
  it("releases the lock through the shared recovery when the menu closes with the lock held", () => {
    const h = createHarness({ dragLocked: true });
    const close = h.popup();
    assert.strictEqual(h.menuOpen, true, "the popup marks the menu open");
    close();
    assert.strictEqual(h.releaseAttempts, 1, "close must run the recovery entry");
    assert.strictEqual(h.menuOpen, false);
    assert.ok(h.calls.includes("owner.hide"), "the owner hides as usual");
  });

  it("does not touch the recovery path when the menu closes with no lock held", () => {
    const h = createHarness({ dragLocked: false });
    const close = h.popup();
    close();
    assert.strictEqual(h.releaseAttempts, 0);
    assert.strictEqual(h.menuOpen, false);
  });

  it("stays inert when no recovery entry is available on the ctx", () => {
    const h = createHarness({ dragLocked: true, includeReleaseEntry: false });
    const close = h.popup();
    assert.doesNotThrow(() => close());
    assert.strictEqual(h.menuOpen, false);
    assert.ok(h.calls.includes("owner.hide"), "the rest of the close path still runs");
  });
});
