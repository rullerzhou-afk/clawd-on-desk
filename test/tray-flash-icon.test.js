const test = require("node:test");
const assert = require("node:assert");

const { loadTrayNormalIcon, loadTrayFlashIcon } = require("../src/tray-flash-icon");

// Minimal nativeImage stand-in: records what was asked of it so the tests can
// assert on the sizing decisions rather than on real pixels.
function makeNativeImage({ empty = false, addRepresentationThrows = false } = {}) {
  const calls = { created: [], representations: [], resizes: [] };

  function makeImage({ isEmptyValue }) {
    return {
      isEmpty: () => isEmptyValue(),
      setTemplateImage(value) { this.template = value; },
      toDataURL: () => "data:image/png;base64,AAA",
      resize(size) {
        calls.resizes.push(size);
        return { ...this, size };
      },
      addRepresentation(rep) {
        if (addRepresentationThrows) throw new Error("unsupported");
        calls.representations.push(rep);
      },
    };
  }

  return {
    calls,
    createFromPath(p) {
      calls.created.push(p);
      return makeImage({ isEmptyValue: () => empty });
    },
    createEmpty() {
      return makeImage({ isEmptyValue: () => calls.representations.length === 0 });
    },
  };
}

const PATHS = {
  templatePath: "/assets/tray-iconTemplate.png",
  iconPath: "/assets/icon.png",
  flashPath: "/assets/tray-icon-flash.png",
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

// #722: the flash frame used to be a raw 32×32 image next to a 16pt normal
// icon, so the menu bar reflowed on every blink.
test("mac flash icon is added as an @2x representation, not a 32pt image", () => {
  const nativeImage = makeNativeImage();
  loadTrayFlashIcon({
    nativeImage,
    platform: "darwin",
    flashPath: PATHS.flashPath,
    fileExists: () => true,
  });

  assert.deepStrictEqual(nativeImage.calls.representations, [
    { scaleFactor: 2, dataURL: "data:image/png;base64,AAA" },
  ]);
  assert.deepStrictEqual(nativeImage.calls.resizes, [], "no 32pt resize on mac");
});

test("mac flash icon falls back to a 16pt downscale when addRepresentation fails", () => {
  const nativeImage = makeNativeImage({ addRepresentationThrows: true });
  loadTrayFlashIcon({
    nativeImage,
    platform: "darwin",
    flashPath: PATHS.flashPath,
    fileExists: () => true,
  });

  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 16, height: 16 }]);
});

test("non-mac flash icon matches the 32px normal icon", () => {
  const nativeImage = makeNativeImage();
  loadTrayFlashIcon({
    nativeImage,
    platform: "win32",
    flashPath: PATHS.flashPath,
    fileExists: () => true,
  });

  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 32, height: 32 }]);
});

test("missing or unreadable flash asset yields no highlight icon", () => {
  const absent = makeNativeImage();
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: absent, platform: "darwin", flashPath: PATHS.flashPath, fileExists: () => false }),
    null
  );
  assert.deepStrictEqual(absent.calls.created, []);

  const emptyImage = makeNativeImage({ empty: true });
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: emptyImage, platform: "darwin", flashPath: PATHS.flashPath, fileExists: () => true }),
    null
  );
});
