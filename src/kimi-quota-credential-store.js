"use strict";

// Kimi Code API keys are deliberately kept outside prefs. Settings snapshots
// are broadcast to every renderer window, while this file is read only by the
// main process and contains a safeStorage ciphertext plus a random, non-derived
// credential id used to bind persisted quota to the key that produced it.

const os = require("os");
const path = require("path");
const { atomicWriteJson, createQuotaCredentialStore, isCredentialId } = require("./quota-credential-store");

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

const config = {
  CREDENTIAL_VERSION, CREDENTIAL_KIND, DEFAULT_CREDENTIAL_PATH, MAX_API_KEY_LENGTH,
  STORAGE_UNAVAILABLE, CREDENTIAL_INVALID, keyName: "Kimi Code API Key",
  recordName: "Kimi quota credential record", secretName: "Kimi key",
};

function createKimiQuotaCredentialStore(options = {}) {
  return createQuotaCredentialStore(config, options);
}

function validateApiKey(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_API_KEY_LENGTH
      || value.trim() !== value || /[\r\n\0]/.test(value)) {
    const error = new Error("Kimi Code API Key is invalid");
    error.code = CREDENTIAL_INVALID;
    throw error;
  }
  return value;
}

module.exports = {
  CREDENTIAL_INVALID, CREDENTIAL_KIND, CREDENTIAL_VERSION, DEFAULT_CREDENTIAL_PATH,
  MAX_API_KEY_LENGTH, STORAGE_UNAVAILABLE, atomicWriteJson, createKimiQuotaCredentialStore,
  isCredentialId, validateApiKey,
};
