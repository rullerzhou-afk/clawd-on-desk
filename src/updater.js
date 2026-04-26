const https = require("https");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const electron = require("electron");

const isMac = process.platform === "darwin";
const RELEASES_LATEST_URL = "https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest";

function makeTranslate(ctx) {
  return (key, fallback) => {
    const value = typeof ctx.t === "function" ? ctx.t(key) : key;
    if (value && value !== key) return value;
    return fallback != null ? fallback : key;
  };
}

function compareVersions(v1, v2) {
  const parts1 = String(v1).replace(/^v/, "").split(".").map(Number);
  const parts2 = String(v2).replace(/^v/, "").split(".").map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLength; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

function isUpdate404Error(err) {
  return !!(err && (
    err.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ||
    String(err.message || "").includes("404") ||
    String(err.message || "").includes("Cannot find latest.yml")
  ));
}

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return String(err.message || err).trim() || "Unknown error";
}

function classifyFailureType(reason, fallback = "Update Failed") {
  const text = String(reason || "").toLowerCase();
  if (text.includes("dirty worktree") || text.includes("uncommitted") || text.includes("modified")) return "Dirty Worktree";
  if (text.includes("timed out") || text.includes("network") || text.includes("github api")) return "Network Error";
  if (text.includes("npm install")) return "Dependency Install Failed";
  if (text.includes("git pull")) return "Git Pull Failed";
  if (text.includes("download")) return "Update Download Failed";
  if (text.includes("autoupdater")) return "Updater Unavailable";
  return fallback;
}

function buildErrorDetail({ failureType, operation, reason, nextStep, detail }) {
  const lines = [];
  if (failureType) lines.push(`Failure Type: ${failureType}`);
  if (operation) lines.push(`Operation: ${operation}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (nextStep) lines.push(`Next Step: ${nextStep}`);
  if (detail && detail !== reason) {
    lines.push("");
    lines.push(detail);
  }
  return lines.join("\n").trim();
}

function formatVersionForMessage(version) {
  return String(version || "").replace(/^v/i, "");
}

function shouldPromptNativeArm64({ platform, arch, isPackaged, runningUnderARM64Translation }) {
  return platform === "win32" &&
    arch === "x64" &&
    !!isPackaged &&
    !!runningUnderARM64Translation;
}

function findWindowsArm64InstallerAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  return assets.find((asset) => {
    const name = String(asset && asset.name || "");
    return /setup/i.test(name) &&
      /arm64/i.test(name) &&
      /\.exe$/i.test(name) &&
      asset.browser_download_url;
  }) || null;
}

function initUpdater(ctx, deps = {}) {
  const app = deps.app || electron.app;
  const shell = deps.shell || electron.shell;
  const httpsGet = deps.httpsGetImpl || https.get;
  const execFileFn = deps.execFileImpl || execFile;
  const fsApi = deps.fsImpl || fs;
  const t = makeTranslate(ctx);
  const runtimePlatform = deps.platform || process.platform;
  const runtimeArch = deps.arch || process.arch;

  let updateStatus = "idle";
  let manualUpdateCheck = false;
  let repoRootCache;
  let autoUpdaterInstance = null;
  let overlayKind = null;
  let nativeArm64PromptDismissed = false;
  let nativeArm64PromptToken = 0;

  function rebuildMenus() {
    if (typeof ctx.rebuildAllMenus === "function") ctx.rebuildAllMenus();
  }

  function log(message) {
    if (typeof ctx.updateLog === "function") ctx.updateLog(message);
  }

  function renderResolvedState() {
    if (typeof ctx.applyState === "function" && typeof ctx.resolveDisplayState === "function") {
      const resolved = ctx.resolveDisplayState();
      const svgOverride = typeof ctx.getSvgOverride === "function" ? ctx.getSvgOverride(resolved) : null;
      ctx.applyState(resolved, svgOverride);
    }
  }

  function setOverlay(kind) {
    if (overlayKind === kind) return;
    overlayKind = kind || null;
    if (typeof ctx.setUpdateVisualState === "function") ctx.setUpdateVisualState(overlayKind);
    renderResolvedState();
  }

  function clearOverlay() {
    setOverlay(null);
  }

  function pulseState(state) {
    clearOverlay();
    if (typeof ctx.applyState === "function") ctx.applyState(state);
  }

  function pulseSuccessState() {
    if (typeof ctx.resetSoundCooldown === "function") ctx.resetSoundCooldown();
    pulseState("attention");
  }

  function showBubble(payload) {
    if (typeof ctx.showUpdateBubble !== "function") {
      return Promise.resolve(payload.defaultAction != null ? payload.defaultAction : null);
    }
    return Promise.resolve(ctx.showUpdateBubble(payload));
  }

  function hideBubble() {
    if (typeof ctx.hideUpdateBubble === "function") ctx.hideUpdateBubble();
  }

  function isSilentMode() {
    return !!ctx.doNotDisturb || !!ctx.miniMode;
  }

  function dismissToResolvedState() {
    clearOverlay();
    rebuildMenus();
  }

  function invalidateNativeArm64Prompt() {
    nativeArm64PromptToken += 1;
  }

  function showInfoBubble(mode, title, message, extra = {}) {
    return showBubble({
      mode,
      title,
      message,
      detail: extra.detail || "",
      version: extra.version || "",
      actions: extra.actions || [],
      defaultAction: extra.defaultAction != null ? extra.defaultAction : null,
      lang: ctx.lang || "en",
      requireAction: !!extra.requireAction,
    });
  }

  async function showErrorBubble(detailOrReport, messageOverride = null) {
    const report = typeof detailOrReport === "object" && detailOrReport !== null && !Array.isArray(detailOrReport)
      ? detailOrReport
      : { detail: detailOrReport, message: messageOverride };
    const reason = report.reason || getErrorMessage(report.detail);
    const detail = buildErrorDetail({
      failureType: report.failureType || classifyFailureType(reason),
      operation: report.operation || "Check for Updates",
      reason,
      nextStep: report.nextStep || "",
      detail: typeof report.detail === "string" ? report.detail : "",
    });
    pulseState("error");
    return showBubble({
      mode: "error",
      title: t("updateError", "Update Error"),
      message: report.message || t("updateErrorMsg", "Failed to check for updates. Please try again later."),
      detail,
      actions: [
        { id: "dismiss", label: t("dismiss", "Dismiss"), variant: "secondary" },
      ],
      defaultAction: "dismiss",
      lang: ctx.lang || "en",
      requireAction: true,
    });
  }

  async function showUpToDateBubble(version) {
    clearOverlay();
    return showInfoBubble(
      "up-to-date",
      t("updateNotAvailable", "You're Up to Date"),
      t("updateNotAvailableMsg", "Clawd v{version} is the latest version.").replace("{version}", version),
      {
        version,
        actions: [{ id: "dismiss", label: t("dismiss", "Dismiss"), variant: "secondary" }],
        defaultAction: "dismiss",
      }
    );
  }

  async function showSuccessBubble({ title, message, version = "", actions = [], defaultAction = null, requireAction = false }) {
    pulseSuccessState();
    return showBubble({
      mode: "ready",
      title,
      message,
      version,
      detail: "",
      actions,
      defaultAction,
      lang: ctx.lang || "en",
      requireAction,
    });
  }

  function getRepoRoot() {
    if (repoRootCache !== undefined) return repoRootCache;
    if (app.isPackaged) {
      repoRootCache = null;
      return repoRootCache;
    }
    const root = path.join(__dirname, "..");
    try {
      if (fsApi.statSync(path.join(root, ".git")).isDirectory()) {
        repoRootCache = root;
        return repoRootCache;
      }
    } catch {}
    repoRootCache = null;
    return repoRootCache;
  }

  function gitCmd(args, cwd, timeout = 30000) {
    return new Promise((resolve, reject) => {
      execFileFn("git", args, { cwd, timeout }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || "").trim());
      });
    });
  }

  function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const req = httpsGet({
        hostname: "api.github.com",
        path: "/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
        headers: { "User-Agent": "Clawd-on-Desk" },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            if (res.statusCode === 404) return reject(new Error("No releases found"));
            return reject(new Error(`GitHub API returned ${res.statusCode}`));
          }
          try {
            const release = JSON.parse(data);
            if (!release.tag_name) return reject(new Error("No tag_name in release"));
            resolve(release);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${err.message}`));
          }
        });
      });

      if (req && typeof req.on === "function") req.on("error", reject);
      if (req && typeof req.setTimeout === "function") {
        req.setTimeout(10000, () => {
          if (typeof req.destroy === "function") req.destroy();
          reject(new Error("GitHub API request timed out (10s)"));
        });
      }
    });
  }

  function isRunningX64OnWindowsArm64() {
    return shouldPromptNativeArm64({
      platform: runtimePlatform,
      arch: runtimeArch,
      isPackaged: app.isPackaged,
      runningUnderARM64Translation: deps.runningUnderARM64Translation != null
        ? deps.runningUnderARM64Translation
        : app.runningUnderARM64Translation,
    });
  }

  function getAutoUpdater() {
    if (autoUpdaterInstance) return autoUpdaterInstance;
    try {
      autoUpdaterInstance = deps.autoUpdaterFactory
        ? deps.autoUpdaterFactory()
        : require("electron-updater").autoUpdater;
      autoUpdaterInstance.autoDownload = false;
      autoUpdaterInstance.autoInstallOnAppQuit = true;
      return autoUpdaterInstance;
    } catch (err) {
      log(`ERROR: electron-updater load failed: ${err.message}`);
      return null;
    }
  }

  async function promptAvailableUpdate({ mode, version, onPrimary }) {
    const primaryLabel = mode === "git"
      ? t("updateNow", "Update Now")
      : t("download", "Download");
    const action = await showBubble({
      mode: "available",
      title: t("updateAvailable", "Update Available"),
      message: (mode === "mac"
        ? t("updateAvailableMacMsg", "v{version} is available. Open the download page?")
        : t("updateAvailableMsg", "v{version} is available. Download and install now?"))
        .replace("{version}", version),
      version,
      actions: [
        { id: "primary", label: primaryLabel, variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    });

    if (action === "primary") return onPrimary();
    hideBubble();
    dismissToResolvedState();
    updateStatus = "idle";
    rebuildMenus();
    manualUpdateCheck = false;
    return null;
  }

  async function promptReadyUpdate(version, onPrimary) {
    pulseSuccessState();
    const action = await showBubble({
      mode: "ready",
      title: t("updateReady", "Update Ready"),
      message: t("updateReadyMsg", "v{version} has been downloaded. Restart now to update?").replace("{version}", version),
      version,
      actions: [
        { id: "primary", label: t("restartNow", "Restart Now"), variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    });

    if (action === "primary") return onPrimary();
    hideBubble();
    dismissToResolvedState();
    updateStatus = "idle";
    rebuildMenus();
    return null;
  }

  async function maybePromptNativeArm64Installer(release, { manual = false, currentVersion = app.getVersion() } = {}) {
    if (!isRunningX64OnWindowsArm64()) return false;
    if (!manual && (nativeArm64PromptDismissed || isSilentMode())) return false;
    if (!manual && (manualUpdateCheck || updateStatus !== "idle")) return false;

    const version = release && release.tag_name;
    if (!version || compareVersions(currentVersion, version) > 0) return false;
    const displayVersion = formatVersionForMessage(version);

    const asset = findWindowsArm64InstallerAsset(release);
    if (!asset) return false;
    const promptToken = nativeArm64PromptToken + 1;
    nativeArm64PromptToken = promptToken;

    updateStatus = "available";
    setOverlay("available");
    rebuildMenus();

    const action = await showBubble({
      mode: "available",
      title: t("nativeArm64Available", "Native ARM64 Build Available"),
      message: t(
        "nativeArm64AvailableMsg",
        "Clawd v{version} has a native Windows ARM64 installer. Install it for better performance and battery life?"
      ).replace("{version}", displayVersion),
      version,
      actions: [
        { id: "primary", label: t("download", "Download"), variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    });

    if (promptToken !== nativeArm64PromptToken) return true;

    if (action === "primary") {
      shell.openExternal(asset.browser_download_url || RELEASES_LATEST_URL);
      updateStatus = "idle";
      manualUpdateCheck = false;
      rebuildMenus();
      await showSuccessBubble({
        title: t("updateReady", "Update Ready"),
        message: t("nativeArm64DownloadOpened", "Opened the ARM64 installer download in your browser."),
        version,
        actions: [
          { id: "dismiss", label: t("dismiss", "Dismiss"), variant: "secondary" },
        ],
        defaultAction: "dismiss",
        requireAction: true,
      });
      dismissToResolvedState();
      return true;
    }

    nativeArm64PromptDismissed = true;
    hideBubble();
    dismissToResolvedState();
    updateStatus = "idle";
    manualUpdateCheck = false;
    rebuildMenus();
    return true;
  }

  async function runGitUpdate(repoRoot, branch, localHead) {
    updateStatus = "downloading";
    setOverlay("downloading");
    rebuildMenus();
    await showInfoBubble(
      "downloading",
      t("updating", "Updating..."),
      t("updateDownloading", "Downloading Update...")
    );

    try {
      await gitCmd(["pull", "origin", branch], repoRoot, 60000);
    } catch (err) {
      err.updateOperation = "Apply Git Update";
      err.updateFailureType = "Git Pull Failed";
      err.updateNextStep = "Resolve the Git error, then try the update again.";
      throw err;
    }
    const diff = await gitCmd(["diff", "--name-only", localHead, "HEAD"], repoRoot);
    if (diff.includes("package.json") || diff.includes("package-lock.json")) {
      try {
        await new Promise((resolve, reject) => {
          execFileFn("npm", ["install", "--no-fund", "--no-audit"], {
            cwd: repoRoot,
            timeout: 120000,
            shell: process.platform === "win32",
          }, (err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        err.updateOperation = "Install Updated Dependencies";
        err.updateFailureType = "Dependency Install Failed";
        err.updateNextStep = "Fix the npm install error, then try the update again.";
        throw err;
      }
    }

    await showSuccessBubble({
      title: t("updateReady", "Update Ready"),
      message: t("gitUpdateRestarting", "Update complete. Restarting Clawd now..."),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    hideBubble();
    app.relaunch();
    app.exit(0);
  }

  async function gitCheckForUpdates(repoRoot, manual) {
    updateStatus = "checking";
    manualUpdateCheck = manual;
    setOverlay("checking");
    rebuildMenus();
    await showInfoBubble(
      "checking",
      t("checkForUpdates", "Check for Updates"),
      t("checkingForUpdates", "Checking for Updates...")
    );

    try {
      const branch = await gitCmd(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
      await gitCmd(["fetch", "origin", branch], repoRoot);

      const localHead = await gitCmd(["rev-parse", "HEAD"], repoRoot);
      const remoteHead = await gitCmd(["rev-parse", `origin/${branch}`], repoRoot);

      if (localHead === remoteHead) {
        updateStatus = "idle";
        manualUpdateCheck = false;
        rebuildMenus();
        if (manual) await showUpToDateBubble(app.getVersion());
        else dismissToResolvedState();
        return;
      }

      let remoteVersion;
      try {
        const remotePkg = await gitCmd(["show", `origin/${branch}:package.json`], repoRoot);
        remoteVersion = JSON.parse(remotePkg).version;
      } catch {
        remoteVersion = remoteHead.slice(0, 8);
      }

      if (!manual && isSilentMode()) {
        hideBubble();
        updateStatus = "idle";
        manualUpdateCheck = false;
        dismissToResolvedState();
        return;
      }

      updateStatus = "available";
      setOverlay("available");
      rebuildMenus();

      await promptAvailableUpdate({
        mode: "git",
        version: remoteVersion,
        onPrimary: async () => {
          const dirty = await gitCmd(["status", "--porcelain"], repoRoot);
          if (dirty) {
            updateStatus = "error";
            manualUpdateCheck = false;
            rebuildMenus();
            clearOverlay();
            await showErrorBubble({
              failureType: "Dirty Worktree",
              operation: "Apply Git Update",
              reason: "Local files have uncommitted changes.",
              nextStep: "Commit or stash your changes, then try the update again.",
              detail: dirty,
              message: t("updateDirtyMsg", "Local files have been modified. Please commit or stash your changes before updating."),
            });
            return;
          }
          await runGitUpdate(repoRoot, branch, localHead);
        },
      });
    } catch (err) {
      updateStatus = "error";
      manualUpdateCheck = false;
      rebuildMenus();
      clearOverlay();
      if (manual) {
        await showErrorBubble({
          failureType: err.updateFailureType,
          operation: err.updateOperation || "Check for Updates",
          reason: getErrorMessage(err),
          nextStep: err.updateNextStep || "",
          detail: getErrorMessage(err),
        });
      }
    }
  }

  function setupAutoUpdater() {
    if (isRunningX64OnWindowsArm64()) {
      Promise.resolve()
        .then(fetchLatestRelease)
        .then((release) => maybePromptNativeArm64Installer(release, { manual: false }))
        .catch((err) => log(`Native ARM64 prompt skipped: ${err.message}`));
    }

    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) return;

    autoUpdater.on("update-available", async (info) => {
      const wasManual = manualUpdateCheck;
      manualUpdateCheck = false;

      if (!wasManual && isSilentMode()) {
        hideBubble();
        updateStatus = "idle";
        dismissToResolvedState();
        return;
      }

      updateStatus = "available";
      setOverlay("available");
      rebuildMenus();

      await promptAvailableUpdate({
        mode: isMac ? "mac" : "win",
        version: info.version,
        onPrimary: async () => {
          if (isMac) {
            shell.openExternal(RELEASES_LATEST_URL);
            updateStatus = "idle";
            manualUpdateCheck = false;
            rebuildMenus();
            await showSuccessBubble({
              title: t("updateReady", "Update Ready"),
              message: t("macUpdateOpened", "Opened the latest download page in your browser."),
              version: info.version,
              actions: [
                { id: "dismiss", label: t("dismiss", "Dismiss"), variant: "secondary" },
              ],
              defaultAction: "dismiss",
              requireAction: true,
            });
            dismissToResolvedState();
            return;
          }

          updateStatus = "downloading";
          setOverlay("downloading");
          rebuildMenus();
          await showInfoBubble(
            "downloading",
            t("updateDownloading", "Downloading Update..."),
            t("updateDownloading", "Downloading Update...")
          );
          autoUpdater.downloadUpdate();
        },
      });
    });

    autoUpdater.on("update-not-available", async () => {
      updateStatus = "idle";
      rebuildMenus();
      if (manualUpdateCheck) {
        manualUpdateCheck = false;
        await showUpToDateBubble(app.getVersion());
        return;
      }
      dismissToResolvedState();
    });

    autoUpdater.on("update-downloaded", async (info) => {
      updateStatus = "ready";
      rebuildMenus();
      clearOverlay();
      await promptReadyUpdate(info.version, async () => {
        autoUpdater.quitAndInstall(false, true);
      });
    });

    autoUpdater.on("error", async (err) => {
      log(`ERROR: AutoUpdater error: ${err.message}`);
      const shouldShowErrorBubble = manualUpdateCheck || updateStatus === "downloading";
      const failedWhileDownloading = updateStatus === "downloading";
      if (!shouldShowErrorBubble) {
        updateStatus = "error";
        rebuildMenus();
        clearOverlay();
        return;
      }

      manualUpdateCheck = false;
      if (isUpdate404Error(err)) {
        updateStatus = "idle";
        rebuildMenus();
        await showUpToDateBubble(app.getVersion());
      } else {
        updateStatus = "error";
        rebuildMenus();
        clearOverlay();
        await showErrorBubble({
          failureType: classifyFailureType(err.message),
          operation: failedWhileDownloading ? "Download Update" : "Check for Updates",
          reason: getErrorMessage(err),
          nextStep: failedWhileDownloading
            ? "Check your network connection and try downloading again."
            : "Check your network connection and try again.",
          detail: getErrorMessage(err),
        });
      }
    });
  }

  async function checkForUpdates(manual = false) {
    if (updateStatus === "checking" || updateStatus === "downloading") {
      log(`Check skipped: already ${updateStatus}`);
      return;
    }

    invalidateNativeArm64Prompt();

    const repoRoot = getRepoRoot();
    if (repoRoot) return gitCheckForUpdates(repoRoot, manual);

    const currentVersion = app.getVersion();
    manualUpdateCheck = manual;
    updateStatus = "checking";
    setOverlay("checking");
    rebuildMenus();
    await showInfoBubble(
      "checking",
      t("checkForUpdates", "Check for Updates"),
      t("checkingForUpdates", "Checking for Updates...")
    );

    let latestRelease;
    let latestVersion;
    try {
      latestRelease = await fetchLatestRelease();
      latestVersion = latestRelease.tag_name;
    } catch (err) {
      updateStatus = "error";
      manualUpdateCheck = false;
      rebuildMenus();
      clearOverlay();
      if (manual) {
        await showErrorBubble({
          failureType: classifyFailureType(err.message),
          operation: "Check for Updates",
          reason: getErrorMessage(err),
          nextStep: "Check your network connection and try again.",
          detail: getErrorMessage(err),
        });
      }
      return;
    }

    if (await maybePromptNativeArm64Installer(latestRelease, { manual, currentVersion })) return;

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      updateStatus = "idle";
      manualUpdateCheck = false;
      rebuildMenus();
      if (manual) await showUpToDateBubble(currentVersion);
      else dismissToResolvedState();
      return;
    }

    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      updateStatus = "error";
      manualUpdateCheck = false;
      rebuildMenus();
      clearOverlay();
      if (manual) {
        await showErrorBubble({
          failureType: "Updater Unavailable",
          operation: "Check for Updates",
          reason: "AutoUpdater not available",
          nextStep: "Restart Clawd or reinstall the packaged app, then try again.",
          detail: "AutoUpdater not available",
        });
      }
      return;
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        updateStatus = "idle";
        manualUpdateCheck = false;
        rebuildMenus();
        dismissToResolvedState();
      }
    } catch (err) {
      if (isUpdate404Error(err)) {
        updateStatus = "idle";
        manualUpdateCheck = false;
        rebuildMenus();
        if (manual) await showUpToDateBubble(currentVersion);
        else dismissToResolvedState();
      } else {
        updateStatus = "error";
        manualUpdateCheck = false;
        rebuildMenus();
        clearOverlay();
        if (manual) {
          await showErrorBubble({
            failureType: classifyFailureType(err.message),
            operation: "Check for Updates",
            reason: getErrorMessage(err),
            nextStep: "Check your network connection and try again.",
            detail: getErrorMessage(err),
          });
        }
      }
    }
  }

  function getUpdateMenuLabel() {
    switch (updateStatus) {
      case "checking":
        return t("checkingForUpdates", "Checking for Updates...");
      case "downloading":
        return getRepoRoot()
          ? t("updating", "Updating...")
          : t("updateDownloading", "Downloading Update...");
      case "ready":
        return t("updateReady", "Update Ready");
      default:
        return t("checkForUpdates", "Check for Updates");
    }
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

  return {
    setupAutoUpdater,
    checkForUpdates,
    getUpdateMenuItem,
    getUpdateMenuLabel,
  };
}

module.exports = initUpdater;
module.exports.__test = {
  compareVersions,
  findWindowsArm64InstallerAsset,
  formatVersionForMessage,
  isUpdate404Error,
  shouldPromptNativeArm64,
};
