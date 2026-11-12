"use strict";

// ── Chromium / Electron macOS Safe Storage (OSCrypt) helper ──
//
// Cursor ≥ 3.27 on macOS may store its `cursorAuth/accessToken` encrypted as:
//
//     cursor-safe-storage:v1:<base64("v10" + AES-128-CBC ciphertext)>
//
// The AES key is derived from the "Cursor Safe Storage" Keychain generic
// password (Chromium's OSCrypt scheme):
//   key = PBKDF2-HMAC-SHA1(password, salt="saltysalt", iterations=1003, len=16)
//   iv  = 16 bytes of 0x20, PKCS#7 padding
//
// Verified against CodexBar's implementation (PR #4790, ChromiumSafeStorage.swift
// + CursorAppAuth.swift) — see THIRD-PARTY-QUOTA-BUNDLE-PLAN.md.
//
// This module never writes anything and only reads the Keychain item when an
// explicit caller action asks it to (Clawd's runtime gates that behind its own
// "user explicitly enabled/refreshed" policy).

const crypto = require("crypto");
const { execFile } = require("child_process");

const ENVELOPE_PREFIX = "cursor-safe-storage:v1:";
const OSCrypt_PREFIX = "v10";
const SAFE_STORAGE_SERVICE = "Cursor Safe Storage";
const SAFE_STORAGE_ACCOUNTS = ["Cursor", "Cursor Key"];
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_SALT = "saltysalt";
const KEY_BYTES = 16;
const IV_BYTES = 16;
const SPACE_IV = 0x20;

function isEncryptedCursorToken(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

function deriveKey(password) {
  if (typeof password !== "string" || !password) throw new Error("missing Safe Storage password");
  return crypto.pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from(PBKDF2_SALT, "utf8"),
    PBKDF2_ITERATIONS, KEY_BYTES, "sha1");
}

// Decrypt a full `cursor-safe-storage:v1:` envelope. Returns the plaintext token
// or null when the envelope is not the expected shape.
function decryptEnvelope(envelope, password) {
  if (!isEncryptedCursorToken(envelope)) return null;
  let blob;
  try {
    blob = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), "base64");
  } catch {
    return null;
  }
  if (blob.length <= OSCrypt_PREFIX.length) return null;
  if (blob.subarray(0, 3).toString("utf8") !== OSCrypt_PREFIX) return null;
  const ciphertext = blob.subarray(3);
  if (!ciphertext.length || ciphertext.length % 16 !== 0) return null;
  const key = deriveKey(password);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(IV_BYTES, SPACE_IV));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const token = plaintext.toString("utf8");
  return token && token.trim() ? token.trim() : null;
}

function readKeychainPassword({ service = SAFE_STORAGE_SERVICE, account, execFileImpl = execFile, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl("security", ["find-generic-password", "-s", service, "-a", account, "-w"],
        { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
          if (error) return resolve(null);
          const value = String(stdout || "").trim();
          resolve(value || null);
        });
    } catch {
      resolve(null);
    }
  });
}

// Try the current account name first, then the legacy one. Returns
// { token, account } or null. Any Keychain denial simply yields null.
async function decryptCursorToken({ envelope, execFileImpl = execFile } = {}) {
  if (!isEncryptedCursorToken(envelope)) return null;
  for (const account of SAFE_STORAGE_ACCOUNTS) {
    const password = await readKeychainPassword({ account, execFileImpl });
    if (!password) continue;
    try {
      const token = decryptEnvelope(envelope, password);
      if (token) return { token, account };
    } catch {
      // Wrong password / corrupt blob: try the next account name only.
    }
  }
  return null;
}

// Test/utility: build an envelope the same way Cursor's app does.
function encryptTokenForTest(token, password) {
  const key = deriveKey(password);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(IV_BYTES, SPACE_IV));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(token, "utf8")), cipher.final()]);
  return ENVELOPE_PREFIX + Buffer.concat([Buffer.from(OSCrypt_PREFIX, "utf8"), ciphertext]).toString("base64");
}

module.exports = {
  ENVELOPE_PREFIX,
  SAFE_STORAGE_SERVICE,
  SAFE_STORAGE_ACCOUNTS,
  isEncryptedCursorToken,
  deriveKey,
  decryptEnvelope,
  readKeychainPassword,
  decryptCursorToken,
  encryptTokenForTest,
};
