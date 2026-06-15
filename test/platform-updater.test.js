const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prepareLinuxDebUpdate, __test } = require("../src/platform-updater");

describe("platform updater asset validation", () => {
  it("selects the release asset matching each packaged architecture", () => {
    const release = {
      assets: [
        { name: "Clawd-on-Desk-1.2.3-x64.dmg", browser_download_url: "https://github.com/x64" },
        { name: "Clawd-on-Desk-1.2.3-arm64.dmg", browser_download_url: "https://github.com/arm64" },
        { name: "Clawd-on-Desk-1.2.3-amd64.deb", browser_download_url: "https://github.com/deb" },
      ],
    };

    assert.strictEqual(__test.findMacDmgAsset(release, "x64").name, "Clawd-on-Desk-1.2.3-x64.dmg");
    assert.strictEqual(__test.findMacDmgAsset(release, "arm64").name, "Clawd-on-Desk-1.2.3-arm64.dmg");
    assert.strictEqual(__test.findLinuxDebAsset(release, "x64").name, "Clawd-on-Desk-1.2.3-amd64.deb");
    assert.strictEqual(__test.findLinuxDebAsset(release, "arm64"), null);
  });

  it("allows only GitHub release download hosts", () => {
    assert.doesNotThrow(() => __test.assertAllowedDownloadUrl("https://github.com/org/repo/releases/download/v1/app.dmg"));
    assert.doesNotThrow(() => __test.assertAllowedDownloadUrl("https://release-assets.githubusercontent.com/file"));
    assert.throws(() => __test.assertAllowedDownloadUrl("https://example.com/app.dmg"), /untrusted URL/);
    assert.throws(() => __test.assertAllowedDownloadUrl("http://github.com/app.dmg"), /untrusted URL/);
  });

  it("verifies the GitHub SHA-256 digest and asset size", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-platform-updater-test-"));
    const filePath = path.join(tempDir, "asset.bin");
    const content = Buffer.from("verified update payload");
    fs.writeFileSync(filePath, content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");

    try {
      await __test.verifyAssetFile({ size: content.length, digest: `sha256:${digest}` }, filePath);
      await assert.rejects(
        __test.verifyAssetFile({ size: content.length, digest: `sha256:${"0".repeat(64)}` }, filePath),
        /SHA-256 verification/
      );
      await assert.rejects(
        __test.verifyAssetFile({ size: content.length + 1, digest: `sha256:${digest}` }, filePath),
        /size mismatch/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives the enclosing macOS app bundle from the executable path", () => {
    assert.strictEqual(
      __test.getMacAppPath("/Applications/Clawd on Desk.app/Contents/MacOS/Clawd on Desk"),
      "/Applications/Clawd on Desk.app"
    );
  });

  it("ships the macOS replacement helper as a mac-only extra resource", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const resources = pkg.build.mac.extraResources || [];
    assert.ok(resources.some((entry) => (
      entry.from === "src/macos-update-helper.sh" && entry.to === "macos-update-helper.sh"
    )));

    const helper = fs.readFileSync(path.join(__dirname, "..", "src", "macos-update-helper.sh"), "utf8");
    assert.match(helper, /codesign --verify --deep --strict/);
    assert.match(helper, /ditto "\$APP_PATH" "\$BACKUP_APP"/);
    assert.match(helper, /rollback "Updated app did not remain running"/);
  });

  it("validates a deb before installing it through pkexec and apt-get", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-deb-updater-test-"));
    const content = Buffer.from("fake deb payload");
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const calls = [];
    let relaunches = 0;
    let exits = 0;
    const fsApi = {
      ...fs,
      promises: {
        ...fs.promises,
        access: async (target, mode) => {
          if (target === "/usr/bin/pkexec" || target === "/usr/bin/apt-get") return;
          return fs.promises.access(target, mode);
        },
      },
    };
    const execFileImpl = (file, args, options, callback) => {
      calls.push([file, ...args]);
      if (file === "/usr/bin/dpkg-deb") {
        const values = { Package: "clawd-on-desk", Version: "1.2.3", Architecture: "amd64" };
        callback(null, `${values[args[2]]}\n`, "");
        return;
      }
      if (file === "/usr/bin/pkexec") {
        callback(null, "", "");
        return;
      }
      callback(new Error(`unexpected command: ${file}`));
    };

    try {
      const prepared = await prepareLinuxDebUpdate({
        release: {
          assets: [{
            name: "Clawd-on-Desk-1.2.3-amd64.deb",
            browser_download_url: "https://github.com/example/clawd.deb",
            size: content.length,
            digest: `sha256:${digest}`,
          }],
        },
        version: "v1.2.3",
        arch: "x64",
        userDataPath: tempDir,
        app: {
          relaunch() { relaunches += 1; },
          exit(code) { assert.strictEqual(code, 0); exits += 1; },
        },
      }, {
        fsImpl: fsApi,
        execFileImpl,
        downloadFileImpl: async (url, destination) => {
          assert.match(url, /^https:\/\/github[.]com\//);
          fs.writeFileSync(destination, content);
        },
      });

      await prepared.install();
      assert.ok(calls.some((call) => (
        call[0] === "/usr/bin/pkexec" &&
        call[1] === "/usr/bin/apt-get" &&
        call[2] === "install" &&
        call[3] === "-y"
      )));
      assert.strictEqual(relaunches, 1);
      assert.strictEqual(exits, 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
