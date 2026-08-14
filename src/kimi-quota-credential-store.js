"use strict";

// Kimi Code API keys are deliberately kept outside prefs. Settings snapshots
// are broadcast to every renderer window, while this file is read only by the
// main process and contains a safeStorage ciphertext plus a random, non-derived
// credential id used to bind persisted quota to the key that produced it.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CREDENTIAL_VERSION = 1;
const CREDENTIAL_KIND = "kimi-code-api-key";
const DEFAULT_CREDENTIAL_PATH = path.join(
  os.homedir(),
  ".clawd",
  "kimi-code-quota-credential.json"
);
const MAX_API_KEY_LENGTH = 2048;
const STORAGE_UNAVAILABLE = "KIMI_QUOTA_STORAGE_UNAVAILABLE";
const CREDENTIAL_INVALID = "KIMI_QUOTA_CREDENTIAL_INVALID";

function makeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function validateApiKey(value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > MAX_API_KEY_LENGTH
      || value.trim() !== value
      || /[\r\n\0]/.test(value)) {
    throw makeError(CREDENTIAL_INVALID, "Kimi Code API Key is invalid");
  }
  return value;
}

function selectedBackend(safeStorage) {
  if (!safeStorage
      || typeof safeStorage.isEncryptionAvailable !== "function"
      || !safeStorage.isEncryptionAvailable()
      || typeof safeStorage.encryptString !== "function"
      || typeof safeStorage.decryptString !== "function") {
    throw makeError(STORAGE_UNAVAILABLE, "system credential encryption is unavailable");
  }
  let backend = "safe-storage";
  if (typeof safeStorage.getSelectedStorageBackend === "function") {
    try {
      const selected = safeStorage.getSelectedStorageBackend();
      if (typeof selected === "string" && selected) backend = selected;
    } catch (cause) {
      throw makeError(STORAGE_UNAVAILABLE, "system credential backend is unavailable", cause);
    }
  }
  // Electron's Linux basic_text backend is reversible obfuscation, not a
  // credential vault. Kimi keys can invoke models and potentially spend Extra
  // Usage, so this integration fails closed instead of silently using it.
  if (backend === "basic_text" || backend === "plaintext") {
    throw makeError(STORAGE_UNAVAILABLE, "secure system credential storage is unavailable");
  }
  return backend;
}

function isCredentialId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateRecord(value) {
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.version !== CREDENTIAL_VERSION
      || value.kind !== CREDENTIAL_KIND
      || !isCredentialId(value.credentialId)
      || typeof value.ciphertext !== "string"
      || value.ciphertext.length < 1
      || value.ciphertext.length > 16 * 1024
      || typeof value.storageBackend !== "string"
      || !value.storageBackend
      || !Number.isFinite(value.createdAt)
      || !Number.isFinite(value.updatedAt)) {
    throw makeError(CREDENTIAL_INVALID, "Kimi quota credential record is invalid");
  }
  return value;
}

function atomicWriteJson(filePath, value, options = {}) {
  const fsImpl = options.fs || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { fsImpl.chmodSync(temporaryPath, 0o600); } catch {}
    fsImpl.renameSync(temporaryPath, filePath);
    renamed = true;
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(temporaryPath); } catch {}
    }
  }
}

function createKimiQuotaCredentialStore(options = {}) {
  const safeStorage = options.safeStorage;
  const fsImpl = options.fs || fs;
  const recordPath = options.recordPath || DEFAULT_CREDENTIAL_PATH;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const randomUUID = typeof options.randomUUID === "function"
    ? options.randomUUID
    : crypto.randomUUID;
  const randomBytes = options.randomBytes || crypto.randomBytes;

  function readRecord() {
    let raw;
    try {
      raw = fsImpl.readFileSync(recordPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw makeError(CREDENTIAL_INVALID, "Kimi quota credential record is invalid", cause);
    }
    return validateRecord(parsed);
  }

  function inspect() {
    const record = readRecord();
    if (!record) return { configured: false, decryptable: false };
    try {
      selectedBackend(safeStorage);
      const plaintext = safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
      validateApiKey(plaintext);
      return {
        configured: true,
        decryptable: true,
        credentialId: record.credentialId,
        updatedAt: record.updatedAt,
      };
    } catch (error) {
      return {
        configured: true,
        decryptable: false,
        credentialId: record.credentialId,
        updatedAt: record.updatedAt,
        reason: error && error.code === STORAGE_UNAVAILABLE
          ? "secure-storage-unavailable"
          : "credential-unreadable",
      };
    }
  }

  function load() {
    const record = readRecord();
    if (!record) return null;
    selectedBackend(safeStorage);
    let apiKey;
    try {
      apiKey = safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
    } catch (cause) {
      throw makeError(STORAGE_UNAVAILABLE, "system credential storage could not decrypt the Kimi key", cause);
    }
    return {
      apiKey: validateApiKey(apiKey),
      credentialId: record.credentialId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function save(apiKey) {
    validateApiKey(apiKey);
    const storageBackend = selectedBackend(safeStorage);
    let ciphertext;
    try {
      ciphertext = safeStorage.encryptString(apiKey).toString("base64");
    } catch (cause) {
      throw makeError(STORAGE_UNAVAILABLE, "system credential storage could not encrypt the Kimi key", cause);
    }
    const previous = readRecord();
    const timestamp = now();
    const record = {
      version: CREDENTIAL_VERSION,
      kind: CREDENTIAL_KIND,
      credentialId: randomUUID(),
      ciphertext,
      storageBackend,
      createdAt: previous ? previous.createdAt : timestamp,
      updatedAt: timestamp,
    };
    validateRecord(record);
    atomicWriteJson(recordPath, record, { fs: fsImpl, randomBytes });
    return {
      credentialId: record.credentialId,
      replaced: Boolean(previous),
      updatedAt: record.updatedAt,
    };
  }

  function forget() {
    try {
      fsImpl.unlinkSync(recordPath);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  return { inspect, load, save, forget, recordPath };
}

module.exports = {
  CREDENTIAL_INVALID,
  CREDENTIAL_KIND,
  CREDENTIAL_VERSION,
  DEFAULT_CREDENTIAL_PATH,
  MAX_API_KEY_LENGTH,
  STORAGE_UNAVAILABLE,
  atomicWriteJson,
  createKimiQuotaCredentialStore,
  isCredentialId,
  validateApiKey,
};
