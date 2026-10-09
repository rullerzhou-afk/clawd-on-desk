"use strict";

const path = require("path");

const WINDOWS_APP_USER_MODEL_ID = "com.clawd.on-desk";
const SETTINGS_WINDOW_TITLE = "Clawd Settings";
const SETTINGS_WINDOW_LAUNCH_ARG = "--open-settings-window";

function quoteWindowsCommandArg(value) {
  const text = String(value || "");
  return `"${text.replace(/"/g, '\\"')}"`;
}

function shouldOpenSettingsWindowFromArgv(argv) {
  return Array.isArray(argv) && argv.includes(SETTINGS_WINDOW_LAUNCH_ARG);
}

function getSettingsWindowIconPath({
  platform,
  isPackaged,
  resourcesPath,
  appDir,
  existsSync,
}) {
  if (platform === "darwin") return undefined;
  if (platform !== "win32") return undefined;

  const hasFile = typeof existsSync === "function" ? existsSync : () => true;
  const candidates = [];

  if (isPackaged) {
    candidates.push(
      path.join(resourcesPath || "", "app.asar.unpacked", "assets", "icons", "256x256.png"),
      path.join(resourcesPath || "", "app.asar", "assets", "icons", "256x256.png"),
      path.join(resourcesPath || "", "icon.ico")
    );
  } else {
    candidates.push(
      path.join(appDir || "", "assets", "icons", "256x256.png"),
      path.join(appDir || "", "assets", "icon.ico")
    );
  }

  return candidates.find((candidate) => candidate && hasFile(candidate));
}

function getWindowsShellIconPath({
  isPackaged,
  resourcesPath,
  appDir,
  execPath,
  existsSync,
}) {
  const hasFile = typeof existsSync === "function" ? existsSync : () => true;
  const candidates = isPackaged
    ? [
        path.join(resourcesPath || "", "icon.ico"),
        execPath,
      ]
    : [
        path.join(appDir || "", "assets", "icon.ico"),
      ];

  return candidates.find((candidate) => candidate && hasFile(candidate));
}

function getSettingsWindowTaskbarDetails({
  platform,
  isPackaged,
  resourcesPath,
  appDir,
  execPath,
  appPath,
  existsSync,
}) {
  if (platform !== "win32") return null;

  const appIconPath = getWindowsShellIconPath({
    isPackaged,
    resourcesPath,
    appDir,
    execPath,
    existsSync,
  }) || getSettingsWindowIconPath({
    platform,
    isPackaged,
    resourcesPath,
    appDir,
    existsSync,
  });

  const relaunchParts = [execPath];
  if (!isPackaged && appPath) relaunchParts.push(appPath);
  relaunchParts.push(SETTINGS_WINDOW_LAUNCH_ARG);
  const relaunchCommand = relaunchParts
    .filter(Boolean)
    .map(quoteWindowsCommandArg)
    .join(" ");

  return {
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath,
    appIconIndex: 0,
    relaunchCommand,
    relaunchDisplayName: SETTINGS_WINDOW_TITLE,
  };
}

function applyWindowsAppUserModelId(app, platform = process.platform) {
  if (platform !== "win32") return;
  if (!app || typeof app.setAppUserModelId !== "function") return;
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

module.exports = {
  WINDOWS_APP_USER_MODEL_ID,
  SETTINGS_WINDOW_TITLE,
  SETTINGS_WINDOW_LAUNCH_ARG,
  getSettingsWindowIconPath,
  getWindowsShellIconPath,
  getSettingsWindowTaskbarDetails,
  shouldOpenSettingsWindowFromArgv,
  applyWindowsAppUserModelId,
};
