const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getUpdateInstallFormat } = require("../src/update-install-format");

function classify(overrides = {}) {
  return getUpdateInstallFormat({
    platform: "linux", isPackaged: true, resourcesPath: "/opt/Clawd/resources", env: {},
    fsApi: { readFileSync: () => { throw new Error("ENOENT"); } }, ...overrides,
  });
}

test("only an actual deb marker selects APT, including with foreign inherited AppImage env", () => {
  const fsApi = { readFileSync: (name) => { assert.equal(name, "/opt/Clawd/resources/package-type"); return "deb\n"; } };
  assert.equal(classify({ fsApi }), "deb");
  assert.equal(classify({ fsApi, env: { APPIMAGE: "/home/me/other.AppImage", APPDIR: "/tmp/other" } }), "deb");
  assert.equal(classify(), "manual");
  assert.equal(classify({ fsApi: { readFileSync: () => "rpm" } }), "manual");
});

test("AppImage requires ownership of this process resources, not just inherited variables", () => {
  const env = { APPIMAGE: "/home/me/Clawd.AppImage", APPDIR: "/tmp/.mount_clawd" };
  assert.equal(classify({ env, resourcesPath: "/tmp/.mount_clawd/resources" }), "appimage");
  assert.equal(classify({ env, resourcesPath: "/tmp/.mount_clawd/resources", fsApi: { readFileSync: () => "deb" } }), "appimage");
  for (const resourcesPath of ["/opt/Clawd/resources", "/tmp/.mount_clawd-other/resources", "/tmp/.mount_clawd/../other", "/tmp/.mount_clawd"]) {
    assert.equal(classify({ env, resourcesPath }), "manual");
  }
  for (const invalid of [
    { APPIMAGE: env.APPIMAGE }, { ...env, APPIMAGE: "relative" },
    { ...env, APPDIR: "/" }, { ...env, APPDIR: "relative" }, { ...env, APPIMAGE: "/bad\0" },
  ]) assert.equal(classify({ env: invalid, resourcesPath: "/tmp/.mount_clawd/resources" }), "manual");
});

test("non-Linux and source installations keep their current updater", () => {
  for (const platform of ["darwin", "win32"]) assert.equal(classify({ platform }), "native");
  assert.equal(classify({ isPackaged: false }), "native");
});
