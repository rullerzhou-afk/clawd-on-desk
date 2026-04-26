"use strict";

function shouldKeepOutOfTaskbar(platform = process.platform) {
  return platform === "win32" || platform === "linux";
}

// Some shells/window managers can lose the BrowserWindow creation-time
// skipTaskbar flag after showInactive() or taskbar/shell restart. Reassert it
// for floating Clawd windows whenever they are shown without activation, and
// from Windows' shell-state watchdog while they remain visible.
function keepOutOfTaskbar(w) {
  if (!w || w.isDestroyed()) return;
  if (shouldKeepOutOfTaskbar() && typeof w.setSkipTaskbar === "function") {
    w.setSkipTaskbar(true);
  }
}

module.exports = {
  keepOutOfTaskbar,
  __test: {
    shouldKeepOutOfTaskbar,
  },
};
