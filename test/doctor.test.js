const { describe, it } = require("node:test");
const assert = require("node:assert");
const { computeOverall, runDoctorChecks } = require("../src/doctor");

describe("doctor aggregate checks", () => {
  it("computes red overall when any check is critical", () => {
    assert.deepStrictEqual(
      computeOverall([
        { status: "pass" },
        { status: "fail", level: "critical" },
        { status: "fail", level: "warning" },
      ]),
      { status: "critical", level: "critical", issueCount: 2 }
    );
  });

  it("computes yellow overall when warnings exist without critical failures", () => {
    assert.deepStrictEqual(
      computeOverall([
        { status: "pass" },
        { status: "fail", level: "warning" },
      ]),
      { status: "warning", level: "warning", issueCount: 1 }
    );
  });

  it("computes green overall when all checks pass or info", () => {
    assert.deepStrictEqual(
      computeOverall([
        { status: "pass" },
        { status: "suppressed-by-dnd", level: "info" },
      ]),
      { status: "pass", level: null, issueCount: 0 }
    );
  });

  it("runs all checks through injectable dependencies", () => {
    const result = runDoctorChecks({
      prefs: { theme: "clawd" },
      checkPrefsReadability: () => ({ id: "prefs-readability", status: "pass", level: null }),
      checkLocalServer: () => ({ id: "local-server", status: "pass", level: null }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass", level: null, details: [] }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass", level: null }),
      checkFeishuApproval: () => ({ id: "feishu-approval", status: "pass", level: null }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass", level: null }),
      checkRemoteSshIngress: () => ({ id: "remote-ssh-ingress", status: "pass", level: null, rejectedCount: 0 }),
      checkRemoteSshIsolation: () => ({ id: "remote-ssh-isolation", status: "pass", level: null }),
    });

    assert.strictEqual(result.overall.status, "pass");
    assert.deepStrictEqual(result.checks.map((check) => check.id), [
      "prefs-readability",
      "local-server",
      "agent-integrations",
      "permission-bubble-policy",
      "feishu-approval",
      "theme-health",
      "remote-ssh-ingress",
      "remote-ssh-isolation",
    ]);
  });

  it("surfaces unreadable preferences as critical and legacy Feishu provenance as warning", () => {
    const result = runDoctorChecks({
      prefsReadFailure: true,
      prefs: { feishuApproval: { enabled: true } },
      feishuApprovalSecrets: { appId: "cli_a1234567890", appSecret: "secret" },
      checkLocalServer: () => ({ id: "local-server", status: "pass" }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass" }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass" }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass" }),
    });

    const prefs = result.checks.find((check) => check.id === "prefs-readability");
    const feishu = result.checks.find((check) => check.id === "feishu-approval");
    assert.strictEqual(prefs.status, "critical");
    assert.strictEqual(feishu.status, "warning");
    assert.strictEqual(feishu.reason, "credential-provenance-unknown");
    assert.match(feishu.detail, /save App ID\/App Secret again/i);
    assert.strictEqual(result.overall.status, "critical");
    assert.strictEqual(result.overall.issueCount, 2);
  });

  it("surfaces a recovered malformed prefs snapshot as non-authoritative", () => {
    const result = runDoctorChecks({
      prefsRecovered: true,
      checkLocalServer: () => ({ id: "local-server", status: "pass" }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass" }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass" }),
      checkFeishuApproval: () => ({ id: "feishu-approval", status: "pass" }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass" }),
    });
    const prefs = result.checks.find((check) => check.id === "prefs-readability");
    assert.strictEqual(prefs.status, "critical");
    assert.strictEqual(prefs.reason, "prefs-recovered");
    assert.match(prefs.detail, /clawd-prefs\.json\.bak/);
    assert.match(prefs.detail, /paused for this launch/i);
  });

  it("does not claim an invalid prefs backup exists when backup creation failed", () => {
    const result = runDoctorChecks({
      prefsReadFailure: true,
      prefsRecoveryBackupFailed: true,
      checkLocalServer: () => ({ id: "local-server", status: "pass" }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass" }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass" }),
      checkFeishuApproval: () => ({ id: "feishu-approval", status: "pass" }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass" }),
    });
    const prefs = result.checks.find((check) => check.id === "prefs-readability");
    assert.strictEqual(prefs.reason, "prefs-recovery-backup-failed");
    assert.match(prefs.detail, /kept unchanged/i);
    assert.doesNotMatch(prefs.detail, /backed up as/i);
  });

  it("surfaces the numeric Remote SSH ingress rejection count", () => {
    const result = runDoctorChecks({
      checkLocalServer: () => ({ id: "local-server", status: "pass" }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass" }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass" }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass" }),
      getRemoteSshStatuses: () => [
        { profileId: "a", ingressRejectedCount: 2 },
        { profileId: "b", ingressRejectedCount: 3 },
      ],
    });
    const ingress = result.checks.find((check) => check.id === "remote-ssh-ingress");
    assert.strictEqual(ingress.rejectedCount, 5);
    assert.strictEqual(ingress.status, "warning");
    assert.match(ingress.detail, /5/);
    assert.strictEqual(result.overall.status, "warning");
  });

  it("surfaces experimental isolation boundaries and interrupted mode switches", () => {
    const result = runDoctorChecks({
      prefs: {
        remoteSsh: {
          profiles: [{
            id: "p1",
            runtimeMode: "profile-isolated",
            isolatedActive: false,
            runtimeModeTxn: { phase: "cleanup-done" },
          }],
        },
      },
      checkLocalServer: () => ({ id: "local-server", status: "pass" }),
      checkAgentIntegrations: () => ({ id: "agent-integrations", status: "pass" }),
      checkPermissionBubblePolicy: () => ({ id: "permission-bubble-policy", status: "pass" }),
      checkThemeHealth: () => ({ id: "theme-health", status: "pass" }),
    });
    const isolation = result.checks.find((check) => check.id === "remote-ssh-isolation");
    assert.strictEqual(isolation.status, "warning");
    assert.strictEqual(isolation.inactiveCount, 1);
    assert.strictEqual(isolation.pendingSwitchCount, 1);
    assert.match(isolation.detail, /same Unix UID/i);
    assert.match(isolation.detail, /project-local config/i);
    assert.match(isolation.detail, /Keychain/i);
  });
});
