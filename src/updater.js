const https = require("https");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const electron = require("electron");
const { redactSecrets } = require("./secret-redact");

const RELEASES_LATEST_URL = "https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest";
const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_ERROR_DETAIL_MAX_LENGTH = 8 * 1024;

const UPDATE_ERROR_COPY = Object.freeze({
  NETWORK_OFFLINE: {
    suffix: "NetworkOffline",
    message: "Clawd could not reach the update service because the network appears to be offline.",
    nextStep: "Reconnect to the internet, then check for updates again.",
  },
  DNS_FAILED: {
    suffix: "DnsFailed",
    message: "The update service address could not be resolved.",
    nextStep: "Check DNS, VPN, or proxy settings, then try again.",
  },
  CONNECTION_TIMEOUT: {
    suffix: "ConnectionTimeout",
    message: "The update request timed out before the service responded.",
    nextStep: "Check the connection or proxy and retry in a moment.",
  },
  TLS_OR_PROXY: {
    suffix: "TlsOrProxy",
    message: "A TLS certificate or proxy prevented a secure connection to the update service.",
    nextStep: "Review proxy and certificate settings, then try again.",
  },
  GITHUB_RATE_LIMIT: {
    suffix: "RateLimit",
    message: "GitHub temporarily limited update requests.",
    nextStep: "Wait a few minutes before checking again.",
  },
  HTTP_SERVICE_ERROR: {
    suffix: "Service",
    message: "The update service returned a temporary server error.",
    nextStep: "Try again later or open the releases page manually.",
  },
  GIT_DIRTY_WORKTREE: {
    suffix: "DirtyWorktree",
    message: "Local files have uncommitted changes, so the source checkout cannot be updated safely.",
    nextStep: "Commit or stash your changes, then try the update again.",
  },
  GIT_FETCH_FAILED: {
    suffix: "GitFetch",
    message: "Clawd could not fetch the latest source revision.",
    nextStep: "Check the Git remote and network connection, then try again.",
  },
  GIT_REMOTE_OR_BRANCH: {
    suffix: "GitRemote",
    message: "The configured Git remote or branch is unavailable.",
    nextStep: "Verify the current branch and its origin remote before retrying.",
  },
  GIT_UPDATE_FAILED: {
    suffix: "GitUpdate",
    message: "The source checkout could not apply the latest update.",
    nextStep: "Resolve the reported Git error, then try again.",
  },
  UPDATER_UNAVAILABLE: {
    suffix: "UpdaterUnavailable",
    message: "The packaged updater is unavailable in this installation.",
    nextStep: "Restart Clawd or reinstall it from the latest official package.",
  },
  NO_COMPATIBLE_ASSET: {
    suffix: "NoAsset",
    message: "A newer release exists, but it has no compatible package for this platform and architecture.",
    nextStep: "Open the releases page and check whether a matching installer is available.",
  },
  DOWNLOAD_FAILED: {
    suffix: "Download",
    message: "The update package could not be downloaded.",
    nextStep: "Check the network and available disk space, then try again.",
  },
  INTEGRITY_FAILED: {
    suffix: "Integrity",
    message: "The downloaded update failed its integrity check.",
    nextStep: "Retry the download. If it repeats, install the release manually.",
  },
  DISK_OR_PERMISSION: {
    suffix: "DiskPermission",
    message: "Clawd could not write the update because of disk space or file permissions.",
    nextStep: "Free disk space or check install-folder permissions, then retry.",
  },
  DEPENDENCY_INSTALL_FAILED: {
    suffix: "Dependency",
    message: "Updated dependencies could not be installed.",
    nextStep: "Run npm install in the Clawd repository, then restart Clawd.",
  },
  UNKNOWN: {
    suffix: "Unknown",
    message: "Clawd encountered an unexpected error while updating.",
    nextStep: "Copy the error details and try again later.",
  },
});

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
    /Cannot find latest(?:-[^/\\\s]+)?\.yml/i.test(String(err.message || ""))
  ));
}

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return String(err.message || err).trim() || "Unknown error";
}

function sanitizeUpdateErrorDetail(value, maxLength = UPDATE_ERROR_DETAIL_MAX_LENGTH) {
  let text = redactSecrets(value);
  const tokenBoundary = String.raw`(^|[\s"'(<\[{=:,;\x60])`;
  text = text.replace(
    new RegExp(`${tokenBoundary}([a-z][a-z0-9+.-]*:\\/\\/)(?:[^/\\s?#"'<>]*@)`, "gim"),
    "$1$2[REDACTED]@"
  );
  text = text.replace(
    new RegExp(`${tokenBoundary}([a-z][a-z0-9+.-]*:\\/\\/[^\\s?#"'<>]+)(?:\\?[^\\s#"'<>]*)?(?:#[^\\s"'<>]*)?`, "gim"),
    "$1$2"
  );
  text = text.replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]");
  // Copied updater diagnostics use a stricter policy than user-facing approval
  // summaries: redact even custom lower-case names such as company_api_token.
  text = text.replace(
    /(^|[\s"'(<\[{=:,;\x60])([a-z0-9_.-]+)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,;\r\n}]+)/gim,
    (match, prefix, key) => /(?:token|password|passwd|secret|api[_-]?key|cookie|credential)/i.test(key)
      ? `${prefix}${key}=[REDACTED]`
      : match
  );
  if (text.length <= maxLength) return text.trim();
  const suffix = "\n... [truncated]";
  return (text.slice(0, Math.max(0, maxLength - suffix.length)) + suffix).trim();
}

function classifyUpdateError(err, meta = {}) {
  const code = String(err && err.code || "").toUpperCase();
  const status = Number(err && (err.statusCode || err.status || (err.response && err.response.status)));
  const text = getErrorMessage(err).toLowerCase();
  const phase = String(meta.phase || "").toLowerCase();
  const mode = String(meta.mode || "").toLowerCase();

  if (["ERR_UPDATER_ZIP_FILE_NOT_FOUND", "ERR_UPDATER_NO_FILES_PROVIDED"].includes(code)) {
    return "NO_COMPATIBLE_ASSET";
  }
  if ((meta.releaseConfirmed === true) && (status === 404 || isUpdate404Error(err))) return "NO_COMPATIBLE_ASSET";
  if (["ENETDOWN", "ENETUNREACH", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED"].includes(code)
      || text.includes("network is offline") || text.includes("network down") || text.includes("offline")) return "NETWORK_OFFLINE";
  if (["ENOTFOUND", "EAI_AGAIN", "ERR_NAME_NOT_RESOLVED"].includes(code)
      || text.includes("getaddrinfo") || text.includes("name not resolved")) return "DNS_FAILED";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_TIMED_OUT"].includes(code)
      || text.includes("timed out") || text.includes("timeout")) return "CONNECTION_TIMEOUT";
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || text.includes("certificate")
      || text.includes("self signed") || text.includes("proxy")) return "TLS_OR_PROXY";
  if (status === 429 || (status === 403 && (text.includes("rate") || text.includes("github")))) return "GITHUB_RATE_LIMIT";
  if (status >= 500) return "HTTP_SERVICE_ERROR";
  if (text.includes("dirty worktree") || text.includes("uncommitted") || text.includes("local files have been modified")) {
    return "GIT_DIRTY_WORKTREE";
  }
  if (code === "ENOSPC" || code === "EACCES" || code === "EPERM" || text.includes("no space left")
      || text.includes("permission denied") || text.includes("access denied")) return "DISK_OR_PERMISSION";
  if (phase === "integrity" || text.includes("checksum") || text.includes("sha512") || text.includes("integrity")) {
    return "INTEGRITY_FAILED";
  }
  if (phase === "dependency-install" || text.includes("npm install")) return "DEPENDENCY_INSTALL_FAILED";
  if (mode === "git" && (text.includes("couldn't find remote ref") || text.includes("unknown revision")
      || text.includes("not a git repository") || text.includes("no such remote") || text.includes("remote branch"))) {
    return "GIT_REMOTE_OR_BRANCH";
  }
  if (phase === "git-fetch") return "GIT_FETCH_FAILED";
  if (phase === "git-apply") return "GIT_UPDATE_FAILED";
  if (phase === "download" || text.includes("download")) return "DOWNLOAD_FAILED";
  if (text.includes("autoupdater not available") || text.includes("updater unavailable")) return "UPDATER_UNAVAILABLE";
  if (status >= 400) return "HTTP_SERVICE_ERROR";
  return "UNKNOWN";
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
  const now = deps.now || (() => Date.now());
  const t = makeTranslate(ctx);
  const runtimePlatform = deps.platform || process.platform;
  const runtimeArch = deps.arch || process.arch;

  let updateStatus = "idle";
  let updateCheckSnapshot = Object.freeze({ state: "idle" });
  // activeCheck carries the current in-flight check context. trigger:
  // 'manual' | 'scheduled' | 'arm64-startup'. intent: 'check' | 'download'.
  // The scheduled discovery path (quietDiscover) intentionally does NOT
  // populate activeCheck — it bypasses electron-updater. activeCheck only
  // tracks the manual / electron-updater leg, so its trigger reflects who
  // is currently driving promptAvailableUpdate / showInfoBubble.
  let activeCheck = null;
  let repoRootCache;
  let autoUpdaterInstance = null;
  let installRequested = false;
  let overlayKind = null;
  let nativeArm64PromptDismissed = false;
  let nativeArm64PromptToken = 0;
  // Pending state for the #329 scheduler. pendingUpdateVersion mirrors a
  // prefs field; we cache the release JSON in memory so a user clicking
  // Update Now from the menu does not need a fresh GitHub request first.
  // pendingPromptDeferred holds the resume hook for the DND/mini exit path.
  let pendingUpdateVersion = "";
  let pendingUpdateRelease = null;
  let pendingPromptDeferred = null;

  function cloneUpdateCheckSnapshot() {
    return {
      ...updateCheckSnapshot,
      ...(updateCheckSnapshot.error ? { error: { ...updateCheckSnapshot.error } } : {}),
    };
  }

  function publishUpdateCheckSnapshot(stateName, details = {}) {
    updateStatus = stateName;
    const next = { state: stateName };
    if (details.version) next.version = String(details.version);
    if (details.error) next.error = { ...details.error };
    updateCheckSnapshot = Object.freeze(next);
    if (typeof ctx.onUpdateCheckStatusChanged === "function") {
      try { ctx.onUpdateCheckStatusChanged(cloneUpdateCheckSnapshot()); } catch {}
    }
    return cloneUpdateCheckSnapshot();
  }

  function getUpdateCheckSnapshot() {
    return cloneUpdateCheckSnapshot();
  }

  function buildUpdateErrorReport(err, meta = {}) {
    const code = meta.code || classifyUpdateError(err, meta);
    const copy = UPDATE_ERROR_COPY[code] || UPDATE_ERROR_COPY.UNKNOWN;
    const message = t(`updateError${copy.suffix}Msg`, copy.message);
    const nextStep = t(`updateError${copy.suffix}Next`, copy.nextStep);
    const rawDetail = [meta.detail, getErrorMessage(err)]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join("\n\n");
    const detail = sanitizeUpdateErrorDetail(rawDetail);
    const timestamp = new Date(now()).toISOString();
    const phase = meta.phase || "availability-check";
    const mode = meta.mode || (getRepoRoot() ? "git" : "packaged");
    const report = {
      code,
      phase,
      title: t("updateError", "Update Error"),
      message,
      nextStep,
      detail,
      copyText: "",
      timestamp,
      appVersion: String(app.getVersion()),
      platform: runtimePlatform,
      arch: runtimeArch,
      mode,
    };
    report.copyText = sanitizeUpdateErrorDetail([
      report.title,
      report.message,
      report.nextStep,
      "",
      `Code: ${report.code}`,
      `Phase: ${report.phase}`,
      `Time: ${report.timestamp}`,
      `App: ${report.appVersion}`,
      `Platform: ${report.platform}/${report.arch}`,
      `Mode: ${report.mode}`,
      report.detail ? "" : null,
      report.detail || null,
    ].filter((line) => line != null).join("\n"));
    return report;
  }

  function clearUpdateError() {
    if (updateStatus === "error") {
      publishUpdateCheckSnapshot("idle");
      clearOverlay();
      rebuildMenus();
    }
    return getUpdateCheckSnapshot();
  }

  function isManualCheck() {
    return !!activeCheck && activeCheck.trigger === "manual";
  }

  function isDownloadIntent() {
    return !!activeCheck && activeCheck.intent === "download";
  }

  function beginActiveCheck(opts = {}) {
    activeCheck = {
      trigger: opts.trigger || "manual",
      intent: opts.intent || "check",
      version: opts.version || null,
      releaseConfirmed: opts.releaseConfirmed === true,
    };
  }

  function clearActiveCheck() {
    activeCheck = null;
  }

  function rebuildMenus() {
    if (typeof ctx.rebuildAllMenus === "function") ctx.rebuildAllMenus();
  }

  // ── #329 pending-update state (Phase 2) ──────────────────────────────
  // Prefs IO is delegated to ctx.getUpdatePref / setUpdatePref. main.js
  // wires these to settingsController so reads/writes go through the
  // single-writer architecture and persist to clawd-prefs.json.
  function readPref(key, fallback) {
    if (typeof ctx.getUpdatePref !== "function") return fallback;
    try {
      const value = ctx.getUpdatePref(key);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    if (typeof ctx.setUpdatePref !== "function") return;
    try { ctx.setUpdatePref(key, value); } catch {}
  }

  function getDismissedMap() {
    const raw = readPref("dismissedUpdateVersions", {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  function isVersionDismissed(version) {
    if (!version) return false;
    return getDismissedMap()[version] === true;
  }

  function markVersionDismissed(version) {
    if (!version) return;
    const map = { ...getDismissedMap() };
    if (map[version] === true) return;
    map[version] = true;
    writePref("dismissedUpdateVersions", map);
  }

  function pruneDismissedBelow(currentVersion) {
    if (!currentVersion) return;
    const map = getDismissedMap();
    const keys = Object.keys(map);
    if (!keys.length) return;
    const next = {};
    let mutated = false;
    for (const v of keys) {
      if (compareVersions(currentVersion, v) < 0) {
        next[v] = true;
      } else {
        mutated = true;
      }
    }
    if (mutated) writePref("dismissedUpdateVersions", next);
  }

  function setPendingUpdate(version, release) {
    if (pendingUpdateVersion === version && pendingUpdateRelease === release) return;
    pendingUpdateVersion = version || "";
    pendingUpdateRelease = release || null;
    writePref("pendingUpdateVersion", pendingUpdateVersion);
    rebuildMenus();
  }

  function clearPendingUpdate() {
    const storedPending = String(readPref("pendingUpdateVersion", "") || "");
    if (!pendingUpdateVersion && !pendingUpdateRelease && !pendingPromptDeferred && !storedPending) return;
    pendingUpdateVersion = "";
    pendingUpdateRelease = null;
    pendingPromptDeferred = null;
    writePref("pendingUpdateVersion", "");
    rebuildMenus();
  }

  // Boot-time reconciliation. If the user installed out-of-band (manual
  // download from the macOS releases page, sysadmin push, etc.), the
  // pending version stored in prefs may now equal or trail the running
  // app version. Clear it so the menu badge / About hint don't lie, and
  // drop dismissed entries that no longer matter.
  function reconcilePendingOnStartup() {
    const current = app.getVersion();
    const storedPending = String(readPref("pendingUpdateVersion", "") || "");
    if (storedPending) {
      if (compareVersions(current, storedPending) >= 0) {
        pendingUpdateVersion = "";
        pendingUpdateRelease = null;
        writePref("pendingUpdateVersion", "");
      } else {
        pendingUpdateVersion = storedPending;
      }
    }
    pruneDismissedBelow(current);
    rebuildMenus();
  }

  // Called by main.js when the user leaves DND or exits mini mode. If we
  // discovered a new version during silent mode and stashed a deferred
  // prompt, run it now — but only if both silent modes are actually off.
  // Otherwise (e.g. DND off but still in mini, or vice versa) we are still
  // in silent territory and the prompt has to keep waiting for the second
  // exit.
  function onSilentModeExit() {
    if (!pendingPromptDeferred) return;
    if (isSilentMode()) return;
    const run = pendingPromptDeferred;
    pendingPromptDeferred = null;
    Promise.resolve()
      .then(() => run())
      .catch((err) => log(`pending prompt resume failed: ${err && err.message}`));
  }

  function getPendingUpdateVersion() {
    return pendingUpdateVersion;
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

  // Helper for callers that only care about the action id (the historical
  // contract). Resolves to the action string regardless of whether the
  // bubble returned a tagged {action, source} object or a raw string
  // (legacy test mocks). handlePendingVersion uses awaitBubbleResult
  // instead when it needs the source tag for dedupe gating.
  async function awaitBubbleAction(maybePromise) {
    const result = await maybePromise;
    if (result && typeof result === "object" && "action" in result) return result.action;
    return result;
  }

  // Same shape normalization, but returns the full { action, source }
  // tuple. Phase 2 handlePendingVersion consumes this so it can gate
  // dedupe on source === 'user'.
  async function awaitBubbleResult(maybePromise) {
    const result = await maybePromise;
    if (result && typeof result === "object" && "action" in result) return result;
    return { action: result == null ? null : result, source: "user" };
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
    const candidate = typeof detailOrReport === "object" && detailOrReport !== null && !Array.isArray(detailOrReport)
      ? detailOrReport
      : { detail: detailOrReport, message: messageOverride };
    const report = candidate.code && candidate.copyText
      ? candidate
      : buildUpdateErrorReport(candidate.error || candidate.reason || candidate.detail, candidate);
    publishUpdateCheckSnapshot("error", { error: report });
    pulseState("error");
    return showBubble({
      mode: "error",
      title: report.title,
      message: report.message,
      detail: [report.nextStep, `Code: ${report.code}`, report.detail].filter(Boolean).join("\n\n"),
      copyText: report.copyText,
      copyFeedback: {
        copied: t("updateErrorCopied", "Copied"),
        failed: t("updateErrorCopyFailed", "Copy failed"),
      },
      actions: [
        { id: "copy-error", label: t("updateErrorCopy", "Copy Error"), variant: "secondary" },
        { id: "dismiss", label: t("dismiss", "Dismiss"), variant: "secondary" },
      ],
      defaultAction: "dismiss",
      lang: ctx.lang || "en",
      requireAction: true,
    });
  }

  async function showUpToDateBubble(version) {
    const displayVersion = formatVersionForMessage(version);
    clearOverlay();
    return showInfoBubble(
      "up-to-date",
      t("updateNotAvailable", "You're Up to Date"),
      t("updateNotAvailableMsg", "Clawd v{version} is the latest version.").replace("{version}", displayVersion),
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

  // ETag cache for the GitHub releases endpoint. Keeps unauthenticated
  // requests well under the 60 req/h limit when nothing has shipped.
  // Module-scoped within the initUpdater closure so the cache survives
  // across calls but is dropped when the module re-inits.
  let lastReleaseEtag = "";
  let lastReleaseJson = null;

  function buildGitHubApiStatusError(res, body) {
    const statusCode = res && res.statusCode;
    const headers = (res && res.headers) || {};
    const parts = [`GitHub API returned ${statusCode}`];
    const remaining = headers["x-ratelimit-remaining"];
    const limit = headers["x-ratelimit-limit"];
    const reset = headers["x-ratelimit-reset"];
    if (remaining != null || limit != null) {
      parts.push(`rate limit ${remaining != null ? remaining : "?"}/${limit != null ? limit : "?"}`);
    }
    if (reset != null) parts.push(`reset ${reset}`);
    const trimmedBody = String(body || "").trim();
    if (trimmedBody) {
      try {
        const parsed = JSON.parse(trimmedBody);
        if (parsed && parsed.message) parts.push(String(parsed.message));
      } catch {
        parts.push(trimmedBody.slice(0, 160));
      }
    }
    const err = new Error(parts.join("; "));
    err.statusCode = statusCode;
    return err;
  }

  function extractLatestRedirectTag(location) {
    if (!location) return "";
    try {
      const url = new URL(String(location), RELEASES_LATEST_URL);
      const match = /\/releases\/tag\/([^/?#]+)\/?$/.exec(url.pathname);
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }

  function fetchLatestReleaseViaRedirect() {
    return new Promise((resolve, reject) => {
      const req = httpsGet({
        hostname: "github.com",
        path: "/rullerzhou-afk/clawd-on-desk/releases/latest",
        headers: {
          "User-Agent": "Clawd-on-Desk",
          Accept: "text/html,*/*",
        },
      }, (res) => {
        const tag = extractLatestRedirectTag(res.headers && res.headers.location);
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 300 && res.statusCode < 400 && tag) {
            // The redirect fallback only exposes the tag, not release assets.
            // Windows-on-ARM64 native-installer prompts therefore fall back to
            // the normal updater path while the GitHub API is unavailable.
            return resolve({ tag_name: tag, assets: [] });
          }
          reject(new Error(`GitHub releases redirect returned ${res.statusCode}${data ? `: ${data.slice(0, 160)}` : ""}`));
        });
        res.on("error", reject);
      });

      if (req && typeof req.on === "function") req.on("error", reject);
      if (req && typeof req.setTimeout === "function") {
        req.setTimeout(10000, () => {
          if (typeof req.destroy === "function") req.destroy();
          reject(new Error("GitHub releases redirect request timed out (10s)"));
        });
      }
    });
  }

  function fetchLatestReleaseFromApi() {
    return new Promise((resolve, reject) => {
      const headers = { "User-Agent": "Clawd-on-Desk" };
      if (lastReleaseEtag) headers["If-None-Match"] = lastReleaseEtag;
      const req = httpsGet({
        hostname: "api.github.com",
        path: "/repos/rullerzhou-afk/clawd-on-desk/releases/latest",
        headers,
      }, (res) => {
        // 304 Not Modified — drain and serve the cached release.
        if (res.statusCode === 304) {
          res.resume();
          res.on("end", () => {
            if (lastReleaseJson) return resolve(lastReleaseJson);
            return reject(new Error("304 Not Modified but no cached release"));
          });
          res.on("error", reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            if (res.statusCode === 404) return reject(new Error("No releases found"));
            return reject(buildGitHubApiStatusError(res, data));
          }
          try {
            const release = JSON.parse(data);
            if (!release.tag_name) return reject(new Error("No tag_name in release"));
            const etag = res.headers && (res.headers.etag || res.headers.ETag);
            if (etag) lastReleaseEtag = String(etag);
            lastReleaseJson = release;
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

  async function fetchLatestRelease() {
    try {
      return await fetchLatestReleaseFromApi();
    } catch (err) {
      if (err && err.message === "No releases found") throw err;
      if (!err || err.statusCode == null) throw err;
      const reason = getErrorMessage(err);
      log(`GitHub API latest release lookup failed (${err.statusCode}): ${reason}; trying releases/latest redirect`);
      return fetchLatestReleaseViaRedirect();
    }
  }

  // Scheduler-only discovery path. Looks up the latest release, compares
  // against the running app version, and returns a structured result.
  // Strictly no UI side effects: no setOverlay, no showInfoBubble, no
  // showUpdateBubble, no applyState. Errors are logged + returned, never
  // bubbled.
  // electron-updater is intentionally bypassed here — see plan
  // "Architectural Boundary" section. If the caller wants to actually
  // download what this returns, route through checkForUpdates({ trigger:
  // 'manual', intent: 'download' }) to re-establish the electron-updater
  // event context.
  async function quietDiscover() {
    try {
      const release = await fetchLatestRelease();
      const version = release && release.tag_name;
      if (!version) return { status: "no-update" };
      const current = app.getVersion();
      if (compareVersions(current, version) >= 0) {
        return { status: "no-update", version };
      }
      return { status: "new-update", version, release };
    } catch (err) {
      const message = (err && err.message) || String(err);
      log(`quietDiscover error: ${message}`);
      return { status: "error", message };
    }
  }

  // Called by the scheduler (Phase 3) after quietDiscover() finds a new
  // version. The ctx parameter carries this prompt's local context —
  // `{ trigger: 'scheduled' }` by default. Dedupe decisions live inside
  // this prompt's local scope, not on the global activeCheck token (which
  // quietDiscover intentionally does not populate).
  //
  // Flow:
  //   1. dismissed already → menu badge only, no bubble.
  //   2. silent mode (DND or mini) → menu badge + defer the bubble to
  //      onSilentModeExit.
  //   3. else → one-shot pulseState('notification'), then show the
  //      promptAvailableUpdate bubble. Decide on the resolved
  //      { action, source } tuple:
  //        - action='primary'        → re-enter manual checkForUpdates
  //          with intent='download' so electron-updater can drive the
  //          actual download (see Architectural Boundary in the plan).
  //        - action='later', source='user' → markVersionDismissed.
  //        - any other source (autoClose / policy / closed) → menu badge
  //          only; do NOT pollute the dedupe store with a dismissal the
  //          user never made.
  async function handlePendingVersion(version, release, promptCtx = { trigger: "scheduled" }) {
    if (!version) return;
    const displayVersion = formatVersionForMessage(version);

    // Always record the pending version so the tray label / About hint
    // reflect reality, even if we end up not showing the bubble.
    setPendingUpdate(version, release);

    if (isVersionDismissed(version)) return;

    if (isSilentMode()) {
      pendingPromptDeferred = () => handlePendingVersion(version, release, promptCtx);
      return;
    }

    // One-shot notification pulse. pulseState clears the overlay first
    // and lets AUTO_RETURN_MS in state.js reclaim the state, so the
    // pet does not get stuck masking working/thinking.
    pulseState("notification");

    const primaryLabel = t("download", "Download");
    const messageKey = t("updateAvailableMsg", "v{version} is available. Download and install now?");

    const result = await awaitBubbleResult(showBubble({
      mode: "available",
      title: t("updateAvailable", "Update Available"),
      message: messageKey.replace("{version}", displayVersion),
      version,
      actions: [
        { id: "primary", label: primaryLabel, variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    }));

    if (result.action === "primary") {
      // Round-trip to re-establish the electron-updater event context.
      // checkForUpdates will normalize this into a manual download path
      // and (via setupAutoUpdater's update-available handler with
      // wantsAutoPrimary=true) skip the second promptAvailableUpdate.
      try {
        await checkForUpdates({ trigger: "manual", intent: "download" });
      } catch (err) {
        log(`pending download round-trip failed: ${err && err.message}`);
      }
      return;
    }

    if (result.action === "later" && result.source === "user") {
      markVersionDismissed(version);
    }
    // For autoClose / policy / closed: pending state already set above,
    // tray label still shows the badge, but no dedupe entry — so the
    // next scheduled tick will surface the bubble again.
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
    const displayVersion = formatVersionForMessage(version);
    const primaryLabel = mode === "git"
      ? t("updateNow", "Update Now")
      : t("download", "Download");
    const action = await awaitBubbleAction(showBubble({
      mode: "available",
      title: t("updateAvailable", "Update Available"),
      message: t("updateAvailableMsg", "v{version} is available. Download and install now?")
        .replace("{version}", displayVersion),
      version,
      actions: [
        { id: "primary", label: primaryLabel, variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    }));

    if (action === "primary") return onPrimary();
    hideBubble();
    dismissToResolvedState();
    publishUpdateCheckSnapshot("idle");
    rebuildMenus();
    clearActiveCheck();
    return null;
  }

  async function promptReadyUpdate(version, onPrimary) {
    const displayVersion = formatVersionForMessage(version);
    pulseSuccessState();
    const action = await awaitBubbleAction(showBubble({
      mode: "ready",
      title: t("updateReady", "Update Ready"),
      message: t(
        "updateReadyMsg",
        "v{version} has been downloaded. Restart now to finish updating, or choose Later to finish after you quit and reopen Clawd."
      ).replace("{version}", displayVersion),
      version,
      actions: [
        { id: "primary", label: t("restartNow", "Restart Now"), variant: "primary" },
        { id: "later", label: t("restartLater", "Later"), variant: "secondary" },
      ],
      defaultAction: "later",
      lang: ctx.lang || "en",
      requireAction: true,
    }));

    if (action === "primary") return onPrimary();
    hideBubble();
    dismissToResolvedState();
    publishUpdateCheckSnapshot("idle");
    rebuildMenus();
    return null;
  }

  async function requestInstall(version) {
    if (installRequested) return null;
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      return showErrorBubble(buildUpdateErrorReport(new Error("AutoUpdater not available."), {
        phase: "install",
        mode: "packaged",
        releaseConfirmed: true,
      }));
    }

    installRequested = true;
    void showInfoBubble(
      "downloading",
      t("updateInstalling", "Installing Update..."),
      t("updateInstallingMsg", "Preparing the update. Clawd will restart when it is ready."),
      { version }
    );

    try {
      return await autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      installRequested = false;
      return showErrorBubble(buildUpdateErrorReport(err, {
        phase: "install",
        mode: "packaged",
        releaseConfirmed: true,
      }));
    }
  }

  async function maybePromptNativeArm64Installer(release, { manual = false, currentVersion = app.getVersion() } = {}) {
    if (!isRunningX64OnWindowsArm64()) return false;
    if (!manual && (nativeArm64PromptDismissed || isSilentMode())) return false;
    if (!manual && (activeCheck || updateStatus !== "idle")) return false;

    const version = release && release.tag_name;
    if (!version || compareVersions(currentVersion, version) > 0) return false;
    const displayVersion = formatVersionForMessage(version);

    const asset = findWindowsArm64InstallerAsset(release);
    if (!asset) return false;
    const promptToken = nativeArm64PromptToken + 1;
    nativeArm64PromptToken = promptToken;

    publishUpdateCheckSnapshot("available", { version });
    setOverlay("available");
    rebuildMenus();

    const action = await awaitBubbleAction(showBubble({
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
    }));

    if (promptToken !== nativeArm64PromptToken) return true;

    if (action === "primary") {
      shell.openExternal(asset.browser_download_url || RELEASES_LATEST_URL);
      publishUpdateCheckSnapshot("idle");
      clearActiveCheck();
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
    publishUpdateCheckSnapshot("idle");
    clearActiveCheck();
    rebuildMenus();
    return true;
  }

  async function runGitUpdate(repoRoot, branch, localHead) {
    publishUpdateCheckSnapshot("downloading");
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
      err.updatePhase = "git-apply";
      throw err;
    }
    const diff = await gitCmd(["diff", "--name-only", localHead, "HEAD"], repoRoot);
    if (diff.includes("package.json") || diff.includes("package-lock.json")) {
      try {
        await new Promise((resolve, reject) => {
          execFileFn("npm", ["install", "--no-fund", "--no-audit"], {
            cwd: repoRoot,
            timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
            shell: runtimePlatform === "win32",
          }, (err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        err.updatePhase = "dependency-install";
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
    publishUpdateCheckSnapshot("checking");
    beginActiveCheck({ trigger: manual ? "manual" : "scheduled", intent: "check" });
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
        publishUpdateCheckSnapshot("up-to-date", { version: app.getVersion() });
        clearActiveCheck();
        rebuildMenus();
        if (manual) void showUpToDateBubble(app.getVersion());
        else dismissToResolvedState();
        return getUpdateCheckSnapshot();
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
        publishUpdateCheckSnapshot("idle");
        clearActiveCheck();
        dismissToResolvedState();
        return getUpdateCheckSnapshot();
      }

      publishUpdateCheckSnapshot("available", { version: remoteVersion });
      setOverlay("available");
      rebuildMenus();

      void promptAvailableUpdate({
        mode: "git",
        version: remoteVersion,
        onPrimary: async () => {
          const dirty = await gitCmd(["status", "--porcelain"], repoRoot);
          if (dirty) {
            clearActiveCheck();
            rebuildMenus();
            clearOverlay();
            await showErrorBubble(buildUpdateErrorReport(new Error("Local files have uncommitted changes."), {
              code: "GIT_DIRTY_WORKTREE",
              phase: "git-apply",
              mode: "git",
              detail: dirty,
            }));
            return;
          }
          await runGitUpdate(repoRoot, branch, localHead);
        },
      }).catch(async (err) => {
        clearActiveCheck();
        rebuildMenus();
        clearOverlay();
        await showErrorBubble(buildUpdateErrorReport(err, {
          phase: err && err.updatePhase || "git-apply",
          mode: "git",
        }));
      });
      return getUpdateCheckSnapshot();
    } catch (err) {
      clearActiveCheck();
      rebuildMenus();
      clearOverlay();
      const report = buildUpdateErrorReport(err, {
        phase: err && err.updatePhase || "git-fetch",
        mode: "git",
      });
      if (manual) {
        void showErrorBubble(report);
      } else {
        publishUpdateCheckSnapshot("error", { error: report });
      }
      return getUpdateCheckSnapshot();
    }
  }

  // ── #329 background update scheduler (Phase 3) ───────────────────────
  // Drives quietDiscover() on a 12h ± 30min cycle (first tick 2–5 min
  // after start) in packaged builds only. Down stream: handlePendingVersion
  // owns the bubble + dedupe semantics.
  const FIRST_DELAY_MIN_MS = 2 * 60 * 1000;
  const FIRST_DELAY_MAX_MS = 5 * 60 * 1000;
  const RECURRING_BASE_MS = 12 * 60 * 60 * 1000;
  const RECURRING_JITTER_MS = 30 * 60 * 1000;

  let schedulerTimer = null;
  let schedulerRunning = false;
  const setTimeoutFn = deps.setTimeoutImpl || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutImpl || clearTimeout;
  const randomFn = deps.randomImpl || Math.random;

  function pickFirstDelay() {
    return FIRST_DELAY_MIN_MS + Math.floor(randomFn() * (FIRST_DELAY_MAX_MS - FIRST_DELAY_MIN_MS + 1));
  }

  function pickRecurringDelay() {
    const offset = Math.floor((randomFn() * 2 - 1) * RECURRING_JITTER_MS);
    return RECURRING_BASE_MS + offset;
  }

  async function schedulerTick() {
    schedulerTimer = null;
    try {
      const result = await quietDiscover();
      if (result && result.status === "new-update") {
        await handlePendingVersion(result.version, result.release, { trigger: "scheduled" });
      }
    } catch (err) {
      log(`scheduler tick error: ${err && err.message}`);
    }
    if (!schedulerRunning) return;
    schedulerTimer = setTimeoutFn(schedulerTick, pickRecurringDelay());
  }

  function startUpdateScheduler() {
    // Primary guard: only packaged builds. !app.isPackaged covers the
    // zip-source-drop / mid-build-artifacts case that getRepoRoot() misses.
    if (!app.isPackaged) {
      log("scheduler: skip — not packaged");
      return;
    }
    // Defensive secondary guard: even in a packaged build, refuse to run
    // if a .git directory somehow sits next to the bundle.
    if (getRepoRoot()) {
      log("scheduler: skip — git checkout detected");
      return;
    }
    if (readPref("autoUpdateCheck", true) !== true) {
      log("scheduler: skip — autoUpdateCheck pref off");
      return;
    }
    if (schedulerRunning) return;
    schedulerRunning = true;
    schedulerTimer = setTimeoutFn(schedulerTick, pickFirstDelay());
  }

  function stopUpdateScheduler() {
    schedulerRunning = false;
    if (schedulerTimer) {
      clearTimeoutFn(schedulerTimer);
      schedulerTimer = null;
    }
  }

  function isSchedulerRunning() {
    return schedulerRunning;
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
      const wasManual = isManualCheck();
      const wantsAutoPrimary = isDownloadIntent();

      if (!wasManual && isSilentMode()) {
        clearActiveCheck();
        hideBubble();
        publishUpdateCheckSnapshot("idle");
        dismissToResolvedState();
        return;
      }

      publishUpdateCheckSnapshot("available", { version: info.version });
      setOverlay("available");
      rebuildMenus();

      const onPrimary = async () => {
        publishUpdateCheckSnapshot("downloading", { version: info.version });
        setOverlay("downloading");
        rebuildMenus();
        await showInfoBubble(
          "downloading",
          t("updateDownloading", "Downloading Update..."),
          t("updateDownloading", "Downloading Update...")
        );
        autoUpdater.downloadUpdate();
      };

      // intent='download' round-trip from a scheduler bubble: the user
      // already saw promptAvailableUpdate from handlePendingVersion and
      // clicked Download. Prompting again here would force them to click
      // twice. Auto-execute the download branch instead.
      if (wantsAutoPrimary) {
        await onPrimary();
        return;
      }

      await promptAvailableUpdate({
        mode: "packaged",
        version: info.version,
        onPrimary,
      });
    });

    autoUpdater.on("update-not-available", async () => {
      const wasManual = isManualCheck();
      clearActiveCheck();
      publishUpdateCheckSnapshot("up-to-date", { version: app.getVersion() });
      rebuildMenus();
      if (wasManual) {
        void showUpToDateBubble(app.getVersion());
        return;
      }
      dismissToResolvedState();
    });

    autoUpdater.on("update-downloaded", async (info) => {
      clearActiveCheck();
      installRequested = false;
      publishUpdateCheckSnapshot("ready", { version: info.version });
      rebuildMenus();
      clearOverlay();
      await promptReadyUpdate(info.version, async () => {
        await requestInstall(info.version);
      });
    });

    autoUpdater.on("error", async (err) => {
      log(`ERROR: AutoUpdater error: ${err.message}`);
      const failedWhileDownloading = updateStatus === "downloading";
      const failedWhileReady = updateStatus === "ready";
      const failedAfterReleaseConfirmation = failedWhileDownloading || failedWhileReady;
      const shouldShowErrorBubble = isManualCheck() || failedAfterReleaseConfirmation;
      const releaseConfirmed = failedAfterReleaseConfirmation || !!(activeCheck && activeCheck.releaseConfirmed);
      const failurePhase = failedWhileReady
        ? "install"
        : (failedWhileDownloading ? "download" : "availability-check");
      installRequested = false;
      clearActiveCheck();
      if (!shouldShowErrorBubble) {
        const report = buildUpdateErrorReport(err, {
          phase: failurePhase,
          mode: "packaged",
          releaseConfirmed,
        });
        publishUpdateCheckSnapshot("error", { error: report });
        rebuildMenus();
        clearOverlay();
        return;
      }

      if (!failedAfterReleaseConfirmation && isUpdate404Error(err) && !releaseConfirmed) {
        publishUpdateCheckSnapshot("up-to-date", { version: app.getVersion() });
        rebuildMenus();
        void showUpToDateBubble(app.getVersion());
      } else {
        rebuildMenus();
        clearOverlay();
        await showErrorBubble(buildUpdateErrorReport(err, {
          phase: failurePhase,
          mode: "packaged",
          releaseConfirmed,
        }));
      }
    });
  }

  // Normalize legacy boolean signature → opts object.
  // checkForUpdates(true)        → { trigger: 'manual', intent: 'check' }
  // checkForUpdates(false)       → { trigger: 'scheduled', intent: 'check' }
  // checkForUpdates({trigger,intent}) → as-is (defaults trigger='manual', intent='check')
  function normalizeCheckOpts(arg) {
    if (typeof arg === "boolean") {
      return { trigger: arg ? "manual" : "scheduled", intent: "check" };
    }
    if (arg && typeof arg === "object") {
      return {
        trigger: arg.trigger || "manual",
        intent: arg.intent || "check",
      };
    }
    return { trigger: "manual", intent: "check" };
  }

  async function checkForUpdates(arg = true) {
    const hasActiveAvailableFlow = updateStatus === "available" && !!activeCheck;
    if (["checking", "downloading", "ready"].includes(updateStatus) || hasActiveAvailableFlow) {
      log(`Check skipped: already ${updateStatus}`);
      return getUpdateCheckSnapshot();
    }

    invalidateNativeArm64Prompt();

    const opts = normalizeCheckOpts(arg);
    const manual = opts.trigger === "manual";
    const downloadIntent = opts.intent === "download";

    const repoRoot = getRepoRoot();
    if (repoRoot) return gitCheckForUpdates(repoRoot, manual);

    const currentVersion = app.getVersion();
    beginActiveCheck({ trigger: opts.trigger, intent: opts.intent });
    publishUpdateCheckSnapshot("checking");
    // intent='download' is a round-trip from a scheduler-discovered bubble:
    // user already saw and acted, so we skip the "checking…" bubble and the
    // up-to-date toast. The overlay still flashes briefly via setOverlay so
    // the tray label reflects in-flight state.
    setOverlay("checking");
    rebuildMenus();
    if (!downloadIntent) {
      await showInfoBubble(
        "checking",
        t("checkForUpdates", "Check for Updates"),
        t("checkingForUpdates", "Checking for Updates...")
      );
    }

    let latestRelease;
    let latestVersion;
    try {
      latestRelease = await fetchLatestRelease();
      latestVersion = latestRelease.tag_name;
    } catch (err) {
      clearActiveCheck();
      rebuildMenus();
      clearOverlay();
      const report = buildUpdateErrorReport(err, {
        phase: "release-lookup",
        mode: "packaged",
      });
      if (manual) {
        void showErrorBubble(report);
      } else {
        publishUpdateCheckSnapshot("error", { error: report });
      }
      return getUpdateCheckSnapshot();
    }

    if (compareVersions(currentVersion, latestVersion) <= 0 &&
        isRunningX64OnWindowsArm64() &&
        findWindowsArm64InstallerAsset(latestRelease)) {
      publishUpdateCheckSnapshot("available", { version: latestVersion });
      void maybePromptNativeArm64Installer(latestRelease, { manual, currentVersion });
      return getUpdateCheckSnapshot();
    }

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      publishUpdateCheckSnapshot("up-to-date", { version: currentVersion });
      clearActiveCheck();
      rebuildMenus();
      // intent='download' originated from a scheduler bubble that the
      // user already saw. If the round-trip somehow finds no update
      // (latest was yanked between discovery and click), stay silent
      // instead of showing the up-to-date toast — and clear the pending
      // marker so the tray badge / About hint don't keep advertising a
      // version we just confirmed isn't available.
      if (downloadIntent) clearPendingUpdate();
      if (manual && !downloadIntent) void showUpToDateBubble(currentVersion);
      else dismissToResolvedState();
      return getUpdateCheckSnapshot();
    }

    if (activeCheck) {
      activeCheck.version = latestVersion;
      activeCheck.releaseConfirmed = true;
    }

    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      clearActiveCheck();
      rebuildMenus();
      clearOverlay();
      const report = buildUpdateErrorReport(new Error("AutoUpdater not available"), {
        code: "UPDATER_UNAVAILABLE",
        phase: "availability-check",
        mode: "packaged",
        releaseConfirmed: true,
      });
      if (manual) {
        void showErrorBubble(report);
      } else {
        publishUpdateCheckSnapshot("error", { error: report });
      }
      return getUpdateCheckSnapshot();
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      if (updateStatus === "checking") {
        rebuildMenus();
        if (result && result.updateInfo && result.updateInfo.version) {
          publishUpdateCheckSnapshot("available", { version: result.updateInfo.version });
        } else {
          publishUpdateCheckSnapshot("available", { version: latestVersion });
        }
      }
    } catch (err) {
      clearActiveCheck();
      rebuildMenus();
      clearOverlay();
      const report = buildUpdateErrorReport(err, {
        phase: "availability-check",
        mode: "packaged",
        releaseConfirmed: true,
      });
      if (manual) {
        void showErrorBubble(report);
      } else {
        publishUpdateCheckSnapshot("error", { error: report });
      }
    }
    return getUpdateCheckSnapshot();
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
        if (pendingUpdateVersion) {
          return t("checkForUpdatesPending", "Update available · v{version}")
            .replace("{version}", formatVersionForMessage(pendingUpdateVersion));
        }
        return t("checkForUpdates", "Check for Updates");
    }
  }

  function getUpdateMenuItem() {
    const hasActiveAvailableFlow = updateStatus === "available" && !!activeCheck;
    return {
      label: getUpdateMenuLabel(),
      enabled: !["checking", "downloading"].includes(updateStatus) && !hasActiveAvailableFlow,
      click: () => updateStatus === "ready"
        ? requestInstall(updateCheckSnapshot.version)
        : checkForUpdates(true),
    };
  }

  return {
    setupAutoUpdater,
    checkForUpdates,
    getUpdateCheckSnapshot,
    clearUpdateError,
    getUpdateMenuItem,
    getUpdateMenuLabel,
    // ── #329 scheduler hooks (Phase 2+3) ──
    quietDiscover,
    handlePendingVersion,
    reconcilePendingOnStartup,
    onSilentModeExit,
    getPendingUpdateVersion,
    startUpdateScheduler,
    stopUpdateScheduler,
    isSchedulerRunning,
  };
}

module.exports = initUpdater;
module.exports.__test = {
  DEPENDENCY_INSTALL_TIMEOUT_MS,
  compareVersions,
  findWindowsArm64InstallerAsset,
  formatVersionForMessage,
  isUpdate404Error,
  classifyUpdateError,
  sanitizeUpdateErrorDetail,
  shouldPromptNativeArm64,
  UPDATE_ERROR_DETAIL_MAX_LENGTH,
};
