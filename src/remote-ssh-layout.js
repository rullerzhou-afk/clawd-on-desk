"use strict";

const path = require("path");

const REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT = "account-default";
const REMOTE_RUNTIME_MODE_PROFILE_ISOLATED = "profile-isolated";
const ACCOUNT_DEFAULT_RUNTIME_KEY = "account-default";
const REMOTE_LAYOUT_VERSION = 1;

const RUNTIME_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

function assertRemoteHome(remoteHome) {
  if (typeof remoteHome !== "string"
    || remoteHome.length === 0
    || CONTROL_CHARS_RE.test(remoteHome)
    || !path.posix.isAbsolute(remoteHome)
    || path.posix.normalize(remoteHome) !== remoteHome
    || remoteHome === "/") {
    throw new TypeError("remoteHome must be a normalized absolute POSIX home path");
  }
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
  const identity = normalizeRemoteRuntimeIdentity({ runtimeMode, runtimeKey });
  const isolated = identity.runtimeMode === REMOTE_RUNTIME_MODE_PROFILE_ISOLATED;
  const runtimeRoot = isolated
    ? path.posix.join(remoteHome, ".clawd", "profiles", identity.runtimeKey)
    : remoteHome;
  const claudeConfigDir = isolated
    ? path.posix.join(runtimeRoot, "claude")
    : path.posix.join(remoteHome, ".claude");
  const claudeHooksDir = path.posix.join(claudeConfigDir, "hooks");
  const codexHome = isolated
    ? path.posix.join(runtimeRoot, "codex")
    : path.posix.join(remoteHome, ".codex");
  const copilotHome = isolated
    ? path.posix.join(runtimeRoot, "copilot")
    : path.posix.join(remoteHome, ".copilot");
  const clawdStateDir = isolated
    ? path.posix.join(runtimeRoot, "clawd")
    : path.posix.join(remoteHome, ".clawd");
  const binDir = isolated ? path.posix.join(runtimeRoot, "bin") : null;
  const wrapperEvidenceDir = isolated
    ? path.posix.join(clawdStateDir, "wrapper-evidence")
    : null;

  const layout = {
    runtimeMode: identity.runtimeMode,
    runtimeKey: identity.runtimeKey,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    remoteHome,
    runtimeRoot,
    claudeConfigDir,
    claudeHooksDir,
    claudeSettingsFile: path.posix.join(claudeConfigDir, "settings.json"),
    codexHome,
    codexSessionsDir: path.posix.join(codexHome, "sessions"),
    copilotHome,
    clawdStateDir,
    binDir,
    wrapperEvidenceDir,
    bootstrapOwnerFile: isolated ? path.posix.join(clawdStateDir, "bootstrap-owner.json") : null,
    claudeWrapperFile: isolated ? path.posix.join(binDir, "claude") : null,
    codexWrapperFile: isolated ? path.posix.join(binDir, "codex") : null,
    copilotWrapperFile: isolated ? path.posix.join(binDir, "copilot") : null,
    claudeWrapperEvidenceFile: isolated ? path.posix.join(wrapperEvidenceDir, "claude.used") : null,
    codexWrapperEvidenceFile: isolated ? path.posix.join(wrapperEvidenceDir, "codex.used") : null,
    copilotWrapperEvidenceFile: isolated ? path.posix.join(wrapperEvidenceDir, "copilot.used") : null,
    identityFile: path.posix.join(claudeHooksDir, "clawd-remote.json"),
    secureMarkerFile: path.posix.join(claudeHooksDir, "clawd-ssh-secure-v1"),
    hostPrefixFile: path.posix.join(claudeHooksDir, "clawd-host-prefix"),
    statuslineSidecarFile: path.posix.join(claudeHooksDir, "clawd-statusline-chain.json"),
    lastLogFile: path.posix.join(clawdStateDir, "remote-last-error.log"),
    // profile-isolated roots are bootstrapped under the old layout's lease
    // before the mode switch is persisted. Deploy itself therefore never has
    // to create a lock parent before acquiring this runtime-local lease.
    deployLockDir: isolated
      ? path.posix.join(clawdStateDir, "remote-deploy.lock")
      : path.posix.join(remoteHome, ".clawd-remote-deploy-account-default.lock"),
    deployStagingDir: path.posix.join(clawdStateDir, "remote-deploy-staging"),
    monitorPidFile: path.posix.join(clawdStateDir, "codex-monitor.pid"),
    legacyMonitorPidFile: isolated
      ? null
      : path.posix.join(remoteHome, ".clawd-codex-monitor.pid"),
  };
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
};
