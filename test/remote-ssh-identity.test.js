"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  REMOTE_IDENTITY_STEP_NAMES,
  sanitizeIdentityTxn,
} = require("../src/remote-ssh-profile");
const {
  deriveInstallId,
  installationIdentityPath,
  loadOrCreateInstallationIdentity,
  readInstallationIdentity,
  createIdentityTxn,
  forceRevokeOldIdentity,
  abortIdentityTxnToEmergencyNonce,
  updateIdentityTxnStep,
  canCommitIdentityTxn,
  commitIdentityTxn,
  acceptedRoutingNonces,
  cloneRecoverRemoteSsh,
  buildRemoteIdentityDocument,
} = require("../src/remote-ssh-identity");
const { checkSecureConnectReadiness } = require("../src/remote-ssh-runtime");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-remote-identity-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function deterministicRandom(byte) {
  return (size) => Buffer.alloc(size, byte);
}

function profile(over = {}) {
  return {
    id: "profile-a",
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    remoteForwardPort: 23333,
    ...over,
  };
}

test("main startup defers Remote SSH installation identity until IPC use", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const readyStart = mainSource.indexOf("app.whenReady().then(async () => {");
  const beforeQuit = mainSource.indexOf('app.on("before-quit"', readyStart);
  assert.notEqual(readyStart, -1);
  assert.notEqual(beforeQuit, -1);
  assert.doesNotMatch(
    mainSource.slice(readyStart, beforeQuit),
    /(?:initialize|ensure)RemoteSshInstallationIdentity\s*\(/,
  );
  assert.equal(
    (mainSource.match(/ensureRemoteSshInstallationIdentity\s*\(/g) || []).length,
    1,
    "the function declaration must be the only direct call-shaped occurrence; runtime access stays lazy"
  );
  assert.match(
    mainSource,
    /getInstallationIdentity:\s*ensureRemoteSshInstallationIdentity/,
  );
});

test("installation binding is separate from prefs and derives a stable public install id", () => {
  withTempDir((userDataDir) => {
    const first = loadOrCreateInstallationIdentity({
      userDataDir,
      randomBytes: deterministicRandom(0x41),
      now: () => 12345,
    });
    assert.equal(first.created, true);
    assert.equal(first.cloneRecoveryRequired, false);
    assert.equal(first.installId, deriveInstallId(Buffer.alloc(32, 0x41)));
    assert.equal(first.recordPath, installationIdentityPath(userDataDir));
    assert.equal(JSON.parse(fs.readFileSync(first.recordPath, "utf8")).storageBackend, "plaintext");

    const second = loadOrCreateInstallationIdentity({
      userDataDir,
      expectedInstallId: first.installId,
      randomBytes: deterministicRandom(0x42),
    });
    assert.equal(second.created, false);
    assert.equal(second.installId, first.installId);
  });
});

test("safe storage ciphertext is used and basic_text is reported as weak", () => {
  withTempDir((userDataDir) => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: (value) => Buffer.from(`wrapped:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^wrapped:/, ""),
    };
    const identity = loadOrCreateInstallationIdentity({
      userDataDir,
      safeStorage,
      randomBytes: deterministicRandom(0x51),
      now: () => 12345,
    });
    const disk = fs.readFileSync(identity.recordPath, "utf8");
    assert.equal(disk.includes(Buffer.alloc(32, 0x51).toString("base64")), false);
    assert.equal(identity.strongStorage, false);
    assert.equal(readInstallationIdentity({
      recordPath: identity.recordPath,
      safeStorage,
    }).installId, identity.installId);
  });
});

test("missing or mismatched binding with a cached install id triggers clone recovery", () => {
  withTempDir((userDataDir) => {
    const clonedPrefsInstallId = "a".repeat(64);
    const recovered = loadOrCreateInstallationIdentity({
      userDataDir,
      expectedInstallId: clonedPrefsInstallId,
      randomBytes: deterministicRandom(0x61),
      now: () => 12345,
    });
    assert.equal(recovered.cloneRecoveryRequired, true);
    assert.notEqual(recovered.installId, clonedPrefsInstallId);
  });
});

test("missing binding with copied remote authority triggers recovery even after a buggy prefs write lost installId", () => {
  withTempDir((userDataDir) => {
    const recovered = loadOrCreateInstallationIdentity({
      userDataDir,
      persistedAuthorityPresent: true,
      randomBytes: deterministicRandom(0x62),
      now: () => 12345,
    });
    assert.equal(recovered.cloneRecoveryRequired, true);
    assert.equal(recovered.recoveryReason, "record-missing");
  });
});

test("corrupt records and public-id mismatch rotate atomically into clone recovery", () => {
  for (const [label, mutate] of [
    ["malformed json", (recordPath) => fs.writeFileSync(recordPath, "{broken", { mode: 0o600 })],
    ["public id mismatch", (recordPath) => {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      record.installId = "f".repeat(64);
      fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }],
  ]) {
    withTempDir((userDataDir) => {
      const original = loadOrCreateInstallationIdentity({
        userDataDir,
        randomBytes: deterministicRandom(0x71),
        now: () => 100,
      });
      mutate(original.recordPath);
      const recovered = loadOrCreateInstallationIdentity({
        userDataDir,
        expectedInstallId: original.installId,
        randomBytes: deterministicRandom(0x72),
        now: () => 200,
      });
      assert.equal(recovered.created, true, label);
      assert.equal(recovered.cloneRecoveryRequired, true, label);
      assert.equal(recovered.recoveryReason, "record-invalid", label);
      assert.notEqual(recovered.installId, original.installId, label);
      assert.equal(
        readInstallationIdentity({ recordPath: original.recordPath }).installId,
        recovered.installId,
        label,
      );
      const residue = fs.readdirSync(userDataDir).filter((name) => name.includes(".tmp-"));
      assert.deepEqual(residue, [], label);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(original.recordPath).mode & 0o777, 0o600, label);
      }
    });
  }
});

test("unreadable binding fails closed without replacing the installation identity", () => {
  withTempDir((userDataDir) => {
    const original = loadOrCreateInstallationIdentity({
      userDataDir,
      randomBytes: deterministicRandom(0x73),
      now: () => 100,
    });
    const before = fs.readFileSync(original.recordPath, "utf8");
    const unreadableFs = {
      ...fs,
      readFileSync(target, ...args) {
        if (target === original.recordPath) {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        }
        return fs.readFileSync(target, ...args);
      },
    };

    assert.throws(() => loadOrCreateInstallationIdentity({
      userDataDir,
      expectedInstallId: original.installId,
      fsImpl: unreadableFs,
      randomBytes: deterministicRandom(0x74),
      now: () => 200,
    }), (err) => err && err.code === "EACCES");
    assert.equal(fs.readFileSync(original.recordPath, "utf8"), before);
  });
});

test("transient safeStorage decryption failure preserves ciphertext for a later retry", () => {
  withTempDir((userDataDir) => {
    let decryptAvailable = true;
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (value) => Buffer.from(`wrapped:${value}`, "utf8"),
      decryptString: (value) => {
        if (!decryptAvailable) throw new Error("keyring is locked");
        return value.toString("utf8").replace(/^wrapped:/, "");
      },
    };
    const original = loadOrCreateInstallationIdentity({
      userDataDir,
      safeStorage,
      randomBytes: deterministicRandom(0x75),
      now: () => 100,
    });
    const before = fs.readFileSync(original.recordPath, "utf8");
    decryptAvailable = false;

    assert.throws(() => loadOrCreateInstallationIdentity({
      userDataDir,
      expectedInstallId: original.installId,
      safeStorage,
      randomBytes: deterministicRandom(0x76),
      now: () => 200,
    }), (err) => err && err.code === "CLAWD_IDENTITY_STORAGE_UNAVAILABLE");
    assert.equal(fs.readFileSync(original.recordPath, "utf8"), before);

    decryptAvailable = true;
    const retried = loadOrCreateInstallationIdentity({
      userDataDir,
      expectedInstallId: original.installId,
      safeStorage,
    });
    assert.equal(retried.created, false);
    assert.equal(retried.installId, original.installId);
  });
});

test("A to B transaction resumes one nonce and commits only after every component verifies", () => {
  const a = "a".repeat(32);
  const original = profile({ routingNonce: a });
  let txn = createIdentityTxn(original, {
    randomBytes: deterministicRandom(0xbb),
    now: () => 1000,
  });
  assert.equal(txn.fromNonce, a);
  assert.equal(txn.toNonce, "bb".repeat(16));
  assert.throws(() => createIdentityTxn({ ...original, identityTxn: txn }, {
    randomBytes: deterministicRandom(0xcc),
  }), /resume/);

  for (const name of REMOTE_IDENTITY_STEP_NAMES) {
    txn = updateIdentityTxnStep(
      txn,
      name,
      name === "installCopilot"
        ? { status: "not-applicable", evidence: "agent-not-installed" }
        : { status: "done", evidence: `verified-${name}` },
      original,
    );
  }
  assert.equal(canCommitIdentityTxn(txn), true);
  const committed = commitIdentityTxn(original, txn);
  assert.equal(committed.routingNonce, "bb".repeat(16));
  assert.equal(committed.previousNonce, a);
  assert.equal(committed.previousExpiresAt, 901000);
  assert.deepEqual(acceptedRoutingNonces(committed, 901000), ["bb".repeat(16), a]);
  assert.deepEqual(acceptedRoutingNonces(committed, 901001), ["bb".repeat(16)]);
});

test("active rotation accepts only B and unexpired A, never the stale profile nonce independently", () => {
  const rotating = profile({
    routingNonce: "a".repeat(32),
    previousNonce: "9".repeat(32),
    previousExpiresAt: 50_000,
    identityTxn: {
      runtimeKey: "account-default",
      layoutVersion: 1,
      phase: "rotating",
      fromNonce: "a".repeat(32),
      toNonce: "b".repeat(32),
      startedAt: 1_000,
      previousExpiresAt: 2_000,
      steps: Object.fromEntries(
        REMOTE_IDENTITY_STEP_NAMES.map((name) => [name, { status: "pending" }]),
      ),
    },
  });
  assert.deepEqual(
    acceptedRoutingNonces(rotating, 1_999),
    ["b".repeat(32), "a".repeat(32), "9".repeat(32)],
  );
  assert.deepEqual(
    acceptedRoutingNonces(rotating, 2_001),
    ["b".repeat(32), "9".repeat(32)],
    "the profile routingNonce must not silently keep A alive after the txn TTL",
  );
});

test("force-revoke A and emergency A/B to C both fail closed for revoked generations", () => {
  const rotating = profile({
    routingNonce: "a".repeat(32),
    previousNonce: "9".repeat(32),
    previousExpiresAt: 50_000,
    identityTxn: {
      runtimeKey: "account-default",
      layoutVersion: 1,
      phase: "verifying",
      fromNonce: "a".repeat(32),
      toNonce: "b".repeat(32),
      startedAt: 1_000,
      previousExpiresAt: 20_000,
      steps: Object.fromEntries(
        REMOTE_IDENTITY_STEP_NAMES.map((name) => [name, { status: "pending" }]),
      ),
    },
  });

  const revokedA = forceRevokeOldIdentity(rotating);
  assert.deepEqual(acceptedRoutingNonces(revokedA, 1_500), ["b".repeat(32)]);

  const emergency = abortIdentityTxnToEmergencyNonce(rotating, {
    randomBytes: deterministicRandom(0xcc),
    now: () => 3_000,
  });
  assert.equal(emergency.identityTxn.toNonce, "cc".repeat(16));
  assert.equal(emergency.routingNonce, undefined);
  assert.equal(emergency.previousNonce, undefined);
  assert.equal(emergency.isolatedActive, false);
  assert.equal(emergency.identityTxn.previousExpiresAt, 3_001);
  assert.ok(sanitizeIdentityTxn(emergency.identityTxn, emergency));
  assert.deepEqual(acceptedRoutingNonces(emergency, 3_000), ["cc".repeat(16)]);
  assert.equal(acceptedRoutingNonces(emergency, 3_000).includes("a".repeat(32)), false);
  assert.equal(acceptedRoutingNonces(emergency, 3_000).includes("b".repeat(32)), false);
});

test("clone recovery clears all copied routing authority before activation", () => {
  const recovered = cloneRecoverRemoteSsh({
    installId: "a".repeat(64),
    profiles: [profile({
      routingNonce: "b".repeat(32),
      previousNonce: "c".repeat(32),
      previousExpiresAt: 999999,
      identityTxn: { phase: "rotating" },
      isolatedActive: true,
      isolatedRuntime: { active: true },
      managedDeployTargets: [{ installId: "a".repeat(64) }],
      lastDeployedAt: 12345,
    })],
  }, "d".repeat(64));
  assert.equal(recovered.installId, "d".repeat(64));
  const next = recovered.profiles[0];
  assert.equal(next.routingNonce, undefined);
  assert.equal(next.previousNonce, undefined);
  assert.equal(next.identityTxn, undefined);
  assert.equal(next.isolatedActive, false);
  assert.equal(next.isolatedRuntime, undefined);
  assert.equal(next.managedDeployTargets, undefined);
  assert.equal(next.lastDeployedAt, undefined);
  const readiness = checkSecureConnectReadiness(next);
  assert.equal(readiness.reason, "deployment_required");
  assert.equal(readiness.detail, "deployment_stamp_missing");
});

test("remote identity document binds nonce to installation, profile, and layout", () => {
  const doc = buildRemoteIdentityDocument({
    profile: profile({ routingNonce: "e".repeat(32) }),
    installId: "f".repeat(64),
    deployedAt: 12345,
  });
  assert.deepEqual(doc, {
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "profile-a",
    installId: "f".repeat(64),
    remotePort: 23333,
    routingNonce: "e".repeat(32),
    deployedAt: 12345,
  });
  assert.equal(Object.isFrozen(doc), true);
});
