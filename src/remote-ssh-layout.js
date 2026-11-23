"use strict";

const path = require("path");

const REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT = "account-default";
const REMOTE_RUNTIME_MODE_PROFILE_ISOLATED = "profile-isolated";
const ACCOUNT_DEFAULT_RUNTIME_KEY = "account-default";
const REMOTE_LAYOUT_VERSION = 1;

const RUNTIME_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

function assertRemoteHome(remoteHome) {
  if (isWindowsAbsolutePath(remoteHome)
    && path.win32.normalize(remoteHome) === remoteHome
    && remoteHome !== path.win32.parse(remoteHome).root) return;
  if (typeof remoteHome !== "string"
    || remoteHome.length === 0
    || CONTROL_CHARS_RE.test(remoteHome)
    || !path.posix.isAbsolute(remoteHome)
    || path.posix.normalize(remoteHome) !== remoteHome
    || remoteHome === "/") {
    throw new TypeError("remoteHome must be a normalized absolute POSIX home path");
  }
}

function isWindowsAbsolutePath(value) {
  return typeof value === "string"
    && /^[a-zA-Z]:\\/.test(value)
    && !CONTROL_CHARS_RE.test(value)
    && !/[<>"|?*]/.test(value)
    && !value.slice(2).includes(":");
}

function assertPosixRemoteLayout(layout) {
  if (!layout || layout.platform !== "posix") {
    throw new TypeError("POSIX remote layout required");
  }
}

function toRemoteSftpPath(nativePath) {
  return isWindowsAbsolutePath(nativePath)
    ? `/${nativePath.replace(/\\/g, "/")}`
    : nativePath;
}

function remoteLayoutDirectories(layout) {
  return [
    layout.claudeHooksDir,
    ...(layout.platform === "posix" ? [layout.codexHome] : []),
    layout.copilotHome,
    layout.clawdStateDir,
    ...(layout.binDir ? [layout.binDir] : []),
    ...(layout.wrapperEvidenceDir ? [layout.wrapperEvidenceDir] : []),
  ];
}

function assertRuntimeKey(runtimeKey) {
  if (typeof runtimeKey !== "string" || !RUNTIME_KEY_RE.test(runtimeKey)) {
    throw new TypeError("runtimeKey must be 1-64 chars [a-zA-Z0-9_-]");
  }
}

function normalizeRemoteRuntimeIdentity({ runtimeMode, runtimeKey } = {}) {
  const mode = runtimeMode || REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT;
  if (mode === REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT) {
    return {
      runtimeMode: mode,
      runtimeKey: ACCOUNT_DEFAULT_RUNTIME_KEY,
    };
  }
  if (mode !== REMOTE_RUNTIME_MODE_PROFILE_ISOLATED) {
    throw new TypeError(`unsupported remote runtime mode: ${String(mode)}`);
  }
  assertRuntimeKey(runtimeKey);
  if (runtimeKey === ACCOUNT_DEFAULT_RUNTIME_KEY) {
    throw new TypeError("profile-isolated runtimeKey must not use the reserved account-default key");
  }
  return {
    runtimeMode: mode,
    runtimeKey,
  };
}

function resolveRemoteRuntimeLayout({ runtimeMode, runtimeKey, remoteHome } = {}) {
  assertRemoteHome(remoteHome);
  const platform = isWindowsAbsolutePath(remoteHome) ? "win32" : "posix";
  const remotePath = platform === "win32" ? path.win32 : path.posix;
  const identity = normalizeRemoteRuntimeIdentity({ runtimeMode, runtimeKey });
  const isolated = identity.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED;
  const runtimeRoot = isolated
    ? remotePath.join(remoteHome, ".clawd", "profiles", identity.runtimeKey)
    : remoteHome;
  const claudeConfigDir = isolated
    ? remotePath.join(runtimeRoot, "claude")
    : remotePath.join(remoteHome, ".claude");
  const claudeHooksDir = remotePath.join(claudeConfigDir, "hooks");
  const codexHome = isolated
    ? remotePath.join(runtimeRoot, "codex")
    : remotePath.join(remoteHome, ".codex");
  const copilotHome = isolated
    ? remotePath.join(runtimeRoot, "copilot")
    : remotePath.join(remoteHome, ".copilot");
  const clawdStateDir = isolated
    ? remotePath.join(runtimeRoot, "clawd")
    : remotePath.join(remoteHome, ".clawd");
  const binDir = isolated ? remotePath.join(runtimeRoot, "bin") : null;
  const wrapperEvidenceDir = isolated
    ? remotePath.join(clawdStateDir, "wrapper-evidence")
    : null;

  const layout = {
    runtimeMode: identity.runtimeMode,
    runtimeKey: identity.runtimeKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    remoteHome,
    runtimeRoot,
    claudeConfigDir,
    claudeHooksDir,
    claudeSettingsFile: remotePath.join(claudeConfigDir, "settings.json"),
    codexHome,
    codexSessionsDir: remotePath.join(codexHome, "sessions"),
    copilotHome,
    clawdStateDir,
    binDir,
    wrapperEvidenceDir,
    bootstrapOwnerFile: isolated ? remotePath.join(clawdStateDir, "bootstrap-owner.json") : null,
    claudeWrapperFile: isolated ? remotePath.join(binDir, "claude") : null,
    codexWrapperFile: isolated ? remotePath.join(binDir, "codex") : null,
    copilotWrapperFile: isolated ? remotePath.join(binDir, "copilot") : null,
    claudeWrapperEvidenceFile: isolated ? remotePath.join(wrapperEvidenceDir, "claude.used") : null,
    codexWrapperEvidenceFile: isolated ? remotePath.join(wrapperEvidenceDir, "codex.used") : null,
    copilotWrapperEvidenceFile: isolated ? remotePath.join(wrapperEvidenceDir, "copilot.used") : null,
    identityFile: remotePath.join(claudeHooksDir, "clawd-remote.json"),
    secureMarkerFile: remotePath.join(claudeHooksDir, "clawd-ssh-secure-v1"),
    hostPrefixFile: remotePath.join(claudeHooksDir, "clawd-host-prefix"),
    statuslineSidecarFile: remotePath.join(claudeHooksDir, "clawd-statusline-chain.json"),
    lastLogFile: remotePath.join(clawdStateDir, "remote-last-error.log"),
    // profile-isolated roots are bootstrapped under the old layout's lease
    // before the mode switch is persisted. Deploy itself therefore never has
    // to create a lock parent before acquiring this runtime-local lease.
    deployLockDir: isolated
      ? remotePath.join(clawdStateDir, "remote-deploy.lock")
      : remotePath.join(remoteHome, ".clawd-remote-deploy-account-default.lock"),
    deployStagingDir: remotePath.join(clawdStateDir, "remote-deploy-staging"),
    monitorPidFile: remotePath.join(clawdStateDir, "codex-monitor.pid"),
    legacyMonitorPidFile: isolated
      ? null
      : remotePath.join(remoteHome, ".clawd-codex-monitor.pid"),
  };
  // Keep the enumerable POSIX layout contract stable for existing consumers.
  // Spread or a JSON round trip drops platform; the POSIX assertion rejects it.
  Object.defineProperty(layout, "platform", { value: platform });
  return Object.freeze(layout);
}

function collectRemoteLayoutPathSet(layout) {
  if (!layout || typeof layout !== "object") {
    throw new TypeError("layout is required");
  }
  const paths = new Set();
  for (const [key, value] of Object.entries(layout)) {
    if (key !== "remoteHome"
      && (key.endsWith("Dir")
      || key.endsWith("File")
      || key.endsWith("Home")
      || key === "runtimeRoot")) {
      if (typeof value === "string") paths.add(value);
    }
  }
  return paths;
}

module.exports = {
  REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
  REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
  ACCOUNT_DEFAULT_RUNTIME_KEY,
  REMOTE_LAYOUT_VERSION,
  RUNTIME_KEY_RE,
  normalizeRemoteRuntimeIdentity,
  resolveRemoteRuntimeLayout,
  collectRemoteLayoutPathSet,
  isWindowsAbsolutePath,
  assertPosixRemoteLayout,
  toRemoteSftpPath,
  remoteLayoutDirectories,
};
