const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { pipeline } = require("stream");

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function normalizeVersion(version) {
  return String(version || "").replace(/^v/i, "").split("-")[0];
}

function findMacDmgAsset(release, arch) {
  const suffix = arch === "arm64" ? "arm64.dmg" : arch === "x64" ? "x64.dmg" : "";
  if (!suffix) return null;
  return (release && Array.isArray(release.assets) ? release.assets : []).find((asset) => {
    const name = String(asset && asset.name || "");
    return name.endsWith(suffix) && asset.browser_download_url;
  }) || null;
}

function findLinuxDebAsset(release, arch) {
  const suffix = arch === "arm64" ? "arm64.deb" : arch === "x64" ? "amd64.deb" : "";
  if (!suffix) return null;
  return (release && Array.isArray(release.assets) ? release.assets : []).find((asset) => {
    const name = String(asset && asset.name || "");
    return name.endsWith(suffix) && asset.browser_download_url;
  }) || null;
}

function assertAllowedDownloadUrl(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing update download from untrusted URL: ${url.href}`);
  }
  return url;
}

function execFileAsync(execFileFn, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, options, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || err).trim();
        err.message = detail || err.message;
        reject(err);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function downloadReleaseAsset(rawUrl, destination, deps = {}, redirects = 0) {
  const httpsGet = deps.httpsGetImpl || https.get;
  const fsApi = deps.fsImpl || fs;
  const url = assertAllowedDownloadUrl(rawUrl);
  if (redirects > 5) return Promise.reject(new Error("Too many update download redirects"));

  return new Promise((resolve, reject) => {
    const req = httpsGet({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: { "User-Agent": "Clawd-on-Desk-Updater" },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
        res.resume();
        downloadReleaseAsset(new URL(res.headers.location, url).href, destination, deps, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Update download returned HTTP ${res.statusCode}`));
        return;
      }
      const output = fsApi.createWriteStream(destination, { mode: 0o600 });
      pipeline(res, output, (err) => err ? reject(err) : resolve(destination));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Update download timed out"));
    });
  });
}

async function verifyAssetFile(asset, filePath, deps = {}) {
  const fsApi = deps.fsImpl || fs;
  const stat = await fsApi.promises.stat(filePath);
  if (Number.isFinite(asset.size) && stat.size !== asset.size) {
    throw new Error(`Update size mismatch: expected ${asset.size}, received ${stat.size}`);
  }

  const digest = String(asset.digest || "");
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest);
  if (!match) throw new Error("GitHub release asset is missing a SHA-256 digest");

  const actual = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fsApi.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
  if (actual.toLowerCase() !== match[1].toLowerCase()) {
    throw new Error("Downloaded update failed SHA-256 verification");
  }
}

function getMacAppPath(execPath) {
  return path.resolve(path.dirname(execPath), "../..");
}

async function readPlistValue(execFileFn, plistPath, key) {
  return execFileAsync(execFileFn, "/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", plistPath,
  ], { timeout: 10000 });
}

async function findAppBundle(fsApi, mountPoint) {
  const entries = await fsApi.promises.readdir(mountPoint, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  return appEntry ? path.join(mountPoint, appEntry.name) : null;
}

async function prepareMacDmgUpdate(options, deps = {}) {
  const fsApi = deps.fsImpl || fs;
  const execFileFn = deps.execFileImpl || execFile;
  const spawnFn = deps.spawnImpl || spawn;
  const downloadFile = deps.downloadFileImpl || downloadReleaseAsset;
  const runtimeArch = options.arch;
  const asset = findMacDmgAsset(options.release, runtimeArch);
  if (!asset) throw new Error(`No macOS ${runtimeArch} DMG is attached to this release`);

  const appPath = options.appPath || getMacAppPath(options.execPath || process.execPath);
  const appParent = path.dirname(appPath);
  const userData = options.userDataPath || options.app.getPath("userData");
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const helperPath = path.join(resourcesPath, "macos-update-helper.sh");
  const updateRoot = path.join(userData, "updates", `v${normalizeVersion(options.version)}`);
  const downloadPath = path.join(updateRoot, asset.name);
  const mountPoint = await fsApi.promises.mkdtemp(path.join(os.tmpdir(), "clawd-update-mount-"));
  let stagingRoot = "";
  let attached = false;

  await fsApi.promises.access(appParent, fs.constants.W_OK);
  await fsApi.promises.access(helperPath, fs.constants.R_OK);
  await fsApi.promises.rm(updateRoot, { recursive: true, force: true });
  await fsApi.promises.mkdir(updateRoot, { recursive: true, mode: 0o700 });

  try {
    await downloadFile(asset.browser_download_url, downloadPath, deps);
    await verifyAssetFile(asset, downloadPath, deps);
    await execFileAsync(execFileFn, "/usr/bin/hdiutil", ["verify", downloadPath], { timeout: 120000 });
    await execFileAsync(execFileFn, "/usr/bin/hdiutil", [
      "attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, downloadPath,
    ], { timeout: 120000 });
    attached = true;

    const sourceApp = await findAppBundle(fsApi, mountPoint);
    if (!sourceApp) throw new Error("The macOS update DMG does not contain an app bundle");
    const infoPlist = path.join(sourceApp, "Contents", "Info.plist");
    const bundleId = await readPlistValue(execFileFn, infoPlist, "CFBundleIdentifier");
    const bundleVersion = await readPlistValue(execFileFn, infoPlist, "CFBundleShortVersionString");
    if (bundleId !== "com.clawd.on-desk") throw new Error(`Unexpected app bundle id: ${bundleId}`);
    if (normalizeVersion(bundleVersion) !== normalizeVersion(options.version)) {
      throw new Error(`DMG version ${bundleVersion} does not match release ${options.version}`);
    }

    const executableName = await readPlistValue(execFileFn, infoPlist, "CFBundleExecutable");
    const executablePath = path.join(sourceApp, "Contents", "MacOS", executableName);
    const architectures = await execFileAsync(execFileFn, "/usr/bin/lipo", ["-archs", executablePath], { timeout: 10000 });
    if (!architectures.split(/\s+/).includes(runtimeArch)) {
      throw new Error(`DMG executable does not contain the ${runtimeArch} architecture`);
    }
    await execFileAsync(execFileFn, "/usr/bin/codesign", ["--verify", "--deep", "--strict", sourceApp], { timeout: 120000 });

    stagingRoot = await fsApi.promises.mkdtemp(path.join(appParent, ".clawd-update-"));
    const stagedApp = path.join(stagingRoot, path.basename(appPath));
    await execFileAsync(execFileFn, "/usr/bin/ditto", [sourceApp, stagedApp], { timeout: 300000 });
    await execFileAsync(execFileFn, "/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp], { timeout: 120000 });
    // Release assets are ad-hoc signed today. Remove quarantine only after the
    // user approved the update and every GitHub/package identity check passed.
    await execFileAsync(execFileFn, "/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedApp], { timeout: 30000 });

    const backupDir = path.join(userData, "update-backups");
    const logPath = path.join(userData, "macos-updater.log");
    const messages = options.messages || {};
    await fsApi.promises.mkdir(backupDir, { recursive: true, mode: 0o700 });

    return {
      kind: "mac-dmg",
      version: normalizeVersion(options.version),
      async install() {
        const child = spawnFn("/bin/bash", [
          helperPath,
          String(options.pid || process.pid),
          appPath,
          stagedApp,
          backupDir,
          logPath,
          normalizeVersion(options.version),
          runtimeArch,
          executableName,
          "com.clawd.on-desk",
          messages.success || `Clawd was updated to v${normalizeVersion(options.version)}.`,
          messages.rollback || "The update failed, so the previous version was restored.",
          messages.quitTimeout || "Clawd could not quit, so the update was cancelled.",
        ], { detached: true, stdio: "ignore" });
        child.unref();
        options.app.quit();
      },
    };
  } catch (err) {
    if (stagingRoot) await fsApi.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    if (attached) {
      await execFileAsync(execFileFn, "/usr/bin/hdiutil", ["detach", mountPoint, "-force"], { timeout: 60000 }).catch(() => {});
    }
    await fsApi.promises.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
    await fsApi.promises.rm(downloadPath, { force: true }).catch(() => {});
  }
}

async function prepareLinuxDebUpdate(options, deps = {}) {
  const fsApi = deps.fsImpl || fs;
  const execFileFn = deps.execFileImpl || execFile;
  const downloadFile = deps.downloadFileImpl || downloadReleaseAsset;
  const asset = findLinuxDebAsset(options.release, options.arch);
  if (!asset) throw new Error(`No Linux ${options.arch} deb package is attached to this release`);

  const userData = options.userDataPath || options.app.getPath("userData");
  const updateRoot = path.join(userData, "updates", `v${normalizeVersion(options.version)}`);
  const debPath = path.join(updateRoot, asset.name);
  await fsApi.promises.rm(updateRoot, { recursive: true, force: true });
  await fsApi.promises.mkdir(updateRoot, { recursive: true, mode: 0o700 });

  await downloadFile(asset.browser_download_url, debPath, deps);
  await verifyAssetFile(asset, debPath, deps);

  const packageName = await execFileAsync(execFileFn, "/usr/bin/dpkg-deb", ["-f", debPath, "Package"], { timeout: 30000 });
  const packageVersion = await execFileAsync(execFileFn, "/usr/bin/dpkg-deb", ["-f", debPath, "Version"], { timeout: 30000 });
  const packageArch = await execFileAsync(execFileFn, "/usr/bin/dpkg-deb", ["-f", debPath, "Architecture"], { timeout: 30000 });
  const expectedArch = options.arch === "arm64" ? "arm64" : "amd64";
  if (packageName !== "clawd-on-desk") throw new Error(`Unexpected deb package name: ${packageName}`);
  if (normalizeVersion(packageVersion) !== normalizeVersion(options.version)) {
    throw new Error(`deb version ${packageVersion} does not match release ${options.version}`);
  }
  if (packageArch !== expectedArch) throw new Error(`Unexpected deb architecture: ${packageArch}`);
  await fsApi.promises.access("/usr/bin/pkexec", fs.constants.X_OK);
  await fsApi.promises.access("/usr/bin/apt-get", fs.constants.X_OK);

  return {
    kind: "linux-deb",
    version: normalizeVersion(options.version),
    async install() {
      await execFileAsync(execFileFn, "/usr/bin/pkexec", [
        "/usr/bin/apt-get", "install", "-y", debPath,
      ], { timeout: 600000 });
      await fsApi.promises.rm(updateRoot, { recursive: true, force: true }).catch(() => {});
      options.app.relaunch();
      options.app.exit(0);
    },
  };
}

module.exports = {
  findLinuxDebAsset,
  findMacDmgAsset,
  prepareLinuxDebUpdate,
  prepareMacDmgUpdate,
  __test: {
    assertAllowedDownloadUrl,
    findLinuxDebAsset,
    findMacDmgAsset,
    getMacAppPath,
    normalizeVersion,
    verifyAssetFile,
  },
};
