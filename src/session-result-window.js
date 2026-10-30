"use strict";
const path = require("node:path");
const { computeSessionResultBounds } = require("./session-result-layout");
const { getSessionResultDictionary } = require("./session-result-i18n");
const { applyZoomToWindow, clampTextScale } = require("./text-scale");
const { keepOutOfTaskbar } = require("./taskbar");

function createSessionResultWindow(ctx) {
  const { BrowserWindow, ipcMain, store, focus } = ctx;
  let win = null;
  let loaded = false;
  let disposed = false;
  let scheduled = null;
  let desiredHeight = 520;
  let fullscreenSuppressed = false;
  let windowGeneration = 0;
  const attempts = new Set();
  function payload() {
    const lang = ctx.getLang();
    return {
      lang, dictionary: getSessionResultDictionary(lang),
      cards: store.list().map(card => ({
        id: card.id, generation: card.generation, kind: card.kind, at: card.at,
        title: card.title, agentName: card.agentName, opening: card.opening,
        notice: card.notice, canOpen: focus.canOpen(card),
      })),
    };
  }
  function validSender(event) {
    return !!win && !win.isDestroyed() && event.sender === win.webContents
      && event.senderFrame === win.webContents.mainFrame;
  }
  function validCard(event, request) {
    if (!validSender(event) || !request || typeof request.id !== "string"
      || request.id.length > 64 || !Number.isSafeInteger(request.generation)) return null;
    return store.find(request.id, request.generation);
  }
  function geometryChanged() { if (ctx.onGeometryChanged) ctx.onGeometryChanged(); }
  function hide() {
    if (win && !win.isDestroyed() && win.isVisible()) { win.hide(); geometryChanged(); }
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return;
    loaded = false;
    windowGeneration++;
    win = new BrowserWindow({
      width: 340, height: 520, show: false, frame: false, transparent: true,
      resizable: false, maximizable: false, minimizable: false, skipTaskbar: true,
      hasShadow: false, focusable: false, alwaysOnTop: process.platform !== "darwin",
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      ...(process.platform === "linux" ? { type: "toolbar" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-result.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    if (process.platform === "win32") win.setAlwaysOnTop(true, "pop-up-menu");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("did-finish-load", () => { loaded = true; schedule(); });
    win.on("closed", () => {
      windowGeneration++;
      win = null; loaded = false;
      for (const card of store.list()) {
        if (card.opening) store.update(card.id, card.generation, { opening: false });
      }
      geometryChanged();
    });
    if (ctx.guardAlwaysOnTop) ctx.guardAlwaysOnTop(win);
    void win.loadFile(path.join(__dirname, "session-result.html")).catch(error => {
      console.warn("Session result window failed to load:", error && error.message);
      if (win && !win.isDestroyed()) win.destroy();
    });
  }
  function sync(hiddenOverride) {
    if (disposed) return;
    const cards = store.list();
    if (!cards.length || fullscreenSuppressed || ctx.isSuppressed(hiddenOverride)) { hide(); return; }
    const layout = ctx.getLayout();
    if (!layout) { hide(); return; }
    const scale = clampTextScale(layout.scale);
    const bounds = computeSessionResultBounds({ ...layout, scale, desiredHeight });
    if (!bounds) { hide(); return; }
    ensureWindow();
    if (!loaded) return;
    applyZoomToWindow(win, scale);
    const before = win.getBounds();
    const wasVisible = win.isVisible();
    if (JSON.stringify(before) !== JSON.stringify(bounds)) win.setBounds(bounds);
    win.webContents.send("session-result:change", payload());
    if (!wasVisible) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (ctx.reapplyMacVisibility) ctx.reapplyMacVisibility();
    }
    if (!wasVisible || JSON.stringify(before) !== JSON.stringify(bounds)) geometryChanged();
  }
  function schedule() {
    if (disposed || scheduled) return;
    scheduled = setImmediate(() => { scheduled = null; sync(); });
  }
  ipcMain.handle("session-result:ready", event => validSender(event) ? payload() : null);
  ipcMain.handle("session-result:dismiss", (event, request) => {
    const card = validCard(event, request);
    return !!card && store.dismiss(card.id, card.generation);
  });
  ipcMain.handle("session-result:open", async (event, request) => {
    const card = validCard(event, request);
    if (!card || card.opening) return false;
    const openingWindowGeneration = windowGeneration;
    store.update(card.id, card.generation, { opening: true, notice: null });
    let timeout;
    let cancel;
    const cancelled = new Promise(resolve => {
      cancel = () => resolve("unconfirmed");
      attempts.add(cancel);
      timeout = setTimeout(cancel, 10000);
      timeout.unref?.();
    });
    let result;
    try { result = await Promise.race([focus.open(card), cancelled]); }
    catch { result = "failed"; }
    finally { clearTimeout(timeout); attempts.delete(cancel); }
    if (disposed || openingWindowGeneration !== windowGeneration) return false;
    if (result === "opened") store.dismiss(card.id, card.generation);
    else store.update(card.id, card.generation, { opening: false, notice: result });
    return true;
  });
  function measure(event, height) {
    if (!validSender(event) || !Number.isFinite(height) || height < 80 || height > 5000) return;
    const next = Math.max(120, Math.min(520, Math.ceil(height)));
    if (next !== desiredHeight) { desiredHeight = next; schedule(); }
  }
  ipcMain.on("session-result:height", measure);
  function dispose() {
    disposed = true;
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    for (const cancel of attempts) cancel();
    for (const channel of ["ready", "dismiss", "open"]) ipcMain.removeHandler("session-result:" + channel);
    ipcMain.removeListener("session-result:height", measure);
    if (win && !win.isDestroyed()) win.destroy();
  }
  return {
    schedule, sync, hide, dispose,
    getWindow: () => win,
    getBounds: () => win && !win.isDestroyed() && win.isVisible() ? win.getBounds() : null,
    setFullscreenSuppressed: value => { fullscreenSuppressed = value === true; sync(); },
  };
}
module.exports = { createSessionResultWindow };
