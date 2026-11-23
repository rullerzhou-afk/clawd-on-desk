"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDeepseekBalanceCredentialStore, STORAGE_UNAVAILABLE } = require("../src/deepseek-balance-credential-store");
const { createRuntimeStore, createDeepseekBalanceRuntime } = require("../src/deepseek-balance-runtime");

const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";
function withFiles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-deepseek-credential-"));
  const options = { recordPath: path.join(dir, "credential.json"), randomUUID: () => ID_A,
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    } };
  return Promise.resolve().then(() => fn(options, dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("DeepSeek credentials use private ciphertext and expose only metadata", () => withFiles((options) => {
  const store = createDeepseekBalanceCredentialStore(options);
  store.save("sk-private-deepseek");
  assert.equal(store.load().apiKey, "sk-private-deepseek");
  assert.doesNotMatch(fs.readFileSync(options.recordPath, "utf8"), /sk-private-deepseek/);
  assert.doesNotMatch(JSON.stringify(store.inspect()), /sk-private-deepseek/);
  if (process.platform !== "win32") assert.equal(fs.statSync(options.recordPath).mode & 0o777, 0o600);
}));

test("DeepSeek refuses basic_text and preserves a key when the vault is locked", () => withFiles((options) => {
  const weak = createDeepseekBalanceCredentialStore({ ...options, safeStorage: { ...options.safeStorage,
    getSelectedStorageBackend: () => "basic_text" } });
  assert.throws(() => weak.save("key"), (error) => error.code === STORAGE_UNAVAILABLE);
  assert.equal(fs.existsSync(options.recordPath), false);
  createDeepseekBalanceCredentialStore(options).save("key");
  const before = fs.readFileSync(options.recordPath);
  const locked = createDeepseekBalanceCredentialStore({ ...options, safeStorage: { ...options.safeStorage,
    decryptString: () => { throw new Error("locked"); } } });
  assert.equal(locked.inspect().decryptable, false);
  assert.equal(locked.inspectMetadata().credentialId, ID_A);
  assert.deepEqual(fs.readFileSync(options.recordPath), before);
}));

test("DeepSeek recovers a crash between credential replacement and journal replacement", () => withFiles(async (options, dir) => {
  const credentialStore = createDeepseekBalanceCredentialStore(options);
  credentialStore.save("old-key");
  const runtimeStore = createRuntimeStore({ recordPath: path.join(dir, "runtime.json") });
  runtimeStore.write({ version: 1, credentialId: ID_A, currency: "CNY", baseline: 500,
    lastAmount: 400, capturedAt: 1000 });
  // Only the credential replacement reached disk before the process stopped.
  createDeepseekBalanceCredentialStore({ ...options, randomUUID: () => ID_B }).save("new-key");
  let clears = 0;
  const runtime = createDeepseekBalanceRuntime({ credentialStore, runtimeStore,
    client: { fetchBalance: () => { throw new Error("must not query while disabled"); } },
    getSettingsSnapshot: () => ({ deepseekBalanceCollectionEnabled: false }),
    setCollectionEnabled: async () => ({ status: "ok" }),
    commitLocalDeepseekQuota: () => { throw new Error("must not commit"); },
    clearLocalDeepseekQuota: () => { clears++; return { persisted: true }; },
  });
  await runtime.initialize();
  assert.ok(clears > 0);
  assert.equal(runtimeStore.read(), null);
  assert.equal(credentialStore.load().apiKey, "new-key");
  runtime.dispose();
}));

test("DeepSeek journal replacement is atomic and discards invalid records", () => withFiles((options, dir) => {
  const recordPath = path.join(dir, "runtime.json");
  const store = createRuntimeStore({ recordPath });
  const record = { version: 1, credentialId: ID_A, currency: "USD", baseline: 12,
    lastAmount: 10, capturedAt: 1000 };
  store.write(record);
  const before = fs.readFileSync(recordPath);
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error("disk full"); };
  assert.throws(() => createRuntimeStore({ recordPath, fs: failingFs }).write({ ...record, lastAmount: 9 }));
  assert.deepEqual(fs.readFileSync(recordPath), before);
  assert.deepEqual(store.read(), record);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")).length, 0);
  store.write({ ...record, currency: "EUR" });
  assert.equal(store.read(), null);
}));


test("DeepSeek first launch without a key performs no runtime file writes", () => withFiles(async (options, dir) => {
  const noWrites = Object.create(fs);
  for (const method of ["mkdirSync", "writeFileSync", "renameSync", "unlinkSync"]) {
    noWrites[method] = () => { throw new Error(`unexpected ${method}`); };
  }
  const recordPath = path.join(dir, "runtime.json");
  const runtime = createDeepseekBalanceRuntime({
    credentialStore: createDeepseekBalanceCredentialStore(options),
    runtimeStore: createRuntimeStore({ recordPath, fs: noWrites }),
    client: { fetchBalance: () => { throw new Error("must not query"); } },
    getSettingsSnapshot: () => ({ deepseekBalanceCollectionEnabled: false }),
    clearLocalDeepseekQuota: () => ({ persisted: true }),
    setCollectionEnabled: async () => ({ status: "ok" }),
    commitLocalDeepseekQuota: () => { throw new Error("must not commit"); },
  });
  assert.equal((await runtime.initialize()).status, "ok");
  assert.equal(fs.existsSync(recordPath), false);
  runtime.dispose();
}));

test("DeepSeek clearing its runtime journal removes the file and reports deletion errors", () => withFiles((options, dir) => {
  const recordPath = path.join(dir, "runtime.json");
  const store = createRuntimeStore({ recordPath });
  store.write({ version: 1, credentialId: ID_A, rejected: true });
  assert.equal(store.read().rejected, true);
  const failingFs = Object.create(fs);
  failingFs.unlinkSync = () => { throw new Error("delete failed"); };
  assert.throws(() => createRuntimeStore({ recordPath, fs: failingFs }).write(null), /delete failed/);
  assert.equal(fs.existsSync(recordPath), true);
  store.write(null);
  assert.equal(fs.existsSync(recordPath), false);
  assert.doesNotThrow(() => store.write(null));
}));


test("DeepSeek rejection survives rebuilding the on-disk runtime store", () => withFiles(async (options, dir) => {
  const credentialStore = createDeepseekBalanceCredentialStore(options);
  credentialStore.save("sk-private");
  const recordPath = path.join(dir, "runtime.json");
  let requests = 0;
  let result = { kind: "credential-rejected", statusCode: 401 };
  const dependencies = {
    credentialStore,
    client: { fetchBalance: async () => { requests++; return result; } },
    getSettingsSnapshot: () => ({ deepseekBalanceCollectionEnabled: true,
      agents: { "deepseek-harness": { enabled: true } } }),
    setCollectionEnabled: async () => ({ status: "ok" }),
    clearLocalDeepseekQuota: () => ({ persisted: true }),
    commitLocalDeepseekQuota: () => ({ accepted: true, persisted: true }),
  };
  const first = createDeepseekBalanceRuntime({ ...dependencies, runtimeStore: createRuntimeStore({ recordPath }) });
  await first.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();
  assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).rejected, true);
  const second = createDeepseekBalanceRuntime({ ...dependencies, runtimeStore: createRuntimeStore({ recordPath }) });
  try {
    await second.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(second.getStatus().state, "credential-rejected");
    result = { kind: "success", value: { is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "12.00" }] } };
    await second.reconnect();
    assert.equal(requests, 2);
    assert.equal(second.getStatus().state, "fresh");
    assert.notEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")).rejected, true);
  } finally {
    second.dispose();
  }
}));
