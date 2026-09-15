"use strict";

// Native host for the single Dashboard page.
//
// darwin/win32 need the page to move between an ordinary window and a
// non-activating quick host, which is only possible when the page lives in an
// explicit `WebContentsView` that an owner can re-parent. Those platforms
// therefore build the ordinary host as `BaseWindow` + `WebContentsView`.
//
// Linux keeps the historical `BrowserWindow`: the quick host is not offered
// there (opacity parking is a documented no-op on Linux), so there is nothing
// to re-parent and no reason to take on the migration.
//
// Everything above the host talks to this uniform shape, so the geometry and
// page code in dashboard.js never branches on platform:
//   window        native window (BaseWindow or BrowserWindow)
//   webContents   the one and only Dashboard WebContents
//   view          WebContentsView on darwin/win32, null on Linux
//   onceFirstPaint(cb)  BaseWindow has no `ready-to-show`; the view path waits
//                       on the real WebContents load instead.

const VIEW_PLATFORMS = new Set(["darwin", "win32"]);

function usesWebContentsView(platform) {
  return VIEW_PLATFORMS.has(platform);
}

function splitWindowOptions(options) {
  const { webPreferences, ...windowOptions } = options || {};
  return { webPreferences: webPreferences || {}, windowOptions };
}

function isLive(win) {
  return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
}

function createDashboardHost(config = {}) {
  const platform = config.platform || process.platform;
  const electron = config.electron || {};
  const { webPreferences, windowOptions } = splitWindowOptions(config.windowOptions);

  if (!usesWebContentsView(platform)) {
    const BrowserWindow = electron.BrowserWindow;
    const window = new BrowserWindow({ ...windowOptions, webPreferences });
    return {
      platform,
      usesView: false,
      window,
      view: null,
      webContents: window.webContents,
      onceFirstPaint(callback) {
        window.once("ready-to-show", callback);
      },
      loadFile(filePath) {
        return window.loadFile(filePath);
      },
      // BrowserWindow lays its own page out and is never re-parented.
      syncViewBounds() {},
      getHostedWindow: () => window,
      setHostedWindow() {},
      closeWebContents() {},
    };
  }

  const { BaseWindow, WebContentsView } = electron;
  const window = new BaseWindow(windowOptions);
  const view = new WebContentsView({ webPreferences });
  window.contentView.addChildView(view);
  // Which window currently holds the view. While the quick host has borrowed
  // it, an ordinary-host resize must not re-lay the page out to the ordinary
  // host's size — the page is not in that window.
  let hostedWindow = window;

  function layoutIn(target) {
    if (!isLive(target) || !view) return;
    let size = null;
    try {
      size = target.getContentSize();
    } catch {
      size = null;
    }
    if (!Array.isArray(size) || size.length < 2) return;
    try {
      view.setBounds({ x: 0, y: 0, width: size[0], height: size[1] });
    } catch {}
  }

  function syncViewBounds() {
    layoutIn(hostedWindow);
  }

  layoutIn(window);
  window.on("resize", () => {
    if (hostedWindow !== window) return;
    layoutIn(window);
  });

  return {
    platform,
    usesView: true,
    window,
    view,
    webContents: view.webContents,
    // `ready-to-show` is a BrowserWindow event and never fires on BaseWindow;
    // listening for it here would leave the window permanently hidden.
    onceFirstPaint(callback) {
      view.webContents.once("did-finish-load", callback);
    },
    loadFile(filePath) {
      return view.webContents.loadFile(filePath);
    },
    syncViewBounds,
    getHostedWindow: () => hostedWindow,
    // Records the window that now owns the view and lays the page out in it.
    setHostedWindow(target) {
      hostedWindow = target || window;
      layoutIn(hostedWindow);
    },
    // A BaseWindow closing does not end the WebContents lifetime; the owner
    // closes the single WebContents exactly once on teardown.
    closeWebContents() {
      const contents = view && view.webContents;
      if (!contents) return;
      if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return;
      try { contents.close(); } catch {}
    },
  };
}

module.exports = {
  createDashboardHost,
  usesWebContentsView,
};
