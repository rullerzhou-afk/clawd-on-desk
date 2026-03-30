// src/updater.js — Auto-update system (electron-updater + GitHub API version check)
// Extracted from main.js L1877-2271

const https = require("https");
const { app, dialog, shell, Notification } = require("electron");

const isMac = process.platform === "darwin";

module.exports = function initUpdater(ctx) {

let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) {
    try {
      _autoUpdater = require("electron-updater").autoUpdater;
      _autoUpdater.autoDownload = false;
      _autoUpdater.autoInstallOnAppQuit = true;
      ctx.updateLog("Auto-updater initialized successfully");
    } catch (err) {
      const errMsg = `electron-updater load failed: ${err.message}`;
      console.warn("Clawd:", errMsg);
      ctx.updateLog(`ERROR: ${errMsg}`);
      ctx.updateLog(`Stack: ${err.stack}`);
      return null;
    }
  }
  return _autoUpdater;
}

let updateStatus = "idle"; // idle | checking | available | downloading | ready | error
let manualUpdateCheck = false;

function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) {
    ctx.updateLog("setupAutoUpdater: autoUpdater is null, skipping event setup");
    return;
  }
  ctx.updateLog("Setting up auto-updater event handlers");

  autoUpdater.on("update-available", (info) => {
    ctx.updateLog(`Update available: v${info.version} (current: v${app.getVersion()})`);
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    // Silent check during DND/mini: skip dialog, stay idle so user can check later
    if (!wasManual && (ctx.doNotDisturb || ctx.miniMode)) {
      ctx.updateLog("Silent mode (DND/mini), skipping dialog");
      updateStatus = "idle";
      ctx.rebuildAllMenus();
      return;
    }
    updateStatus = "available";
    ctx.rebuildAllMenus();
    if (isMac) {
      // macOS: no code signing → can't auto-update, open GitHub Releases page instead
      ctx.updateLog("macOS detected: will open GitHub Releases page");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateAvailable"),
        message: ctx.t("updateAvailableMacMsg").replace("{version}", info.version),
        buttons: [ctx.t("download"), ctx.t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          ctx.updateLog("User chose to download, opening GitHub Releases");
          shell.openExternal("https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest");
        } else {
          ctx.updateLog("User chose to download later");
        }
        updateStatus = "idle";
        ctx.rebuildAllMenus();
      });
    } else {
      // Windows: auto-download
      ctx.updateLog("Windows detected: will offer auto-download");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateAvailable"),
        message: ctx.t("updateAvailableMsg").replace("{version}", info.version),
        buttons: [ctx.t("download"), ctx.t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          ctx.updateLog("User chose to download, starting download");
          updateStatus = "downloading";
          ctx.rebuildAllMenus();
          autoUpdater.downloadUpdate();
        } else {
          ctx.updateLog("User chose to download later");
          updateStatus = "idle";
          ctx.rebuildAllMenus();
        }
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    ctx.updateLog(`No update available: current v${app.getVersion()} is latest`);
    updateStatus = "idle";
    ctx.rebuildAllMenus();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      ctx.updateLog("Showing 'up to date' dialog");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateNotAvailable"),
        message: ctx.t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    ctx.updateLog(`Update downloaded: v${info.version}`);
    updateStatus = "ready";
    ctx.rebuildAllMenus();
    dialog.showMessageBox({
      type: "info",
      title: ctx.t("updateReady"),
      message: ctx.t("updateReadyMsg").replace("{version}", info.version),
      buttons: [ctx.t("restartNow"), ctx.t("restartLater")],
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        ctx.updateLog("User chose to restart now");
        autoUpdater.quitAndInstall(false, true);
      } else {
        ctx.updateLog("User chose to restart later");
      }
    });
  });

  autoUpdater.on("error", (err) => {
    ctx.updateLog(`ERROR: AutoUpdater error: ${err.message}`);
    ctx.updateLog(`Error code: ${err.code || 'none'}`);
    ctx.updateLog(`Error stack: ${err.stack}`);

    // Note: 404 errors during download might mean:
    // 1. Release files not uploaded yet (check GitHub first)
    // 2. Real network error
    // Since we now check GitHub API first, 404 here likely means
    // the release exists but files aren't ready
    // For auto-checks (not manual), just log silently
    if (!manualUpdateCheck) {
      ctx.updateLog("Auto-check error, not showing dialog");
      updateStatus = "error";
      ctx.rebuildAllMenus();
      return;
    }

    // For manual checks, show user-friendly error
    manualUpdateCheck = false;
    if (isUpdate404Error(err)) {
      // 404 after GitHub API check = release exists but files missing
      updateStatus = "idle";
      ctx.rebuildAllMenus();
      ctx.updateLog("404 error: release files not ready, showing 'up to date'");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateNotAvailable"),
        message: ctx.t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    } else {
      // Real error: network, permissions, corrupted download, etc.
      updateStatus = "error";
      ctx.rebuildAllMenus();
      ctx.updateLog("Real error: showing error dialog");
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
  });
}

// ── Version comparison utilities ──
// Compare two version strings (e.g., "0.5.0" vs "0.5.1")
// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
function compareVersions(v1, v2) {
  const parts1 = v1.replace('v', '').split('.').map(Number);
  const parts2 = v2.replace('v', '').split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

// Fetch latest release version from GitHub API (10s timeout)
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/rullerzhou-afk/clawd-on-desk/releases/latest',
      headers: {
        'User-Agent': 'Clawd-on-Desk'
      }
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            if (!release.tag_name) return reject(new Error('No tag_name in release'));
            resolve(release.tag_name);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${err.message}`));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('No releases found'));
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
      });
    }).on('error', reject);

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out (10s)'));
    });
  });
}

function isUpdate404Error(err) {
  return err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
         err.message?.includes('404') ||
         err.message?.includes('Cannot find latest.yml');
}

async function checkForUpdates(manual = false) {
  try { return await _checkForUpdatesInner(manual); }
  catch (e) {
    ctx.updateLog(`ERROR: unhandled in checkForUpdates: ${e.message}`);
    updateStatus = "idle";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
  }
}

async function _checkForUpdatesInner(manual) {
  if (updateStatus === "checking" || updateStatus === "downloading") {
    ctx.updateLog(`Check skipped: already ${updateStatus}`);
    return;
  }

  const currentVersion = app.getVersion();
  ctx.updateLog(`Starting update check (manual: ${manual}, current version: v${currentVersion})`);
  manualUpdateCheck = manual;
  updateStatus = "checking";
  ctx.rebuildAllMenus();

  // Step 1: Check GitHub API for latest version
  ctx.updateLog("Fetching latest version from GitHub API...");
  let latestVersion;
  try {
    latestVersion = await fetchLatestVersion();
    ctx.updateLog(`Latest version on GitHub: ${latestVersion}`);
  } catch (err) {
    ctx.updateLog(`ERROR: Failed to fetch latest version: ${err.message}`);

    // Network error or GitHub API issue
    updateStatus = "error";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      ctx.updateLog("Showing error dialog (GitHub API failed)");
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }

  // Step 2: Compare versions
  const versionCompare = compareVersions(currentVersion, latestVersion);
  ctx.updateLog(`Version comparison: ${currentVersion} vs ${latestVersion} = ${versionCompare}`);

  if (versionCompare >= 0) {
    // Current version is up-to-date or newer
    ctx.updateLog("Current version is up-to-date or newer");
    updateStatus = "idle";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      ctx.updateLog("Showing 'up to date' notification");
      new Notification({
        title: ctx.t("updateNotAvailable"),
        body: ctx.t("updateNotAvailableMsg").replace("{version}", currentVersion),
      }).show();
    }
    return;
  }

  // Step 3: Newer version available, use electron-updater to download
  ctx.updateLog(`Newer version available: ${latestVersion}, proceeding with electron-updater`);
  const au = getAutoUpdater();
  if (!au) {
    ctx.updateLog("ERROR: AutoUpdater not available");
    updateStatus = "error";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      ctx.updateLog("Showing error dialog (auto-updater not available)");
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }

  // Let electron-updater handle the download
  au.checkForUpdates().then((result) => {
    if (!result) {
      ctx.updateLog("Update check returned null (likely dev mode)");
      updateStatus = "idle";
      manualUpdateCheck = false;
      ctx.rebuildAllMenus();
    } else {
      const info = result.updateInfo || result.versionInfo || {};
      ctx.updateLog(`Update check result: v${info.version}, files: ${info.files?.map(f => f.url)?.join(", ")}`);
    }
  }).catch((err) => {
    ctx.updateLog(`ERROR: checkForUpdates promise rejected: ${err.message}`);
    ctx.updateLog(`Stack: ${err.stack}`);

    // Distinguish between real errors and "no newer version"
    if (isUpdate404Error(err)) {
      // This might mean the release files aren't ready yet
      ctx.updateLog("404 error: release files may not be uploaded yet");
      updateStatus = "idle";
      manualUpdateCheck = false;
      ctx.rebuildAllMenus();
      if (manual) {
        ctx.updateLog("Showing 'up to date' dialog (release files not found)");
        dialog.showMessageBox({
          type: "info",
          title: ctx.t("updateNotAvailable"),
          message: ctx.t("updateNotAvailableMsg").replace("{version}", currentVersion),
          noLink: true,
        });
      }
    } else {
      // Real error: network, permissions, etc.
      ctx.updateLog("Real error in promise: showing error dialog");
      updateStatus = "error";
      manualUpdateCheck = false;
      ctx.rebuildAllMenus();
      if (manual) {
        ctx.updateLog("Showing error dialog (check failed)");
        dialog.showMessageBox({
          type: "error",
          title: ctx.t("updateError"),
          message: ctx.t("updateErrorMsg"),
          noLink: true,
        });
      }
    }
  });
}

function getUpdateMenuItem() {
  return {
    label: getUpdateMenuLabel(),
    enabled: updateStatus !== "checking" && updateStatus !== "downloading",
    click: () => updateStatus === "ready"
      ? getAutoUpdater()?.quitAndInstall(false, true)
      : checkForUpdates(true),
  };
}

function getUpdateMenuLabel() {
  switch (updateStatus) {
    case "checking": return ctx.t("checkingForUpdates");
    case "downloading": return ctx.t("updateDownloading");
    case "ready": return ctx.t("updateReady");
    default: return ctx.t("checkForUpdates");
  }
}

return { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel };

};
