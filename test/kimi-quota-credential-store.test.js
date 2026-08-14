"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  STORAGE_UNAVAILABLE,
  createKimiQuotaCredentialStore,
} = require("../src/kimi-quota-credential-store");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-credential-"));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function strongSafeStorage(options = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => options.backend || "dpapi",
    encryptString: (value) => Buffer.from(`wrapped:${value}`, "utf8"),
    decryptString: options.decryptString
      || ((value) => value.toString("utf8").replace(/^wrapped:/, "")),
  };
}

test("Kimi credential store keeps the key encrypted and outside metadata", () => withTempDir((dir) => {
  const recordPath = path.join(dir, "credential.json");
  const store = createKimiQuotaCredentialStore({
    recordPath,
    safeStorage: strongSafeStorage(),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
    now: () => 1234,
  });
  assert.deepEqual(store.inspect(), { configured: false, decryptable: false });
  assert.deepEqual(store.save("sk-kimi-secret"), {
    credentialId: "123e4567-e89b-42d3-a456-426614174000",
    replaced: false,
    updatedAt: 1234,
  });
  const disk = fs.readFileSync(recordPath, "utf8");
  assert.doesNotMatch(disk, /sk-kimi-secret/);
  assert.equal(store.load().apiKey, "sk-kimi-secret");
  assert.equal(store.inspect().credentialId, "123e4567-e89b-42d3-a456-426614174000");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  }
}));

test("Kimi credential store fails closed on Electron basic_text", () => withTempDir((dir) => {
  const store = createKimiQuotaCredentialStore({
    recordPath: path.join(dir, "credential.json"),
    safeStorage: strongSafeStorage({ backend: "basic_text" }),
  });
  assert.throws(() => store.save("sk-kimi-secret"), (error) => error.code === STORAGE_UNAVAILABLE);
  assert.equal(fs.existsSync(store.recordPath), false);
}));

test("temporary decryption failure preserves the only ciphertext", () => withTempDir((dir) => {
  const recordPath = path.join(dir, "credential.json");
  const writable = createKimiQuotaCredentialStore({
    recordPath,
    safeStorage: strongSafeStorage(),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  writable.save("sk-kimi-secret");
  const before = fs.readFileSync(recordPath, "utf8");
  const unreadable = createKimiQuotaCredentialStore({
    recordPath,
    safeStorage: strongSafeStorage({ decryptString: () => { throw new Error("vault locked"); } }),
  });
  assert.equal(unreadable.inspect().configured, true);
  assert.equal(unreadable.inspect().decryptable, false);
  assert.throws(() => unreadable.load(), (error) => error.code === STORAGE_UNAVAILABLE);
  assert.equal(fs.readFileSync(recordPath, "utf8"), before);
}));

test("a failed atomic replacement leaves the previous key readable", () => withTempDir((dir) => {
  const recordPath = path.join(dir, "credential.json");
  const safeStorage = strongSafeStorage();
  const original = createKimiQuotaCredentialStore({
    recordPath,
    safeStorage,
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  original.save("sk-old");
  const failingFs = Object.create(fs);
  failingFs.writeFileSync = (target, ...args) => {
    if (String(target).includes(".tmp-")) throw new Error("disk full");
    return fs.writeFileSync(target, ...args);
  };
  const replacement = createKimiQuotaCredentialStore({
    recordPath,
    safeStorage,
    fs: failingFs,
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174001",
  });
  assert.throws(() => replacement.save("sk-new"), /disk full/);
  assert.equal(original.load().apiKey, "sk-old");
}));

test("forget removes only the local ciphertext and is idempotent", () => withTempDir((dir) => {
  const store = createKimiQuotaCredentialStore({
    recordPath: path.join(dir, "credential.json"),
    safeStorage: strongSafeStorage(),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  store.save("sk-kimi-secret");
  assert.equal(store.forget(), true);
  assert.equal(store.forget(), false);
  assert.deepEqual(store.inspect(), { configured: false, decryptable: false });
}));
