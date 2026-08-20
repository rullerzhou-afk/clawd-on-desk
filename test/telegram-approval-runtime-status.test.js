"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTelegramApprovalStatus,
  isNativeTelegramApprovalSelected,
  buildTelegramStatusDiagnostic,
  formatTelegramStatusDiagnostic,
} = require("../src/telegram-approval-runtime-status");
const {
  ALLOWED_TEST_ERROR_CLASSES,
} = require("../src/telegram-verification-failure");

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
      displaySessionTag: "deadbeef00",
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
  assert.equal(status.errorCode, "");
  assert.equal(status.failureOutcome, "");
});

test("fresh off verification failures expose a stable top-level diagnostic", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "IDLE",
      transport: "off",
      lastTestResult: { outcome: "failed", errorClass: "401", at: 123 },
    },
    nativePolling: false,
  });

  assert.equal(status.status, "failed");
  assert.equal(status.transport, "off");
  assert.equal(status.reason, "native-verification-failed");
  assert.equal(status.message, "");
  assert.equal(status.errorCode, "401");
  assert.equal(status.failureOutcome, "failed");
});

test("runtime status projects every safe verification error class", () => {
  for (const errorClass of ALLOWED_TEST_ERROR_CLASSES) {
    const status = buildTelegramApprovalStatus({
      config: COMPLETE_CONFIG_DISABLED,
      token: TOKEN_STORED,
      migrationSnapshot: {
        state: "IDLE",
        transport: "off",
        lastTestResult: { outcome: "failed", errorClass },
      },
      nativePolling: false,
    });
    assert.equal(status.errorCode, errorClass);
    assert.equal(status.failureOutcome, "failed");
  }
});

test("timeout projection wins over a stale class and malformed classes become unknown", () => {
  const timeout = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "IDLE",
      lastTestResult: { outcome: "timeout", errorClass: "401" },
    },
    nativePolling: false,
  });
  assert.equal(timeout.errorCode, "timeout");
  assert.equal(timeout.failureOutcome, "timeout");

  const malformed = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "IDLE",
      lastTestResult: { outcome: "failed", errorClass: "token=secret raw body" },
    },
    nativePolling: false,
  });
  assert.equal(malformed.errorCode, "unknown");
  assert.doesNotMatch(JSON.stringify({
    errorCode: malformed.errorCode,
    failureOutcome: malformed.failureOutcome,
    reason: malformed.reason,
    message: malformed.message,
  }), /secret raw/);
});

test("malformed terminal outcomes cannot forge a failed status", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot: {
      state: "IDLE",
      lastTestResult: { outcome: "surprise", errorClass: "401" },
    },
    nativePolling: false,
  });
  assert.equal(status.status, "stopped");
  assert.equal(status.errorCode, "");
  assert.equal(status.failureOutcome, "");
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
  assert.match(text, /最新会话: claude-code #deadbeef00 状态=working 标记=running; 最近 hook: PreToolUse 3 秒前/);
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

test("R2 diagnostic reports the projected off verification failure", () => {
  const migrationSnapshot = {
    state: "IDLE",
    transport: "off",
    lastTestResult: { outcome: "failed", errorClass: "401", at: 123 },
  };
  const approvalStatus = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    migrationSnapshot,
    nativePolling: false,
  });
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    approvalStatus,
    migrationSnapshot,
  });

  assert.equal(diagnostic.transport, "off");
  assert.equal(diagnostic.health, "failed");
  assert.deepEqual(diagnostic.lastError, {
    source: "approval",
    code: "401",
    outcome: "failed",
    message: "",
  });
  assert.match(formatTelegramStatusDiagnostic(diagnostic), /Last error: approval code=401 outcome=failed/);
  assert.match(
    formatTelegramStatusDiagnostic(diagnostic, { lang: "zh" }),
    /最近错误: approval 代码=401 结果=failed/,
  );
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

// Regression: the fixture above uses a bare id, so the suite never saw a real
// namespaced session key. Slicing that key returns the envelope, which is the
// same for every local session.
test("distinct local sessions get distinct short ids in the diagnostic", () => {
  const { resolveSessionIdentity } = require("../src/session-key");

  function lineFor(rawSessionId) {
    const identity = resolveSessionIdentity(rawSessionId);
    const diagnostic = buildTelegramStatusDiagnostic({
      config: COMPLETE_CONFIG_OUTPUT_FULL,
      token: TOKEN_STORED,
      sessionSnapshot: {
        sessions: [{
          id: identity.sessionId,
          rawSessionId: identity.rawSessionId,
          agentId: "claude-code",
          state: "working",
          badge: "running",
          updatedAt: 10_000,
          lastEvent: { rawEvent: "PreToolUse", at: 9_000 },
        }],
      },
      now: 12_000,
    });
    return diagnostic.sessions[0].id;
  }

  const a = lineFor("11111111-2222-3333-4444-555555555555");
  const b = lineFor("99999999-8888-7777-6666-aaaaaaaaaaaa");
  assert.equal(a, "a0a040910c");
  assert.notEqual(a, b, "two sessions must not render the same id");
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.ok(!a.startsWith("s1."), `id must not be the key envelope: ${a}`);
  assert.ok(!"11111111-2222-3333-4444-555555555555".startsWith(a), "id must not be a raw prefix");
});

test("status all uses each snapshot display tag without leaking canonical ids", () => {
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    sessionSnapshot: {
      sessions: [
        {
          id: "s1.bG9jYWw.MTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1",
          rawSessionId: "11111111-2222-3333-4444-555555555555",
          displaySessionTag: "deadbeef00",
          agentId: "claude-code",
          state: "working",
          badge: "running",
          updatedAt: 10_000,
          lastEvent: { rawEvent: "PreToolUse", at: 9_000 },
        },
        {
          id: "s1.bG9jYWw.OTk5OTk5OTktODg4OC03Nzc3LTY2NjYtYWFhYWFhYWFhYWFh",
          rawSessionId: "99999999-8888-7777-6666-aaaaaaaaaaaa",
          displaySessionTag: "feedface01",
          agentId: "codex",
          state: "idle",
          badge: "done",
          updatedAt: 9_000,
          lastEvent: { rawEvent: "Stop", at: 8_000 },
        },
      ],
    },
    now: 12_000,
    all: true,
  });

  const text = formatTelegramStatusDiagnostic(diagnostic, { all: true });
  assert.match(text, /#deadbeef00/);
  assert.match(text, /#feedface01/);
  assert.doesNotMatch(text, /s1\.bG9jYWw|111111|999999|#a0a040910c|#83ff7f4baa/);
});

test("hashes a token-shaped session id without leaking a raw prefix", () => {
  const { resolveSessionIdentity } = require("../src/session-key");
  const secret = "123456789:AAHqwertyuiopasdfghjklzxcvbnm123456";
  const identity = resolveSessionIdentity(secret, "local");
  const diagnostic = buildTelegramStatusDiagnostic({
    config: COMPLETE_CONFIG_OUTPUT_FULL,
    token: TOKEN_STORED,
    sessionSnapshot: {
      sessions: [{
        id: identity.sessionId,
        rawSessionId: identity.rawSessionId,
        agentId: "claude-code",
        state: "working",
        badge: "running",
        updatedAt: 10_000,
        lastEvent: { rawEvent: "PreToolUse", at: 9_000 },
      }],
    },
    now: 12_000,
  });
  const id = diagnostic.sessions[0].id;
  assert.equal(id, "a94b1a8e6c");
  assert.match(id, /^[0-9a-f]{10}$/);
  assert.ok(!secret.startsWith(id), "tag must not be a raw token prefix");
  assert.ok(!id.includes(":"), `must not reach the token separator, got: ${id}`);
});
