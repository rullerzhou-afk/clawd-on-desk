const assert = require("node:assert");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { minimatch } = require("minimatch");

const pkg = require("../package.json");
const ROOT = path.join(__dirname, "..");

function matchedByAnyGlob(globs, target) {
  return globs.some((g) => minimatch(target, g));
}

describe("package build config", () => {
  it("ships project window icons in packaged builds", () => {
    assert.ok(
      pkg.build.files.includes("assets/icons/**/*"),
      "build.files should include assets/icons/**/*"
    );
  });

  it("ships agent session icons in packaged builds", () => {
    assert.ok(
      pkg.build.files.includes("assets/icons/agents/**/*"),
      "build.files should include assets/icons/agents/**/*"
    );
  });

  it("unpacks built-in theme assets so the folder can be opened from settings", () => {
    assert.ok(
      pkg.build.asarUnpack.includes("assets/svg/**/*"),
      "asarUnpack should include assets/svg/**/*"
    );
    assert.ok(
      pkg.build.asarUnpack.includes("themes/**/*"),
      "asarUnpack should include themes/**/*"
    );
  });

  // getWindowsShellIconPath has a three-step fallback:
  //   1. resourcesPath/icon.ico            ← extraResources copy
  //   2. resourcesPath/app.asar.unpacked/assets/icon.ico
  //   3. resourcesPath/app.asar/assets/icon.ico
  // Fallback 1 only works if extraResources actually copies icon.ico, and
  // fallback 3 only works if icon.ico is inside build.files. Guard both so a
  // future refactor to either array can't silently drop the shell icon.
  describe("Windows shell icon fallback chain", () => {
    it("has the source icon.ico on disk", () => {
      const src = path.join(ROOT, "assets", "icon.ico");
      assert.ok(fs.existsSync(src), "assets/icon.ico must exist for build.win.icon + extraResources");
    });

    it("copies icon.ico into resourcesPath via extraResources", () => {
      const extra = pkg.build.extraResources || [];
      const copied = extra.some(
        (e) => e && e.from === "assets/icon.ico" && e.to === "icon.ico"
      );
      assert.ok(copied, "build.extraResources must copy assets/icon.ico → icon.ico (shell fallback 1)");
    });

    it("wires win.icon to the same source file", () => {
      assert.strictEqual(
        pkg.build.win && pkg.build.win.icon,
        "assets/icon.ico",
        "build.win.icon should point at the same file the shell icon chain expects"
      );
    });

    it("packs icon.ico into the asar so fallback 3 resolves", () => {
      // getWindowsShellIconPath's third fallback reads
      // resourcesPath/app.asar/assets/icon.ico — which only exists if the
      // file survives the build.files glob filter. Earlier versions listed
      // only assets/icons/**/* (subdir), which does NOT match assets/icon.ico
      // at the root, so fallback 3 was dead. Guard against that regression.
      assert.ok(
        matchedByAnyGlob(pkg.build.files, "assets/icon.ico"),
        "build.files must include a glob covering assets/icon.ico (fallback 3)"
      );
    });
  });
});
