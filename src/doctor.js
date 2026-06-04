"use strict";

const { checkLocalServer } = require("./doctor-detectors/local-server");
const { checkAgentIntegrations } = require("./doctor-detectors/agent-integrations");
const { checkPermissionBubblePolicy } = require("./doctor-detectors/permission-bubble-policy");
const { checkThemeHealth } = require("./doctor-detectors/theme-health");

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

function runDoctorChecks(options = {}) {
  const prefs = options.prefs || {};
  const checks = [
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
    (options.checkThemeHealth || checkThemeHealth)({
      prefs,
      themeId: options.themeId,
      variant: options.variant,
      overrides: options.overrides,
    }),
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
};
