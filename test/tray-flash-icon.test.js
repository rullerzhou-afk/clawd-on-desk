const test = require("node:test");
const assert = require("node:assert");

const { loadTrayNormalIcon, loadTrayFlashIcon } = require("../src/tray-flash-icon");

// Minimal nativeImage stand-in: records what was asked of it so the tests can
// assert on the sizing decisions rather than on real pixels.
function makeNativeImage({ empty = false } = {}) {
  const calls = { created: [], resizes: [] };

  function makeImage({ isEmptyValue }) {
    return {
      isEmpty: () => isEmptyValue(),
      setTemplateImage(value) { this.template = value; },
      resize(size) {
        calls.resizes.push(size);
        return { ...this, size };
      },
    };
  }

  return {
    calls,
    createFromPath(p) {
      calls.created.push(p);
      return makeImage({ isEmptyValue: () => empty });
    },
  };
}

const PATHS = {
  templatePath: "/assets/tray-iconTemplate.png",
  iconPath: "/assets/icon.png",
  flashPath: "/assets/tray-icon-flash.png",
  flashTemplatePath: "/assets/tray-icon-flashTemplate.png",
};

test("mac normal icon is loaded as a template image at its natural point size", () => {
  const nativeImage = makeNativeImage();
  const icon = loadTrayNormalIcon({ nativeImage, platform: "darwin", ...PATHS });

  assert.strictEqual(icon.template, true);
  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.templatePath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, [], "no resize — @2x sibling handles retina");
});

test("non-mac normal icon is normalised to 32px", () => {
  const nativeImage = makeNativeImage();
  loadTrayNormalIcon({ nativeImage, platform: "win32", ...PATHS });

  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.iconPath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 32, height: 32 }]);
});

// #722/#941: macOS uses a natural 18pt Template pair. The @2x sibling is
// discovered by Electron/macOS, so no runtime representation or resize occurs.
test("mac flash icon uses the dedicated Template pair at its natural point size", () => {
  const nativeImage = makeNativeImage();
  const icon = loadTrayFlashIcon({
    nativeImage,
    platform: "darwin",
    ...PATHS,
    fileExists: () => true,
  });

  assert.strictEqual(icon.template, true);
  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.flashTemplatePath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, []);
});

test("non-mac flash icon matches the 32px normal icon", () => {
  const nativeImage = makeNativeImage();
  loadTrayFlashIcon({
    nativeImage,
    platform: "win32",
    ...PATHS,
    fileExists: () => true,
  });

  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 32, height: 32 }]);
});

test("missing or unreadable flash asset yields no highlight icon", () => {
  const absent = makeNativeImage();
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: absent, platform: "darwin", ...PATHS, fileExists: () => false }),
    null
  );
  assert.deepStrictEqual(absent.calls.created, []);

  const emptyImage = makeNativeImage({ empty: true });
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: emptyImage, platform: "darwin", ...PATHS, fileExists: () => true }),
    null
  );
});
