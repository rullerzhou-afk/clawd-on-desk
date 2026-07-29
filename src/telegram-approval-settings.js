"use strict";

const path = require("path");

const DEFAULT_TG_APPROVAL = Object.freeze({
  enabled: false,
  allowedTgUserId: "",
  targetSessionKey: "",
  // R1a bare ping gate: when false, Clawd will not send a "finished" message.
  // Native-only; getTelegramCompanionClient in main.js gates delivery on the
  // verified in-process transport.
  notifyOnComplete: false,
  // R1b privacy default: do not send assistant output unless the user
  // explicitly opts into "Full answer" from Settings.
  completionOutputMode: "off",
  // R3 dogfood gate. Slice 1/2/3a only focuses the selected local terminal;
  // it does not paste text or press Enter.
  r3DirectSendEnabled: false,
});

const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_USER_ID_RE = /^[1-9]\d{4,19}$/;
const TELEGRAM_SESSION_KEY_RE = /^telegram:-?[1-9]\d{4,19}(?::\d{1,20}){0,2}$/;
const COMPLETION_OUTPUT_MODES = Object.freeze(["off", "full"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultTelegramApproval() {
  return { ...DEFAULT_TG_APPROVAL };
}

function trimString(value, maxLen = 256) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function isValidTelegramUserId(value) {
  return TELEGRAM_USER_ID_RE.test(String(value || "").trim());
}

function normalizeTelegramSessionKey(value) {
  const raw = trimString(value, 256);
  if (!raw) return "";
  const key = /^-?\d+(?::\d+){0,2}$/.test(raw) ? `telegram:${raw}` : raw;
  return TELEGRAM_SESSION_KEY_RE.test(key) ? key : "";
}

function normalizeCompletionOutputMode(value, fallback = DEFAULT_TG_APPROVAL.completionOutputMode) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mode === "tail") return "full";
  if (COMPLETION_OUTPUT_MODES.includes(mode)) return mode;
  return COMPLETION_OUTPUT_MODES.includes(fallback) ? fallback : DEFAULT_TG_APPROVAL.completionOutputMode;
}

function isValidTelegramSessionKey(value) {
  return TELEGRAM_SESSION_KEY_RE.test(String(value || "").trim());
}

function normalizeTelegramApproval(value, defaultsValue = DEFAULT_TG_APPROVAL) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_TG_APPROVAL;
  const out = {
    enabled: defaults.enabled === true,
    allowedTgUserId: trimString(defaults.allowedTgUserId, 64),
    targetSessionKey: normalizeTelegramSessionKey(defaults.targetSessionKey),
    notifyOnComplete: defaults.notifyOnComplete === true,
    completionOutputMode: normalizeCompletionOutputMode(defaults.completionOutputMode),
    r3DirectSendEnabled: defaults.r3DirectSendEnabled === true,
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.notifyOnComplete === "boolean") out.notifyOnComplete = value.notifyOnComplete;
  if (typeof value.r3DirectSendEnabled === "boolean") out.r3DirectSendEnabled = value.r3DirectSendEnabled;
  if (typeof value.completionOutputMode === "string") {
    out.completionOutputMode = normalizeCompletionOutputMode(value.completionOutputMode, out.completionOutputMode);
  }
  if (typeof value.allowedTgUserId === "string") {
    const candidate = trimString(value.allowedTgUserId, 64);
    out.allowedTgUserId = isValidTelegramUserId(candidate) ? candidate : "";
  }
  if (typeof value.targetSessionKey === "string") {
    out.targetSessionKey = normalizeTelegramSessionKey(value.targetSessionKey);
  }
  return out;
}

function validateTelegramApproval(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "tgApproval must be a plain object" };
  }
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "allowedTgUserId" && key !== "targetSessionKey"
      && key !== "notifyOnComplete" && key !== "completionOutputMode"
      && key !== "r3DirectSendEnabled") {
      return { status: "error", message: `tgApproval.${key} is not supported` };
    }
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "tgApproval.enabled must be a boolean" };
  }
  if (value.notifyOnComplete !== undefined && typeof value.notifyOnComplete !== "boolean") {
    return { status: "error", message: "tgApproval.notifyOnComplete must be a boolean" };
  }
  if (value.r3DirectSendEnabled !== undefined && typeof value.r3DirectSendEnabled !== "boolean") {
    return { status: "error", message: "tgApproval.r3DirectSendEnabled must be a boolean" };
  }
  if (
    value.completionOutputMode !== undefined
    && (typeof value.completionOutputMode !== "string"
      || !COMPLETION_OUTPUT_MODES.includes(value.completionOutputMode))
  ) {
    return { status: "error", message: "tgApproval.completionOutputMode must be off|full" };
  }
  const allowed = trimString(value.allowedTgUserId, 64);
  if (allowed && !isValidTelegramUserId(allowed)) {
    return { status: "error", message: "tgApproval.allowedTgUserId must be a Telegram numeric user id" };
  }
  const target = trimString(value.targetSessionKey, 256);
  const normalizedTarget = normalizeTelegramSessionKey(target);
  if (target && !normalizedTarget) {
    return { status: "error", message: "tgApproval.targetSessionKey must be telegram:<numeric chat id>" };
  }
  return { status: "ok" };
}

function validateTelegramBotToken(token) {
  const value = trimString(token, 512);
  if (!value) return { status: "error", message: "Telegram bot token is required" };
  if (!BOT_TOKEN_RE.test(value)) {
    return { status: "error", message: "Telegram bot token format is invalid" };
  }
  return { status: "ok", token: value };
}

function defaultTokenEnvFilePath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "telegram-approval.env") : "";
}

function buildTokenEnvFile(token) {
  const validated = validateTelegramBotToken(token);
  if (validated.status !== "ok") return validated;
  return {
    status: "ok",
    text: `CLAWD_TG_BOT_TOKEN=${validated.token}\n`,
  };
}

function writeTokenEnvFile({ fs, path: pathModule = path, filePath, token, platform = process.platform } = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return { status: "error", message: "writeTokenEnvFile requires fs" };
  }
  const built = buildTokenEnvFile(token);
  if (built.status !== "ok") return built;
  if (!filePath || typeof filePath !== "string") {
    return { status: "error", message: "Telegram token env file path is required" };
  }
  try {
    const dir = pathModule.dirname(filePath);
    const base = pathModule.basename(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const tmpPath = pathModule.join(dir, `.${base}.${suffix}.tmp`);
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, built.text, { encoding: "utf8" });
      fs.closeSync(fd);
      fd = null;
      if (platform !== "win32" && typeof fs.chmodSync === "function") {
        fs.chmodSync(tmpPath, 0o600);
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      if (fd != null && typeof fs.closeSync === "function") {
        try { fs.closeSync(fd); } catch {}
      }
      if (typeof fs.rmSync === "function") {
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
      } else if (typeof fs.unlinkSync === "function") {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      throw err;
    }
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    return { status: "ok", tokenStored: true, filePath };
  } catch (err) {
    return { status: "error", message: `Telegram token write failed: ${err && err.message}` };
  }
}

// Compute a short masked preview of a bot token for UI display only — never
// returns the raw token. Format: "AAEk……DyLc" (first 4 + last 4 of the part
// after the bot id colon). The bot id itself is intentionally dropped — it is
// public-ish (visible to anyone who can DM the bot) but the user does not
// need to see it in Settings, and hiding it keeps the preview short and uniform.
// Tokens too short to safely show 4+4 without overlap are fully masked.
function maskTelegramBotToken(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) return "";
  const colonIdx = value.indexOf(":");
  const secret = colonIdx > 0 ? value.slice(colonIdx + 1) : value;
  if (secret.length < 10) return "••••";
  return `${secret.slice(0, 4)}……${secret.slice(-4)}`;
}

// Read the bot token from the env file and return ONLY a masked preview.
// The raw token never leaves main; the masked form is safe-ish to show in UI
// (industry pattern, similar to GitHub PAT display). Returns "" if no token is
// stored or the file is unreadable.
function readMaskedBotToken({ fs, filePath } = {}) {
  if (!fs || !filePath || typeof fs.readFileSync !== "function") return "";
  let text = "";
  try {
    text = String(fs.readFileSync(filePath, { encoding: "utf8" }) || "");
  } catch {
    return "";
  }
  const match = text.match(/^\s*CLAWD_TG_BOT_TOKEN\s*=\s*(.+?)\s*$/m);
  if (!match) return "";
  return maskTelegramBotToken(match[1]);
}

// Token state is derived solely from the userData env-file on disk. Earlier
// versions also accepted the bot-token env var as a "configured" signal, but
// that path pulled the token value into Clawd's main process and violated the
// "bot token only ever lives at userData/telegram-approval.env" invariant.
// The `env` parameter is retained for signature compatibility but is
// intentionally ignored.
function tokenStatus({ fs, filePath } = {}) {
  let fileExists = false;
  let tokenFileMtimeMs = 0;
  if (fs && filePath && typeof fs.existsSync === "function") {
    try { fileExists = fs.existsSync(filePath); } catch { fileExists = false; }
    if (fileExists && typeof fs.statSync === "function") {
      try {
        const stat = fs.statSync(filePath);
        tokenFileMtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        tokenFileMtimeMs = 0;
      }
    }
  }
  return {
    tokenConfigured: fileExists,
    tokenStored: fileExists,
    tokenFileMtimeMs,
  };
}

function redactionSecretsForTelegramApproval(config) {
  const normalized = normalizeTelegramApproval(config);
  const secrets = [];
  if (normalized.allowedTgUserId) secrets.push(normalized.allowedTgUserId);
  if (normalized.targetSessionKey) {
    secrets.push(normalized.targetSessionKey);
    for (const part of normalized.targetSessionKey.replace(/^telegram:/, "").split(":")) {
      if (part) secrets.push(part);
    }
  }
  return [...new Set(secrets)];
}

function readiness(config, token) {
  const normalized = normalizeTelegramApproval(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  const valid = validateTelegramApproval(normalized);
  if (valid.status !== "ok") return { ready: false, reason: "invalid-config", message: valid.message, config: normalized };
  if (!normalized.allowedTgUserId) {
    return { ready: false, reason: "invalid-config", message: "Telegram allowed user id is not configured", config: normalized };
  }
  if (!normalized.targetSessionKey) {
    return { ready: false, reason: "invalid-config", message: "Telegram target session key is not configured", config: normalized };
  }
  if (!token || token.tokenConfigured !== true) {
    return { ready: false, reason: "missing-token", message: "Telegram bot token is not configured", config: normalized };
  }
  return { ready: true, config: normalized };
}

module.exports = {
  DEFAULT_TG_APPROVAL,
  BOT_TOKEN_RE,
  TELEGRAM_USER_ID_RE,
  TELEGRAM_SESSION_KEY_RE,
  COMPLETION_OUTPUT_MODES,
  cloneDefaultTelegramApproval,
  normalizeTelegramApproval,
  normalizeCompletionOutputMode,
  validateTelegramApproval,
  validateTelegramBotToken,
  normalizeTelegramSessionKey,
  isValidTelegramUserId,
  isValidTelegramSessionKey,
  defaultTokenEnvFilePath,
  buildTokenEnvFile,
  writeTokenEnvFile,
  tokenStatus,
  maskTelegramBotToken,
  readMaskedBotToken,
  redactionSecretsForTelegramApproval,
  readiness,
};
