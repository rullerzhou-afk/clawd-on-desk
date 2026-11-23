"use strict";

const os = require("os");
const path = require("path");
const { createQuotaCredentialStore } = require("./quota-credential-store");

const DEFAULT_CREDENTIAL_PATH = path.join(os.homedir(), ".clawd", "deepseek-balance-credential.json");
const STORAGE_UNAVAILABLE = "DEEPSEEK_BALANCE_STORAGE_UNAVAILABLE";
const CREDENTIAL_INVALID = "DEEPSEEK_BALANCE_CREDENTIAL_INVALID";

function createDeepseekBalanceCredentialStore(options = {}) {
  return createQuotaCredentialStore({
    CREDENTIAL_VERSION: 1,
    CREDENTIAL_KIND: "deepseek-api-key",
    DEFAULT_CREDENTIAL_PATH,
    MAX_API_KEY_LENGTH: 2048,
    STORAGE_UNAVAILABLE,
    CREDENTIAL_INVALID,
    keyName: "DeepSeek API Key",
    recordName: "DeepSeek balance credential record",
  }, options);
}

module.exports = {
  CREDENTIAL_INVALID, DEFAULT_CREDENTIAL_PATH, STORAGE_UNAVAILABLE, createDeepseekBalanceCredentialStore,
};
