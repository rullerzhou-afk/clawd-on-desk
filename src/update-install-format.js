const fs = require("fs");
const path = require("path");

// APPIMAGE is inherited by child processes, including other Electron apps.
// Only use it when this app's resources belong to the indicated mount.
function getUpdateInstallFormat({ platform, isPackaged, resourcesPath, env = process.env, fsApi = fs }) {
  if (platform !== "linux" || !isPackaged) return "native";
  const absolute = (value) => typeof value === "string" &&
    !value.includes("\0") && path.posix.isAbsolute(value);
  if (absolute(env.APPIMAGE) && absolute(env.APPDIR) && absolute(resourcesPath)) {
    const mount = path.posix.normalize(env.APPDIR);
    const relative = path.posix.relative(mount, resourcesPath);
    if (mount !== "/" && relative && relative !== ".." &&
        !relative.startsWith("../") && !path.posix.isAbsolute(relative)) return "appimage";
  }
  try {
    if (absolute(resourcesPath) &&
        fsApi.readFileSync(path.posix.join(resourcesPath, "package-type"), "utf8").trim() === "deb") {
      return "deb";
    }
  } catch { /* Unknown installations get a manual update, never a guessed installer. */ }
  return "manual";
}

module.exports = { getUpdateInstallFormat };
