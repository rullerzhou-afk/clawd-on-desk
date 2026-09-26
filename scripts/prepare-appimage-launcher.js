"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateAppRunScript } = require("app-builder-lib/out/targets/appimage/appImageUtil");
const { validateAppRunContent } = require("./verify-appimage-apprun");

const PREFIX = `# Clawd AppImage lifetime guard (#1048). Start Electron from regular files.
# Manual AppDir/extract-and-run launches already have regular backing files.
if [[ -n "\${APPIMAGE:-}" && -n "\${APPDIR:-}" ]]; then
  clawd_fs_type=$(command -p stat -f -c %T -- "$APPDIR") || exit 1
  if [[ "$clawd_fs_type" == fuseblk ]]; then
    clawd_launcher=$(command -p cat -- "$APPDIR/clawd-appimage-launcher.sh") || exit 1
    exec /bin/bash -c "$clawd_launcher" clawd-appimage-supervisor "$APPDIR" "$APPIMAGE" "$@"
  fi
fi
`;

function prepareAppImageLauncher(context) {
  if (context.electronPlatformName !== "linux") return null;
  const config = context.packager.config;
  if ((config.appImage && config.appImage.license) || (config.linux && config.linux.license)) {
    throw new Error("AppImage launcher guard needs review before enabling a package license prompt");
  }
  const executableName = context.packager.executableName;
  if (!/^[A-Za-z0-9_.-]+$/.test(executableName)) {
    throw new Error("Unsupported AppImage executable name");
  }
  const appInfo = context.packager.appInfo;
  const original = generateAppRunScript({
    DesktopFileName: `${executableName}.desktop`,
    ExecutableName: executableName,
    ProductName: appInfo.productName,
    ProductFilename: appInfo.productFilename,
    ResourceName: `appimagekit-${executableName}`,
  });
  const content = original.replace("set -e\n", `set -e\n\n${PREFIX}\n`);
  if (!content.includes(PREFIX)) throw new Error("AppRun template changed; cannot install the lifetime guard");
  // Preserve the existing security gate on all path exports.
  validateAppRunContent(content);
  // electron-builder writes its default launcher to the AppImage staging
  // directory, then copies appOutDir over it. The final-artifact gate verifies
  // that this override and the exact supervisor survived that packaging step.
  fs.writeFileSync(path.join(context.appOutDir, "AppRun"), content, { mode: 0o755 });
  fs.copyFileSync(
    path.join(__dirname, "../build/appimage-launcher.sh"),
    path.join(context.appOutDir, "clawd-appimage-launcher.sh"),
  );
  return { appRun: path.join(context.appOutDir, "AppRun") };
}

module.exports = { PREFIX, prepareAppImageLauncher };
