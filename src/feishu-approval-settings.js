"use strict";

const path = require("path");

const DEFAULT_FEISHU_APPROVAL = Object.freeze({
  enabled: false,
  platform: "feishu",
  idType: "open_id",
  approverId: "",
  approverSource: "none",
  approverBoundPlatform: "",
  approverBoundAppId: "",
  connectionTimeoutSeconds: 15,
});

// Feishu (China) and Lark (international) are separate deployments of the same
// product with separate API hosts. The value only ever selects an official SDK
// domain enum — users cannot type a host, so an App Secret can never be sent to
// a non-official server. Old configs have no platform key and normalize to
// "feishu", which is what they were implicitly using before this field existed.
const FEISHU_PLATFORMS = new Set(["feishu", "lark"]);
const FEISHU_ID_TYPES = new Set(["open_id", "user_id", "union_id"]);
const FEISHU_APPROVER_SOURCES = new Set(["none", "lookup", "manual", "unknown"]);
const CONNECTION_TIMEOUT_SECONDS = new Set([5, 10, 15, 30, 60]);
const SECRET_KEYS = Object.freeze({
  credentialPlatform: "FEISHU_CREDENTIAL_PLATFORM",
  appId: "FEISHU_APP_ID",
  appSecret: "FEISHU_APP_SECRET",
  verificationToken: "FEISHU_VERIFICATION_TOKEN",
  encryptKey: "FEISHU_ENCRYPT_KEY",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function trimString(value, maxLen = 512) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function normalizeCredentialPlatform(value) {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FEISHU_PLATFORMS.has(platform) ? platform : "unknown";
}

function isValidFeishuAppId(value) {
  const appId = trimString(value, 256);
  return /^cli_[A-Za-z0-9_-]+$/.test(appId);
}

function cloneDefaultFeishuApproval() {
  return { ...DEFAULT_FEISHU_APPROVAL };
}

function normalizeConnectionTimeoutSeconds(value, fallback = DEFAULT_FEISHU_APPROVAL.connectionTimeoutSeconds) {
  const numeric = Number(value);
  return CONNECTION_TIMEOUT_SECONDS.has(numeric) ? numeric : fallback;
}

function normalizeFeishuApproval(value, defaultsValue = DEFAULT_FEISHU_APPROVAL) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_FEISHU_APPROVAL;
  const defaultPlatform = FEISHU_PLATFORMS.has(defaults.platform) ? defaults.platform : DEFAULT_FEISHU_APPROVAL.platform;
  const defaultIdType = FEISHU_ID_TYPES.has(defaults.idType) ? defaults.idType : DEFAULT_FEISHU_APPROVAL.idType;
  const defaultTimeout = normalizeConnectionTimeoutSeconds(defaults.connectionTimeoutSeconds);
  const out = {
    enabled: defaults.enabled === true,
    platform: defaultPlatform,
    idType: defaultIdType,
    approverId: trimString(defaults.approverId, 128),
    approverSource: "none",
    approverBoundPlatform: "",
    approverBoundAppId: "",
    connectionTimeoutSeconds: defaultTimeout,
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.platform === "string") {
    const platform = trimString(value.platform, 32);
    out.platform = FEISHU_PLATFORMS.has(platform) ? platform : DEFAULT_FEISHU_APPROVAL.platform;
  }
  const rawIdType = typeof value.idType === "string" ? trimString(value.idType, 32) : "";
  if (typeof value.idType === "string") {
    out.idType = FEISHU_ID_TYPES.has(rawIdType) ? rawIdType : DEFAULT_FEISHU_APPROVAL.idType;
  }
  if (typeof value.approverId === "string") out.approverId = trimString(value.approverId, 128);
  if (value.connectionTimeoutSeconds !== undefined) {
    out.connectionTimeoutSeconds = normalizeConnectionTimeoutSeconds(value.connectionTimeoutSeconds, defaultTimeout);
  }
  if (!out.approverId) return out;

  const source = trimString(value.approverSource, 32);
  const boundPlatform = trimString(value.approverBoundPlatform, 32);
  const rawBoundAppId = typeof value.approverBoundAppId === "string"
    ? value.approverBoundAppId.trim()
    : "";
  const boundAppId = trimString(rawBoundAppId, 256);
  const trusted = (source === "lookup" || source === "manual")
    && FEISHU_PLATFORMS.has(boundPlatform)
    && !!boundAppId
    && rawBoundAppId.length <= 256
    && FEISHU_ID_TYPES.has(rawIdType)
    && (source !== "lookup" || out.idType === "open_id");
  if (trusted) {
    out.approverSource = source;
    out.approverBoundPlatform = boundPlatform;
    out.approverBoundAppId = boundAppId;
  } else {
    out.approverSource = "unknown";
  }
  return out;
}

function validateFeishuApproval(value) {
  if (!isPlainObject(value)) return { status: "error", message: "feishuApproval must be a plain object" };
  for (const key of Object.keys(value)) {
    if (
      key !== "enabled"
      && key !== "platform"
      && key !== "idType"
      && key !== "approverId"
      && key !== "approverSource"
      && key !== "approverBoundPlatform"
      && key !== "approverBoundAppId"
      && key !== "connectionTimeoutSeconds"
    ) {
      return { status: "error", message: `feishuApproval.${key} is not supported` };
    }
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "feishuApproval.enabled must be a boolean" };
  }
  // Optional on the way in — configs saved before the platform field existed
  // (and any caller that omits it) stay valid and normalize to "feishu". A
  // present value must be one of the two official deployments; an arbitrary
  // host is never accepted here or anywhere downstream.
  if (value.platform !== undefined && !FEISHU_PLATFORMS.has(value.platform)) {
    return { status: "error", message: "feishuApproval.platform must be feishu or lark" };
  }
  if (!FEISHU_ID_TYPES.has(value.idType)) {
    return { status: "error", message: "feishuApproval.idType must be open_id, user_id, or union_id" };
  }
  if (typeof value.approverId !== "string") {
    return { status: "error", message: "feishuApproval.approverId must be a string" };
  }
  if (value.approverId.length > 128) {
    return { status: "error", message: "feishuApproval.approverId is too long" };
  }
  const provenanceKeys = ["approverSource", "approverBoundPlatform", "approverBoundAppId"];
  const provenanceKeyCount = provenanceKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).length;
  if (provenanceKeyCount > 0 && provenanceKeyCount !== provenanceKeys.length) {
    return { status: "error", message: "feishuApproval approver provenance must be a complete tuple" };
  }
  if (provenanceKeyCount === provenanceKeys.length) {
    if (!FEISHU_APPROVER_SOURCES.has(value.approverSource)) {
      return { status: "error", message: "feishuApproval.approverSource is invalid" };
    }
    if (typeof value.approverBoundPlatform !== "string" || typeof value.approverBoundAppId !== "string") {
      return { status: "error", message: "feishuApproval approver bindings must be strings" };
    }
    if (value.approverBoundAppId.length > 256) {
      return { status: "error", message: "feishuApproval.approverBoundAppId is too long" };
    }
    const noBindings = !value.approverBoundPlatform && !value.approverBoundAppId;
    if (!value.approverId) {
      if (value.approverSource !== "none" || !noBindings) {
        return { status: "error", message: "feishuApproval empty approver must use canonical none provenance" };
      }
    } else if (value.approverSource === "unknown") {
      if (!noBindings) {
        return { status: "error", message: "feishuApproval unknown approver cannot claim a binding" };
      }
    } else if (value.approverSource === "lookup" || value.approverSource === "manual") {
      if (!FEISHU_PLATFORMS.has(value.approverBoundPlatform) || !value.approverBoundAppId) {
        return { status: "error", message: "feishuApproval trusted approver binding is incomplete" };
      }
      if (value.approverSource === "lookup" && value.idType !== "open_id") {
        return { status: "error", message: "feishuApproval lookup approver requires open_id" };
      }
    } else {
      return { status: "error", message: "feishuApproval nonempty approver must be trusted or unknown" };
    }
  }
  if (value.connectionTimeoutSeconds !== undefined && !CONNECTION_TIMEOUT_SECONDS.has(Number(value.connectionTimeoutSeconds))) {
    return { status: "error", message: "feishuApproval.connectionTimeoutSeconds must be 5, 10, 15, 30, or 60" };
  }
  return { status: "ok" };
}

function defaultSecretsEnvFilePath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "feishu-approval.env") : "";
}

function parseEnvText(text) {
  const out = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function readSecretsEnvFile({ fs, filePath } = {}) {
  if (!fs || !filePath || typeof fs.readFileSync !== "function") {
    return { credentialPlatform: "unknown", appId: "", appSecret: "", verificationToken: "", encryptKey: "" };
  }
  let parsed = {};
  try {
    parsed = parseEnvText(fs.readFileSync(filePath, "utf8"));
  } catch {
    parsed = {};
  }
  return {
    credentialPlatform: normalizeCredentialPlatform(parsed[SECRET_KEYS.credentialPlatform]),
    appId: trimString(parsed[SECRET_KEYS.appId], 256),
    appSecret: trimString(parsed[SECRET_KEYS.appSecret], 512),
    verificationToken: trimString(parsed[SECRET_KEYS.verificationToken], 512),
    encryptKey: trimString(parsed[SECRET_KEYS.encryptKey], 512),
  };
}

function buildSecretsEnvFile(secrets) {
  const source = isPlainObject(secrets) ? secrets : {};
  return [
    `${SECRET_KEYS.credentialPlatform}=${FEISHU_PLATFORMS.has(source.credentialPlatform) ? source.credentialPlatform : ""}`,
    `${SECRET_KEYS.appId}=${trimString(source.appId, 256)}`,
    `${SECRET_KEYS.appSecret}=${trimString(source.appSecret, 512)}`,
    `${SECRET_KEYS.verificationToken}=${trimString(source.verificationToken, 512)}`,
    `${SECRET_KEYS.encryptKey}=${trimString(source.encryptKey, 512)}`,
    "",
  ].join("\n");
}

// Errors here are user-visible (the settings page shows them on a failed save),
// so they carry a stable `code` for the UI to localize and stay brand-neutral:
// the same writer serves Feishu and Lark, and a disk/permission failure has
// nothing to do with which platform was picked. `message` remains the English
// diagnostic — it names the real cause (EACCES, ENOSPC…) and is the only clue
// worth showing alongside the translated copy.
function writeSecretsEnvFile({ fs, path: pathModule = path, filePath, secrets, platform = process.platform } = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return { status: "error", code: "write-failed", message: "writeSecretsEnvFile requires fs" };
  }
  if (!filePath || typeof filePath !== "string") {
    return { status: "error", code: "write-failed", message: "Secrets env file path is required" };
  }
  // The planner always supplies a complete bundle. Treat it as authoritative
  // so identity replacement can intentionally clear optional credentials;
  // merging truthy fields here would silently carry the previous App's token.
  const incoming = isPlainObject(secrets) ? secrets : {};
  const next = {
    credentialPlatform: normalizeCredentialPlatform(incoming.credentialPlatform),
    appId: trimString(incoming.appId, 256),
    appSecret: trimString(incoming.appSecret, 512),
    verificationToken: trimString(incoming.verificationToken, 512),
    encryptKey: trimString(incoming.encryptKey, 512),
  };
  try {
    fs.mkdirSync(pathModule.dirname(filePath), { recursive: true });
    const base = pathModule.basename(filePath);
    const tmpPath = pathModule.join(
      pathModule.dirname(filePath),
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    fs.writeFileSync(tmpPath, buildSecretsEnvFile(next), { encoding: "utf8", mode: 0o600 });
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(tmpPath, 0o600); } catch {}
    }
    fs.renameSync(tmpPath, filePath);
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    return { status: "ok", secretsStored: true, filePath };
  } catch (err) {
    return {
      status: "error",
      code: "write-failed",
      message: `Secrets write failed: ${err && err.message}`,
    };
  }
}

function maskSecret(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length < 10) return "****";
  return `${text.slice(0, 4)}......${text.slice(-4)}`;
}

function readMaskedSecrets({ fs, filePath } = {}) {
  const secrets = readSecretsEnvFile({ fs, filePath });
  const configured = !!(secrets.appId && secrets.appSecret);
  return {
    configured,
    credentialPlatform: secrets.credentialPlatform,
    appId: maskSecret(secrets.appId),
    appSecret: maskSecret(secrets.appSecret),
    verificationToken: maskSecret(secrets.verificationToken),
    encryptKey: maskSecret(secrets.encryptKey),
  };
}

function deriveSavedFeishuCredentialIdentity(config, secrets) {
  const normalized = normalizeFeishuApproval(config);
  const source = isPlainObject(secrets) ? secrets : {};
  const appId = trimString(source.appId, 256);
  const appSecret = trimString(source.appSecret, 512);
  if (!appId || !appSecret) return { ok: false, code: "missing-credentials" };
  if (!isValidFeishuAppId(appId)) return { ok: false, code: "invalid-app-id" };
  const credentialPlatform = normalizeCredentialPlatform(source.credentialPlatform);
  if (credentialPlatform === "unknown") {
    return { ok: false, code: "credential-provenance-unknown" };
  }
  if (credentialPlatform !== normalized.platform) {
    return { ok: false, code: "credential-platform-mismatch" };
  }
  return { ok: true, identity: { platform: credentialPlatform, appId } };
}

function validateFeishuApproverBinding(config, identity) {
  const source = isPlainObject(config) ? config : {};
  const approverId = trimString(source.approverId, 128);
  if (!approverId) return { ok: false, code: "missing-approver" };
  const approverSource = trimString(source.approverSource, 32);
  if (approverSource !== "lookup" && approverSource !== "manual") {
    return { ok: false, code: "approver-provenance-unknown" };
  }
  const boundPlatform = trimString(source.approverBoundPlatform, 32);
  const boundAppId = trimString(source.approverBoundAppId, 256);
  if (!FEISHU_PLATFORMS.has(boundPlatform) || !boundAppId) {
    return { ok: false, code: "approver-binding-incomplete" };
  }
  if (boundPlatform !== identity.platform) {
    return { ok: false, code: "approver-platform-mismatch" };
  }
  if (boundAppId !== identity.appId) {
    return { ok: false, code: "approver-app-mismatch" };
  }
  const idType = FEISHU_ID_TYPES.has(source.idType) ? source.idType : "open_id";
  if (approverSource === "lookup" && idType !== "open_id") {
    return { ok: false, code: "lookup-requires-open-id" };
  }
  return { ok: true, approver: { idType, approverId, source: approverSource } };
}

function evaluateFeishuApprovalConfiguration(config, secrets, options = {}) {
  const normalized = normalizeFeishuApproval(config);
  const valid = validateFeishuApproval(normalized);
  if (valid.status !== "ok") return { ok: false, code: "invalid-config", config: normalized };
  if (options.requireEnabled !== false && !normalized.enabled) {
    return { ok: false, code: "disabled", config: normalized };
  }
  const credential = deriveSavedFeishuCredentialIdentity(normalized, secrets);
  if (!credential.ok) return { ok: false, code: credential.code, config: normalized };
  const result = { ok: true, config: normalized, identity: credential.identity };
  if (options.requireApprover !== false) {
    const approver = validateFeishuApproverBinding(normalized, credential.identity);
    if (!approver.ok) return { ok: false, code: approver.code, config: normalized };
    result.approver = approver.approver;
  }
  return result;
}

function planFeishuCredentialWrite(current, requestedPlatform, patch) {
  const platform = normalizeCredentialPlatform(requestedPlatform);
  if (platform === "unknown") return { ok: false, code: "invalid-platform" };

  const saved = isPlainObject(current) ? current : {};
  const incoming = isPlainObject(patch) ? patch : {};
  const currentPlatform = normalizeCredentialPlatform(saved.credentialPlatform);
  const currentAppId = trimString(saved.appId, 256);
  const currentAppSecret = trimString(saved.appSecret, 512);
  const currentVerificationToken = trimString(saved.verificationToken, 512);
  const currentEncryptKey = trimString(saved.encryptKey, 512);
  const submittedAppId = trimString(incoming.appId, 256);
  const submittedAppSecret = trimString(incoming.appSecret, 512);
  const submittedVerificationToken = trimString(incoming.verificationToken, 512);
  const submittedEncryptKey = trimString(incoming.encryptKey, 512);
  const hasSavedMaterial = !!(
    currentAppId
    || currentAppSecret
    || currentVerificationToken
    || currentEncryptKey
  );
  const legacySameApp = hasSavedMaterial
    && currentPlatform === "unknown"
    && !!submittedAppId
    && submittedAppId === currentAppId;
  const requestedAppId = submittedAppId || currentAppId;
  const replacement = hasSavedMaterial
    && !legacySameApp
    && (
      currentPlatform === "unknown"
      || currentPlatform !== platform
      || requestedAppId !== currentAppId
    );
  const replacementConfirmed = Object.prototype.hasOwnProperty.call(incoming, "confirmReplace")
    && incoming.confirmReplace === true;

  if (!hasSavedMaterial || legacySameApp || replacement) {
    if (!submittedAppId || !submittedAppSecret) {
      return { ok: false, code: "credentials-replacement-incomplete" };
    }
    if (!isValidFeishuAppId(submittedAppId)) return { ok: false, code: "invalid-app-id" };
  }

  if (!hasSavedMaterial) {
    return {
      ok: true,
      nextBundle: {
        credentialPlatform: platform,
        appId: submittedAppId,
        appSecret: submittedAppSecret,
        verificationToken: submittedVerificationToken,
        encryptKey: submittedEncryptKey,
      },
    };
  }

  if (legacySameApp) {
    return {
      ok: true,
      nextBundle: {
        credentialPlatform: platform,
        appId: submittedAppId,
        appSecret: submittedAppSecret,
        verificationToken: submittedVerificationToken || currentVerificationToken,
        encryptKey: submittedEncryptKey || currentEncryptKey,
      },
    };
  }

  if (replacement && !replacementConfirmed) {
    return { ok: false, code: "credentials-replace-confirmation-required" };
  }

  if (replacement) {
    return {
      ok: true,
      nextBundle: {
        credentialPlatform: platform,
        appId: submittedAppId,
        appSecret: submittedAppSecret,
        verificationToken: submittedVerificationToken,
        encryptKey: submittedEncryptKey,
      },
    };
  }

  return {
    ok: true,
    nextBundle: {
      credentialPlatform: platform,
      appId: currentAppId,
      appSecret: submittedAppSecret || currentAppSecret,
      verificationToken: submittedVerificationToken || currentVerificationToken,
      encryptKey: submittedEncryptKey || currentEncryptKey,
    },
  };
}

function secretStatus({ fs, filePath } = {}) {
  const secrets = readSecretsEnvFile({ fs, filePath });
  let fileExists = false;
  let secretFileMtimeMs = 0;
  if (fs && filePath && typeof fs.existsSync === "function") {
    try { fileExists = fs.existsSync(filePath); } catch { fileExists = false; }
    if (fileExists && typeof fs.statSync === "function") {
      try {
        const stat = fs.statSync(filePath);
        secretFileMtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        secretFileMtimeMs = 0;
      }
    }
  }
  return {
    secretStored: fileExists,
    secretConfigured: !!(secrets.appId && secrets.appSecret),
    secretFileMtimeMs,
  };
}

// `reason` is the stable code the UI maps to a localized, platform-aware
// string; `message` stays English and brand-neutral because it is a log/
// fallback diagnostic that can surface under either platform. Never name a
// single brand here — a Lark user reading "Feishu App ID is invalid" is being
// told their (correct) setup is wrong.
function readiness(config, secrets) {
  const evaluated = evaluateFeishuApprovalConfiguration(config, secrets, {
    requireEnabled: true,
    requireApprover: true,
  });
  if (evaluated.ok) return { ready: true, config: evaluated.config };
  const messages = {
    disabled: "Remote approval is disabled",
    "invalid-config": "Remote approval configuration is invalid",
    "missing-credentials": "App ID and App Secret are not configured",
    "invalid-app-id": "App ID format is invalid",
    "credential-provenance-unknown": "Saved credential platform is unknown",
    "credential-platform-mismatch": "Saved credentials do not match the selected platform",
    "missing-approver": "Approver is not configured",
    "approver-provenance-unknown": "Approver provenance is unknown",
    "approver-binding-incomplete": "Approver binding is incomplete",
    "approver-platform-mismatch": "Approver does not match the saved credential platform",
    "approver-app-mismatch": "Approver does not match the saved App ID",
    "lookup-requires-open-id": "Lookup approver must use open_id",
  };
  return {
    ready: false,
    reason: evaluated.code,
    message: messages[evaluated.code] || "Remote approval configuration is invalid",
    config: evaluated.config,
  };
}

function redactionSecretsForFeishuApproval(config, secrets) {
  const normalized = normalizeFeishuApproval(config);
  const sourceSecrets = secrets && typeof secrets === "object" ? secrets : {};
  return [
    normalized.approverId,
    sourceSecrets.appId,
    sourceSecrets.appSecret,
    sourceSecrets.verificationToken,
    sourceSecrets.encryptKey,
  ].filter(Boolean);
}

module.exports = {
  DEFAULT_FEISHU_APPROVAL,
  FEISHU_PLATFORMS,
  FEISHU_ID_TYPES,
  FEISHU_APPROVER_SOURCES,
  CONNECTION_TIMEOUT_SECONDS,
  cloneDefaultFeishuApproval,
  normalizeFeishuApproval,
  validateFeishuApproval,
  deriveSavedFeishuCredentialIdentity,
  validateFeishuApproverBinding,
  evaluateFeishuApprovalConfiguration,
  planFeishuCredentialWrite,
  defaultSecretsEnvFilePath,
  readSecretsEnvFile,
  writeSecretsEnvFile,
  readMaskedSecrets,
  secretStatus,
  readiness,
  redactionSecretsForFeishuApproval,
  maskSecret,
};
