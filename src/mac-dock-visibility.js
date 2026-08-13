"use strict";

function createMacDockVisibilityCoordinator(options = {}) {
  const app = options.app || null;
  const dock = options.dock || (app && app.dock) || null;
  const dockIconPath = options.dockIconPath || null;
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const reapplyMacVisibility = options.reapplyMacVisibility || (() => {});
  const logWarn = options.logWarn || ((...args) => console.warn(...args));

  let desiredVisible = null;
  let needsDrain = false;
  let activeRun = null;
  let disposed = false;

  function warn(message, err) {
    try {
      logWarn(message, err && err.message ? err.message : err);
    } catch {}
  }

  function installDockIcon() {
    if (!dock || !dockIconPath || typeof dock.setIcon !== "function") return;
    try {
      dock.setIcon(dockIconPath);
    } catch (err) {
      warn("Clawd: failed to install macOS Dock icon:", err);
    }
  }

  function reapplyVisibility() {
    try {
      reapplyMacVisibility();
    } catch (err) {
      warn("Clawd: failed to reapply macOS window visibility after Dock transition:", err);
    }
  }

  function captureFocusedSettingsWindow() {
    try {
      const win = getSettingsWindow();
      if (!win) return null;
      if (typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
      if (typeof win.isVisible === "function" && !win.isVisible()) return null;
      if (typeof win.isFocused !== "function" || !win.isFocused()) return null;
      return win;
    } catch (err) {
      warn("Clawd: failed to inspect Settings focus before Dock transition:", err);
      return null;
    }
  }

  function restoreSettingsFocus(win) {
    if (!win) return;
    try {
      if (app && typeof app.focus === "function") app.focus({ steal: true });
      if (typeof win.focus === "function") win.focus();
    } catch (err) {
      warn("Clawd: failed to preserve Settings focus while hiding Dock:", err);
    }
  }

  function applyNativeVisibility(visible) {
    // Electron's dock.show() deliberately performs two delayed app activations
    // when the app is frontmost. Switching NSApplication activation policy is
    // synchronous and avoids exposing that ~2 second sequence to Settings.
    const focusedSettingsWindow = visible ? null : captureFocusedSettingsWindow();
    // A tray-only launch has no Dock tile to receive the runtime icon. Pin it
    // immediately before and after promotion so the newly-created tile never
    // exposes the app bundle's fallback icon.
    if (visible) installDockIcon();
    if (!app || typeof app.setActivationPolicy !== "function") {
      warn("Clawd: macOS activation policy API is unavailable");
      reapplyVisibility();
      return;
    }
    app.setActivationPolicy(visible ? "regular" : "accessory");
    if (visible) installDockIcon();
    if (!visible) restoreSettingsFocus(focusedSettingsWindow);
    reapplyVisibility();
  }

  function scheduleDrain() {
    if (disposed) return Promise.resolve();
    if (activeRun) return activeRun;
    activeRun = Promise.resolve()
      .then(() => {
        while (needsDrain && !disposed) {
          needsDrain = false;
          const target = desiredVisible;
          try {
            applyNativeVisibility(target);
          } catch (err) {
            warn("Clawd: macOS Dock transition failed:", err);
          }
          needsDrain = desiredVisible !== target;
        }
      })
      .finally(() => {
        activeRun = null;
        if (needsDrain && !disposed) scheduleDrain();
      });
    return activeRun;
  }

  function apply(visible) {
    desiredVisible = !!visible;
    needsDrain = true;
    return scheduleDrain();
  }

  function dispose() {
    disposed = true;
    needsDrain = false;
  }

  return {
    apply,
    dispose,
    getDesiredVisible: () => desiredVisible,
  };
}

module.exports = {
  createMacDockVisibilityCoordinator,
};
