"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function quoteDesktopArg(arg) {
  if (/^[A-Za-z0-9_./:+-]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/(["\\])/g, "\\$1")}"`;
}

function buildLinuxExec(app) {
  const args = [process.execPath];
  if (!app.isPackaged) args.push(app.getAppPath());
  return args.map(quoteDesktopArg).join(" ");
}

function getLinuxAutostartPath() {
  return path.join(os.homedir(), ".config", "autostart", "clawd-on-desk.desktop");
}

function buildLinuxDesktopEntry(app) {
  const exec = buildLinuxExec(app);
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Clawd on Desk",
    "Comment=Clawd desktop pet",
    `Exec=${exec}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function getOpenAtLoginEnabled(app) {
  if (process.platform === "linux") {
    return fs.existsSync(getLinuxAutostartPath());
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(app, enabled) {
  if (process.platform === "linux") {
    const filePath = getLinuxAutostartPath();
    if (!enabled) {
      try { fs.unlinkSync(filePath); } catch {}
      return;
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buildLinuxDesktopEntry(app), "utf8");
    return;
  }

  app.setLoginItemSettings({ openAtLogin: !!enabled });
}

module.exports = function initAutoStart(app) {
  return {
    getOpenAtLoginEnabled: () => getOpenAtLoginEnabled(app),
    setOpenAtLogin: (enabled) => setOpenAtLogin(app, enabled),
  };
};

