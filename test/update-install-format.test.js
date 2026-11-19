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

// A fake realpath that rewrites a path prefix, the way a symlinked $TMPDIR would.
function symlinks(links) {
  return (name) => {
    for (const [link, target] of Object.entries(links)) {
      if (name === link || name.startsWith(link + "/")) return target + name.slice(link.length);
    }
    return name;
  };
}
const unreadable = () => { throw new Error("ENOENT"); };

test("AppImage compares resolved paths when APPDIR goes through a symlinked TMPDIR", () => {
  const env = { APPIMAGE: "/home/me/Clawd.AppImage", APPDIR: "/tmp/tmp-link/clawd-appimage.AbCd1234/app" };
  const resourcesPath = "/mnt/real-tmp/clawd-appimage.AbCd1234/app/resources";
  const realpathSync = symlinks({ "/tmp/tmp-link": "/mnt/real-tmp" });
  assert.equal(classify({ env, resourcesPath, fsApi: { readFileSync: unreadable, realpathSync } }), "appimage");
  // Without resolution the same inputs are a manual install, as before.
  assert.equal(classify({ env, resourcesPath }), "manual");
});

test("AppImage keeps the literal comparison when paths cannot be resolved", () => {
  const env = { APPIMAGE: "/home/me/Clawd.AppImage", APPDIR: "/tmp/.mount_clawd" };
  const inside = "/tmp/.mount_clawd/resources";
  const throwing = { readFileSync: unreadable, realpathSync: unreadable };
  assert.equal(classify({ env, resourcesPath: inside, fsApi: throwing }), "appimage");
  for (const answer of [undefined, "", "relative/path", 42]) {
    const fsApi = { readFileSync: unreadable, realpathSync: () => answer };
    assert.equal(classify({ env, resourcesPath: inside, fsApi }), "appimage");
  }
  const symlinked = { APPIMAGE: env.APPIMAGE, APPDIR: "/tmp/tmp-link/app" };
  assert.equal(classify({ env: symlinked, resourcesPath: "/mnt/real-tmp/app/resources", fsApi: throwing }), "manual");
  assert.equal(classify({ env: symlinked, resourcesPath: "/mnt/real-tmp/app/resources" }), "manual");
});

test("AppImage still rejects resources that resolve outside the mount", () => {
  const env = { APPIMAGE: "/home/me/Clawd.AppImage", APPDIR: "/tmp/.mount_clawd" };
  const fsApiFor = (links) => ({ readFileSync: unreadable, realpathSync: symlinks(links) });
  // resources is a symlink that leaves the mount.
  assert.equal(classify({
    env, resourcesPath: "/tmp/.mount_clawd/resources", fsApi: fsApiFor({ "/tmp/.mount_clawd/resources": "/opt/Clawd/resources" }),
  }), "manual");
  // Another app's APPDIR that is a symlink to the filesystem root is not a mount.
  assert.equal(classify({
    env: { ...env, APPDIR: "/tmp/root-link" }, resourcesPath: "/opt/Clawd/resources", fsApi: fsApiFor({ "/tmp/root-link": "/" }),
  }), "manual");
  // A foreign APPDIR stays foreign after resolution.
  assert.equal(classify({
    env: { ...env, APPDIR: "/tmp/other-link" }, resourcesPath: "/opt/Clawd/resources", fsApi: fsApiFor({ "/tmp/other-link": "/tmp/.mount_other" }),
  }), "manual");
});

test("non-Linux and source installations keep their current updater", () => {
  for (const platform of ["darwin", "win32"]) assert.equal(classify({ platform }), "native");
  assert.equal(classify({ isPackaged: false }), "native");
});
