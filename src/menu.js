"use strict";

const { app, BrowserWindow, screen, Menu, Tray, nativeImage, dialog } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

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

// Concatenate menu groups into one Electron template, inserting exactly one
// separator between non-empty groups. Empty groups are dropped entirely so no
// phantom/doubled separator is ever rendered (Electron leaves a visible gap for
// a stray separator). Doing the grouping here — instead of hand-placing a
// separator around almost every item — is what lets the menu read as a few
// labelled clusters (state / work / display / app) rather than one slice per
// row.
function joinGroups(groups) {
  const template = [];
  for (const group of groups) {
    if (!group || group.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...group);
  }
  return template;
}

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
    const miniDisabled = typeof ctx.getDisableMiniMode === "function" && ctx.getDisableMiniMode();
    return {
      label: inMiniMode ? t("exitMiniMode") : t("miniMode"),
      enabled: !ctx.getMiniTransitioning()
        && (inMiniMode || (!miniDisabled && miniSupported && !(ctx.doNotDisturb && !inMiniMode))),
      click: () => {
        if (inMiniMode) return ctx.exitMiniMode();
        if (miniDisabled) return undefined;
        return ctx.enterMiniViaMenu();
      },
    };
  }

  // DANGER "auto-pilot" quick toggle. Enabling auto-approves EVERY agent
  // permission request with no prompt, so the enable path is gated behind a
  // native modal confirm. Disabling is immediate. After either decision we
  // rebuild menus so the checkbox reflects the committed value (Electron has
  // already flipped the visual optimistically on click).
  function buildAutoApproveMenuItem() {
    return {
      label: t("menuAutoApproveAll"),
      type: "checkbox",
      checked: !!ctx.autoApproveAllPermissions,
      click: (menuItem) => {
        const wantOn = menuItem.checked;
        if (!wantOn) {
          ctx.autoApproveAllPermissions = false;
          return;
        }
        // Revert the optimistic check until the user confirms.
        menuItem.checked = false;
        // No parent window: attaching the dialog to ctx.win (the small pet
        // window) makes macOS render it as a sheet centered on the pet. A
        // parentless dialog is a standalone window centered on the screen,
        // which is what a danger confirmation should be.
        Promise.resolve(
          dialog.showMessageBox({
            type: "warning",
            buttons: [t("autoApproveAllConfirmEnable"), t("autoApproveAllConfirmCancel")],
            defaultId: 1,
            cancelId: 1,
            title: t("autoApproveAllConfirmTitle"),
            message: t("autoApproveAllConfirmTitle"),
            detail: t("autoApproveAllConfirmDetail"),
          })
        ).then((res) => {
          if (res && res.response === 0) {
            ctx.autoApproveAllPermissions = true;
          }
          rebuildAllMenus();
        }).catch((err) => {
          console.warn("Clawd: auto-pilot confirm failed:", err && err.message);
          rebuildAllMenus();
        });
      },
    };
  }

  function buildBringToPrimaryDisplayMenuItem() {
    return {
      label: t("bringPetToPrimaryDisplay"),
      enabled: typeof ctx.bringPetToPrimaryDisplay === "function"
        && !ctx.getMiniMode()
        && !ctx.getMiniTransitioning(),
      click: () => {
        if (typeof ctx.bringPetToPrimaryDisplay === "function") {
          ctx.bringPetToPrimaryDisplay();
        }
      },
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

    // Same grouping discipline as the context menu (see joinGroups), adapted
    // for the tray's larger item set: state / noise / work / system / app /
    // quit. Other settings (language, theme, bubble follow, start-with-Claude,
    // updates, etc.) live only in the Settings panel / About tab.
    const stateGroup = [
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      buildMiniModeMenuItem(),
    ];

    // Quick noise toggles (bubbles + sound) kept together.
    const noiseGroup = [
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
    ];

    // Dashboard + the danger auto-approve toggle (danger last, as in the
    // context menu).
    const workGroup = [
      {
        label: t("openDashboard"),
        click: () => {
          if (typeof ctx.openDashboard === "function") ctx.openDashboard();
        },
      },
      buildAutoApproveMenuItem(),
    ];

    // OS-integration / placement group: bring-to-primary, mac dock/menu-bar,
    // start-on-login.
    const systemGroup = [
      buildBringToPrimaryDisplayMenuItem(),
    ];
    if (isMac) {
      systemGroup.push(
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
    systemGroup.push({
      label: t("startOnLogin"),
      type: "checkbox",
      // Bound to prefs via ctx.openAtLogin. The setter routes to
      // settings-controller → openAtLogin pre-commit gate, which calls the
      // OS API. Subscriber in main.js rebuilds the menu on commit, so the
      // checkbox updates without explicit buildTrayMenu/buildContextMenu().
      checked: ctx.openAtLogin,
      click: (menuItem) => { ctx.openAtLogin = menuItem.checked; },
    });

    const appGroup = [
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
    ];
    // #329: surface the update item alongside the app actions. The label
    // switches to "Update available · vX" / "Update Ready" when applicable.
    if (typeof ctx.getUpdateMenuItem === "function") {
      const updateItem = ctx.getUpdateMenuItem();
      if (updateItem) appGroup.push(updateItem);
    }
    appGroup.push({
      label: ctx.petHidden ? t("showPet") : t("hidePet"),
      click: () => ctx.togglePetVisibility(),
    });

    const quitGroup = [
      { label: t("quit"), click: () => requestAppQuit() },
    ];

    const items = joinGroups([stateGroup, noiseGroup, workGroup, systemGroup, appGroup, quitGroup]);
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

    // Chromium reclaims empty (about:blank) hidden renderers, which defeats
    // the "persistent helper window" design — every right-click ends up
    // re-spawning a renderer process. Load a minimal data: URL so the
    // renderer has a real document and stays alive across menu invocations.
    ctx.contextMenuOwner.loadURL("data:text/html,%3C!doctype%20html%3E");

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
    keepOutOfTaskbar(owner);
    owner.focus();

    ctx.menuOpen = true;
    menu.popup({
      window: owner,
      callback: () => {
        ctx.menuOpen = false;
        if (owner && !owner.isDestroyed()) owner.hide();
        // ctx.petHidden guard: the menu's own Hide item may have just hidden
        // the pet, and the click handler can fire on either side of this close
        // callback — an unconditional showInactive() would resurrect a window
        // setPetHidden() just hid. Skipping is safe: showPetWindows() re-asserts
        // taskbar/mac flags on the next show, and Windows topmost is held by
        // the window's alwaysOnTop flag plus the topmost-runtime watchdog, not
        // by this callback.
        if (ctx.win && !ctx.win.isDestroyed() && !ctx.petHidden) {
          ctx.win.showInactive();
          keepOutOfTaskbar(ctx.win);
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
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize(wa)
      : (SIZES[ctx.currentSize] || ctx.getCurrentPixelSize(wa));
    const x = Math.round(wa.x + (wa.width - size.width) / 2);
    const y = Math.round(wa.y + (wa.height - size.height) / 2);
    ctx.applyPetWindowBounds({ x, y, width: size.width, height: size.height });
    ctx.syncHitWin();
    ctx.repositionBubbles();
    ctx.flushRuntimeStateToPrefs();
  }

  function buildContextMenu() {
    // Grouped as state / work / display / app / quit and joined with a single
    // separator between non-empty groups (see joinGroups). This replaced a flat
    // list that wrapped almost every item in its own separator, and it moves the
    // danger auto-approve toggle into the work group instead of leaving it as a
    // prominent top-level entry.
    const stateGroup = [
      { ...buildMiniModeMenuItem() },
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
    ];

    const workGroup = [
      {
        label: t("openDashboard"),
        click: () => {
          if (typeof ctx.openDashboard === "function") ctx.openDashboard();
        },
      },
      {
        label: t("newSession"),
        submenu: [
          {
            label: t("newSessionSelectFolder"),
            click: () => {
              if (typeof ctx.newSessionWithFolder === "function") ctx.newSessionWithFolder(t);
            },
          },
          {
            label: t("newSessionHomeDir"),
            click: () => {
              if (typeof ctx.newSessionInCurrentDir === "function") ctx.newSessionInCurrentDir(t);
            },
          },
        ],
      },
      // Danger auto-approve sits at the tail of the work group: it governs how
      // agent permission requests are handled, and keeping it here (rather than
      // near the top) makes it harder to hit by accident.
      buildAutoApproveMenuItem(),
    ];

    // Display group: just the multi-display "send to display" entry. The mac
    // dock / menu-bar visibility toggles deliberately do NOT live here — they
    // are set-once OS-integration prefs and live in the tray menu + Settings
    // instead. On a single display this group is empty and joinGroups drops it.
    const displayGroup = [];
    const displays = screen.getAllDisplays();
    if (displays.length > 1 && !ctx.getMiniMode()) {
      displayGroup.push({
        label: t("sendToDisplay"),
        submenu: buildDisplaySubmenu(displays),
      });
    }

    const appGroup = [
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
    ];
    // #329: surface the update item alongside the other app actions when one is
    // available.
    if (typeof ctx.getUpdateMenuItem === "function") {
      const updateItem = ctx.getUpdateMenuItem();
      if (updateItem) appGroup.push(updateItem);
    }
    appGroup.push({
      label: ctx.petHidden ? t("showPet") : t("hidePet"),
      click: () => ctx.togglePetVisibility(),
    });

    // Quit stands alone as the final group so it is always set off by a
    // separator (native-menu convention), which also keeps Hide/Show Pet
    // directly above the Quit separator (see menu-hide-pet test, #460).
    const quitGroup = [
      { label: t("quit"), click: () => requestAppQuit() },
    ];

    const template = joinGroups([stateGroup, workGroup, displayGroup, appGroup, quitGroup]);
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
    getTray: () => ctx.tray,
    applyDockVisibility,
    ensureContextMenuOwner,
    popupMenuAt,
    showPetContextMenu,
    resizeWindow,
    requestAppQuit,
  };
};
