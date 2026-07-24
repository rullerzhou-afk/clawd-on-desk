"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  REMOTE_IDENTITY_STEP_NAMES,
  REMOTE_LAYOUT_VERSION,
  isValidInstallId,
  isValidRoutingNonce,
  sanitizeIdentityStep,
  sanitizeIdentityTxn,
} = require("./remote-ssh-profile");

const INSTALLATION_IDENTITY_FILENAME = "clawd-installation-identity.json";
const INSTALLATION_IDENTITY_VERSION = 1;
const REMOTE_IDENTITY_VERSION = 2;
const DEFAULT_PREVIOUS_NONCE_TTL_MS = 15 * 60 * 1000;

function deriveInstallId(bindingSecret) {
  if (!Buffer.isBuffer(bindingSecret) || bindingSecret.length !== 32) {
    throw new TypeError("bindingSecret must be a 256-bit Buffer");
  }
  return crypto.createHash("sha256").update(bindingSecret).digest("hex");
}

function installationIdentityPath(userDataDir) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new TypeError("userDataDir must be an absolute path");
  }
  return path.join(userDataDir, INSTALLATION_IDENTITY_FILENAME);
}

function selectedSafeStorageBackend(safeStorage) {
  if (!safeStorage
    || typeof safeStorage.isEncryptionAvailable !== "function"
    || !safeStorage.isEncryptionAvailable()
    || typeof safeStorage.encryptString !== "function"
    || typeof safeStorage.decryptString !== "function") {
    return "plaintext";
  }
  if (typeof safeStorage.getSelectedStorageBackend === "function") {
    const backend = safeStorage.getSelectedStorageBackend();
    if (typeof backend === "string" && backend) return backend;
  }
  return "safe-storage";
}

function encodeBindingSecret(bindingSecret, safeStorage, storageBackend) {
  if (storageBackend === "plaintext") return bindingSecret.toString("base64");
  return safeStorage.encryptString(bindingSecret.toString("base64")).toString("base64");
}

function decodeBindingSecret(record, safeStorage) {
  let encoded;
  if (record.storageBackend === "plaintext") {
    encoded = record.encryptedBindingSecret;
  } else {
    if (!safeStorage
      || typeof safeStorage.isEncryptionAvailable !== "function"
      || !safeStorage.isEncryptionAvailable()
      || typeof safeStorage.decryptString !== "function") {
      throw new Error("safe storage is unavailable");
    }
    encoded = safeStorage.decryptString(Buffer.from(record.encryptedBindingSecret, "base64"));
  }
  const bindingSecret = Buffer.from(encoded, "base64");
  if (bindingSecret.length !== 32) throw new Error("binding secret length is invalid");
  return bindingSecret;
}

function atomicWriteRecord(recordPath, record, fsImpl = fs, randomBytes = crypto.randomBytes) {
  fsImpl.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${recordPath}.tmp-${process.pid}-${suffix}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    fsImpl.renameSync(tmpPath, recordPath);
    renamed = true;
    try { fsImpl.chmodSync(recordPath, 0o600); } catch {}
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tmpPath); } catch {}
    }
  }
}

function mintInstallationIdentity({
  recordPath,
  safeStorage,
  fsImpl = fs,
  randomBytes = crypto.randomBytes,
  now = Date.now,
}) {
  const bindingSecret = randomBytes(32);
  const installId = deriveInstallId(bindingSecret);
  const storageBackend = selectedSafeStorageBackend(safeStorage);
  const record = {
    version: INSTALLATION_IDENTITY_VERSION,
    encryptedBindingSecret: encodeBindingSecret(bindingSecret, safeStorage, storageBackend),
    installId,
    storageBackend,
    createdAt: now(),
  };
  atomicWriteRecord(recordPath, record, fsImpl, randomBytes);
  return {
    installId,
    storageBackend,
    strongStorage: storageBackend !== "plaintext" && storageBackend !== "basic_text",
    recordPath,
  };
}

function readInstallationIdentity({ recordPath, safeStorage, fsImpl = fs }) {
  const parsed = JSON.parse(fsImpl.readFileSync(recordPath, "utf8"));
  if (!parsed
    || parsed.version !== INSTALLATION_IDENTITY_VERSION
    || !isValidInstallId(parsed.installId)
    || typeof parsed.encryptedBindingSecret !== "string"
    || typeof parsed.storageBackend !== "string"
    || !Number.isFinite(parsed.createdAt)
    || parsed.createdAt <= 0) {
    throw new Error("installation identity record is invalid");
  }
  const bindingSecret = decodeBindingSecret(parsed, safeStorage);
  const derived = deriveInstallId(bindingSecret);
  if (derived !== parsed.installId) {
    throw new Error("installation identity public id does not match its binding secret");
  }
  return {
    installId: derived,
    storageBackend: parsed.storageBackend,
    strongStorage: parsed.storageBackend !== "plaintext" && parsed.storageBackend !== "basic_text",
    recordPath,
  };
}

function loadOrCreateInstallationIdentity({
  userDataDir,
  expectedInstallId,
  persistedAuthorityPresent = false,
  safeStorage,
  fsImpl = fs,
  randomBytes = crypto.randomBytes,
  now = Date.now,
} = {}) {
  const recordPath = installationIdentityPath(userDataDir);
  try {
    const identity = readInstallationIdentity({ recordPath, safeStorage, fsImpl });
    if (expectedInstallId && identity.installId !== expectedInstallId) {
      throw new Error("cached installation id does not match the local binding");
    }
    return {
      ...identity,
      created: false,
      cloneRecoveryRequired: false,
    };
  } catch (err) {
    const missing = err && err.code === "ENOENT";
    const identity = mintInstallationIdentity({
      recordPath,
      safeStorage,
      fsImpl,
      randomBytes,
      now,
    });
    return {
      ...identity,
      created: true,
      cloneRecoveryRequired: !missing
        || isValidInstallId(expectedInstallId)
        || persistedAuthorityPresent === true,
      recoveryReason: missing ? "record-missing" : "record-invalid",
    };
  }
}

function createIdentityTxn(profile, {
  randomBytes = crypto.randomBytes,
  now = Date.now,
  previousNonceTtlMs = DEFAULT_PREVIOUS_NONCE_TTL_MS,
} = {}) {
  if (!profile || typeof profile !== "object") throw new TypeError("profile is required");
  if (profile.identityTxn && profile.identityTxn.phase !== "committed") {
    throw new Error("identity rotation already in progress; resume it instead of minting another nonce");
  }
  const startedAt = now();
  const toNonce = randomBytes(16).toString("hex");
  if (!isValidRoutingNonce(toNonce)) throw new Error("random source did not return a 128-bit nonce");
  const raw = {
    runtimeKey: profile.runtimeKey,
    layoutVersion: profile.layoutVersion || REMOTE_LAYOUT_VERSION,
    phase: "rotating",
    fromNonce: isValidRoutingNonce(profile.routingNonce) ? profile.routingNonce : null,
    toNonce,
    startedAt,
    previousExpiresAt: startedAt + previousNonceTtlMs,
    steps: Object.fromEntries(
      REMOTE_IDENTITY_STEP_NAMES.map((name) => [name, { status: "pending" }]),
    ),
  };
  const txn = sanitizeIdentityTxn(raw, profile);
  if (!txn) throw new Error("failed to build a layout-bound identity transaction");
  return txn;
}

function mintRoutingNonce(randomBytes = crypto.randomBytes) {
  const nonce = randomBytes(16).toString("hex");
  if (!isValidRoutingNonce(nonce)) {
    throw new Error("random source did not return a 128-bit nonce");
  }
  return nonce;
}

function forceRevokeOldIdentity(profile) {
  const next = { ...profile };
  delete next.previousNonce;
  delete next.previousExpiresAt;
  if (next.identityTxn && next.identityTxn.phase !== "committed") {
    next.identityTxn = {
      ...next.identityTxn,
      fromNonce: null,
      previousExpiresAt: Date.now(),
    };
  }
  return next;
}

function abortIdentityTxnToEmergencyNonce(profile, {
  randomBytes = crypto.randomBytes,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const toNonce = mintRoutingNonce(randomBytes);
  const next = {
    ...profile,
    isolatedActive: false,
    identityTxn: {
      runtimeKey: profile.runtimeKey,
      layoutVersion: profile.layoutVersion || REMOTE_LAYOUT_VERSION,
      phase: "rotating",
      fromNonce: null,
      toNonce,
      startedAt,
      previousExpiresAt: startedAt,
      steps: Object.fromEntries(
        REMOTE_IDENTITY_STEP_NAMES.map((name) => [name, { status: "pending" }]),
      ),
    },
  };
  delete next.routingNonce;
  delete next.previousNonce;
  delete next.previousExpiresAt;
  delete next.lastDeployedAt;
  return next;
}

function updateIdentityTxnStep(txn, stepName, stepValue, expectedProfile) {
  if (!REMOTE_IDENTITY_STEP_NAMES.includes(stepName)) {
    throw new TypeError(`unknown identity transaction step: ${String(stepName)}`);
  }
  const step = sanitizeIdentityStep(stepValue);
  if (!step) throw new TypeError(`invalid identity transaction step: ${stepName}`);
  const next = {
    ...txn,
    steps: {
      ...txn.steps,
      [stepName]: step,
    },
  };
  if (REMOTE_IDENTITY_STEP_NAMES.every((name) => {
    const status = next.steps[name] && next.steps[name].status;
    return status === "done" || status === "not-applicable";
  })) {
    next.phase = "verifying";
  }
  const clean = sanitizeIdentityTxn(next, expectedProfile);
  if (!clean) throw new Error("identity transaction lost its runtime layout binding");
  return clean;
}

function canCommitIdentityTxn(txn) {
  return !!txn
    && (txn.phase === "verifying" || txn.phase === "committed")
    && REMOTE_IDENTITY_STEP_NAMES.every((name) => {
      const step = txn.steps && txn.steps[name];
      return step
        && (step.status === "done"
          || (step.status === "not-applicable" && typeof step.evidence === "string" && step.evidence));
    });
}

function commitIdentityTxn(profile, txn) {
  const clean = sanitizeIdentityTxn(txn, profile);
  if (!clean || clean.runtimeKey !== profile.runtimeKey || clean.layoutVersion !== profile.layoutVersion) {
    throw new Error("identity transaction does not belong to this runtime layout");
  }
  if (!canCommitIdentityTxn(clean)) {
    throw new Error("identity transaction cannot commit before every applicable component is verified");
  }
  const next = {
    ...profile,
    routingNonce: clean.toNonce,
    identityTxn: {
      ...clean,
      phase: "committed",
    },
  };
  if (clean.fromNonce) {
    next.previousNonce = clean.fromNonce;
    next.previousExpiresAt = clean.previousExpiresAt;
  } else {
    delete next.previousNonce;
    delete next.previousExpiresAt;
  }
  return next;
}

function acceptedRoutingNonces(profile, now = Date.now()) {
  const nonces = [];
  const txn = profile && profile.identityTxn;
  const activeTxn = txn && txn.phase !== "committed";
  if (!activeTxn && isValidRoutingNonce(profile && profile.routingNonce)) {
    nonces.push(profile.routingNonce);
  }
  if (activeTxn
    && isValidRoutingNonce(txn.toNonce)
    && !nonces.includes(txn.toNonce)) {
    nonces.push(txn.toNonce);
  }
  if (activeTxn
    && isValidRoutingNonce(txn.fromNonce)
    && Number.isFinite(txn.previousExpiresAt)
    && now <= txn.previousExpiresAt
    && !nonces.includes(txn.fromNonce)) {
    nonces.push(txn.fromNonce);
  }
  if (isValidRoutingNonce(profile && profile.previousNonce)
    && Number.isFinite(profile.previousExpiresAt)
    && now <= profile.previousExpiresAt) {
    nonces.push(profile.previousNonce);
  }
  return nonces;
}

function cloneRecoverRemoteSsh(remoteSsh, newInstallId) {
  if (!isValidInstallId(newInstallId)) throw new TypeError("newInstallId is invalid");
  const source = remoteSsh && typeof remoteSsh === "object" ? remoteSsh : {};
  const profiles = Array.isArray(source.profiles) ? source.profiles : [];
  return {
    installId: newInstallId,
    profiles: profiles.map((profile) => {
      const next = {
        ...profile,
        isolatedActive: false,
      };
      delete next.routingNonce;
      delete next.previousNonce;
      delete next.previousExpiresAt;
      delete next.identityTxn;
      delete next.runtimeModeTxn;
      delete next.lastDeployedAt;
      delete next.managedDeployTargets;
      delete next.isolatedRuntime;
      return next;
    }),
  };
}

function buildRemoteIdentityDocument({ profile, installId, deployedAt = Date.now() }) {
  if (!profile || typeof profile !== "object") throw new TypeError("profile is required");
  if (!isValidInstallId(installId)) throw new TypeError("installId is invalid");
  if (!isValidRoutingNonce(profile.routingNonce)) throw new TypeError("profile.routingNonce is invalid");
  if (!Number.isInteger(profile.remoteForwardPort)) throw new TypeError("profile.remoteForwardPort is invalid");
  return Object.freeze({
    version: REMOTE_IDENTITY_VERSION,
    layoutVersion: profile.layoutVersion,
    runtimeKey: profile.runtimeKey,
    profileId: profile.id,
    installId,
    remotePort: profile.remoteForwardPort,
    routingNonce: profile.routingNonce,
    deployedAt,
  });
}

module.exports = {
  INSTALLATION_IDENTITY_FILENAME,
  INSTALLATION_IDENTITY_VERSION,
  REMOTE_IDENTITY_VERSION,
  DEFAULT_PREVIOUS_NONCE_TTL_MS,
  deriveInstallId,
  installationIdentityPath,
  selectedSafeStorageBackend,
  atomicWriteRecord,
  mintInstallationIdentity,
  readInstallationIdentity,
  loadOrCreateInstallationIdentity,
  createIdentityTxn,
  mintRoutingNonce,
  forceRevokeOldIdentity,
  abortIdentityTxnToEmergencyNonce,
  updateIdentityTxnStep,
  canCommitIdentityTxn,
  commitIdentityTxn,
  acceptedRoutingNonces,
  cloneRecoverRemoteSsh,
  buildRemoteIdentityDocument,
};
