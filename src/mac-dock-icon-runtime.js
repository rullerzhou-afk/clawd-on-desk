"use strict";

const TAHOE_MAJOR_VERSION = 26;

function parseMacOSMajorVersion(systemVersion) {
  if (typeof systemVersion !== "string") return null;
  const value = systemVersion.trim();
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  const major = Number.parseInt(value.split(".", 1)[0], 10);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

function shouldInstallRuntimeDockIcon({ platform, isPackaged, systemVersion } = {}) {
  if (platform !== "darwin") return false;
  if (isPackaged !== true) return true;
  const major = parseMacOSMajorVersion(systemVersion);
  // Unknown macOS versions retain the historical padded icon. This is the
  // compatible fallback: only a positively identified Tahoe+ packaged build
  // opts into the system-rendered bundle icon.
  if (major === null) return true;
  return major < TAHOE_MAJOR_VERSION;
}

function resolveRuntimeDockIconPolicy({
  platform = process.platform,
  isPackaged = false,
  getSystemVersion = () => "",
} = {}) {
  if (platform !== "darwin") return false;
  if (isPackaged !== true) return true;
  let systemVersion = "";
  try {
    systemVersion = getSystemVersion();
  } catch {
    systemVersion = "";
  }
  return shouldInstallRuntimeDockIcon({ platform, isPackaged, systemVersion });
}

function warn(logWarn, message, err) {
  try {
    logWarn(message, err && err.message ? err.message : err);
  } catch {}
}

function installStartupDockIcon({
  dock = null,
  showDock = true,
  dockIconPath = null,
  installRuntimeIcon = false,
  logWarn = (...args) => console.warn(...args),
} = {}) {
  if (showDock === false || installRuntimeIcon !== true) return false;
  if (!dock || typeof dock.setIcon !== "function" || !dockIconPath) return false;
  try {
    dock.setIcon(dockIconPath);
    return true;
  } catch (err) {
    warn(logWarn, "Clawd: failed to install startup macOS Dock icon:", err);
    return false;
  }
}

module.exports = {
  TAHOE_MAJOR_VERSION,
  installStartupDockIcon,
  parseMacOSMajorVersion,
  resolveRuntimeDockIconPolicy,
  shouldInstallRuntimeDockIcon,
};
