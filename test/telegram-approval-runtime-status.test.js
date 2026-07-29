"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTelegramApprovalStatus,
  isNativeTelegramApprovalSelected,
  buildTelegramStatusDiagnostic,
  formatTelegramStatusDiagnostic,
} = require("../src/telegram-approval-runtime-status");

const COMPLETE_CONFIG_DISABLED = {
  enabled: false,
  allowedTgUserId: "123456789",
  targetSessionKey: "telegram:123456789",
};
const TOKEN_STORED = { tokenConfigured: true, tokenStored: true };
const TOKEN_MISSING = { tokenConfigured: false, tokenStored: false };
const COMPLETE_CONFIG_ENABLED = {
  ...COMPLETE_CONFIG_DISABLED,
  enabled: true,
};
const COMPLETE_CONFIG_OUTPUT_FULL = {
  ...COMPLETE_CONFIG_DISABLED,
  completionOutputMode: "full",
};

function sessionSnapshot() {
  return {
    sessions: [{
      id: "session-secret-abc123",
      agentId: "claude-code",
      state: "working",
      badge: "running",
      updatedAt: 10_000,
      cwd: "D:\\secret\\repo",
      displayTitle: "do not leak prompt",
      lastEvent: { rawEvent: "PreToolUse", at: 9_000 },
    }],
  };
}

test("native active status ignores the historical enabled flag", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "NATIVE_ACTIVE", transport: "native" },
    nativePolling: true,
  });

  assert.deepEqual(status, {
    status: "running",
    transport: "native",
    native: true,
    enabled: true,
    configured: true,
    reason: "",
    message: "",
    tokenStored: true,
    nativePolling: true,
    migrationState: "NATIVE_ACTIVE",
  });
});

test("native active status reports native inactive when polling is stopped", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "NATIVE_ACTIVE", transport: "native" },
    nativePolling: false,
  });

  assert.equal(status.status, "stopped");
  assert.equal(status.transport, "native");
  assert.equal(status.configured, true);
  assert.equal(status.reason, "native-inactive");
  assert.equal(status.message, "Native Telegram approval is not active");
});

test("native testing status carries a native reason", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "TESTING_NATIVE" },
    nativePolling: true,
  });

  assert.equal(status.status, "starting");
  assert.equal(status.transport, "native");
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.reason, "native-testing");
  assert.equal(status.message, "Native Telegram approval test is already in progress");
});

test("native setup debt is reported as inactive until verification can run", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "NEEDS_SETUP", transport: "native" },
    nativePolling: false,
  });

  assert.equal(status.status, "stopped");
  assert.equal(status.transport, "off");
  assert.equal(status.enabled, false);
  assert.equal(status.configured, true);
  assert.equal(status.reason, "disabled");
  assert.equal(status.message, "");
});

test("off transport stays off after USER_DISABLE", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "IDLE", transport: "off" },
    nativePolling: false,
  });

  assert.equal(status.transport, "off");
  assert.equal(status.configured, true);
  assert.equal(status.reason, "disabled");
  assert.equal(status.message, "");
});

test("retired legacy snapshots can only report migration required", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_ENABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "NATIVE_MIGRATION_REQUIRED",
      transport: "legacy",
    },
    nativePolling: false,
  });

  assert.equal(status.transport, "off");
  assert.equal(status.status, "stopped");
  assert.equal(status.reason, "native-migration-required");
  assert.equal(status.nativePolling, false);
});

test("stale legacy runtime fields cannot forge a running status", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_ENABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "LEGACY_ACTIVE",
      transport: "legacy",
      runtimeStatus: { transport: "legacy", status: "running", reason: null, message: "" },
    },
    nativePolling: false,
  });

  assert.equal(status.transport, "off");
  assert.equal(status.status, "stopped");
});

test("stale legacy failure fields are ignored after disable", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      // User disabled after a failure: state moved to IDLE/off, but a stale
      // legacy failed runtimeStatus lingers. It must NOT keep the badge red.
      state: "IDLE",
      transport: "off",
      runtimeStatus: { transport: "legacy", status: "failed", reason: "sidecar_runtime_failed", message: "boom" },
    },
    nativePolling: false,
  });

  assert.equal(status.status, "stopped");
  assert.notEqual(status.status, "failed");
});

test("native selection only includes live native states", () => {
  assert.equal(isNativeTelegramApprovalSelected({ state: "NATIVE_ACTIVE" }), true);
  assert.equal(isNativeTelegramApprovalSelected({ state: "TESTING_NATIVE" }), true);
  assert.equal(isNativeTelegramApprovalSelected({ state: "NATIVE_MIGRATION_REQUIRED", transport: "legacy" }), false);
  assert.equal(isNativeTelegramApprovalSelected({ state: "NEEDS_SETUP", transport: "native" }), false);
  assert.equal(isNativeTelegramApprovalSelected({ state: "IDLE", transport: "off" }), false);
});

test("R2 diagnostic reports native active healthy without exposing recipient ids", () => {
  const approvalStatus = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "NATIVE_ACTIVE",
      transport: "native",
      ownerSnapshot: { nativePolling: true },
    },
    nativePolling: true,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot: {
      state: "NATIVE_ACTIVE",
      transport: "native",
      ownerSnapshot: { nativePolling: true },
    },
    nativeRunnerStatus: { polling: true, pendingApprovalCount: 1 },
    pendingApprovalCount: 2,
    sessionSnapshot: sessionSnapshot(),
    now: 12_000,
  });

  assert.equal(diagnostic.transport, "native");
  assert.equal(diagnostic.health, "healthy");
  assert.equal(diagnostic.nativePolling, true);
  assert.equal(diagnostic.approvalAvailable, true);
  assert.equal(diagnostic.completionNotifications.enabled, true);
  assert.equal(diagnostic.completionNotifications.effective, true);
  assert.equal(diagnostic.completionNotifications.outputMode, "full");
  assert.equal(diagnostic.completionNotifications.bare, false);
  assert.equal(diagnostic.tokenStored, true);
  assert.deepEqual(diagnostic.pendingApprovals, { total: 2, nativeCards: 1 });

  const text = formatTelegramStatusDiagnostic(diagnostic);
  assert.match(text, /Transport: native/);
  assert.match(text, /Native polling: running/);
  assert.match(text, /Approval: available/);
  assert.match(text, /Completion notifications: on, output=full answer, bare fallback=off/);
  assert.match(text, /Pending approvals: 2/);
  assert.match(text, /PreToolUse 3s ago/);
  assert.equal(text.includes("123456789"), false);
  assert.equal(text.includes("telegram:123456789"), false);
});

test("R3 diagnostic formatter follows the Clawd language setting", () => {
  const approvalStatus = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "NATIVE_ACTIVE",
      transport: "native",
      ownerSnapshot: { nativePolling: true },
    },
    nativePolling: true,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot: {
      state: "NATIVE_ACTIVE",
      transport: "native",
      ownerSnapshot: { nativePolling: true },
    },
    nativeRunnerStatus: { polling: true, pendingApprovalCount: 1 },
    pendingApprovalCount: 2,
    sessionSnapshot: sessionSnapshot(),
    now: 12_000,
  });

  const text = formatTelegramStatusDiagnostic(diagnostic, { lang: "zh" });
  assert.match(text, /Clawd Telegram 状态/);
  assert.match(text, /传输: 原生/);
  assert.match(text, /健康状态: 正常/);
  assert.match(text, /原生轮询: 运行中/);
  assert.match(text, /审批: 可用/);
  assert.match(text, /完成通知: 开启, 输出=完整回答, 裸通知=关闭/);
  assert.match(text, /待处理审批: 2/);
  assert.match(text, /最新会话: claude-code #session- 状态=working 标记=running; 最近 hook: PreToolUse 3 秒前/);
  assert.doesNotMatch(text, /Transport:|Native polling:|Latest session:/);
});

test("R3 diagnostic formatter localizes status all and falls back to English", () => {
  const diagnostic = {
    transport: "off",
    health: "off",
    nativePolling: false,
    approvalAvailable: false,
    completionNotifications: { enabled: false, effective: false },
    tokenStored: false,
    configured: false,
    pendingApprovals: { total: 0, nativeCards: 0 },
    lastError: null,
    sessions: [],
  };

  const ja = formatTelegramStatusDiagnostic(diagnostic, { all: true, lang: "ja" });
  assert.match(ja, /Clawd Telegram ステータス/);
  assert.match(ja, /送信方式: オフ/);
  assert.match(ja, /セッション:\n- なし/);

  const fallback = formatTelegramStatusDiagnostic(diagnostic, { lang: "klingon" });
  assert.match(fallback, /Transport: off/);
  assert.match(fallback, /Latest session: none/);
});

test("R2 diagnostic reports setup debt without claiming an active transport", () => {
  const incomplete = {
    enabled: false,
    allowedTgUserId: "",
    targetSessionKey: "",
    notifyOnComplete: true,
  };
  const approvalStatus = buildTelegramApprovalStatus({
    config: incomplete,
    token: TOKEN_MISSING,
    migrationSnapshot: { state: "NEEDS_SETUP", transport: "native" },
    nativePolling: false,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: incomplete,
    token: TOKEN_MISSING,
    approvalStatus,
    migrationSnapshot: { state: "NEEDS_SETUP", transport: "native" },
    nativeRunnerStatus: { polling: false, pendingApprovalCount: 0 },
  });

  assert.equal(diagnostic.transport, "off");
  assert.equal(diagnostic.health, "off");
  assert.equal(diagnostic.nativePolling, false);
  assert.equal(diagnostic.approvalAvailable, false);
  assert.equal(diagnostic.tokenStored, false);
  assert.equal(diagnostic.recipientConfigured, false);
  assert.equal(diagnostic.configured, false);

  const text = formatTelegramStatusDiagnostic(diagnostic);
  assert.match(text, /Token: missing/);
  assert.match(text, /Config: incomplete/);
});

test("R2 diagnostic distinguishes off transport from legacy stopped", () => {
  const approvalStatus = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: { state: "IDLE", transport: "off" },
    nativePolling: false,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot: { state: "IDLE", transport: "off" },
  });

  assert.equal(diagnostic.transport, "off");
  assert.equal(diagnostic.health, "off");
  assert.equal(diagnostic.approvalAvailable, false);
  assert.equal(diagnostic.completionNotifications.enabled, false);
  assert.equal(diagnostic.completionNotifications.effective, false);
  assert.equal(diagnostic.completionNotifications.configured, false);
  assert.equal(diagnostic.completionNotifications.outputMode, "off");
  assert.equal(diagnostic.completionNotifications.bare, false);
  const text = formatTelegramStatusDiagnostic(diagnostic);
  assert.match(text, /Transport: off/);
  assert.match(text, /Completion notifications: off, output=off, bare fallback=off/);
  assert.doesNotMatch(text, /inactive until native is running/);
});

test("R2 diagnostic never reports the retired legacy fallback as available", () => {
  const approvalStatus = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_ENABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "NATIVE_MIGRATION_REQUIRED",
      transport: "legacy",
      ownerSnapshot: { sidecarRunning: true, nativePolling: false },
    },
    nativePolling: false,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_ENABLED,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot: {
      state: "NATIVE_MIGRATION_REQUIRED",
      transport: "legacy",
      ownerSnapshot: { sidecarRunning: true, nativePolling: false },
    },
  });

  assert.equal(diagnostic.transport, "off");
  assert.equal(diagnostic.health, "off");
  assert.equal(diagnostic.nativePolling, false);
  assert.equal(diagnostic.approvalAvailable, false);
  assert.equal(diagnostic.completionNotifications.enabled, false);
  assert.equal(diagnostic.completionNotifications.effective, false);
  assert.equal(diagnostic.completionNotifications.outputMode, "off");
  assert.equal(diagnostic.completionNotifications.bare, false);
});

test("R2 diagnostic redacts token, Telegram ids, paths, and tool-like secrets from errors", () => {
  const approvalStatus = {
    status: "failed",
    transport: "native",
    configured: true,
    tokenStored: true,
    reason: "native-error",
    message: "bot 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop chat 987654321 path D:\\Users\\me\\secret\\file.txt command npm test -- --token sk-1234567890abcdef",
  };
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot: {
      state: "NATIVE_ACTIVE",
      transport: "native",
      lastError: {
        code: "APPLY_FAILED",
        message: approvalStatus.message,
      },
    },
    nativeRunnerStatus: { polling: false, pendingApprovalCount: 0 },
    pendingApprovalCount: 0,
    sessionSnapshot: sessionSnapshot(),
    now: 12_000,
  });
  const text = JSON.stringify(diagnostic) + "\n" + formatTelegramStatusDiagnostic(diagnostic);

  assert.equal(text.includes("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop"), false);
  assert.equal(text.includes("987654321"), false);
  assert.equal(text.includes("D:\\Users\\me\\secret\\file.txt"), false);
  assert.equal(text.includes("sk-1234567890abcdef"), false);
  assert.equal(text.includes("npm test -- --token"), false);
  assert.equal(text.includes("D:\\secret\\repo"), false);
  assert.equal(text.includes("do not leak prompt"), false);
});
