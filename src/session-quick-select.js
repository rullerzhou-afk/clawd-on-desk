"use strict";

const { BrowserWindow, nativeTheme, screen } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { clampTextScale, applyZoomToWindow } = require("./text-scale");
const createOriginFocus = require("./quick-select-origin-focus");

const PAGE_PATH = path.join(__dirname, "session-quick-select.html");
const PAGE_URL = pathToFileURL(PAGE_PATH).toString();

function orderedCandidates(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const ids = [
    ...(Array.isArray(snapshot.groups) ? snapshot.groups : []).flatMap((group) => group.ids || []),
    ...(snapshot.orderedIds || []),
    ...sessions.map((entry) => entry.id),
  ];
  return [...new Set(ids)].map((id) => byId.get(id))
    .filter((entry) => entry && entry.canFocus === true).slice(0, 9);
}

// A separate owner keeps transient keyboard navigation out of the management
// Dashboard. The main process owns the frozen IDs as well as fresh eligibility.
module.exports = function initSessionQuickSelect(ctx) {
  const ipcMain = ctx.ipcMain;
  const platform = ctx.platform || process.platform;
  const originFocus = ctx.originFocus || createOriginFocus({ platform });
  let origin = null;
  let win = null;
  let wantsVisible = false;
  let awaitingShow = false;
  let rendererReady = false;
  let paintReady = false;
  let pendingIntent = false;
  let submitted = false;
  let revision = 0;
  let mappedEntries = [];
  const channels = [];

  const snapshot = () => ctx.getSessionSnapshot() || { sessions: [] };
  const i18n = () => ctx.getI18n();
  const liveWindow = () => win && !win.isDestroyed() ? win : null;
  const background = () => nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7";
  const scaleFor = (bounds) => clampTextScale(ctx.getTextScale ? ctx.getTextScale(bounds) : 1);

  function send(channel, payload) {
    const current = liveWindow();
    if (current && !current.webContents.isDestroyed()) current.webContents.send(channel, payload);
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      title: entry.displayTitle || entry.sessionTitle || entry.id,
      agentName: entry.agentName || entry.agentId || "",
      badge: entry.badge || "idle",
      canFocus: entry.canFocus === true,
    };
  }

  function currentEntries(nextSnapshot = snapshot()) {
    const byId = new Map((nextSnapshot.sessions || []).map((entry) => [entry.id, entry]));
    return mappedEntries.map((previous) => {
      const current = byId.get(previous.id);
      return current ? publicEntry(current) : { ...previous, canFocus: false };
    });
  }

  function dismiss(restoreOrigin = false) {
    const previousOrigin = origin;
    origin = null;
    wantsVisible = false;
    awaitingShow = false;
    pendingIntent = false;
    submitted = false;
    mappedEntries = [];
    revision += 1;
    send("quick-select:dismissed", { revision });
    const current = liveWindow();
    if (restoreOrigin && current) originFocus.restore(previousOrigin, current);
    if (current && current.isVisible()) current.hide();
    return { status: "ok" };
  }

  function showWhenReady() {
    const current = liveWindow();
    if (!current || !wantsVisible || !awaitingShow || !rendererReady || !paintReady) return;
    awaitingShow = false;
    current.show();
    current.focus();
  }

  function placement() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const scale = scaleFor(area);
    const width = Math.min(area.width, Math.round(480 * scale));
    const rows = Math.max(1, mappedEntries.length || orderedCandidates(snapshot()).length);
    // Include the native frame and footer, so all nine rows fit without an
    // accidental scrollbar at the normal scale. Small work areas may scroll.
    const height = Math.min(area.height, Math.ceil((170 + rows * 58) * scale));
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    };
  }

  function createWindow() {
    const bounds = placement();
    const created = new BrowserWindow({
      ...bounds,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: false,
      // Windows tool windows can take keyboard focus without entering Alt+Tab.
      // macOS panels take key focus without activating the app in show()/focus().
      // This keeps Clawd out of the Cmd+Tab return path even with its Dock tile
      // visible. Keep the panel open until native blur completes the handoff.
      skipTaskbar: platform !== "darwin",
      ...(platform === "win32" ? { type: "toolbar" } : {}),
      ...(platform === "darwin" ? { type: "panel" } : {}),
      title: ctx.t("dashboardQuickSelectTitle"),
      backgroundColor: background(),
      ...(ctx.iconPath ? { icon: ctx.iconPath } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-quick-select.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win = created;
    created.setMenuBarVisibility(false);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (created !== win || !isMainFrame || isInPlace) return;
      rendererReady = false;
      paintReady = false;
      pendingIntent = wantsVisible;
      awaitingShow = wantsVisible;
      mappedEntries = [];
      submitted = false;
      revision += 1;
    });
    // Register the zoom helper's reload invalidation before our load callback.
    applyZoomToWindow(created, scaleFor(bounds));
    created.webContents.on("did-finish-load", () => {
      if (created !== win) return;
      paintReady = true;
      applyZoomToWindow(created, scaleFor(created.getBounds()));
      showWhenReady();
    });
    created.webContents.on("render-process-gone", () => {
      if (created !== win) return;
      dismiss();
      created.destroy();
    });
    // Hiding only after native focus leaves the palette preserves the target
    // handoff. A dispatch acknowledgement is never a reason to hide it early.
    created.on("blur", () => {
      if (created === win && wantsVisible) dismiss();
    });
    created.on("close", () => {
      if (created === win && wantsVisible) dismiss(true);
    });
    created.on("closed", () => {
      if (created !== win) return;
      win = null;
      rendererReady = false;
      paintReady = false;
      dismiss();
    });
    created.loadFile(PAGE_PATH);
    return created;
  }

  function show() {
    origin = originFocus.capture(liveWindow(), origin);
    wantsVisible = true;
    awaitingShow = true;
    pendingIntent = true;
    submitted = false;
    mappedEntries = [];
    revision += 1;
    const current = liveWindow() || createWindow();
    current.setBounds(placement());
    applyZoomToWindow(current, scaleFor(current.getBounds()));
    if (rendererReady) send("quick-select:intent");
    return current;
  }

  function trusted(event) {
    const current = liveWindow();
    return !!current && !current.webContents.isDestroyed()
      && event && event.sender === current.webContents
      && event.senderFrame === current.webContents.mainFrame
      && event.senderFrame.url === PAGE_URL;
  }

  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => trusted(event)
      ? fn(...args)
      : { status: "rejected", reason: "untrusted-quick-select-sender" });
    channels.push(channel);
  }

  handle("quick-select:consume-intent", () => {
    rendererReady = true;
    const enterQuickSelect = pendingIntent && wantsVisible;
    pendingIntent = false;
    if (enterQuickSelect) mappedEntries = orderedCandidates(snapshot()).map(publicEntry);
    showWhenReady();
    return { status: "ok", enterQuickSelect, revision, entries: currentEntries(), i18n: i18n() };
  });

  handle("quick-select:dismiss", () => dismiss(true));

  handle("quick-select:activate-session", (payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [];
    if (keys.length !== 1 || keys[0] !== "sessionId" || typeof payload.sessionId !== "string" || !payload.sessionId) {
      return { status: "rejected", reason: "invalid-payload" };
    }
    if (!wantsVisible || !rendererReady || !liveWindow().isFocused()) {
      return { status: "rejected", reason: "quick-select-inactive" };
    }
    if (submitted) return { status: "rejected", reason: "dropped-duplicate" };
    const entry = currentEntries().find((entry) => entry.id === payload.sessionId);
    if (!entry || !entry.canFocus) return { status: "rejected", reason: "focus-unavailable" };
    let result;
    try {
      result = ctx.focusSession(payload.sessionId, { requestSource: "quick-select" });
    } catch {
      return { status: "rejected", reason: "focus-threw" };
    }
    const reason = result && result.reason;
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch((err) => console.warn("Quick select focus request failed:", err));
    } else if (result !== true && !["submitted", "queued", "linux-command-submitted"].includes(reason)) {
      return { status: "rejected", reason: reason || "focus-unavailable" };
    }
    submitted = true;
    return { status: "submitted" };
  });

  function sendI18n() {
    const current = liveWindow();
    if (current) current.setTitle(ctx.t("dashboardQuickSelectTitle"));
    send("quick-select:lang-change", i18n());
  }
  function syncTheme() {
    const current = liveWindow();
    if (current) current.setBackgroundColor(background());
  }
  nativeTheme.on("updated", syncTheme);

  return {
    show,
    dismiss,
    getWindow: liveWindow,
    sendI18n,
    broadcastSessionSnapshot(nextSnapshot) {
      if (wantsVisible && rendererReady) send("quick-select:snapshot", { revision, entries: currentEntries(nextSnapshot) });
    },
    applyTextScaleToWindow() {
      const current = liveWindow();
      if (current) {
        current.setBounds(placement());
        applyZoomToWindow(current, scaleFor(current.getBounds()));
      }
    },
    dispose() {
      for (const channel of channels) ipcMain.removeHandler(channel);
      nativeTheme.removeListener("updated", syncTheme);
      const current = liveWindow();
      if (current) current.destroy();
    },
  };
};
