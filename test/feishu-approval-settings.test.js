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
    platform: "feishu",
    idType: "user_id",
    approverId: "user_123",
    approverSource: "unknown",
    approverBoundPlatform: "",
    approverBoundAppId: "",
    connectionTimeoutSeconds: 30,
  });
  assert.deepEqual(settings.normalizeFeishuApproval({ idType: "bad", approverId: "" }), {
    enabled: false,
    platform: "feishu",
    idType: "open_id",
    approverId: "",
    approverSource: "none",
    approverBoundPlatform: "",
    approverBoundAppId: "",
    connectionTimeoutSeconds: 15,
  });
  assert.equal(settings.normalizeFeishuApproval({ connectionTimeoutSeconds: 999 }).connectionTimeoutSeconds, 15);
});

// The upgrade contract: an existing Feishu user must land on Feishu without
// touching anything, and must not be asked to re-enter credentials.
test("normalizeFeishuApproval migrates a pre-platform config to feishu", () => {
  const legacy = {
    enabled: true,
    idType: "open_id",
    approverId: "ou_legacy",
    connectionTimeoutSeconds: 15,
  };
  assert.equal(settings.normalizeFeishuApproval(legacy).platform, "feishu");
  assert.equal(settings.normalizeFeishuApproval(legacy).approverId, "ou_legacy");
  assert.equal(settings.DEFAULT_FEISHU_APPROVAL.platform, "feishu");
  assert.equal(settings.normalizeFeishuApproval(undefined).platform, "feishu");
});

test("normalizeFeishuApproval keeps lark and falls back to feishu for anything else", () => {
  assert.equal(settings.normalizeFeishuApproval({ platform: "lark" }).platform, "lark");
  assert.equal(settings.normalizeFeishuApproval({ platform: " lark " }).platform, "lark");
  for (const bad of ["Lark", "LARK", "feishu.cn", "", "evil.example.com", 1, null, {}]) {
    assert.equal(
      settings.normalizeFeishuApproval({ platform: bad }).platform,
      "feishu",
      `platform ${JSON.stringify(bad)} must fall back to feishu`
    );
  }
});

test("validateFeishuApproval accepts both platforms, rejects anything else", () => {
  const base = { enabled: true, idType: "open_id", approverId: "ou_abc" };
  assert.equal(settings.validateFeishuApproval({ ...base, platform: "feishu" }).status, "ok");
  assert.equal(settings.validateFeishuApproval({ ...base, platform: "lark" }).status, "ok");
  // Absent stays valid: configs saved before the field existed must not be
  // rejected on the way back in.
  assert.equal(settings.validateFeishuApproval(base).status, "ok");
  // A user must never be able to aim the App Secret at an arbitrary host.
  for (const bad of ["", "Lark", "custom", "https://evil.example.com", 1, null]) {
    assert.equal(
      settings.validateFeishuApproval({ ...base, platform: bad }).status,
      "error",
      `platform ${JSON.stringify(bad)} must be rejected`
    );
  }
  assert.deepEqual([...settings.FEISHU_PLATFORMS].sort(), ["feishu", "lark"]);
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

test("normalizeFeishuApproval preserves legacy approvers as explicit unknown provenance", () => {
  for (const idType of ["open_id", "user_id", "union_id"]) {
    const normalized = settings.normalizeFeishuApproval({
      enabled: true,
      platform: "lark",
      idType,
      approverId: `legacy-${idType}`,
    });
    assert.deepEqual(normalized, {
      enabled: true,
      platform: "lark",
      idType,
      approverId: `legacy-${idType}`,
      approverSource: "unknown",
      approverBoundPlatform: "",
      approverBoundAppId: "",
      connectionTimeoutSeconds: 15,
    });
  }
});

test("normalizeFeishuApproval canonicalizes every partial trusted provenance shape without dropping the ID", () => {
  const partials = [
    { approverSource: "lookup" },
    { approverSource: "lookup", approverBoundPlatform: "feishu" },
    { approverSource: "manual", approverBoundAppId: "cli_bound" },
    { approverSource: "manual", approverBoundPlatform: "custom", approverBoundAppId: "cli_bound" },
    { idType: undefined, approverSource: "manual", approverBoundPlatform: "feishu", approverBoundAppId: "cli_bound" },
    { approverSource: "lookup", approverBoundPlatform: "feishu", approverBoundAppId: "cli_bound", idType: "user_id" },
    { approverSource: "none", approverBoundPlatform: "feishu", approverBoundAppId: "cli_bound" },
  ];
  for (const partial of partials) {
    const normalized = settings.normalizeFeishuApproval({
      enabled: true,
      platform: "feishu",
      idType: partial.idType || "open_id",
      approverId: "preserved-id",
      ...partial,
    });
    assert.equal(normalized.approverId, "preserved-id");
    assert.equal(normalized.approverSource, "unknown");
    assert.equal(normalized.approverBoundPlatform, "");
    assert.equal(normalized.approverBoundAppId, "");
  }

  assert.deepEqual(settings.normalizeFeishuApproval({
    approverId: "",
    approverSource: "lookup",
    approverBoundPlatform: "feishu",
    approverBoundAppId: "cli_stray",
  }), {
    enabled: false,
    platform: "feishu",
    idType: "open_id",
    approverId: "",
    approverSource: "none",
    approverBoundPlatform: "",
    approverBoundAppId: "",
    connectionTimeoutSeconds: 15,
  });
});

test("validateFeishuApproval rejects partial trusted tuples and accepts canonical none unknown lookup and manual tuples", () => {
  const base = {
    enabled: true,
    platform: "feishu",
    idType: "open_id",
    approverId: "ou_valid",
    connectionTimeoutSeconds: 15,
  };
  for (const partial of [
    { approverSource: "lookup", approverBoundPlatform: "", approverBoundAppId: "" },
    { approverSource: "lookup", approverBoundPlatform: "feishu", approverBoundAppId: "" },
    { approverSource: "manual", approverBoundPlatform: "", approverBoundAppId: "cli_valid" },
    { approverSource: "lookup", approverBoundPlatform: "feishu", approverBoundAppId: "cli_valid", idType: "user_id" },
  ]) {
    assert.equal(settings.validateFeishuApproval({ ...base, ...partial }).status, "error");
  }

  for (const canonical of [
    { ...base, approverId: "", approverSource: "none", approverBoundPlatform: "", approverBoundAppId: "" },
    { ...base, approverSource: "unknown", approverBoundPlatform: "", approverBoundAppId: "" },
    { ...base, approverSource: "lookup", approverBoundPlatform: "feishu", approverBoundAppId: "cli_valid" },
    { ...base, idType: "user_id", approverSource: "manual", approverBoundPlatform: "feishu", approverBoundAppId: "cli_valid" },
    { ...base, idType: "union_id", approverSource: "manual", approverBoundPlatform: "feishu", approverBoundAppId: "cli_valid" },
  ]) {
    assert.equal(settings.validateFeishuApproval(canonical).status, "ok");
  }
});

test("writeSecretsEnvFile atomically stores the complete planned credential bundle", () => {
  const filePath = path.join(tempDir(), "feishu-approval.env");
  let result = settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: {
      credentialPlatform: "feishu",
      appId: "cli_123456",
      appSecret: "secret-abcdef",
      verificationToken: "verify-token",
      encryptKey: "encrypt-key",
    },
    platform: "linux",
  });
  assert.equal(result.status, "ok");
  assert.match(fs.readFileSync(filePath, "utf8"), /FEISHU_CREDENTIAL_PLATFORM=feishu/);
  assert.match(fs.readFileSync(filePath, "utf8"), /FEISHU_APP_SECRET=secret-abcdef/);

  result = settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: {
      credentialPlatform: "feishu",
      appId: "cli_123456",
      appSecret: "new-secret",
      verificationToken: "",
      encryptKey: "",
    },
    platform: "linux",
  });
  assert.equal(result.status, "ok");
  const env = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(env.appId, "cli_123456");
  assert.equal(env.credentialPlatform, "feishu");
  assert.equal(env.appSecret, "new-secret");
  assert.equal(env.verificationToken, "");
  assert.equal(env.encryptKey, "");
});

test("legacy secret files preserve credentials while credential platform remains unknown", () => {
  const filePath = path.join(tempDir(), "feishu-approval.env");
  fs.writeFileSync(filePath, [
    "FEISHU_APP_ID=cli_legacy",
    "FEISHU_APP_SECRET=legacy-secret",
    "FEISHU_VERIFICATION_TOKEN=legacy-verify",
    "FEISHU_ENCRYPT_KEY=legacy-encrypt",
    "",
  ].join("\n"));
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), {
    credentialPlatform: "unknown",
    appId: "cli_legacy",
    appSecret: "legacy-secret",
    verificationToken: "legacy-verify",
    encryptKey: "legacy-encrypt",
  });
});

test("planFeishuCredentialWrite saves a first complete identity without replacement confirmation", () => {
  assert.deepEqual(settings.planFeishuCredentialWrite({}, "feishu", {
    appId: "cli_initial",
    appSecret: "initial-secret",
    verificationToken: "initial-verify",
  }), {
    ok: true,
    nextBundle: {
      credentialPlatform: "feishu",
      appId: "cli_initial",
      appSecret: "initial-secret",
      verificationToken: "initial-verify",
      encryptKey: "",
    },
  });
});

test("planFeishuCredentialWrite rebinds a legacy same App without clearing optional fields", () => {
  const legacy = {
    credentialPlatform: "unknown",
    appId: "cli_legacy",
    appSecret: "old-secret",
    verificationToken: "old-verify",
    encryptKey: "old-encrypt",
  };

  assert.deepEqual(settings.planFeishuCredentialWrite(legacy, "lark", {
    appId: "cli_legacy",
    appSecret: "rotated-secret",
  }), {
    ok: true,
    nextBundle: {
      credentialPlatform: "lark",
      appId: "cli_legacy",
      appSecret: "rotated-secret",
      verificationToken: "old-verify",
      encryptKey: "old-encrypt",
    },
  });

  assert.deepEqual(settings.planFeishuCredentialWrite(legacy, "lark", {
    appId: "cli_legacy",
    appSecret: "rotated-secret",
    verificationToken: "new-verify",
  }), {
    ok: true,
    nextBundle: {
      credentialPlatform: "lark",
      appId: "cli_legacy",
      appSecret: "rotated-secret",
      verificationToken: "new-verify",
      encryptKey: "old-encrypt",
    },
  });
});

test("planFeishuCredentialWrite preserves optional fields for a known same identity and Secret rotation", () => {
  const current = {
    credentialPlatform: "feishu",
    appId: "cli_current",
    appSecret: "old-secret",
    verificationToken: "old-verify",
    encryptKey: "old-encrypt",
  };

  assert.deepEqual(settings.planFeishuCredentialWrite(current, "feishu", {
    appSecret: "rotated-secret",
  }), {
    ok: true,
    nextBundle: {
      credentialPlatform: "feishu",
      appId: "cli_current",
      appSecret: "rotated-secret",
      verificationToken: "old-verify",
      encryptKey: "old-encrypt",
    },
  });
});

test("planFeishuCredentialWrite requires confirmation before a real identity replacement", () => {
  const knownFeishu = {
    credentialPlatform: "feishu",
    appId: "cli_current",
    appSecret: "old-secret",
    verificationToken: "old-verify",
    encryptKey: "old-encrypt",
  };

  for (const [label, current, platform, patch] of [
    ["known platform switch", knownFeishu, "lark", {
      appId: "cli_current",
      appSecret: "new-secret",
    }],
    ["known App ID switch", knownFeishu, "feishu", {
      appId: "cli_other",
      appSecret: "new-secret",
    }],
    ["legacy App ID switch", { ...knownFeishu, credentialPlatform: "unknown" }, "feishu", {
      appId: "cli_other",
      appSecret: "new-secret",
    }],
  ]) {
    assert.deepEqual(
      settings.planFeishuCredentialWrite(current, platform, patch),
      { ok: false, code: "credentials-replace-confirmation-required" },
      label,
    );
  }

  assert.deepEqual(settings.planFeishuCredentialWrite(knownFeishu, "lark", {
    appId: "cli_replacement",
    appSecret: "replacement-secret",
    confirmReplace: true,
  }), {
    ok: true,
    nextBundle: {
      credentialPlatform: "lark",
      appId: "cli_replacement",
      appSecret: "replacement-secret",
      verificationToken: "",
      encryptKey: "",
    },
  });

  for (const confirmReplace of ["true", 1]) {
    assert.deepEqual(settings.planFeishuCredentialWrite(knownFeishu, "lark", {
      appId: "cli_replacement",
      appSecret: "replacement-secret",
      confirmReplace,
    }), { ok: false, code: "credentials-replace-confirmation-required" });
  }

  const inheritedConfirmation = Object.create({ confirmReplace: true });
  Object.assign(inheritedConfirmation, {
    appId: "cli_replacement",
    appSecret: "replacement-secret",
  });
  assert.deepEqual(
    settings.planFeishuCredentialWrite(knownFeishu, "lark", inheritedConfirmation),
    { ok: false, code: "credentials-replace-confirmation-required" },
  );

  for (const patch of [
    {},
    { appId: "cli_replacement" },
    { appSecret: "replacement-secret" },
  ]) {
    assert.deepEqual(
      settings.planFeishuCredentialWrite(knownFeishu, "lark", patch),
      { ok: false, code: "credentials-replacement-incomplete" },
    );
  }

  assert.deepEqual(settings.planFeishuCredentialWrite(knownFeishu, "lark", {
    appId: "not-valid",
    appSecret: "replacement-secret",
  }), { ok: false, code: "invalid-app-id" });
});

test("deriveSavedFeishuCredentialIdentity returns exact fail-closed codes", () => {
  const config = { platform: "feishu" };
  assert.deepEqual(settings.deriveSavedFeishuCredentialIdentity(config, {}), {
    ok: false,
    code: "missing-credentials",
  });
  assert.deepEqual(settings.deriveSavedFeishuCredentialIdentity(config, {
    credentialPlatform: "feishu",
    appId: "bad",
    appSecret: "secret",
  }), { ok: false, code: "invalid-app-id" });
  assert.deepEqual(settings.deriveSavedFeishuCredentialIdentity(config, {
    credentialPlatform: "unknown",
    appId: "cli_valid",
    appSecret: "secret",
  }), { ok: false, code: "credential-provenance-unknown" });
  assert.deepEqual(settings.deriveSavedFeishuCredentialIdentity(config, {
    credentialPlatform: "lark",
    appId: "cli_valid",
    appSecret: "secret",
  }), { ok: false, code: "credential-platform-mismatch" });
  assert.deepEqual(settings.deriveSavedFeishuCredentialIdentity(config, {
    credentialPlatform: "feishu",
    appId: "cli_valid",
    appSecret: "secret",
  }), { ok: true, identity: { platform: "feishu", appId: "cli_valid" } });
});

test("validateFeishuApproverBinding enforces source, platform, App, and lookup open_id", () => {
  const identity = { platform: "feishu", appId: "cli_current" };
  const base = {
    idType: "open_id",
    approverId: "ou_current",
    approverSource: "lookup",
    approverBoundPlatform: "feishu",
    approverBoundAppId: "cli_current",
  };
  const cases = [
    [{ ...base, approverId: "" }, "missing-approver"],
    [{ ...base, approverSource: "unknown", approverBoundPlatform: "", approverBoundAppId: "" }, "approver-provenance-unknown"],
    [{ ...base, approverBoundPlatform: "" }, "approver-binding-incomplete"],
    [{ ...base, approverBoundPlatform: "lark" }, "approver-platform-mismatch"],
    [{ ...base, approverBoundAppId: "cli_other" }, "approver-app-mismatch"],
    [{ ...base, idType: "user_id" }, "lookup-requires-open-id"],
  ];
  for (const [config, code] of cases) {
    assert.deepEqual(settings.validateFeishuApproverBinding(config, identity), { ok: false, code });
  }
  assert.deepEqual(settings.validateFeishuApproverBinding(base, identity), {
    ok: true,
    approver: { idType: "open_id", approverId: "ou_current", source: "lookup" },
  });
});

test("manual approver identity transitions fail closed without dropping the value", () => {
  const ids = ["open_id", "user_id", "union_id"];
  const savedSecrets = {
    credentialPlatform: "feishu",
    appId: "cli_current",
    appSecret: "secret-one",
  };

  for (const idType of ids) {
    const approverId = `${idType}-value`;
    const savedConfig = {
      enabled: true,
      platform: "feishu",
      idType,
      approverId,
      approverSource: "manual",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_current",
      connectionTimeoutSeconds: 15,
    };
    const transitions = [
      {
        name: "same platform + same appId",
        config: savedConfig,
        secrets: savedSecrets,
        ready: true,
        reason: undefined,
        retainedId: approverId,
      },
      {
        name: "secret-only rotation",
        config: savedConfig,
        secrets: { ...savedSecrets, appSecret: "secret-two" },
        ready: true,
        reason: undefined,
        retainedId: approverId,
      },
      {
        name: "platform change",
        config: { ...savedConfig, platform: "lark" },
        secrets: { ...savedSecrets, credentialPlatform: "lark" },
        ready: false,
        reason: "approver-platform-mismatch",
        retainedId: approverId,
      },
      {
        name: "App ID change",
        config: savedConfig,
        secrets: { ...savedSecrets, appId: "cli_other" },
        ready: false,
        reason: "approver-app-mismatch",
        retainedId: approverId,
      },
      {
        name: "platform reconfirmation",
        config: {
          ...savedConfig,
          platform: "lark",
          approverBoundPlatform: "lark",
        },
        secrets: { credentialPlatform: "lark", appId: "cli_current", appSecret: "secret-three" },
        ready: true,
        reason: undefined,
        retainedId: approverId,
      },
      {
        name: "App ID reconfirmation",
        config: {
          ...savedConfig,
          approverBoundAppId: "cli_other",
        },
        secrets: { ...savedSecrets, appId: "cli_other", appSecret: "secret-three" },
        ready: true,
        reason: undefined,
        retainedId: approverId,
      },
    ];

    for (const transition of transitions) {
      const result = settings.readiness(transition.config, transition.secrets);
      assert.equal(result.ready, transition.ready, `${idType}: ${transition.name}`);
      assert.equal(result.reason, transition.reason, `${idType}: ${transition.name} reason`);
      assert.equal(result.config.approverId, transition.retainedId, `${idType}: ${transition.name} value`);
    }
  }
});

// A disk/permission failure is platform-independent, and the settings page
// shows this text. Naming Feishu tells a Lark user their setup is the problem.
test("writeSecretsEnvFile reports failures brand-neutrally with a stable code", () => {
  const failing = {
    readFileSync: () => "",
    mkdirSync: () => { throw new Error("EACCES: permission denied, mkdir"); },
    writeFileSync: () => {},
  };
  const results = [
    settings.writeSecretsEnvFile({ fs: failing, path, filePath: "/x/feishu-approval.env", secrets: { appId: "cli_1", appSecret: "s" }, platform: "linux" }),
    settings.writeSecretsEnvFile({ fs: failing, path, filePath: "", secrets: {} }),
    settings.writeSecretsEnvFile({}),
  ];
  for (const result of results) {
    assert.equal(result.status, "error");
    assert.equal(result.code, "write-failed", "a stable code lets the UI localize the failure");
    assert.doesNotMatch(result.message, /Feishu/i, `must not name a brand: ${result.message}`);
    assert.doesNotMatch(result.message, /Lark/i, `must not name a brand: ${result.message}`);
  }
  // The underlying cause survives as the detail the UI appends.
  assert.match(results[0].message, /EACCES/);
});

test("readiness requires enabled config, approver id, and app credentials", () => {
  assert.equal(settings.readiness({ enabled: false }, {}).reason, "disabled");
  assert.equal(settings.readiness({
    enabled: true,
    idType: "open_id",
    approverId: "",
    approverSource: "none",
  }, {
    credentialPlatform: "feishu",
    appId: "cli_123",
    appSecret: "secret",
  }).reason, "missing-approver");
  assert.equal(settings.readiness({ enabled: true, idType: "open_id", approverId: "ou_1" }, {
    credentialPlatform: "feishu",
    appId: "cli_123",
    appSecret: "",
  }).reason, "missing-credentials");
  assert.equal(settings.readiness({
    enabled: true,
    idType: "open_id",
    approverId: "ou_1",
    approverSource: "lookup",
    approverBoundPlatform: "feishu",
    approverBoundAppId: "cli_123",
  }, {
    credentialPlatform: "feishu",
    appId: "cli_123",
    appSecret: "secret",
  }).ready, true);
});

test("readiness rejects obviously invalid Feishu app ids", () => {
  const result = settings.readiness({ enabled: true, idType: "open_id", approverId: "ou_1" }, {
    credentialPlatform: "feishu",
    appId: "not-a-cli-id",
    appSecret: "secret",
  });
  assert.equal(result.reason, "invalid-app-id");
  assert.match(result.message, /App ID/);
});

// Lark self-built apps use the same cli_ prefix as Feishu, so a real Lark App
// ID must sail through the format gate — the gate is not a platform detector.
test("readiness accepts real-shaped Lark cli_ app ids on the lark platform", () => {
  for (const appId of ["cli_a1b2c3d4e5f6g7h8", "cli_9f8e7d6c5b4a3210", "cli_A1b2-C3d4_E5f6"]) {
    const result = settings.readiness(
      {
        enabled: true,
        platform: "lark",
        idType: "open_id",
        approverId: "ou_lark_1",
        approverSource: "lookup",
        approverBoundPlatform: "lark",
        approverBoundAppId: appId,
      },
      { credentialPlatform: "lark", appId, appSecret: "lark-secret" }
    );
    assert.equal(result.ready, true, `${appId} should pass readiness on Lark`);
    assert.equal(result.config.platform, "lark");
  }
  // ...and the same id is equally valid on Feishu.
  assert.equal(settings.readiness(
    {
      enabled: true,
      platform: "feishu",
      idType: "open_id",
      approverId: "ou_1",
      approverSource: "lookup",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_a1b2c3d4e5f6g7h8",
    },
    { credentialPlatform: "feishu", appId: "cli_a1b2c3d4e5f6g7h8", appSecret: "s" }
  ).ready, true);
});

// A Lark user reading "Feishu App ID is invalid" is being told their correct
// setup is wrong. These messages are log/fallback diagnostics shown to users
// when no localized mapping exists, so they must not name one brand.
test("readiness diagnostics are platform-neutral", () => {
  const cases = [
    settings.readiness({ enabled: true, platform: "lark", idType: "open_id", approverId: "" }, { credentialPlatform: "lark", appId: "cli_1", appSecret: "s" }),
    settings.readiness({ enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1" }, { credentialPlatform: "lark", appId: "", appSecret: "" }),
    settings.readiness({ enabled: true, platform: "lark", idType: "open_id", approverId: "ou_1" }, { credentialPlatform: "lark", appId: "nope", appSecret: "s" }),
  ];
  for (const result of cases) {
    assert.equal(result.ready, false);
    assert.ok(result.message, "a diagnostic message is still provided");
    assert.doesNotMatch(result.message, /Feishu/i, `must not hardcode a brand: ${result.message}`);
    assert.doesNotMatch(result.message, /Lark/i, `must not hardcode a brand: ${result.message}`);
  }
  // The stable reason codes the UI maps to localized copy are unchanged.
  assert.deepEqual(cases.map((r) => r.reason), ["missing-approver", "missing-credentials", "invalid-app-id"]);
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
