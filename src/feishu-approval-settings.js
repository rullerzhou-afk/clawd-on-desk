"use strict";

const path = require("path");

const DEFAULT_FEISHU_APPROVAL = Object.freeze({
  enabled: false,
  idType: "open_id",
  approverId: "",
});

const FEISHU_ID_TYPES = new Set(["open_id", "user_id", "union_id"]);
const SECRET_KEYS = Object.freeze({
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

function cloneDefaultFeishuApproval() {
  return { ...DEFAULT_FEISHU_APPROVAL };
}

function normalizeFeishuApproval(value, defaultsValue = DEFAULT_FEISHU_APPROVAL) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_FEISHU_APPROVAL;
  const defaultIdType = FEISHU_ID_TYPES.has(defaults.idType) ? defaults.idType : DEFAULT_FEISHU_APPROVAL.idType;
  const out = {
    enabled: defaults.enabled === true,
    idType: defaultIdType,
    approverId: trimString(defaults.approverId, 128),
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.idType === "string") {
    const idType = trimString(value.idType, 32);
    out.idType = FEISHU_ID_TYPES.has(idType) ? idType : DEFAULT_FEISHU_APPROVAL.idType;
  }
  if (typeof value.approverId === "string") out.approverId = trimString(value.approverId, 128);
  return out;
}

function validateFeishuApproval(value) {
  if (!isPlainObject(value)) return { status: "error", message: "feishuApproval must be a plain object" };
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "idType" && key !== "approverId") {
      return { status: "error", message: `feishuApproval.${key} is not supported` };
    }
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "feishuApproval.enabled must be a boolean" };
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
    return { appId: "", appSecret: "", verificationToken: "", encryptKey: "" };
  }
  let parsed = {};
  try {
    parsed = parseEnvText(fs.readFileSync(filePath, "utf8"));
  } catch {
    parsed = {};
  }
  return {
    appId: trimString(parsed[SECRET_KEYS.appId], 256),
    appSecret: trimString(parsed[SECRET_KEYS.appSecret], 512),
    verificationToken: trimString(parsed[SECRET_KEYS.verificationToken], 512),
    encryptKey: trimString(parsed[SECRET_KEYS.encryptKey], 512),
  };
}

function buildSecretsEnvFile(secrets) {
  const source = isPlainObject(secrets) ? secrets : {};
  return [
    `${SECRET_KEYS.appId}=${trimString(source.appId, 256)}`,
    `${SECRET_KEYS.appSecret}=${trimString(source.appSecret, 512)}`,
    `${SECRET_KEYS.verificationToken}=${trimString(source.verificationToken, 512)}`,
    `${SECRET_KEYS.encryptKey}=${trimString(source.encryptKey, 512)}`,
    "",
  ].join("\n");
}

function writeSecretsEnvFile({ fs, path: pathModule = path, filePath, secrets, platform = process.platform } = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return { status: "error", message: "writeSecretsEnvFile requires fs" };
  }
  if (!filePath || typeof filePath !== "string") {
    return { status: "error", message: "Feishu secrets env file path is required" };
  }
  const current = readSecretsEnvFile({ fs, filePath });
  const incoming = isPlainObject(secrets) ? secrets : {};
  const next = { ...current };
  for (const key of Object.keys(SECRET_KEYS)) {
    if (typeof incoming[key] === "string" && incoming[key].trim()) {
      next[key] = trimString(incoming[key], key === "appId" ? 256 : 512);
    }
  }
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
    return { status: "error", message: `Feishu secrets write failed: ${err && err.message}` };
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
    appId: maskSecret(secrets.appId),
    appSecret: maskSecret(secrets.appSecret),
    verificationToken: maskSecret(secrets.verificationToken),
    encryptKey: maskSecret(secrets.encryptKey),
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

function readiness(config, secrets) {
  const normalized = normalizeFeishuApproval(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  const valid = validateFeishuApproval(normalized);
  if (valid.status !== "ok") return { ready: false, reason: "invalid-config", message: valid.message, config: normalized };
  if (!normalized.approverId) {
    return { ready: false, reason: "invalid-config", message: "Feishu approver id is not configured", config: normalized };
  }
  if (!secrets || !secrets.appId || !secrets.appSecret) {
    return { ready: false, reason: "missing-secret", message: "Feishu App ID and App Secret are not configured", config: normalized };
  }
  return { ready: true, config: normalized };
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
  FEISHU_ID_TYPES,
  cloneDefaultFeishuApproval,
  normalizeFeishuApproval,
  validateFeishuApproval,
  defaultSecretsEnvFilePath,
  readSecretsEnvFile,
  writeSecretsEnvFile,
  readMaskedSecrets,
  secretStatus,
  readiness,
  redactionSecretsForFeishuApproval,
  maskSecret,
};
