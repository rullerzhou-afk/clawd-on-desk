"use strict";

const { app, BrowserWindow, screen, Menu, Tray, nativeImage } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

// ── Linux XDG autostart helpers ──
const fs = require("fs");
const os = require("os");
const AUTOSTART_DIR = path.join(os.homedir(), ".config", "autostart");
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, "clawd-on-desk.desktop");

function getLoginItemSettings({ isPackaged, openAtLogin, execPath, appPath }) {
  if (isPackaged) return { openAtLogin };
  return {
    openAtLogin,
    path: execPath,
    args: [appPath],
  };
}

function linuxGetOpenAtLogin() {
  try { return fs.existsSync(AUTOSTART_FILE); } catch { return false; }
}

function linuxSetOpenAtLogin(enable) {
  if (enable) {
    const projectDir = path.resolve(__dirname, "..");
    const launchScript = path.join(projectDir, "launch.js");
    const execCmd = app.isPackaged
      ? `"${process.env.APPIMAGE || app.getPath("exe")}"`
      : `node "${launchScript}"`;
    const desktop = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Clawd on Desk",
      `Exec=${execCmd}`,
      "Hidden=false",
      "NoDisplay=false",
      "X-GNOME-Autostart-enabled=true",
    ].join("\n") + "\n";
    try {
      fs.mkdirSync(AUTOSTART_DIR, { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, desktop);
    } catch (err) {
      console.warn("Clawd: failed to write autostart entry:", err.message);
    }
  } else {
    try { fs.unlinkSync(AUTOSTART_FILE); } catch {}
  }
}
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

const { shell } = require("electron");

module.exports = function initMenu(ctx) {
  // ── Translation helper (bound to ctx.lang via the shared i18n module) ──
  const t = createTranslator(() => ctx.lang);

  // ── Theme submenu builder ──
  function buildThemeSubmenu() {
    const themes = ctx.discoverThemes ? ctx.discoverThemes() : [];
    const activeId = ctx.getActiveThemeId ? ctx.getActiveThemeId() : "clawd";

    const items = themes.map(theme => ({
      label: theme.name + (theme.builtin ? "" : " ✦"),
      type: "radio",
      checked: theme.id === activeId,
      click: () => {
        if (theme.id !== activeId && ctx.switchTheme) {
          ctx.switchTheme(theme.id);
        }
      },
    }));

    items.push({ type: "separator" });
    items.push({
      label: t("openThemeDir"),
      click: () => {
        const dir = ctx.ensureUserThemesDir ? ctx.ensureUserThemesDir() : null;
        if (dir) shell.openPath(dir);
      },
    });

    return items;
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
      // The setters route through ctx.settings.applyUpdate(); main.js's
      // settings subscriber handles reposition / menu rebuild / persist.
      {
        label: t("bubbleFollow"),
        type: "checkbox",
        checked: ctx.bubbleFollowPet,
        click: (menuItem) => { ctx.bubbleFollowPet = menuItem.checked; },
      },
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
        label: t("theme"),
        submenu: buildThemeSubmenu(),
      },
      { type: "separator" },
      {
        label: t("startOnLogin"),
        type: "checkbox",
        // NOTE: path/args must match setLoginItemSettings — see getLoginItemSettings()
        checked: isLinux ? linuxGetOpenAtLogin()
          : app.getLoginItemSettings(
              app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }
            ).openAtLogin,
        click: (menuItem) => {
          if (isLinux) {
            linuxSetOpenAtLogin(menuItem.checked);
          } else {
            app.setLoginItemSettings(getLoginItemSettings({
              isPackaged: app.isPackaged,
              openAtLogin: menuItem.checked,
              execPath: process.execPath,
              appPath: app.getAppPath(),
            }));
          }
          buildTrayMenu();
          buildContextMenu();
        },
      },
      {
        label: t("startWithClaude"),
        type: "checkbox",
        checked: ctx.autoStartWithClaude,
        // Setter triggers controller.applyUpdate; subscriber in main.js
        // installs/uninstalls the SessionStart hook + rebuilds the menu.
        click: (menuItem) => { ctx.autoStartWithClaude = menuItem.checked; },
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
      ctx.getUpdateMenuItem(),
      { type: "separator" },
      {
        label: t("language"),
        submenu: [
          { label: "English", type: "radio", checked: ctx.lang === "en", click: () => { ctx.lang = "en"; } },
          { label: "中文", type: "radio", checked: ctx.lang === "zh", click: () => { ctx.lang = "zh"; } },
        ],
      },
      { type: "separator" },
      {
        label: ctx.petHidden ? t("showPet") : t("hidePet"),
        click: () => ctx.togglePetVisibility(),
      },
      {
        label: t("toggleShortcut").replace("{shortcut}", isMac ? "⌘⇧⌥C" : "Ctrl+Shift+Alt+C"),
        enabled: false,
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

  function buildProportionalSubmenu() {
    const isP = ctx.isProportionalMode && ctx.isProportionalMode();
    const currentRatio = isP ? parseFloat(ctx.currentSize.slice(2)) : 0;
    const isCustom = isP && !ctx.PROPORTIONAL_RATIOS.includes(currentRatio);
    const items = ctx.PROPORTIONAL_RATIOS.map(r => ({
      label: t("proportionalPct").replace("{n}", r),
      type: "radio",
      checked: ctx.currentSize === `P:${r}`,
      click: () => resizeWindow(`P:${r}`),
    }));
    items.push({ type: "separator" });
    items.push({
      label: isCustom
        ? `${t("proportionalCustom")} (${currentRatio}%)`
        : t("proportionalCustom"),
      type: "radio",
      checked: isCustom,
      click: () => promptCustomRatio(isCustom ? currentRatio : 10),
    });
    return items;
  }

  function promptCustomRatio(defaultVal) {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0; padding: 16px; background: #f5f5f5; user-select: none; }
  label { display: block; font-size: 13px; margin-bottom: 8px; color: #333; }
  input { width: 80px; padding: 4px 8px; font-size: 14px; border: 1px solid #ccc;
          border-radius: 4px; outline: none; text-align: center; }
  input:focus { border-color: #4a90d9; }
  .buttons { margin-top: 12px; text-align: right; }
  button { padding: 4px 16px; font-size: 13px; border-radius: 4px; border: 1px solid #ccc;
           background: #fff; cursor: pointer; margin-left: 6px; }
  button.primary { background: #4a90d9; color: #fff; border-color: #4a90d9; }
  .hint { font-size: 11px; color: #999; margin-top: 4px; }
</style></head><body>
<label>${t("proportionalCustomMsg")}</label>
<input id="v" type="number" min="1" max="75" step="1" value="${defaultVal}" autofocus>
<div class="hint">1% ≈ tiny &nbsp; 15% ≈ large &nbsp; 75% = max</div>
<div class="buttons">
  <button onclick="window.close()">Cancel</button>
  <button class="primary" onclick="ok()">OK</button>
</div>
<script>
  const inp = document.getElementById("v");
  inp.select();
  inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); if (e.key === "Escape") window.close(); });
  function ok() { const n = parseFloat(inp.value); if (n >= 1 && n <= 75) window.promptAPI.submit(n); window.close(); }
</script></body></html>`;

    const promptWin = new BrowserWindow({
      width: 280, height: 140,
      resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      frame: false, transparent: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-prompt.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    promptWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    promptWin.once("ready-to-show", () => promptWin.show());

    const { ipcMain } = require("electron");
    const handler = (_, val) => {
      resizeWindow(`P:${val}`);
      ipcMain.removeListener("proportional-custom", handler);
    };
    ipcMain.on("proportional-custom", handler);
    promptWin.on("closed", () => {
      ipcMain.removeListener("proportional-custom", handler);
    });
  }

  function buildDisplaySubmenu() {
    const displays = screen.getAllDisplays();
    if (displays.length <= 1) return [{ label: t("displayLabel").replace("{n}", 1), enabled: false }];
    const current = ctx.win && !ctx.win.isDestroyed()
      ? screen.getDisplayNearestPoint(ctx.win.getBounds())
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
      const ratio = parseFloat(ctx.currentSize.slice(2)) || 10;
      const px = Math.round(wa.width * ratio / 100);
      const size = { width: px, height: px };
      const x = Math.round(wa.x + (wa.width - size.width) / 2);
      const y = Math.round(wa.y + (wa.height - size.height) / 2);
      ctx.win.setBounds({ x, y, width: size.width, height: size.height });
    } else {
      const size = SIZES[ctx.currentSize] || ctx.getCurrentPixelSize();
      const x = Math.round(wa.x + (wa.width - size.width) / 2);
      const y = Math.round(wa.y + (wa.height - size.height) / 2);
      ctx.win.setBounds({ x, y, width: size.width, height: size.height });
    }
    ctx.syncHitWin();
    if (ctx.bubbleFollowPet) ctx.repositionBubbles();
    ctx.flushRuntimeStateToPrefs();
  }

  function buildContextMenu() {
    const template = [
      {
        label: t("proportional"),
        submenu: buildProportionalSubmenu(),
      },
      {
        label: t("sendToDisplay"),
        submenu: buildDisplaySubmenu(),
        visible: screen.getAllDisplays().length > 1 && !ctx.getMiniMode(),
      },
      { type: "separator" },
      {
        label: ctx.getMiniMode() ? t("exitMiniMode") : t("miniMode"),
        enabled: !ctx.getMiniTransitioning() && !(ctx.doNotDisturb && !ctx.getMiniMode()),
        click: () => ctx.getMiniMode() ? ctx.exitMiniMode() : ctx.enterMiniViaMenu(),
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
      { type: "separator" },
      {
        label: t("theme"),
        submenu: buildThemeSubmenu(),
      },
    ];
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
        label: t("toggleShortcut").replace("{shortcut}", isMac ? "⌘⇧⌥C" : "Ctrl+Shift+Alt+C"),
        enabled: false,
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

  function resizeWindow(sizeKey) {
    // Setter routes through controller.applyUpdate("size", ...) — subscriber
    // rebuilds menus on commit. We still need to physically resize the
    // window and capture the new bounds at the end.
    ctx.currentSize = sizeKey;
    const size = SIZES[sizeKey] || ctx.getCurrentPixelSize();
    if (!ctx.miniHandleResize(sizeKey)) {
      if (ctx.win && !ctx.win.isDestroyed()) {
        const { x, y } = ctx.win.getBounds();
        const clamped = ctx.clampToScreen(x, y, size.width, size.height);
        ctx.win.setBounds({ ...clamped, width: size.width, height: size.height });
        ctx.syncHitWin();
      }
    }
    if (ctx.bubbleFollowPet) ctx.repositionBubbles();
    ctx.flushRuntimeStateToPrefs();
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

module.exports.__test = {
  getLoginItemSettings,
};
