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

// ── Internationalization ──
const i18n = {
  en: {
    size: "Size",
    small: "Small (S)",
    medium: "Medium (M)",
    large: "Large (L)",
    miniMode: "Mini Mode",
    exitMiniMode: "Exit Mini Mode",
    sleep: "Sleep (Do Not Disturb)",
    wake: "Wake Clawd",
    startOnLogin: "Start on Login",
    startWithClaude: "Start with Claude Code",
    showInMenuBar: "Show in Menu Bar",
    showInDock: "Show in Dock",
    language: "Language",
    checkForUpdates: "Check for Updates",
    checkingForUpdates: "Checking for Updates…",
    updateAvailable: "Update Available",
    updateAvailableMsg: "v{version} is available. Download and install now?",
    updateAvailableMacMsg: "v{version} is available. Open the download page?",
    updateNotAvailable: "You're Up to Date",
    updateNotAvailableMsg: "Clawd v{version} is the latest version.",
    updateDownloading: "Downloading Update…",
    updateReady: "Update Ready",
    updateReadyMsg: "v{version} has been downloaded. Restart now to update?",
    updateError: "Update Error",
    updateErrorMsg: "Failed to check for updates. Please try again later.",
    restartNow: "Restart Now",
    restartLater: "Later",
    download: "Download",
    bubbleFollow: "Bubble Follow Pet",
    sessions: "Sessions",
    noSessions: "No active sessions",
    sessionWorking: "Working",
    sessionThinking: "Thinking",
    sessionJuggling: "Juggling",
    sessionIdle: "Idle",
    sessionSleeping: "Sleeping",
    sessionJustNow: "just now",
    sessionMinAgo: "{n}m ago",
    sessionHrAgo: "{n}h ago",
    quit: "Quit",
  },
  zh: {
    size: "大小",
    small: "小 (S)",
    medium: "中 (M)",
    large: "大 (L)",
    miniMode: "极简模式",
    exitMiniMode: "退出极简模式",
    sleep: "休眠（免打扰）",
    wake: "唤醒 Clawd",
    startOnLogin: "开机自启",
    startWithClaude: "随 Claude Code 启动",
    showInMenuBar: "在菜单栏显示",
    showInDock: "在 Dock 显示",
    language: "语言",
    checkForUpdates: "检查更新",
    checkingForUpdates: "正在检查更新…",
    updateAvailable: "发现新版本",
    updateAvailableMsg: "v{version} 已发布，是否下载并安装？",
    updateAvailableMacMsg: "v{version} 已发布，是否打开下载页面？",
    updateNotAvailable: "已是最新版本",
    updateNotAvailableMsg: "Clawd v{version} 已是最新版本。",
    updateDownloading: "正在下载更新…",
    updateReady: "更新就绪",
    updateReadyMsg: "v{version} 已下载完成，是否立即重启以完成更新？",
    updateError: "更新失败",
    updateErrorMsg: "检查更新失败，请稍后再试。",
    restartNow: "立即重启",
    restartLater: "稍后",
    download: "下载",
    bubbleFollow: "气泡跟随宠物",
    sessions: "会话",
    noSessions: "无活跃会话",
    sessionWorking: "工作中",
    sessionThinking: "思考中",
    sessionJuggling: "多任务",
    sessionIdle: "空闲",
    sessionSleeping: "睡眠",
    sessionJustNow: "刚刚",
    sessionMinAgo: "{n}分钟前",
    sessionHrAgo: "{n}小时前",
    quit: "退出",
  },
};

module.exports = function initMenu(ctx) {
  // ── Translation helper ──
  function t(key) {
    return (i18n[ctx.lang] || i18n.en)[key] || key;
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

  function setShowTray(val) {
    // Prevent disabling both Menu Bar and Dock — app would become unquittable
    if (!val && !ctx.showDock) return;
    ctx.showTray = val;
    if (ctx.showTray) {
      createTray();
    } else {
      destroyTray();
    }
    buildContextMenu();
    ctx.savePrefs();
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

  function setShowDock(val) {
    if (!isMac || !app.dock) return;
    // Prevent disabling both Dock and Menu Bar — app would become unquittable
    if (!val && !ctx.showTray) return;
    ctx.showDock = val;
    applyDockVisibility();
    buildTrayMenu();
    buildContextMenu();
    ctx.savePrefs();
  }

  function buildTrayMenu() {
    if (!ctx.tray) return;
    const items = [
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      {
        label: t("bubbleFollow"),
        type: "checkbox",
        checked: ctx.bubbleFollowPet,
        click: (menuItem) => {
          ctx.bubbleFollowPet = menuItem.checked;
          if (ctx.pendingPermissions.length) ctx.repositionBubbles();
          buildContextMenu();
          buildTrayMenu();
          ctx.savePrefs();
        },
      },
      { type: "separator" },
      {
        label: t("startOnLogin"),
        type: "checkbox",
        checked: isLinux ? linuxGetOpenAtLogin() : app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          if (isLinux) {
            linuxSetOpenAtLogin(menuItem.checked);
          } else {
            app.setLoginItemSettings({ openAtLogin: menuItem.checked });
          }
          buildTrayMenu();
          buildContextMenu();
        },
      },
      {
        label: t("startWithClaude"),
        type: "checkbox",
        checked: ctx.autoStartWithClaude,
        click: (menuItem) => {
          ctx.autoStartWithClaude = menuItem.checked;
          try {
            const { registerHooks, unregisterAutoStart } = require("../hooks/install.js");
            if (ctx.autoStartWithClaude) {
              registerHooks({ silent: true, autoStart: true, port: ctx.getHookServerPort() });
            } else {
              unregisterAutoStart();
            }
          } catch (err) {
            console.warn("Clawd: failed to toggle auto-start hook:", err.message);
          }
          ctx.savePrefs();
          buildTrayMenu();
          buildContextMenu();
        },
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
          click: (menuItem) => setShowTray(menuItem.checked),
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => setShowDock(menuItem.checked),
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
          { label: "English", type: "radio", checked: ctx.lang === "en", click: () => setLanguage("en") },
          { label: "中文", type: "radio", checked: ctx.lang === "zh", click: () => setLanguage("zh") },
        ],
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

  function buildContextMenu() {
    const template = [
      {
        label: t("size"),
        submenu: [
          { label: t("small"), type: "radio", checked: ctx.currentSize === "S", click: () => resizeWindow("S") },
          { label: t("medium"), type: "radio", checked: ctx.currentSize === "M", click: () => resizeWindow("M") },
          { label: t("large"), type: "radio", checked: ctx.currentSize === "L", click: () => resizeWindow("L") },
        ],
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
          click: (menuItem) => setShowTray(menuItem.checked),
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => setShowDock(menuItem.checked),
        },
      );
    }
    template.push(
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

  function setLanguage(newLang) {
    ctx.lang = newLang;
    rebuildAllMenus();
    ctx.savePrefs();
  }

  function resizeWindow(sizeKey) {
    ctx.currentSize = sizeKey;
    const size = SIZES[sizeKey];
    if (!ctx.miniHandleResize(sizeKey)) {
      if (ctx.win && !ctx.win.isDestroyed()) {
        const { x, y } = ctx.win.getBounds();
        const clamped = ctx.clampToScreen(x, y, size.width, size.height);
        ctx.win.setBounds({ ...clamped, width: size.width, height: size.height });
      }
    }
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length) ctx.repositionBubbles();
    buildContextMenu();
    ctx.savePrefs();
  }

  return {
    t,
    buildContextMenu,
    buildTrayMenu,
    rebuildAllMenus,
    createTray,
    destroyTray,
    setShowTray,
    applyDockVisibility,
    setShowDock,
    ensureContextMenuOwner,
    popupMenuAt,
    showPetContextMenu,
    setLanguage,
    resizeWindow,
    requestAppQuit,
  };
};
