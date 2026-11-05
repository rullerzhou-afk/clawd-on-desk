"use strict";

// Read-only deployment discovery. Recognized POSIX kernels retain the existing
// shell/Node discovery path; ambiguous shells must rule out native Windows Node
// before a deployment can acquire a lease or persist a new identity.
const { detectRemoteShell } = require("./remote-ssh-shell-detect");
const {
  runRemoteNodeFrame,
  runRemoteNodeCommand,
  resolveRemoteNodeBin,
  buildRemoteNodeEvalCommand,
  isSupportedRemoteNodeVersion,
  isValidRemoteNodeBin,
} = require("./remote-ssh-node");
const { buildNodeDiscoveryFrame } = require("./remote-ssh-node-launch");
const { isValidRemoteHome } = require("./remote-ssh-profile");

const POSIX_KERNEL_RE = /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX)$/i;
const WINDOWS_ENVIRONMENT_RE = /^(MINGW|MSYS|CYGWIN)/i;

// Windows-specific hints are applied only after a native Windows snapshot.
function windowsFailureHint(reason) {
  return {
    windows_node_missing: "remoteSshErrWindowsNodeMissing",
    node_unavailable: "remoteSshErrWindowsNodeMissing",
    local_clawd_conflict: "remoteSshErrWindowsLocalClawdRunning",
    runtime_owner_unknown: "remoteSshErrWindowsLocalClawdUnknown",
    runtime_invalid: "remoteSshErrWindowsLocalClawdUnknown",
    windows_profile_isolated_unsupported: "remoteSshErrWindowsProfileIsolatedUnsupported",
    windows_node_changed: "remoteSshErrWindowsNodeChanged",
    identity_txn_platform_mismatch: "remoteSshErrIdentityTxnPlatformMismatch",
    copilot_config_bom: "remoteSshErrCopilotConfigBom",
    windows_powershell_path_unsupported: "remoteSshErrWindowsPowerShellPath",
    windows_codex_powershell_path_unsupported: "remoteSshErrWindowsCodexPowerShellPath",
    windows_codex_ownership_conflict: "remoteSshErrWindowsCodexOwnershipConflict",
    windows_codex_hooks_disabled: "remoteSshErrWindowsCodexHooksDisabled",
    windows_codex_cleanup_incomplete: "remoteSshErrWindowsCodexCleanupIncomplete",
    windows_dsh_desktop_session_required: "remoteSshErrWindowsDshDesktopSessionRequired",
    dsh_local_migration_required: "remoteSshErrDshLocalMigrationRequired",
    windows_dsh_cleanup_incomplete: "remoteSshErrWindowsDshCleanupIncomplete",
    "bridge-ownership-conflict": "remoteSshErrDshBridgeOwnershipConflict",
    "dsh-home-changed": "remoteSshErrDshHomeChanged",
    "inspection-required": "remoteSshErrDshInspectionRequired",
    "version-unsupported": "remoteSshErrDshVersionUnsupported",
    dsh_desktop_ambiguous: "remoteSshErrDshDesktopAmbiguous",
    dsh_desktop_unreadable: "remoteSshErrDshDesktopUnreadable",
    dsh_profile_unreadable: "remoteSshErrDshProfileUnreadable",
    dsh_home_ambiguous: "remoteSshErrDshHomeAmbiguous",
    dsh_asset_upload_failed: "remoteSshErrDshAssetUploadFailed",
    dsh_install_failed: "remoteSshErrDshInstallFailed",
    dsh_readback_failed: "remoteSshErrDshReadbackFailed",
    installer_result_unknown: "remoteSshErrDshInstallerResultUnknown",
  }[reason] || null;
}

function windowsPlatformFailure() {
  return {
    ok: false, step: "remote-shell", reason: "windows_node_missing",
    hint: "remoteSshErrWindowsNodeMissing",
    message: "Node.js was not found on remote Windows (Node.js 14+ must be on PATH).",
  };
}

function parsePlatformProbe(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1));
    const remotePlatform = value.platform === "win32" ? "win32" : "posix";
    if (typeof value.platform !== "string" || !value.platform
      || !isSupportedRemoteNodeVersion(value.version)
      || !isValidRemoteNodeBin(value.execPath, remotePlatform)
      || !isValidRemoteHome(value.homedir, remotePlatform)) return null;
    return { remotePlatform, node: value };
  } catch {
    return null;
  }
}

async function probeRemotePlatform(options) {
  const { profile, spawn, buildSshArgs, runtime, deps = {} } = options;
  const shell = await (deps.detectRemoteShell || detectRemoteShell)({ profile, spawn, buildSshArgs, runtime });
  if (shell && shell.shell === "posix" && POSIX_KERNEL_RE.test(shell.os)) {
    return { ok: true, remotePlatform: "posix", shell };
  }
  const knownWindows = !!(shell && (shell.shell === "windows-cmd" || WINDOWS_ENVIRONMENT_RE.test(shell.os)));
  const result = await runRemoteNodeFrame({ ...options, frame: buildNodeDiscoveryFrame() });
  const parsed = result.code === 0 ? parsePlatformProbe(result.stdout) : null;
  // Non-win32 Node in MINGW/MSYS/CYGWIN intentionally keeps the old POSIX behavior.
  if (parsed) return {
    ok: true, ...parsed, shell,
    remoteNode: { ok: true, nodeBin: parsed.node.execPath, version: parsed.node.version, source: "platform-probe" },
  };
  if (knownWindows) return windowsPlatformFailure();

  // Keep login-shell discovery for custom POSIX environments whose PATH does
  // not contain Node. A /c/... executable can still be native Windows Node.
  const resolved = await (deps.resolveRemoteNodeBin || resolveRemoteNodeBin)({
    profile: { ...profile, remotePlatform: "posix" }, spawn, buildSshArgs, runtime, verifyCache: true,
  });
  if (!resolved.ok) return { ...resolved, ok: false, step: "check-node" };
  const fallback = await (deps.spawnAndWait || runRemoteNodeCommand)(
    spawn, "ssh", buildSshArgs(profile).concat([
      buildRemoteNodeEvalCommand(resolved.nodeBin, "console.log(process.platform)"),
    ]), { runtime },
  );
  const platform = String(fallback.stdout || "").trim();
  if (fallback.code !== 0 || !/^[a-z][a-z0-9]*$/.test(platform)) {
    return { ok: false, step: "check-node", message: "Remote Node platform could not be verified." };
  }
  if (platform === "win32") return windowsPlatformFailure();
  return { ok: true, remotePlatform: "posix", shell, remoteNode: resolved };
}

module.exports = { probeRemotePlatform, parsePlatformProbe, windowsPlatformFailure, windowsFailureHint };
