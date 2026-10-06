// Tray flash icons (#722).
//
// The completion flash blinks the menu bar / taskbar icon between the normal
// icon and a completion mark. macOS uses two natural 18pt Template pairs
// (18×18 plus @2x siblings), so both frames inherit system contrast and occupy
// an identical menu-bar slot. Windows/Linux retain the existing 32px orange
// completion dot.
//
// Windows / Linux trays work in raw pixels and both assets are normalised to
// 32×32 there.

const TRAY_PIXEL_SIZE = 32; // Windows / Linux trays work in pixels

function loadTrayNormalIcon({ nativeImage, platform, templatePath, iconPath }) {
  if (platform === "darwin") {
    const icon = nativeImage.createFromPath(templatePath);
    icon.setTemplateImage(true);
    return icon;
  }
  return nativeImage
    .createFromPath(iconPath)
    .resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
}

function loadTrayFlashIcon({ nativeImage, platform, flashPath, flashTemplatePath, fileExists }) {
  const sourcePath = platform === "darwin" ? flashTemplatePath : flashPath;
  if (!sourcePath || !fileExists(sourcePath)) return null;

  const src = nativeImage.createFromPath(sourcePath);
  if (!src || src.isEmpty()) return null;

  if (platform === "darwin") {
    src.setTemplateImage(true);
    return src;
  }
  return src.resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
}

module.exports = { loadTrayNormalIcon, loadTrayFlashIcon, TRAY_PIXEL_SIZE };
