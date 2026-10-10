"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CREDENTIAL_INVALID,
  STORAGE_UNAVAILABLE,
  createRemoteOpenclawCredentialStore,
  isCredentialId,
} = require("../src/remote-openclaw-credential-store");

function createFakeSafeStorage(options = {}) {
  const backend = options.backend || "keychain";
  return {
    isEncryptionAvailable: () => options.available !== false,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^enc:/, ""),
  };
}

function createFakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (p, data) => { files.set(p, String(data)); },
    readFileSync: (p) => {
      if (!files.has(p)) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return files.get(p);
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    chmodSync: () => {},
    unlinkSync: (p) => {
      if (!files.has(p)) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      files.delete(p);
    },
  };
}

function createStore(options = {}) {
  const fsImpl = createFakeFs();
  const store = createRemoteOpenclawCredentialStore({
    safeStorage: options.safeStorage || createFakeSafeStorage(),
    fs: fsImpl,
    recordPath: options.recordPath || "/home/u/.clawd/remote-openclaw-credential.json",
    now: () => 1234,
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    randomBytes: () => Buffer.from("0123456789abcdef"),
  });
  return { store, fsImpl };
}

test("an absent credential file reads as not configured", () => {
  const { store } = createStore();
  assert.deepEqual(store.inspect(), { configured: false, decryptable: false });
  assert.equal(store.load(), null);
});

test("save then load round-trips the secret", () => {
  const { store } = createStore();
  const saved = store.save("gateway-password");
  assert.ok(isCredentialId(saved.credentialId));
  assert.equal(saved.replaced, false);

  const loaded = store.load();
  assert.equal(loaded.secret, "gateway-password");
  assert.equal(store.inspect().configured, true);
  assert.equal(store.inspect().decryptable, true);
});

test("saving a second time reports that it replaced the previous credential", () => {
  const { store } = createStore();
  store.save("first");
  assert.equal(store.save("second").replaced, true);
  assert.equal(store.load().secret, "second");
});

test("forget removes the credential", () => {
  const { store } = createStore();
  store.save("pw");
  assert.equal(store.forget(), true);
  assert.equal(store.load(), null);
  assert.equal(store.forget(), false, "forgetting twice is not an error");
});

test("empty and oversized secrets are rejected", () => {
  const { store } = createStore();
  for (const bad of ["", "   ", "a\nb", "x".repeat(2000), null, undefined, 42]) {
    assert.throws(() => store.save(bad), (err) => err.code === CREDENTIAL_INVALID, `input ${JSON.stringify(bad)}`);
  }
});

test("a blank secret is rejected even though it round-trips", () => {
  const { store } = createStore();
  assert.throws(() => store.save(""));
  // Nothing was written, so nothing can be loaded.
  assert.equal(store.load(), null);
});

test("an unencrypted backend fails closed instead of storing the secret", () => {
  for (const backend of ["basic_text", "plaintext"]) {
    const { store } = createStore({ safeStorage: createFakeSafeStorage({ backend }) });
    assert.throws(() => store.save("pw"), (err) => err.code === STORAGE_UNAVAILABLE, `backend ${backend}`);
    assert.equal(store.load(), null);
  }
});

test("encryption being unavailable fails closed", () => {
  const { store } = createStore({ safeStorage: createFakeSafeStorage({ available: false }) });
  assert.throws(() => store.save("pw"), (err) => err.code === STORAGE_UNAVAILABLE);
  // inspect() must still answer, not throw — the settings panel calls it.
  assert.doesNotThrow(() => store.inspect());
});

test("a corrupt record is reported as configured-but-unreadable rather than throwing", () => {
  const { store, fsImpl } = createStore();
  fsImpl.files.set("/home/u/.clawd/remote-openclaw-credential.json", "{not json");
  assert.doesNotThrow(() => store.inspect());
  // load() is the strict path used when actually opening a connection.
  assert.throws(() => store.load());
});

test("a record whose ciphertext no longer decrypts is reported, not thrown", () => {
  const { store } = createStore();
  store.save("pw");
  const unreadable = createRemoteOpenclawCredentialStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (v) => Buffer.from(v, "utf8"),
      decryptString: () => { throw new Error("wrong key"); },
    },
    fs: (() => {
      const fsImpl = createFakeFs();
      return fsImpl;
    })(),
    recordPath: "/home/u/.clawd/other.json",
  });
  assert.doesNotThrow(() => unreadable.inspect());
  assert.equal(typeof unreadable.inspect().configured, "boolean");
});

test("the secret never appears in the inspected metadata", () => {
  const { store } = createStore();
  store.save("super-secret-value");
  const info = store.inspect();
  assert.equal(JSON.stringify(info).includes("super-secret-value"), false);
});
