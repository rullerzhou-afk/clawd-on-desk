"use strict";

const { app, BrowserWindow, screen, Menu, Tray, nativeImage } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

// Login-item / autostart helpers and the openAtLogin write path live in
// src/login-item.js + main.js's settings-actions effect. menu.js used to
// inline them but now just renders a checkbox bound to ctx.openAtLogin.

const WIN_TOPMOST_LEVEL = "pop-up-menu"; // above taskbar-level UI

// ── Window size presets (mirrored from main.js for resizeWindow) ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// i18n string pool + translator factory live in src/i18n.js so the future
// settings panel can share them. menu.js binds the translator to ctx.lang.
const { createTranslator } = require("./i18n");

module.exports = function initMenu(ctx) {
  // ── Translation helper (bound to ctx.lang via the shared i18n module) ──
  const t = createTranslator(() => ctx.lang);

  function isMiniSupported() {
    const caps = typeof ctx.getActiveThemeCapabilities === "function"
      ? ctx.getActiveThemeCapabilities()
      : null;
    if (caps && typeof caps.miniMode === "boolean") return caps.miniMode;
    return true;
  }

  function buildMiniModeMenuItem() {
    const miniSupported = isMiniSupported();
    const inMiniMode = ctx.getMiniMode();
    return {
      label: inMiniMode ? t("exitMiniMode") : t("miniMode"),
      enabled: !ctx.getMiniTransitioning()
        && (inMiniMode || (miniSupported && !(ctx.doNotDisturb && !inMiniMode))),
      click: () => inMiniMode ? ctx.exitMiniMode() : ctx.enterMiniViaMenu(),
    };
  }

  // ── System tray ──
  function createTray() {
    if (ctx.tray) return;
    let icon;
    if (isMac) {
      icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-iconTemplate.png"));
      icon.setTemplateImage(true);
    } else {
      icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
    }
    ctx.tray = new Tray(icon);
    ctx.tray.setToolTip("Clawd Desktop Pet");
    buildTrayMenu();
  }

  function destroyTray() {
    if (!ctx.tray) return;
    ctx.tray.destroy();
    ctx.tray = null;
  }

  function applyDockVisibility() {
    if (!isMac) return;
    if (ctx.showDock) {
      app.setActivationPolicy("regular");
      if (app.dock) app.dock.show();
    } else {
      app.setActivationPolicy("accessory");
      if (app.dock) app.dock.hide();
    }
    // dock.hide()/show() resets NSWindowCollectionBehavior — re-apply fullscreen visibility
    ctx.reapplyMacVisibility();
  }

  function buildTrayMenu() {
    if (!ctx.tray) return;
    const items = [
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      buildMiniModeMenuItem(),
      { type: "separator" },
      // Quick-toggle noise controls. Other settings (language, theme, bubble
      // follow, start-with-Claude, updates, etc.) were moved out of the tray
      // and now live only in the Settings panel / About tab.
      {
        label: t("hideBubbles"),
        type: "checkbox",
        checked: ctx.hideBubbles,
        click: (menuItem) => { ctx.hideBubbles = menuItem.checked; },
      },
      {
        label: t("soundEffects"),
        type: "checkbox",
        checked: !ctx.soundMuted,
        click: (menuItem) => { ctx.soundMuted = !menuItem.checked; },
      },
      {
        label: t("showSessionId"),
        type: "checkbox",
        checked: ctx.showSessionId,
        click: (menuItem) => { ctx.showSessionId = menuItem.checked; },
      },
      { type: "separator" },
      {
        label: t("startOnLogin"),
        type: "checkbox",
        // Bound to prefs via ctx.openAtLogin. The setter routes to
        // settings-controller → openAtLogin pre-commit gate, which calls the
        // OS API. Subscriber in main.js rebuilds the menu on commit, so the
        // checkbox updates without explicit buildTrayMenu/buildContextMenu().
        checked: ctx.openAtLogin,
        click: (menuItem) => { ctx.openAtLogin = menuItem.checked; },
      },
    ];
    // macOS: Dock and Menu Bar visibility toggles
    if (isMac) {
      items.push(
        { type: "separator" },
        {
          label: t("showInMenuBar"),
          type: "checkbox",
          checked: ctx.showTray,
          enabled: ctx.showTray ? ctx.showDock : true, // can't uncheck if Dock is already hidden
          click: (menuItem) => { ctx.showTray = menuItem.checked; },
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => { ctx.showDock = menuItem.checked; },
        },
      );
    }
    items.push(
      { type: "separator" },
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
      { type: "separator" },
      {
        label: ctx.petHidden ? t("showPet") : t("hidePet"),
        click: () => ctx.togglePetVisibility(),
      },
      { type: "separator" },
      { label: t("quit"), click: () => requestAppQuit() },
    );
    ctx.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  function rebuildAllMenus() {
    buildTrayMenu();
    buildContextMenu();
  }

  function requestAppQuit() {
    ctx.isQuitting = true;
    app.quit();
  }

  function ensureContextMenuOwner() {
    if (ctx.contextMenuOwner && !ctx.contextMenuOwner.isDestroyed()) return ctx.contextMenuOwner;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    ctx.contextMenuOwner = new BrowserWindow({
      parent: ctx.win,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: true,
      closable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
    });

    // macOS: ensure owner can appear on fullscreen Spaces
    ctx.reapplyMacVisibility();

    ctx.contextMenuOwner.on("close", (event) => {
      if (!ctx.isQuitting) {
        event.preventDefault();
        ctx.contextMenuOwner.hide();
      }
    });

    ctx.contextMenuOwner.on("closed", () => {
      ctx.contextMenuOwner = null;
    });

    return ctx.contextMenuOwner;
  }

  function popupMenuAt(menu) {
    if (ctx.menuOpen) return;
    const owner = ensureContextMenuOwner();
    if (!owner) return;

    const cursor = screen.getCursorScreenPoint();
    owner.setBounds({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
    owner.show();
    owner.focus();

    ctx.menuOpen = true;
    menu.popup({
      window: owner,
      callback: () => {
        ctx.menuOpen = false;
        if (owner && !owner.isDestroyed()) owner.hide();
        if (ctx.win && !ctx.win.isDestroyed()) {
          ctx.win.showInactive();
          if (isMac) {
            ctx.reapplyMacVisibility();
          } else if (isWin) {
            ctx.win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
          }
        }
      },
    });
  }

  function buildDisplaySubmenu(displays = screen.getAllDisplays()) {
    if (displays.length <= 1) return [{ label: t("displayLabel").replace("{n}", 1), enabled: false }];
    const currentBounds = ctx.getPetWindowBounds ? ctx.getPetWindowBounds() : null;
    const current = currentBounds
      ? screen.getDisplayNearestPoint({
        x: Math.round(currentBounds.x + currentBounds.width / 2),
        y: Math.round(currentBounds.y + currentBounds.height / 2),
      })
      : null;
    return displays.map((d, i) => {
      const isPrimary = d.bounds.x === 0 && d.bounds.y === 0;
      const labelKey = isPrimary ? "displayLabelPrimary" : "displayLabel";
      const res = t("displayResolution").replace("{w}", d.bounds.width).replace("{h}", d.bounds.height);
      const isCurrent = current && current.id === d.id;
      return {
        label: `${t(labelKey).replace("{n}", i + 1)}  ${res}`,
        enabled: !isCurrent,
        click: () => sendToDisplay(d),
      };
    });
  }

  function sendToDisplay(display) {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    if (ctx.getMiniMode()) return;
    const wa = display.workArea;
    if (ctx.isProportionalMode && ctx.isProportionalMode()) {
      const size = ctx.getCurrentPixelSize(wa);
      const x = Math.round(wa.x + (wa.width - size.width) / 2);
      const y = Math.round(wa.y + (wa.height - size.height) / 2);
      ctx.applyPetWindowBounds({ x, y, width: size.width, height: size.height });
    } else {
      const size = SIZES[ctx.currentSize] || ctx.getCurrentPixelSize();
      const x = Math.round(wa.x + (wa.width - size.width) / 2);
      const y = Math.round(wa.y + (wa.height - size.height) / 2);
      ctx.applyPetWindowBounds({ x, y, width: size.width, height: size.height });
    }
    ctx.syncHitWin();
    ctx.repositionBubbles();
    ctx.flushRuntimeStateToPrefs();
  }

  function buildContextMenu() {
    const template = [
      {
        ...buildMiniModeMenuItem(),
      },
      { type: "separator" },
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      { type: "separator" },
      {
        label: `${t("sessions")} (${ctx.sessions.size})`,
        submenu: ctx.buildSessionSubmenu(),
      },
    ];
    // sendToDisplay is a multi-display-only tail entry. Push dynamically
    // (rather than visible:false) — Electron leaves a phantom gap for
    // hidden separators otherwise.
    const displays = screen.getAllDisplays();
    if (displays.length > 1 && !ctx.getMiniMode()) {
      template.push(
        { type: "separator" },
        {
          label: t("sendToDisplay"),
          submenu: buildDisplaySubmenu(displays),
        },
      );
    }
    // macOS: Dock and Menu Bar visibility toggles
    if (isMac) {
      template.push(
        { type: "separator" },
        {
          label: t("showInMenuBar"),
          type: "checkbox",
          checked: ctx.showTray,
          enabled: ctx.showTray ? ctx.showDock : true, // can't uncheck if Dock is already hidden
          click: (menuItem) => { ctx.showTray = menuItem.checked; },
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => { ctx.showDock = menuItem.checked; },
        },
      );
    }
    template.push(
      { type: "separator" },
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
      { type: "separator" },
      { label: t("quit"), click: () => requestAppQuit() },
    );
    ctx.contextMenu = Menu.buildFromTemplate(template);
  }

  function showPetContextMenu() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    buildContextMenu();
    popupMenuAt(ctx.contextMenu);
  }

  function resizeWindow(sizeKey, options = {}) {
    const mode = options.mode || (options.persist === false ? "preview" : "commit");
    const persist = mode !== "preview";
    // Setter routes through controller.applyUpdate("size", ...) — subscriber
    // rebuilds menus on commit. We still need to physically resize the
    // window and capture the new bounds at the end.
    if (persist) ctx.currentSize = sizeKey;
    const size = (typeof ctx.getPixelSizeFor === "function")
      ? ctx.getPixelSizeFor(sizeKey)
      : (SIZES[sizeKey] || ctx.getCurrentPixelSize());
    if (!ctx.miniHandleResize(sizeKey)) {
      if (ctx.win && !ctx.win.isDestroyed()) {
        const { x, y } = ctx.getPetWindowBounds();
        const clamped = ctx.clampToScreenVisual(x, y, size.width, size.height);
        ctx.applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      }
    }
    if (mode !== "preview") {
      ctx.syncHitWin();
      ctx.repositionBubbles();
      if (persist) ctx.flushRuntimeStateToPrefs();
    }
  }

  return {
    t,
    buildContextMenu,
    buildTrayMenu,
    rebuildAllMenus,
    createTray,
    destroyTray,
    applyDockVisibility,
    ensureContextMenuOwner,
    popupMenuAt,
    showPetContextMenu,
    resizeWindow,
    requestAppQuit,
  };
};

