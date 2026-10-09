"use strict";

const { checkLocalServer } = require("./doctor-detectors/local-server");
const { checkAgentIntegrations } = require("./doctor-detectors/agent-integrations");
const { checkPermissionBubblePolicy } = require("./doctor-detectors/permission-bubble-policy");
const { checkThemeHealth } = require("./doctor-detectors/theme-health");
const { checkPrefsReadability } = require("./doctor-detectors/prefs-readability");
const { checkFeishuApproval } = require("./doctor-detectors/feishu-approval");

function normalizeCheckLevel(check) {
  if (!check) return null;
  if (check.level === "critical" || check.status === "critical") return "critical";
  if (check.level === "warning" || check.status === "warning") return "warning";
  return null;
}

function computeOverall(checks) {
  const levels = checks.map(normalizeCheckLevel);
  const critical = levels.filter((level) => level === "critical").length;
  const warning = levels.filter((level) => level === "warning").length;
  if (critical > 0) return { status: "critical", level: "critical", issueCount: critical + warning };
  if (warning > 0) return { status: "warning", level: "warning", issueCount: warning };
  return { status: "pass", level: null, issueCount: 0 };
}

function checkRemoteSshIngress(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  const rejectedCount = list.reduce((sum, status) => {
    const count = Number(status && status.ingressRejectedCount);
    return sum + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  }, 0);
  return {
    id: "remote-ssh-ingress",
    status: rejectedCount > 0 ? "warning" : "pass",
    level: rejectedCount > 0 ? "warning" : null,
    rejectedCount,
    detail: rejectedCount > 0
      ? `Rejected remote events: ${rejectedCount}. Remote hooks may be outdated or owned by another deployment.`
      : "Rejected remote events: 0",
  };
}

function checkRemoteSshIsolation(prefs) {
  const profiles = prefs
    && prefs.remoteSsh
    && Array.isArray(prefs.remoteSsh.profiles)
    ? prefs.remoteSsh.profiles
    : [];
  const isolated = profiles.filter((profile) => profile.runtimeMode === "profile-isolated");
  const pendingSwitchCount = profiles.filter((profile) => profile.runtimeModeTxn).length;
  const activeCount = isolated.filter((profile) =>
    profile.isolatedActive === true
    && profile.isolatedRuntime
    && profile.isolatedRuntime.active === true).length;
  const inactiveCount = isolated.length - activeCount;
  const needsAttention = pendingSwitchCount > 0 || inactiveCount > 0;
  let detail = "No profile-isolated Remote SSH runtimes are configured.";
  if (isolated.length > 0 || pendingSwitchCount > 0) {
    detail = [
      `Experimental isolated runtimes: ${activeCount} active, ${inactiveCount} awaiting verified wrapper use; pending mode switches: ${pendingSwitchCount}.`,
      "This separates managed CLI config, sessions, and Clawd routing only.",
      "The same Unix UID can read every profile; project-local config and some caches remain shared; macOS Claude subscription auth remains shared through Keychain.",
    ].join(" ");
  }
  return {
    id: "remote-ssh-isolation",
    status: needsAttention ? "warning" : (isolated.length > 0 ? "info" : "pass"),
    level: needsAttention ? "warning" : (isolated.length > 0 ? "info" : null),
    profileCount: isolated.length,
    activeCount,
    inactiveCount,
    pendingSwitchCount,
    detail,
  };
}

function runDoctorChecks(options = {}) {
  const prefs = options.prefs || {};
  const checks = [
    (options.checkPrefsReadability || checkPrefsReadability)({
      readFailure: options.prefsReadFailure === true,
      recovered: options.prefsRecovered === true,
      recoveryBackupFailed: options.prefsRecoveryBackupFailed === true,
    }),
    (options.checkLocalServer || checkLocalServer)(options.server),
    (options.checkAgentIntegrations || checkAgentIntegrations)({
      prefs,
      server: options.server,
      fs: options.fs,
      platform: options.platform,
      descriptors: options.descriptors,
      validateCommand: options.validateCommand,
    }),
    (options.checkPermissionBubblePolicy || checkPermissionBubblePolicy)({
      prefs,
      doNotDisturb: !!options.doNotDisturb,
    }),
    (options.checkFeishuApproval || checkFeishuApproval)({
      config: prefs.feishuApproval,
      secrets: options.feishuApprovalSecrets,
    }),
    (options.checkThemeHealth || checkThemeHealth)({
      prefs,
      themeId: options.themeId,
      variant: options.variant,
      overrides: options.overrides,
    }),
    (options.checkRemoteSshIngress || checkRemoteSshIngress)(
      typeof options.getRemoteSshStatuses === "function"
        ? options.getRemoteSshStatuses()
        : options.remoteSshStatuses
    ),
    (options.checkRemoteSshIsolation || checkRemoteSshIsolation)(prefs),
  ];

  return {
    generatedAt: new Date().toISOString(),
    overall: computeOverall(checks),
    checks,
  };
}

module.exports = {
  runDoctorChecks,
  computeOverall,
  checkRemoteSshIngress,
  checkRemoteSshIsolation,
};
