"use strict";

const path = require("path");

const WINDOWS_APP_USER_MODEL_ID = "com.clawd.on-desk";

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

function applyWindowsAppUserModelId(app, platform = process.platform) {
  if (platform !== "win32") return;
  if (!app || typeof app.setAppUserModelId !== "function") return;
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

module.exports = {
  WINDOWS_APP_USER_MODEL_ID,
  getSettingsWindowIconPath,
  applyWindowsAppUserModelId,
};
