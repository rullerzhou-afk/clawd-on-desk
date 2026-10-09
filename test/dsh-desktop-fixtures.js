"use strict";

const fs = require("node:fs");
const path = require("node:path");

const APP_NAME = "DeepSeek Harness";
const MAC_APP_NAME = "DeepSeek Harness.app";

// A copy of the one recognized upstream apps/desktop/cli/dsh.cmd, kept here so
// the tests do not read the constant the code under test compares against.
const DSH_CMD_TEMPLATE = [
  "@echo off",
  "setlocal DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  "exit /b %errorlevel%",
];

function dshCmdText() {
  return `${DSH_CMD_TEMPLATE.join("\r\n")}\r\n`;
}

// Build the per-user Windows desktop install layout under `root`. On win32 the
// desktop flow re-reads and parses the launcher, so the stub files have to
// exist and the dsh.cmd must carry the upstream template.
function windowsDesktop(root) {
  const appRoot = path.join(root, APP_NAME);
  const binDir = path.join(appRoot, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, `${APP_NAME}.exe`), "exe", "utf8");
  fs.writeFileSync(path.join(appRoot, "resources", "app.asar"), "asar", "utf8");
  const launcherPath = path.join(binDir, "dsh.cmd");
  fs.writeFileSync(launcherPath, dshCmdText(), "utf8");
  return { appRoot, launcherPath };
}

function macDesktop(root) {
  const appRoot = path.join(root, MAC_APP_NAME);
  return {
    appRoot,
    launcherPath: path.join(appRoot, "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
  };
}

// Platform-aware "desktop app found" discovery. Windows points at an on-disk
// launcher the win32 command parser recognizes; other platforms keep the
// macOS-shaped result their desktop flow consumes as-is.
function desktopFound(root, staticVersion = null) {
  const layout = process.platform === "win32" ? windowsDesktop(root) : macDesktop(root);
  return {
    status: "found",
    appRoot: layout.appRoot,
    launcherPath: layout.launcherPath,
    staticVersion,
    checkedPaths: [layout.launcherPath],
    reason: null,
  };
}

// Real DSH creates directory junctions on Windows; symlink type "dir" needs a
// privilege (or Developer Mode) that Windows does not grant by default.
function symlinkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

module.exports = {
  DSH_CMD_TEMPLATE,
  dshCmdText,
  desktopFound,
  symlinkDir,
};
