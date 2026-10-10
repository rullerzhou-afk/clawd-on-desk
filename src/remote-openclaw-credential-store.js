"use strict";

// ── Remote OpenClaw gateway credential ──
//
// The gateway password / token is deliberately kept OUT of prefs. Settings
// snapshots are broadcast to every renderer window, so a credential stored
// there would be readable by any renderer (and by anything injected into one),
// while this file is read only by the main process.
//
// Mirrors kimi-quota-credential-store.js: a safeStorage ciphertext plus a
// random, non-derived credential id, written atomically with 0600 perms.
//
// There is exactly one gateway, so there is exactly one credential slot. The
// `authMode` pref decides how the stored secret is presented to the gateway
// (`auth.password` vs `auth.token`); switching modes therefore invalidates it
// and the settings tab clears the slot.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CREDENTIAL_VERSION = 1;
const CREDENTIAL_KIND = "remote-openclaw-gateway";
const DEFAULT_CREDENTIAL_PATH = path.join(
  os.homedir(),
  ".clawd",
  "remote-openclaw-credential.json"
);
const MAX_SECRET_LENGTH = 1024;
const STORAGE_UNAVAILABLE = "REMOTE_OPENCLAW_STORAGE_UNAVAILABLE";
const CREDENTIAL_INVALID = "REMOTE_OPENCLAW_CREDENTIAL_INVALID";

function makeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function validateSecret(value) {
  // Whitespace is NOT trimmed: a gateway password may legitimately start or
  // end with a space. An all-blank value, however, is never a credential.
  if (typeof value !== "string"
      || value.length < 1
      || value.trim() === ""
      || value.length > MAX_SECRET_LENGTH
      || /[\r\n\0]/.test(value)) {
    throw makeError(CREDENTIAL_INVALID, "Remote OpenClaw credential is invalid");
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
  // credential vault. A gateway credential can drive agents on the user's
  // behalf, so this integration fails closed like the Kimi key store.
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
    throw makeError(CREDENTIAL_INVALID, "Remote OpenClaw credential record is invalid");
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

function createRemoteOpenclawCredentialStore(options = {}) {
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
      throw makeError(CREDENTIAL_INVALID, "Remote OpenClaw credential record is invalid", cause);
    }
    return validateRecord(parsed);
  }

  // Safe read: never throws. The settings tab asks "is one saved?" and a
  // corrupt or undecryptable file must answer "no", not break the panel.
  function inspect() {
    let record = null;
    try {
      record = readRecord();
      if (!record) return { configured: false, decryptable: false };
      selectedBackend(safeStorage);
      const plaintext = safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
      validateSecret(plaintext);
      return {
        configured: true,
        decryptable: true,
        credentialId: record.credentialId,
        updatedAt: record.updatedAt,
      };
    } catch (error) {
      // A file that exists but cannot be read or decrypted still counts as
      // "something is stored here" — the panel must nudge the user to
      // re-enter it rather than silently showing an empty field.
      return {
        configured: true,
        decryptable: false,
        credentialId: record ? record.credentialId : "",
        updatedAt: record ? record.updatedAt : 0,
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
    let secret;
    try {
      secret = safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
    } catch (cause) {
      throw makeError(
        STORAGE_UNAVAILABLE,
        "system credential storage could not decrypt the Remote OpenClaw credential",
        cause,
      );
    }
    return {
      secret: validateSecret(secret),
      credentialId: record.credentialId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function save(secret) {
    validateSecret(secret);
    const storageBackend = selectedBackend(safeStorage);
    let ciphertext;
    try {
      ciphertext = safeStorage.encryptString(secret).toString("base64");
    } catch (cause) {
      throw makeError(
        STORAGE_UNAVAILABLE,
        "system credential storage could not encrypt the Remote OpenClaw credential",
        cause,
      );
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
  MAX_SECRET_LENGTH,
  STORAGE_UNAVAILABLE,
  atomicWriteJson,
  createRemoteOpenclawCredentialStore,
  isCredentialId,
  validateSecret,
};
