"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/feishu-approval-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-feishu-approval-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test("normalizeFeishuApproval trims config and defaults to open_id", () => {
  assert.deepEqual(settings.normalizeFeishuApproval({
    enabled: true,
    idType: " user_id ",
    approverId: "  user_123  ",
    connectionTimeoutSeconds: 30,
  }), {
    enabled: true,
    idType: "user_id",
    approverId: "user_123",
    connectionTimeoutSeconds: 30,
  });
  assert.deepEqual(settings.normalizeFeishuApproval({ idType: "bad", approverId: "" }), {
    enabled: false,
    idType: "open_id",
    approverId: "",
    connectionTimeoutSeconds: 15,
  });
  assert.equal(settings.normalizeFeishuApproval({ connectionTimeoutSeconds: 999 }).connectionTimeoutSeconds, 15);
});

test("validateFeishuApproval permits incomplete saved config and rejects unknown keys", () => {
  assert.equal(settings.validateFeishuApproval({
    enabled: false,
    idType: "open_id",
    approverId: "",
  }).status, "ok");
  assert.equal(settings.validateFeishuApproval({
    enabled: true,
    idType: "open_id",
    approverId: "ou_abc",
    connectionTimeoutSeconds: 15,
  }).status, "ok");
  assert.equal(settings.validateFeishuApproval({
    enabled: true,
    idType: "open_id",
    approverId: "ou_abc",
    connectionTimeoutSeconds: 999,
  }).status, "error");
  assert.equal(settings.validateFeishuApproval({
    enabled: true,
    idType: "bad",
    approverId: "ou_abc",
  }).status, "error");
  assert.equal(settings.validateFeishuApproval({
    enabled: false,
    idType: "open_id",
    approverId: "",
    appSecret: "should-not-live-in-prefs",
  }).status, "error");
});

test("writeSecretsEnvFile stores Feishu secrets outside prefs and preserves blank fields", () => {
  const filePath = path.join(tempDir(), "feishu-approval.env");
  let result = settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: {
      appId: "cli_123456",
      appSecret: "secret-abcdef",
      verificationToken: "verify-token",
      encryptKey: "encrypt-key",
    },
    platform: "linux",
  });
  assert.equal(result.status, "ok");
  assert.match(fs.readFileSync(filePath, "utf8"), /FEISHU_APP_SECRET=secret-abcdef/);

  result = settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: {
      appId: "",
      appSecret: "new-secret",
      verificationToken: "",
      encryptKey: "",
    },
    platform: "linux",
  });
  assert.equal(result.status, "ok");
  const env = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(env.appId, "cli_123456");
  assert.equal(env.appSecret, "new-secret");
  assert.equal(env.verificationToken, "verify-token");
  assert.equal(env.encryptKey, "encrypt-key");
});

test("readiness requires enabled config, approver id, and app credentials", () => {
  assert.equal(settings.readiness({ enabled: false }, {}).reason, "disabled");
  assert.equal(settings.readiness({ enabled: true, idType: "open_id", approverId: "" }, {
    appId: "cli_123",
    appSecret: "secret",
  }).reason, "invalid-config");
  assert.equal(settings.readiness({ enabled: true, idType: "open_id", approverId: "ou_1" }, {
    appId: "cli_123",
    appSecret: "",
  }).reason, "missing-secret");
  assert.equal(settings.readiness({ enabled: true, idType: "open_id", approverId: "ou_1" }, {
    appId: "cli_123",
    appSecret: "secret",
  }).ready, true);
});

test("readiness rejects obviously invalid Feishu app ids", () => {
  const result = settings.readiness({ enabled: true, idType: "open_id", approverId: "ou_1" }, {
    appId: "not-a-cli-id",
    appSecret: "secret",
  });
  assert.equal(result.reason, "invalid-secret");
  assert.match(result.message, /App ID/);
});

test("redactionSecretsForFeishuApproval includes saved ids and secrets", () => {
  assert.deepEqual(settings.redactionSecretsForFeishuApproval({
    enabled: true,
    idType: "open_id",
    approverId: "ou_1",
  }, {
    appId: "cli_123",
    appSecret: "secret-value",
    verificationToken: "verify-value",
    encryptKey: "encrypt-value",
  }), [
    "ou_1",
    "cli_123",
    "secret-value",
    "verify-value",
    "encrypt-value",
  ]);
});

test("masked secret info never returns raw secret values", () => {
  const filePath = path.join(tempDir(), "feishu-approval.env");
  settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: {
      appId: "cli_1234567890",
      appSecret: "super-secret-value",
      verificationToken: "verify-token-value",
      encryptKey: "encrypt-key-value",
    },
  });
  const info = settings.readMaskedSecrets({ fs, filePath });
  assert.equal(info.configured, true);
  assert.equal(JSON.stringify(info).includes("super-secret-value"), false);
  assert.equal(info.appSecret, "supe......alue");
});
